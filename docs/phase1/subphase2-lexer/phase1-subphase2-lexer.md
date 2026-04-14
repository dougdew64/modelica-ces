# Phase 1, Subphase 2: Lexer

This document describes the implementation of the Modelica lexer (tokenizer). The lexer converts raw source text into a flat sequence of tokens for consumption by the parser.

Scope:
- Lexer class structure and state
- Character scanning and token recognition
- Handling of Modelica-specific lexing rules: block comments, quoted identifiers, numeric literals, keywords vs. identifiers, and elementwise operators

The token types and keyword table that the lexer produces are defined in the data structures document:

**[phase1-subphase1-data-structures.md — Token types and keyword table](../subphase1-data-structures/phase1-subphase1-data-structures.md)**

The authoritative lexical reference is:

**[Modelica 3.6 Concrete Syntax — Lexical Conventions (Appendix A.1)](https://specification.modelica.org/maint/3.6/modelica-concrete-syntax.html)**
**[Modelica 3.6 Lexical Structure](https://specification.modelica.org/maint/3.6/lexical-structure.html)**

---

## Spec Conformance Update — 2026-04-13

This document was revised on **2026-04-13** as part of the same conformance pass that updated the parser design document ([phase1-subphase3-parser.md](../subphase3-parser/phase1-subphase3-parser.md)) against the Modelica 3.6 Language Specification. Verifying the lexer against Appendix A.1 surfaced three real divergences from the spec, all of which are fixed below.

Each change is marked with a `[SPEC UPDATE]` callout in the same Was/Now/Spec rule/Action format used in the parser and data-structures documents. Search for `[SPEC UPDATE]` to find every change. The test plan, tests, and existing implementation in `src/phase1/lexer.ts` (or wherever the lexer lives) must be revised to match.

### Conformance change index

1. **Block comments do NOT nest** — see §3
2. **Identifiers are ASCII-only** — see §5
3. **Quoted identifiers have a restricted character set** (acceptable looseness — see §5 and §7)

### Relationship to the parser update

The parser's seventeen spec-conformance fixes were also reviewed against the lexer to determine whether any new tokens or new keywords are required. Result: **none**. Every keyword the parser dispatches on for the new behavior — `initial`, `pure`, `break`, `function`, `replaceable`, `redeclare`, `der`, `extends`, `enumeration`, `input`, `output` — is already in the lexer's keyword table. Every punctuation/operator token the new parsing logic uses (`:=`, `:`, `+` for description-string concatenation, etc.) is already produced. **No additions to the token kind enum or keyword table are needed for the parser updates.** The keyword set in `src/phase1/data-structures.ts` should still be cross-checked against the spec's reserved-word list to confirm — the lexer was built from a 59-word list and the spec lists the same 59 reserved words, but the verification should be done again as part of the conformance pass.

---

## 1. Lexer Structure

The lexer is a class with a single public method, `nextToken()`, that returns the next token each time it is called. It does not tokenize the entire source up front — it produces one token per call. The parser drives the lexer by calling `nextToken()` as it needs tokens. This avoids allocating a large token array for the full source.

```typescript
class Lexer {
  private source: string;
  private file: string;
  private pos: number;          // current byte offset into source
  private tokenStart: number;   // offset where the current token began

  constructor(source: string, file: string) {
    this.source = source;
    this.file = file;
    this.pos = 0;
    this.tokenStart = 0;
  }

  nextToken(): Token { ... }

  private peek(): string     { return this.source[this.pos] ?? "\0"; }
  private peekNext(): string { return this.source[this.pos + 1] ?? "\0"; }
  private advance(): string  { return this.source[this.pos++]; }
  private isAtEnd(): boolean { return this.pos >= this.source.length; }
  private match(ch: string): boolean {
    if (this.peek() === ch) { this.pos++; return true; }
    return false;
  }
}
```

The four core helpers (`peek`, `peekNext`, `advance`, `match`) are the only primitives needed for all scanning. `peek` and `peekNext` return `"\0"` past the end of source, which simplifies boundary checks — most character tests fail naturally against `"\0"` without explicit end-of-input guards.

If eager tokenization is preferred (for example, to support arbitrary look-ahead in the parser), a `tokenizeAll(): Token[]` method can call `nextToken()` in a loop until `EOF`. Either approach works — the parser interface supports both.

---

## 2. Main Scanning Loop

`nextToken()` follows this fixed pattern:

1. Skip whitespace and comments
2. If at end, return EOF
3. Record the start position in `tokenStart`
4. Consume one character and dispatch to the appropriate handler
5. Return the resulting token

```typescript
nextToken(): Token {
  this.skipWhitespaceAndComments();

  if (this.isAtEnd()) {
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
    case "\"":
      return this.scanString();
    case "'":
      return this.scanQuotedIdentifier();
    default:
      if (isDigit(ch)) return this.scanNumber();
      if (isIdentStart(ch)) return this.scanIdentifierOrKeyword();
      throw this.error(`Unexpected character: '${ch}'`);
  }
}
```

The dispatch structure is straightforward: single-character tokens are handled inline; two-character tokens like `==`, `:=`, `<=`, `<>`, `>=` are handled with a single `match` call that peeks and conditionally consumes. Multi-character tokens with complex rules (strings, identifiers, numbers, dots) are delegated to private methods.

---

## 3. Whitespace and Comment Skipping

Whitespace and comments are discarded — they produce no tokens.

```typescript
private skipWhitespaceAndComments(): void {
  while (!this.isAtEnd()) {
    const ch = this.peek();

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      this.advance();
      continue;
    }

    // Line comment: // ... to end of line
    if (ch === "/" && this.peekNext() === "/") {
      while (!this.isAtEnd() && this.peek() !== "\n") {
        this.advance();
      }
      continue;
    }

    // Block comment: /* ... */ with nesting support
    if (ch === "/" && this.peekNext() === "*") {
      this.advance(); // consume /
      this.advance(); // consume *
      this.scanBlockComment();
      continue;
    }

    break;
  }
}
```

### 3.1 Block comments do not nest

> **\[SPEC UPDATE]** — *Block comments do not nest (lexer item 1)*
>
> **Was:** the original document said Modelica block comments support nesting and described a depth counter implementation. This was incorrect.
> **Now:** the spec explicitly states: *"Delimited Modelica comments do not nest, i.e., `/* */` cannot be embedded within `/* … */`."* Block comments behave the same as in C and Java — the first `*/` after a `/*` ends the comment, regardless of any intervening `/*`.
> **Spec reference:** Modelica 3.6 lexical structure, "Comments" subsection.
> **Action:**
> - Replace `scanBlockComment` with the simple non-nesting version below.
> - Remove the depth counter from the lexer state and from any helper methods.
> - Update tests:
>   - `/* foo */` accepted (unchanged).
>   - `/* foo /* bar */` accepted as a single comment (the `/*` inside is part of the comment text, not a new opening). The original tests likely treated this as the start of a nested comment.
>   - `/* foo /* bar */ baz */` is **a comment `/* foo /* bar */` followed by the tokens `baz`, `*`, `/`** — not one nested comment. Any test that expected the whole thing to be a single comment must be revised.
>   - Unterminated `/* foo` still produces an error.

```typescript
private scanBlockComment(): void {
  // The opening "/*" has already been consumed by the caller.
  while (!this.isAtEnd()) {
    if (this.peek() === "*" && this.peekNext() === "/") {
      this.advance(); // consume *
      this.advance(); // consume /
      return;
    }
    this.advance();
  }
  throw this.error("Unterminated block comment");
}
```

The non-nesting behavior matches C, C++, and Java exactly: scan forward until the first `*/`, consume it, and return. If end-of-source is reached first, throw an unterminated-comment error.

---

## 4. Numeric Literals

Modelica has two numeric token kinds: `IntegerLiteral` and `RealLiteral`. The main dispatch calls `scanNumber()` when the first character consumed was a digit. At entry, that first digit has already been consumed and `tokenStart` points to it.

```typescript
private scanNumber(): Token {
  // First digit already consumed

  // Consume remaining integer digits
  while (isDigit(this.peek())) this.advance();

  let isReal = false;

  // A dot makes this a real literal, unless followed by an elementwise operator
  // (e.g. 1.+x should be integer 1, then .+, then x — not real 1. then +x)
  if (this.peek() === "." && !isElementwiseOp(this.peekNext())) {
    isReal = true;
    this.advance(); // consume the dot
    while (isDigit(this.peek())) this.advance();
  }

  // An exponent (e or E) also makes this a real literal
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

function isElementwiseOp(ch: string): boolean {
  return ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "^";
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}
```

### 4.1 Edge cases

| Input | Expected | Notes |
|-------|----------|-------|
| `42` | `IntegerLiteral(42)` | Plain integer |
| `3.14` | `RealLiteral(3.14)` | Decimal real |
| `1.` | `RealLiteral(1.0)` | Trailing dot — valid real, not integer |
| `1.5e-3` | `RealLiteral(0.0015)` | Exponent with sign |
| `2E+4` | `RealLiteral(20000.0)` | Uppercase E |
| `1:10` | `IntegerLiteral(1)`, `Colon`, `IntegerLiteral(10)` | Range — dot not present |
| `1.+x` | `IntegerLiteral(1)`, `DotPlus`, `Identifier(x)` | Elementwise op, not real |
| `1.*x` | `IntegerLiteral(1)`, `DotStar`, `Identifier(x)` | Elementwise op, not real |

The critical disambiguation is `1.` vs. `1.+`. When the dot is followed by an elementwise operator character (`+`, `-`, `*`, `/`, `^`), the dot is not consumed as part of the number — it belongs to the elementwise token. In all other cases (digit, letter, or anything else), the dot is part of the real literal.

---

## 5. Identifiers and Keywords

> **\[SPEC UPDATE]** — *Identifiers are ASCII-only (lexer item 2)*
>
> **Was:** the original document said *"Modelica 3.6 permits Unicode letters as identifier start characters"* and used `\p{L}` regular-expression checks for non-ASCII characters in `isIdentStart`/`isIdentPart`. This was incorrect.
> **Now:** the spec states: *"The character set of the Modelica language is Unicode, but restricted to the Unicode characters corresponding to 7-bit ASCII characters for identifiers."* The IDENT alphabet is exactly: `a-z`, `A-Z`, `_`, and (for non-first characters) `0-9`. No Unicode letters, combining marks, or non-ASCII digits are allowed in unquoted identifiers.
>
> Note: this restriction applies only to **unquoted** identifiers. Quoted identifiers (`'…'`) and string literals can still contain a wider character set — see §7 below.
> **Spec reference:** Modelica 3.6 lexical structure, "Identifiers" subsection; Appendix A.1 `IDENT`, `NON-DIGIT`.
> **Action:**
> - Replace `isIdentStart` and `isIdentPart` with the strict ASCII-only versions shown below.
> - Update tests:
>   - Negative test: `Real café = 1.0;` — `é` should now produce a lex error (the original parser may have accepted this).
>   - Positive tests: standard ASCII identifiers, identifiers with digits, leading underscores, mixed case — unchanged.
>   - Confirm that string literals containing non-ASCII characters (e.g., `"naïve"`) are still accepted — strings are full Unicode per the spec.

After consuming the first character (which passed `isIdentStart`), `scanIdentifierOrKeyword` consumes all remaining identifier characters and then checks the keyword table.

```typescript
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

function isIdentStart(ch: string): boolean {
  if (ch >= "a" && ch <= "z") return true;
  if (ch >= "A" && ch <= "Z") return true;
  if (ch === "_") return true;
  return false;
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}
```

### 5.1 `true` and `false`

`true` and `false` are in the keyword table (as `TokenKind.True` and `TokenKind.False`), but the lexer converts them to `BooleanLiteral` tokens with a boolean `value` field. This is a convenience — without it, the parser would have to check for identifier tokens with text `"true"` or `"false"` in many expression-parsing contexts.

### 5.2 `der`

`der` is a keyword (`TokenKind.Der`). The parser produces a regular function-call AST node for `der(x)` — the keyword is purely for efficient identification in later phases, avoiding string comparisons. Other built-in function names (`abs`, `sign`, `sqrt`, `sin`, etc.) remain ordinary identifiers; only `der` has structural significance, as it identifies state variables during equation processing.

### 5.3 `Real`, `Integer`, `Boolean`, `String`

These are **not** keywords. They are ordinary identifiers that name built-in types. The lexer produces `TokenKind.Identifier` for them. They are resolved to type meanings during flattening, not during parsing. Treating them as keywords would break qualified paths like `Modelica.SIunits.Real`.

---

## 6. String Literals

Modelica strings use double quotes. The opening `"` has already been consumed at entry. The lexer builds the decoded string value as it scans, handling escape sequences.

```typescript
private scanString(): Token {
  let value = "";

  while (!this.isAtEnd() && this.peek() !== "\"") {
    if (this.peek() === "\\") {
      this.advance(); // consume backslash
      const esc = this.advance();
      switch (esc) {
        case "n":  value += "\n"; break;
        case "t":  value += "\t"; break;
        case "\\": value += "\\"; break;
        case "\"": value += "\""; break;
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
```

The `value` stored on the token is the decoded string content — backslash sequences are resolved, and the surrounding quotes are not included. String concatenation with `+` is an expression-level operation handled by the parser, not the lexer.

---

## 7. Quoted Identifiers

Modelica allows identifiers enclosed in single quotes: `'my.unusual variable'`. Inside the quotes, spaces, dots, double quotes, and most other characters are legal. This is used by the Modelica Standard Library for names that contain special characters.

The opening `'` has already been consumed at entry.

```typescript
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
```

Quoted identifiers produce `TokenKind.Identifier` — the same kind as unquoted identifiers. The quotes are a lexical detail; the parser and all later phases receive only the name string.

> **\[SPEC UPDATE]** — *Quoted identifier character set is restricted (lexer item 3, acceptable looseness)*
>
> **Was:** the original document allowed any character inside a quoted identifier (other than backslash and the closing single quote).
> **Now:** the spec defines `Q-CHAR` (the character class allowed inside `'…'`) as exactly: `NON-DIGIT`, `DIGIT`, plus the 28 special characters `! # $ % & ( ) * + , - . / : ; < > = ? @ [ ] ^ { } | ~` `<space>` and `"`. Notably, **non-ASCII characters are not allowed inside a quoted identifier**, even though they are allowed inside string literals. Only the listed ASCII characters and the standard escape sequences (`\'`, `\"`, `\?`, `\\`, `\a`, `\b`, `\f`, `\n`, `\r`, `\t`, `\v`) are valid.
> **Spec reference:** Modelica 3.6 Appendix A.1, `Q-IDENT` and `Q-CHAR`.
> **Action (acceptable looseness):** the parser will continue to accept the more permissive form. The current `scanQuotedIdentifier` is a strict superset of the spec: any valid Modelica quoted identifier is accepted; some non-ASCII content is also accepted that the spec rejects. **No required code change** unless strict conformance is desired. If strict conformance is required, add a `isQChar(ch)` predicate that checks against the explicit Q-CHAR set, and reject any character outside it. Tests in this case should cover: `'foo bar'` accepted, `'foo"bar'` accepted, `'foo\'bar'` accepted via escape, `'naïve'` rejected (non-ASCII), `'foo\u0007bar'` rejected (control character outside Q-CHAR).

---

## 8. Dot and Elementwise Operators

The dot character (`.`) is overloaded:

- Member access: `a.b.c`
- Start of an elementwise operator: `.+`, `.-`, `.*`, `./`, `.^`
- Part of a real literal: `1.5` — but this case is dispatched in `scanNumber`, not here

When the main dispatch reaches the `"."` case, it means the dot was not preceded by a digit (i.e., the number case did not apply). The lexer peeks at the next character to decide:

```typescript
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
```

Note that `scanNumber` already handles the case where a dot appears inside a number (`1.5`, `1.`). The `isElementwiseOp` check in `scanNumber` ensures that `1.+x` is correctly scanned as `IntegerLiteral(1)` + `DotPlus` + `Identifier(x)`, rather than `RealLiteral(1.)` + `Plus` + `Identifier(x)`.

---

## 9. Token Construction and Source Locations

### 9.1 `makeToken`

All scanning methods return tokens through `makeToken`:

```typescript
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
```

`tokenStart` is set at the beginning of `nextToken()`, just before the first character of the token is consumed. `this.pos` is the current position after all characters of the token have been consumed. The span covers exactly the characters belonging to the token.

### 9.2 `makeLocation`

```typescript
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
```

This implementation is O(n) per call. For a production compiler, precompute an array of line-start offsets at construction time and use binary search to convert offset to line/column in O(log n). For an initial implementation, the linear scan is correct and acceptable — `makeLocation` is only called when constructing tokens, and Modelica source files are rarely large enough for the O(n) cost to matter.

---

## 10. Error Reporting

```typescript
private error(message: string): Error {
  const loc = this.makeLocation(this.pos);
  return new Error(`${loc.file}:${loc.line}:${loc.column}: ${message}`);
}
```

The error includes the file name, line number, and column number, in the standard `file:line:col: message` format. The error is thrown from the scanning methods; the caller (`nextToken`) does not catch it — lexer errors propagate up to the top-level entry point for reporting and exit.

For richer diagnostics, the error message can include the source line text and a caret (`^`) pointing to the error column. This enhancement does not change the lexer structure and can be added later:

```
tests/Bad.mo:5:12: Unexpected character: '@'
  parameter Real @x = 1.0;
             ^
```

---

## 11. Update Summary for Test Plan, Tests, and Implementation

This section consolidates the changes from the 2026-04-13 spec-conformance update for use when revising the test plan, tests, and existing implementation in `src/phase1/lexer.ts`.

### Lexer logic changes (required)

1. **Block comments do not nest** (§3.1) — replace `scanBlockComment` with the simple non-nesting version. Remove the depth counter from any helper or state. Behavioral change: `/* foo /* bar */ baz */` is no longer parsed as one comment.
2. **Identifiers are ASCII-only** (§5) — replace `isIdentStart` and `isIdentPart` with the ASCII-only versions. Behavioral change: `Real café = 1.0;` now produces a lex error at `é`.

### Lexer logic changes (optional / acceptable looseness)

3. **Quoted identifier Q-CHAR** (§7) — the current implementation is more permissive than the spec. No required change. If strict conformance is desired, add an `isQChar` predicate.

### No-change items prompted by the parser update

The parser conformance pass (items 1–17 in [phase1-subphase3-parser.md](../subphase3-parser/phase1-subphase3-parser.md)) was reviewed against the lexer:

- **No new tokens** — every token kind referenced by the new parser logic is already in `TokenKind`.
- **No new keywords** — every keyword the new parser dispatches on (`initial`, `pure`, `break`, `function`, `replaceable`, `redeclare`, `der`, `extends`, `enumeration`, `input`, `output`) is already in the keyword table.
- **No new escape sequences or numeric forms** — the parser changes affect grammar above the lexical layer only.

A cross-check of the 59-keyword set in `src/phase1/data-structures.ts` against the spec's reserved-word list should be performed once as part of the conformance pass to confirm the keyword table is exact.

### New tests required

1. **Block comment non-nesting:**
   - Positive: `/* foo */` accepted as one comment.
   - Positive: `/* foo /* bar */` accepted as one comment (the inner `/*` is part of the comment text).
   - Boundary: `/* foo /* bar */ baz */` produces tokens `Identifier(baz)`, `Star`, `Slash` after the closing `*/` — not one nested comment. Replaces any prior nested-comment test.
   - Error: `/* foo` produces an unterminated-comment error.

2. **Identifier ASCII-only:**
   - Negative: `café` produces a lex error.
   - Negative: identifiers starting with non-ASCII characters produce errors.
   - Positive: `_x`, `x_`, `Real`, `Integer`, `myVar1`, `_123abc` — all unchanged.
   - Positive (sanity): `"naïve"` (a string literal containing non-ASCII) is still accepted — strings remain full Unicode.

3. **Optional, if strict Q-CHAR conformance is implemented:**
   - Positive: `'foo bar'`, `'foo.bar'`, `'foo"bar'`, `'foo\'bar'` accepted.
   - Negative: `'naïve'`, `'foo\u0007bar'` rejected.

### Test cases that are unchanged

All existing tests for numeric literals (integer, real, exponent, the `1.+x` ambiguity), string literals and escape sequences, dot/elementwise operator disambiguation, two-character operator tokens (`==`, `:=`, `<=`, `<>`, `>=`), the keyword vs. identifier check, and `true`/`false` → `BooleanLiteral` conversion are unaffected by the conformance update and should continue to pass without modification.
