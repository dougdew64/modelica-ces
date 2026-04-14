# Phase 1, Subphase 1: Data Structures

The base data structures for the syntactic parsing phase are described in Part 1 of the phase document:

**[phase1-syntactic-parsing.md — Part 1: Data Structures](../phase1-syntactic-parsing.md)**

That document covers:
- Source location and span types (`SourceLocation`, `Span`)
- Token kinds (`TokenKind` enum) and the `Token` interface
- Keyword lookup table
- All AST node types: `StoredDefinition`, `ClassDefinition`, `ShortClassDefinition`, elements, modifications, annotations, equation sections, algorithm sections, expressions, component references, and external declarations

The base definitions are not duplicated here. This document records the **deltas** that the data structures need on top of the base definitions in order to match the spec-conformance updates made to the parser design document on 2026-04-13.

---

## Spec Conformance Update — 2026-04-13

The parser design document [phase1-subphase3-parser.md](../subphase3-parser/phase1-subphase3-parser.md) was revised to bring it into complete agreement with the [Modelica 3.6 Concrete Syntax (Appendix A.2)](https://specification.modelica.org/maint/3.6/modelica-concrete-syntax.html). Seventeen spec-conformance items were addressed there. Most of them require changes to the AST data structures.

This section records every required data-structure change. Each change is marked with a `[SPEC UPDATE]` callout in the same style as the parser document, so the test plan, tests, and existing implementation can be revised in lockstep. Search for `[SPEC UPDATE]` to find every change.

The corresponding parser change is referenced by item number from the parser document's conformance change index (parser items 1–17).

---

## 1. Modified AST Node Types

### 1.1 `ClassDefinition`

> **\[SPEC UPDATE]** — *Long class specifier with `extends` form (parser item 5)*
>
> **Was:** `ClassDefinition` had no field for the second form of `long-class-specifier`.
> **Now:** the spec defines:
> ```
> long-class-specifier :=
>     IDENT description-string composition end IDENT
>   | extends IDENT [ class-modification ] description-string composition end IDENT
> ```
> The "extending class" form (`model X extends Y(p = 1) ... end X;`) needs explicit AST representation.
> **Action:** add an `extending` field to `ClassDefinition`:
> ```typescript
> interface ClassDefinition {
>   // ... existing fields ...
>   extending: {
>     name: ComponentReference;
>     modification: ClassModification | null;
>   } | null;
> }
> ```
> The field is `null` for the plain form and populated for the `extends` form. The `name` field uses `ComponentReference` for parser convenience even though the spec says `name`; this is acceptable looseness (see parser §5).

> **\[SPEC UPDATE]** — *Constraining clause on replaceable classes (parser item 10)*
>
> **Was:** `constrainedBy` was attached only to `ComponentDeclaration`.
> **Now:** the spec allows `constrainedby` on any `replaceable` element, including a class definition. A nested replaceable class can carry a constraining clause.
> **Action:** add `constrainedBy: ConstrainedByClause | null` to `ClassDefinition`. Set to `null` unless the class was wrapped in `replaceable ... constrainedby ...` at the element level.
> ```typescript
> interface ClassDefinition {
>   // ... existing fields ...
>   constrainedBy: ConstrainedByClause | null;
> }
> ```

### 1.2 `ShortClassDefinition`

> **\[SPEC UPDATE]** — *Short class specifier `base-prefix` and open enumeration (parser item 12)*
>
> **Was:** `ShortClassDefinition` did not record the `base-prefix` (input/output) that can appear before the type-specifier in a short class specifier, and had no representation for `enumeration(:)`.
> **Now:** the spec rule is:
> ```
> short-class-specifier :=
>     IDENT "=" base-prefix type-specifier [ array-subscripts ]
>     [ class-modification ] description
>   | IDENT "=" enumeration "(" ( [ enum-list ] | ":" ) ")" description
> base-prefix := [ input | output ]
> ```
> **Action:** add two fields to `ShortClassDefinition`:
> ```typescript
> interface ShortClassDefinition {
>   // ... existing fields ...
>   basePrefix: { isInput: boolean; isOutput: boolean };  // both false when neither was present
>   isOpen: boolean;  // true for "enumeration(:)" (open enumeration); false otherwise
> }
> ```
> The existing `enumeration: EnumerationLiteral[] | null` field continues to hold the literal list for the closed form. When `isOpen` is true, `enumeration` should be `null` and `baseType` should also be `null`.

### 1.3 `ComponentDeclaration`

> **\[SPEC UPDATE]** — *Multi-component declarations and type-level array subscripts (parser items 3 and 4)*
>
> **Was:** `ComponentDeclaration` had a single `arraySubscripts` field that held the variable-name's subscripts. There was no representation for type-level array subscripts (`Real[3] x;`).
> **Now:** the spec's `component-clause` allows array subscripts in two places:
> ```
> component-clause     := type-prefix type-specifier [ array-subscripts ] component-list
> declaration          := IDENT [ array-subscripts ] [ modification ]
> ```
> Both can be present and they compose: `Real[2] m[3]` is a 3-element array of `Real[2]` (a 3×2 matrix).
> **Action:** rename the existing `arraySubscripts` field to `nameArraySubscripts` and add a new `typeArraySubscripts` field:
> ```typescript
> interface ComponentDeclaration {
>   // ... existing fields ...
>   typeArraySubscripts: Expression[];   // empty if absent — the [N] in "Real[N] x"
>   nameArraySubscripts: Expression[];   // empty if absent — the [N] in "Real x[N]"
> }
> ```
> Note that one `component-clause` produces multiple `ComponentDeclaration` nodes (one per name in the comma-separated `component-list`). Each generated node shares the same `typeName`, `typeArraySubscripts`, and type prefixes (visibility, flow/stream, variability, causality, redeclare/final/inner/outer/replaceable). Each has its own `name`, `nameArraySubscripts`, `modification`, `conditionAttribute`, `comment`, and `annotation`.

### 1.4 `Modification`

> **\[SPEC UPDATE]** — *`:=` binding form and `break` modification expression (parser items 11 and 13)*
>
> **Was:** `Modification` had a single `bindingExpression: Expression | null` field. It could not distinguish `=` from `:=`, and could not represent `break` as a binding.
> **Now:** the spec rule is:
> ```
> modification           := class-modification [ "=" modification-expression ]
>                         | "=" modification-expression
>                         | ":=" modification-expression
> modification-expression := expression | break
> ```
> **Action:** replace `bindingExpression` with a structured `binding` field:
> ```typescript
> interface Modification {
>   kind: "Modification";
>   span: Span;
>   classModification: ClassModification | null;
>   binding: {
>     kind: "equals" | "assign";        // "=" vs ":="
>     value: Expression | "break";       // the literal string "break" represents the break form
>   } | null;
> }
> ```
> Using the literal string `"break"` keeps the discriminator simple and avoids introducing a dedicated `BreakBinding` node type. Implementations that prefer a tagged variant can use `{ isBreak: true } | { isBreak: false; expression: Expression }` instead — pick one and document it.

### 1.5 `ElementModification`

> **\[SPEC UPDATE]** — *Element modifications carry a description string (parser item 10 in the modification group)*
>
> **Was:** `ElementModification` had no field for the trailing description string.
> **Now:** the spec rule is `element-modification := name [ modification ] description-string`. A description string can follow the modification: `(p = 1 "documentation")`.
> **Action:** add `descriptionString: string | null` to `ElementModification`:
> ```typescript
> interface ElementModification {
>   kind: "ElementModification";
>   span: Span;
>   isFinal: boolean;
>   isEach: boolean;
>   name: ComponentReference;
>   modification: Modification | null;
>   descriptionString: string | null;   // NEW
> }
> ```

### 1.6 `ClassModification`

> **\[SPEC UPDATE]** — *Argument list union: element-modification, element-replaceable, element-redeclaration (parser item 9)*
>
> **Was:** `ClassModification.arguments` was typed as `ElementModification[]`.
> **Now:** the spec defines:
> ```
> argument := element-modification-or-replaceable | element-redeclaration
> element-modification-or-replaceable := [ each ] [ final ] ( element-modification | element-replaceable )
> element-redeclaration := redeclare [ each ] [ final ]
>                         ( short-class-definition | component-clause1 | element-replaceable )
> element-replaceable   := replaceable ( short-class-definition | component-clause1 )
>                         [ constraining-clause ]
> ```
> An argument can be one of three things, not just an element-modification.
> **Action:** widen the `arguments` field type:
> ```typescript
> interface ClassModification {
>   kind: "ClassModification";
>   span: Span;
>   arguments: (ElementModification | ElementReplaceable | ElementRedeclaration)[];
> }
> ```
> Two new node types (`ElementReplaceable`, `ElementRedeclaration`) are defined in §2 below.

### 1.7 `ArrayConstructExpr`

> **\[SPEC UPDATE]** — *Array constructors with `for`-comprehension (parser item 16)*
>
> **Was:** `ArrayConstructExpr` had only `elements: Expression[]`.
> **Now:** the spec allows `array-arguments := expression [ "," array-arguments-non-first | for for-indices ]`. So `{i*2 for i in 1:N}` is a valid array constructor — a single seed expression followed by `for`-iterators producing the array.
> **Action:** add `forIterators: ForIterator[] | null` to `ArrayConstructExpr`:
> ```typescript
> interface ArrayConstructExpr {
>   kind: "ArrayConstructExpr";
>   span: Span;
>   elements: Expression[];               // the seed expression(s); for the comprehension form, length is 1
>   forIterators: ForIterator[] | null;   // null for the literal form; populated for the comprehension form
> }
> ```
> When `forIterators` is non-null, `elements` should contain exactly one expression (the seed expression that is evaluated for each combination of iterator values).

### 1.8 `TupleTarget`

> **\[SPEC UPDATE]** — *Output-expression-list allows empty positions (parser item 15)*
>
> **Was:** `TupleTarget.components` was typed as `ComponentReference[]`.
> **Now:** the spec rule is `output-expression-list := [ expression ] { "," [ expression ] }`. Each slot is optional. `(a, , c) := f(x)` ignores the second return value.
> **Action:** allow `null` in the components array:
> ```typescript
> interface TupleTarget {
>   components: (ComponentReference | null)[];   // null marks a skipped position
> }
> ```

---

## 2. New AST Node Types

### 2.1 `DerClassDefinition`

> **\[SPEC UPDATE]** — *`der`-class-specifier (parser item 6)*
>
> The spec defines a third class specifier form:
> ```
> der-class-specifier := IDENT "=" der "(" type-specifier "," IDENT { "," IDENT } ")" description
> ```
> Used to declare a function as the partial derivative of another, e.g. `function df = der(f, x);`.
> **Action:** add a new top-level class-definition node type:
> ```typescript
> interface DerClassDefinition {
>   kind: "DerClassDefinition";
>   span: Span;
>   restriction: ClassRestriction;        // typically "function"
>   name: string;
>   isFinal: boolean;
>   isEncapsulated: boolean;
>   isPartial: boolean;
>   isExpandable: boolean;
>   isPure: boolean;
>   isImpure: boolean;
>   baseFunction: ComponentReference;     // the function being differentiated (type-specifier)
>   withRespectTo: string[];              // the IDENT list — at least one
>   annotation: Annotation | null;
>   comment: string | null;
> }
> ```
> Implementations that prefer fewer node types can instead extend `ShortClassDefinition` with an optional `derInfo: { baseFunction: ComponentReference; withRespectTo: string[] } | null` field. Pick one approach and document it.

### 2.2 `ElementReplaceable`

> **\[SPEC UPDATE]** — *Element replaceable inside class modifications (parser item 9)*
>
> The spec rule is:
> ```
> element-replaceable := replaceable ( short-class-definition | component-clause1 )
>                       [ constraining-clause ]
> ```
> **Action:** add a new node type for use inside `ClassModification.arguments`:
> ```typescript
> interface ElementReplaceable {
>   kind: "ElementReplaceable";
>   span: Span;
>   isEach: boolean;                    // from the surrounding [each] [final] wrapper
>   isFinal: boolean;
>   element: ShortClassDefinition | ComponentClause1;
>   constrainedBy: ConstrainedByClause | null;
> }
> ```

### 2.3 `ElementRedeclaration`

> **\[SPEC UPDATE]** — *Element redeclaration inside class modifications (parser item 9)*
>
> The spec rule is:
> ```
> element-redeclaration := redeclare [ each ] [ final ]
>                         ( short-class-definition | component-clause1 | element-replaceable )
> ```
> **Action:** add a new node type:
> ```typescript
> interface ElementRedeclaration {
>   kind: "ElementRedeclaration";
>   span: Span;
>   isEach: boolean;
>   isFinal: boolean;
>   element: ShortClassDefinition | ComponentClause1 | ElementReplaceable;
> }
> ```

### 2.4 `ComponentClause1`

> **\[SPEC UPDATE]** — *Non-recursive component clause for redeclarations (parser item 9, supporting type)*
>
> The spec defines `component-clause1` as a simplified form of `component-clause` used inside redeclarations. It declares exactly one component (no comma-separated list) and excludes some prefixes that don't apply in a redeclaration context. The exact spec rule should be checked against Appendix A.2 when implementing — the parser document references it but does not quote it in full.
> **Action:** add a new node type:
> ```typescript
> interface ComponentClause1 {
>   kind: "ComponentClause1";
>   span: Span;
>   typeName: ComponentReference;
>   typeArraySubscripts: Expression[];
>   name: string;
>   nameArraySubscripts: Expression[];
>   modification: Modification | null;
>   comment: string | null;
> }
> ```
> Verify against the spec when implementing — adjust fields if `component-clause1` permits or excludes more than this.

### 2.5 `FunctionPartialApplicationExpr`

> **\[SPEC UPDATE]** — *Function partial application (parser item 17)*
>
> The spec rule is:
> ```
> function-partial-application := function type-specifier "(" [ named-arguments ] ")"
> ```
> Example: `f(function g(x = 1))`. Used to pass a function as an argument with some parameters already bound.
> **Action:** add a new expression node and include it in the `Expression` union:
> ```typescript
> interface FunctionPartialApplicationExpr {
>   kind: "FunctionPartialApplicationExpr";
>   span: Span;
>   functionName: ComponentReference;
>   namedArguments: { name: string; value: Expression }[];
> }
>
> type Expression =
>   | IntegerLiteralExpr
>   | RealLiteralExpr
>   | StringLiteralExpr
>   | BooleanLiteralExpr
>   | ComponentReferenceExpr
>   | BinaryExpr
>   | UnaryExpr
>   | IfExpr
>   | FunctionCallExpr
>   | FunctionPartialApplicationExpr   // NEW
>   | ArrayConstructExpr
>   | ArrayConcatExpr
>   | RangeExpr
>   | EndExpr
>   | ColonExpr;
> ```

---

## 3. Top-Level Union Updates

### 3.1 `StoredClassEntry.definition`

> **\[SPEC UPDATE]** — *Three class-specifier forms (parser items 5 and 6)*
>
> **Was:**
> ```typescript
> interface StoredClassEntry {
>   isFinal: boolean;
>   definition: ClassDefinition | ShortClassDefinition;
> }
> ```
> **Now:** with `DerClassDefinition` added as a new top-level form:
> ```typescript
> interface StoredClassEntry {
>   isFinal: boolean;
>   definition: ClassDefinition | ShortClassDefinition | DerClassDefinition;
> }
> ```
> The same union widening must apply to the `Element` union (where nested classes appear) and to anywhere else that currently lists `ClassDefinition | ShortClassDefinition`.

### 3.2 `Element` union

> **\[SPEC UPDATE]** — *Nested `DerClassDefinition` (parser item 6)*
>
> **Was:**
> ```typescript
> type Element =
>   | ComponentDeclaration
>   | ExtendsClause
>   | ImportClause
>   | ClassDefinition;
> ```
> **Now:** allow nested der-class-definitions:
> ```typescript
> type Element =
>   | ComponentDeclaration
>   | ExtendsClause
>   | ImportClause
>   | ClassDefinition
>   | ShortClassDefinition       // also valid as a nested element
>   | DerClassDefinition;        // NEW
> ```

---

## 4. Update Summary

A consolidated checklist of every data-structure change required by the 2026-04-13 spec-conformance update, for use when revising the test plan, tests, and existing implementation in `src/phase1/data-structures.ts`:

### Modified existing types (8)

1. `ClassDefinition` — add `extending`, add `constrainedBy`
2. `ShortClassDefinition` — add `basePrefix`, add `isOpen`
3. `ComponentDeclaration` — add `typeArraySubscripts`, rename `arraySubscripts` → `nameArraySubscripts`
4. `Modification` — replace `bindingExpression` with structured `binding`
5. `ElementModification` — add `descriptionString`
6. `ClassModification` — widen `arguments` element type
7. `ArrayConstructExpr` — add `forIterators`
8. `TupleTarget` — allow `null` slots in `components`

### New types (5)

1. `DerClassDefinition`
2. `ElementReplaceable`
3. `ElementRedeclaration`
4. `ComponentClause1`
5. `FunctionPartialApplicationExpr`

### Union updates (3)

1. `StoredClassEntry.definition` — add `DerClassDefinition`
2. `Element` — add `DerClassDefinition` (and explicitly list `ShortClassDefinition` if not already present)
3. `Expression` — add `FunctionPartialApplicationExpr`

### Cross-document consistency

When `src/phase1/data-structures.ts` is updated to match this document, the test files for the data structures phase must be updated in lockstep. The test plan for subphase 1 should add cases that exercise each new field and each new node type. The parser test plan (subphase 3) covers the parsing behavior; the data-structures test plan should cover construction, type-narrowing through `kind` discriminators, and serialization round-trips for the new shapes.
