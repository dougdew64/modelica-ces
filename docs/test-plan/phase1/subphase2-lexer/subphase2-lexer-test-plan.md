# Phase 1, Subphase 2: Lexer — Test Plan

## Overview

This document defines the tests for the Modelica lexer. The lexer converts a raw source string into a flat sequence of `Token` values, one per `nextToken()` call.

Tests are written before implementation (TDD). All tests in this document are failing until the corresponding implementation is in place.

Test source file: `tests/phase1/subphase2-lexer/lexer_test.ts`

Design reference: `docs/phase1/subphase2-lexer/phase1-subphase2-lexer.md`

---

## Testing Approach

The lexer is a class with runtime behavior. Every test exercises `Lexer` directly. A small set of helper functions in the test file (`lex`, `lexOne`, `lexKinds`) reduce boilerplate:

- `lex(source)` — calls `nextToken()` in a loop until `EOF` and returns all tokens including `EOF`
- `lexOne(source)` — returns the first token in `lex(source)`
- `lexKinds(source)` — returns the `TokenKind` of every non-EOF token as an array

Error-case tests use `assertThrows` to confirm that the lexer throws an `Error` with the expected message content.

---

## 1. Basic Structure

The `Lexer` class must be exported from `src/phase1/lexer.ts` and be constructible.

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-LEX-1 | `Lexer` is exported and constructible | `new Lexer("", "test.mo")` | Constructs without error; instance is non-null |
| U-LEX-2 | Instance has a `nextToken` method | `typeof lexer.nextToken` | `"function"` |
| U-LEX-3 | Empty source returns `EOF` on first call | `new Lexer("", "test.mo").nextToken()` | `kind === TokenKind.EOF` |

---

## 2. EOF Behavior

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-LEX-4 | Whitespace-only source returns `EOF` | `"   \t\n  "` | First token has `kind === TokenKind.EOF` |
| U-LEX-5 | Calling `nextToken()` after `EOF` returns `EOF` again | `new Lexer("", …).nextToken()` twice | Both calls return `kind === TokenKind.EOF` |

---

## 3. Whitespace Skipping

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-LEX-6 | Spaces, tabs, CR, and newlines between tokens are skipped | `"  model  "` | Only one token: `Model` |
| U-LEX-7 | Mixed whitespace between multiple tokens is discarded | `"x\t+\r\ny"` | Kinds: `Identifier`, `Plus`, `Identifier` |

---

## 4. Line Comments

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-LEX-8 | A `//` line comment up to end-of-line is skipped | `"// full line comment\n"` | No non-EOF tokens |
| U-LEX-9 | A token on the line after a line comment is returned | `"// comment\nmodel"` | Kinds: `Model` |

---

## 5. Block Comments

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-LEX-10 | A `/* ... */` block comment is skipped | `"/* block comment */"` | No non-EOF tokens |
| U-LEX-11 | Tokens before and after a block comment are returned | `"x /* skip this */ y"` | Kinds: `Identifier`, `Identifier` |
| U-LEX-12 | Nested block comments `/* /* */ */` are handled correctly | `"x /* outer /* inner */ outer */ y"` | Kinds: `Identifier`, `Identifier` |
| U-LEX-13 | An unterminated block comment throws | `"/* no close"` | `Error` thrown |

---

## 6. Single-Character Punctuation and Operators

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-LEX-14 | All bracket/delimiter tokens are recognized | `"( ) [ ] { } ; ,"` | Kinds: `LParen`, `RParen`, `LBracket`, `RBracket`, `LBrace`, `RBrace`, `Semicolon`, `Comma` |
| U-LEX-15 | Single-character arithmetic operators are recognized | `"+ - * / ^"` | Kinds: `Plus`, `Minus`, `Star`, `Slash`, `Power` |

---

## 7. Two-Character Operators

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-LEX-16 | `==` produces `EqualEqual`; `=` alone produces `Equals` | `"=="`, `"="` | `EqualEqual`; `Equals` |
| U-LEX-17 | `:=` produces `Assign`; `:` alone produces `Colon` | `":="`, `":"` | `Assign`; `Colon` |
| U-LEX-18 | `<=` produces `LessEqual`; `<` alone produces `LessThan` | `"<="`, `"<"` | `LessEqual`; `LessThan` |
| U-LEX-19 | `<>` produces `NotEqual` | `"<>"` | `NotEqual` |
| U-LEX-20 | `>=` produces `GreaterEqual`; `>` alone produces `GreaterThan` | `">="`, `">"` | `GreaterEqual`; `GreaterThan` |

---

## 8. Dot and Elementwise Operators

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-LEX-21 | Standalone `.` produces `Dot` | `"."` | `Dot` |
| U-LEX-22 | `.+` produces `DotPlus` | `".+"` | `DotPlus` |
| U-LEX-23 | `.-` produces `DotMinus` | `".-"` | `DotMinus` |
| U-LEX-24 | `.*` produces `DotStar` | `".*"` | `DotStar` |
| U-LEX-25 | `./` produces `DotSlash` | `"./"` | `DotSlash` |
| U-LEX-26 | `.^` produces `DotPower` | `".^"` | `DotPower` |

---

## 9. Integer Literals

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-LEX-27 | Single-digit integer | `"0"` | `kind === IntegerLiteral`, `value === 0` |
| U-LEX-28 | Multi-digit integer | `"42"` | `kind === IntegerLiteral`, `value === 42` |
| U-LEX-29 | Large integer | `"12345"` | `kind === IntegerLiteral`, `value === 12345` |

---

## 10. Real Literals

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-LEX-30 | Decimal real | `"3.14"` | `kind === RealLiteral`, `value === 3.14` |
| U-LEX-31 | Trailing-dot real | `"1."` | `kind === RealLiteral`, `value === 1.0` |
| U-LEX-32 | Exponent with negative sign | `"1.5e-3"` | `kind === RealLiteral`, `value === 1.5e-3` |
| U-LEX-33 | Uppercase exponent with positive sign | `"2E+4"` | `kind === RealLiteral`, `value === 2e4` |
| U-LEX-34 | Exponent with no decimal part | `"1e10"` | `kind === RealLiteral`, `value === 1e10` |
| U-LEX-35 | Exponent with no following digit throws | `"1e"` | `Error` thrown |

---

## 11. Number/Dot Disambiguation

The dot after integer digits is **not** consumed as part of the number when followed by an elementwise operator character (`+`, `-`, `*`, `/`, `^`).

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-LEX-36 | `1.+x` scans as integer, DotPlus, identifier | `"1.+x"` | Kinds: `IntegerLiteral`, `DotPlus`, `Identifier` |
| U-LEX-37 | `1.*x` scans as integer, DotStar, identifier | `"1.*x"` | Kinds: `IntegerLiteral`, `DotStar`, `Identifier` |

---

## 12. Identifiers

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-LEX-38 | Simple single-letter identifier | `"x"` | `kind === Identifier`, `value === "x"` |
| U-LEX-39 | Mixed-case identifier with digit suffix | `"myVar2"` | `kind === Identifier`, `value === "myVar2"` |
| U-LEX-40 | Underscore-prefixed identifier | `"_internal"` | `kind === Identifier`, `value === "_internal"` |
| U-LEX-41 | Built-in type names are not keywords | `"Real Integer Boolean String"` | All four produce `Identifier`, not a keyword kind |

---

## 13. Keywords

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-LEX-42 | `model` keyword | `"model"` | `kind === TokenKind.Model` |
| U-LEX-43 | `equation` keyword | `"equation"` | `kind === TokenKind.Equation` |
| U-LEX-44 | `der` keyword | `"der"` | `kind === TokenKind.Der` |
| U-LEX-45 | Spot-check five more keywords | `"algorithm function package parameter end"` | Kinds: `Algorithm`, `Function`, `Package`, `Parameter`, `End` |

---

## 14. Boolean Literals

`true` and `false` are in the keyword table but the lexer converts them to `BooleanLiteral` tokens with a boolean `value` field rather than emitting `TokenKind.True` / `TokenKind.False`.

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-LEX-46 | `true` produces `BooleanLiteral` with value `true` | `"true"` | `kind === BooleanLiteral`, `value === true` (boolean) |
| U-LEX-47 | `false` produces `BooleanLiteral` with value `false` | `"false"` | `kind === BooleanLiteral`, `value === false` (boolean) |

---

## 15. String Literals

The `value` on the token is the **decoded** string content — escape sequences are resolved and surrounding quotes are not included.

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-LEX-48 | Simple string | `"\"hello\""` | `kind === StringLiteral`, `value === "hello"` |
| U-LEX-49 | Empty string | `"\"\""` | `kind === StringLiteral`, `value === ""` |
| U-LEX-50 | `\n` escape decoded to newline | `"\"\\n\""` | `value === "\n"` (one newline character) |
| U-LEX-51 | `\t` escape decoded to tab | `"\"\\t\""` | `value === "\t"` (one tab character) |
| U-LEX-52 | `\\` escape decoded to backslash | `"\"\\\\\""`  | `value === "\\"` (one backslash) |
| U-LEX-53 | `\"` escape decoded to double-quote | `"\"\\\"\""` | `value === "\""` (one double-quote character) |
| U-LEX-54 | Unterminated string literal throws | `"\"hello"` | `Error` thrown |

---

## 16. Quoted Identifiers

Quoted identifiers use single quotes and produce `TokenKind.Identifier`. The quotes are discarded; the `value` is the raw name text. A `\` inside the quotes causes the immediately following character to be taken literally.

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-LEX-55 | Name with spaces | `"'hello world'"` | `kind === Identifier`, `value === "hello world"` |
| U-LEX-56 | Name with dots | `"'my.variable'"` | `kind === Identifier`, `value === "my.variable"` |
| U-LEX-57 | Escaped single-quote inside name | `"'can\\'t stop'"` | `kind === Identifier`, `value === "can't stop"` |
| U-LEX-58 | Unterminated quoted identifier throws | `"'hello"` | `Error` thrown |

---

## 17. Source Locations

Every token carries a `span` with `start` and `end` `SourceLocation` values. Each `SourceLocation` has `file`, `line` (1-based), `column` (1-based), and `offset` (0-based byte index).

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-LEX-59 | First token starts at offset 0 | `"model"` | `span.start.offset === 0` |
| U-LEX-60 | Token offsets bracket the token text | `"model"` | `span.start.offset === 0`, `span.end.offset === 5` |
| U-LEX-61 | Token on second line has `line === 2`, `column === 1` | `"x\ny"` | Second token: `span.start.line === 2`, `span.start.column === 1` |
| U-LEX-62 | `file` field matches the constructor argument | `new Lexer("x", "my_file.mo")` | `span.start.file === "my_file.mo"` |

---

## 18. Error Reporting

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-LEX-63 | An unexpected character throws | `"@"` | `Error` thrown |
| U-LEX-64 | Error message includes `file:line:col:` prefix | `new Lexer("@", "test.mo")` | Error message starts with `"test.mo:1:1:"` |
