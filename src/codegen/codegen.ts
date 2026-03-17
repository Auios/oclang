/**
 * x86-64 assembly codegen for oclang
 * Target: Windows (NASM win64) - no libc, uses kernel32 GetStdHandle/WriteFile/ExitProcess
 */

import type { Program, Expr, Stmt, FunctionDecl, Declaration } from "../parser/ast.ts";

const STD_OUTPUT_HANDLE = -11;
const STD_ERROR_HANDLE = -12;

const WIN64_PARAM_REGS = ["ecx", "edx", "r8d", "r9d"];
const WIN64_PARAM_REGS_64 = ["rcx", "rdx", "r8", "r9"];

export interface CodegenOptions {
  verbose?: boolean;
}

export class Codegen {
  private asm: string[] = [];
  private labelId = 0;
  private stringMap = new Map<string, string>();
  private staticArrayMap = new Map<string, string>();
  private floatMap = new Map<number, string>();
  private currentDecl: FunctionDecl | null = null;
  private inReturnOfArrayFunction = false;
  private currentConstOffset = -1;
  private verbose: boolean;
  private moduleMap = new Map<string, Map<string, "function" | "const">>();
  private enumMap = new Map<string, Map<string, number>>();
  private functionReturnTypeMap = new Map<string, string>();
  private maxTemplateInterpolations = 1;
  private typeMap = new Map<string, { fieldOffsets: Map<string, number>; fieldTypes: Map<string, string>; size: number }>();
  private currentObjectLiteralType: string | null = null;
  private functionParamTypes = new Map<string, string[]>();

  constructor(options: CodegenOptions = {}) {
    this.verbose = options.verbose ?? false;
  }

  private emit(line: string): void {
    this.asm.push(line);
  }

  private escapeString(s: string): string {
    const parts: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "\n") parts.push("10");
      else if (c === "\r") parts.push("13");
      else if (c === "\t") parts.push("9");
      else if (c === '"') parts.push("34");
      else parts.push(s.charCodeAt(i).toString());
    }
    return parts.join(", ");
  }

  private getStringLabel(value: string): string {
    let label = this.stringMap.get(value);
    if (!label) {
      label = `str_${this.labelId++}`;
      this.stringMap.set(value, label);
    }
    return label;
  }

  private getFloatLabel(value: number): string {
    const key = value;
    let label = this.floatMap.get(key);
    if (!label) {
      label = `flt_${this.labelId++}`;
      this.floatMap.set(key, label);
    }
    return label;
  }

  generate(ast: Program): string {
    this.asm = [];
    this.labelId = 0;
    this.stringMap = new Map();
    this.floatMap = new Map();
    this.moduleMap = new Map();
    this.enumMap = new Map();
    this.typeMap = new Map();

    // Build type map, module map, enum map, and function return types
    for (const decl of ast.declarations) {
      if (decl.kind === "type") {
        const fieldOffsets = new Map<string, number>();
        const fieldTypes = new Map<string, string>();
        let offset = 0;
        for (const f of decl.fields) {
          const sz = this.getTypeFieldSize(f.type);
          fieldOffsets.set(f.name, offset);
          fieldTypes.set(f.name, f.type);
          offset += sz;
        }
        this.typeMap.set(decl.name, { fieldOffsets, fieldTypes, size: (offset + 7) & ~7 });
      } else if (decl.kind === "enum") {
        const members = new Map<string, number>();
        for (const m of decl.members) {
          members.set(m.name, m.value);
        }
        this.enumMap.set(decl.name, members);
      } else if (decl.kind === "module") {
        const members = new Map<string, "function" | "const">();
        for (const m of decl.members) {
          members.set(m.name, m.kind);
          if (m.kind === "function") {
            this.functionReturnTypeMap.set(`${decl.name}_${m.name}`, m.returnType);
            this.functionParamTypes.set(`${decl.name}_${m.name}`, m.params.map((p) => p.type));
          }
        }
        this.moduleMap.set(decl.name, members);
      } else if (decl.kind === "function") {
        this.functionReturnTypeMap.set(decl.name, decl.returnType);
        this.functionParamTypes.set(decl.name, decl.params.map((p) => p.type));
      }
    }

    // Pre-scan: collect string literals, float literals, static arrays, and max template interpolations
    for (const decl of ast.declarations) {
      this.collectStringsFromDecl(decl);
      this.collectFloatsFromDecl(decl);
      this.collectStaticArraysFromDecl(decl);
      this.collectMaxTemplateInterpolationsFromDecl(decl);
    }

    this.emit("; oclang generated - x64 Windows (NASM)");
    this.emit("; no libc - uses kernel32 GetStdHandle, WriteFile, ExitProcess");
    this.emit("");
    this.emit("extern GetStdHandle");
    this.emit("extern WriteFile");
    this.emit("extern ExitProcess");
    this.emit("");
    this.emit("global main");
    this.emit("");

    // Data section - string literals, float constants, static arrays, and module constants
    const hasData =
      this.stringMap.size > 0 ||
      this.floatMap.size > 0 ||
      this.staticArrayMap.size > 0 ||
      this.maxTemplateInterpolations > 0 ||
      ast.declarations.some((d) => d.kind === "module" && d.members.some((m) => m.kind === "const"));
    if (hasData) {
      this.emit("section .data");
      if (this.maxTemplateInterpolations > 0) {
        this.emit("  _flt_100 dq 100.0");
        this.emit("  align 16");
        this.emit("  _flt_abs_mask dq 0x7FFFFFFFFFFFFFFF, 0xFFFFFFFFFFFFFFFF");
      }
      for (const [value, label] of this.stringMap) {
        const escaped = this.escapeString(value);
        this.emit(`  ${label} db ${escaped}`);
        this.emit(`  ${label}_len equ $ - ${label}`);
      }
      for (const [value, label] of this.floatMap) {
        const asmFloat = Number.isInteger(value) ? `${value}.0` : String(value);
        this.emit(`  ${label} dq ${asmFloat}`);
      }
      for (const [key, label] of this.staticArrayMap) {
        const values = JSON.parse(key) as number[];
        this.emit(`  ${label} dd ${values.length}, ${values.join(", ")}`);
      }
      for (const decl of ast.declarations) {
        if (decl.kind === "module") {
          for (const m of decl.members) {
            if (m.kind === "const") {
              const val = m.value.kind === "int" ? m.value.value : 0;
              this.emit(`  ${decl.name}_${m.name} dq ${val}`);
            }
          }
        }
      }
      this.emit("");
    }

    this.emit("section .bss");
    this.emit("  alignb 8");
    this.emit("  _stdout resq 1");
    this.emit("  _stderr resq 1");
    this.emit("  _written resq 1");
    this.emit("  _itobuf resb 12");
    this.emit("  _tmp_rdx resq 1");
    this.emit("  _tmp_r8 resq 1");
    this.emit("  _tmp_obj resq 1");
    this.emit("  _tmp_handle resq 1");
    this.emit("  _tmp_left resd 1");
    this.emit(`  _tmp_ints resd ${this.maxTemplateInterpolations}`);
    if (this.maxTemplateInterpolations > 0) {
      this.emit("  _ftobuf resb 24");
      this.emit("  _tmp_xmm0 resq 1");
      this.emit(`  _tmp_floats resq ${this.maxTemplateInterpolations}`);
    }
    this.emit("");

    this.emit("section .text");

    for (const decl of ast.declarations) {
      if (decl.kind === "import") continue;
      if (decl.kind === "enum") continue;
      if (decl.kind === "type") continue;
      if (decl.kind === "module") {
        for (const m of decl.members) {
          if (m.kind === "function") {
            this.emitModuleFunction(decl.name, m);
          }
          // const members already emitted in .data section
        }
        continue;
      }
      // FunctionDecl
      this.currentDecl = decl;
      const locals = this.getLocals(decl);
      const stackSize = this.getStackSize(locals);
      this.emit(`${decl.name}:`);
      this.emit(`  sub rsp, ${stackSize}`);
      this.emitParamSpills(decl, locals);
      this.emit("");

      for (const stmt of decl.body.statements) {
        this.emitStmt(stmt);
      }

      if (decl.name === "main") {
        const hasReturn = decl.body.statements.some((s) => s.kind === "return");
        if (!hasReturn) {
          this.emit("  sub rsp, 32");
          this.emit("  mov ecx, 0");
          this.emit("  call ExitProcess");
        }
      } else {
        const hasReturn = decl.body.statements.some((s) => s.kind === "return");
        if (!hasReturn) {
          this.emit(`  add rsp, ${stackSize}`);
          this.emit("  ret");
        }
      }
      this.emit("");
    }

    return this.asm.join("\n");
  }

  private collectStaticArraysFromStmt(stmt: Stmt): void {
    if (stmt.kind === "return" && stmt.value.kind === "array" && stmt.value.elements.length > 0) {
      const key = JSON.stringify(stmt.value.elements.map((e) => (e.kind === "int" ? e.value : 0)));
      if (!this.staticArrayMap.has(key)) {
        this.staticArrayMap.set(key, `arr_${this.labelId++}`);
      }
    } else if (stmt.kind === "if") {
      for (const s of stmt.thenBody.statements) this.collectStaticArraysFromStmt(s);
      if (stmt.elseBody) for (const s of stmt.elseBody.statements) this.collectStaticArraysFromStmt(s);
    } else if (stmt.kind === "for") {
      for (const s of stmt.body.statements) this.collectStaticArraysFromStmt(s);
    } else if (stmt.kind === "while") {
      for (const s of stmt.body.statements) this.collectStaticArraysFromStmt(s);
    }
  }

  private collectStaticArraysFromDecl(decl: Declaration): void {
    if (decl.kind === "function" && (decl.returnType.endsWith("]") || decl.returnType.startsWith("ptr<"))) {
      for (const stmt of decl.body.statements) this.collectStaticArraysFromStmt(stmt);
    } else if (decl.kind === "module") {
      for (const m of decl.members) {
        if (m.kind === "function" && (m.returnType.endsWith("]") || m.returnType.startsWith("ptr<"))) {
          for (const stmt of m.body.statements) this.collectStaticArraysFromStmt(stmt);
        }
      }
    }
  }

  private collectFloatsFromDecl(decl: Declaration): void {
    if (decl.kind === "function") {
      for (const stmt of decl.body.statements) this.collectFloats(stmt);
    } else if (decl.kind === "module") {
      for (const m of decl.members) {
        if (m.kind === "function") {
          for (const stmt of m.body.statements) this.collectFloats(stmt);
        } else if (m.kind === "const") {
          this.collectFloatsInExpr(m.value);
        }
      }
    }
  }

  private collectFloats(stmt: Stmt): void {
    if (stmt.kind === "const" || stmt.kind === "let") {
      if (stmt.value) this.collectFloatsInExpr(stmt.value);
    } else if (stmt.kind === "expr") {
      this.collectFloatsInExpr(stmt.expr);
    } else if (stmt.kind === "if") {
      this.collectFloatsInExpr(stmt.condition);
      for (const s of stmt.thenBody.statements) this.collectFloats(s);
      if (stmt.elseBody) for (const s of stmt.elseBody.statements) this.collectFloats(s);
    } else if (stmt.kind === "for") {
      if (stmt.init) {
        if ((stmt.init.kind === "const" || stmt.init.kind === "let") && stmt.init.value) this.collectFloatsInExpr(stmt.init.value);
        else if (stmt.init.kind === "expr") this.collectFloatsInExpr(stmt.init.expr);
      }
      if (stmt.condition) this.collectFloatsInExpr(stmt.condition);
      if (stmt.update) this.collectFloatsInExpr(stmt.update);
      for (const s of stmt.body.statements) this.collectFloats(s);
    } else if (stmt.kind === "while") {
      this.collectFloatsInExpr(stmt.condition);
      for (const s of stmt.body.statements) this.collectFloats(s);
    }
  }

  private collectFloatsInExpr(expr: Expr): void {
    if (expr.kind === "float") this.getFloatLabel(expr.value);
    else if (expr.kind === "call") {
      for (const arg of expr.args) this.collectFloatsInExpr(arg);
    } else if (expr.kind === "binary") {
      this.collectFloatsInExpr(expr.left);
      this.collectFloatsInExpr(expr.right);
    } else if (expr.kind === "addressOf" || expr.kind === "deref" || expr.kind === "unary") {
      this.collectFloatsInExpr(expr.operand);
    } else if (expr.kind === "assign") this.collectFloatsInExpr(expr.value);
    else if (expr.kind === "preIncDec" || expr.kind === "postIncDec") this.collectFloatsInExpr(expr.operand);
    else if (expr.kind === "index") {
      this.collectFloatsInExpr(expr.object);
      this.collectFloatsInExpr(expr.index);
    } else if (expr.kind === "array") {
      for (const e of expr.elements) this.collectFloatsInExpr(e);
    } else if (expr.kind === "template") {
      for (const seg of expr.segments) {
        if (seg.kind === "interpolate") this.collectFloatsInExpr(seg.expr);
      }
    }
  }

  private collectStringsFromDecl(decl: Declaration): void {
    if (decl.kind === "function") {
      for (const stmt of decl.body.statements) this.collectStrings(stmt);
    } else if (decl.kind === "module") {
      for (const m of decl.members) {
        if (m.kind === "function") {
          for (const stmt of m.body.statements) this.collectStrings(stmt);
        } else {
          this.collectStringsInExpr(m.value);
        }
      }
    }
  }

  private emitModuleFunction(moduleName: string, fn: FunctionDecl): void {
    const mangled = `${moduleName}_${fn.name}`;
    this.currentDecl = fn;
    const locals = this.getLocals(fn);
    const stackSize = this.getStackSize(locals);
    const hasReturn = fn.body.statements.some((s) => s.kind === "return");
    this.emit(`${mangled}:`);
    this.emit(`  sub rsp, ${stackSize}`);
    this.emitParamSpills(fn, locals);
    this.emit("");
    for (const stmt of fn.body.statements) {
      this.emitStmt(stmt);
    }
    if (!hasReturn) {
      this.emit(`  add rsp, ${stackSize}`);
      this.emit("  ret");
    }
    this.emit("");
  }

  private getLocals(decl: FunctionDecl): Array<{ name: string; type: string; value?: import("../parser/ast.ts").Expr; mutable: boolean }> {
    const locals: Array<{ name: string; type: string; value?: import("../parser/ast.ts").Expr; mutable: boolean }> = [];
    for (const p of decl.params) {
      locals.push({ name: p.name, type: p.type, mutable: true });
    }
    const addFromStmt = (s: Stmt): void => {
      if (s.kind === "const" || s.kind === "let") {
        locals.push({ name: s.name, type: s.type, value: s.value, mutable: s.kind === "let" });
      } else if (s.kind === "if") {
        for (const b of s.thenBody.statements) addFromStmt(b);
        if (s.elseBody) for (const b of s.elseBody.statements) addFromStmt(b);
      } else if (s.kind === "for") {
        if (s.init?.kind === "let") locals.push({ name: s.init.name, type: s.init.type, value: s.init.value, mutable: true });
        for (const b of s.body.statements) addFromStmt(b);
      } else if (s.kind === "while") {
        for (const b of s.body.statements) addFromStmt(b);
      }
    };
    for (const stmt of decl.body.statements) addFromStmt(stmt);
    return locals;
  }

  private getArrayLength(name: string): number {
    const decl = this.currentDecl!;
    const locals = this.getLocals(decl);
    const l = locals.find((x) => x.name === name);
    if (!l || !/\[\d*\]$/.test(l.type)) return -1;
    const match = l.type.match(/^(\w+)\[(\d*)\]$/);
    if (!match) return -1;
    if (match[2]) return parseInt(match[2], 10);
    if (l.value?.kind === "array") return l.value.elements.length;
    return -1;
  }

  private getTypeFieldSize(type: string): number {
    if (type === "string") return 8;
    if (type === "single") return 4;
    if (type === "double") return 8;
    if (type.startsWith("ptr<") || type.endsWith("]")) return 8;
    const info = this.typeMap.get(type);
    if (info) return 8; // object types are pointers
    if (type === "byte" || type === "ubyte") return 1;
    if (type === "short" || type === "ushort") return 2;
    if (type === "int" || type === "uint") return 4;
    if (type === "long" || type === "ulong") return 8;
    return 4; // default
  }

  private getStructSize(typeName: string): number {
    const info = this.typeMap.get(typeName);
    return info?.size ?? 0;
  }

  private getFieldOffset(typeName: string, fieldName: string): number {
    const info = this.typeMap.get(typeName);
    return info?.fieldOffsets.get(fieldName) ?? -1;
  }

  private getFieldStoreSize(typeName: string, fieldName: string): "byte" | "word" | "dword" | "qword" {
    const info = this.typeMap.get(typeName);
    const fieldType = info?.fieldTypes.get(fieldName) ?? "int";
    const sz = this.getTypeFieldSize(fieldType);
    if (sz === 1) return "byte";
    if (sz === 2) return "word";
    if (sz === 4) return "dword";
    return "qword";
  }

  private isObjectType(type: string): boolean {
    return this.typeMap.has(type);
  }

  private getLocalByteSize(type: string, value?: import("../parser/ast.ts").Expr): number {
    if (this.isObjectType(type)) {
      const structSize = this.getStructSize(type);
      return 8 + structSize; // ptr + struct storage
    }
    const match = type.match(/^(\w+)\[(\d*)\]$/);
    if (match) {
      const base = match[1];
      const elemSize = base === "string" || base.startsWith("ptr<") ? 8
        : base === "single" ? 4 : base === "double" ? 8
          : base === "byte" || base === "ubyte" ? 1 : base === "short" || base === "ushort" ? 2
            : base === "long" || base === "ulong" ? 8 : 4;
      if (match[2]) return parseInt(match[2], 10) * elemSize;
      if (value?.kind === "array") return Math.max(1, value.elements.length) * elemSize;
      return 8; // int[] from call = pointer
    }
    if (type === "single") return 4;
    if (type === "double") return 8;
    if (type === "byte" || type === "ubyte") return (1 + 7) & ~7; // 8 aligned
    if (type === "short" || type === "ushort") return (2 + 7) & ~7; // 8 aligned
    if (type === "int" || type === "uint") return 8;
    if (type === "long" || type === "ulong") return 8;
    return 8; // scalar default
  }

  private getLocalOffset(name: string): number {
    const decl = this.currentDecl!;
    const locals = this.getLocals(decl);
    let off = 0;
    for (const l of locals) {
      if (l.name === name) return off;
      off += (this.getLocalByteSize(l.type, l.value) + 7) & ~7;
    }
    return -1;
  }

  private emitParamSpills(decl: FunctionDecl, _locals: Array<{ name: string; type: string; value?: import("../parser/ast.ts").Expr; mutable?: boolean }>): void {
    let off = 0;
    for (let i = 0; i < decl.params.length && i < WIN64_PARAM_REGS_64.length; i++) {
      const p = decl.params[i];
      const sz = (this.getLocalByteSize(p.type) + 7) & ~7;
      const reg = this.isObjectType(p.type) ? WIN64_PARAM_REGS_64[i] : WIN64_PARAM_REGS_64[i];
      this.emit(`  mov [rsp + ${off}], ${reg}`);
      off += sz;
    }
  }

  private getStackSize(locals: Array<{ name: string; type: string; value?: import("../parser/ast.ts").Expr; mutable?: boolean }>): number {
    let localSize = 0;
    for (const l of locals) {
      localSize += (this.getLocalByteSize(l.type, l.value) + 7) & ~7;
    }
    return localSize + 8 + ((localSize & 8) ? 8 : 0);
  }

  private collectMaxTemplateInterpolationsFromDecl(decl: Declaration): void {
    const countInTemplate = (expr: Expr): void => {
      if (expr.kind === "template") {
        const n = expr.segments.filter((s) => s.kind === "interpolate").length;
        if (n > this.maxTemplateInterpolations) this.maxTemplateInterpolations = n;
        for (const seg of expr.segments) {
          if (seg.kind === "interpolate") countInTemplate(seg.expr);
        }
      } else if (expr.kind === "call") {
        for (const arg of expr.args) countInTemplate(arg);
      } else if (expr.kind === "binary") {
        countInTemplate(expr.left);
        countInTemplate(expr.right);
      } else if (expr.kind === "addressOf" || expr.kind === "deref" || expr.kind === "unary") countInTemplate(expr.operand);
      else if (expr.kind === "assign") countInTemplate(expr.value);
      else if (expr.kind === "preIncDec" || expr.kind === "postIncDec") countInTemplate(expr.operand);
      else if (expr.kind === "index") {
        countInTemplate(expr.object);
        countInTemplate(expr.index);
      } else if (expr.kind === "array") {
        for (const e of expr.elements) countInTemplate(e);
      } else if (expr.kind === "object") {
        for (const f of expr.fields) countInTemplate(f.value);
      }
    };
    const countInStmt = (s: Stmt): void => {
      if (s.kind === "expr") countInTemplate(s.expr);
      else if (s.kind === "const" || s.kind === "let") {
        if (s.value) countInTemplate(s.value);
      }
      else if (s.kind === "if") {
        countInTemplate(s.condition);
        for (const b of s.thenBody.statements) countInStmt(b);
        if (s.elseBody) for (const b of s.elseBody.statements) countInStmt(b);
      } else if (s.kind === "for") {
        if (s.init) {
          if ((s.init.kind === "const" || s.init.kind === "let") && s.init.value) countInTemplate(s.init.value);
          else if (s.init.kind === "expr") countInTemplate(s.init.expr);
        }
        if (s.condition) countInTemplate(s.condition);
        if (s.update) countInTemplate(s.update);
        for (const b of s.body.statements) countInStmt(b);
      } else if (s.kind === "while") {
        countInTemplate(s.condition);
        for (const b of s.body.statements) countInStmt(b);
      }
    };
    if (decl.kind === "function") {
      for (const s of decl.body.statements) countInStmt(s);
    } else if (decl.kind === "module") {
      for (const m of decl.members) {
        if (m.kind === "function") {
          for (const s of m.body.statements) countInStmt(s);
        } else if (m.kind === "const") {
          countInTemplate(m.value);
        }
      }
    }
  }

  private collectStrings(stmt: Stmt): void {
    if (stmt.kind === "expr" && stmt.expr.kind === "call") {
      for (const arg of stmt.expr.args) {
        if (arg.kind === "string") this.getStringLabel(arg.value);
        else this.collectStringsInExpr(arg);
      }
    } else if (stmt.kind === "const" || stmt.kind === "let") {
      if (stmt.value) this.collectStringsInExpr(stmt.value);
    } else if (stmt.kind === "if") {
      this.collectStringsInExpr(stmt.condition);
      for (const s of stmt.thenBody.statements) this.collectStrings(s);
      if (stmt.elseBody) for (const s of stmt.elseBody.statements) this.collectStrings(s);
    } else if (stmt.kind === "for") {
      if (stmt.init) {
        if (stmt.init.kind === "const" || stmt.init.kind === "let") {
          if (stmt.init.value) this.collectStringsInExpr(stmt.init.value);
        }
        else if (stmt.init.kind === "expr") this.collectStringsInExpr(stmt.init.expr);
      }
      if (stmt.condition) this.collectStringsInExpr(stmt.condition);
      if (stmt.update) this.collectStringsInExpr(stmt.update);
      for (const s of stmt.body.statements) this.collectStrings(s);
    } else if (stmt.kind === "while") {
      this.collectStringsInExpr(stmt.condition);
      for (const s of stmt.body.statements) this.collectStrings(s);
    }
  }

  private collectStringsInExpr(expr: Expr): void {
    if (expr.kind === "call") {
      for (const arg of expr.args) {
        if (arg.kind === "string") this.getStringLabel(arg.value);
        else this.collectStringsInExpr(arg);
      }
    } else if (expr.kind === "binary") {
      this.collectStringsInExpr(expr.left);
      this.collectStringsInExpr(expr.right);
    } else if (expr.kind === "addressOf" || expr.kind === "deref" || expr.kind === "unary") {
      this.collectStringsInExpr(expr.operand);
    } else if (expr.kind === "assign") {
      this.collectStringsInExpr(expr.value);
    } else if (expr.kind === "sizeof") {
      // no strings to collect
    } else if (expr.kind === "preIncDec" || expr.kind === "postIncDec") {
      this.collectStringsInExpr(expr.operand);
    } else if (expr.kind === "index") {
      this.collectStringsInExpr(expr.object);
      this.collectStringsInExpr(expr.index);
    } else if (expr.kind === "string") {
      this.getStringLabel(expr.value);
    } else if (expr.kind === "array") {
      for (const e of expr.elements) this.collectStringsInExpr(e);
    } else if (expr.kind === "object") {
      for (const f of expr.fields) this.collectStringsInExpr(f.value);
    } else if (expr.kind === "template") {
      for (const seg of expr.segments) {
        if (seg.kind === "string" && seg.value.length > 0) this.getStringLabel(seg.value);
        else if (seg.kind === "interpolate") this.collectStringsInExpr(seg.expr);
      }
    }
  }

  private emitStmt(stmt: Stmt): void {
    if (stmt.kind === "return") {
      const decl = this.currentDecl!;
      this.inReturnOfArrayFunction = decl.returnType.endsWith("]") || decl.returnType.startsWith("ptr<");
      const val = this.emitExpr(stmt.value);
      this.inReturnOfArrayFunction = false;
      if (decl.name === "main") {
        this.emit("  sub rsp, 32");
        if (val === "xmm0") {
          this.emit(`  cvttsd2si ecx, xmm0`);
        } else {
          this.emit(val === "rax" ? "  mov ecx, eax" : `  mov ecx, ${val}`);
        }
        this.emit("  call ExitProcess");
      } else {
        const locals = this.getLocals(decl);
        const stackSize = this.getStackSize(locals);
        if (val !== "rax" && val !== "xmm0") this.emit(`  mov eax, ${val}`);
        this.emit(`  add rsp, ${stackSize}`);
        this.emit("  ret");
      }
    } else if (stmt.kind === "const" || stmt.kind === "let") {
      const off = this.getLocalOffset(stmt.name);
      const isObjectInit = stmt.value?.kind === "object" && this.isObjectType(stmt.type);
      this.currentConstOffset = off >= 0 && isObjectInit ? off + 8 : off >= 0 ? off : -1;
      this.currentObjectLiteralType = isObjectInit ? stmt.type : null;
      if (!stmt.value) {
        if (stmt.kind === "const" || (!stmt.type.startsWith("ptr<") && !this.isObjectType(stmt.type))) {
          throw new Error(`let without initializer only allowed for ptr<T> or object types; use = null or = @x`);
        }
        this.emit(`  xor rax, rax`);
        this.emit(`  mov [rsp + ${off}], rax`);
        this.currentConstOffset = -1;
      } else {
        const val = this.emitExpr(stmt.value);
        this.currentConstOffset = -1;
        this.currentObjectLiteralType = null;
        if (off >= 0) {
          if (stmt.value.kind !== "array") {
            if (stmt.type === "single" || stmt.type === "double") {
              const srcIsDouble =
                stmt.value.kind === "float" ||
                (stmt.value.kind === "identifier" && this.getLocalType(stmt.value.name) === "double") ||
                (stmt.value.kind === "binary" && this.isFloatExpr(stmt.value));
              if (stmt.type === "single" && srcIsDouble) this.emit(`  cvtsd2ss xmm0, xmm0`);
              if (stmt.type === "single") this.emit(`  movss [rsp + ${off}], xmm0`);
              else this.emit(`  movsd [rsp + ${off}], xmm0`);
            } else if (stmt.type.startsWith("ptr<") || stmt.type.endsWith("]") || this.isObjectType(stmt.type)) {
              const ptrVal = val === "eax" ? "rax" : val;
              this.emit(ptrVal !== "rax" ? `  mov rax, ${ptrVal}` : "");
              this.emit(`  mov [rsp + ${off}], rax`);
            } else {
              this.emit(`  mov eax, ${val}`);
              this.emit(`  mov [rsp + ${off}], eax`);
            }
          }
        }
      }
    } else if (stmt.kind === "expr") {
      this.emitExpr(stmt.expr);
    } else if (stmt.kind === "asm") {
      for (const line of stmt.lines) {
        this.emit(`  ${line}`);
      }
    } else if (stmt.kind === "if") {
      this.emitIfStmt(stmt);
    } else if (stmt.kind === "for") {
      this.emitForStmt(stmt);
    } else if (stmt.kind === "while") {
      this.emitWhileStmt(stmt);
    }
  }

  private emitIfStmt(stmt: import("../parser/ast.ts").IfStmt): void {
    const cond = this.emitExpr(stmt.condition);
    this.emit(`  mov dword [rel _tmp_left], ${cond}`);
    this.emit(`  mov eax, dword [rel _tmp_left]`);
    this.emit(`  test eax, eax`);
    const skipLbl = `_L${this.labelId++}`;
    this.emit(`  jz ${skipLbl}`);
    for (const s of stmt.thenBody.statements) this.emitStmt(s);
    if (stmt.elseBody) {
      const endLbl = `_L${this.labelId++}`;
      this.emit(`  jmp ${endLbl}`);
      this.emit(`${skipLbl}:`);
      for (const s of stmt.elseBody.statements) this.emitStmt(s);
      this.emit(`${endLbl}:`);
    } else {
      this.emit(`${skipLbl}:`);
    }
  }

  private emitForStmt(stmt: import("../parser/ast.ts").ForStmt): void {
    if (stmt.init) this.emitStmt(stmt.init);
    const loopLbl = `_L${this.labelId++}`;
    const endLbl = `_L${this.labelId++}`;
    this.emit(`${loopLbl}:`);
    if (stmt.condition) {
      const cond = this.emitExpr(stmt.condition);
      this.emit(`  mov dword [rel _tmp_left], ${cond}`);
      this.emit(`  mov eax, dword [rel _tmp_left]`);
      this.emit(`  test eax, eax`);
      this.emit(`  jz ${endLbl}`);
    }
    for (const s of stmt.body.statements) this.emitStmt(s);
    if (stmt.update) this.emitExpr(stmt.update);
    this.emit(`  jmp ${loopLbl}`);
    this.emit(`${endLbl}:`);
  }

  private emitWhileStmt(stmt: import("../parser/ast.ts").WhileStmt): void {
    const loopLbl = `_L${this.labelId++}`;
    const endLbl = `_L${this.labelId++}`;
    this.emit(`${loopLbl}:`);
    const cond = this.emitExpr(stmt.condition);
    this.emit(`  mov dword [rel _tmp_left], ${cond}`);
    this.emit(`  mov eax, dword [rel _tmp_left]`);
    this.emit(`  test eax, eax`);
    this.emit(`  jz ${endLbl}`);
    for (const s of stmt.body.statements) this.emitStmt(s);
    this.emit(`  jmp ${loopLbl}`);
    this.emit(`${endLbl}:`);
  }

  private isArrayLocal(name: string): boolean {
    const locals = this.getLocals(this.currentDecl!);
    const l = locals.find((x) => x.name === name);
    return l ? /\[\d*\]$/.test(l.type) : false;
  }

  private isArrayPointerLocal(name: string): boolean {
    const locals = this.getLocals(this.currentDecl!);
    const l = locals.find((x) => x.name === name);
    if (!l || !l.type.endsWith("]")) return false;
    return l.value?.kind !== "array";
  }

  private isPointerLocal(name: string): boolean {
    const locals = this.getLocals(this.currentDecl!);
    const l = locals.find((x) => x.name === name);
    return l ? l.type.startsWith("ptr<") : false;
  }

  private isObjectLocal(name: string): boolean {
    const t = this.getLocalType(name);
    return t ? this.isObjectType(t) : false;
  }

  private isFloatLocal(name: string): boolean {
    const t = this.getLocalType(name);
    return t === "single" || t === "double";
  }

  private resolveIdentifier(name: string): string {
    const off = this.getLocalOffset(name);
    if (off >= 0) {
      if (this.isObjectLocal(name)) {
        this.emit(`  mov rax, [rsp + ${off}]`);
        return "rax";
      }
      if (this.isArrayPointerLocal(name)) {
        this.emit(`  mov rax, [rsp + ${off}]`);
        return "rax";
      }
      if (this.isArrayLocal(name)) {
        this.emit(`  lea rax, [rsp + ${off}]`);
        return "rax";
      }
      if (this.isPointerLocal(name)) {
        this.emit(`  mov rax, [rsp + ${off}]`);
        return "rax";
      }
      if (this.isFloatLocal(name)) {
        const t = this.getLocalType(name)!;
        if (t === "single") {
          this.emit(`  movss xmm0, [rsp + ${off}]`);
          this.emit(`  cvtss2sd xmm0, xmm0`);
        } else {
          this.emit(`  movsd xmm0, [rsp + ${off}]`);
        }
        return "xmm0";
      }
      this.emit(`  mov eax, [rsp + ${off}]`);
      return "eax";
    }
    return name;
  }

  private emitExpr(expr: Expr): string {
    switch (expr.kind) {
      case "identifier":
        return this.resolveIdentifier(expr.name);
      case "int":
        return expr.value.toString();
      case "bool":
        return expr.value ? "1" : "0";
      case "null":
        return "0";
      case "float":
        return this.emitFloatLiteral(expr);
      case "string":
        return this.getStringLabel(expr.value);
      case "binary":
        return this.emitBinary(expr);
      case "member":
        return this.emitMemberCall(expr);
      case "call":
        return this.emitCall(expr);
      case "addressOf":
        return this.emitAddressOf(expr);
      case "deref":
        return this.emitDeref(expr);
      case "index":
        return this.emitIndex(expr);
      case "array":
        return this.emitArrayLiteral(expr);
      case "object":
        return this.emitObjectLiteral(expr);
      case "sizeof":
        return this.emitSizeOf(expr);
      case "assign":
        return this.emitAssign(expr);
      case "unary":
        return this.emitUnary(expr);
      case "preIncDec":
        return this.emitPreIncDec(expr);
      case "postIncDec":
        return this.emitPostIncDec(expr);
      default:
        throw new Error(`Unsupported expression: ${(expr as Expr).kind}`);
    }
  }

  private emitAddressOf(expr: import("../parser/ast.ts").AddressOfExpr): string {
    const op = expr.operand;
    if (op.kind === "identifier") {
      const off = this.getLocalOffset(op.name);
      if (off >= 0) {
        this.emit(`  lea rax, [rsp + ${off}]`);
        return "rax";
      }
    }
    throw new Error(`Cannot take address of ${op.kind}`);
  }

  private emitDeref(expr: import("../parser/ast.ts").DerefExpr): string {
    const ptr = this.emitExpr(expr.operand);
    this.emit(`  mov eax, [${ptr}]`);
    return "eax";
  }

  private getArrayElementSize(name: string): number {
    const t = this.getLocalType(name);
    if (!t || !t.endsWith("]")) return 4;
    const m = t.match(/^(\w+)(?:\[\d*\])?$/);
    if (!m) return 4;
    const base = m[1];
    if (base === "string" || base.startsWith("ptr<")) return 8;
    if (base === "double" || base === "long" || base === "ulong") return 8;
    return 4;
  }

  private emitIndexAddress(expr: import("../parser/ast.ts").IndexExpr): void {
    const base = this.emitExpr(expr.object);
    const elemSize = expr.object.kind === "identifier"
      ? this.getArrayElementSize(expr.object.name)
      : 4;
    if (
      expr.object.kind === "identifier" &&
      this.isArrayPointerLocal(expr.object.name)
    ) {
      this.emit("  add rax, 4");
    }
    if (expr.index.kind === "int") {
      const byteOff = parseInt(this.emitExpr(expr.index), 10) * elemSize;
      this.emit(`  lea rax, [${base} + ${byteOff}]`);
    } else {
      this.emit(`  mov [rel _tmp_obj], ${base}`);
      const idx = this.emitExpr(expr.index);
      this.emit(`  mov r8d, ${idx}`);
      this.emit(`  mov rax, [rel _tmp_obj]`);
      this.emit(`  lea rax, [rax + r8 * ${elemSize}]`);
    }
  }

  private emitIndex(expr: import("../parser/ast.ts").IndexExpr): string {
    const elemSize = expr.object.kind === "identifier"
      ? this.getArrayElementSize(expr.object.name)
      : 4;
    this.emitIndexAddress(expr);
    if (elemSize === 8) {
      this.emit(`  mov rax, [rax]`);
      return "rax";
    }
    this.emit(`  mov eax, [rax]`);
    return "eax";
  }

  private getLocalType(name: string): string | null {
    const decl = this.currentDecl!;
    const p = decl.params.find((x) => x.name === name);
    if (p) return p.type;
    const locals = this.getLocals(decl);
    const l = locals.find((x) => x.name === name);
    return l?.type ?? null;
  }

  private emitFloatLiteral(expr: import("../parser/ast.ts").FloatLiteral): string {
    const label = this.getFloatLabel(expr.value);
    this.emit(`  movsd xmm0, [rel ${label}]`);
    return "xmm0";
  }

  private emitObjectLiteral(expr: import("../parser/ast.ts").ObjectLiteral): string {
    const base = this.currentConstOffset >= 0 ? this.currentConstOffset : 0;
    const typeName = this.currentObjectLiteralType;
    if (!typeName || !this.typeMap.has(typeName)) {
      throw new Error("Object literal requires typed context (e.g. let x: T = {...})");
    }
    const info = this.typeMap.get(typeName)!;
    for (const f of expr.fields) {
      const fieldOff = info.fieldOffsets.get(f.key) ?? -1;
      if (fieldOff < 0) throw new Error(`Unknown field '${f.key}' in type ${typeName}`);
      const val = this.emitExpr(f.value);
      if (val === "xmm0") {
        this.emit(`  movsd [rsp + ${base + fieldOff}], xmm0`);
      } else {
        this.emit(`  mov dword [rsp + ${base + fieldOff}], ${val}`);
      }
    }
    this.emit(`  lea rax, [rsp + ${base}]`);
    return "rax";
  }

  private emitArrayLiteral(expr: import("../parser/ast.ts").ArrayLiteral): string {
    const base = this.currentConstOffset >= 0 ? this.currentConstOffset : 0;
    if (expr.elements.length === 0) {
      this.emit(`  lea rax, [rsp + ${base}]`);
      return "rax";
    }
    const isStringArray = expr.elements[0]?.kind === "string";
    const elemSize = isStringArray ? 8 : 4;
    if (this.inReturnOfArrayFunction && !isStringArray) {
      const key = JSON.stringify(expr.elements.map((e) => (e.kind === "int" ? e.value : 0)));
      const label = this.staticArrayMap.get(key);
      if (label) {
        this.emit(`  lea rax, [rel ${label}]`);
        return "rax";
      }
    }
    for (let i = 0; i < expr.elements.length; i++) {
      const el = expr.elements[i];
      const val = this.emitExpr(el);
      if (isStringArray) {
        if (el.kind === "string") {
          this.emit(`  lea rax, [rel ${val}]`);
          this.emit(`  mov qword [rsp + ${base + i * elemSize}], rax`);
        } else {
          this.emit(`  mov qword [rsp + ${base + i * elemSize}], ${val}`);
        }
      } else {
        this.emit(`  mov dword [rsp + ${base + i * elemSize}], ${val}`);
      }
    }
    this.emit(`  lea rax, [rsp + ${base}]`);
    return "rax";
  }

  private isFloatExpr(expr: Expr): boolean {
    if (expr.kind === "float") return true;
    if (expr.kind === "identifier") return this.isFloatLocal(expr.name);
    if (expr.kind === "binary" && ["+", "-", "*", "/"].includes(expr.op)) {
      return this.isFloatExpr(expr.left) || this.isFloatExpr(expr.right);
    }
    return false;
  }

  private isPointerOrNullExpr(expr: Expr): boolean {
    if (expr.kind === "null") return true;
    if (expr.kind === "identifier") return this.isPointerLocal(expr.name) || this.isArrayPointerLocal(expr.name);
    return false;
  }

  private emitBinary(expr: Expr & { kind: "binary" }): string {
    const useFloat = ["+", "-", "*", "/"].includes(expr.op) && this.isFloatExpr(expr.left) && this.isFloatExpr(expr.right);
    if (useFloat) {
      this.emitExpr(expr.left);
      this.emit(`  movsd xmm1, xmm0`);
      this.emitExpr(expr.right);
      if (expr.op === "+") this.emit(`  addsd xmm0, xmm1`);
      else if (expr.op === "-") {
        this.emit(`  subsd xmm1, xmm0`);
        this.emit(`  movsd xmm0, xmm1`);
      } else if (expr.op === "*") this.emit(`  mulsd xmm0, xmm1`);
      else if (expr.op === "/") {
        this.emit(`  divsd xmm1, xmm0`);
        this.emit(`  movsd xmm0, xmm1`);
      }
      return "xmm0";
    }

    const usePtrCmp =
      (expr.op === "==" || expr.op === "!=") &&
      this.isPointerOrNullExpr(expr.left) &&
      this.isPointerOrNullExpr(expr.right);
    if (usePtrCmp) {
      this.emitExpr(expr.left);
      if (expr.left.kind === "null") this.emit("  xor rbx, rbx");
      else this.emit("  mov rbx, rax");
      this.emitExpr(expr.right);
      if (expr.right.kind === "null") this.emit("  xor rax, rax");
      this.emit("  cmp rbx, rax");
      this.emit(expr.op === "==" ? "  sete al" : "  setne al");
      this.emit("  movzx eax, al");
      return "eax";
    }

    const left = this.emitExpr(expr.left);
    this.emit(`  mov dword [rel _tmp_left], ${left}`);
    let right = this.emitExpr(expr.right);
    if (/^-?\d+$/.test(right)) {
      this.emit(`  mov eax, ${right}`);
      right = "eax";
    }
    this.emit(`  mov r8d, dword [rel _tmp_left]`);

    if (expr.op === "+") {
      this.emit(`  add eax, r8d`);
      return "eax";
    }
    if (expr.op === "-") {
      this.emit(`  mov ecx, eax`);
      this.emit(`  mov eax, r8d`);
      this.emit(`  sub eax, ecx`);
      return "eax";
    }
    if (expr.op === "*") {
      this.emit(`  mov ecx, eax`);
      this.emit(`  mov eax, r8d`);
      this.emit(`  imul eax, ecx`);
      return "eax";
    }
    if (expr.op === "/") {
      this.emit(`  mov ecx, eax`);
      this.emit(`  mov eax, r8d`);
      this.emit(`  cdq`);
      this.emit(`  idiv ecx`);
      return "eax";
    }

    if (expr.op === "==" || expr.op === "!=" || expr.op === "<" || expr.op === ">" || expr.op === "<=" || expr.op === ">=") {
      this.emit(`  cmp r8d, eax`);
      const setcc: Record<string, string> = {
        "==": "sete",
        "!=": "setne",
        "<": "setl",
        ">": "setg",
        "<=": "setle",
        ">=": "setge",
      };
      this.emit(`  ${setcc[expr.op]} al`);
      this.emit(`  movzx eax, al`);
      return "eax";
    }

    if (expr.op === "&&" || expr.op === "||") {
      const l0 = `_L${this.labelId++}`;
      const l1 = `_L${this.labelId++}`;
      if (expr.op === "&&") {
        this.emit(`  test r8d, r8d`);
        this.emit(`  jz ${l0}`);
        this.emit(`  test eax, eax`);
        this.emit(`  jz ${l0}`);
        this.emit(`  mov eax, 1`);
        this.emit(`  jmp ${l1}`);
        this.emit(`${l0}:`);
        this.emit(`  xor eax, eax`);
        this.emit(`${l1}:`);
      } else {
        this.emit(`  test r8d, r8d`);
        this.emit(`  jnz ${l1}`);
        this.emit(`  test eax, eax`);
        this.emit(`  jnz ${l1}`);
        this.emit(`  xor eax, eax`);
        this.emit(`  jmp ${l0}`);
        this.emit(`${l1}:`);
        this.emit(`  mov eax, 1`);
        this.emit(`${l0}:`);
      }
      return "eax";
    }

    throw new Error(`Unknown binary op: ${expr.op}`);
  }

  private getTypeSize(typeStr: string): number {
    if (typeStr === "string") return 8;
    if (typeStr === "int" || typeStr === "uint") return 4;
    if (typeStr === "single") return 4;
    if (typeStr === "double") return 8;
    if (typeStr === "ubyte" || typeStr === "byte") return 1;
    if (typeStr === "short" || typeStr === "ushort") return 2;
    if (typeStr === "long" || typeStr === "ulong") return 8;
    if (typeStr.startsWith("ptr<")) return 8;
    const arrMatch = typeStr.match(/^(\w+)\[(\d+)\]$/);
    if (arrMatch) {
      const elemType = arrMatch[1];
      const n = parseInt(arrMatch[2], 10);
      const elemSize = this.getTypeSize(elemType);
      return n * elemSize;
    }
    if (typeStr.endsWith("[]")) return 8;
    if (this.isObjectType(typeStr)) return 8;
    const locals = this.getLocals(this.currentDecl!);
    const l = locals.find((x) => x.name === typeStr);
    if (l) return this.getTypeSize(l.type);
    const paramIdx = this.currentDecl!.params.findIndex((p) => p.name === typeStr);
    if (paramIdx >= 0) {
      throw new Error(`sizeof(param) not supported - param types not tracked`);
    }
    throw new Error(`Unknown type or variable for sizeof: ${typeStr}`);
  }

  private emitSizeOf(expr: import("../parser/ast.ts").SizeOfExpr): string {
    const size = this.getTypeSize(expr.typeOrVar);
    this.emit(`  mov eax, ${size}`);
    return "eax";
  }

  private isLetLocal(name: string): boolean {
    if (this.currentDecl!.params.some((p) => p.name === name)) return true;
    const locals = this.getLocals(this.currentDecl!);
    const l = locals.find((x) => x.name === name);
    return l?.mutable ?? false;
  }

  private emitAssign(expr: import("../parser/ast.ts").AssignExpr): string {
    if (expr.target.kind === "identifier") {
      if (!this.isLetLocal(expr.target.name)) {
        throw new Error(`Cannot assign to const variable '${expr.target.name}'`);
      }
      const off = this.getLocalOffset(expr.target.name);
      if (off < 0) throw new Error(`Unknown variable '${expr.target.name}'`);

      if (expr.op === "=") {
        const targetType = this.getLocalType(expr.target.name);
        if (targetType && this.isObjectType(targetType) && expr.value.kind === "object") {
          this.currentConstOffset = off + 8;
          this.currentObjectLiteralType = targetType;
          this.emitExpr(expr.value);
          this.currentConstOffset = -1;
          this.currentObjectLiteralType = null;
          this.emit(`  mov [rsp + ${off}], rax`);
          return "rax";
        }
        const val = this.emitExpr(expr.value);
        if (targetType && this.isObjectType(targetType)) {
          if (val !== "rax") this.emit(`  mov rax, ${val}`);
          this.emit(`  mov [rsp + ${off}], rax`);
          return "rax";
        }
        this.emit(`  mov eax, ${val}`);
        this.emit(`  mov [rsp + ${off}], eax`);
        return "eax";
      }
      // += -= *= /=
      this.emit(`  mov eax, [rsp + ${off}]`);
      const right = this.emitExpr(expr.value);
      if (expr.op === "+=") {
        this.emit(`  add eax, ${right}`);
      } else if (expr.op === "-=") {
        this.emit(`  sub eax, ${right}`);
      } else if (expr.op === "*=") {
        this.emit(`  imul eax, ${right}`);
      } else if (expr.op === "/=") {
        this.emit(`  cdq`);
        this.emit(`  mov ecx, ${right}`);
        this.emit(`  idiv ecx`);
      }
      this.emit(`  mov [rsp + ${off}], eax`);
      return "eax";
    }
    if (expr.target.kind === "index") {
      this.emitIndexAddress(expr.target);
      this.emit(`  mov r8, rax`);
      const val = this.emitExpr(expr.value);
      this.emit(`  mov [r8], ${val}`);
      this.emit(`  mov eax, ${val}`);
      return "eax";
    }
    if (expr.target.kind === "member") {
      const mobj = expr.target.object;
      const prop = expr.target.property;
      if (mobj.kind === "identifier") {
        const t = this.getLocalType(mobj.name);
        if (t && this.isObjectType(t)) {
          const ptr = this.resolveIdentifier(mobj.name);
          if (ptr !== "rax") this.emit(`  mov rax, ${ptr}`);
          this.emit(`  mov [rel _tmp_obj], rax`);
          const fieldOff = this.getFieldOffset(t, prop);
          if (fieldOff < 0) throw new Error(`Unknown field ${mobj.name}.${prop}`);
          const memSize = this.getFieldStoreSize(t, prop);
          const val = this.emitExpr(expr.value);
          this.emit(`  mov dword [rel _tmp_left], ${val}`);
          this.emit(`  mov rax, [rel _tmp_obj]`);
          const reg = memSize === "byte" ? "r8b" : memSize === "word" ? "r8w" : memSize === "dword" ? "r8d" : "r8";
          this.emit(`  mov r8d, dword [rel _tmp_left]`);
          this.emit(`  mov ${memSize} [rax + ${fieldOff}], ${reg}`);
          this.emit(`  mov eax, r8d`);
          return "eax";
        }
      }
      throw new Error(`Invalid assignment target: ${expr.target.kind}`);
    }
    throw new Error(`Invalid assignment target: ${expr.target.kind}`);
  }

  private emitUnary(expr: import("../parser/ast.ts").UnaryExpr): string {
    const op = this.emitExpr(expr.operand);
    this.emit(`  mov eax, ${op}`);
    this.emit(`  test eax, eax`);
    this.emit(`  sete al`);
    this.emit(`  movzx eax, al`);
    return "eax";
  }

  private emitPreIncDec(expr: import("../parser/ast.ts").PreIncDecExpr): string {
    if (expr.operand.kind !== "identifier") {
      throw new Error("++/-- only supported on variables");
    }
    if (!this.isLetLocal(expr.operand.name)) {
      throw new Error(`Cannot mutate const variable '${expr.operand.name}'`);
    }
    const off = this.getLocalOffset(expr.operand.name);
    if (off < 0) throw new Error(`Unknown variable '${expr.operand.name}'`);
    this.emit(`  mov eax, [rsp + ${off}]`);
    if (expr.op === "++") {
      this.emit(`  add eax, 1`);
    } else {
      this.emit(`  sub eax, 1`);
    }
    this.emit(`  mov [rsp + ${off}], eax`);
    return "eax";
  }

  private emitPostIncDec(expr: import("../parser/ast.ts").PostIncDecExpr): string {
    if (expr.operand.kind !== "identifier") {
      throw new Error("++/-- only supported on variables");
    }
    if (!this.isLetLocal(expr.operand.name)) {
      throw new Error(`Cannot mutate const variable '${expr.operand.name}'`);
    }
    const off = this.getLocalOffset(expr.operand.name);
    if (off < 0) throw new Error(`Unknown variable '${expr.operand.name}'`);
    this.emit(`  mov eax, [rsp + ${off}]`);
    const tmpReg = "r8d";
    this.emit(`  mov ${tmpReg}, eax`);
    if (expr.op === "++") {
      this.emit(`  add eax, 1`);
    } else {
      this.emit(`  sub eax, 1`);
    }
    this.emit(`  mov [rsp + ${off}], eax`);
    this.emit(`  mov eax, ${tmpReg}`); // return old value
    return "eax";
  }

  private emitMemberCall(expr: Expr & { kind: "member" }): string {
    const obj = expr.object;
    const prop = expr.property;
    if (obj.kind === "identifier") {
      const objType = this.getLocalType(obj.name);
      if (objType && this.isObjectType(objType)) {
        const ptr = this.resolveIdentifier(obj.name);
        if (ptr !== "rax") this.emit(`  mov rax, ${ptr}`);
        const fieldOff = this.getFieldOffset(objType, prop);
        if (fieldOff < 0) throw new Error(`Unknown field ${obj.name}.${prop}`);
        const memSize = this.getFieldStoreSize(objType, prop);
        if (memSize === "byte") this.emit(`  movzx eax, byte [rax + ${fieldOff}]`);
        else if (memSize === "word") this.emit(`  movzx eax, word [rax + ${fieldOff}]`);
        else if (memSize === "qword") {
          this.emit(`  mov rax, [rax + ${fieldOff}]`);
          return "rax";
        } else this.emit(`  mov eax, [rax + ${fieldOff}]`);
        return "eax";
      }
      const members = this.enumMap.get(obj.name);
      if (members) {
        const val = members.get(prop);
        if (val !== undefined) {
          this.emit(`  mov eax, ${val}`);
          return "eax";
        }
        throw new Error(`Unknown enum member ${obj.name}.${prop}`);
      }
    }
    if (obj.kind === "identifier" && prop === "length") {
      const len = this.getArrayLength(obj.name);
      if (len >= 0) {
        this.emit(`  mov eax, ${len}`);
        return "eax";
      }
      if (this.isArrayPointerLocal(obj.name)) {
        const off = this.getLocalOffset(obj.name);
        this.emit(`  mov rax, [rsp + ${off}]`);
        this.emit("  mov eax, [rax]");
        return "eax";
      }
    }
    if (obj.kind === "identifier") {
      const members = this.moduleMap.get(obj.name);
      if (members) {
        const kind = members.get(prop);
        if (kind === "const") {
          this.emit(`  mov rax, [rel ${obj.name}_${prop}]`);
          this.emit("  mov eax, eax");
          return "eax";
        }
      }
      if (obj.name === "process") {
        throw new Error('process is not defined; add import("lib/stdlib.oc", [process]);');
      }
    }
    throw new Error(`Unsupported: ${obj.kind === "identifier" ? obj.name : "?"}.${prop}`);
  }

  private emitCall(expr: Expr & { kind: "call" }): string {
    const callee = expr.callee;
    if (callee.kind === "member") {
      const obj = callee.object;
      const prop = callee.property;
      if (obj.kind === "identifier" && obj.name === "process" && prop === "write") {
        if (!this.moduleMap.has("process")) {
          throw new Error('process is not defined; add import("lib/stdlib.oc", [process]);');
        }
        if (expr.args.length !== 2) {
          throw new Error("process.write expects two arguments: (fd, msg)");
        }
        const fdVal = this.emitExpr(expr.args[0]);
        const handle = fdVal === "0" ? -10 : fdVal === "1" ? STD_OUTPUT_HANDLE : fdVal === "2" ? STD_ERROR_HANDLE : STD_OUTPUT_HANDLE;
        const arg = expr.args[1];
        if (arg.kind === "string") {
          this.emitProcessWriteString(arg.value, handle);
        } else if (arg.kind === "template") {
          this.emitProcessWriteTemplate(arg.segments, handle);
        } else {
          const val = this.emitExpr(arg);
          if (val === "xmm0") {
            this.emit(`  cvttsd2si eax, xmm0`);
            this.emitProcessWriteInt("eax", handle);
          } else {
            this.emitProcessWriteInt(val, handle);
          }
        }
        return "";
      }
      if (obj.kind === "identifier") {
        const members = this.moduleMap.get(obj.name);
        if (members?.get(prop) === "function") {
          const mangled = `${obj.name}_${prop}`;
          const paramTypes = this.functionParamTypes.get(mangled) ?? [];
          for (let i = 0; i < expr.args.length; i++) {
            const argVal = this.emitExpr(expr.args[i]);
            const pt = paramTypes[i] ?? "";
            const use64 = this.isObjectType(pt) || pt.startsWith("ptr<");
            const reg = use64 ? WIN64_PARAM_REGS_64[i] : WIN64_PARAM_REGS[i];
            this.emit(`  mov ${reg}, ${argVal}`);
          }
          this.emit("  sub rsp, 32");
          this.emit(`  call ${mangled}`);
          this.emit("  add rsp, 32");
          const retType = this.functionReturnTypeMap.get(mangled);
          return retType?.endsWith("]") || retType?.startsWith("ptr<") || (retType && this.isObjectType(retType)) ? "rax" : "eax";
        }
      }
    }
    if (callee.kind === "identifier") {
      const paramTypes = this.functionParamTypes.get(callee.name) ?? [];
      for (let i = 0; i < expr.args.length; i++) {
        const argVal = this.emitExpr(expr.args[i]);
        const pt = paramTypes[i] ?? "";
        const use64 = this.isObjectType(pt) || pt.startsWith("ptr<");
        const reg = use64 ? WIN64_PARAM_REGS_64[i] : WIN64_PARAM_REGS[i];
        this.emit(`  mov ${reg}, ${argVal}`);
      }
      this.emit(`  sub rsp, 32`);
      this.emit(`  call ${callee.name}`);
      this.emit(`  add rsp, 32`);
      const retType = this.functionReturnTypeMap.get(callee.name);
      return retType?.endsWith("]") || retType?.startsWith("ptr<") || (retType && this.isObjectType(retType)) ? "rax" : "eax";
    }
    throw new Error(`Unsupported call: ${JSON.stringify(callee)}`);
  }

  private emitProcessWriteTemplate(
    segments: import("../parser/ast.ts").TemplateSegment[],
    handle: number,
  ): void {
    // Pre-evaluate all interpolated values and store so they survive
    // process__write_string calls (which may clobber stack/registers).
    const interpolates = segments.filter((s): s is import("../parser/ast.ts").TemplateSegment & { kind: "interpolate" } => s.kind === "interpolate");
    const isFloat: boolean[] = [];
    for (let i = 0; i < interpolates.length; i++) {
      const val = this.emitExpr(interpolates[i].expr);
      if (val === "xmm0") {
        this.emit(`  movsd [rel _tmp_floats + ${i * 8}], xmm0`);
        isFloat.push(true);
      } else {
        if (val !== "rax" && val !== "eax") {
          this.emit(`  mov eax, ${val}`);
        }
        this.emit(`  mov dword [rel _tmp_ints + ${i * 4}], eax`);
        isFloat.push(false);
      }
    }
    let interpIdx = 0;
    for (const seg of segments) {
      if (seg.kind === "string") {
        if (seg.value.length > 0) this.emitProcessWriteString(seg.value, handle);
      } else {
        if (isFloat[interpIdx]) {
          this.emit(`  movsd xmm0, [rel _tmp_floats + ${interpIdx * 8}]`);
          this.emit(`  mov ecx, ${handle}`);
          this.emit("  sub rsp, 32");
          this.emit("  call process__write_float");
          this.emit("  add rsp, 32");
        } else {
          this.emit(`  mov edx, dword [rel _tmp_ints + ${interpIdx * 4}]`);
          this.emit(`  mov ecx, ${handle}`);
          this.emit("  sub rsp, 32");
          this.emit("  call process__write_int");
          this.emit("  add rsp, 32");
        }
        this.emit("");
        interpIdx++;
      }
    }
  }

  private emitProcessWriteString(str: string, handle: number): void {
    const label = this.getStringLabel(str);
    const lenLabel = `${label}_len`;
    this.emit(`  ; process.write(string) -> process__write_string`);
    this.emit(`  mov ecx, ${handle}`);
    this.emit(`  lea rdx, [rel ${label}]`);
    this.emit(`  mov r8, ${lenLabel}`);
    this.emit("  sub rsp, 32");
    this.emit("  call process__write_string");
    this.emit("  add rsp, 32");
    this.emit("");
  }

  private emitProcessWriteInt(valueOperand: string, handle: number): void {
    this.emit(`  ; process.write(int) -> process__write_int`);
    if (valueOperand !== "edx") {
      if (valueOperand === "rax") {
        this.emit("  mov edx, eax");
      } else {
        this.emit(`  mov edx, ${valueOperand}`);
      }
    }
    this.emit(`  mov ecx, ${handle}`);
    this.emit("  sub rsp, 32");
    this.emit("  call process__write_int");
    this.emit("  add rsp, 32");
    this.emit("");
  }
}
