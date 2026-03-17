import type { Token, TokenType } from "./types.ts";
import { KEYWORDS, TYPES, BOOLEAN_LITERALS, NULL_LITERAL } from "./types.ts";

export class Lexer {
  private source: string;
  private pos = 0;
  private line = 1;
  private column = 1;

  constructor(source: string) {
    this.source = source;
  }

  private peek(offset = 0): string {
    return this.source[this.pos + offset] ?? "\0";
  }

  private advance(): string {
    if (this.pos >= this.source.length) return "\0";
    const ch = this.source[this.pos++];
    if (ch === "\n") {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return ch;
  }

  private isAtEnd(): boolean {
    return this.pos >= this.source.length;
  }

  private skipWhitespace(): void {
    while (!this.isAtEnd()) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        this.advance();
      } else if (ch === "/" && this.peek(1) === "/") {
        this.advance();
        this.advance();
        while (!this.isAtEnd() && this.peek() !== "\n") this.advance();
      } else if (ch === "/" && this.peek(1) === "*") {
        this.advance();
        this.advance();
        while (!this.isAtEnd() && !(this.peek() === "*" && this.peek(1) === "/")) {
          this.advance();
        }
        if (!this.isAtEnd()) {
          this.advance();
          this.advance();
        }
      } else {
        break;
      }
    }
  }

  private readTemplate(): string {
    const startLine = this.line;
    const startCol = this.column;
    this.advance(); // consume opening `
    let value = "";
    while (!this.isAtEnd() && this.peek() !== "`") {
      if (this.peek() === "\\") {
        this.advance();
        const escaped = this.advance();
        if (escaped === "`") value += "`";
        else if (escaped === "\\") value += "\\";
        else if (escaped === "$" && this.peek() === "{") {
          value += "${"; // literal ${
          this.advance(); // consume {
        } else if (escaped === "n") value += "\n";
        else if (escaped === "t") value += "\t";
        else if (escaped === "r") value += "\r";
        else {
          throw new Error(`Invalid escape sequence \\${escaped} at ${startLine}:${startCol}`);
        }
      } else {
        value += this.advance();
      }
    }
    if (this.isAtEnd()) {
      throw new Error(`Unterminated template literal at ${startLine}:${startCol}`);
    }
    this.advance(); // consume closing `
    return value;
  }

  private readString(): string {
    const startLine = this.line;
    const startCol = this.column;
    this.advance(); // consume opening "
    let value = "";
    while (!this.isAtEnd() && this.peek() !== '"') {
      if (this.peek() === "\\") {
        this.advance();
        const escaped = this.advance();
        if (escaped === "n") value += "\n";
        else if (escaped === "t") value += "\t";
        else if (escaped === "r") value += "\r";
        else if (escaped === '"') value += '"';
        else if (escaped === "\\") value += "\\";
        else {
          throw new Error(`Invalid escape sequence \\${escaped} at ${startLine}:${startCol}`);
        }
      } else {
        value += this.advance();
      }
    }
    if (this.isAtEnd()) {
      throw new Error(`Unterminated string at ${startLine}:${startCol}`);
    }
    this.advance(); // consume closing "
    return value;
  }

  private readNumber(): { value: string; isFloat: boolean } {
    let value = "";
    let hasDecimal = false;
    if (this.peek() === "." && this.peek(1) >= "0" && this.peek(1) <= "9") {
      value = "0.";
      this.advance();
      hasDecimal = true;
    }
    while (this.peek() >= "0" && this.peek() <= "9") {
      value += this.advance();
    }
    if (this.peek() === "." && this.peek(1) >= "0" && this.peek(1) <= "9") {
      value += this.advance();
      hasDecimal = true;
      while (this.peek() >= "0" && this.peek() <= "9") {
        value += this.advance();
      }
    }
    if (this.peek() === "." && (this.peek(1) === "e" || this.peek(1) === "E")) {
      value += this.advance();
      value += this.advance();
      hasDecimal = true;
    }
    if ((this.peek() === "e" || this.peek() === "E") && (this.peek(1) === "+" || this.peek(1) === "-" || (this.peek(1) >= "0" && this.peek(1) <= "9"))) {
      value += this.advance();
      if (this.peek() === "+" || this.peek() === "-") value += this.advance();
      while (this.peek() >= "0" && this.peek() <= "9") value += this.advance();
      hasDecimal = true;
    }
    return { value, isFloat: hasDecimal };
  }

  private readIdentifier(): string {
    let value = "";
    const start = this.peek();
    const isStart = (c: string) =>
      (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
    const isContinue = (c: string) => isStart(c) || (c >= "0" && c <= "9");

    if (!isStart(start)) return "";
    value += this.advance();
    while (isContinue(this.peek())) {
      value += this.advance();
    }
    return value;
  }

  private makeToken(type: TokenType, value: string): Token {
    return { type, value, line: this.line, column: this.column };
  }

  nextToken(): Token {
    this.skipWhitespace();

    const line = this.line;
    const column = this.column;

    if (this.isAtEnd()) {
      return this.makeToken("eof", "");
    }

    const ch = this.peek();

    // Template literals (backticks)
    if (ch === "`") {
      const value = this.readTemplate();
      return { type: "template", value, line, column };
    }

    // String literals
    if (ch === '"') {
      const value = this.readString();
      return { type: "string", value, line, column };
    }

    // Numbers (including .123)
    if ((ch >= "0" && ch <= "9") || (ch === "." && this.peek(1) >= "0" && this.peek(1) <= "9")) {
      const { value, isFloat } = this.readNumber();
      return { type: isFloat ? "float" : "int", value, line, column };
    }

    // Identifiers and keywords
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_") {
      const value = this.readIdentifier();
      if (value === "__asm") {
        this.skipWhitespace();
        if (this.peek() === "{") {
          this.advance();
          let content = "";
          let depth = 1;
          while (!this.isAtEnd() && depth > 0) {
            const c = this.advance();
            if (c === "{") depth++;
            else if (c === "}") {
              depth--;
              if (depth > 0) content += c;
            } else {
              content += c;
            }
          }
          if (depth !== 0) throw new Error(`Unterminated __asm block at ${line}:${column}`);
          return this.makeToken("asm_block", content);
        }
      }
      if (BOOLEAN_LITERALS.has(value)) return this.makeToken("boolean", value);
      if (value === NULL_LITERAL) return this.makeToken("null", value);
      if (KEYWORDS.has(value)) return this.makeToken("keyword", value);
      if (TYPES.has(value)) return this.makeToken("type", value);
      return this.makeToken("identifier", value);
    }

    // Two-character tokens (must be checked before single-char)
    const ch2 = this.peek(1);
    const twoChar: Record<string, { next: string; type: TokenType; value: string }> = {
      "=": { next: "=", type: "eqeq", value: "==" },
      "!": { next: "=", type: "neq", value: "!=" },
      "<": { next: "=", type: "le", value: "<=" },
      ">": { next: "=", type: "ge", value: ">=" },
      "&": { next: "&", type: "and", value: "&&" },
      "|": { next: "|", type: "or", value: "||" },
      "+": { next: "=", type: "pluseq", value: "+=" },
      "-": { next: "=", type: "minuseq", value: "-=" },
      "*": { next: "=", type: "stareq", value: "*=" },
      "/": { next: "=", type: "slasheq", value: "/=" },
    };
    const twoPlus = twoChar[ch];
    if (twoPlus && ch2 === twoPlus.next) {
      this.advance();
      this.advance();
      return this.makeToken(twoPlus.type, twoPlus.value);
    }
    if (ch === "+" && ch2 === "+") {
      this.advance();
      this.advance();
      return this.makeToken("plusplus", "++");
    }
    if (ch === "-" && ch2 === "-") {
      this.advance();
      this.advance();
      return this.makeToken("minusminus", "--");
    }

    // Single-character tokens
    this.advance();
    const single: Record<string, TokenType> = {
      "(": "lparen",
      ")": "rparen",
      "{": "lbrace",
      "}": "rbrace",
      ":": "colon",
      ";": "semicolon",
      ",": "comma",
      ".": "dot",
      "+": "plus",
      "-": "minus",
      "*": "star",
      "/": "slash",
      "=": "eq",
      "[": "lsquare",
      "]": "rsquare",
      "<": "lt",
      ">": "gt",
      "!": "bang",
      "@": "at",
    };
    if (single[ch]) {
      return this.makeToken(single[ch], ch);
    }

    throw new Error(`Unexpected character '${ch}' at ${line}:${column}`);
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    let t: Token;
    do {
      t = this.nextToken();
      tokens.push(t);
    } while (t.type !== "eof");
    return tokens;
  }
}
