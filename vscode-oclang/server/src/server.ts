import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  InsertTextFormat,
  Diagnostic,
  DiagnosticSeverity,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

const KEYWORDS = [
  "function",
  "return",
  "const",
  "let",
  "if",
  "else",
  "for",
  "while",
  "module",
  "import",
  "type",
  "enum",
  "sizeof",
];

const TYPES = [
  "int",
  "uint",
  "byte",
  "ubyte",
  "short",
  "ushort",
  "long",
  "ulong",
  "single",
  "double",
  "void",
  "string",
];

const LITERALS = ["true", "false", "null"];

const PROCESS_MEMBERS = [
  { label: "write", kind: CompletionItemKind.Method, detail: "(fd: int, msg: string | int | template)" },
  { label: "stdin", kind: CompletionItemKind.Constant, detail: "int = 0" },
  { label: "stdout", kind: CompletionItemKind.Constant, detail: "int = 1" },
  { label: "stderr", kind: CompletionItemKind.Constant, detail: "int = 2" },
  { label: "_write_string", kind: CompletionItemKind.Method, detail: "(handle, ptr, len) - low-level" },
  { label: "_write_int", kind: CompletionItemKind.Method, detail: "(handle, value) - low-level" },
  { label: "_write_float", kind: CompletionItemKind.Method, detail: "(handle, value) - low-level" },
  { label: "exit", kind: CompletionItemKind.Method, detail: "(code: int)" },
  { label: "cwd", kind: CompletionItemKind.Method, detail: "()" },
  { label: "chdir", kind: CompletionItemKind.Method, detail: "(path)" },
];

const OS_MEMBERS = [
  { label: "name", kind: CompletionItemKind.Method, detail: "()" },
  { label: "arch", kind: CompletionItemKind.Method, detail: "()" },
  { label: "cpuCount", kind: CompletionItemKind.Method, detail: "()" },
  { label: "pageSize", kind: CompletionItemKind.Method, detail: "()" },
  { label: "hostname", kind: CompletionItemKind.Method, detail: "()" },
  { label: "sleep", kind: CompletionItemKind.Method, detail: "(ms: int)" },
  { label: "spawn", kind: CompletionItemKind.Method, detail: "(path)" },
  { label: "kill", kind: CompletionItemKind.Method, detail: "(pid: int)" },
  { label: "tempDir", kind: CompletionItemKind.Method, detail: "()" },
  { label: "homeDir", kind: CompletionItemKind.Method, detail: "()" },
];

function getLineBeforePosition(document: TextDocument, position: { line: number; character: number }): string {
  const line = document.getText({
    start: { line: position.line, character: 0 },
    end: position,
  });
  return line;
}

/** Extract imported module names from import("path", [mod1, mod2, ...]) */
function getImportedModules(document: TextDocument): string[] {
  const text = document.getText();
  const modules: string[] = [];
  const importRegex = /import\s*\([^)]+,\s*\[([^\]]+)\]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(text))) {
    const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    for (const name of names) {
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) && !modules.includes(name)) {
        modules.push(name);
      }
    }
  }
  return modules;
}

/** Extract enum names and their members from enum Name { ... } or enum Name: type { ... } */
function getDeclaredEnums(document: TextDocument): { name: string; members: string[] }[] {
  const text = document.getText();
  const result: { name: string; members: string[] }[] = [];
  const enumRegex = /enum\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::\s*[a-zA-Z_][a-zA-Z0-9_]*)?\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = enumRegex.exec(text))) {
    const name = m[1];
    const body = m[2];
    const members = body
      .split(",")
      .map((s) => s.replace(/\s*=.*$/, "").trim())
      .filter((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s));
    result.push({ name, members });
  }
  return result;
}

/** Extract type/struct names from type Name { ... } */
function getDeclaredTypes(document: TextDocument): string[] {
  const text = document.getText();
  const types: string[] = [];
  const typeRegex = /type\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = typeRegex.exec(text))) {
    if (!types.includes(m[1])) types.push(m[1]);
  }
  return types;
}

const STATEMENT_KEYWORDS = new Set(["const", "let", "if", "else", "for", "while", "return", "module", "import", "type", "enum"]);

function validateDocument(document: TextDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const enums = getDeclaredEnums(document);
  const types = getDeclaredTypes(document);
  const typeAndEnumNames = new Set([...enums.map((e) => e.name), ...types]);

  const lines = document.getText().split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    const constNoType = trimmed.match(/^const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*/);
    if (constNoType) {
      const name = constNoType[1];
      const start = line.indexOf(name);
      const end = start + name.length;
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: {
          start: { line: i, character: start },
          end: { line: i, character: end },
        },
        message:
          "const requires an explicit type (use `const name: type = value`); oclang does not infer types",
      });
    }

    const letNoTypeEq = trimmed.match(/^let\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*/);
    if (letNoTypeEq) {
      const name = letNoTypeEq[1];
      const start = line.indexOf(name);
      const end = start + name.length;
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: {
          start: { line: i, character: start },
          end: { line: i, character: end },
        },
        message:
          "let requires an explicit type (use `let name: type = value`); oclang does not infer types",
      });
    }

    const assignMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=/);
    if (assignMatch) {
      const lhs = assignMatch[1];
      if (!STATEMENT_KEYWORDS.has(lhs) && typeAndEnumNames.has(lhs)) {
        const start = line.indexOf(assignMatch[1]);
        const end = start + assignMatch[1].length;
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: {
            start: { line: i, character: start },
            end: { line: i, character: end },
          },
          message: `Cannot assign to '${lhs}'; enums and types are not assignable`,
        });
      }
    }
  }
  return diagnostics;
}

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        triggerCharacters: [".", ":", " "],
      },
    },
  };
});

connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];

  const line = getLineBeforePosition(document, params.position);
  const trimmed = line.trimEnd();

  if (trimmed.endsWith("process.")) {
    return PROCESS_MEMBERS.map((m) => ({
      ...m,
      documentation: m.detail ? { kind: "plaintext" as const, value: m.detail } : undefined,
    }));
  }

  if (trimmed.endsWith("os.")) {
    return OS_MEMBERS.map((m) => ({
      ...m,
      documentation: m.detail ? { kind: "plaintext" as const, value: m.detail } : undefined,
    }));
  }

  const enums = getDeclaredEnums(document);
  for (const { name, members } of enums) {
    if (trimmed.endsWith(`${name}.`)) {
      return members.map((mem) => ({
        label: mem,
        kind: CompletionItemKind.EnumMember,
        detail: `${name} member`,
      }));
    }
  }

  if (trimmed.endsWith(": ") || /:\s*$/.test(trimmed) || /\b(let|const)\s+\w+\s*:\s*$/.test(trimmed)) {
    const customTypes = [...getDeclaredTypes(document), ...enums.map((e) => e.name)];
    return [
      ...TYPES.map((t) => ({ label: t, kind: CompletionItemKind.TypeParameter as CompletionItemKind })),
      ...customTypes.map((t) => ({
        label: t,
        kind: CompletionItemKind.Class,
        detail: enums.some((e) => e.name === t) ? "enum" : "type",
      })),
      {
        label: "ptr<T>",
        kind: CompletionItemKind.TypeParameter,
        insertText: "ptr<${1:int}>",
        insertTextFormat: InsertTextFormat.Snippet,
      },
    ];
  }

  const wordMatch = trimmed.match(/\b(\w*)$/);
  const prefix = wordMatch ? wordMatch[1].toLowerCase() : "";

  const importedModules = getImportedModules(document);
  const moduleDetails: Record<string, string> = {
    process: "imported module (stdlib)",
    os: "imported module (stdlib)",
  };

  const all: CompletionItem[] = [
    ...KEYWORDS.filter((k) => k.startsWith(prefix)).map((k) => ({
      label: k,
      kind: CompletionItemKind.Keyword,
    })),
    ...TYPES.filter((t) => t.startsWith(prefix)).map((t) => ({
      label: t,
      kind: CompletionItemKind.TypeParameter as CompletionItemKind,
    })),
    ...LITERALS.filter((l) => l.startsWith(prefix)).map((l) => ({
      label: l,
      kind: CompletionItemKind.Value,
    })),
    ...importedModules
      .filter((mod) => mod.toLowerCase().startsWith(prefix))
      .map((mod) => ({
        label: mod,
        kind: CompletionItemKind.Module,
        detail: moduleDetails[mod] ?? "imported module",
      })),
    ...enums
      .filter((e) => e.name.toLowerCase().startsWith(prefix))
      .map((e) => ({
        label: e.name,
        kind: CompletionItemKind.Enum,
        detail: "enum",
      })),
    ...getDeclaredTypes(document)
      .filter((t) => t.toLowerCase().startsWith(prefix) && !enums.some((e) => e.name === t))
      .map((t) => ({
        label: t,
        kind: CompletionItemKind.Class,
        detail: "type",
      })),
  ];

  if (prefix === "" || "main".startsWith(prefix)) {
    all.push({ label: "main", kind: CompletionItemKind.Function, detail: "Entry point" });
  }

  return all;
});

documents.onDidChangeContent((change) => {
  const diagnostics = validateDocument(change.document);
  connection.sendDiagnostics({ uri: change.document.uri, diagnostics });
});

documents.onDidOpen((event) => {
  const diagnostics = validateDocument(event.document);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics });
});

documents.onDidClose((event) => {
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

documents.listen(connection);
connection.listen();
