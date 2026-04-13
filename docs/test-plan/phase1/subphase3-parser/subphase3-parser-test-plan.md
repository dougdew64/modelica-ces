# Phase 1, Subphase 3: Parser — Test Plan

## Overview

This document defines the tests for the Modelica parser. The parser consumes the token stream produced by the lexer and builds an Abstract Syntax Tree (AST) rooted at a `StoredDefinition` node.

Tests are written before implementation (TDD). All tests in this document are failing until the corresponding implementation is in place.

Test source file: `tests/phase1/subphase3-parser/parser_test.ts`

Design reference: `docs/phase1/subphase3-parser/phase1-subphase3-parser.md`

---

## Testing Approach

The parser is a class with a single public entry point: `parse()`. All tests call `parse()` on a Modelica source string and inspect the returned AST. A small set of helper functions in the test file reduce boilerplate:

- `parse(source)` — constructs a `Parser` and calls `.parse()`, returning a `StoredDefinition`
- `parseClass(source)` — calls `parse(source)` and returns `classDefinitions[0].definition`
- `firstElement(def)` — returns `elements[0]` from a `ClassDefinition`
- `firstEquation(source)` — returns the first equation from the first equation section
- `parseExpr(exprSource)` — wraps the expression in a minimal model and returns the parsed `Expression` for its RHS

Error-case tests use `assertThrows` to confirm that the parser throws an `Error` with the expected message content.

---

## 1. Basic Structure

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-PAR-1 | `Parser` is exported and constructible | `new Parser("", "test.mo")` | Constructs without error; instance is non-null |
| U-PAR-2 | Instance has a `parse` method | `typeof parser.parse` | `"function"` |
| U-PAR-3 | Empty source returns a `StoredDefinition` with an empty class list | `parse("")` | `kind === "StoredDefinition"`, `classDefinitions.length === 0` |

---

## 2. `StoredDefinition` and `within` Clause

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-PAR-4 | `withinPath` is `null` when no `within` clause is present | `parse("")` | `withinPath === null` |
| U-PAR-5 | `within;` produces `withinPath === null` (no name given) | `"within;"` | `withinPath === null` |
| U-PAR-6 | `within Foo;` produces a single-part `withinPath` | `"within Foo;"` | `withinPath.parts.length === 1`, `parts[0].name === "Foo"` |
| U-PAR-7 | `within Foo.Bar;` produces a two-part `withinPath` | `"within Foo.Bar;"` | `withinPath.parts.length === 2`, `parts[0].name === "Foo"`, `parts[1].name === "Bar"` |
| U-PAR-8 | Multiple class definitions are all collected | `"model A end A; model B end B;"` | `classDefinitions.length === 2` |

---

## 3. Class Definitions

### Long-form class definitions

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-PAR-9 | Minimal model: kind, restriction, name | `"model M end M;"` | `kind === "ClassDefinition"`, `restriction === "model"`, `name === "M"` |
| U-PAR-10 | Spot-check class restrictions | `"block M end M;"`, `"record M end M;"`, `"connector M end M;"`, `"package M end M;"`, `"function M end M;"`, `"type M end M;"`, `"class M end M;"` | Each produces the matching `restriction` string |
| U-PAR-11 | `operator function` and `operator record` two-word restrictions | `"operator function M end M;"`, `"operator record M end M;"` | `restriction === "operator function"`, `restriction === "operator record"` |
| U-PAR-12 | `encapsulated` and `partial` prefix flags | `"encapsulated partial model M end M;"` | `isEncapsulated === true`, `isPartial === true` |
| U-PAR-13 | `pure` and `impure` prefix flags | `"pure function F end F;"`, `"impure function F end F;"` | `isPure === true`, `isImpure === true` |
| U-PAR-14 | `final` prefix on a class definition | `"final model M end M;"` | `classDefinitions[0].isFinal === true` |
| U-PAR-15 | Mismatched end-name throws | `"model Foo end Bar;"` | `Error` thrown containing `"Mismatched"` |

### Short-form class definitions

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-PAR-16 | Short type specialization | `"type Length = Real;"` | `kind === "ShortClassDefinition"`, `restriction === "type"`, `name === "Length"`, `baseType.parts[0].name === "Real"` |
| U-PAR-17 | Short enumeration | `"type Dir = enumeration(x, y, z);"` | `kind === "ShortClassDefinition"`, `enumeration.length === 3`, `enumeration[0].name === "x"` |

---

## 4. Component Declarations

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-PAR-18 | Simple component | `"model M Real x; end M;"` | `kind === "ComponentDeclaration"`, `name === "x"`, `typeName.parts[0].name === "Real"` |
| U-PAR-19 | `parameter` variability | `"model M parameter Real m; end M;"` | `variability === "parameter"` |
| U-PAR-20 | `constant` and `discrete` variability | `"model M constant Real c; end M;"`, `"model M discrete Real d; end M;"` | `variability === "constant"`, `variability === "discrete"` |
| U-PAR-21 | `input` and `output` causality | `"model M input Real u; end M;"`, `"model M output Real y; end M;"` | `causality === "input"`, `causality === "output"` |
| U-PAR-22 | `flow` and `stream` prefixes | `"model M flow Real i; end M;"`, `"model M stream Real h; end M;"` | `isFlow === true`, `isStream === true` |
| U-PAR-23 | Array subscripts in declaration | `"model M Real[3] v; end M;"` | `arraySubscripts.length === 1` |
| U-PAR-24 | Component with class modification | `"model M Real x(start = 0.0); end M;"` | `modification.classModification !== null`, `classModification.arguments[0].name.parts[0].name === "start"` |

---

## 5. `extends` and `import` Clauses

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-PAR-25 | `extends` clause | `"model M extends Base; end M;"` | `kind === "ExtendsClause"`, `baseName.parts[0].name === "Base"` |
| U-PAR-26 | `import` clause — simple path | `"model M import Foo.Bar; end M;"` | `kind === "ImportClause"`, two-part path |
| U-PAR-27 | `import` clause — wildcard | `"model M import Foo.*; end M;"` | `isWildcard === true` |
| U-PAR-28 | `import` clause — alias | `"model M import F = Foo.Bar; end M;"` | `alias === "F"` |

---

## 6. Modifications

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-PAR-29 | Binding expression modification | `"model M Real x = 1.0; end M;"` | `modification.bindingExpression.kind === "RealLiteral"` |
| U-PAR-30 | Nested modification | `"model M R1 r(p(v(start = 0))); end M;"` | Three levels of `ClassModification` nesting |
| U-PAR-31 | `each` and `final` in element modification | `"model M R1[3] r(each final x = 0); end M;"` | `isEach === true`, `isFinal === true` on the `ElementModification` |

---

## 7. Equation Sections

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-PAR-32 | Equation section is parsed; `isInitial` is false | `"model M equation x = 0; end M;"` | `equationSections.length === 1`, `isInitial === false` |
| U-PAR-33 | `initial equation` section has `isInitial === true` | `"model M initial equation x = 0; end M;"` | `equationSections[0].isInitial === true` |
| U-PAR-34 | Simple equation | `"model M equation x = 1.0; end M;"` | First equation: `kind === "SimpleEquation"` |
| U-PAR-35 | Connect equation | `"model M equation connect(p, n); end M;"` | `kind === "ConnectEquation"`, `from.parts[0].name === "p"`, `to.parts[0].name === "n"` |
| U-PAR-36 | For equation | `"model M equation for i in 1:N loop x[i] = 0; end for; end M;"` | `kind === "ForEquation"`, one iterator named `"i"` |
| U-PAR-37 | If equation | `"model M equation if x > 0 then y = 1; end if; end M;"` | `kind === "IfEquation"` |
| U-PAR-38 | When equation | `"model M equation when x > 1 then y = 0; end when; end M;"` | `kind === "WhenEquation"` |
| U-PAR-39 | Function-call equation (no `=` following) | `"model M equation assert(x > 0, \"msg\"); end M;"` | `kind === "FunctionCallEquation"`, `name.parts[0].name === "assert"` |

---

## 8. Algorithm Sections

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-PAR-40 | Algorithm section is parsed; `isInitial` is false | `"model M algorithm x := 1; end M;"` | `algorithmSections.length === 1`, `isInitial === false` |
| U-PAR-41 | `initial algorithm` section has `isInitial === true` | `"model M initial algorithm x := 1; end M;"` | `algorithmSections[0].isInitial === true` |
| U-PAR-42 | Assignment statement | `"model M algorithm x := 1; end M;"` | `kind === "AssignmentStatement"` |
| U-PAR-43 | Tuple assignment statement | `"model M algorithm (a, b) := f(x); end M;"` | `kind === "AssignmentStatement"`, `target` has `components.length === 2` |
| U-PAR-44 | `return` and `break` statements | `"function F algorithm return; end F;"`, `"function F algorithm break; end F;"` | `kind === "ReturnStatement"`, `kind === "BreakStatement"` |
| U-PAR-45 | For statement | `"model M algorithm for i in 1:N loop x := 0; end for; end M;"` | `kind === "ForStatement"` |
| U-PAR-46 | While statement | `"model M algorithm while x > 0 loop x := x - 1; end while; end M;"` | `kind === "WhileStatement"` |

---

## 9. Expressions

All expression tests use a helper `parseExpr(src)` that wraps `src` in `model _M equation _e = SRC; end _M;` and returns the parsed RHS. Range and subscript expressions are tested in their natural contexts (for-iterators, array subscripts) because `:` is not an infix operator in the Pratt parser.

### Literal atoms

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-PAR-47 | Integer literal | `"42"` | `kind === "IntegerLiteral"`, `value === 42` |
| U-PAR-48 | Real literal | `"3.14"` | `kind === "RealLiteral"`, `value === 3.14` |
| U-PAR-49 | String literal | `'"hello"'` | `kind === "StringLiteral"`, `value === "hello"` |
| U-PAR-50 | Boolean literals | `"true"`, `"false"` | `kind === "BooleanLiteral"`, `value === true` and `false` |

### Unary and binary operators

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-PAR-51 | Unary minus | `"-x"` | `kind === "UnaryExpr"`, `op === "-"` |
| U-PAR-52 | Unary `not` | `"not x"` | `kind === "UnaryExpr"`, `op === "not"` |
| U-PAR-53 | Binary arithmetic | `"x + y"` | `kind === "BinaryExpr"`, `op === "+"` |
| U-PAR-54 | Multiplication binds tighter than addition | `"1 + 2 * 3"` | Root is `BinaryExpr(+)`; `right` is `BinaryExpr(*)` |
| U-PAR-55 | `^` is right-associative | `"2 ^ 3 ^ 4"` | Root is `BinaryExpr(^)`; `right` is `BinaryExpr(^)` |

### Component references and function calls

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-PAR-56 | Component reference | `"x.y.z"` | `kind === "ComponentReference"`, three parts |
| U-PAR-57 | Global component reference (leading dot) | `".Foo.bar"` | `isGlobal === true`, two parts |
| U-PAR-58 | Function call | `"sin(x)"` | `kind === "FunctionCallExpr"`, `name.parts[0].name === "sin"` |
| U-PAR-59 | `der(x)` produces a function-call expression | `"der(x)"` | `kind === "FunctionCallExpr"`, `name.parts[0].name === "der"` |

### Compound expressions

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-PAR-60 | Array construction | `"{1, 2, 3}"` | `kind === "ArrayConstructExpr"`, `elements.length === 3` |
| U-PAR-61 | Two-part range in for-iterator | `"for i in 1:N loop x = 0; end for"` in equation section | `range.kind === "RangeExpr"`, `step === null` |
| U-PAR-62 | Three-part range (with step) in for-iterator | `"for i in 1:2:N loop x = 0; end for"` in equation section | `range.step !== null` |
| U-PAR-63 | If-expression | `"if x > 0 then 1 else 0"` | `kind === "IfExpr"`, `elseIfs.length === 0` |
| U-PAR-64 | Named function arguments | `"f(x = 1, y = 2)"` | `args.positional.length === 0`, `args.named.length === 2`, `args.named[0].name === "x"` |

---

## 10. Annotations and String Comments

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-PAR-65 | Annotation on a component declaration | `'model M Real x annotation(Color = 1); end M;'` | `annotation.kind === "Annotation"` |
| U-PAR-66 | Annotation at class level | `'model M annotation(version = "1.0"); end M;'` | `annotation.kind === "Annotation"` |
| U-PAR-67 | String comment on a component declaration | `'model M Real x "the x variable"; end M;'` | `comment === "the x variable"` |

---

## 11. Error Reporting

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-PAR-68 | Mismatched class end-name throws with descriptive message | `"model Foo end Bar;"` | `Error` thrown containing `"Mismatched"` |
| U-PAR-69 | Missing semicolon after class definition throws | `"model M end M model N end N;"` | `Error` thrown |
| U-PAR-70 | Error message includes `file:line:col:` prefix | `new Parser("model Foo end Bar;", "test.mo")` | Error message starts with `"test.mo:"` |

---

## 12. End-to-End

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-PAR-71 | `SpringMassDamper.mo` parses to the expected full structure | File read from `tests/models/SpringMassDamper.mo` | `StoredDefinition` with one `ClassDefinition`; `restriction === "model"`, `name === "SpringMassDamper"`, `elements.length === 5`, one equation section with two `SimpleEquation`s |
