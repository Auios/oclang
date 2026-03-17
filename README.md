# O'Connor Programming Language (oclang)

This is **oclang**, a small compiled language I'm building to learn more about compilers. I've taken inspiration from C and TypeScript. If it ends up useful for tiny tools, experiments, or embedded tinkering, great. Source files use `.oc`.

**64-bit only** - Targetting 64bit architecture only at the moment.

A programming language is **for humans first** - we're the ones who have to read, reason about, and maintain the source. The computer is just the part that runs it. So I'm interested in **explicit definitions** people can actually consume: what's happening should be written down in plain view, not implied or scattered across hidden rules.

What that means for **oclang**:

- **Simplicity** over cleverness; **explicit** over implicit magic.
- **Reader-focused** prose in code form - scan a file and know what's going on without decoding dialect trivia.
- No guessing what you meant, no papering over behavior, no invisible rules you have to memorize.
- **Inspiration:** **C** for staying close to the metal and honest about the machine; **TypeScript** for syntax and ergonomics that feel natural in a modern editor.
- **Where I'm frustrated with C:** the ecosystem has turned into a patchwork - overlapping and disorganized standards, compiler- and vendor-specific habits, conventions that don't match from one codebase to the next.
- **What I'm aiming for instead:** **opinionated** standards and real **consistency** that can be found between different people's codebases and from project to project.

---

## Requirements

- **Deno** – compiler runtime
- **NASM** – assembler (x64 Windows: `nasm -f win64`)
- **GCC** (MinGW) – linker, for `-nostdlib -e main -lkernel32`

---

## Build

```bash
# Compile .oc → .exe (no libc, uses kernel32 directly)
deno task occ examples/hello_world -o hello_world.exe

# Or run directly
deno run -A src/main.ts examples/hello_world -o hello_world.exe

# Install global `occ` command (optional)
deno task install
# Then: occ examples/hello_world -o hello_world.exe
```

### Options

| Flag                    | Description                                                                       |
| ----------------------- | --------------------------------------------------------------------------------- |
| `-o`, `--output <path>` | Output executable path (default: `<input>.exe`)                                   |
| `-k`, `--keep`          | Keep `.asm` and `.obj` intermediate files; by default only the `.exe` is retained |
| `-v`, `--verbose`       | Verbose compiler output                                                           |

---

## Language Design

### Keywords

| Keyword    | Purpose                                                             | Implemented |
| ---------- | ------------------------------------------------------------------- | ----------- |
| `function` | Declare a function                                                  | ✓           |
| `return`   | Return a value from a function                                      | ✓           |
| `const`    | Declare an immutable local variable                                 | ✓           |
| `let`      | Mutable local variable                                              | ✓           |
| `if`       | Conditional branching                                               | ✓           |
| `else`     | Else branch                                                         | ✓           |
| `for`      | Loop                                                                | ✓           |
| `while`    | Loop                                                                | ✓           |
| `module`   | Define a namespace / module                                         | ✓           |
| `import`   | Import modules from a file                                          | ✓           |
| `export`   | Module exports (inferred via `module`)                              | ✓           |
| `type`     | Type alias / struct definition; see `examples/employee_example.oc`  | ✓           |
| `enum`     | Enumerations; see `examples/enum_example.oc`                        | ✓           |
| `sizeof`   | Size in bytes of type or variable; see `examples/sizeof_example.oc` | ✓           |

---

### Types

| Type        | Size          | Description                                                                                           | Implemented |
| ----------- | ------------- | ----------------------------------------------------------------------------------------------------- | ----------- |
| `void`      | -             | No value (return type only); see `examples/types_example.oc`                                          | ✓           |
| `byte`      | 1 byte        | 8-bit signed integer; see `examples/types_example.oc`                                                 | ✓           |
| `ubyte`     | 1 byte        | 8-bit unsigned integer; enum underlying; see `examples/sizeof_example.oc`, `examples/enum_example.oc` | ✓           |
| `short`     | 2 bytes       | 16-bit signed integer; see `examples/types_example.oc`                                                | ✓           |
| `ushort`    | 2 bytes       | 16-bit unsigned integer; see `examples/types_example.oc`                                              | ✓           |
| `int`       | 4 bytes       | 32-bit signed integer                                                                                 | ✓           |
| `uint`      | 4 bytes       | 32-bit unsigned integer; see `examples/types_example.oc`                                              | ✓           |
| `long`      | 8 bytes       | 64-bit signed integer; see `examples/types_example.oc`                                                | ✓           |
| `ulong`     | 8 bytes       | 64-bit unsigned integer; see `examples/types_example.oc`                                              | ✓           |
| `single`    | 4 bytes       | 32-bit float; see `examples/float_example.oc`                                                         | ✓           |
| `double`    | 8 bytes       | 64-bit float; see `examples/float_example.oc`                                                         | ✓           |
| `string`    | 8 bytes       | Pointer to string data (string literals only; no `string` variable type)                              |             |
| `ptr<T>`    | 8 bytes       | Pointer to T; can be `null`; see `examples/ptr_example.oc`, `examples/null_example.oc`                | ✓           |
| `T[]`       | -             | Variable-length array (TypeScript-style); see `examples/array_example.oc`                             | ✓           |
| `T[N]`      | N × size of T | Fixed-length array; see `examples/array_example.oc`                                                   | ✓           |
| Custom type | -             | `type Name { field: Type; ... }`; pass-by-sharing (like Node.js); see `examples/employee_example.oc`  | ✓           |

Use `sizeof(type)` or `sizeof(var)` to verify sizes at compile time. See `examples/sizeof_example.oc` and `examples/types_example.oc` for all implemented types.

#### Custom types (pass-by-sharing)

Define struct-like types with `type Name { field: Type; ... }`. Objects use **pass-by-sharing** (like JavaScript/Node.js): mutating `obj.field` affects the original; reassigning the parameter `obj = { ... }` does not affect the caller.

```oc
type Employee { id: int; age: int; salary: int; }

function promote(emp: Employee, raise: int): void {
  emp.salary = emp.salary + raise;  // mutates shared object
}

let alice: Employee = { id: 1, age: 30, salary: 50000 };
promote(alice, 5000);  // alice.salary is now 55000
```

See `examples/employee_example.oc` and `examples/employee_minimal.oc`.

**Implemented:** Type checking rejects incompatible operations (e.g. `int + ptr`, dereference of non-pointer); see `examples/type_mismatch_example.oc` for expected compile-time errors.

---

### Operators

| Operator            | Purpose                         | Implemented |
| ------------------- | ------------------------------- | ----------- |
| `+`                 | Addition                        | ✓           |
| `-`                 | Subtraction                     | ✓           |
| `*`                 | Multiplication                  | ✓           |
| `/`                 | Division                        | ✓           |
| `=`                 | Assignment / const init         | ✓           |
| `:`                 | Type annotation                 | ✓           |
| `;`                 | Statement terminator            | ✓           |
| `,`                 | Argument/param separator        | ✓           |
| `.`                 | Member access                   | ✓           |
| `==`                | Equality                        | ✓           |
| `!=`                | Inequality                      | ✓           |
| `<` `>` `<=` `>=`   | Comparison                      | ✓           |
| `&&` `\|\|` `!`     | Logical                         | ✓           |
| `+=` `-=` `*=` `/=` | Compound assignment             | ✓           |
| `++` `--`           | Increment / decrement           | ✓           |
| `@x`                | Address-of (reference to x)     | ✓           |
| `*p`                | Dereference pointer             | ✓           |
| `a[i]`              | Array index                     | ✓           |
| `arr.length`        | Array length (TypeScript-style) | ✓           |

See `examples/operators_example.oc` for usage of equality, comparison, logical, compound assignment, and increment/decrement operators.

---

### Built-ins

| API                    | Description                                                           | Implemented |
| ---------------------- | --------------------------------------------------------------------- | ----------- |
| `process.write(fd, x)` | Write to fd: 0=stdin, 1=stdout, 2=stderr. x: string, int, or template | ✓           |

---

### Statements

| Statement            | Example                                                                   | Implemented |
| -------------------- | ------------------------------------------------------------------------- | ----------- |
| Function declaration | `function add(a: int, b: int): int { ... }`                               | ✓           |
| Return               | `return x;`                                                               | ✓           |
| Const declaration    | `const sum: int = add(2, 3);`                                             | ✓           |
| Expression statement | `process.write(1, "hi");`                                                 | ✓           |
| If/else              | `if (x > 0) { ... } else { ... }`                                         | ✓           |
| For loop             | `for (let i = 0; i < 10; i++) { ... }`                                    | ✓           |
| While loop           | `while (cond) { ... }`                                                    | ✓           |
| Let                  | `let x: int = 0;` or `let p: ptr<int>;` (ptr defaults to null)            | ✓           |
| Array declaration    | `const arr: int[] = [1, 2, 3];` or `const buf: int[5] = [1, 2, 3, 4, 5];` | ✓           |
| Type declaration     | `type Employee { id: int; age: int; salary: int; }`                       | ✓           |
| Object literal       | `let emp: Employee = { id: 1, age: 30, salary: 50000 };`                  | ✓           |
| Inline assembly      | `__asm { sub rsp, 32; mov ecx, 0; call ExitProcess }`                     | ✓           |

Inline assembly (`__asm { ... }`) emits raw x64 NASM into the function body. Use `;` or `//` for comments.

Examples: `examples/if_example.oc`, `examples/for_example.oc`, `examples/while_example.oc`, `examples/employee_example.oc` (custom types, pass-by-sharing)

---

### Literals

| Literal         | Example                                 | Implemented |
| --------------- | --------------------------------------- | ----------- |
| Integer         | `42`, `0`, `-1`                         | ✓           |
| String          | `"hello"`, `"line\nbreak"`              | ✓           |
| Template string | `` `hello ${name}` ``, `` `x = ${x}` `` | ✓           |
| Boolean         | `true`, `false`                         | ✓           |
| Null            | `null` (for pointers)                   | ✓           |
| Float           | `3.14`, `1e-10`                         | ✓           |
| Array           | `[1, 2, 3]`, `["a", "b"]`               | ✓           |
| Object          | `{ id: 1, age: 30, salary: 50000 }`     | ✓           |

Template strings use backticks and `${expr}` for interpolation (JavaScript-style). Use `\`` and `\${`for literal backticks and`$`+`{`.

---

### Modules

**Modules** are namespaces that group functions and variables. A module defined in a file can be imported from another file. Conceptually, the compiler behaves as if a prelude is injected (Rust/Zig style):

```
import std.process
import std.os
```

#### Defining modules

Use `module name { ... }` to define a module. The body contains `function` and `const` declarations:

```oc
module process {
  const stdin: int = 0;
  const stdout: int = 0;
  function exit(code: int): int { return 0; }
}
```

#### Importing modules

Import from a file and select which modules to bring in:

```oc
import("lib/stdlib.oc", [os, process]);
```

A file like `lib/stdlib.oc` can define multiple modules. Access members via `module.member`:

```oc
process.exit(0);
process.write(1, `stdout handle: ${process.stdout}`);
```

#### Standard library (lib/stdlib.oc)

| Module      | Members                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| **process** | `stdin`, `stdout`, `stderr`, `args`, `env`, `write(fd, msg)`, `cwd()`, `chdir()`, `exit()`                             |
| **os**      | `name()`, `arch()`, `cpuCount()`, `pageSize()`, `hostname()`, `sleep()`, `spawn()`, `kill()`, `tempDir()`, `homeDir()` |

These are implemented as stubs; full implementations are planned.
