/**
 * Test script: compile and run all .oc files.
 * Generates .exe for each. Prints compilation/runtime errors to terminal.
 * Exits with 1 if any compile or run fails.
 */

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  brightYellow: "\x1b[93m",
  brightCyan: "\x1b[96m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  gray: "\x1b[90m",
};

async function findOcFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    const path = `${dir}/${e.name}`.replace(/\\/g, "/");
    if (e.isDirectory && !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "lib") {
      files.push(...await findOcFiles(path));
    } else if (e.isFile && e.name.endsWith(".oc")) {
      files.push(path);
    }
  }
  return files.sort();
}

/** Check if the file expects compilation to fail (e.g. type_mismatch_example.oc). */
async function expectsCompileFail(ocPath: string): Promise<boolean> {
  try {
    const content = await Deno.readTextFile(ocPath);
    const head = content.slice(0, 1024);
    return /\/\/\s*expect:\s*compile-fail|\/\*\s*expect:\s*compile-fail\s*\*\//.test(head);
  } catch {
    return false;
  }
}

async function run(
  cmd: string[],
  cwd?: string,
): Promise<{ ok: boolean; out: string; err: string }> {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: cwd ?? Deno.cwd(),
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await p.output();
  return {
    ok: code === 0,
    out: new TextDecoder().decode(stdout),
    err: new TextDecoder().decode(stderr),
  };
}

async function main(): Promise<number> {
  const ocFiles = await findOcFiles(".");
  if (ocFiles.length === 0) {
    console.log("No .oc files found.");
    return 0;
  }

  let failed = 0;
  const total = ocFiles.length;
  for (let i = 0; i < ocFiles.length; i++) {
    const oc = ocFiles[i];
    const n = i + 1;
    const base = oc.replace(/\.oc$/i, "");
    const exe = `${base}.exe`;

    console.log(`${c.brightYellow}${c.bold}[${n}/${total}]${c.reset} ${c.brightBlue}${oc}${c.reset}`);

    const expectCompileFail = await expectsCompileFail(oc);
    await Deno.stdout.write(new TextEncoder().encode(`  ${c.brightCyan}Compile${c.reset}... `));

    const compileStart = performance.now();
    const compile = await run(["deno", "run", "-A", "src/main.ts", oc]);
    const compileMs = performance.now() - compileStart;

    if (expectCompileFail) {
      if (compile.ok) {
        console.log(`${c.red}${c.bold}FAIL${c.reset}`);
        console.error(`${c.red}Expected compilation to fail (expect: compile-fail) but it succeeded.${c.reset}`);
        failed++;
      } else {
        console.log(`${c.green}${c.bold}OK${c.reset} ${c.gray}(expected fail)${c.reset}`);
        if (verbose) {
          const msg = (compile.err || compile.out).trim();
          if (msg) console.log(`${c.dim}  (compile error as expected)${c.reset}`);
        }
      }
      continue;
    }

    if (!compile.ok) {
      console.log(`${c.red}${c.bold}FAIL${c.reset}`);
      console.error(`${c.red}Compilation error:${c.reset}\n` + (compile.err || compile.out).trim());
      failed++;
      continue;
    }

    let sizeKb = "";
    try {
      const stat = await Deno.stat(exe);
      sizeKb = ` ${compileMs.toFixed(0)}ms, ${(stat.size / 1024).toFixed(1)} KB`;
    } catch {
      sizeKb = ` ${compileMs.toFixed(0)}ms`;
    }
    console.log(`${c.green}${c.bold}OK${c.reset}${c.gray}${sizeKb}${c.reset}`);

    await Deno.stdout.write(new TextEncoder().encode(`  ${c.brightMagenta}Run${c.reset}... `));
    const exePath = exe.replace(/\//g, Deno.build.os === "windows" ? "\\" : "/");
    const runResult = await run([exePath]);
    if (!runResult.ok) {
      console.log(`${c.red}${c.bold}FAIL${c.reset}`);
      console.error(`${c.red}Runtime error:${c.reset}\n` + (runResult.err || runResult.out).trim());
      failed++;
    } else {
      console.log(`${c.green}${c.bold}OK${c.reset}`);
      if (verbose && (runResult.out || runResult.err)) {
        const out = runResult.out?.trim();
        const err = runResult.err?.trim();
        if (out) console.log(`${c.dim}  stdout:${c.reset}\n${out.split("\n").map((l) => `  ${l}`).join("\n")}`);
        if (err) console.error(`${c.dim}  stderr:${c.reset}\n${err.split("\n").map((l) => `  ${l}`).join("\n")}`);
      }
    }
  }

  if (failed > 0) {
    console.error(`\n${c.red}${c.bold}✗ ${failed} test(s) failed${c.reset}`);
    return 1;
  }
  console.log(`\n${c.green}${c.bold}✓ All ${ocFiles.length} tests passed${c.reset}`);
  return 0;
}

const verbose = Deno.args.includes("-v") || Deno.args.includes("--verbose");

Deno.exit(await main());
