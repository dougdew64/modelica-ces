import { assert, assertEquals, assertThrows } from "@std/assert";
import { Lexer } from "../../../src/phase1/lexer.ts";
import { TokenKind } from "../../../src/phase1/data-structures.ts";
import type { Token } from "../../../src/phase1/data-structures.ts";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Lex an entire source string, collecting tokens until EOF (inclusive).
 */
function lex(source: string, file = "test.mo"): Token[] {
  const lexer = new Lexer(source, file);
  const tokens: Token[] = [];
  let tok: Token;
  do {
    tok = lexer.nextToken();
    tokens.push(tok);
  } while (tok.kind !== TokenKind.EOF);
  return tokens;
}

/**
 * Return the first token produced from source (may be EOF for empty input).
 */
function lexOne(source: string, file = "test.mo"): Token {
  return lex(source, file)[0];
}

/**
 * Return the TokenKind of every non-EOF token in source.
 */
function lexKinds(source: string): TokenKind[] {
  return lex(source).slice(0, -1).map((t) => t.kind);
}

// =============================================================================
// 1. Basic structure
// =============================================================================

Deno.test("U-LEX-1: Lexer is exported and constructible", () => {
  const lexer = new Lexer("", "test.mo");
  assert(lexer !== null && lexer !== undefined);
});

Deno.test("U-LEX-2: Lexer instance has a nextToken method", () => {
  const lexer = new Lexer("", "test.mo");
  assertEquals(typeof lexer.nextToken, "function");
});

Deno.test("U-LEX-3: Empty source returns EOF on the first call", () => {
  const lexer = new Lexer("", "test.mo");
  assertEquals(lexer.nextToken().kind, TokenKind.EOF);
});

// =============================================================================
// 2. EOF behavior
// =============================================================================

Deno.test("U-LEX-4: Whitespace-only source returns EOF", () => {
  assertEquals(lexOne("   \t\n  ").kind, TokenKind.EOF);
});

Deno.test("U-LEX-5: Calling nextToken() after EOF returns EOF again", () => {
  const lexer = new Lexer("", "test.mo");
  const first = lexer.nextToken();
  const second = lexer.nextToken();
  assertEquals(first.kind, TokenKind.EOF);
  assertEquals(second.kind, TokenKind.EOF);
});

// =============================================================================
// 3. Whitespace skipping
// =============================================================================

Deno.test("U-LEX-6: Spaces, tabs, CR, and newlines between tokens are skipped", () => {
  assertEquals(lexKinds("  model  "), [TokenKind.Model]);
});

Deno.test("U-LEX-7: Mixed whitespace between multiple tokens is discarded", () => {
  assertEquals(lexKinds("x\t+\r\ny"), [
    TokenKind.Identifier,
    TokenKind.Plus,
    TokenKind.Identifier,
  ]);
});

// =============================================================================
// 4. Line comments
// =============================================================================

Deno.test("U-LEX-8: A // line comment up to end-of-line is skipped", () => {
  assertEquals(lexKinds("// full line comment\n"), []);
});

Deno.test("U-LEX-9: A token on the line after a line comment is returned", () => {
  assertEquals(lexKinds("// comment\nmodel"), [TokenKind.Model]);
});

// =============================================================================
// 5. Block comments
// =============================================================================

Deno.test("U-LEX-10: A /* ... */ block comment is skipped", () => {
  assertEquals(lexKinds("/* block comment */"), []);
});

Deno.test("U-LEX-11: Tokens before and after a block comment are returned", () => {
  assertEquals(lexKinds("x /* skip this */ y"), [
    TokenKind.Identifier,
    TokenKind.Identifier,
  ]);
});

Deno.test("U-LEX-12: Nested block comments are handled correctly", () => {
  assertEquals(lexKinds("x /* outer /* inner */ outer */ y"), [
    TokenKind.Identifier,
    TokenKind.Identifier,
  ]);
});

Deno.test("U-LEX-13: An unterminated block comment throws", () => {
  assertThrows(() => lex("/* no close"), Error);
});

// =============================================================================
// 6. Single-character punctuation and operators
// =============================================================================

Deno.test("U-LEX-14: All bracket and delimiter tokens are recognized", () => {
  assertEquals(lexKinds("( ) [ ] { } ; ,"), [
    TokenKind.LParen,
    TokenKind.RParen,
    TokenKind.LBracket,
    TokenKind.RBracket,
    TokenKind.LBrace,
    TokenKind.RBrace,
    TokenKind.Semicolon,
    TokenKind.Comma,
  ]);
});

Deno.test("U-LEX-15: Single-character arithmetic operators are recognized", () => {
  assertEquals(lexKinds("+ - * / ^"), [
    TokenKind.Plus,
    TokenKind.Minus,
    TokenKind.Star,
    TokenKind.Slash,
    TokenKind.Power,
  ]);
});

// =============================================================================
// 7. Two-character operators
// =============================================================================

Deno.test("U-LEX-16: == produces EqualEqual; standalone = produces Equals", () => {
  assertEquals(lexOne("==").kind, TokenKind.EqualEqual);
  assertEquals(lexOne("=").kind, TokenKind.Equals);
});

Deno.test("U-LEX-17: := produces Assign; standalone : produces Colon", () => {
  assertEquals(lexOne(":=").kind, TokenKind.Assign);
  assertEquals(lexOne(":").kind, TokenKind.Colon);
});

Deno.test("U-LEX-18: <= produces LessEqual; standalone < produces LessThan", () => {
  assertEquals(lexOne("<=").kind, TokenKind.LessEqual);
  assertEquals(lexOne("<").kind, TokenKind.LessThan);
});

Deno.test("U-LEX-19: <> produces NotEqual", () => {
  assertEquals(lexOne("<>").kind, TokenKind.NotEqual);
});

Deno.test("U-LEX-20: >= produces GreaterEqual; standalone > produces GreaterThan", () => {
  assertEquals(lexOne(">=").kind, TokenKind.GreaterEqual);
  assertEquals(lexOne(">").kind, TokenKind.GreaterThan);
});

// =============================================================================
// 8. Dot and elementwise operators
// =============================================================================

Deno.test("U-LEX-21: Standalone . produces Dot", () => {
  assertEquals(lexOne(".").kind, TokenKind.Dot);
});

Deno.test("U-LEX-22: .+ produces DotPlus", () => {
  assertEquals(lexOne(".+").kind, TokenKind.DotPlus);
});

Deno.test("U-LEX-23: .- produces DotMinus", () => {
  assertEquals(lexOne(".-").kind, TokenKind.DotMinus);
});

Deno.test("U-LEX-24: .* produces DotStar", () => {
  assertEquals(lexOne(".*").kind, TokenKind.DotStar);
});

Deno.test("U-LEX-25: ./ produces DotSlash", () => {
  assertEquals(lexOne("./").kind, TokenKind.DotSlash);
});

Deno.test("U-LEX-26: .^ produces DotPower", () => {
  assertEquals(lexOne(".^").kind, TokenKind.DotPower);
});

// =============================================================================
// 9. Integer literals
// =============================================================================

Deno.test("U-LEX-27: Single-digit integer", () => {
  const tok = lexOne("0");
  assertEquals(tok.kind, TokenKind.IntegerLiteral);
  assertEquals(tok.value, 0);
});

Deno.test("U-LEX-28: Multi-digit integer", () => {
  const tok = lexOne("42");
  assertEquals(tok.kind, TokenKind.IntegerLiteral);
  assertEquals(tok.value, 42);
});

Deno.test("U-LEX-29: Large integer", () => {
  const tok = lexOne("12345");
  assertEquals(tok.kind, TokenKind.IntegerLiteral);
  assertEquals(tok.value, 12345);
});

// =============================================================================
// 10. Real literals
// =============================================================================

Deno.test("U-LEX-30: Decimal real", () => {
  const tok = lexOne("3.14");
  assertEquals(tok.kind, TokenKind.RealLiteral);
  assertEquals(tok.value, 3.14);
});

Deno.test("U-LEX-31: Trailing-dot real", () => {
  const tok = lexOne("1.");
  assertEquals(tok.kind, TokenKind.RealLiteral);
  assertEquals(tok.value, 1.0);
});

Deno.test("U-LEX-32: Exponent with negative sign", () => {
  const tok = lexOne("1.5e-3");
  assertEquals(tok.kind, TokenKind.RealLiteral);
  assertEquals(tok.value, 1.5e-3);
});

Deno.test("U-LEX-33: Uppercase exponent with positive sign", () => {
  const tok = lexOne("2E+4");
  assertEquals(tok.kind, TokenKind.RealLiteral);
  assertEquals(tok.value, 2e4);
});

Deno.test("U-LEX-34: Exponent with no decimal part", () => {
  const tok = lexOne("1e10");
  assertEquals(tok.kind, TokenKind.RealLiteral);
  assertEquals(tok.value, 1e10);
});

Deno.test("U-LEX-35: Exponent with no following digit throws", () => {
  assertThrows(() => lex("1e"), Error);
});

// =============================================================================
// 11. Number/dot disambiguation
// =============================================================================

Deno.test("U-LEX-36: 1.+x scans as IntegerLiteral, DotPlus, Identifier", () => {
  const toks = lex("1.+x");
  assertEquals(toks[0].kind, TokenKind.IntegerLiteral);
  assertEquals(toks[0].value, 1);
  assertEquals(toks[1].kind, TokenKind.DotPlus);
  assertEquals(toks[2].kind, TokenKind.Identifier);
  assertEquals(toks[2].value, "x");
});

Deno.test("U-LEX-37: 1.*x scans as IntegerLiteral, DotStar, Identifier", () => {
  const toks = lex("1.*x");
  assertEquals(toks[0].kind, TokenKind.IntegerLiteral);
  assertEquals(toks[0].value, 1);
  assertEquals(toks[1].kind, TokenKind.DotStar);
  assertEquals(toks[2].kind, TokenKind.Identifier);
  assertEquals(toks[2].value, "x");
});

// =============================================================================
// 12. Identifiers
// =============================================================================

Deno.test("U-LEX-38: Simple single-letter identifier", () => {
  const tok = lexOne("x");
  assertEquals(tok.kind, TokenKind.Identifier);
  assertEquals(tok.value, "x");
});

Deno.test("U-LEX-39: Mixed-case identifier with digit suffix", () => {
  const tok = lexOne("myVar2");
  assertEquals(tok.kind, TokenKind.Identifier);
  assertEquals(tok.value, "myVar2");
});

Deno.test("U-LEX-40: Underscore-prefixed identifier", () => {
  const tok = lexOne("_internal");
  assertEquals(tok.kind, TokenKind.Identifier);
  assertEquals(tok.value, "_internal");
});

Deno.test("U-LEX-41: Built-in type names are not keywords", () => {
  assertEquals(lexOne("Real").kind, TokenKind.Identifier);
  assertEquals(lexOne("Integer").kind, TokenKind.Identifier);
  assertEquals(lexOne("Boolean").kind, TokenKind.Identifier);
  assertEquals(lexOne("String").kind, TokenKind.Identifier);
});

// =============================================================================
// 13. Keywords
// =============================================================================

Deno.test("U-LEX-42: model keyword", () => {
  assertEquals(lexOne("model").kind, TokenKind.Model);
});

Deno.test("U-LEX-43: equation keyword", () => {
  assertEquals(lexOne("equation").kind, TokenKind.Equation);
});

Deno.test("U-LEX-44: der keyword", () => {
  assertEquals(lexOne("der").kind, TokenKind.Der);
});

Deno.test("U-LEX-45: Spot-check five additional keywords", () => {
  assertEquals(lexKinds("algorithm function package parameter end"), [
    TokenKind.Algorithm,
    TokenKind.Function,
    TokenKind.Package,
    TokenKind.Parameter,
    TokenKind.End,
  ]);
});

// =============================================================================
// 14. Boolean literals
// =============================================================================

Deno.test("U-LEX-46: true produces BooleanLiteral with value true", () => {
  const tok = lexOne("true");
  assertEquals(tok.kind, TokenKind.BooleanLiteral);
  assertEquals(tok.value, true);
  assertEquals(typeof tok.value, "boolean");
});

Deno.test("U-LEX-47: false produces BooleanLiteral with value false", () => {
  const tok = lexOne("false");
  assertEquals(tok.kind, TokenKind.BooleanLiteral);
  assertEquals(tok.value, false);
  assertEquals(typeof tok.value, "boolean");
});

// =============================================================================
// 15. String literals
// =============================================================================

Deno.test('U-LEX-48: Simple string "hello"', () => {
  const tok = lexOne('"hello"');
  assertEquals(tok.kind, TokenKind.StringLiteral);
  assertEquals(tok.value, "hello");
});

Deno.test("U-LEX-49: Empty string", () => {
  const tok = lexOne('""');
  assertEquals(tok.kind, TokenKind.StringLiteral);
  assertEquals(tok.value, "");
});

Deno.test("U-LEX-50: \\n escape is decoded to a newline character", () => {
  const tok = lexOne('"\\n"');
  assertEquals(tok.kind, TokenKind.StringLiteral);
  assertEquals(tok.value, "\n");
});

Deno.test("U-LEX-51: \\t escape is decoded to a tab character", () => {
  const tok = lexOne('"\\t"');
  assertEquals(tok.kind, TokenKind.StringLiteral);
  assertEquals(tok.value, "\t");
});

Deno.test("U-LEX-52: \\\\ escape is decoded to a single backslash", () => {
  // Source seen by lexer: " \ \ "  →  value is one backslash character
  const tok = lexOne('"\\\\"');
  assertEquals(tok.kind, TokenKind.StringLiteral);
  assertEquals(tok.value, "\\");
});

Deno.test('U-LEX-53: \\" escape is decoded to a double-quote character', () => {
  const tok = lexOne('"\\""');
  assertEquals(tok.kind, TokenKind.StringLiteral);
  assertEquals(tok.value, '"');
});

Deno.test("U-LEX-54: Unterminated string literal throws", () => {
  assertThrows(() => lex('"hello'), Error);
});

// =============================================================================
// 16. Quoted identifiers
// =============================================================================

Deno.test("U-LEX-55: Quoted identifier with spaces", () => {
  const tok = lexOne("'hello world'");
  assertEquals(tok.kind, TokenKind.Identifier);
  assertEquals(tok.value, "hello world");
});

Deno.test("U-LEX-56: Quoted identifier with dots", () => {
  const tok = lexOne("'my.variable'");
  assertEquals(tok.kind, TokenKind.Identifier);
  assertEquals(tok.value, "my.variable");
});

Deno.test("U-LEX-57: Escaped single-quote inside quoted identifier", () => {
  // Source: 'can\'t stop'  (the \' is an escaped quote taken literally)
  const tok = lexOne("'can\\'t stop'");
  assertEquals(tok.kind, TokenKind.Identifier);
  assertEquals(tok.value, "can't stop");
});

Deno.test("U-LEX-58: Unterminated quoted identifier throws", () => {
  assertThrows(() => lex("'hello"), Error);
});

// =============================================================================
// 17. Source locations
// =============================================================================

Deno.test("U-LEX-59: First token starts at offset 0", () => {
  const tok = lexOne("model");
  assertEquals(tok.span.start.offset, 0);
});

Deno.test("U-LEX-60: Token offsets bracket the token text exactly", () => {
  const tok = lexOne("model");
  assertEquals(tok.span.start.offset, 0);
  assertEquals(tok.span.end.offset, 5); // "model" is 5 characters
});

Deno.test("U-LEX-61: Token on second line has line 2, column 1", () => {
  const tokens = lex("x\ny");
  const yTok = tokens[1]; // "y" is the second token
  assertEquals(yTok.span.start.line, 2);
  assertEquals(yTok.span.start.column, 1);
});

Deno.test("U-LEX-62: file field matches the constructor argument", () => {
  const lexer = new Lexer("x", "my_file.mo");
  const tok = lexer.nextToken();
  assertEquals(tok.span.start.file, "my_file.mo");
  assertEquals(tok.span.end.file, "my_file.mo");
});

// =============================================================================
// 18. Error reporting
// =============================================================================

Deno.test("U-LEX-63: An unexpected character throws an error", () => {
  assertThrows(() => lex("@"), Error);
});

Deno.test("U-LEX-64: Error message includes file:line:col: prefix", () => {
  assertThrows(
    () => new Lexer("@", "test.mo").nextToken(),
    Error,
    "test.mo:1:1:",
  );
});
