/**
 * Type checker for oclang. Runs after parsing, before codegen.
 * Rejects invalid operations (e.g. int + ptr, deref of int).
 */

import type {
  Program,
  Stmt,
  Expr,
  FunctionDecl,
  ModuleDecl,
  EnumDecl,
  TypeDecl,
} from "../parser/ast.ts";

export class TypeCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypeCheckError";
  }
}

/** Scalar integer-like types that can participate in int arithmetic */
const SCALAR_INT = new Set(["int", "uint", "byte", "ubyte", "short", "ushort", "long", "ulong"]);
/** Scalar float types */
const SCALAR_FLOAT = new Set(["single", "double"]);

function isScalarInt(t: string): boolean {
  return SCALAR_INT.has(t);
}


function isPtr(t: string): boolean {
  return t.startsWith("ptr<");
}

function isArray(t: string): boolean {
  return t.endsWith("[]") || /\[\d+\]$/.test(t);
}

function arrayElementType(t: string): string | null {
  const m = t.match(/^(.+)\[\d*\]$/);
  return m ? m[1] : null;
}

function ptrElementType(t: string): string | null {
  const m = t.match(/^ptr<(.+)>$/);
  return m ? m[1] : null;
}

/** Promote single to double for arithmetic if mixed */
function arithmeticResultType(left: string, right: string): string {
  if (SCALAR_FLOAT.has(left) || SCALAR_FLOAT.has(right)) {
    return left === "single" && right === "single" ? "single" : "double";
  }
  return "int";
}

export class TypeChecker {
  private functionReturnTypes = new Map<string, string>();
  private moduleMemberTypes = new Map<string, Map<string, string>>();
  private enumMemberTypes = new Map<string, Map<string, string>>();
  private typeMap = new Map<string, Map<string, string>>();

  typeCheck(ast: Program): void {
    for (const decl of ast.declarations) {
      if (decl.kind === "type") {
        const fields = new Map<string, string>();
        for (const f of decl.fields) fields.set(f.name, f.type);
        this.typeMap.set(decl.name, fields);
      } else if (decl.kind === "module") {
        this.collectModuleTypes(decl);
      } else if (decl.kind === "function") {
        this.functionReturnTypes.set(decl.name, decl.returnType);
      } else if (decl.kind === "enum") {
        this.collectEnumTypes(decl);
      }
    }
    for (const decl of ast.declarations) {
      if (decl.kind === "import" || decl.kind === "enum" || decl.kind === "type") continue;
      if (decl.kind === "module") {
        for (const m of decl.members) {
          if (m.kind === "function") {
            this.checkFunction(`${decl.name}_${m.name}`, m);
          }
        }
        continue;
      }
      if (decl.kind === "function") {
        this.checkFunction(decl.name, decl);
      }
    }
  }

  private collectEnumTypes(en: EnumDecl): void {
    const members = new Map<string, string>();
    for (const m of en.members) {
      members.set(m.name, en.underlyingType);
    }
    this.enumMemberTypes.set(en.name, members);
  }

  private collectModuleTypes(mod: ModuleDecl): void {
    const members = new Map<string, string>();
    for (const m of mod.members) {
      if (m.kind === "function") {
        members.set(m.name, "function");
      } else if (m.kind === "const") {
        const t = m.value.kind === "int" ? "int" : "int";
        members.set(m.name, t);
      }
    }
    this.moduleMemberTypes.set(mod.name, members);
  }

  private checkFunction(_mangledName: string, fn: FunctionDecl): void {
    const locals = new Map<string, string>();
    for (const p of fn.params) {
      locals.set(p.name, p.type);
    }
    for (const s of fn.body.statements) {
      this.collectLocalsFromStmt(s, locals);
    }
    for (const s of fn.body.statements) {
      this.checkStmt(s, locals, fn.returnType);
    }
  }

  private collectLocalsFromStmt(stmt: Stmt, locals: Map<string, string>): void {
    if (stmt.kind === "const" || stmt.kind === "let") {
      locals.set(stmt.name, stmt.type);
    } else if (stmt.kind === "if") {
      for (const s of stmt.thenBody.statements) this.collectLocalsFromStmt(s, locals);
      if (stmt.elseBody) for (const s of stmt.elseBody.statements) this.collectLocalsFromStmt(s, locals);
    } else if (stmt.kind === "for") {
      if (stmt.init?.kind === "let") locals.set(stmt.init.name, stmt.init.type);
      for (const s of stmt.body.statements) this.collectLocalsFromStmt(s, locals);
    } else if (stmt.kind === "while") {
      for (const s of stmt.body.statements) this.collectLocalsFromStmt(s, locals);
    }
  }

  private checkStmt(stmt: Stmt, locals: Map<string, string>, returnType: string): void {
    if (stmt.kind === "const") {
      const valueType = this.checkExpr(stmt.value, locals);
        this.checkObjectLiteralIfNeeded(stmt.type, stmt.value, locals);
        this.checkAssignable(stmt.type, valueType, "const initializer", stmt.value);
    } else if (stmt.kind === "let") {
      if (stmt.value) {
        const valueType = this.checkExpr(stmt.value, locals);
        this.checkObjectLiteralIfNeeded(stmt.type, stmt.value, locals);
        this.checkAssignable(stmt.type, valueType, "let initializer", stmt.value);
      }
    } else if (stmt.kind === "if") {
      this.checkExpr(stmt.condition, locals);
      for (const s of stmt.thenBody.statements) this.checkStmt(s, locals, returnType);
      if (stmt.elseBody) for (const s of stmt.elseBody.statements) this.checkStmt(s, locals, returnType);
    } else if (stmt.kind === "for") {
      if (stmt.init) this.checkStmt(stmt.init, locals, returnType);
      if (stmt.condition) this.checkExpr(stmt.condition, locals);
      if (stmt.update) this.checkExpr(stmt.update, locals);
      for (const s of stmt.body.statements) this.checkStmt(s, locals, returnType);
    } else if (stmt.kind === "while") {
      this.checkExpr(stmt.condition, locals);
      for (const s of stmt.body.statements) this.checkStmt(s, locals, returnType);
    } else if (stmt.kind === "return") {
      const valueType = this.checkExpr(stmt.value, locals);
      this.checkAssignable(returnType, valueType, "return");
    } else if (stmt.kind === "expr") {
      this.checkExpr(stmt.expr, locals);
    }
    // asm: no type check
  }

  private isObjectType(t: string): boolean {
    return this.typeMap.has(t);
  }

  private checkObjectLiteralIfNeeded(targetType: string, valueExpr: Expr, locals: Map<string, string>): void {
    if (valueExpr.kind !== "object" || !this.isObjectType(targetType)) return;
    const fields = this.typeMap.get(targetType)!;
    const provided = new Set(valueExpr.fields.map((f) => f.key));
    for (const [name, expected] of fields) {
      if (!provided.has(name)) throw new TypeCheckError(`Missing field '${name}' in object literal for type ${targetType}`);
    }
    for (const f of valueExpr.fields) {
      const expected = fields.get(f.key);
      if (!expected) throw new TypeCheckError(`Unknown field '${f.key}' in type ${targetType}`);
      const actual = this.checkExpr(f.value, locals);
      this.checkAssignable(expected, actual, `field ${f.key}`);
    }
  }

  private checkAssignable(targetType: string, valueType: string, context: string, _valueExpr?: Expr): void {
    if (targetType === valueType) return;
    if (targetType === "void" && valueType === "int") return;
    if (isPtr(targetType) && (valueType === "ptr<?>" || valueType === "string")) return;
    if (SCALAR_FLOAT.has(targetType) && SCALAR_FLOAT.has(valueType)) return;
    if (isScalarInt(targetType) && isScalarInt(valueType)) return;
    if (this.isObjectType(targetType) && (valueType === targetType || valueType === "object_literal")) return;
    const targetArr = arrayElementType(targetType);
    const valueArr = arrayElementType(valueType) ?? (valueType.endsWith("[]") ? valueType.slice(0, -2) : null);
    if (targetArr && valueArr && targetArr === valueArr) return;
    throw new TypeCheckError(
      `type error in ${context}: cannot assign ${valueType} to ${targetType}`,
    );
  }

  private checkExpr(expr: Expr, locals: Map<string, string>): string {
    switch (expr.kind) {
      case "int":
      case "bool":
        return "int";
      case "float":
        return "double";
      case "null":
        return "ptr<?>";
      case "string":
        return "string";
      case "identifier": {
        const t = locals.get(expr.name);
        if (t) return t;
        if (this.moduleMemberTypes.has(expr.name)) return "module";
        if (this.enumMemberTypes.has(expr.name)) return "enum";
        throw new TypeCheckError(`undefined variable '${expr.name}'`);
      }
      case "binary":
        return this.checkBinary(expr, locals);
      case "unary":
        return this.checkUnary(expr, locals);
      case "addressOf":
        return this.checkAddressOf(expr, locals);
      case "deref":
        return this.checkDeref(expr, locals);
      case "assign":
        return this.checkAssign(expr, locals);
      case "call":
        return this.checkCall(expr, locals);
      case "member":
        return this.checkMember(expr, locals);
      case "index":
        return this.checkIndex(expr, locals);
      case "array":
        return this.checkArrayLiteral(expr, locals);
      case "object":
        return "object_literal";
      case "sizeof":
        return "int";
      case "template":
        return this.checkTemplate(expr, locals);
      case "preIncDec":
      case "postIncDec":
        return this.checkIncDec(expr, locals);
      default:
        return "int";
    }
  }

  private checkBinary(expr: Expr & { kind: "binary" }, locals: Map<string, string>): string {
    const left = this.checkExpr(expr.left, locals);
    const right = this.checkExpr(expr.right, locals);

    if (["+", "-", "*", "/"].includes(expr.op)) {
      if (isPtr(left) && isPtr(right)) {
        throw new TypeCheckError(`cannot ${expr.op} two pointers`);
      }
      if (isPtr(left) || isPtr(right)) {
        const opName = expr.op === "+" ? "add" : expr.op === "-" ? "subtract" : expr.op;
        throw new TypeCheckError(
          `cannot ${opName} pointer and integer without explicit cast`,
        );
      }
      if (isArray(left) || isArray(right)) {
        throw new TypeCheckError(`invalid operand types for ${expr.op}: ${left} and ${right}`);
      }
      if (this.isObjectType(left) || this.isObjectType(right) || left === "object_literal" || right === "object_literal") {
        throw new TypeCheckError(`invalid operand types for ${expr.op}`);
      }
      if (SCALAR_FLOAT.has(left) || SCALAR_FLOAT.has(right)) {
        return arithmeticResultType(left, right);
      }
      if (isScalarInt(left) && isScalarInt(right)) return "int";
      throw new TypeCheckError(`invalid operand types for ${expr.op}: ${left} and ${right}`);
    }

      if (["==", "!="].includes(expr.op)) {
      if (left === "ptr<?>" || right === "ptr<?>") {
        const other = left === "ptr<?>" ? right : left;
        if (!isPtr(other) && other !== "ptr<?>") {
          throw new TypeCheckError(`cannot compare pointer with ${other}`);
        }
        return "int";
      }
      if (isPtr(left) && !isPtr(right) && right !== "ptr<?>") {
        throw new TypeCheckError(`cannot compare pointer with ${right}`);
      }
      if (isPtr(right) && !isPtr(left) && left !== "ptr<?>") {
        throw new TypeCheckError(`cannot compare pointer with ${left}`);
      }
      if (isArray(left) || isArray(right)) {
        if (left !== right) throw new TypeCheckError(`cannot compare ${left} with ${right}`);
      }
      return "int";
    }

    if (["<", ">", "<=", ">="].includes(expr.op)) {
      if (isPtr(left) || isPtr(right)) {
        throw new TypeCheckError(`cannot compare pointers with ${expr.op}`);
      }
      if (isArray(left) || isArray(right)) {
        throw new TypeCheckError(`invalid operand types for ${expr.op}`);
      }
      return "int";
    }

    if (["&&", "||"].includes(expr.op)) {
      return "int";
    }

    return "int";
  }

  private checkUnary(expr: Expr & { kind: "unary" }, locals: Map<string, string>): string {
    this.checkExpr(expr.operand, locals);
    return "int";
  }

  private checkAddressOf(expr: Expr & { kind: "addressOf" }, locals: Map<string, string>): string {
    const inner = this.checkExpr(expr.operand, locals);
    if (inner.endsWith("[]") || /\[\d+\]$/.test(inner)) {
      const elem = arrayElementType(inner);
      return elem ? `ptr<${elem}>` : "int";
    }
    return `ptr<${inner}>`;
  }

  private checkDeref(expr: Expr & { kind: "deref" }, locals: Map<string, string>): string {
    const inner = this.checkExpr(expr.operand, locals);
    if (!isPtr(inner)) {
      throw new TypeCheckError(`cannot dereference non-pointer type ${inner}`);
    }
    const elem = ptrElementType(inner);
    return elem ?? "int";
  }

  private checkAssign(expr: Expr & { kind: "assign" }, locals: Map<string, string>): string {
    let targetType: string;
    if (expr.target.kind === "identifier") {
      const t = locals.get(expr.target.name);
      if (!t) throw new TypeCheckError(`undefined variable '${expr.target.name}'`);
      targetType = t;
      if (this.isObjectType(targetType) && expr.value.kind === "object") {
        this.checkObjectLiteralIfNeeded(targetType, expr.value, locals);
      }
    } else if (expr.target.kind === "index") {
      targetType = this.checkIndex(expr.target, locals);
    } else if (expr.target.kind === "deref") {
      targetType = this.checkDeref(expr.target, locals);
    } else if (expr.target.kind === "member") {
      targetType = this.checkMember(expr.target, locals);
    } else {
      throw new TypeCheckError("invalid assignment target");
    }
    const valueType = this.checkExpr(expr.value, locals);
    this.checkAssignable(targetType, valueType, "assignment");
    return valueType;
  }

  private checkCall(expr: Expr & { kind: "call" }, _locals: Map<string, string>): string {
    if (expr.callee.kind === "member") {
      const obj = expr.callee.object;
      if (obj.kind === "identifier") {
        const modMembers = this.moduleMemberTypes.get(obj.name);
        if (modMembers?.get(expr.callee.property) === "function") {
          return "int";
        }
      }
    }
    if (expr.callee.kind === "identifier") {
      const ret = this.functionReturnTypes.get(expr.callee.name);
      if (ret) return ret;
    }
    return "int";
  }

  private checkMember(expr: Expr & { kind: "member" }, locals: Map<string, string>): string {
    const objType = this.checkExpr(expr.object, locals);
    if (expr.property === "length" && isArray(objType)) return "int";
    if (this.isObjectType(objType)) {
      const fields = this.typeMap.get(objType);
      const ft = fields?.get(expr.property);
      if (ft) return ft;
      throw new TypeCheckError(`Unknown field '${expr.property}' in type ${objType}`);
    }
    if (expr.object.kind === "identifier") {
      const enumMembers = this.enumMemberTypes.get(expr.object.name);
      if (enumMembers?.has(expr.property)) return enumMembers.get(expr.property)!;
      const modMembers = this.moduleMemberTypes.get(expr.object.name);
      const t = modMembers?.get(expr.property);
      if (t) return t === "function" ? "int" : t;
    }
    return "int";
  }

  private checkIndex(expr: Expr & { kind: "index" }, locals: Map<string, string>): string {
    const objType = this.checkExpr(expr.object, locals);
    this.checkExpr(expr.index, locals);
    const elem = arrayElementType(objType);
    if (elem) return elem;
    throw new TypeCheckError(`cannot index type ${objType}`);
  }

  private checkArrayLiteral(expr: Expr & { kind: "array" }, locals: Map<string, string>): string {
    if (expr.elements.length === 0) return "int[]";
    const first = this.checkExpr(expr.elements[0], locals);
    for (let i = 1; i < expr.elements.length; i++) {
      const t = this.checkExpr(expr.elements[i], locals);
      if (t !== first) {
        throw new TypeCheckError(`array elements must have same type; got ${first} and ${t}`);
      }
    }
    return `${first}[]`;
  }

  private checkTemplate(expr: Expr & { kind: "template" }, locals: Map<string, string>): string {
    for (const seg of expr.segments) {
      if (seg.kind === "interpolate") {
        this.checkExpr(seg.expr, locals);
      }
    }
    return "string";
  }

  private checkIncDec(
    expr: Expr & { kind: "preIncDec" | "postIncDec" },
    locals: Map<string, string>,
  ): string {
    const t = this.checkExpr(expr.operand, locals);
    if (!isScalarInt(t) && !isPtr(t)) {
      throw new TypeCheckError(`cannot apply ${expr.op} to type ${t}`);
    }
    return t;
  }
}

export function typeCheck(ast: Program): void {
  const checker = new TypeChecker();
  checker.typeCheck(ast);
}
