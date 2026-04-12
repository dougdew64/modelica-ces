# Phase 1, Subphase 1: Data Structures — Test Plan

## Overview

This document defines the tests for the Phase 1 data structures: source location types, the `TokenKind` enum, the `Token` interface, the `KEYWORDS` lookup map, and the AST node types.

Tests are written before implementation (TDD). All tests in this document are failing until the corresponding implementation is in place.

Test source file: `tests/phase1/subphase1-data-structures/data_structures_test.ts`

Design reference: `docs/phase1/phase1-syntactic-parsing.md` — Part 1: Data Structures

---

## Testing approach

The data structures are a mix of runtime values and compile-time types:

- **`TokenKind` enum** — a JavaScript runtime object; its members and their uniqueness can be tested at runtime.
- **`KEYWORDS` map** — a runtime `Map<string, TokenKind>`; its size, entries, and completeness can be tested at runtime.
- **Interfaces and type aliases** (`SourceLocation`, `Span`, `Token`, all AST node interfaces) — erased at compile time; no runtime representation exists. Compliance is verified by TypeScript's type checker at compile time. A small number of shape tests confirm that objects constructed to satisfy each interface have the expected property names and value types at runtime.

---

## `TokenKind` enum

The `TokenKind` enum must contain exactly the members specified in the design, with distinct numeric values.

### Unit Tests

| # | Test | Expected Result |
|---|------|----------------|
| U-TK-1 | `TokenKind` is exported and is a non-null object | `typeof TokenKind === "object"` and `TokenKind !== null` |
| U-TK-2 | Literal kinds exist: `IntegerLiteral`, `RealLiteral`, `StringLiteral`, `BooleanLiteral` | Each is a `number` |
| U-TK-3 | `Identifier` kind exists | `typeof TokenKind.Identifier === "number"` |
| U-TK-4 | Spot-check keyword kinds: `Algorithm`, `Model`, `Equation`, `Function`, `Within` | Each is a `number` |
| U-TK-5 | Spot-check operator/punctuation kinds: `LParen`, `Assign`, `EqualEqual`, `NotEqual`, `DotPower` | Each is a `number` |
| U-TK-6 | `EOF` kind exists | `typeof TokenKind.EOF === "number"` |
| U-TK-7 | All enum values are unique | No two members share the same numeric value |
| U-TK-8 | Total member count is 93 | Computed by counting unique numeric values in the enum object |

**Member count breakdown:** 4 literals + 1 identifier + 59 keywords + 28 operators/punctuation + 1 EOF = 93

---

## `KEYWORDS` map

The `KEYWORDS` constant is a `Map<string, TokenKind>` that maps each Modelica keyword string (lowercase) to its `TokenKind`. It must be complete, correct, and must not include non-keyword identifiers.

### Unit Tests

| # | Test | Expected Result |
|---|------|----------------|
| U-KW-1 | `KEYWORDS` is exported and is a `Map` instance | `KEYWORDS instanceof Map` is `true` |
| U-KW-2 | `KEYWORDS` has exactly 59 entries | `KEYWORDS.size === 59` |
| U-KW-3 | Spot-check correct mappings | `"model"` → `TokenKind.Model`; `"equation"` → `TokenKind.Equation`; `"algorithm"` → `TokenKind.Algorithm`; `"within"` → `TokenKind.Within` |
| U-KW-4 | `"true"` and `"false"` map to their keyword kinds | `"true"` → `TokenKind.True`; `"false"` → `TokenKind.False` |
| U-KW-5 | `"der"` maps to `TokenKind.Der` | `KEYWORDS.get("der") === TokenKind.Der` |
| U-KW-6 | Non-keyword built-in type names are absent | `KEYWORDS.has("Real")`, `KEYWORDS.has("Integer")`, `KEYWORDS.has("Boolean")`, `KEYWORDS.has("String")` are all `false` |
| U-KW-7 | Keyword strings are lowercase | Every key in `KEYWORDS` equals its own `toLowerCase()` |
| U-KW-8 | No keyword `TokenKind` value is missing from the map | Every value of the 59 keyword members of `TokenKind` appears at least once as a value in `KEYWORDS` |

---

## Source location types

`SourceLocation` and `Span` are interfaces; they have no runtime representation. These tests verify that objects conforming to each interface have the expected property types.

### Unit Tests

| # | Test | Expected Result |
|---|------|----------------|
| U-SL-1 | A `SourceLocation` object has `file` (string), `line` (number), `column` (number), `offset` (number) | Constructed object has correct property types |
| U-SL-2 | A `Span` object has `start` and `end` properties, each a `SourceLocation` | Constructed object has correct nested structure |

---

## `Token` interface

`Token` is an interface; these tests verify runtime shape of conforming objects.

### Unit Tests

| # | Test | Token under test | Expected Result |
|---|------|-----------------|----------------|
| U-TOK-1 | A keyword token has `kind` (number), `span` (object), and no `value` | `{ kind: TokenKind.Model, span: ... }` | `"value" in token` is `false` or `token.value === undefined` |
| U-TOK-2 | An identifier token has `kind === TokenKind.Identifier` and `value` as a string | `{ kind: TokenKind.Identifier, span: ..., value: "x" }` | `typeof token.value === "string"` |
| U-TOK-3 | An integer literal token has `value` as a number | `{ kind: TokenKind.IntegerLiteral, span: ..., value: 42 }` | `typeof token.value === "number"` |
| U-TOK-4 | A boolean literal token has `value` as a boolean | `{ kind: TokenKind.True, span: ..., value: true }` | `typeof token.value === "boolean"` |

---

## AST node shapes

AST interfaces are compile-time constructs. These tests verify that the `kind` discriminant strings are correct and that constructed objects have the right top-level property shapes. Full correctness of the AST type hierarchy is validated by the TypeScript compiler.

### Unit Tests

| # | Test | Node under test | Expected `kind` value |
|---|------|-----------------|-----------------------|
| U-AST-1 | `StoredDefinition` discriminant | Constructed `StoredDefinition` | `"StoredDefinition"` |
| U-AST-2 | `ClassDefinition` discriminant | Constructed `ClassDefinition` | `"ClassDefinition"` |
| U-AST-3 | `ShortClassDefinition` discriminant | Constructed `ShortClassDefinition` | `"ShortClassDefinition"` |
| U-AST-4 | `ComponentDeclaration` discriminant | Constructed `ComponentDeclaration` | `"ComponentDeclaration"` |
| U-AST-5 | `ExtendsClause` discriminant | Constructed `ExtendsClause` | `"ExtendsClause"` |
| U-AST-6 | `ImportClause` discriminant | Constructed `ImportClause` | `"ImportClause"` |
| U-AST-7 | `ConstrainedByClause` discriminant | Constructed `ConstrainedByClause` | `"ConstrainedByClause"` |
| U-AST-8 | `Modification` discriminant | Constructed `Modification` | `"Modification"` |
| U-AST-9 | `ClassModification` discriminant | Constructed `ClassModification` | `"ClassModification"` |
| U-AST-10 | `ElementModification` discriminant | Constructed `ElementModification` | `"ElementModification"` |
| U-AST-11 | `Annotation` discriminant | Constructed `Annotation` | `"Annotation"` |
| U-AST-12 | `EquationSection` discriminant | Constructed `EquationSection` | `"EquationSection"` |
| U-AST-13 | `SimpleEquation` discriminant | Constructed `SimpleEquation` | `"SimpleEquation"` |
| U-AST-14 | `ConnectEquation` discriminant | Constructed `ConnectEquation` | `"ConnectEquation"` |
| U-AST-15 | `AlgorithmSection` discriminant | Constructed `AlgorithmSection` | `"AlgorithmSection"` |
| U-AST-16 | `AssignmentStatement` discriminant | Constructed `AssignmentStatement` | `"AssignmentStatement"` |
| U-AST-17 | `BinaryExpr` discriminant | Constructed `BinaryExpr` | `"BinaryExpr"` |
| U-AST-18 | `UnaryExpr` discriminant | Constructed `UnaryExpr` | `"UnaryExpr"` |
| U-AST-19 | `FunctionCallExpr` discriminant | Constructed `FunctionCallExpr` | `"FunctionCallExpr"` |
| U-AST-20 | `ExternalDeclaration` discriminant | Constructed `ExternalDeclaration` | `"ExternalDeclaration"` |
