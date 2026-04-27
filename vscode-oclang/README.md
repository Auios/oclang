# O'Connor Language (oclang) - VS Code Extension

Syntax highlighting and IntelliSense for the oclang programming language.

## Features

- **Syntax highlighting** – Keywords, types, strings, template literals, numbers, comments
- **Inline assembly** – Special highlighting for `__asm { ... }` blocks (x64 instructions, registers, labels)
- **Language support** – Brackets, comments, and word pattern for `.oc` files
- **IntelliSense / Auto-complete** – Context-aware completions:
  - Keywords: `function`, `return`, `const`, `let`, `if`, `else`, `for`, `while`, `module`, `import`, `type`, `enum`, `sizeof`
  - Types: `int`, `uint`, `byte`, `string`, `ptr<T>`, etc.
  - `process.*` – `write`, `stdout`, `stderr`, `_write_string`, etc.
  - `os.*` – `cpuCount`, `sleep`, `hostname`, etc.

## Installation

### From source (development)

1. Copy or clone the `vscode-oclang` folder
2. Open VS Code or Cursor
3. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
4. Run **Extensions: Install Extension from Location...**
5. Select the `vscode-oclang` folder

### Package and install locally

```bash
cd vscode-oclang
npm install -g @vscode/vsce
vsce package
code --install-extension oclang-0.2.0.vsix
```

The `.vsix` name is `oclang-<version>.vsix`, where `<version>` is the `version` field in this folder’s `package.json`.

## Scope Support

| Element           | Scope                                                       |
| ----------------- | ----------------------------------------------------------- |
| Keywords          | `keyword.control.oc`                                        |
| Types             | `storage.type.primitive.oc`                                 |
| Pointers          | `storage.type.ptr.oc`                                       |
| Strings           | `string.quoted.double.oc`                                   |
| Template literals | `string.quoted.template.oc`                                 |
| Booleans          | `constant.language.boolean.oc`                              |
| Null              | `constant.language.null.oc`                                 |
| Numbers           | `constant.numeric.integer.oc` / `constant.numeric.float.oc` |
| Comments          | `comment.line.double-slash.oc`                              |
| Inline asm        | `meta.asm.oc`                                               |
