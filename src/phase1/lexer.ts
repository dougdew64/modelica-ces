import { KEYWORDS, TokenKind } from "./data-structures.ts";
import type { SourceLocation, Token } from "./data-structures.ts";

// =============================================================================
// Character helpers
// =============================================================================

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string): boolean {
  if (ch >= "a" && ch <= "z") return true;
  if (ch >= "A" && ch <= "Z") return true;
  if (ch === "_") return true;
  const cp = ch.codePointAt(0)!;
  return cp > 127 && /\p{L}/u.test(ch);
}

function isIdentPart(ch: string): boolean {
  if (isIdentStart(ch)) return true;
  if (isDigit(ch)) return true;
  const cp = ch.codePointAt(0)!;
  return cp > 127 && /[\p{L}\p{N}\p{M}]/u.test(ch);
}

function isElementwiseOp(ch: string): boolean {
  return ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "^";
}

// =============================================================================
// Lexer
// =============================================================================

export class Lexer {
  private source: string;
  private file: string;
  private pos: number;
  private tokenStart: number;

  constructor(source: string, file: string) {
    this.source = source;
    this.file = file;
    this.pos = 0;
    this.tokenStart = 0;
  }

  nextToken(): Token {
    this.skipWhitespaceAndComments();

    if (this.isAtEnd()) {
      this.tokenStart = this.pos;
      return this.makeToken(TokenKind.EOF);
    }

    this.tokenStart = this.pos;
    const ch = this.advance();

    switch (ch) {
      case "(": return this.makeToken(TokenKind.LParen);
      case ")": return this.makeToken(TokenKind.RParen);
      case "[": return this.makeToken(TokenKind.LBracket);
      case "]": return this.makeToken(TokenKind.RBracket);
      case "{": return this.makeToken(TokenKind.LBrace);
      case "}": return this.makeToken(TokenKind.RBrace);
      case ";": return this.makeToken(TokenKind.Semicolon);
      case ",": return this.makeToken(TokenKind.Comma);
      case "+": return this.makeToken(TokenKind.Plus);
      case "-": return this.makeToken(TokenKind.Minus);
      case "*": return this.makeToken(TokenKind.Star);
      case "/": return this.makeToken(TokenKind.Slash);
      case "^": return this.makeToken(TokenKind.Power);
      case "=":
        return this.match("=")
          ? this.makeToken(TokenKind.EqualEqual)
          : this.makeToken(TokenKind.Equals);
      case ":":
        return this.match("=")
          ? this.makeToken(TokenKind.Assign)
          : this.makeToken(TokenKind.Colon);
      case "<":
        if (this.match("=")) return this.makeToken(TokenKind.LessEqual);
        if (this.match(">")) return this.makeToken(TokenKind.NotEqual);
        return this.makeToken(TokenKind.LessThan);
      case ">":
        return this.match("=")
          ? this.makeToken(TokenKind.GreaterEqual)
          : this.makeToken(TokenKind.GreaterThan);
      case ".":
        return this.scanDotOrElementwise();
      case '"':
        return this.scanString();
      case "'":
        return this.scanQuotedIdentifier();
      default:
        if (isDigit(ch)) return this.scanNumber();
        if (isIdentStart(ch)) return this.scanIdentifierOrKeyword();
        throw this.error(`Unexpected character: '${ch}'`, this.tokenStart);
    }
  }

  // ---------------------------------------------------------------------------
  // Whitespace and comment skipping
  // ---------------------------------------------------------------------------

  private skipWhitespaceAndComments(): void {
    while (!this.isAtEnd()) {
      const ch = this.peek();

      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        this.advance();
        continue;
      }

      if (ch === "/" && this.peekNext() === "/") {
        while (!this.isAtEnd() && this.peek() !== "\n") {
          this.advance();
        }
        continue;
      }

      if (ch === "/" && this.peekNext() === "*") {
        this.advance(); // consume /
        this.advance(); // consume *
        this.scanBlockComment();
        continue;
      }

      break;
    }
  }

  private scanBlockComment(): void {
    let depth = 1;
    while (!this.isAtEnd() && depth > 0) {
      if (this.peek() === "/" && this.peekNext() === "*") {
        this.advance();
        this.advance();
        depth++;
      } else if (this.peek() === "*" && this.peekNext() === "/") {
        this.advance();
        this.advance();
        depth--;
      } else {
        this.advance();
      }
    }
    if (depth > 0) {
      throw this.error("Unterminated block comment");
    }
  }

  // ---------------------------------------------------------------------------
  // Numeric literals
  // ---------------------------------------------------------------------------

  private scanNumber(): Token {
    // First digit already consumed

    while (isDigit(this.peek())) this.advance();

    let isReal = false;

    if (this.peek() === "." && !isElementwiseOp(this.peekNext())) {
      isReal = true;
      this.advance(); // consume the dot
      while (isDigit(this.peek())) this.advance();
    }

    if (this.peek() === "e" || this.peek() === "E") {
      isReal = true;
      this.advance(); // consume e/E
      if (this.peek() === "+" || this.peek() === "-") this.advance();
      if (!isDigit(this.peek())) {
        throw this.error("Expected digit after exponent");
      }
      while (isDigit(this.peek())) this.advance();
    }

    const text = this.source.slice(this.tokenStart, this.pos);
    if (isReal) {
      return this.makeToken(TokenKind.RealLiteral, parseFloat(text));
    } else {
      return this.makeToken(TokenKind.IntegerLiteral, parseInt(text, 10));
    }
  }

  // ---------------------------------------------------------------------------
  // Identifiers and keywords
  // ---------------------------------------------------------------------------

  private scanIdentifierOrKeyword(): Token {
    while (isIdentPart(this.peek())) this.advance();

    const text = this.source.slice(this.tokenStart, this.pos);
    const keywordKind = KEYWORDS.get(text);

    if (keywordKind === TokenKind.True) {
      return this.makeToken(TokenKind.BooleanLiteral, true);
    }
    if (keywordKind === TokenKind.False) {
      return this.makeToken(TokenKind.BooleanLiteral, false);
    }
    if (keywordKind !== undefined) {
      return this.makeToken(keywordKind);
    }
    return this.makeToken(TokenKind.Identifier, text);
  }

  // ---------------------------------------------------------------------------
  // String literals
  // ---------------------------------------------------------------------------

  private scanString(): Token {
    let value = "";

    while (!this.isAtEnd() && this.peek() !== '"') {
      if (this.peek() === "\\") {
        this.advance(); // consume backslash
        const esc = this.advance();
        switch (esc) {
          case "n":  value += "\n"; break;
          case "t":  value += "\t"; break;
          case "\\":  value += "\\"; break;
          case '"':  value += '"'; break;
          case "'":  value += "'";  break;
          case "?":  value += "?";  break;
          case "a":  value += "\x07"; break;
          case "b":  value += "\b"; break;
          case "f":  value += "\f"; break;
          case "r":  value += "\r"; break;
          case "v":  value += "\v"; break;
          default:
            throw this.error(`Invalid escape sequence: \\${esc}`);
        }
      } else {
        value += this.advance();
      }
    }

    if (this.isAtEnd()) {
      throw this.error("Unterminated string literal");
    }

    this.advance(); // consume closing "
    return this.makeToken(TokenKind.StringLiteral, value);
  }

  // ---------------------------------------------------------------------------
  // Quoted identifiers
  // ---------------------------------------------------------------------------

  private scanQuotedIdentifier(): Token {
    let name = "";

    while (!this.isAtEnd() && this.peek() !== "'") {
      if (this.peek() === "\\") {
        this.advance();
        name += this.advance(); // escaped character — take literally
      } else {
        name += this.advance();
      }
    }

    if (this.isAtEnd()) {
      throw this.error("Unterminated quoted identifier");
    }

    this.advance(); // consume closing '
    return this.makeToken(TokenKind.Identifier, name);
  }

  // ---------------------------------------------------------------------------
  // Dot and elementwise operators
  // ---------------------------------------------------------------------------

  private scanDotOrElementwise(): Token {
    switch (this.peek()) {
      case "+": this.advance(); return this.makeToken(TokenKind.DotPlus);
      case "-": this.advance(); return this.makeToken(TokenKind.DotMinus);
      case "*": this.advance(); return this.makeToken(TokenKind.DotStar);
      case "/": this.advance(); return this.makeToken(TokenKind.DotSlash);
      case "^": this.advance(); return this.makeToken(TokenKind.DotPower);
      default:  return this.makeToken(TokenKind.Dot);
    }
  }

  // ---------------------------------------------------------------------------
  // Token construction and source locations
  // ---------------------------------------------------------------------------

  private makeToken(kind: TokenKind, value?: string | number | boolean): Token {
    return {
      kind,
      span: {
        start: this.makeLocation(this.tokenStart),
        end: this.makeLocation(this.pos),
      },
      value,
    };
  }

  private makeLocation(offset: number): SourceLocation {
    let line = 1;
    let column = 1;
    for (let i = 0; i < offset; i++) {
      if (this.source[i] === "\n") {
        line++;
        column = 1;
      } else {
        column++;
      }
    }
    return { file: this.file, line, column, offset };
  }

  // ---------------------------------------------------------------------------
  // Error reporting
  // ---------------------------------------------------------------------------

  private error(message: string, at: number = this.pos): Error {
    const loc = this.makeLocation(at);
    return new Error(`${loc.file}:${loc.line}:${loc.column}: ${message}`);
  }

  // ---------------------------------------------------------------------------
  // Primitives
  // ---------------------------------------------------------------------------

  private peek(): string     { return this.source[this.pos] ?? "\0"; }
  private peekNext(): string { return this.source[this.pos + 1] ?? "\0"; }
  private advance(): string  { return this.source[this.pos++]; }
  private isAtEnd(): boolean { return this.pos >= this.source.length; }
  private match(ch: string): boolean {
    if (this.peek() === ch) { this.pos++; return true; }
    return false;
  }
}
