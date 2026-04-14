# Phase 1, Subphase 3: Parser

This document describes the implementation of the Modelica parser. The parser consumes the token stream produced by the lexer and builds an Abstract Syntax Tree (AST).

Scope:
- Parser class structure and token consumption model
- Recursive descent parsing of Modelica grammar rules
- Pratt (precedence climbing) parser for expressions
- Error reporting and recovery

The AST node types that the parser produces are defined in the data structures document:

**[phase1-subphase1-data-structures.md — AST node types](../subphase1-data-structures/phase1-subphase1-data-structures.md)**

The authoritative grammar reference is:

**[Modelica 3.6 Concrete Syntax (Appendix A.2)](https://specification.modelica.org/maint/3.6/modelica-concrete-syntax.html)**

---

## Spec Conformance Update — 2026-04-13

This document was revised on **2026-04-13** to bring it into complete agreement with the Modelica 3.6 Language Specification, after a verification pass against the formal grammar in Appendix A of the spec. The original version of the document had several divergences from the spec that would have produced an incorrect parser.

Each change is marked with a callout of the form:

> **\[SPEC UPDATE]** — *<short topic>*
>
> **Was:** what the original document said
> **Now:** what the spec actually requires
> **Spec rule:** the relevant production from Appendix A.2
> **Action:** what the test plan, tests, and existing implementation must change

These callouts can be searched for with the literal string `[SPEC UPDATE]`. Every callout corresponds to at least one change that the existing test plan, tests, and implementation must absorb. **Items 1–17 below are the full set of conformance changes** — use them as a checklist when revising test plan, tests, and implementation.

### Conformance change index

1. **Power operator is non-associative**, not right-associative — see §3.2, §3.3
2. **Unary `+`/`-` binds at addition level**, not between multiplication and power — see §3.2, §3.3
3. **Multi-component declarations** (`Real x, y, z;`) — see §2.4
4. **Type-level array subscripts** (`Real[3] x;`) — see §2.4
5. **Long class specifier with `extends`** (`model X extends Y(p=1) ... end X;`) — see §2.2
6. **`der`-class-specifier** (`function f = der(g, x)`) — see §2.2
7. **`initial` and `pure` as primary function-call prefixes** — see §3.3
8. **Tuple assignment RHS must be a function call** — see §2.8
9. **Class modification arguments can be `element-replaceable` or `element-redeclaration`** in addition to `element-modification` — see §2.5
10. **Element modifications carry a description-string** — see §2.5
11. **Modification expression can be `break`** — see §2.5
12. **Short class specifier has a `base-prefix`** (input/output) — see §2.2
13. **`:=` form in modifications** — see §2.5
14. **Description strings support `+` concatenation** — see §2.10
15. **Output-expression-list allows empty positions** (`(a, , c)`) for tuple targets — see §2.8
16. **Array constructors support `for`-comprehensions** (`{i*2 for i in 1:N}`) — see §3.3
17. **`function`-partial-application** in function arguments — see §3.6

Several minor items (function-call-equation LHS being parsed as a full expression, type-specifier being parsed via the more general component-reference parser) are documented as **acceptable looseness** — the parser accepts a strict superset of valid Modelica, which does not affect correctness for valid input. These are noted in §5.

---

## 1. Parser Class Structure and Token Consumption Model

### 1.1 Class structure

The parser is a class that wraps the lexer and exposes a single public method, `parse()`, which drives the full parse and returns a `StoredDefinition` node.

```typescript
class Parser {
  private lexer: Lexer;
  private current: Token;
  private previous: Token;

  constructor(source: string, file: string) {
    this.lexer = new Lexer(source, file);
    this.current = this.lexer.nextToken();
    this.previous = this.current;
  }

  parse(): StoredDefinition { ... }
}
```

The parser maintains **one token of lookahead**: `current` holds the next unconsumed token. `previous` holds the token that was most recently consumed.

### 1.2 Token consumption primitives

Five primitives cover all token consumption: `peek`, `check`, `advance`, `match`, `expect`. Their semantics are unchanged from the original document — see the implementation listing below.

```typescript
private peek(): TokenKind { return this.current.kind; }
private check(kind: TokenKind): boolean { return this.current.kind === kind; }
private advance(): Token {
  this.previous = this.current;
  this.current = this.lexer.nextToken();
  return this.previous;
}
private match(...kinds: TokenKind[]): boolean {
  for (const kind of kinds) {
    if (this.check(kind)) { this.advance(); return true; }
  }
  return false;
}
private expect(kind: TokenKind, message?: string): Token {
  if (this.check(kind)) return this.advance();
  throw this.error(
    message ?? `Expected ${TokenKind[kind]}, got ${TokenKind[this.current.kind]}`
  );
}
```

### 1.3 Two-token lookahead

A small number of decisions need two tokens of lookahead — `initial` followed by `equation` or `algorithm` (vs. `initial` as an element prefix), and named function arguments (`name =` vs. an identifier expression followed by `==`). Implement either by save/restore around an extra `advance()`, or by keeping a two-token buffer in the parser. Both approaches work.

### 1.4 Span construction

Every AST node carries a `span`. The pattern is unchanged:

```typescript
private spanFrom(start: SourceLocation): Span {
  return { start, end: this.previous.span.end };
}
```

---

## 2. Recursive Descent Parsing of Modelica Grammar Rules

The parser is a **recursive descent parser** — each grammar rule maps to a private method.

### 2.1 Top-level: stored definition

```
stored-definition :=
  [ within [ name ] ";" ]
  { [ final ] class-definition ";" }
```

```typescript
parse(): StoredDefinition {
  const start = this.current.span.start;

  let withinPath: ComponentReference | null = null;
  if (this.match(TokenKind.Within)) {
    if (!this.check(TokenKind.Semicolon)) {
      withinPath = this.parseName();
    }
    this.expect(TokenKind.Semicolon);
  }

  const classDefinitions: StoredClassEntry[] = [];
  while (!this.check(TokenKind.EOF)) {
    const isFinal = this.match(TokenKind.Final);
    const definition = this.parseClassDefinition(isFinal);
    classDefinitions.push({ isFinal, definition });
    this.expect(TokenKind.Semicolon);
  }

  return { kind: "StoredDefinition", span: this.spanFrom(start), withinPath, classDefinitions };
}
```

### 2.2 Class definitions

The spec splits class definitions into three forms via `class-specifier`:

```
class-definition  := [ encapsulated ] class-prefixes class-specifier
class-specifier   := long-class-specifier | short-class-specifier | der-class-specifier
class-prefixes    := [ partial ]
                     ( class | model | [ operator ] record | block
                     | [ expandable ] connector | type | package
                     | [ pure | impure ] [ operator ] function | operator )
```

The parser must distinguish all three forms after the class restriction has been parsed.

> **\[SPEC UPDATE]** — *Long class specifier with `extends` form (item 5)*
>
> **Was:** the original document only handled the `IDENT description-string composition end IDENT` form.
> **Now:** the long-class-specifier has a second form that begins with `extends`:
> ```
> long-class-specifier :=
>     IDENT description-string composition end IDENT
>   | extends IDENT [ class-modification ] description-string composition end IDENT
> ```
> This is the **extending class** definition (`model X extends Y(p = 1) ... end X;`), distinct from the `extends` clause that appears inside a class body. `parseClassDefinition` must check for the `extends` keyword immediately after the class restriction and, if present, parse `IDENT [ class-modification ]` as the base class extension.
> **Spec rule:** `long-class-specifier`
> **Action:**
> - Add `extending: { name: ComponentReference; modification: ClassModification | null } | null` to `ClassDefinition` in the data structures.
> - Update `parseClassDefinition` to detect and parse the `extends IDENT [ class-modification ]` form.
> - Add tests covering `model X extends Y; ... end X;` and `model X extends Y(p = 1); ... end X;`.

> **\[SPEC UPDATE]** — *`der`-class-specifier (item 6)*
>
> **Was:** the original document did not handle the `der`-class-specifier form at all.
> **Now:** the spec defines a third form of class-specifier:
> ```
> der-class-specifier :=
>   IDENT "=" der "(" type-specifier "," IDENT { "," IDENT } ")" description
> ```
> This is used to define a class as the partial derivative of another (e.g. `function f = der(g, x, y)`). `parseClassDefinition` must detect `der` after the `=` in a short-style class definition.
> **Spec rule:** `der-class-specifier`
> **Action:**
> - Add a new AST node type `DerClassDefinition` (or extend `ShortClassDefinition` with a `derInfo: { baseFunction: ComponentReference; withRespectTo: string[] } | null` field).
> - In `parseClassDefinition`, after consuming `=`, if the next token is `der`, dispatch to a new `parseDerClassBody` helper.
> - Add tests for `function df = der(f, x);` and `function df = der(f, x, y);`.

> **\[SPEC UPDATE]** — *Short class specifier `base-prefix` (item 12)*
>
> **Was:** the original document parsed short class specifiers without recognizing a `base-prefix`.
> **Now:** the spec rule is:
> ```
> short-class-specifier :=
>     IDENT "=" base-prefix type-specifier [ array-subscripts ]
>     [ class-modification ] description
>   | IDENT "=" enumeration "(" ( [ enum-list ] | ":" ) ")" description
> base-prefix := [ input | output ]
> ```
> `parseShortClassBody` must consume an optional `input` or `output` keyword before the type-specifier. Note also that the enumeration form supports `enumeration(:)` for an "open" enumeration type.
> **Spec rule:** `short-class-specifier`, `base-prefix`
> **Action:**
> - Add `basePrefix: { isInput: boolean; isOutput: boolean }` to `ShortClassDefinition`.
> - Add an `isOpen: boolean` flag on `ShortClassDefinition` for the `enumeration(:)` form.
> - Update `parseShortClassBody` to consume `input`/`output` before parsing the base type, and to recognize the `:` form inside `enumeration(...)`.
> - Add tests for `type T = input Real;`, `type T = output Real;`, and `type E = enumeration(:);`.

```typescript
private parseClassDefinition(isFinal: boolean): ClassDefinition | ShortClassDefinition | DerClassDefinition {
  const start = this.current.span.start;

  const isEncapsulated = this.match(TokenKind.Encapsulated);
  const isPartial = this.match(TokenKind.Partial);
  const isExpandable = this.match(TokenKind.Expandable);
  const isPure = this.match(TokenKind.Pure);
  const isImpure = this.match(TokenKind.Impure);

  const restriction = this.parseClassRestriction();
  const nameToken = this.expect(TokenKind.Identifier);
  const name = nameToken.value as string;

  // Three forms: long ("extends" or plain), short ("="), der ("= der(...)")
  if (this.match(TokenKind.Equals)) {
    if (this.match(TokenKind.Der)) {
      return this.parseDerClassBody(start, restriction, name, /* prefixes */ ...);
    }
    return this.parseShortClassBody(start, restriction, name, /* prefixes */ ...);
  }

  if (this.match(TokenKind.Extends)) {
    // long-class-specifier, second form
    const baseName = this.parseName();
    const baseModification = this.check(TokenKind.LParen)
      ? this.parseClassModification() : null;
    const comment = this.parseDescriptionString();
    return this.parseLongClassBody(start, restriction, name,
      { isFinal, isEncapsulated, isPartial, isExpandable, isPure, isImpure },
      { name: baseName, modification: baseModification }, comment);
  }

  // long-class-specifier, first form
  const comment = this.parseDescriptionString();
  return this.parseLongClassBody(start, restriction, name,
    { isFinal, isEncapsulated, isPartial, isExpandable, isPure, isImpure },
    null, comment);
}
```

`parseLongClassBody` factors out the body-parsing loop (interleaved public/protected sections, equation/algorithm sections, optional external declaration, optional annotation) and the `end IDENT` close. Its body is unchanged from the original document.

`parseClassRestriction` is unchanged. The `composition` body loop is unchanged.

### 2.3 Elements

```
element := import-clause | extends-clause
         | [ redeclare ] [ final ] [ inner ] [ outer ]
           ( class-definition | component-clause
           | replaceable ( class-definition | component-clause )
             [ constraining-clause description ] )
```

The body of `parseElement` is unchanged at the dispatch level — it still handles import, extends, prefix flags, and dispatches to either `parseClassDefinition` or `parseComponentClause`.

> **\[SPEC UPDATE]** — *Constraining clause on replaceable classes (item 10)*
>
> **Was:** the original document attached `constrainedBy` only to `ComponentDeclaration`.
> **Now:** the spec allows a `constraining-clause` on a `replaceable` element regardless of whether the element is a class or a component. A nested replaceable class can be followed by `constrainedby ...`.
> **Spec rule:** `element`, `constraining-clause`
> **Action:**
> - Add `constrainedBy: ConstrainedByClause | null` to `ClassDefinition` (and propagate through `ShortClassDefinition` and `DerClassDefinition`).
> - In `parseElement`, after parsing a `replaceable` class definition, check for `constrainedby` and parse the clause.
> - Add tests for `replaceable model X = Y constrainedby Z;` and `replaceable model X ... end X constrainedby Z;`.

### 2.4 Component declarations

> **\[SPEC UPDATE]** — *Multi-component declarations (item 3) and type-level array subscripts (item 4)*
>
> **Was:** the original document handled exactly one component per declaration. The variable name carried any array subscripts; there was no field for type-level array subscripts.
> **Now:** the spec defines a `component-clause` that may declare **multiple** components sharing the same type prefix and type:
> ```
> component-clause     := type-prefix type-specifier [ array-subscripts ] component-list
> component-list       := component-declaration { "," component-declaration }
> component-declaration := declaration [ condition-attribute ] description
> declaration          := IDENT [ array-subscripts ] [ modification ]
> ```
> A single source-level declaration like `parameter Real a = 1, b[3] = {1, 2, 3}, c;` produces three `ComponentDeclaration` nodes that share `parameter`, `Real`, and the (optional) type-level array subscripts.
>
> Note also that array subscripts can appear in **two places**: after the type (`Real[3] x;`) and/or after the variable name (`Real x[3];`). The parser must capture both. They have equivalent meaning when only one is present, but both are allowed and can compose: `Real[2] x[3]` declares a 3×2 matrix.
> **Spec rule:** `component-clause`, `component-list`, `component-declaration`, `declaration`
> **Action:**
> - Replace the original `parseComponentDeclaration` with a `parseComponentClause(visibility, prefixes): ComponentDeclaration[]` method that parses prefixes and the type once, then loops over comma-separated declarations.
> - `parseElement` must collect the array of `ComponentDeclaration` nodes returned by `parseComponentClause` and append them all to the parent's elements list. The shape of `parseElement`'s return type changes from `Element` to `Element | Element[]` (or, more cleanly, `parseElement` writes directly into an out-array passed in by the caller).
> - Add a `typeArraySubscripts: Expression[]` field to `ComponentDeclaration` for the type-level subscripts; rename the existing field to `nameArraySubscripts` (or keep `arraySubscripts` for the name-level form and add `typeArraySubscripts` separately — pick one and document it in the data structures doc).
> - Add tests for: `Real x, y, z;`, `parameter Real a = 1, b[3] = {1,2,3};`, `Real[3] v;`, `Real v[3];`, `Real[2] m[3];`, and combinations with conditions and string comments per declaration.

```typescript
// Returns an array because one component-clause can declare many components
private parseComponentClause(
  visibility: Visibility,
  prefixes: { isRedeclare: boolean; isFinal: boolean;
              isInner: boolean; isOuter: boolean; isReplaceable: boolean }
): ComponentDeclaration[] {
  // Type prefix (flow/stream + variability + causality)
  const isFlow   = this.match(TokenKind.Flow);
  const isStream = this.match(TokenKind.Stream);

  let variability: Variability = null;
  if      (this.match(TokenKind.Parameter)) variability = "parameter";
  else if (this.match(TokenKind.Constant))  variability = "constant";
  else if (this.match(TokenKind.Discrete))  variability = "discrete";

  let causality: Causality = null;
  if      (this.match(TokenKind.Input))  causality = "input";
  else if (this.match(TokenKind.Output)) causality = "output";

  // Shared type-specifier and shared type-level array subscripts
  const typeName = this.parseTypeSpecifier();
  const typeArraySubscripts = this.check(TokenKind.LBracket)
    ? this.parseArraySubscripts() : [];

  // component-list: at least one declaration, comma-separated
  const declarations: ComponentDeclaration[] = [];
  declarations.push(this.parseSingleComponentDeclaration(
    visibility, prefixes, isFlow, isStream, variability, causality,
    typeName, typeArraySubscripts));

  while (this.match(TokenKind.Comma)) {
    declarations.push(this.parseSingleComponentDeclaration(
      visibility, prefixes, isFlow, isStream, variability, causality,
      typeName, typeArraySubscripts));
  }

  this.expect(TokenKind.Semicolon);
  return declarations;
}

// Parses one declaration (IDENT [array-subscripts] [modification])
// followed by optional condition-attribute and description.
private parseSingleComponentDeclaration(
  visibility: Visibility,
  prefixes: { isRedeclare: boolean; isFinal: boolean;
              isInner: boolean; isOuter: boolean; isReplaceable: boolean },
  isFlow: boolean, isStream: boolean,
  variability: Variability, causality: Causality,
  typeName: ComponentReference, typeArraySubscripts: Expression[]
): ComponentDeclaration {
  const start = this.current.span.start;
  const nameToken = this.expect(TokenKind.Identifier);
  const name = nameToken.value as string;

  const nameArraySubscripts = this.check(TokenKind.LBracket)
    ? this.parseArraySubscripts() : [];

  const modification = this.check(TokenKind.LParen)
       || this.check(TokenKind.Equals)
       || this.check(TokenKind.Assign)
    ? this.parseModification() : null;

  const conditionAttribute = this.match(TokenKind.If)
    ? this.parseExpression() : null;

  const comment    = this.parseDescriptionString();
  const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;

  return {
    kind: "ComponentDeclaration",
    span: this.spanFrom(start),
    visibility, ...prefixes, isFlow, isStream,
    variability, causality, typeName,
    typeArraySubscripts, nameArraySubscripts,
    name, modification, conditionAttribute,
    constrainedBy: null, // populated by parseElement when wrapped in `replaceable ... constrainedby`
    annotation, comment,
  };
}
```

### 2.5 Modifications

> **\[SPEC UPDATE]** — *Modification grammar (items 9, 10, 11, 13)*
>
> **Was:** the original document treated `class-modification` as a list of `element-modification` only; modifications used only `=`; element modifications had no description string; binding expressions were always expressions.
> **Now:** the spec is significantly richer:
> ```
> modification           := class-modification [ "=" modification-expression ]
>                         | "=" modification-expression
>                         | ":=" modification-expression
> modification-expression := expression | break
> class-modification     := "(" [ argument-list ] ")"
> argument-list          := argument { "," argument }
> argument               := element-modification-or-replaceable | element-redeclaration
> element-modification-or-replaceable := [ each ] [ final ] ( element-modification | element-replaceable )
> element-modification   := name [ modification ] description-string
> element-redeclaration  := redeclare [ each ] [ final ]
>                           ( short-class-definition | component-clause1 | element-replaceable )
> element-replaceable    := replaceable ( short-class-definition | component-clause1 )
>                           [ constraining-clause ]
> ```
> Four substantive changes:
> 1. **`:=` form** is allowed in addition to `=`. Some tools use `:=` to indicate an assignment-style binding rather than an equation-style binding.
> 2. **`break`** is allowed as a modification-expression — used in conditional or `when` redeclaration contexts to mean "no binding".
> 3. **Class modification arguments** can be `element-modification`, `element-replaceable`, or `element-redeclaration` — not just plain modifications.
> 4. **Element modifications carry a description string** at the end (`final each x = 1 "documentation"`).
> **Spec rule:** `modification`, `class-modification`, `argument`, `element-modification`, `element-replaceable`, `element-redeclaration`
> **Action:**
> - Update `Modification` AST node:
>   - Replace `bindingExpression: Expression | null` with `binding: { kind: "equals" | "assign"; value: Expression | "break" } | null` (or split into two flags).
> - Update `ElementModification` AST node:
>   - Add `descriptionString: string | null`.
> - Add new AST node types: `ElementReplaceable`, `ElementRedeclaration`. Update `ClassModification.arguments` to `(ElementModification | ElementReplaceable | ElementRedeclaration)[]`.
> - Update `parseModification` to recognize `:=` as an alternative form, and to recognize `break` in the binding position.
> - Update `parseElementModification` to consume an optional description string after the inner modification.
> - Replace the body of `parseClassModification` with a new `parseArgument` dispatcher that distinguishes `redeclare ...` (→ element-redeclaration), `replaceable ...` (→ element-replaceable), and `[each] [final] name ...` (→ element-modification).
> - Add `component-clause1` parser support — a non-recursive simplified component clause used inside redeclarations and replaceables.
> - Add tests for: `(p := 1)`, `(redeclare X = Y)`, `(replaceable X = Y constrainedby Z)`, `(p = 1 "doc")`, `(p = break)`, and the `redeclare each final` combinations.

```typescript
private parseModification(): Modification {
  const start = this.current.span.start;

  const classModification = this.check(TokenKind.LParen)
    ? this.parseClassModification() : null;

  let binding: { kind: "equals" | "assign"; value: Expression | "break" } | null = null;
  if (this.match(TokenKind.Equals)) {
    binding = { kind: "equals", value: this.parseModificationExpression() };
  } else if (this.match(TokenKind.Assign)) {
    binding = { kind: "assign", value: this.parseModificationExpression() };
  }

  return { kind: "Modification", span: this.spanFrom(start), classModification, binding };
}

private parseModificationExpression(): Expression | "break" {
  if (this.match(TokenKind.Break)) return "break";
  return this.parseExpression();
}

private parseClassModification(): ClassModification {
  const start = this.current.span.start;
  this.expect(TokenKind.LParen);

  const args: (ElementModification | ElementReplaceable | ElementRedeclaration)[] = [];
  if (!this.check(TokenKind.RParen)) {
    args.push(this.parseArgument());
    while (this.match(TokenKind.Comma)) {
      if (this.check(TokenKind.RParen)) break;
      args.push(this.parseArgument());
    }
  }

  this.expect(TokenKind.RParen);
  return { kind: "ClassModification", span: this.spanFrom(start), arguments: args };
}

private parseArgument(): ElementModification | ElementReplaceable | ElementRedeclaration {
  // element-redeclaration starts with 'redeclare'
  if (this.match(TokenKind.Redeclare)) {
    return this.parseElementRedeclaration(/* start, after consuming 'redeclare' */);
  }

  // element-modification-or-replaceable: [each] [final] (element-modification | element-replaceable)
  const isEach  = this.match(TokenKind.Each);
  const isFinal = this.match(TokenKind.Final);

  if (this.match(TokenKind.Replaceable)) {
    return this.parseElementReplaceable(isEach, isFinal /*, start */);
  }

  return this.parseElementModification(isEach, isFinal);
}

private parseElementModification(isEach: boolean, isFinal: boolean): ElementModification {
  const start = this.current.span.start;
  const name = this.parseName(); // not parseComponentReference — names in modifications cannot have subscripts
  const modification = this.check(TokenKind.LParen)
       || this.check(TokenKind.Equals)
       || this.check(TokenKind.Assign)
    ? this.parseModification() : null;
  const descriptionString = this.parseDescriptionString();

  return {
    kind: "ElementModification",
    span: this.spanFrom(start),
    isFinal, isEach, name, modification, descriptionString,
  };
}
```

### 2.6 Equation sections

`parseEquationSection` and `isSectionEnd` are unchanged from the original document.

### 2.7 Individual equations

The five equation forms (connect, if, for, when, simple-or-function-call) are unchanged at the dispatch level. The function-call-vs-simple disambiguation is unchanged.

> **\[SPEC UPDATE]** — *Equation LHS uses `simple-expression`, not full `expression` (acceptable looseness)*
>
> The spec defines an equation as `( simple-expression "=" expression | ... )` — the LHS is a `simple-expression` (no `if-then-else`), the RHS is a full `expression`. The parser parses both with `parseExpression()` for simplicity, which accepts a strict superset. **No change required**, but tests should not assume the parser rejects an `if`-expression on the LHS.

The for-iterator parser must change slightly: the spec's `for-index` makes the `in` clause optional only inside function arguments and array comprehensions, but it is required inside for-equations. The original document's `parseForIterator` treats `in` as always optional, which is acceptably loose. No change required.

### 2.8 Statement parsing

The five statement forms are unchanged at the dispatch level. The break/return forms and the if/for/while/when statement parsers are unchanged.

> **\[SPEC UPDATE]** — *Tuple assignment RHS must be a function call (item 8) and may have empty positions (item 15)*
>
> **Was:** `parseTupleAssignment` parsed an arbitrary expression on the RHS and parsed every comma-separated component reference unconditionally on the LHS.
> **Now:** the spec rule is:
> ```
> ( "(" output-expression-list ")" ":=" component-reference function-call-args ) description
> output-expression-list := [ expression ] { "," [ expression ] }
> ```
> The RHS must be a `component-reference` followed by `function-call-args` — i.e., a function call, not an arbitrary expression. And the LHS `output-expression-list` allows **empty positions**: `(a, , c) := f(x)` is valid and means "ignore the second return value".
> **Spec rule:** `statement`, `output-expression-list`
> **Action:**
> - Change `parseTupleAssignment` to allow empty positions in the comma-separated list. The AST should distinguish present components from skipped positions — represent each slot as `ComponentReference | null`.
> - Update `TupleTarget.components` to `(ComponentReference | null)[]`.
> - On the RHS, after `:=`, parse a `component-reference` followed by `function-call-args`, building a `FunctionCallExpr` directly (not a generic `parseExpression()` call).
> - Add tests for: `(a, b) := f(x);`, `(a, , c) := f(x);`, `(, , c) := f(x);`. Also a negative test that `(a, b) := x + 1;` produces a parse error (RHS must be a function call).

```typescript
private parseTupleAssignment(start: SourceLocation): AssignmentStatement {
  this.expect(TokenKind.LParen);
  const components: (ComponentReference | null)[] = [];

  // First slot — may be empty
  if (this.check(TokenKind.Comma) || this.check(TokenKind.RParen)) {
    components.push(null);
  } else {
    components.push(this.parseComponentReference());
  }

  while (this.match(TokenKind.Comma)) {
    if (this.check(TokenKind.Comma) || this.check(TokenKind.RParen)) {
      components.push(null);
    } else {
      components.push(this.parseComponentReference());
    }
  }

  this.expect(TokenKind.RParen);
  this.expect(TokenKind.Assign);

  // RHS must be a function call: component-reference function-call-args
  const fnName = this.parseComponentReference();
  if (!this.check(TokenKind.LParen)) {
    throw this.error("Right-hand side of tuple assignment must be a function call");
  }
  const args = this.parseFunctionArguments();
  const value: FunctionCallExpr = {
    kind: "FunctionCallExpr",
    span: this.spanFrom(start), // refine as needed
    name: fnName, args,
  };

  return {
    kind: "AssignmentStatement",
    span: this.spanFrom(start),
    target: { components },
    value,
  };
}
```

### 2.9 Component references and names

The spec distinguishes two related rules:

```
name              := IDENT { "." IDENT }
component-reference := [ "." ] IDENT [ array-subscripts ]
                       { "." IDENT [ array-subscripts ] }
type-specifier    := [ "." ] name
```

`parseComponentReference` is unchanged from the original document. A new helper `parseName` is added for contexts that require the more restricted `name` form (within clauses, modification names, type names in extends clauses). Internally it can still call `parseComponentReference` and assert that no subscripts appear, or it can be implemented separately.

> **\[SPEC UPDATE]** — *`type-specifier` parsing (acceptable looseness, with helper)*
>
> The original document uses `parseComponentReference` everywhere a type name is needed. The spec's `type-specifier` is `["."] name`, which has no array subscripts at any level. The parser will continue to use `parseComponentReference` (renaming uses to a thin wrapper `parseTypeSpecifier`), since component-reference is a strict superset and no valid Modelica is rejected. **No required change** — `parseTypeSpecifier` is just an alias for clarity at call sites.

### 2.10 Annotations and string comments

```typescript
private parseAnnotation(): Annotation {
  const start = this.current.span.start;
  this.expect(TokenKind.Annotation);
  const classModification = this.parseClassModification();
  return { kind: "Annotation", span: this.spanFrom(start), classModification };
}
```

> **\[SPEC UPDATE]** — *Description-string concatenation with `+` (item 14)*
>
> **Was:** `parseOptionalStringComment` returned the value of a single string literal token.
> **Now:** the spec defines:
> ```
> description-string := [ STRING { "+" STRING } ]
> ```
> Multiple string literals joined by `+` form a single description string. Example: `"line one " + "line two"` is one description string.
> **Spec rule:** `description-string`
> **Action:**
> - Rename `parseOptionalStringComment` to `parseDescriptionString` (per spec terminology).
> - After the first string literal, loop: while the next token is `+` *and* the token after `+` is a string literal, consume both and concatenate. The two-token check is required to avoid mis-consuming a `+` that begins an expression.
> - Add tests for: `"a"`, `"a" + "b"`, `"a" + "b" + "c"`, and the boundary case where `+` is followed by a non-string (must not consume the `+`).

```typescript
private parseDescriptionString(): string | null {
  if (!this.check(TokenKind.StringLiteral)) return null;
  let result = this.advance().value as string;
  // Concatenation: STRING { "+" STRING }
  while (this.check(TokenKind.Plus) && this.peekNextIs(TokenKind.StringLiteral)) {
    this.advance(); // consume '+'
    result += this.advance().value as string;
  }
  return result;
}
```

---

## 3. Pratt (Precedence Climbing) Parser for Expressions

### 3.1 The core idea

Each infix operator has a **left binding power** and a **right binding power**. The parser tracks a minimum binding power (`minBP`) and stops collecting infix operators when the next operator's left BP is less than `minBP`. The right BP of a consumed operator becomes the `minBP` for the recursive right-operand parse.

- **Left-associative:** `right = left + 1` — `a + b + c` parses as `(a + b) + c`.
- **Non-associative:** also `right = left + 1` — `a < b < c` is rejected, which is the correct Modelica behavior.

> **\[SPEC UPDATE]** — *No right-associative operators in Modelica 3.6 (related to item 1)*
>
> The original document described `^` as right-associative, requiring the `right = left - 1` convention. Per the spec grammar, **Modelica 3.6 has no right-associative operators**. All infix operators in the spec are either left-associative or non-associative. The `right = left - 1` convention is no longer needed and should be removed from the parser to avoid future confusion.

### 3.2 Precedence table

> **\[SPEC UPDATE]** — *Power is non-associative, unary `+`/`-` is at addition level (items 1 and 2)*
>
> **Was:** the original precedence table placed `^`/`.^` as **right-associative** at the top of the table, and unary `+`/`-` as a **separate prefix level between multiplication and power** (so `-a*b` parsed as `(-a)*b`).
> **Now:** the spec grammar is:
> ```
> arithmetic-expression := [ add-operator ] term { add-operator term }
> term                  := factor { mul-operator factor }
> factor                := primary [ ("^" | ".^") primary ]
> ```
> Two consequences:
> 1. **`^` and `.^` are non-associative.** Only one optional `^` per factor. `a ^ b ^ c` is a syntax error per the spec.
> 2. **Unary `+`/`-` sits at the same level as binary `+`/`-`** — it is the optional `[ add-operator ]` at the start of an arithmetic-expression. So `-a*b` is `-(a*b)`, not `(-a)*b`. (Numerically equivalent for reals, but the AST shape differs and tests must check the spec-conforming shape.)
> **Spec rule:** `factor`, `arithmetic-expression`
> **Action:**
> - Update the precedence table (below) and the `BP` const enum: remove `BP.UnarySign`.
> - Change the `^`/`.^` entry in `infixBindingPower` to `right = left + 1` (non-associative).
> - In the prefix-half handler for unary `+`/`-`, parse the operand at `BP.Multiplication` (so it absorbs `*`, `/`, `^` but not `+`, `-`). This produces `-a*b` → `-(a*b)`.
> - Update tests:
>   - `a ^ b ^ c` must now produce a **parse error**, not `a ^ (b ^ c)`.
>   - `-a*b` must now produce `Neg(Mul(a, b))`, not `Mul(Neg(a), b)`.
>   - `-a^b` still produces `Neg(Pow(a, b))` (unchanged in shape — `^` was already inside the unary in both versions).

The corrected precedence table:

| Level | Operators | Associativity |
|---|---|---|
| 1 | `or` | left |
| 2 | `and` | left |
| 3 | `not` | prefix (one per logical-factor) |
| 4 | `<`, `<=`, `>`, `>=`, `==`, `<>` | non-associative |
| 5 | unary `+`/`-`, binary `+`, `-`, `.+`, `.-` | left (binary); prefix (unary) at same level |
| 6 | `*`, `/`, `.*`, `./` | left |
| 7 | `^`, `.^` | non-associative |

```typescript
const enum BP {
  None           = 0,
  Or             = 2,
  And            = 4,
  Not            = 6,
  Comparison     = 8,
  Addition       = 10,
  Multiplication = 12,
  Power          = 14,
}

private infixBindingPower(kind: TokenKind): { left: number; right: number } | null {
  switch (kind) {
    case TokenKind.Or:
      return { left: BP.Or, right: BP.Or + 1 };
    case TokenKind.And:
      return { left: BP.And, right: BP.And + 1 };
    case TokenKind.LessThan:
    case TokenKind.LessEqual:
    case TokenKind.GreaterThan:
    case TokenKind.GreaterEqual:
    case TokenKind.EqualEqual:
    case TokenKind.NotEqual:
      return { left: BP.Comparison, right: BP.Comparison + 1 };
    case TokenKind.Plus:
    case TokenKind.Minus:
    case TokenKind.DotPlus:
    case TokenKind.DotMinus:
      return { left: BP.Addition, right: BP.Addition + 1 };
    case TokenKind.Star:
    case TokenKind.Slash:
    case TokenKind.DotStar:
    case TokenKind.DotSlash:
      return { left: BP.Multiplication, right: BP.Multiplication + 1 };
    case TokenKind.Power:
    case TokenKind.DotPower:
      return { left: BP.Power, right: BP.Power + 1 }; // non-associative per spec
    default:
      return null;
  }
}
```

### 3.3 The parsing function

> **\[SPEC UPDATE]** — *Unary sign operand parses at `BP.Multiplication` (item 2)*
>
> The prefix-half handler for unary `+` and `-` must parse its operand at `BP.Multiplication` instead of the removed `BP.UnarySign`. This makes the unary sign consume a `term` (in spec terms) — i.e., absorb `*`, `/`, `^`, but not `+`, `-`.

> **\[SPEC UPDATE]** — *`initial` and `pure` as primary function-call prefixes (item 7)*
>
> **Was:** the original prefix-half handler dispatched on `Identifier`, `Dot`, and `Der` for component-reference-or-function-call.
> **Now:** the spec's `primary` rule allows four prefixes for a function-call form:
> ```
> ( component-reference | der | initial | pure ) function-call-args
> ```
> So `initial()` and `pure(f(x))` are valid primary expressions where `initial` and `pure` are special tokens (not identifiers and not component references). They behave like `der` does — parse as a function call with the keyword token forming the head.
> **Spec rule:** `primary`
> **Action:**
> - In the prefix-half handler, add cases for `TokenKind.Initial` and `TokenKind.Pure` that consume the token and require a following `(` to parse function-call-args, building a `FunctionCallExpr` whose name is a synthetic single-part component reference `{ name: "initial" | "pure", subscripts: [] }`.
> - Add tests for: `initial()`, `pure(f(x))`, and (negative) `initial` without `(` as an expression error.

> **\[SPEC UPDATE]** — *Array constructors with `for` comprehensions (item 16)*
>
> **Was:** `parseArrayConstruct` was referenced but its body was not specified in detail; the original document did not call out the `for` form.
> **Now:** the spec rule is:
> ```
> array-arguments := expression [ "," array-arguments-non-first | for for-indices ]
> ```
> A `{...}` array constructor can take the form `{expr for i in range}` (an array comprehension), e.g. `{i*2 for i in 1:N}`.
> **Spec rule:** `array-arguments`
> **Action:**
> - In `parseArrayConstruct`, after parsing the first expression, check for `for`. If present, parse `for-indices` and produce an `ArrayConstructExpr` with a `forIterators` field set. Otherwise parse the comma-separated expression list as before.
> - Add a `forIterators: ForIterator[] | null` field to `ArrayConstructExpr`.
> - Add tests for: `{1, 2, 3}`, `{i*2 for i in 1:N}`, `{i+j for i in 1:N, j in 1:M}`.

```typescript
private parseExpression(minBP: number = BP.None): Expression {
  const start = this.current.span.start;
  let left: Expression;

  // --- Prefix / atom half ---
  if (this.match(TokenKind.IntegerLiteral)) {
    left = { kind: "IntegerLiteral", span: this.spanFrom(start),
             value: this.previous.value as number };
  } else if (this.match(TokenKind.RealLiteral)) {
    left = { kind: "RealLiteral", span: this.spanFrom(start),
             value: this.previous.value as number };
  } else if (this.match(TokenKind.StringLiteral)) {
    left = { kind: "StringLiteral", span: this.spanFrom(start),
             value: this.previous.value as string };
  } else if (this.match(TokenKind.BooleanLiteral)) {
    left = { kind: "BooleanLiteral", span: this.spanFrom(start),
             value: this.previous.value as boolean };
  } else if (this.match(TokenKind.Not)) {
    const operand = this.parseExpression(BP.Comparison);
    left = { kind: "UnaryExpr", span: this.spanFrom(start), op: "not", operand };
  } else if (this.check(TokenKind.Minus) || this.check(TokenKind.Plus)) {
    // Unary +/- — operand parsed at multiplication level per spec
    const op = this.advance().kind === TokenKind.Minus ? "-" : "+";
    const operand = this.parseExpression(BP.Multiplication);
    left = { kind: "UnaryExpr", span: this.spanFrom(start), op: op as UnaryOp, operand };
  } else if (this.match(TokenKind.LParen)) {
    left = this.parseExpression();
    this.expect(TokenKind.RParen);
  } else if (this.match(TokenKind.LBrace)) {
    left = this.parseArrayConstruct(start);
  } else if (this.match(TokenKind.LBracket)) {
    left = this.parseArrayConcat(start);
  } else if (this.match(TokenKind.If)) {
    left = this.parseIfExpression(start);
  } else if (this.match(TokenKind.End)) {
    left = { kind: "EndExpr", span: this.spanFrom(start) };
  } else if (this.check(TokenKind.Initial) || this.check(TokenKind.Pure)) {
    // Spec: ( initial | pure ) function-call-args
    const keyword = this.advance().kind === TokenKind.Initial ? "initial" : "pure";
    const args = this.parseFunctionArguments();
    left = {
      kind: "FunctionCallExpr",
      span: this.spanFrom(start),
      name: { isGlobal: false, parts: [{ name: keyword, subscripts: [] }] },
      args,
    };
  } else if (this.check(TokenKind.Identifier) || this.check(TokenKind.Dot)
             || this.check(TokenKind.Der)) {
    left = this.parseComponentReferenceOrFunctionCall(start);
  } else {
    throw this.error(`Unexpected token in expression: ${TokenKind[this.current.kind]}`);
  }

  // --- Infix loop ---
  while (true) {
    const bp = this.infixBindingPower(this.current.kind);
    if (bp === null || bp.left < minBP) break;

    const opToken = this.advance();
    const op      = this.tokenToOp(opToken);
    const right   = this.parseExpression(bp.right);
    left = { kind: "BinaryExpr", span: this.spanFrom(start), op, left, right };
  }

  return left;
}
```

### 3.4 Component references and function calls

`parseComponentReferenceOrFunctionCall` is unchanged from the original document. `der(x)` continues to fall out as a function call because the lexer produces a `Der` keyword token that the component-reference parser accepts as the first part of a name.

### 3.5 Range expressions

Range expressions are handled by `parseExpressionOrRange` outside the Pratt loop, in contexts where ranges are expected. Unchanged from the original document.

### 3.6 Function arguments

> **\[SPEC UPDATE]** — *`function`-partial-application (item 17)*
>
> **Was:** `parseFunctionArguments` recognized positional, named, and `for`-comprehension arguments.
> **Now:** the spec adds a fourth form, `function-partial-application`, which lets a function be passed as an argument with some parameters bound:
> ```
> function-arguments := expression [ "," function-arguments-non-first | for for-indices ]
>                     | function-partial-application [ "," function-arguments-non-first ]
>                     | named-arguments
> function-partial-application := function type-specifier "(" [ named-arguments ] ")"
> ```
> A function-partial-application appears at any positional argument slot. Example: `Modelica.Math.Nonlinear.solveOneNonlinearEquation(function f(p = 1), 0, 1)`.
> **Spec rule:** `function-arguments`, `function-partial-application`
> **Action:**
> - Add a new expression AST node: `FunctionPartialApplicationExpr { kind: "FunctionPartialApplicationExpr"; span: Span; functionName: ComponentReference; namedArguments: { name: string; value: Expression }[] }`.
> - In `parseFunctionArguments`, when the current token is `function`, parse `function type-specifier "(" [ named-arguments ] ")"` and produce the new node. The result occupies a positional slot.
> - Update `FunctionArguments` type to allow the new expression as a positional argument (it is just an `Expression`, so it already fits if added to the `Expression` union).
> - Add tests for: `f(function g())`, `f(function g(x = 1))`, `f(function g(x = 1, y = 2), 0, 1)`.

> **\[SPEC UPDATE]** — *Note on `function-arguments-non-first` ordering*
>
> The spec's `function-arguments-non-first` rule means that once a named argument appears in the argument list, only named arguments may follow. The original parser's `parseFunctionArgumentList` should enforce this. Tests should cover: `f(1, 2, x = 3, y = 4)` (valid), `f(x = 1, 2)` (invalid — positional after named).

### 3.7 If-expression and `tokenToOp`

Unchanged from the original document.

---

## 4. Error Reporting and Recovery

Sections 4.1 (error reporting), 4.2 (panic mode), 4.3 (recovery as a future improvement), and 4.4 (expected-token sets) are unchanged from the original document. The new error cases introduced by the spec-conformance updates above (e.g., "right-hand side of tuple assignment must be a function call", `a ^ b ^ c` being a syntax error) use the same `error()` helper and are reported in the same `file:line:col: message` format.

---

## 5. Acceptable Looseness — Where the Parser Is More Permissive Than the Spec

These are the cases where the parser deliberately accepts a strict superset of valid Modelica. They are not bugs and require no implementation changes; they are listed here so future readers do not mistake them for spec divergences.

1. **Function-call equation LHS** — the spec says `component-reference function-call-args`; the parser parses an arbitrary expression and checks `lhs.kind === "FunctionCallExpr"`. Accepts everything valid plus some malformed inputs that produce confusing errors.
2. **Equation LHS allows `if`-expression** — the spec restricts LHS to `simple-expression`; the parser uses `parseExpression()`. No valid Modelica is rejected.
3. **`type-specifier` parsed via `parseComponentReference`** — the spec's `type-specifier` is `["."] name` with no array subscripts; the parser allows the more general form via a thin `parseTypeSpecifier` wrapper around `parseComponentReference`. No valid Modelica is rejected.
4. **For-iterator `in` clause** — the spec requires `in` inside for-equations and for-statements but allows it to be omitted inside function arguments and array comprehensions. The parser treats `in` as always optional. No valid Modelica is rejected.

---

## 6. Update Summary for Test Plan, Tests, and Implementation

The following is a consolidated checklist derived from the `[SPEC UPDATE]` callouts above. Every item must be addressed in the test plan, tests, and implementation.

### Data structure changes

- `ClassDefinition`: add `extending: { name; modification } | null`, add `constrainedBy: ConstrainedByClause | null`.
- `ShortClassDefinition`: add `basePrefix: { isInput; isOutput }`, add `isOpen: boolean` for `enumeration(:)`.
- New AST node: `DerClassDefinition` (or `ShortClassDefinition.derInfo`).
- `ComponentDeclaration`: add `typeArraySubscripts: Expression[]`; rename existing `arraySubscripts` to `nameArraySubscripts` (or document the convention).
- `Modification`: replace `bindingExpression` with a binding object that distinguishes `=` vs `:=` and supports `break`.
- `ElementModification`: add `descriptionString: string | null`.
- `ClassModification.arguments`: change to `(ElementModification | ElementReplaceable | ElementRedeclaration)[]`.
- New AST nodes: `ElementReplaceable`, `ElementRedeclaration`.
- `ArrayConstructExpr`: add `forIterators: ForIterator[] | null`.
- `TupleTarget.components`: change to `(ComponentReference | null)[]` to allow empty positions.
- New AST node: `FunctionPartialApplicationExpr` (added to the `Expression` union).

### Parser logic changes

- `parseClassDefinition`: detect three forms (long, long-with-extends, short, der), dispatch accordingly.
- `parseShortClassBody`: consume optional `input`/`output` `base-prefix`; recognize `enumeration(:)`.
- New `parseDerClassBody` method.
- `parseComponentClause` returns `ComponentDeclaration[]`; `parseElement` collects them all into the parent's elements list.
- `parseSingleComponentDeclaration` accepts shared type/prefix parameters.
- `parseElement`: when wrapping a `replaceable` class definition, attach `constrainedBy` to the class node.
- `parseModification`: accept `:=` form; recognize `break` as binding value.
- `parseClassModification`: dispatch arguments via new `parseArgument` (element-modification, element-replaceable, element-redeclaration).
- `parseElementModification`: consume trailing description-string.
- New methods: `parseElementReplaceable`, `parseElementRedeclaration`, and a `parseComponentClause1` for non-recursive component clauses inside redeclarations.
- `parseTupleAssignment`: allow empty positions; require function call on RHS.
- `parseDescriptionString` (renamed from `parseOptionalStringComment`): support `STRING { "+" STRING }` concatenation.
- Pratt parser: remove `BP.UnarySign`; unary `+`/`-` operand parses at `BP.Multiplication`; `^`/`.^` is non-associative (`right = left + 1`).
- `parseExpression` prefix half: add cases for `Initial` and `Pure` producing function calls.
- `parseArrayConstruct`: support `for`-comprehension form.
- `parseFunctionArguments`: support `function-partial-application` form; enforce that no positional argument follows a named argument.

### New tests required

The conformance items above each list specific test cases. At minimum, the test plan must add:

1. Power non-associativity: `a ^ b ^ c` rejected; `a ^ b` accepted.
2. Unary precedence: `-a*b` produces `Neg(Mul(a, b))`.
3. Multi-component declarations: `Real x, y, z;`, `parameter Real a = 1, b[3] = {1,2,3};`.
4. Type-level array subscripts: `Real[3] x;`, `Real[2] m[3];`.
5. Long class with `extends`: `model X extends Y(p = 1); ... end X;`.
6. `der`-class-specifier: `function df = der(f, x);`.
7. `initial()` and `pure(f(x))` as primaries.
8. Tuple assignment: `(a, , c) := f(x);` (and reject `(a, b) := x + 1;`).
9. Modification arguments: `replaceable`, `redeclare`, with `each`/`final` combinations.
10. Element modification description strings: `(p = 1 "doc")`.
11. Modification `break`: `(p = break)`.
12. Short class `base-prefix`: `type T = input Real;`.
13. Modification `:=`: `(p := 1)`.
14. Description string concatenation: `"a" + "b"`.
15. Tuple-target empty positions covered in item 8.
16. Array comprehensions: `{i*2 for i in 1:N}`.
17. `function`-partial-application: `f(function g(x = 1))`.
