# Phase 1: Syntactic Parsing — Implementation Details

This document describes how to implement the syntactic parsing phase of the Modelica compiler in TypeScript. It covers the lexer, the parser, and the AST data structures. The overview document describes *what* this phase does; this document describes *how to build it*. The target language version is **Modelica 3.6**.

The implementation is split into three parts that are built in order, since each depends on the previous:

1. **Token definitions and AST node types** — the data structures
2. **Lexer** — converts source text to tokens
3. **Parser** — converts tokens to AST

---

## Part 1: Data Structures

### 1.1 Source locations

Every token and AST node should carry its position in the source text. This is essential for error messages.

```typescript
interface SourceLocation {
  file: string;
  line: number;   // 1-based
  column: number; // 1-based
  offset: number; // 0-based byte offset into the source string
}

interface Span {
  start: SourceLocation;
  end: SourceLocation;
}
```

`offset` is the primary field used during lexing (it indexes into the source string). `line` and `column` are derived from `offset` for error reporting. The simplest approach is to compute line/column lazily — maintain only `offset` during lexing, and convert to line/column when producing an error message by scanning the source string for newlines up to that offset. This avoids the cost of tracking line/column on every character advance during normal (error-free) parsing.

### 1.2 Tokens

```typescript
enum TokenKind {
  // Literals
  IntegerLiteral,    // 42
  RealLiteral,       // 3.14, 1.5e-3
  StringLiteral,     // "hello"
  BooleanLiteral,    // true, false

  // Identifiers
  Identifier,        // x, myVar, Real, Integer

  // Keywords
  Algorithm,
  And,
  Annotation,
  Block,
  Break,
  Class,
  Connect,
  Connector,
  Constant,
  ConstrainedBy,
  Der,
  Discrete,
  Each,
  Else,
  ElseIf,
  ElseWhen,
  Encapsulated,
  End,
  Enumeration,
  Equation,
  Expandable,
  Extends,
  External,
  False,
  Final,
  Flow,
  For,
  Function,
  If,
  Import,
  Impure,
  In,
  Initial,
  Inner,
  Input,
  Loop,
  Model,
  Not,
  Operator,
  Or,
  Outer,
  Output,
  Package,
  Parameter,
  Partial,
  Protected,
  Public,
  Pure,
  Record,
  Redeclare,
  Replaceable,
  Return,
  Stream,
  Then,
  True,
  Type,
  When,
  While,
  Within,

  // Punctuation and operators
  LParen,            // (
  RParen,            // )
  LBracket,          // [
  RBracket,          // ]
  LBrace,            // {
  RBrace,            // }
  Dot,               // .
  Comma,             // ,
  Semicolon,         // ;
  Colon,             // :
  Equals,            // =
  Assign,            // :=
  Plus,              // +
  Minus,             // -
  Star,              // *
  Slash,             // /
  Power,             // ^
  DotPlus,           // .+
  DotMinus,          // .-
  DotStar,           // .*
  DotSlash,          // ./
  DotPower,          // .^
  LessThan,          // <
  LessEqual,         // <=
  GreaterThan,       // >
  GreaterEqual,      // >=
  EqualEqual,        // ==
  NotEqual,          // <>

  // Special
  EOF,
}

interface Token {
  kind: TokenKind;
  span: Span;
  value?: string | number | boolean;
  // For Identifier and StringLiteral: value is string
  // For IntegerLiteral: value is number (integer)
  // For RealLiteral: value is number (float)
  // For BooleanLiteral: value is boolean
  // For keywords and punctuation: value is undefined
}
```

#### Design note: `true`/`false` and `der`

`true` and `false` are Modelica keywords. The lexer produces `TokenKind.True` and `TokenKind.False` for them (with a boolean `value` field), rather than identifiers. This is a convenience — the parser would otherwise have to check for identifier tokens with text "true" or "false" in many places.

`der` is listed as a keyword token here even though the overview document notes that the parser treats `der(x)` as an ordinary function call syntactically. Making `der` a keyword at the lexer level is a pragmatic choice: it costs nothing (just one more entry in the keyword table), and it makes it trivial for later phases to identify `der` calls without string comparison. The parser still produces a regular function-call AST node for `der(x)` — the keyword token is just an optimization for pattern matching.

Alternatively, `der` can be left as an ordinary identifier and detected by name during later phases. Either approach works. The same choice applies to other built-in function names like `abs`, `sign`, `sqrt`, etc. The simpler approach is to treat them all as ordinary identifiers and only give `der` keyword status, since `der` is the only one with structural significance (it identifies state variables during equation processing).

#### Design note: `Real`, `Integer`, `Boolean`, `String`

These are **not** keywords. They are ordinary identifiers that name built-in types. The lexer produces `TokenKind.Identifier` for them. They are resolved to type meanings during flattening, not parsing. This matches the Modelica specification and avoids problems if a model uses these names in qualified paths like `Modelica.SIunits.Real`.

### 1.3 Keyword lookup

The keyword table maps identifier strings to token kinds. Build it once as a `Map<string, TokenKind>`:

```typescript
const KEYWORDS: Map<string, TokenKind> = new Map([
  ["algorithm", TokenKind.Algorithm],
  ["and", TokenKind.And],
  ["annotation", TokenKind.Annotation],
  ["block", TokenKind.Block],
  ["break", TokenKind.Break],
  ["class", TokenKind.Class],
  ["connect", TokenKind.Connect],
  ["connector", TokenKind.Connector],
  ["constant", TokenKind.Constant],
  ["constrainedby", TokenKind.ConstrainedBy],
  ["der", TokenKind.Der],
  ["discrete", TokenKind.Discrete],
  ["each", TokenKind.Each],
  ["else", TokenKind.Else],
  ["elseif", TokenKind.ElseIf],
  ["elsewhen", TokenKind.ElseWhen],
  ["encapsulated", TokenKind.Encapsulated],
  ["end", TokenKind.End],
  ["enumeration", TokenKind.Enumeration],
  ["equation", TokenKind.Equation],
  ["expandable", TokenKind.Expandable],
  ["extends", TokenKind.Extends],
  ["external", TokenKind.External],
  ["false", TokenKind.False],
  ["final", TokenKind.Final],
  ["flow", TokenKind.Flow],
  ["for", TokenKind.For],
  ["function", TokenKind.Function],
  ["if", TokenKind.If],
  ["import", TokenKind.Import],
  ["impure", TokenKind.Impure],
  ["in", TokenKind.In],
  ["initial", TokenKind.Initial],
  ["inner", TokenKind.Inner],
  ["input", TokenKind.Input],
  ["loop", TokenKind.Loop],
  ["model", TokenKind.Model],
  ["not", TokenKind.Not],
  ["operator", TokenKind.Operator],
  ["or", TokenKind.Or],
  ["outer", TokenKind.Outer],
  ["output", TokenKind.Output],
  ["package", TokenKind.Package],
  ["parameter", TokenKind.Parameter],
  ["partial", TokenKind.Partial],
  ["protected", TokenKind.Protected],
  ["public", TokenKind.Public],
  ["pure", TokenKind.Pure],
  ["record", TokenKind.Record],
  ["redeclare", TokenKind.Redeclare],
  ["replaceable", TokenKind.Replaceable],
  ["return", TokenKind.Return],
  ["stream", TokenKind.Stream],
  ["then", TokenKind.Then],
  ["true", TokenKind.True],
  ["type", TokenKind.Type],
  ["when", TokenKind.When],
  ["while", TokenKind.While],
  ["within", TokenKind.Within],
]);
```

### 1.4 AST node types

The AST represents the syntactic structure of a Modelica source file. Every node carries a `span` for error reporting.

The design uses a discriminated union pattern — each node has a `kind` string literal field, and TypeScript's type narrowing handles the rest. This is idiomatic TypeScript and works well with `switch` statements.

#### Top-level structure

A Modelica source file contains an optional `within` clause followed by one or more class definitions.

```typescript
interface StoredDefinition {
  kind: "StoredDefinition";
  span: Span;
  withinPath: ComponentReference | null;  // within Package.SubPackage;
  classDefinitions: StoredClassEntry[];
}

interface StoredClassEntry {
  isFinal: boolean;   // "final" keyword before the class definition
  definition: ClassDefinition | ShortClassDefinition;
}
```

#### Class definitions

All class-like constructs (`model`, `block`, `connector`, `record`, `package`, `function`, `type`, `class`, `operator`) share a single AST node type. The `restriction` field records which keyword was used. Semantic validation (e.g., "connectors cannot have equation sections") happens in a later phase, not during parsing.

```typescript
type ClassRestriction =
  | "model"
  | "block"
  | "connector"
  | "record"
  | "package"
  | "function"
  | "type"
  | "class"
  | "operator"
  | "operator function"
  | "operator record";

interface ClassDefinition {
  kind: "ClassDefinition";
  span: Span;
  restriction: ClassRestriction;
  name: string;
  isFinal: boolean;        // "final" prefix (passed in from call site)
  isEncapsulated: boolean;
  isPartial: boolean;
  isExpandable: boolean;   // for expandable connector
  isPure: boolean;         // "pure" prefix — only valid on function restriction
  isImpure: boolean;       // "impure" prefix — only valid on function restriction
  elements: Element[];
  equationSections: EquationSection[];
  algorithmSections: AlgorithmSection[];
  externalDecl: ExternalDeclaration | null;
  annotation: Annotation | null;
}

// A short class definition: type X = Real(unit = "m")  or  type E = enumeration(a, b, c)
interface ShortClassDefinition {
  kind: "ShortClassDefinition";
  span: Span;
  restriction: ClassRestriction;
  name: string;
  isFinal: boolean;
  isEncapsulated: boolean;
  isPartial: boolean;
  isExpandable: boolean;
  isPure: boolean;
  isImpure: boolean;
  // For numeric/record/connector specialisations: baseType is the referenced name.
  // For enumeration types: baseType is null, enumeration is populated.
  baseType: ComponentReference | null;
  arraySubscripts: Expression[];      // e.g. type T = Real[N]
  modification: ClassModification | null;
  enumeration: EnumerationLiteral[] | null;
  annotation: Annotation | null;
  comment: string | null;
}

interface EnumerationLiteral {
  name: string;
  comment: string | null;
  annotation: Annotation | null;
}
```

A single `ClassDefinition` node holds all elements (declarations, extends clauses, import clauses), all equation sections, and all algorithm sections. In Modelica, a class body can have multiple alternating `public`/`protected` sections and multiple `equation`/`algorithm` sections. The elements and sections are stored in the order they appear, with visibility tracked on each element.

#### Elements

An element is anything that appears in the declaration part of a class body — component declarations, extends clauses, import clauses, and nested class definitions.

```typescript
type Element =
  | ComponentDeclaration
  | ExtendsClause
  | ImportClause
  | ClassDefinition;   // nested class

type Visibility = "public" | "protected";

type Variability = "parameter" | "constant" | "discrete" | null;
type Causality = "input" | "output" | null;

interface ComponentDeclaration {
  kind: "ComponentDeclaration";
  span: Span;
  visibility: Visibility;
  isFinal: boolean;
  isInner: boolean;
  isOuter: boolean;
  isRedeclare: boolean;
  isReplaceable: boolean;
  isFlow: boolean;
  isStream: boolean;
  variability: Variability;
  causality: Causality;
  typeName: ComponentReference;
  name: string;
  arraySubscripts: Expression[];    // e.g., [N, 3] for an N×3 array
  modification: Modification | null;
  conditionAttribute: Expression | null;  // if useHeatPort
  constrainedBy: ConstrainedByClause | null;
  annotation: Annotation | null;
  comment: string | null;           // the optional string comment
}
```

The `ComponentDeclaration` node carries many flags because Modelica allows stacking prefixes: `outer replaceable flow Real x`. The parser sets these flags based on which prefix keywords appear before the type name. The order of prefixes is fixed by the grammar (e.g., `redeclare` must come before `final`, which must come before `inner`/`outer`, etc.), but the parser does not need to enforce the order strictly — it can accept any order and let a later validation pass check it if desired.

```typescript
interface ExtendsClause {
  kind: "ExtendsClause";
  span: Span;
  visibility: Visibility;
  baseName: ComponentReference;
  modification: Modification | null;
  annotation: Annotation | null;
}

interface ImportClause {
  kind: "ImportClause";
  span: Span;
  visibility: Visibility;
  path: ComponentReference;
  alias: string | null;          // import alias = Package.Class;
  isWildcard: boolean;           // import Package.*;
  importedNames: string[] | null; // import Package.{A, B, C};
}

interface ConstrainedByClause {
  kind: "ConstrainedByClause";
  span: Span;
  typeName: ComponentReference;
  modification: ClassModification | null;  // only the '(...)' part; no '= expr' allowed here
}
```

#### Modifications

Modifications are the most structurally recursive part of Modelica syntax. A modification can appear on a component declaration, on an extends clause, inside another modification, or as an annotation. The grammar allows arbitrary nesting.

```typescript
interface Modification {
  kind: "Modification";
  span: Span;
  classModification: ClassModification | null;  // (...) part
  bindingExpression: Expression | null;          // = expr part
}

interface ClassModification {
  kind: "ClassModification";
  span: Span;
  arguments: ElementModification[];
}

interface ElementModification {
  kind: "ElementModification";
  span: Span;
  isFinal: boolean;
  isEach: boolean;
  name: ComponentReference;    // can be dotted: p.v.start
  modification: Modification | null;
}
```

The key recursive structure: `Modification` contains `ClassModification`, which contains `ElementModification`s, each of which contains another `Modification`. This is how `R1(p(v(start = 0)))` is represented — three levels of nested modification.

#### Annotation

An annotation is syntactically just a class modification wrapped in the `annotation` keyword. It gets its own node type for clarity, but the structure is identical to `ClassModification`:

```typescript
interface Annotation {
  kind: "Annotation";
  span: Span;
  classModification: ClassModification;
}
```

#### Equation sections

```typescript
interface EquationSection {
  kind: "EquationSection";
  span: Span;
  isInitial: boolean;  // initial equation section
  equations: EquationNode[];
}

type EquationNode =
  | SimpleEquation
  | ConnectEquation
  | IfEquation
  | ForEquation
  | WhenEquation
  | FunctionCallEquation;

interface SimpleEquation {
  kind: "SimpleEquation";
  span: Span;
  lhs: Expression;
  rhs: Expression;
  annotation: Annotation | null;
  comment: string | null;
}

interface ConnectEquation {
  kind: "ConnectEquation";
  span: Span;
  from: ComponentReference;
  to: ComponentReference;
  annotation: Annotation | null;
  comment: string | null;
}

interface IfEquation {
  kind: "IfEquation";
  span: Span;
  branches: { condition: Expression; equations: EquationNode[] }[];
  elseEquations: EquationNode[];
  annotation: Annotation | null;
  comment: string | null;
}

interface ForEquation {
  kind: "ForEquation";
  span: Span;
  iterators: ForIterator[];
  equations: EquationNode[];
  annotation: Annotation | null;
  comment: string | null;
}

interface ForIterator {
  name: string;
  range: Expression | null;    // null means "inferred from context"
}

interface WhenEquation {
  kind: "WhenEquation";
  span: Span;
  branches: { condition: Expression; equations: EquationNode[] }[];
  annotation: Annotation | null;
  comment: string | null;
}

// A function-call equation: name(args)
// Used for built-in procedural statements that appear in equation sections:
//   transition(from, to, condition, immediate, reset, synchronize, priority)
//   initialState(state)
//   assert(condition, message)
//   terminate(message)
//   reinit(variable, expression)
//   Connections.root(n), Connections.branch(a, b), etc.
interface FunctionCallEquation {
  kind: "FunctionCallEquation";
  span: Span;
  name: ComponentReference;
  args: FunctionArguments;
  annotation: Annotation | null;
  comment: string | null;
}
```

#### Algorithm sections

Algorithm sections contain statements, not equations. The key syntactic difference is `:=` for assignment instead of `=`.

```typescript
interface AlgorithmSection {
  kind: "AlgorithmSection";
  span: Span;
  isInitial: boolean;
  statements: Statement[];
}

type Statement =
  | AssignmentStatement
  | IfStatement
  | ForStatement
  | WhileStatement
  | WhenStatement
  | ReturnStatement
  | BreakStatement
  | FunctionCallStatement;

// The target of an assignment can be a single variable or a tuple of variables
// for functions that return multiple values: (a, b, c) := f(x)
type AssignmentTarget = ComponentReference | TupleTarget;

interface TupleTarget {
  components: ComponentReference[];  // the parenthesised list: (a, b, c)
}

interface AssignmentStatement {
  kind: "AssignmentStatement";
  span: Span;
  target: AssignmentTarget;
  value: Expression;
}

interface FunctionCallStatement {
  kind: "FunctionCallStatement";
  span: Span;
  name: ComponentReference;
  args: FunctionArguments;
}

// IfStatement, ForStatement, WhileStatement, WhenStatement, ReturnStatement,
// BreakStatement follow the same pattern as their equation counterparts
// but contain Statement[] instead of EquationNode[].
interface IfStatement {
  kind: "IfStatement";
  span: Span;
  branches: { condition: Expression; statements: Statement[] }[];
  elseStatements: Statement[];
}

interface ForStatement {
  kind: "ForStatement";
  span: Span;
  iterators: ForIterator[];
  statements: Statement[];
}

interface WhileStatement {
  kind: "WhileStatement";
  span: Span;
  condition: Expression;
  statements: Statement[];
}

interface WhenStatement {
  kind: "WhenStatement";
  span: Span;
  branches: { condition: Expression; statements: Statement[] }[];
}

interface ReturnStatement {
  kind: "ReturnStatement";
  span: Span;
}

interface BreakStatement {
  kind: "BreakStatement";
  span: Span;
}
```

#### Expressions

Expressions are the most diverse AST node family. They must represent arithmetic, comparisons, logical operations, function calls, array construction, if-expressions, and component references.

```typescript
type Expression =
  | IntegerLiteralExpr
  | RealLiteralExpr
  | StringLiteralExpr
  | BooleanLiteralExpr
  | ComponentReferenceExpr
  | BinaryExpr
  | UnaryExpr
  | IfExpr
  | FunctionCallExpr
  | ArrayConstructExpr
  | ArrayConcatExpr
  | RangeExpr
  | EndExpr
  | ColonExpr;

interface IntegerLiteralExpr {
  kind: "IntegerLiteral";
  span: Span;
  value: number;
}

interface RealLiteralExpr {
  kind: "RealLiteral";
  span: Span;
  value: number;
}

interface StringLiteralExpr {
  kind: "StringLiteral";
  span: Span;
  value: string;
}

interface BooleanLiteralExpr {
  kind: "BooleanLiteral";
  span: Span;
  value: boolean;
}

interface ComponentReferenceExpr {
  kind: "ComponentReference";
  span: Span;
  ref: ComponentReference;
}

type BinaryOp =
  | "+" | "-" | "*" | "/" | "^"
  | ".+" | ".-" | ".*" | "./" | ".^"
  | "==" | "<>" | "<" | "<=" | ">" | ">="
  | "and" | "or";

interface BinaryExpr {
  kind: "BinaryExpr";
  span: Span;
  op: BinaryOp;
  left: Expression;
  right: Expression;
}

type UnaryOp = "-" | "+" | "not";

interface UnaryExpr {
  kind: "UnaryExpr";
  span: Span;
  op: UnaryOp;
  operand: Expression;
}

interface IfExpr {
  kind: "IfExpr";
  span: Span;
  condition: Expression;
  thenExpr: Expression;
  elseIfs: { condition: Expression; value: Expression }[];
  elseExpr: Expression;
}

interface FunctionCallExpr {
  kind: "FunctionCallExpr";
  span: Span;
  name: ComponentReference;
  args: FunctionArguments;
}

interface FunctionArguments {
  positional: Expression[];
  named: { name: string; value: Expression }[];
  forIterators: ForIterator[] | null;  // for array comprehensions
}

interface ArrayConstructExpr {
  kind: "ArrayConstructExpr";
  span: Span;
  elements: Expression[];
}

interface ArrayConcatExpr {
  kind: "ArrayConcatExpr";
  span: Span;
  rows: Expression[][];   // [a, b; c, d] -> [[a, b], [c, d]]
}

interface RangeExpr {
  kind: "RangeExpr";
  span: Span;
  start: Expression;
  step: Expression | null;
  stop: Expression;
}

interface EndExpr {
  kind: "EndExpr";
  span: Span;
}

// A bare ':' used as an array subscript, meaning "all indices along this dimension".
// e.g. A[:, 1] selects the first column of matrix A.
interface ColonExpr {
  kind: "ColonExpr";
  span: Span;
}
```

#### Component references

A component reference is a dotted name with optional array subscripts at each level: `a.b[1].c[2,3]`. It appears in many contexts — type names, variable references in expressions, targets of modifications, arguments to `connect`.

```typescript
interface ComponentReference {
  isGlobal: boolean;       // starts with .  (global lookup)
  parts: ComponentReferencePart[];
}

interface ComponentReferencePart {
  name: string;
  subscripts: Expression[];  // empty if no subscripts
}
```

For example, `Modelica.Electrical.Analog.Basic.Resistor` is represented as five parts with no subscripts. `.GlobalPackage.Something` has `isGlobal: true`. `r[1].p.v` has three parts, the first with one subscript.

#### External declarations

Functions can have external declarations for calling C or FORTRAN code:

```typescript
interface ExternalDeclaration {
  kind: "ExternalDeclaration";
  span: Span;
  language: string | null;        // "C", "FORTRAN 77", etc.
  functionName: string | null;
  args: Expression[];
  returnVar: ComponentReference | null;
  annotation: Annotation | null;
}
```

---

## Part 2: Lexer

The lexer converts a source string into a sequence of tokens. It is implemented as a class with a single public method `nextToken()` that returns the next token each time it is called.

### 2.1 Lexer structure

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

  // --- internal helpers ---
  private peek(): string       { return this.source[this.pos] ?? "\0"; }
  private peekNext(): string   { return this.source[this.pos + 1] ?? "\0"; }
  private advance(): string    { return this.source[this.pos++]; }
  private isAtEnd(): boolean   { return this.pos >= this.source.length; }
  private match(ch: string): boolean {
    if (this.peek() === ch) { this.pos++; return true; }
    return false;
  }
}
```

The lexer does not tokenize the entire source up front. It produces one token per `nextToken()` call. The parser calls `nextToken()` as it needs tokens. This avoids allocating an array of all tokens, which for large files can be significant.

If eager tokenization is preferred (for simplicity or to enable look-ahead over the full token stream), you can add a `tokenizeAll(): Token[]` method that calls `nextToken()` in a loop until `EOF`. Either approach works — the parser interface described later supports both.

### 2.2 The main scanning loop

`nextToken()` follows a standard pattern:

1. Skip whitespace and comments
2. Record the start position
3. Look at the current character and dispatch to the appropriate scanning function
4. Return the resulting token

```typescript
nextToken(): Token {
  this.skipWhitespaceAndComments();

  if (this.isAtEnd()) {
    return this.makeToken(TokenKind.EOF);
  }

  this.tokenStart = this.pos;
  const ch = this.advance();

  // Single-character dispatch
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

### 2.3 Whitespace and comment skipping

```typescript
private skipWhitespaceAndComments(): void {
  while (!this.isAtEnd()) {
    const ch = this.peek();

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      this.advance();
      continue;
    }

    // Line comment
    if (ch === "/" && this.peekNext() === "/") {
      while (!this.isAtEnd() && this.peek() !== "\n") {
        this.advance();
      }
      continue;
    }

    // Block comment (nested)
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
```

The nesting depth counter is the key detail — Modelica block comments nest, unlike C/Java. The lexer increments on `/*` and decrements on `*/`, only ending when depth returns to zero.

### 2.4 Numbers

Numeric literals require care because of several edge cases.

The lexer must handle:
- Integer: `42`
- Real with decimal: `3.14`
- Real with exponent: `1e10`, `1.5e-3`, `2E+4`
- Real with trailing dot: `1.` (this is `1.0`, not integer `1` followed by dot)
- The ambiguity: `1.` followed by a digit is a real (`1.5`). `1.` followed by a non-digit is also a real (`1.`). But `1` followed by `:` is an integer in a range expression — the `.` is not part of the number.

The simplest correct approach:

```typescript
private scanNumber(): Token {
  // Already consumed the first digit

  // Consume integer part
  while (isDigit(this.peek())) this.advance();

  let isReal = false;

  // Look for decimal point
  // A dot is part of the number if:
  //   - followed by a digit (1.5)
  //   - NOT followed by an identifier start, operator, or another dot (1.e would
  //     be ambiguous, but Modelica says 1. is a valid real literal)
  // A dot is NOT part of the number if:
  //   - it's part of a dotted operator (.+, .*, etc.)
  //   - it starts a component reference (rare after a number, but 1..2 would be
  //     two reals — this doesn't occur in practice)
  if (this.peek() === "." && this.peekNext() !== "."
      && !isElementwiseOp(this.peekNext())) {
    isReal = true;
    this.advance(); // consume the dot
    while (isDigit(this.peek())) this.advance();
  }

  // Look for exponent
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
```

The `isElementwiseOp` check prevents `1.+x` from being scanned as real `1.` followed by `+x` when it should be integer `1` followed by `.+` followed by `x`. This ambiguity is resolved by treating the dot as part of an elementwise operator when followed by `+`, `-`, `*`, `/`, or `^`.

### 2.5 Identifiers and keywords

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
  // Modelica 3.6 allows Unicode letters as identifier start characters.
  // Use the Unicode 'Letter' property (covers all scripts).
  const cp = ch.codePointAt(0)!;
  return cp > 127 && /\p{L}/u.test(ch);
}

function isIdentPart(ch: string): boolean {
  if (isIdentStart(ch)) return true;
  if (isDigit(ch)) return true;
  // Unicode combining marks and non-ASCII decimal digits are also valid
  // identifier continuation characters per Modelica 3.6.
  const cp = ch.codePointAt(0)!;
  return cp > 127 && /[\p{L}\p{N}\p{M}]/u.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}
```

### 2.6 Strings

Modelica strings use double quotes and support standard escape sequences:

```typescript
private scanString(): Token {
  // Opening " already consumed
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

Modelica also supports string concatenation with `+`, but that is an expression-level operation handled by the parser, not the lexer.

### 2.7 Quoted identifiers

Quoted identifiers are enclosed in single quotes and can contain nearly any character:

```typescript
private scanQuotedIdentifier(): Token {
  // Opening ' already consumed
  let name = "";

  while (!this.isAtEnd() && this.peek() !== "'") {
    if (this.peek() === "\\") {
      this.advance();
      name += this.advance(); // escaped character, take literally
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

Quoted identifiers produce the same `TokenKind.Identifier` as regular identifiers — the quotes are purely lexical. The parser does not need to distinguish them.

### 2.8 Dot and elementwise operators

The dot character is overloaded: it can be a member access operator (`.`), part of a real literal (`1.5`), or the start of an elementwise operator (`.+`, `.-`, `.*`, `./`, `.^`). The number case is already handled in `scanNumber` (the main dispatch only reaches here when the dot is not preceded by a digit). For the remaining cases:

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

### 2.9 Token construction helper

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

private makeLocation(offset: number): SourceLocation {
  // Compute line/column from offset by counting newlines
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

The `makeLocation` implementation above is correct but O(n) per call. For a production compiler, maintain a precomputed array of line-start offsets built once at construction time, then use binary search to convert offset to line/column in O(log n). For an initial implementation, the linear scan is fine — it only runs when constructing tokens, and source files are rarely large enough for this to matter.

### 2.10 Error reporting

```typescript
private error(message: string): Error {
  const loc = this.makeLocation(this.pos);
  return new Error(`${loc.file}:${loc.line}:${loc.column}: ${message}`);
}
```

For better diagnostics, include the source line and a caret pointing to the error position. This can be added later without changing the lexer structure.

---

## Part 3: Parser

The parser consumes tokens from the lexer and builds the AST. It is a **recursive descent parser** — each grammar rule maps to a method. Expression parsing uses a **Pratt parser** (precedence climbing) to handle operator precedence.

### 3.1 Parser structure

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

  // --- token consumption ---
  private peek(): TokenKind     { return this.current.kind; }
  private advance(): Token {
    this.previous = this.current;
    this.current = this.lexer.nextToken();
    return this.previous;
  }
  private check(kind: TokenKind): boolean {
    return this.current.kind === kind;
  }
  private match(...kinds: TokenKind[]): boolean {
    for (const kind of kinds) {
      if (this.check(kind)) {
        this.advance();
        return true;
      }
    }
    return false;
  }
  private expect(kind: TokenKind, message?: string): Token {
    if (this.check(kind)) return this.advance();
    throw this.error(message ?? `Expected ${TokenKind[kind]}, got ${TokenKind[this.current.kind]}`);
  }
  private error(message: string): Error {
    const loc = this.current.span.start;
    return new Error(`${loc.file}:${loc.line}:${loc.column}: ${message}`);
  }
}
```

The parser maintains one token of lookahead (`current`). Most parsing decisions require only looking at `current.kind` to decide which grammar rule to apply. The `previous` field is a convenience — after calling `advance()`, it holds the token that was just consumed, which is useful for extracting values from literal and identifier tokens.

### 3.2 Top-level: stored definition

A Modelica file is a `stored_definition`:

```
stored_definition :=
  [ "within" [name] ";" ]
  { class_definition ";" }
```

```typescript
parse(): StoredDefinition {
  const start = this.current.span.start;

  // Optional 'within' clause
  let withinPath: ComponentReference | null = null;
  if (this.match(TokenKind.Within)) {
    if (!this.check(TokenKind.Semicolon)) {
      withinPath = this.parseComponentReference();
    }
    this.expect(TokenKind.Semicolon);
  }

  // Class definitions — each may be optionally preceded by "final"
  const classDefinitions: StoredClassEntry[] = [];
  while (!this.check(TokenKind.EOF)) {
    const isFinal = this.match(TokenKind.Final);
    const definition = this.parseClassDefinition(isFinal);
    classDefinitions.push({ isFinal, definition });
    this.expect(TokenKind.Semicolon);
  }

  return {
    kind: "StoredDefinition",
    span: this.spanFrom(start),
    withinPath,
    classDefinitions,
  };
}
```

### 3.3 Class definitions

This is the largest parsing function because Modelica class bodies have complex structure — interleaved public/protected sections, optional equation/algorithm sections, optional external declarations, and an optional trailing annotation.

```
class_definition :=
  [ "encapsulated" ] [ "partial" ] class_prefixes IDENTIFIER
    string_comment
    composition
  "end" IDENTIFIER ";"
```

The `class_prefixes` are the restriction keyword (`model`, `block`, etc.) plus optional modifiers like `expandable`. The `composition` is the body — elements, equation sections, algorithm sections.

```typescript
// isFinal is passed in from the call site because "final" is consumed there
// (at the stored-definition level or the element level) before this method is called.
private parseClassDefinition(isFinal: boolean): ClassDefinition | ShortClassDefinition {
  const start = this.current.span.start;

  const isEncapsulated = this.match(TokenKind.Encapsulated);
  const isPartial = this.match(TokenKind.Partial);
  const isExpandable = this.match(TokenKind.Expandable);
  // "pure" and "impure" are only semantically valid on function restrictions,
  // but are collected here for all class definitions and left for semantic validation.
  const isPure = this.match(TokenKind.Pure);
  const isImpure = this.match(TokenKind.Impure);

  const restriction = this.parseClassRestriction();
  const nameToken = this.expect(TokenKind.Identifier);
  const name = nameToken.value as string;

  // Detect short class definition: class_prefixes IDENT "=" ...
  // e.g.  type Length = Real(unit = "m");
  //       type Direction = enumeration(x, y, z);
  if (this.match(TokenKind.Equals)) {
    return this.parseShortClassBody(
      start, restriction, name,
      { isFinal, isEncapsulated, isPartial, isExpandable, isPure, isImpure }
    );
  }

  const comment = this.parseOptionalStringComment();

  // Parse composition (body)
  const elements: Element[] = [];
  const equationSections: EquationSection[] = [];
  const algorithmSections: AlgorithmSection[] = [];
  let currentVisibility: Visibility = "public";
  let externalDecl: ExternalDeclaration | null = null;
  let annotation: Annotation | null = null;

  // The body consists of interleaved sections until we hit 'end'
  while (!this.check(TokenKind.End) && !this.check(TokenKind.EOF)) {
    if (this.match(TokenKind.Public)) {
      currentVisibility = "public";
    } else if (this.match(TokenKind.Protected)) {
      currentVisibility = "protected";
    } else if (this.check(TokenKind.Equation) || this.check(TokenKind.Initial)) {
      if (this.check(TokenKind.Initial) && this.peekNextIs(TokenKind.Equation)) {
        this.advance(); // consume 'initial'
        this.advance(); // consume 'equation'
        equationSections.push(this.parseEquationSection(true));
      } else if (this.check(TokenKind.Initial) && this.peekNextIs(TokenKind.Algorithm)) {
        this.advance(); // consume 'initial'
        this.advance(); // consume 'algorithm'
        algorithmSections.push(this.parseAlgorithmSection(true));
      } else if (this.match(TokenKind.Equation)) {
        equationSections.push(this.parseEquationSection(false));
      } else {
        // 'initial' not followed by 'equation' or 'algorithm' — it's an element
        elements.push(this.parseElement(currentVisibility));
      }
    } else if (this.match(TokenKind.Algorithm)) {
      algorithmSections.push(this.parseAlgorithmSection(false));
    } else if (this.match(TokenKind.External)) {
      externalDecl = this.parseExternalDeclaration();
    } else if (this.check(TokenKind.Annotation)) {
      annotation = this.parseAnnotation();
      this.expect(TokenKind.Semicolon);
    } else {
      elements.push(this.parseElement(currentVisibility));
    }
  }

  this.expect(TokenKind.End);
  const endName = this.expect(TokenKind.Identifier);
  if ((endName.value as string) !== name) {
    throw this.error(
      `Mismatched class name: opened '${name}', closed '${endName.value}'`
    );
  }

  return {
    kind: "ClassDefinition",
    span: this.spanFrom(start),
    restriction,
    name,
    isFinal,
    isEncapsulated,
    isPartial,
    isExpandable,
    isPure,
    isImpure,
    elements,
    equationSections,
    algorithmSections,
    externalDecl,
    annotation,
  };
}

private parseClassRestriction(): ClassRestriction {
  if (this.match(TokenKind.Model))     return "model";
  if (this.match(TokenKind.Block))     return "block";
  if (this.match(TokenKind.Connector)) return "connector";
  if (this.match(TokenKind.Record))    return "record";
  if (this.match(TokenKind.Package))   return "package";
  if (this.match(TokenKind.Function))  return "function";
  if (this.match(TokenKind.Type))      return "type";
  if (this.match(TokenKind.Class))     return "class";
  if (this.match(TokenKind.Operator)) {
    if (this.match(TokenKind.Function)) return "operator function";
    if (this.match(TokenKind.Record))   return "operator record";
    return "operator";
  }
  throw this.error("Expected class restriction keyword");
}

// Parses the body of a short class definition, after the "=" has been consumed.
// Two forms:
//   (1) type Length = Real(unit = "m")             — type specialisation
//   (2) type Direction = enumeration(North, South)  — enumeration type
private parseShortClassBody(
  start: SourceLocation,
  restriction: ClassRestriction,
  name: string,
  prefixes: {
    isFinal: boolean; isEncapsulated: boolean; isPartial: boolean;
    isExpandable: boolean; isPure: boolean; isImpure: boolean;
  }
): ShortClassDefinition {
  if (this.match(TokenKind.Enumeration)) {
    // enumeration type
    this.expect(TokenKind.LParen);
    const enumLiterals = this.parseEnumerationList();
    this.expect(TokenKind.RParen);
    const comment = this.parseOptionalStringComment();
    const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;
    return {
      kind: "ShortClassDefinition",
      span: this.spanFrom(start),
      ...prefixes,
      restriction,
      name,
      baseType: null,
      arraySubscripts: [],
      modification: null,
      enumeration: enumLiterals,
      annotation,
      comment,
    };
  }

  // Type specialisation: base type name, optional array subscripts, optional modification
  const baseType = this.parseComponentReference();
  const arraySubscripts = this.check(TokenKind.LBracket)
    ? this.parseArraySubscripts()
    : [];
  const modification = this.check(TokenKind.LParen)
    ? this.parseClassModification()
    : null;
  const comment = this.parseOptionalStringComment();
  const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;

  return {
    kind: "ShortClassDefinition",
    span: this.spanFrom(start),
    ...prefixes,
    restriction,
    name,
    baseType,
    arraySubscripts,
    modification,
    enumeration: null,
    annotation,
    comment,
  };
}

private parseEnumerationList(): EnumerationLiteral[] {
  const literals: EnumerationLiteral[] = [];
  if (!this.check(TokenKind.RParen)) {
    literals.push(this.parseEnumerationLiteral());
    while (this.match(TokenKind.Comma)) {
      if (this.check(TokenKind.RParen)) break; // trailing comma
      literals.push(this.parseEnumerationLiteral());
    }
  }
  return literals;
}

private parseEnumerationLiteral(): EnumerationLiteral {
  const nameToken = this.expect(TokenKind.Identifier);
  const comment = this.parseOptionalStringComment();
  const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;
  return { name: nameToken.value as string, comment, annotation };
}
```

The `peekNextIs` method is needed here — this is one of the few places where the parser needs two tokens of lookahead. When it sees `initial`, it must check whether the next token is `equation` or `algorithm` (making it an initial equation/algorithm section) or something else (making `initial` an element prefix). This can be implemented by buffering one additional token:

```typescript
private peekNextIs(kind: TokenKind): boolean {
  // Save state
  const savedCurrent = this.current;
  const savedPrevious = this.previous;
  const savedPos = this.lexer.getPos(); // requires exposing pos from lexer

  this.advance();
  const result = this.check(kind);

  // Restore state
  this.current = savedCurrent;
  this.previous = savedPrevious;
  this.lexer.setPos(savedPos);

  return result;
}
```

Alternatively, maintain a two-token lookahead buffer instead of save/restore. Both work.

### 3.4 Elements

Elements are the declarations inside a class body. Parsing them requires recognizing the various prefix keywords and then dispatching to the right element type.

```typescript
private parseElement(visibility: Visibility): Element {
  const start = this.current.span.start;

  // Import clause
  if (this.match(TokenKind.Import)) {
    const imp = this.parseImportClause(visibility, start);
    this.expect(TokenKind.Semicolon);
    return imp;
  }

  // Extends clause
  if (this.match(TokenKind.Extends)) {
    const ext = this.parseExtendsClause(visibility, start);
    this.expect(TokenKind.Semicolon);
    return ext;
  }

  // Collect prefix flags
  const isRedeclare = this.match(TokenKind.Redeclare);
  const isFinal = this.match(TokenKind.Final);
  const isInner = this.match(TokenKind.Inner);
  const isOuter = this.match(TokenKind.Outer);
  const isReplaceable = this.match(TokenKind.Replaceable);

  // Check if this is a nested class definition.
  // isFinal collected above is passed in here so the ClassDefinition node records it.
  if (this.isClassRestrictionStart()) {
    const classDef = this.parseClassDefinition(isFinal);
    this.expect(TokenKind.Semicolon);
    return classDef;
  }

  // Otherwise it is a component declaration
  return this.parseComponentDeclaration(visibility, {
    isRedeclare, isFinal, isInner, isOuter, isReplaceable
  });
}

private isClassRestrictionStart(): boolean {
  return this.check(TokenKind.Model)
    || this.check(TokenKind.Block)
    || this.check(TokenKind.Connector)
    || this.check(TokenKind.Record)
    || this.check(TokenKind.Package)
    || this.check(TokenKind.Function)
    || this.check(TokenKind.Type)
    || this.check(TokenKind.Class)
    || this.check(TokenKind.Operator)
    || this.check(TokenKind.Partial)
    || this.check(TokenKind.Encapsulated)
    || this.check(TokenKind.Expandable);
}
```

### 3.5 Component declarations

```typescript
private parseComponentDeclaration(
  visibility: Visibility,
  prefixes: { isRedeclare: boolean; isFinal: boolean;
              isInner: boolean; isOuter: boolean;
              isReplaceable: boolean }
): ComponentDeclaration {
  const start = this.current.span.start;

  // Type prefixes
  const isFlow = this.match(TokenKind.Flow);
  const isStream = this.match(TokenKind.Stream);

  let variability: Variability = null;
  if (this.match(TokenKind.Parameter)) variability = "parameter";
  else if (this.match(TokenKind.Constant)) variability = "constant";
  else if (this.match(TokenKind.Discrete)) variability = "discrete";

  let causality: Causality = null;
  if (this.match(TokenKind.Input)) causality = "input";
  else if (this.match(TokenKind.Output)) causality = "output";

  // Type name
  const typeName = this.parseComponentReference();

  // Variable name
  const nameToken = this.expect(TokenKind.Identifier);
  const name = nameToken.value as string;

  // Optional array subscripts on the variable name
  const arraySubscripts = this.check(TokenKind.LBracket)
    ? this.parseArraySubscripts()
    : [];

  // Optional modification
  const modification = this.check(TokenKind.LParen) || this.check(TokenKind.Equals)
    ? this.parseModification()
    : null;

  // Optional condition attribute
  const conditionAttribute = this.match(TokenKind.If)
    ? this.parseExpression()
    : null;

  // Optional constrainedby clause — only meaningful on replaceable components,
  // but parsed unconditionally so the parser does not need to track that context.
  const constrainedBy = this.match(TokenKind.ConstrainedBy)
    ? this.parseConstrainedByClause()
    : null;

  // Optional string comment and annotation
  const comment = this.parseOptionalStringComment();
  const annotation = this.check(TokenKind.Annotation)
    ? this.parseAnnotation()
    : null;

  this.expect(TokenKind.Semicolon);

  return {
    kind: "ComponentDeclaration",
    span: this.spanFrom(start),
    visibility,
    ...prefixes,
    isFlow,
    isStream,
    variability,
    causality,
    typeName,
    name,
    arraySubscripts,
    modification,
    conditionAttribute,
    constrainedBy,
    annotation,
    comment,
  };
}

private parseConstrainedByClause(): ConstrainedByClause {
  const start = this.current.span.start;
  const typeName = this.parseComponentReference();
  // Only a class modification '(...)' is allowed here — no '= expr' binding
  const modification = this.check(TokenKind.LParen)
    ? this.parseClassModification()
    : null;
  return {
    kind: "ConstrainedByClause",
    span: this.spanFrom(start),
    typeName,
    modification,
  };
}
```

### 3.6 Modifications

Modifications are the most recursive parsing construct. The grammar is:

```
modification := class_modification [ "=" expression ]
              | "=" expression
class_modification := "(" { element_modification_or_replaceable "," } ")"
element_modification := [ "each" ] [ "final" ] name [ modification ]
```

```typescript
private parseModification(): Modification {
  const start = this.current.span.start;

  let classModification: ClassModification | null = null;
  let bindingExpression: Expression | null = null;

  if (this.check(TokenKind.LParen)) {
    classModification = this.parseClassModification();
  }

  if (this.match(TokenKind.Equals)) {
    bindingExpression = this.parseExpression();
  }

  return {
    kind: "Modification",
    span: this.spanFrom(start),
    classModification,
    bindingExpression,
  };
}

private parseClassModification(): ClassModification {
  const start = this.current.span.start;
  this.expect(TokenKind.LParen);

  const arguments: ElementModification[] = [];

  if (!this.check(TokenKind.RParen)) {
    arguments.push(this.parseElementModification());
    while (this.match(TokenKind.Comma)) {
      if (this.check(TokenKind.RParen)) break; // trailing comma
      arguments.push(this.parseElementModification());
    }
  }

  this.expect(TokenKind.RParen);

  return {
    kind: "ClassModification",
    span: this.spanFrom(start),
    arguments,
  };
}

private parseElementModification(): ElementModification {
  const start = this.current.span.start;

  const isEach = this.match(TokenKind.Each);
  const isFinal = this.match(TokenKind.Final);
  const name = this.parseComponentReference();

  const modification =
    this.check(TokenKind.LParen) || this.check(TokenKind.Equals)
      ? this.parseModification()
      : null;

  return {
    kind: "ElementModification",
    span: this.spanFrom(start),
    isFinal,
    isEach,
    name,
    modification,
  };
}
```

The recursion here is: `parseModification` → `parseClassModification` → `parseElementModification` → `parseModification`. This handles arbitrarily deep nesting like `R1(p(v(start = 0)))`.

### 3.7 Equation sections

```typescript
private parseEquationSection(isInitial: boolean): EquationSection {
  const start = this.current.span.start;
  const equations: EquationNode[] = [];

  while (!this.isSectionEnd()) {
    equations.push(this.parseEquation());
    this.expect(TokenKind.Semicolon);
  }

  return {
    kind: "EquationSection",
    span: this.spanFrom(start),
    isInitial,
    equations,
  };
}

private isSectionEnd(): boolean {
  return this.check(TokenKind.End)
    || this.check(TokenKind.Public)
    || this.check(TokenKind.Protected)
    || this.check(TokenKind.Equation)
    || this.check(TokenKind.Algorithm)
    || this.check(TokenKind.Initial)
    || this.check(TokenKind.External)
    || this.check(TokenKind.Annotation)
    || this.check(TokenKind.EOF);
}
```

`isSectionEnd` checks for tokens that can start a new section or end the class body. This is how the parser knows the current equation section is finished without requiring a closing keyword.

### 3.8 Individual equations

```typescript
private parseEquation(): EquationNode {
  const start = this.current.span.start;

  // Connect equation
  if (this.match(TokenKind.Connect)) {
    return this.parseConnectEquation(start);
  }

  // If equation
  if (this.match(TokenKind.If)) {
    return this.parseIfEquation(start);
  }

  // For equation
  if (this.match(TokenKind.For)) {
    return this.parseForEquation(start);
  }

  // When equation
  if (this.match(TokenKind.When)) {
    return this.parseWhenEquation(start);
  }

  // Disambiguate simple equation (lhs = rhs) from function-call equation (name(...)).
  // Both start with an expression. Parse the left side fully, then inspect the result:
  //   - If it produced a FunctionCallExpr and the next token is NOT "=", it is a
  //     function-call equation: transition(...), assert(...), reinit(...), etc.
  //   - Otherwise, expect "=" and parse the right side as a simple equation.
  const lhs = this.parseExpression();

  if (lhs.kind === "FunctionCallExpr" && !this.check(TokenKind.Equals)) {
    const comment = this.parseOptionalStringComment();
    const annotation = this.check(TokenKind.Annotation)
      ? this.parseAnnotation() : null;
    return {
      kind: "FunctionCallEquation",
      span: this.spanFrom(start),
      name: lhs.name,
      args: lhs.args,
      annotation,
      comment,
    };
  }

  // Simple equation: expr = expr
  this.expect(TokenKind.Equals);
  const rhs = this.parseExpression();
  const comment = this.parseOptionalStringComment();
  const annotation = this.check(TokenKind.Annotation)
    ? this.parseAnnotation() : null;

  return {
    kind: "SimpleEquation",
    span: this.spanFrom(start),
    lhs,
    rhs,
    annotation,
    comment,
  };
}
```

The connect equation parser:

```typescript
private parseConnectEquation(start: SourceLocation): ConnectEquation {
  this.expect(TokenKind.LParen);
  const from = this.parseComponentReference();
  this.expect(TokenKind.Comma);
  const to = this.parseComponentReference();
  this.expect(TokenKind.RParen);
  const comment = this.parseOptionalStringComment();
  const annotation = this.check(TokenKind.Annotation)
    ? this.parseAnnotation() : null;

  return {
    kind: "ConnectEquation",
    span: this.spanFrom(start),
    from,
    to,
    annotation,
    comment,
  };
}
```

The for-equation parser:

```typescript
private parseForEquation(start: SourceLocation): ForEquation {
  const iterators = this.parseForIterators();
  this.expect(TokenKind.Loop);

  const equations: EquationNode[] = [];
  while (!this.check(TokenKind.End)) {
    equations.push(this.parseEquation());
    this.expect(TokenKind.Semicolon);
  }
  this.expect(TokenKind.End);
  this.expect(TokenKind.For);

  const comment = this.parseOptionalStringComment();
  const annotation = this.check(TokenKind.Annotation)
    ? this.parseAnnotation() : null;

  return {
    kind: "ForEquation",
    span: this.spanFrom(start),
    iterators,
    equations,
    annotation,
    comment,
  };
}

private parseForIterators(): ForIterator[] {
  const iterators: ForIterator[] = [];
  iterators.push(this.parseForIterator());
  while (this.match(TokenKind.Comma)) {
    iterators.push(this.parseForIterator());
  }
  return iterators;
}

private parseForIterator(): ForIterator {
  const nameToken = this.expect(TokenKind.Identifier);
  let range: Expression | null = null;
  if (this.match(TokenKind.In)) {
    range = this.parseExpression();
  }
  return { name: nameToken.value as string, range };
}
```

The if-equation and when-equation parsers follow the same pattern — parse branches as condition-body pairs, collect them in an array, and close with `end if` or `end when`.

### 3.9 Expression parsing — Pratt parser

Expression parsing is where recursive descent on its own becomes awkward. The grammar has roughly 10 precedence levels and mixed associativity. A Pratt parser handles this cleanly with a single function and a precedence table.

The core idea: each operator has a **binding power** (a number). Higher numbers bind tighter. When parsing an expression, you stop collecting operands when you encounter an operator with binding power less than or equal to your current minimum. Left-associative operators use `left < right` for the comparison; right-associative use `left <= right`.

#### Precedence table

Modelica operator precedence from lowest to highest:

| Level | Operators | Associativity |
|---|---|---|
| 1 | `or` | left |
| 2 | `and` | left |
| 3 | `not` | unary (prefix) |
| 4 | `<`, `<=`, `>`, `>=`, `==`, `<>` | non-associative |
| 5 | `+`, `-`, `.+`, `.-` | left |
| 6 | `*`, `/`, `.*`, `./` | left |
| 7 | unary `+`, unary `-` | prefix |
| 8 | `^`, `.^` | right |

The `if-then-else` expression is handled separately as a prefix construct, not as an infix operator.

```typescript
// Binding powers (even numbers, leaving gaps for future use)
const enum BP {
  None       = 0,
  Or         = 2,
  And        = 4,
  Not        = 6,
  Comparison = 8,
  Addition   = 10,
  Multiplication = 12,
  UnarySign  = 14,
  Power      = 16,
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
      // Non-associative: both sides use same power, so a < b < c will error
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
      // Right-associative: left > right, so a^b^c = a^(b^c)
      return { left: BP.Power, right: BP.Power - 1 };
    default:
      return null;
  }
}
```

For left-associative operators, `right = left + 1` ensures that `a + b + c` parses as `(a + b) + c` — after parsing `a + b`, the next `+` has left binding power equal to the current minimum, so it does not get absorbed into the right operand.

For right-associative operators (like `^`), `right = left - 1` ensures that `a ^ b ^ c` parses as `a ^ (b ^ c)` — after parsing `a`, the `^` starts a right operand parse with a lower minimum, so the next `^` gets absorbed into it.

For non-associative operators (comparisons), we use `right = left + 1`, which makes `a < b` work but `a < b < c` fail because the second `<` would try to nest inside the first and find the binding powers don't allow it. In practice, chained comparisons produce a parse error, which is the correct behavior — Modelica does not support them.

#### The parsing function

```typescript
private parseExpression(minBP: number = BP.None): Expression {
  const start = this.current.span.start;

  // --- Prefix / atom ---
  let left: Expression;

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
    const operand = this.parseExpression(BP.Not);
    left = { kind: "UnaryExpr", span: this.spanFrom(start),
             op: "not", operand };
  } else if (this.check(TokenKind.Minus) || this.check(TokenKind.Plus)) {
    const op = this.advance().kind === TokenKind.Minus ? "-" : "+";
    const operand = this.parseExpression(BP.UnarySign);
    left = { kind: "UnaryExpr", span: this.spanFrom(start),
             op: op as UnaryOp, operand };
  } else if (this.match(TokenKind.LParen)) {
    // Parenthesized expression or tuple
    left = this.parseExpression();
    this.expect(TokenKind.RParen);
  } else if (this.match(TokenKind.LBrace)) {
    left = this.parseArrayConstruct(start);
  } else if (this.match(TokenKind.LBracket)) {
    left = this.parseArrayConcat(start);
  } else if (this.match(TokenKind.If)) {
    left = this.parseIfExpression(start);
  } else if (this.check(TokenKind.End)) {
    this.advance();
    left = { kind: "EndExpr", span: this.spanFrom(start) };
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
    const op = this.tokenToOp(opToken);
    const right = this.parseExpression(bp.right);
    left = {
      kind: "BinaryExpr",
      span: this.spanFrom(start),
      op,
      left,
      right,
    };
  }

  return left;
}
```

The function has two halves. The **prefix half** (top) parses atoms and prefix operators — literals, identifiers, parenthesized expressions, unary minus/plus, `not`, `if`, array constructors, and component references that may turn out to be function calls. The **infix half** (bottom loop) repeatedly checks if the next token is an infix operator with sufficient binding power, and if so, consumes it and parses the right operand recursively.

#### Component references and function calls

When the prefix parser sees an identifier, it could be a simple variable reference (`x`), a dotted name (`R1.p.v`), or a function call (`sin(x)`, `der(x)`). These share a common prefix — you must parse the component reference first, then check for a following `(` to distinguish a function call.

```typescript
private parseComponentReferenceOrFunctionCall(start: SourceLocation): Expression {
  const ref = this.parseComponentReference();

  // Check for function call
  if (this.check(TokenKind.LParen)) {
    const args = this.parseFunctionArguments();
    return {
      kind: "FunctionCallExpr",
      span: this.spanFrom(start),
      name: ref,
      args,
    };
  }

  return {
    kind: "ComponentReference",
    span: this.spanFrom(start),
    ref,
  };
}
```

`der(x)` falls out naturally as a function call — the `der` keyword token is handled as a component reference with a single part `{ name: "der", subscripts: [] }`, followed by the `(` that triggers function call parsing. No special case is needed in the parser.

#### Component reference parsing

```typescript
private parseComponentReference(): ComponentReference {
  const isGlobal = this.match(TokenKind.Dot);
  const parts: ComponentReferencePart[] = [];

  // First part — identifier or 'der' keyword
  const first = this.check(TokenKind.Der)
    ? (this.advance(), "der")
    : (this.expect(TokenKind.Identifier).value as string);

  let subscripts: Expression[] = [];
  if (this.check(TokenKind.LBracket)) {
    subscripts = this.parseArraySubscripts();
  }
  parts.push({ name: first, subscripts });

  // Subsequent dotted parts
  while (this.match(TokenKind.Dot)) {
    const name = this.expect(TokenKind.Identifier).value as string;
    let subs: Expression[] = [];
    if (this.check(TokenKind.LBracket)) {
      subs = this.parseArraySubscripts();
    }
    parts.push({ name, subscripts: subs });
  }

  return { isGlobal, parts };
}

private parseArraySubscripts(): Expression[] {
  this.expect(TokenKind.LBracket);
  const subscripts: Expression[] = [];
  subscripts.push(this.parseSubscript());
  while (this.match(TokenKind.Comma)) {
    subscripts.push(this.parseSubscript());
  }
  this.expect(TokenKind.RBracket);
  return subscripts;
}

// A subscript is either a bare ':' (meaning all indices along this dimension)
// or an expression (possibly a range expression like 1:N or 1:2:N).
private parseSubscript(): Expression {
  const start = this.current.span.start;
  if (this.match(TokenKind.Colon)) {
    return { kind: "ColonExpr", span: this.spanFrom(start) };
  }
  return this.parseExpressionOrRange();
}
```

#### Range expressions

Range expressions (`1:N`, `1:2:N`) need special handling. The colon is **not** an infix operator in the Pratt parser — it does not participate in precedence climbing. Instead, range expressions are parsed as a postfix check after the Pratt parser returns. This avoids ambiguity with the colon in other contexts (like `:=`).

One approach: after `parseExpression` returns, check if the next token is `:` in contexts where a range is expected (for-iterator ranges, array subscripts). If so, parse the range:

```typescript
private parseExpressionOrRange(): Expression {
  const start = this.current.span.start;
  const first = this.parseExpression();

  if (!this.match(TokenKind.Colon)) return first;

  const second = this.parseExpression();

  if (!this.match(TokenKind.Colon)) {
    // Two-part range: start:stop
    return { kind: "RangeExpr", span: this.spanFrom(start),
             start: first, step: null, stop: second };
  }

  // Three-part range: start:step:stop
  const third = this.parseExpression();
  return { kind: "RangeExpr", span: this.spanFrom(start),
           start: first, step: second, stop: third };
}
```

#### Function arguments

Function arguments can be positional, named, or include for-iterators (for array comprehensions):

```typescript
private parseFunctionArguments(): FunctionArguments {
  this.expect(TokenKind.LParen);

  const positional: Expression[] = [];
  const named: { name: string; value: Expression }[] = [];
  let forIterators: ForIterator[] | null = null;

  if (!this.check(TokenKind.RParen)) {
    // Try to distinguish positional from named arguments
    // Named argument: identifier = expression
    // Positional argument: expression
    this.parseFunctionArgumentList(positional, named);

    // Check for 'for' (array comprehension)
    if (this.match(TokenKind.For)) {
      forIterators = this.parseForIterators();
    }
  }

  this.expect(TokenKind.RParen);
  return { positional, named, forIterators };
}
```

Distinguishing named from positional arguments requires checking if the current token is an identifier followed by `=` (but not `==`). This is another place where a two-token lookahead is useful.

#### If-expression

```typescript
private parseIfExpression(start: SourceLocation): IfExpr {
  const condition = this.parseExpression();
  this.expect(TokenKind.Then);
  const thenExpr = this.parseExpression();

  const elseIfs: { condition: Expression; value: Expression }[] = [];
  while (this.match(TokenKind.ElseIf)) {
    const eic = this.parseExpression();
    this.expect(TokenKind.Then);
    const eiv = this.parseExpression();
    elseIfs.push({ condition: eic, value: eiv });
  }

  this.expect(TokenKind.Else);
  const elseExpr = this.parseExpression();

  return {
    kind: "IfExpr",
    span: this.spanFrom(start),
    condition,
    thenExpr,
    elseIfs,
    elseExpr,
  };
}
```

### 3.10 Annotations and string comments

```typescript
private parseAnnotation(): Annotation {
  const start = this.current.span.start;
  this.expect(TokenKind.Annotation);
  const classModification = this.parseClassModification();
  return {
    kind: "Annotation",
    span: this.spanFrom(start),
    classModification,
  };
}

private parseOptionalStringComment(): string | null {
  if (this.check(TokenKind.StringLiteral)) {
    return this.advance().value as string;
  }
  return null;
}
```

### 3.11 Statement parsing

Statements appear inside `algorithm` sections. They follow the same pattern as equation parsing but use `:=` for assignment and include `while` and `break`/`return` forms not available in equation sections.

The main disambiguation challenge is the **tuple assignment** for functions with multiple return values:

```modelica
(a, b, c) := f(x);   // tuple target
x := f(y);           // single target
f(x);                // function-call statement (no assignment)
```

```typescript
private parseStatement(): Statement {
  const start = this.current.span.start;

  // Tuple assignment: (a, b, c) := expr
  if (this.check(TokenKind.LParen)) {
    return this.parseTupleAssignment(start);
  }

  if (this.match(TokenKind.If))     return this.parseIfStatement(start);
  if (this.match(TokenKind.For))    return this.parseForStatement(start);
  if (this.match(TokenKind.While))  return this.parseWhileStatement(start);
  if (this.match(TokenKind.When))   return this.parseWhenStatement(start);
  if (this.match(TokenKind.Return)) return { kind: "ReturnStatement", span: this.spanFrom(start) };
  if (this.match(TokenKind.Break))  return { kind: "BreakStatement",  span: this.spanFrom(start) };

  // Either a single-variable assignment or a function-call statement.
  // Both start with a component reference.
  const ref = this.parseComponentReference();

  if (this.check(TokenKind.LParen)) {
    // Function-call statement: name(args)
    const args = this.parseFunctionArguments();
    return {
      kind: "FunctionCallStatement",
      span: this.spanFrom(start),
      name: ref,
      args,
    };
  }

  // Single-variable assignment: ref := expr
  this.expect(TokenKind.Assign);
  const value = this.parseExpression();
  return {
    kind: "AssignmentStatement",
    span: this.spanFrom(start),
    target: ref,
    value,
  };
}

private parseTupleAssignment(start: SourceLocation): AssignmentStatement {
  // Consume the '(' and parse comma-separated component references.
  this.expect(TokenKind.LParen);
  const components: ComponentReference[] = [];
  if (!this.check(TokenKind.RParen)) {
    components.push(this.parseComponentReference());
    while (this.match(TokenKind.Comma)) {
      components.push(this.parseComponentReference());
    }
  }
  this.expect(TokenKind.RParen);
  this.expect(TokenKind.Assign);  // :=
  const value = this.parseExpression();
  return {
    kind: "AssignmentStatement",
    span: this.spanFrom(start),
    target: { components },
    value,
  };
}
```

The `if`, `for`, `while`, and `when` statement parsers follow the same pattern as their equation counterparts — parse condition-body branches, collect in an array, close with `end if` / `end for` / `end while` / `end when`.

### 3.12 Utility methods

```typescript
private spanFrom(start: SourceLocation): Span {
  return {
    start,
    end: this.previous.span.end,
  };
}

private tokenToOp(token: Token): BinaryOp {
  switch (token.kind) {
    case TokenKind.Plus:         return "+";
    case TokenKind.Minus:        return "-";
    case TokenKind.Star:         return "*";
    case TokenKind.Slash:        return "/";
    case TokenKind.Power:        return "^";
    case TokenKind.DotPlus:      return ".+";
    case TokenKind.DotMinus:     return ".-";
    case TokenKind.DotStar:      return ".*";
    case TokenKind.DotSlash:     return "./";
    case TokenKind.DotPower:     return ".^";
    case TokenKind.LessThan:     return "<";
    case TokenKind.LessEqual:    return "<=";
    case TokenKind.GreaterThan:  return ">";
    case TokenKind.GreaterEqual: return ">=";
    case TokenKind.EqualEqual:   return "==";
    case TokenKind.NotEqual:     return "<>";
    case TokenKind.And:          return "and";
    case TokenKind.Or:           return "or";
    default: throw this.error(`Not a binary operator: ${TokenKind[token.kind]}`);
  }
}
```

---

## Worked Example

To show how the pieces fit together, here is a trace of parsing the SpringMassDamper model from the overview document.

**Input:**
```modelica
model SpringMassDamper
  Real x(start = 1.0);
  Real v(start = 0.0);
  parameter Real m = 1.0;
  parameter Real k = 10.0;
  parameter Real d = 0.5;
equation
  v = der(x);
  m * der(v) = -k * x - d * v;
end SpringMassDamper;
```

**Lexer output** (abbreviated):
```
MODEL, IDENT("SpringMassDamper"),
IDENT("Real"), IDENT("x"), LPAREN, IDENT("start"), EQUALS, REAL(1.0), RPAREN, SEMICOLON,
IDENT("Real"), IDENT("v"), LPAREN, IDENT("start"), EQUALS, REAL(0.0), RPAREN, SEMICOLON,
PARAMETER, IDENT("Real"), IDENT("m"), EQUALS, REAL(1.0), SEMICOLON,
PARAMETER, IDENT("Real"), IDENT("k"), EQUALS, REAL(10.0), SEMICOLON,
PARAMETER, IDENT("Real"), IDENT("d"), EQUALS, REAL(0.5), SEMICOLON,
EQUATION,
IDENT("v"), EQUALS, DER, LPAREN, IDENT("x"), RPAREN, SEMICOLON,
IDENT("m"), STAR, DER, LPAREN, IDENT("v"), RPAREN, EQUALS,
  MINUS, IDENT("k"), STAR, IDENT("x"), MINUS, IDENT("d"), STAR, IDENT("v"), SEMICOLON,
END, IDENT("SpringMassDamper"), SEMICOLON, EOF
```

**Parser trace** (key decisions):

1. `parse()` sees no `within`, enters class definition loop
2. `parseClassDefinition` consumes `MODEL`, reads name `SpringMassDamper`
3. Body loop: `IDENT("Real")` — not a section keyword, not a class restriction → `parseElement` → `parseComponentDeclaration`
   - Type: `Real` (component reference with one part)
   - Name: `x`
   - `LPAREN` → `parseModification` → `parseClassModification`
     - `start` → `parseElementModification` with name `start`, binding `= 1.0`
   - Produces `ComponentDeclaration` node for `x` with modification `(start = 1.0)`
4. Same for `v` with `(start = 0.0)`
5. `PARAMETER` prefix → `parseComponentDeclaration` with `variability: "parameter"`
   - Type: `Real`, name: `m`, modification `= 1.0` (binding expression, no class modification)
6. Same for `k` and `d`
7. `EQUATION` keyword → `parseEquationSection(false)`
8. First equation: `parseEquation` → `parseExpression` returns `ComponentReference("v")`, then `EQUALS`, then `parseExpression` returns `FunctionCallExpr("der", [ComponentReference("x")])` → `SimpleEquation` node
9. Second equation: `parseExpression` with Pratt parser:
   - Prefix: `IDENT("m")` → `ComponentReference("m")`
   - Infix: `STAR` (BP.Multiplication) → right operand: `DER(IDENT("v"))` → `FunctionCallExpr("der", [v])`
   - Left is now `BinaryExpr("*", m, der(v))`
   - No more infix operators with sufficient BP → return
   - `EQUALS` → right side of equation
   - Prefix: `MINUS` → unary minus, operand is `parseExpression(BP.UnarySign)`
     - `IDENT("k")` → reference
     - `STAR` (BP.Multiplication > BP.UnarySign) → absorbed, right: `IDENT("x")`
     - Result: `BinaryExpr("*", k, x)`
   - Unary result: `UnaryExpr("-", BinaryExpr("*", k, x))`
   - Infix: `MINUS` (BP.Addition) → right operand at BP.Addition+1
     - `IDENT("d")` → reference
     - `STAR` (BP.Multiplication > BP.Addition+1) → absorbed, right: `IDENT("v")`
     - Result: `BinaryExpr("*", d, v)`
   - Overall: `BinaryExpr("-", UnaryExpr("-", k*x), d*v)`
10. `END`, verify name matches `SpringMassDamper`

The resulting AST matches the structure shown in section 1.6 of the overview document.

---

## Error Handling Strategy

The parser described above uses a simple **panic mode** error strategy — when it encounters an unexpected token, it throws an exception with a source location and message. This is sufficient for an initial implementation.

For better user experience, two improvements can be added later without restructuring the parser:

**Synchronization.** Instead of stopping at the first error, catch the exception in the enclosing loop (e.g., the element-parsing loop in `parseClassDefinition`), skip tokens until a synchronization point (typically a semicolon, `end`, `equation`, `algorithm`, or `public`/`protected`), and continue parsing. This lets the parser report multiple errors in a single pass.

**Expected-token sets.** When the parser calls `expect(TokenKind.Semicolon)` and finds something else, it can report what tokens would have been valid at that point. The `expect` function already knows what it wanted — extending it to include alternatives ("expected ';' or ')'") is a matter of passing context from the calling function.

Both of these are additive changes to the existing structure — the recursive descent architecture naturally supports error recovery because each parsing function has a clear scope it can recover within.

---

## Testing

The parser should be tested at three levels:

**Lexer tests.** Verify token sequences for known inputs. Focus on edge cases: nested comments, quoted identifiers, numeric literals with exponents, the `.`/`.+`/real-literal ambiguity, `true`/`false` as keywords. Each test is a string in, token sequence out.

**Expression parser tests.** Verify precedence and associativity by parsing expression strings and checking the resulting AST shape. Key cases:
- `a + b * c` → `Add(a, Mul(b, c))`
- `a ^ b ^ c` → `Pow(a, Pow(b, c))` (right-associative)
- `-a * b` → `Mul(Neg(a), b)` (unary binds tighter than multiplication)
- `a + b * c ^ d` → `Add(a, Mul(b, Pow(c, d)))`
- `if a then b else c` inside larger expressions

**Full model tests.** Parse complete Modelica models and verify the AST structure. Start with the examples from the overview document (SpringMassDamper, the circuit components, SimpleCircuit) and verify the AST matches the expected structure shown in section 1.6.

A useful pattern is **round-trip testing**: write an AST pretty-printer that converts an AST back to Modelica text, then verify that parsing the printed text produces an identical AST. This catches both parser bugs and pretty-printer bugs simultaneously.
