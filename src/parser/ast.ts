/**
 * Abstract Syntax Tree nodes for oclang
 */

export type Expr =
  | Identifier
  | IntLiteral
  | BoolLiteral
  | NullLiteral
  | FloatLiteral
  | StringLiteral
  | TemplateLiteral
  | SizeOfExpr
  | MemberExpr
  | CallExpr
  | BinaryExpr
  | AddressOfExpr
  | DerefExpr
  | ArrayLiteral
  | IndexExpr
  | AssignExpr
  | UnaryExpr
  | PreIncDecExpr
  | PostIncDecExpr
  | ObjectLiteral;

export interface AddressOfExpr {
  kind: "addressOf";
  operand: Expr;
}

export interface DerefExpr {
  kind: "deref";
  operand: Expr;
}

export interface ArrayLiteral {
  kind: "array";
  elements: Expr[];
}

export interface ObjectLiteral {
  kind: "object";
  fields: Array<{ key: string; value: Expr }>;
}

export interface IndexExpr {
  kind: "index";
  object: Expr;
  index: Expr;
}

export type BinaryOp =
  | "+" | "-" | "*" | "/"
  | "==" | "!="
  | "<" | ">" | "<=" | ">="
  | "&&" | "||";

export interface BinaryExpr {
  kind: "binary";
  left: Expr;
  op: BinaryOp;
  right: Expr;
}

export type AssignOp = "=" | "+=" | "-=" | "*=" | "/=";

export interface AssignExpr {
  kind: "assign";
  target: Expr;
  op: AssignOp;
  value: Expr;
}

export interface UnaryExpr {
  kind: "unary";
  op: "!";
  operand: Expr;
}

export interface PreIncDecExpr {
  kind: "preIncDec";
  op: "++" | "--";
  operand: Expr;
}

export interface PostIncDecExpr {
  kind: "postIncDec";
  operand: Expr;
  op: "++" | "--";
}

export interface SizeOfExpr {
  kind: "sizeof";
  /** Type string from parseType, or variable name to look up */
  typeOrVar: string;
}

export interface Identifier {
  kind: "identifier";
  name: string;
}

export interface IntLiteral {
  kind: "int";
  value: number;
}

export interface BoolLiteral {
  kind: "bool";
  value: boolean;
}

export interface NullLiteral {
  kind: "null";
}

export interface FloatLiteral {
  kind: "float";
  value: number;
}

export interface StringLiteral {
  kind: "string";
  value: string;
}

export type TemplateSegment =
  | { kind: "string"; value: string }
  | { kind: "interpolate"; expr: Expr };

export interface TemplateLiteral {
  kind: "template";
  segments: TemplateSegment[];
}

/** e.g. process.write */
export interface MemberExpr {
  kind: "member";
  object: Expr;
  property: string;
}

/** e.g. process.write(1, "hi") */
export interface CallExpr {
  kind: "call";
  callee: Expr;
  args: Expr[];
}

export type Stmt = ReturnStmt | ExprStmt | ConstDecl | LetDecl | AsmStmt | IfStmt | ForStmt | WhileStmt;

export interface IfStmt {
  kind: "if";
  condition: Expr;
  thenBody: Block;
  elseBody: Block | null;
}

export interface ForStmt {
  kind: "for";
  init: Stmt | null;
  condition: Expr | null;
  update: Expr | null;
  body: Block;
}

export interface WhileStmt {
  kind: "while";
  condition: Expr;
  body: Block;
}

export interface AsmStmt {
  kind: "asm";
  lines: string[];
}

export interface ConstDecl {
  kind: "const";
  name: string;
  type: string;
  value: Expr;
}

export interface LetDecl {
  kind: "let";
  name: string;
  type: string;
  value?: Expr; // optional for ptr; defaults to null
}

export interface ReturnStmt {
  kind: "return";
  value: Expr;
}

export interface ExprStmt {
  kind: "expr";
  expr: Expr;
}

export interface Block {
  statements: Stmt[];
}

export interface ParamDecl {
  name: string;
  type: string;
}

export interface FunctionDecl {
  kind: "function";
  name: string;
  params: ParamDecl[];
  returnType: string;
  body: Block;
}

export type ModuleMember = FunctionDecl | ConstDecl;

export interface ModuleDecl {
  kind: "module";
  name: string;
  members: ModuleMember[];
}

export interface ImportDecl {
  kind: "import";
  path: string;
  modules: string[];
}

export interface EnumMember {
  name: string;
  value: number;
}

export interface EnumDecl {
  kind: "enum";
  name: string;
  underlyingType: string;
  members: EnumMember[];
}

export interface TypeField {
  name: string;
  type: string;
}

export interface TypeDecl {
  kind: "type";
  name: string;
  fields: TypeField[];
}

export type Declaration = FunctionDecl | ModuleDecl | ImportDecl | EnumDecl | TypeDecl;

export interface Program {
  kind: "program";
  declarations: Declaration[];
}
