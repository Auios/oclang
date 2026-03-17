import type { Token } from "../lexer/types.ts";
import { Lexer } from "../lexer/lexer.ts";
import type {
  Program,
  FunctionDecl,
  Block,
  Stmt,
  Expr,
  TemplateSegment,
  Declaration,
  ModuleDecl,
  ImportDecl,
  ModuleMember,
} from "./ast.ts";

export class ParseError extends Error {
  constructor(
    message: string,
    public line: number,
    public column: number,
  ) {
    super(`${message} at ${line}:${column}`);
    this.name = "ParseError";
  }
}

export class Parser {
  private tokens: Token[];
  private pos = 0;
  private currentReturnType: string | null = null;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1];
  }

  private advance(): Token {
    const t = this.peek();
    if (t.type !== "eof") this.pos++;
    return t;
  }

  private check(type: Token["type"], value?: string): boolean {
    const t = this.peek();
    if (t.type !== type) return false;
    if (value !== undefined && t.value !== value) return false;
    return true;
  }

  /** parseType: int | ptr<int> | int[] | int[N] */
  private parseType(): string {
    const t = this.peek();
    if (t.type !== "type" && t.type !== "identifier") {
      throw new ParseError(
        `Expected type, got ${t.type} "${t.value}"`,
        t.line,
        t.column,
      );
    }
    const base = this.advance().value;
    if (this.check("lt")) {
      this.advance();
      const inner = this.parseType();
      this.expect("gt");
      return `ptr<${inner}>`;
    }
    if (this.check("lsquare")) {
      this.advance();
      if (this.check("rsquare")) {
        this.advance();
        return `${base}[]`;
      }
      const n = this.expect("int").value;
      this.expect("rsquare");
      return `${base}[${n}]`;
    }
    return base;
  }

  private expect(type: Token["type"], value?: string): Token {
    const t = this.peek();
    if (t.type !== type) {
      throw new ParseError(
        `Expected ${value ?? type}, got ${t.type} "${t.value}"`,
        t.line,
        t.column,
      );
    }
    if (value !== undefined && t.value !== value) {
      throw new ParseError(`Expected "${value}", got "${t.value}"`, t.line, t.column);
    }
    return this.advance();
  }

  parse(): Program {
    const declarations: Declaration[] = [];
    while (!this.check("eof")) {
      if (this.check("keyword", "module")) {
        declarations.push(this.parseModuleDecl());
      } else if (this.check("keyword", "import")) {
        declarations.push(this.parseImportDecl());
      } else if (this.check("keyword", "function")) {
        declarations.push(this.parseFunctionDecl());
      } else if (this.check("keyword", "enum")) {
        declarations.push(this.parseEnumDecl());
      } else if (this.check("keyword", "type")) {
        declarations.push(this.parseTypeDecl());
      } else {
        throw new ParseError(
          `Expected module, import, function, enum, or type, got ${this.peek().type} "${this.peek().value}"`,
          this.peek().line,
          this.peek().column,
        );
      }
    }
    return { kind: "program", declarations };
  }

  private parseTypeDecl(): import("./ast.ts").TypeDecl {
    this.expect("keyword", "type");
    const name = this.expect("identifier").value;
    this.expect("lbrace");
    const fields: import("./ast.ts").TypeField[] = [];
    while (!this.check("rbrace") && !this.check("eof")) {
      const fieldName = this.expect("identifier").value;
      this.expect("colon");
      const fieldType = this.parseType();
      fields.push({ name: fieldName, type: fieldType });
      if (!this.check("rbrace")) this.expect("semicolon");
    }
    this.expect("rbrace");
    return { kind: "type", name, fields };
  }

  private parseModuleDecl(): ModuleDecl {
    this.expect("keyword", "module");
    const name = this.expect("identifier").value;
    this.expect("lbrace");
    const members: ModuleMember[] = [];
    while (!this.check("rbrace") && !this.check("eof")) {
      if (this.check("keyword", "function")) {
        members.push(this.parseFunctionDecl());
      } else if (this.check("keyword", "const")) {
        members.push(this.parseConstDecl());
      } else {
        throw new ParseError(
          `Expected function or const in module, got ${this.peek().type} "${this.peek().value}"`,
          this.peek().line,
          this.peek().column,
        );
      }
    }
    this.expect("rbrace");
    return { kind: "module", name, members };
  }

  private parseConstDecl(): import("./ast.ts").ConstDecl {
    this.expect("keyword", "const");
    const name = this.expect("identifier").value;
    this.expect("colon");
    const type = this.parseType();
    this.expect("eq");
    const value = this.parseExpr();
    this.expect("semicolon");
    return { kind: "const", name, type, value };
  }

  private parseEnumDecl(): import("./ast.ts").EnumDecl {
    this.expect("keyword", "enum");
    const name = this.expect("identifier").value;
    let underlyingType = "int";
    if (this.check("colon")) {
      this.advance();
      underlyingType = this.parseType();
    }
    this.expect("lbrace");
    const members: import("./ast.ts").EnumMember[] = [];
    let nextValue = 0;
    if (!this.check("rbrace")) {
      const memName = this.expect("identifier").value;
      let value = nextValue;
      if (this.check("eq")) {
        this.advance();
        const valExpr = this.parseExpr();
        if (valExpr.kind !== "int") {
          throw new ParseError("Enum value must be integer literal", this.peek().line, this.peek().column);
        }
        value = valExpr.value;
        nextValue = value + 1;
      } else {
        nextValue++;
      }
      members.push({ name: memName, value });
      while (this.check("comma")) {
        this.advance();
        if (this.check("rbrace")) break;
        const mName = this.expect("identifier").value;
        let mVal = nextValue;
        if (this.check("eq")) {
          this.advance();
          const valExpr = this.parseExpr();
          if (valExpr.kind !== "int") {
            throw new ParseError("Enum value must be integer literal", this.peek().line, this.peek().column);
          }
          mVal = valExpr.value;
          nextValue = mVal + 1;
        } else {
          nextValue++;
        }
        members.push({ name: mName, value: mVal });
      }
    }
    this.expect("rbrace");
    return { kind: "enum", name, underlyingType, members };
  }

  private parseImportDecl(): ImportDecl {
    this.expect("keyword", "import");
    this.expect("lparen");
    const pathToken = this.expect("string");
    const path = pathToken.value;
    this.expect("comma");
    this.expect("lsquare");
    const modules: string[] = [];
    if (!this.check("rsquare")) {
      modules.push(this.expect("identifier").value);
      while (this.check("comma")) {
        this.advance();
        modules.push(this.expect("identifier").value);
      }
    }
    this.expect("rsquare");
    this.expect("rparen");
    this.expect("semicolon");
    return { kind: "import", path, modules };
  }

  private parseFunctionDecl(): FunctionDecl {
    this.expect("keyword", "function");
    const name = this.expect("identifier").value;
    this.expect("lparen");
    const params: import("./ast.ts").ParamDecl[] = [];
    if (!this.check("rparen")) {
      const pName = this.expect("identifier").value;
      this.expect("colon");
      const pType = this.parseType();
      params.push({ name: pName, type: pType });
      while (this.check("comma")) {
        this.advance();
        const nName = this.expect("identifier").value;
        this.expect("colon");
        const nType = this.parseType();
        params.push({ name: nName, type: nType });
      }
    }
    this.expect("rparen");
    this.expect("colon");
    const returnType = this.parseType();
    this.expect("lbrace");
    this.currentReturnType = returnType;
    const body = this.parseBlock();
    this.currentReturnType = null;
    this.expect("rbrace");

    return {
      kind: "function",
      name,
      params,
      returnType,
      body,
    };
  }

  private parseBlock(): Block {
    const statements: Stmt[] = [];
    while (!this.check("rbrace") && !this.check("eof")) {
      statements.push(this.parseStmt());
    }
    return { statements };
  }

  private parseStmt(): Stmt {
    if (this.check("asm_block")) {
      const t = this.advance();
      const lines = t.value
        .split("\n")
        .map((l) => {
          const idx = l.indexOf("//");
          return (idx >= 0 ? l.slice(0, idx) : l).trim();
        })
        .filter((l) => l.length > 0);
      return { kind: "asm", lines };
    }
    if (this.check("keyword", "return")) {
      this.advance();
      const t = this.peek();
      if (t.type === "semicolon") {
        const hint = this.currentReturnType
          ? ` (function returns ${this.currentReturnType}; add a value after return)`
          : "";
        throw new ParseError(
          `Expected identifier or \`${this.currentReturnType ?? "int"}\` value${hint}`,
          t.line,
          t.column,
        );
      }
      const value = this.parseExpr();
      this.expect("semicolon");
      return { kind: "return", value };
    }
    if (this.check("keyword", "const")) {
      this.advance();
      const name = this.expect("identifier").value;
      this.expect("colon");
      const type = this.parseType();
      this.expect("eq");
      const value = this.parseExpr();
      this.expect("semicolon");
      return { kind: "const", name, type, value };
    }
    if (this.check("keyword", "let")) {
      this.advance();
      const name = this.expect("identifier").value;
      this.expect("colon");
      const type = this.parseType();
      let value: import("./ast.ts").Expr | undefined;
      if (this.check("eq")) {
        this.advance();
        value = this.parseExpr();
      }
      this.expect("semicolon");
      return { kind: "let", name, type, value };
    }
    if (this.check("keyword", "if")) {
      return this.parseIfStmt();
    }
    if (this.check("keyword", "for")) {
      return this.parseForStmt();
    }
    if (this.check("keyword", "while")) {
      return this.parseWhileStmt();
    }
    const expr = this.parseExpr();
    this.expect("semicolon");
    return { kind: "expr", expr };
  }

  private parseIfStmt(): import("./ast.ts").IfStmt {
    this.expect("keyword", "if");
    this.expect("lparen");
    const condition = this.parseExpr();
    this.expect("rparen");
    this.expect("lbrace");
    const thenBody = this.parseBlock();
    this.expect("rbrace");
    let elseBody: import("./ast.ts").Block | null = null;
    if (this.check("keyword", "else")) {
      this.advance();
      this.expect("lbrace");
      elseBody = this.parseBlock();
      this.expect("rbrace");
    }
    return { kind: "if", condition, thenBody, elseBody };
  }

  private parseForStmt(): import("./ast.ts").ForStmt {
    this.expect("keyword", "for");
    this.expect("lparen");
    let init: import("./ast.ts").Stmt | null = null;
    if (this.check("semicolon")) {
      this.advance();
    } else if (this.check("keyword", "let")) {
      init = this.parseLetDeclInFor();
    } else {
      const expr = this.parseExpr();
      this.expect("semicolon");
      init = { kind: "expr", expr };
    }
    let condition: import("./ast.ts").Expr | null = null;
    if (!this.check("semicolon")) {
      condition = this.parseExpr();
    }
    this.expect("semicolon");
    let update: import("./ast.ts").Expr | null = null;
    if (!this.check("rparen")) {
      update = this.parseExpr();
    }
    this.expect("rparen");
    this.expect("lbrace");
    const body = this.parseBlock();
    this.expect("rbrace");
    return { kind: "for", init, condition, update, body };
  }

  private parseLetDeclInFor(): import("./ast.ts").LetDecl {
    this.expect("keyword", "let");
    const name = this.expect("identifier").value;
    this.expect("colon");
    const type = this.parseType();
    let value: import("./ast.ts").Expr | undefined;
    if (this.check("eq")) {
      this.advance();
      value = this.parseExpr();
    }
    this.expect("semicolon");
    return { kind: "let", name, type, value };
  }

  private parseWhileStmt(): import("./ast.ts").WhileStmt {
    this.expect("keyword", "while");
    this.expect("lparen");
    const condition = this.parseExpr();
    this.expect("rparen");
    this.expect("lbrace");
    const body = this.parseBlock();
    this.expect("rbrace");
    return { kind: "while", condition, body };
  }

  /** Public entry for parsing a single expression (e.g. from template interpolation). */
  parseExpression(): Expr {
    return this.parseAssignExpr();
  }

  private parseExpr(): Expr {
    return this.parseAssignExpr();
  }

  /** assignExpr = logicalOrExpr ( ("=" | "+=" | "-=" | "*=" | "/=") assignExpr )? */
  private parseAssignExpr(): Expr {
    const left = this.parseLogicalOrExpr();
    if (
      this.check("eq") ||
      this.check("pluseq") ||
      this.check("minuseq") ||
      this.check("stareq") ||
      this.check("slasheq")
    ) {
      const op = this.advance().value as "=" | "+=" | "-=" | "*=" | "/=";
      if (left.kind !== "identifier" && left.kind !== "index" && left.kind !== "member") {
        throw new ParseError(
          `Assignment target must be variable, field, or array index, got ${left.kind}`,
          this.peek().line,
          this.peek().column,
        );
      }
      const value = this.parseAssignExpr();
      return { kind: "assign", target: left, op, value };
    }
    return left;
  }

  /** logicalOrExpr = logicalAndExpr ( "||" logicalAndExpr )* */
  private parseLogicalOrExpr(): Expr {
    let expr = this.parseLogicalAndExpr();
    while (this.check("or")) {
      this.advance();
      expr = { kind: "binary", left: expr, op: "||", right: this.parseLogicalAndExpr() };
    }
    return expr;
  }

  /** logicalAndExpr = equalityExpr ( "&&" equalityExpr )* */
  private parseLogicalAndExpr(): Expr {
    let expr = this.parseEqualityExpr();
    while (this.check("and")) {
      this.advance();
      expr = { kind: "binary", left: expr, op: "&&", right: this.parseEqualityExpr() };
    }
    return expr;
  }

  /** equalityExpr = comparisonExpr ( ("==" | "!=") comparisonExpr )* */
  private parseEqualityExpr(): Expr {
    let expr = this.parseComparisonExpr();
    while (this.check("eqeq") || this.check("neq")) {
      const op = this.advance().value as "==" | "!=";
      expr = { kind: "binary", left: expr, op, right: this.parseComparisonExpr() };
    }
    return expr;
  }

  /** comparisonExpr = addExpr ( ("<" | ">" | "<=" | ">=") addExpr )* */
  private parseComparisonExpr(): Expr {
    let expr = this.parseAddExpr();
    while (this.check("lt") || this.check("gt") || this.check("le") || this.check("ge")) {
      const op = this.advance().value as "<" | ">" | "<=" | ">=";
      expr = { kind: "binary", left: expr, op, right: this.parseAddExpr() };
    }
    return expr;
  }

  /** addExpr = mulExpr ( ("+" | "-") mulExpr )* */
  private parseAddExpr(): Expr {
    let expr = this.parseMulExpr();
    while (this.check("plus") || this.check("minus")) {
      const op = this.advance().value as "+" | "-";
      expr = { kind: "binary", left: expr, op, right: this.parseMulExpr() };
    }
    return expr;
  }

  /** mulExpr = unaryExpr ( ("*" | "/") unaryExpr )* */
  private parseMulExpr(): Expr {
    let expr = this.parseUnaryExpr();
    while (this.check("star") || this.check("slash")) {
      const op = this.advance().value as "*" | "/";
      expr = { kind: "binary", left: expr, op, right: this.parseUnaryExpr() };
    }
    return expr;
  }

  /** unaryExpr = "sizeof" "(" typeOrVar ")" | "!" | "++" | "--" | "@" | "*" unaryExpr | postfixExpr */
  private parseUnaryExpr(): Expr {
    if (this.check("keyword", "sizeof")) {
      this.advance();
      this.expect("lparen");
      const typeOrVar = this.parseType();
      this.expect("rparen");
      return { kind: "sizeof", typeOrVar };
    }
    if (this.check("bang")) {
      this.advance();
      return { kind: "unary", op: "!", operand: this.parseUnaryExpr() };
    }
    if (this.check("plusplus")) {
      this.advance();
      return { kind: "preIncDec", op: "++", operand: this.parseUnaryExpr() };
    }
    if (this.check("minusminus")) {
      this.advance();
      return { kind: "preIncDec", op: "--", operand: this.parseUnaryExpr() };
    }
    if (this.check("at")) {
      this.advance();
      return { kind: "addressOf", operand: this.parseUnaryExpr() };
    }
    if (this.check("star")) {
      this.advance();
      return { kind: "deref", operand: this.parseUnaryExpr() };
    }
    return this.parsePostfixExpr();
  }

  /** postfixExpr = callExpr ( "++" | "--" )* */
  private parsePostfixExpr(): Expr {
    let expr = this.parseCallExpr();
    while (this.check("plusplus") || this.check("minusminus")) {
      const op = this.advance().value as "++" | "--";
      expr = { kind: "postIncDec", operand: expr, op };
    }
    return expr;
  }

  /** callExpr = memberExpr ( "(" args ")" | "[" expr "]" )* */
  private parseCallExpr(): Expr {
    let expr = this.parseMemberExpr();
    while (this.check("lparen") || this.check("lsquare")) {
      if (this.check("lparen")) {
        this.advance();
        const args: Expr[] = [];
        if (!this.check("rparen")) {
          args.push(this.parseExpr());
          while (this.check("comma")) {
            this.advance();
            args.push(this.parseExpr());
          }
        }
        this.expect("rparen");
        expr = { kind: "call", callee: expr, args };
      } else {
        this.advance();
        const index = this.parseExpr();
        this.expect("rsquare");
        expr = { kind: "index", object: expr, index };
      }
    }
    return expr;
  }

  /** memberExpr = primary ( "." identifier )* */
  private parseMemberExpr(): Expr {
    let expr = this.parsePrimary();
    while (this.check("dot")) {
      this.advance(); // consume .
      const prop = this.expect("identifier").value;
      expr = { kind: "member", object: expr, property: prop };
    }
    return expr;
  }

  private parseTemplateContent(content: string, line: number, col: number): TemplateSegment[] {
    const segments: TemplateSegment[] = [];
    let remaining = content;
    while (remaining.length > 0) {
      const i = remaining.indexOf("${");
      if (i < 0) {
        if (remaining.length > 0) segments.push({ kind: "string", value: remaining });
        break;
      }
      if (i > 0) {
        segments.push({ kind: "string", value: remaining.slice(0, i) });
      }
      let depth = 0;
      let j = i + 2;
      for (; j < remaining.length; j++) {
        const ch = remaining[j];
        if (ch === "{") depth++;
        else if (ch === "}") {
          if (depth === 0) break;
          depth--;
        }
      }
      if (j >= remaining.length) {
        throw new ParseError("Unclosed ${ in template literal", line, col);
      }
      const exprStr = remaining.slice(i + 2, j).trim();
      if (exprStr.length === 0) {
        throw new ParseError("Empty ${} in template literal", line, col);
      }
      const subLexer = new Lexer(exprStr);
      const subTokens = subLexer.tokenize();
      const subParser = new Parser(subTokens);
      const expr = subParser.parseExpression();
      segments.push({ kind: "interpolate", expr });
      remaining = remaining.slice(j + 1);
    }
    return segments;
  }

  /** primary = identifier | int | string | template | "(" expr ")" | [ expr ( "," expr )* ] | { key: expr, ... } */
  private parsePrimary(): Expr {
    const t = this.peek();
    if (t.type === "lparen") {
      this.advance();
      const expr = this.parseExpr();
      this.expect("rparen");
      return expr;
    }
    if (t.type === "lbrace") {
      this.advance();
      const fields: Array<{ key: string; value: Expr }> = [];
      if (!this.check("rbrace")) {
        const key = this.expect("identifier").value;
        this.expect("colon");
        const value = this.parseExpr();
        fields.push({ key, value });
        while (this.check("comma")) {
          this.advance();
          const k = this.expect("identifier").value;
          this.expect("colon");
          fields.push({ key: k, value: this.parseExpr() });
        }
      }
      this.expect("rbrace");
      return { kind: "object", fields };
    }
    if (t.type === "lsquare") {
      this.advance();
      const elements: Expr[] = [];
      if (!this.check("rsquare")) {
        elements.push(this.parseExpr());
        while (this.check("comma")) {
          this.advance();
          elements.push(this.parseExpr());
        }
      }
      this.expect("rsquare");
      return { kind: "array", elements };
    }
    if (t.type === "identifier") {
      this.advance();
      return { kind: "identifier", name: t.value };
    }
    if (t.type === "boolean") {
      this.advance();
      return { kind: "bool", value: t.value === "true" };
    }
    if (t.type === "null") {
      this.advance();
      return { kind: "null" };
    }
    if (t.type === "int") {
      this.advance();
      return { kind: "int", value: parseInt(t.value, 10) };
    }
    if (t.type === "float") {
      this.advance();
      return { kind: "float", value: parseFloat(t.value) };
    }
    if (t.type === "string") {
      this.advance();
      return { kind: "string", value: t.value };
    }
    if (t.type === "template") {
      this.advance();
      const segments = this.parseTemplateContent(t.value, t.line, t.column);
      return { kind: "template", segments };
    }
    throw new ParseError(
      `Expected identifier, number, or string, got ${t.type} "${t.value}"`,
      t.line,
      t.column,
    );
  }
}
