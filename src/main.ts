/**
 * O'Connor Lang Compiler (occ)
 *
 * Usage: occ <input> [-o <output>] [-k] [-v]
 *   input: .oc file (extension optional)
 *   output: optional; defaults to <input>.exe (same location)
 *   -k, --keep     keep .asm and .obj intermediates; default: delete them
 *   -v, --verbose verbose compiler output
 */

import type { Program, Stmt, FunctionDecl, ImportDecl } from "./parser/ast.ts";
import { typeCheck } from "./typecheck/mod.ts";

function hasReturn(stmt: Stmt): boolean {
  return stmt.kind === "return";
}

function checkFunctionReturns(fn: FunctionDecl): void {
  if (fn.returnType === "void") return;
  const hasReturnStmt = fn.body.statements.some(hasReturn);
  if (!hasReturnStmt) {
    throw new Error(
      `Function '${fn.name}' declares return type '${fn.returnType}' but has no return statement`,
    );
  }
}

function checkReturns(ast: Program): void {
  for (const decl of ast.declarations) {
    if (decl.kind === "function") {
      checkFunctionReturns(decl);
    } else if (decl.kind === "module") {
      for (const member of decl.members) {
        if (member.kind === "function") checkFunctionReturns(member);
      }
    }
  }
}

/** Resolve path relative to baseDir (directory of the importing file). Handles . and .. */
function resolveImportPath(baseDir: string, path: string): string {
  if (path.startsWith("/")) return path;
  const segments = `${baseDir}/${path}`.split("/").filter(Boolean);
  const result: string[] = [];
  for (const seg of segments) {
    if (seg === "..") result.pop();
    else if (seg !== ".") result.push(seg);
  }
  return result.join("/") || ".";
}

async function resolveImports(ast: Program, importingFilePath: string): Promise<void> {
  const baseDir = importingFilePath.includes("/")
    ? importingFilePath.slice(0, importingFilePath.lastIndexOf("/"))
    : ".";
  const { Lexer } = await import("./lexer/mod.ts");
  const { Parser } = await import("./parser/mod.ts");
  for (const decl of ast.declarations) {
    if (decl.kind !== "import") continue;
    const imp = decl as ImportDecl;
    const resolved = resolveImportPath(baseDir, imp.path);
    const source = await Deno.readTextFile(resolved);
    const lexer = new Lexer(source);
    const tokens = lexer.tokenize();
    const parser = new Parser(tokens);
    const importedAst = parser.parse();
    for (const modName of imp.modules) {
      const mod = importedAst.declarations.find((d) => d.kind === "module" && d.name === modName);
      if (!mod || mod.kind !== "module") continue;
      const existing = ast.declarations.find((d) => d.kind === "module" && d.name === modName);
      if (existing && existing.kind === "module") {
        const existingNames = new Set(existing.members.map((m) => m.name));
        for (const m of mod.members) {
          if (!existingNames.has(m.name)) {
            existing.members.push(m);
            existingNames.add(m.name);
          }
        }
      } else {
        ast.declarations.unshift(mod);
      }
    }
  }
}

function parseArgs(
  args: string[],
): { input: string; output: string; keep: boolean; verbose: boolean } | null {
  let input: string | null = null;
  let output: string | null = null;
  let keep = false;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-o" || args[i] === "--output") && i + 1 < args.length) {
      output = args[++i];
    } else if (args[i] === "-k" || args[i] === "--keep") {
      keep = true;
    } else if (args[i] === "-v" || args[i] === "--verbose") {
      verbose = true;
    } else if (!args[i].startsWith("-")) {
      input = args[i].endsWith(".oc") ? args[i] : `${args[i]}.oc`;
    }
  }

  if (!input) return null;
  if (!output) {
    output = input.replace(/\.oc$/i, "") + ".exe";
  }
  return { input, output, keep, verbose };
}

async function main(): Promise<number> {
  const args = parseArgs(Deno.args);

  if (!args) {
    console.error("Usage: occ <input> [-o <output> | --output <output>] [-k] [-v]");
    console.error("  Example: occ examples/hello_world.oc");
    console.error("  Example: occ hello_world -o my_program.exe");
    console.error("  Example: occ add.oc -k   (keep .asm and .obj)");
    console.error("  Example: occ add.oc -v   (verbose)");
    return 1;
  }

  const { input, output, keep, verbose } = args;
  const startTime = performance.now();

  try {
    const source = await Deno.readTextFile(input);
    const { Lexer } = await import("./lexer/mod.ts");
    const { Parser } = await import("./parser/mod.ts");
    const { Codegen } = await import("./codegen/mod.ts");

    const lexer = new Lexer(source);
    const tokens = lexer.tokenize();
    const parser = new Parser(tokens);
    const ast = parser.parse();

    checkReturns(ast);

    const inputResolved = input.startsWith("/") || /^[A-Za-z]:/.test(input)
      ? input
      : `${Deno.cwd().replace(/\\/g, "/")}/${input}`.replace(/\/+/g, "/");
    await resolveImports(ast, inputResolved);

    typeCheck(ast);

    const codegen = new Codegen({ verbose });
    const asm = codegen.generate(ast);

    const base = output.replace(/\.exe$/i, "") || output;
    const asmPath = `${base}.asm`;
    const objPath = `${base}.obj`;

    await Deno.writeTextFile(asmPath, asm);

    const nasm = new Deno.Command("nasm", {
      args: ["-f", "win64", asmPath, "-o", objPath],
    });
    const nasmResult = await nasm.output();
    if (!nasmResult.success) {
      console.error("nasm failed:", new TextDecoder().decode(nasmResult.stderr));
      return 1;
    }

    const linker = new Deno.Command("gcc", {
      args: [
        objPath,
        "-o", output,
        "-nostdlib",
        "-e", "main",
        "-lkernel32",
      ],
    });
    const linkResult = await linker.output();
    if (!linkResult.success) {
      console.error("Linker failed:", new TextDecoder().decode(linkResult.stderr));
      return 1;
    }

    if (!keep) {
      await Deno.remove(asmPath);
      await Deno.remove(objPath);
    }

    const elapsedMs = performance.now() - startTime;
    const stat = await Deno.stat(output);
    const sizeKb = (stat.size / 1024).toFixed(1);

    console.log(`Compiled ${input} → ${output}`);
    console.log(`  ${elapsedMs.toFixed(0)}ms, ${sizeKb} KB`);
    return 0;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

Deno.exit(await main());
