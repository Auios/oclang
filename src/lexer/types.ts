export type TokenType =
  | "keyword"
  | "identifier"
  | "type"
  | "int"
  | "string"
  | "template"
  | "lparen"
  | "rparen"
  | "lbrace"
  | "rbrace"
  | "colon"
  | "semicolon"
  | "comma"
  | "dot"
  | "plus"
  | "minus"
  | "star"
  | "slash"
  | "eq"
  | "eqeq"
  | "neq"
  | "le"
  | "ge"
  | "lt"
  | "gt"
  | "and"
  | "or"
  | "bang"
  | "pluseq"
  | "minuseq"
  | "stareq"
  | "slasheq"
  | "plusplus"
  | "minusminus"
  | "at"
  | "boolean"
  | "null"
  | "float"
  | "asm_block"
  | "eof";

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}

export const KEYWORDS = new Set([
  "function", "return", "const", "let", "module", "import",
  "if", "else", "for", "while", "enum", "sizeof", "type",
]);
export const TYPES = new Set(["int", "uint", "byte", "ubyte", "short", "ushort", "long", "ulong", "single", "double", "void", "string"]);
export const BOOLEAN_LITERALS = new Set(["true", "false"]);
export const NULL_LITERAL = "null";
