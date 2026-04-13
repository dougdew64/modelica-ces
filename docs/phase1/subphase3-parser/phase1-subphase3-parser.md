# Phase 1, Subphase 3: Parser

This document describes the implementation of the Modelica parser. The parser consumes the token stream produced by the lexer and builds an Abstract Syntax Tree (AST).

Scope:
- Parser class structure and token consumption model
- Recursive descent parsing of Modelica grammar rules
- Pratt (precedence climbing) parser for expressions
- Error reporting and recovery

The AST node types that the parser produces are defined in the data structures document:

**[phase1-subphase1-data-structures.md — AST node types](../subphase1-data-structures/phase1-subphase1-data-structures.md)**

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

The parser maintains **one token of lookahead**: `current` holds the next unconsumed token. `previous` holds the token that was most recently consumed. `previous` is used to extract values from literal and identifier tokens immediately after consuming them, without needing to save a reference to the token before advancing.

The constructor calls `nextToken()` once to initialize `current`. This means `current` always refers to the next token to be consumed at the start of any parsing method.

### 1.2 Token consumption primitives

Five primitives cover all token consumption:

```typescript
// Return the kind of the current (not yet consumed) token.
private peek(): TokenKind {
  return this.current.kind;
}

// Return true if the current token has the given kind.
private check(kind: TokenKind): boolean {
  return this.current.kind === kind;
}

// Consume and return the current token. Sets this.previous.
private advance(): Token {
  this.previous = this.current;
  this.current = this.lexer.nextToken();
  return this.previous;
}

// If the current token matches any of the given kinds, consume and return true.
// Otherwise return false without consuming.
private match(...kinds: TokenKind[]): boolean {
  for (const kind of kinds) {
    if (this.check(kind)) {
      this.advance();
      return true;
    }
  }
  return false;
}

// Consume and return the current token if it matches kind.
// Throw a parse error if it does not.
private expect(kind: TokenKind, message?: string): Token {
  if (this.check(kind)) return this.advance();
  throw this.error(
    message ?? `Expected ${TokenKind[kind]}, got ${TokenKind[this.current.kind]}`
  );
}
```

`check` and `match` are the primary decision-making tools. `check` is used when the code needs to inspect the token without consuming it (e.g., before deciding which branch to take). `match` is used when a particular token is optional — it consumes and returns `true` if present. `expect` is used when a particular token is required — it consumes and returns it if present, and throws if not.

### 1.3 Two-token lookahead

Most parsing decisions require only one token of lookahead (`current`). One exception: when the parser sees `initial`, it must check whether the next token is `equation` or `algorithm` to decide if this is an `initial equation` / `initial algorithm` section header, or whether `initial` is an element prefix. This requires looking one token ahead of `current`.

```typescript
private peekNextIs(kind: TokenKind): boolean {
  // Save state
  const savedCurrent = this.current;
  const savedPrevious = this.previous;
  const savedPos = this.lexer.getPos(); // requires exposing pos from Lexer

  this.advance();
  const result = this.check(kind);

  // Restore state
  this.current = savedCurrent;
  this.previous = savedPrevious;
  this.lexer.setPos(savedPos);

  return result;
}
```

An alternative is to maintain a two-token lookahead buffer in the parser from the start, storing the next two tokens at all times. Either approach works.

### 1.4 Span construction

Every AST node carries a `span`. The start of a span is captured at the beginning of each parsing method; the end comes from the last token consumed:

```typescript
private spanFrom(start: SourceLocation): Span {
  return {
    start,
    end: this.previous.span.end,
  };
}
```

A typical parsing method starts with:

```typescript
const start = this.current.span.start;
// ... consume tokens ...
return { kind: "...", span: this.spanFrom(start), ... };
```

---

## 2. Recursive Descent Parsing of Modelica Grammar Rules

The parser is a **recursive descent parser** — each grammar rule maps to a private method. Methods call each other according to the grammar structure. The call stack reflects the nesting of the source being parsed.

### 2.1 Top-level: stored definition

A Modelica source file is a `stored_definition` — an optional `within` clause followed by one or more class definitions:

```
stored_definition :=
  [ "within" [ name ] ";" ]
  { [ "final" ] class_definition ";" }
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

  // One or more class definitions
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

### 2.2 Class definitions

`parseClassDefinition` is the largest parsing function. It handles the class restriction keyword (`model`, `block`, etc.), optional prefix modifiers, the class name, and the class body. It also distinguishes long-form class definitions from short-form ones.

```typescript
// isFinal is passed in because the "final" keyword is consumed at the call site
// (either at the stored-definition level or inside an element).
private parseClassDefinition(isFinal: boolean): ClassDefinition | ShortClassDefinition {
  const start = this.current.span.start;

  const isEncapsulated = this.match(TokenKind.Encapsulated);
  const isPartial = this.match(TokenKind.Partial);
  const isExpandable = this.match(TokenKind.Expandable);
  const isPure = this.match(TokenKind.Pure);
  const isImpure = this.match(TokenKind.Impure);

  const restriction = this.parseClassRestriction();
  const nameToken = this.expect(TokenKind.Identifier);
  const name = nameToken.value as string;

  // Short class definition: class_prefixes IDENT "=" ...
  // e.g.  type Length = Real(unit = "m");
  //       type Direction = enumeration(x, y, z);
  if (this.match(TokenKind.Equals)) {
    return this.parseShortClassBody(
      start, restriction, name,
      { isFinal, isEncapsulated, isPartial, isExpandable, isPure, isImpure }
    );
  }

  const comment = this.parseOptionalStringComment();

  // Parse composition (body): interleaved public/protected sections,
  // equation/algorithm sections, optional external declaration, optional annotation.
  const elements: Element[] = [];
  const equationSections: EquationSection[] = [];
  const algorithmSections: AlgorithmSection[] = [];
  let currentVisibility: Visibility = "public";
  let externalDecl: ExternalDeclaration | null = null;
  let annotation: Annotation | null = null;

  while (!this.check(TokenKind.End) && !this.check(TokenKind.EOF)) {
    if (this.match(TokenKind.Public)) {
      currentVisibility = "public";
    } else if (this.match(TokenKind.Protected)) {
      currentVisibility = "protected";
    } else if (this.check(TokenKind.Initial) && this.peekNextIs(TokenKind.Equation)) {
      this.advance(); // consume 'initial'
      this.advance(); // consume 'equation'
      equationSections.push(this.parseEquationSection(true));
    } else if (this.check(TokenKind.Initial) && this.peekNextIs(TokenKind.Algorithm)) {
      this.advance(); // consume 'initial'
      this.advance(); // consume 'algorithm'
      algorithmSections.push(this.parseAlgorithmSection(true));
    } else if (this.match(TokenKind.Equation)) {
      equationSections.push(this.parseEquationSection(false));
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
    restriction, name, isFinal, isEncapsulated, isPartial,
    isExpandable, isPure, isImpure,
    elements, equationSections, algorithmSections, externalDecl, annotation,
  };
}
```

`parseClassRestriction` maps the current keyword token to a `ClassRestriction` string. It handles the two-word forms `operator function` and `operator record` by checking for a second keyword after consuming `operator`:

```typescript
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
```

#### Short class definitions

A short class definition uses `=` immediately after the name. Two forms exist:

```typescript
private parseShortClassBody(
  start: SourceLocation,
  restriction: ClassRestriction,
  name: string,
  prefixes: { isFinal: boolean; isEncapsulated: boolean; isPartial: boolean;
              isExpandable: boolean; isPure: boolean; isImpure: boolean }
): ShortClassDefinition {
  if (this.match(TokenKind.Enumeration)) {
    this.expect(TokenKind.LParen);
    const enumeration = this.parseEnumerationList();
    this.expect(TokenKind.RParen);
    const comment = this.parseOptionalStringComment();
    const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;
    return {
      kind: "ShortClassDefinition", span: this.spanFrom(start),
      ...prefixes, restriction, name,
      baseType: null, arraySubscripts: [], modification: null,
      enumeration, annotation, comment,
    };
  }

  // Type specialisation: baseType name, optional array subscripts, optional modification
  const baseType = this.parseComponentReference();
  const arraySubscripts = this.check(TokenKind.LBracket)
    ? this.parseArraySubscripts() : [];
  const modification = this.check(TokenKind.LParen)
    ? this.parseClassModification() : null;
  const comment = this.parseOptionalStringComment();
  const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;

  return {
    kind: "ShortClassDefinition", span: this.spanFrom(start),
    ...prefixes, restriction, name,
    baseType, arraySubscripts, modification,
    enumeration: null, annotation, comment,
  };
}
```

### 2.3 Elements

Elements are the declarations inside a class body: component declarations, extends clauses, import clauses, and nested class definitions.

```typescript
private parseElement(visibility: Visibility): Element {
  const start = this.current.span.start;

  if (this.match(TokenKind.Import)) {
    const imp = this.parseImportClause(visibility, start);
    this.expect(TokenKind.Semicolon);
    return imp;
  }

  if (this.match(TokenKind.Extends)) {
    const ext = this.parseExtendsClause(visibility, start);
    this.expect(TokenKind.Semicolon);
    return ext;
  }

  // Collect prefix flags that appear before either a class definition or
  // a component declaration.
  const isRedeclare   = this.match(TokenKind.Redeclare);
  const isFinal       = this.match(TokenKind.Final);
  const isInner       = this.match(TokenKind.Inner);
  const isOuter       = this.match(TokenKind.Outer);
  const isReplaceable = this.match(TokenKind.Replaceable);

  // Nested class definition
  if (this.isClassRestrictionStart()) {
    const classDef = this.parseClassDefinition(isFinal);
    this.expect(TokenKind.Semicolon);
    return classDef;
  }

  // Component declaration
  return this.parseComponentDeclaration(visibility, {
    isRedeclare, isFinal, isInner, isOuter, isReplaceable
  });
}

// Returns true if the current token could begin a class restriction,
// including prefixes like 'partial', 'encapsulated', 'expandable'.
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

### 2.4 Component declarations

```typescript
private parseComponentDeclaration(
  visibility: Visibility,
  prefixes: { isRedeclare: boolean; isFinal: boolean;
              isInner: boolean; isOuter: boolean; isReplaceable: boolean }
): ComponentDeclaration {
  const start = this.current.span.start;

  // Type prefixes
  const isFlow   = this.match(TokenKind.Flow);
  const isStream = this.match(TokenKind.Stream);

  let variability: Variability = null;
  if      (this.match(TokenKind.Parameter)) variability = "parameter";
  else if (this.match(TokenKind.Constant))  variability = "constant";
  else if (this.match(TokenKind.Discrete))  variability = "discrete";

  let causality: Causality = null;
  if      (this.match(TokenKind.Input))  causality = "input";
  else if (this.match(TokenKind.Output)) causality = "output";

  const typeName        = this.parseComponentReference();
  const nameToken       = this.expect(TokenKind.Identifier);
  const name            = nameToken.value as string;
  const arraySubscripts = this.check(TokenKind.LBracket)
    ? this.parseArraySubscripts() : [];

  const modification = this.check(TokenKind.LParen) || this.check(TokenKind.Equals)
    ? this.parseModification() : null;

  // Optional condition attribute: component is only present if condition is true
  const conditionAttribute = this.match(TokenKind.If)
    ? this.parseExpression() : null;

  // Optional constrainedby clause — only meaningful on replaceable components
  const constrainedBy = this.match(TokenKind.ConstrainedBy)
    ? this.parseConstrainedByClause() : null;

  const comment    = this.parseOptionalStringComment();
  const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;

  this.expect(TokenKind.Semicolon);

  return {
    kind: "ComponentDeclaration",
    span: this.spanFrom(start),
    visibility, ...prefixes, isFlow, isStream,
    variability, causality, typeName, name, arraySubscripts,
    modification, conditionAttribute, constrainedBy, annotation, comment,
  };
}
```

### 2.5 Modifications

Modifications are the most recursive construct in the grammar. The grammar is:

```
modification         := class_modification [ "=" expression ]
                      | "=" expression
class_modification   := "(" { element_modification "," } ")"
element_modification := [ "each" ] [ "final" ] name [ modification ]
```

The recursion is: `parseModification` → `parseClassModification` → `parseElementModification` → `parseModification`. This handles arbitrary nesting like `R1(p(v(start = 0)))`.

```typescript
private parseModification(): Modification {
  const start = this.current.span.start;

  const classModification = this.check(TokenKind.LParen)
    ? this.parseClassModification() : null;

  const bindingExpression = this.match(TokenKind.Equals)
    ? this.parseExpression() : null;

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

  const args: ElementModification[] = [];
  if (!this.check(TokenKind.RParen)) {
    args.push(this.parseElementModification());
    while (this.match(TokenKind.Comma)) {
      if (this.check(TokenKind.RParen)) break; // trailing comma
      args.push(this.parseElementModification());
    }
  }

  this.expect(TokenKind.RParen);
  return { kind: "ClassModification", span: this.spanFrom(start), arguments: args };
}

private parseElementModification(): ElementModification {
  const start = this.current.span.start;

  const isEach  = this.match(TokenKind.Each);
  const isFinal = this.match(TokenKind.Final);
  const name    = this.parseComponentReference();

  const modification = this.check(TokenKind.LParen) || this.check(TokenKind.Equals)
    ? this.parseModification() : null;

  return {
    kind: "ElementModification",
    span: this.spanFrom(start),
    isFinal, isEach, name, modification,
  };
}
```

### 2.6 Equation sections

```typescript
private parseEquationSection(isInitial: boolean): EquationSection {
  const start = this.current.span.start;
  const equations: EquationNode[] = [];

  while (!this.isSectionEnd()) {
    equations.push(this.parseEquation());
    this.expect(TokenKind.Semicolon);
  }

  return { kind: "EquationSection", span: this.spanFrom(start), isInitial, equations };
}

// Returns true if the current token begins a new section or ends the class body.
// Used to know when the current equation or algorithm section is finished.
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

### 2.7 Individual equations

The five equation forms are distinguished by their leading token. The tricky case is distinguishing a simple equation (`lhs = rhs`) from a function-call equation (`name(args)`) — both can start with an identifier. The parser resolves this by parsing the left side as an expression and then inspecting the result:

```typescript
private parseEquation(): EquationNode {
  const start = this.current.span.start;

  if (this.match(TokenKind.Connect)) return this.parseConnectEquation(start);
  if (this.match(TokenKind.If))      return this.parseIfEquation(start);
  if (this.match(TokenKind.For))     return this.parseForEquation(start);
  if (this.match(TokenKind.When))    return this.parseWhenEquation(start);

  // Parse the left side. This may produce a FunctionCallExpr (e.g. assert(...))
  // or any other expression (e.g. a component reference or arithmetic expression).
  const lhs = this.parseExpression();

  // If it's a function call and there's no '=' following, it's a function-call equation.
  if (lhs.kind === "FunctionCallExpr" && !this.check(TokenKind.Equals)) {
    const comment    = this.parseOptionalStringComment();
    const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;
    return {
      kind: "FunctionCallEquation",
      span: this.spanFrom(start),
      name: lhs.name, args: lhs.args, annotation, comment,
    };
  }

  // Simple equation: lhs = rhs
  this.expect(TokenKind.Equals);
  const rhs        = this.parseExpression();
  const comment    = this.parseOptionalStringComment();
  const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;

  return {
    kind: "SimpleEquation",
    span: this.spanFrom(start),
    lhs, rhs, annotation, comment,
  };
}
```

The connect, for, and when equation parsers:

```typescript
private parseConnectEquation(start: SourceLocation): ConnectEquation {
  this.expect(TokenKind.LParen);
  const from = this.parseComponentReference();
  this.expect(TokenKind.Comma);
  const to   = this.parseComponentReference();
  this.expect(TokenKind.RParen);
  const comment    = this.parseOptionalStringComment();
  const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;
  return { kind: "ConnectEquation", span: this.spanFrom(start), from, to, annotation, comment };
}

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

  const comment    = this.parseOptionalStringComment();
  const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;
  return { kind: "ForEquation", span: this.spanFrom(start), iterators, equations, annotation, comment };
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
  const range = this.match(TokenKind.In) ? this.parseExpressionOrRange() : null;
  return { name: nameToken.value as string, range };
}
```

The if-equation and when-equation parsers follow the same pattern — parse condition-body branches as pairs, collect them in an array, and close with `end if` or `end when`.

### 2.8 Statement parsing

Statements appear inside `algorithm` sections. The main differences from equations are `:=` for assignment, `while` loops, and `break`/`return`.

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
  if (this.check(TokenKind.LParen)) return this.parseTupleAssignment(start);

  if (this.match(TokenKind.If))     return this.parseIfStatement(start);
  if (this.match(TokenKind.For))    return this.parseForStatement(start);
  if (this.match(TokenKind.While))  return this.parseWhileStatement(start);
  if (this.match(TokenKind.When))   return this.parseWhenStatement(start);
  if (this.match(TokenKind.Return)) return { kind: "ReturnStatement", span: this.spanFrom(start) };
  if (this.match(TokenKind.Break))  return { kind: "BreakStatement",  span: this.spanFrom(start) };

  // Either a single-variable assignment or a function-call statement.
  const ref = this.parseComponentReference();

  if (this.check(TokenKind.LParen)) {
    const args = this.parseFunctionArguments();
    return { kind: "FunctionCallStatement", span: this.spanFrom(start), name: ref, args };
  }

  this.expect(TokenKind.Assign);
  const value = this.parseExpression();
  return { kind: "AssignmentStatement", span: this.spanFrom(start), target: ref, value };
}

private parseTupleAssignment(start: SourceLocation): AssignmentStatement {
  this.expect(TokenKind.LParen);
  const components: ComponentReference[] = [];
  if (!this.check(TokenKind.RParen)) {
    components.push(this.parseComponentReference());
    while (this.match(TokenKind.Comma)) {
      components.push(this.parseComponentReference());
    }
  }
  this.expect(TokenKind.RParen);
  this.expect(TokenKind.Assign);
  const value = this.parseExpression();
  return { kind: "AssignmentStatement", span: this.spanFrom(start), target: { components }, value };
}
```

### 2.9 Component references

A component reference is a dotted name with optional array subscripts at each level: `a.b[1].c[2,3]`. It appears in expressions, type names, modification names, and connect arguments.

```typescript
private parseComponentReference(): ComponentReference {
  const isGlobal = this.match(TokenKind.Dot); // leading '.' means global lookup
  const parts: ComponentReferencePart[] = [];

  // First part: identifier or 'der' keyword (der is also valid as a component name)
  const first = this.check(TokenKind.Der)
    ? (this.advance(), "der")
    : (this.expect(TokenKind.Identifier).value as string);

  const firstSubs = this.check(TokenKind.LBracket) ? this.parseArraySubscripts() : [];
  parts.push({ name: first, subscripts: firstSubs });

  // Subsequent dotted parts
  while (this.match(TokenKind.Dot)) {
    const name = this.expect(TokenKind.Identifier).value as string;
    const subs = this.check(TokenKind.LBracket) ? this.parseArraySubscripts() : [];
    parts.push({ name, subscripts: subs });
  }

  return { isGlobal, parts };
}

private parseArraySubscripts(): Expression[] {
  this.expect(TokenKind.LBracket);
  const subscripts = [this.parseSubscript()];
  while (this.match(TokenKind.Comma)) {
    subscripts.push(this.parseSubscript());
  }
  this.expect(TokenKind.RBracket);
  return subscripts;
}

// A subscript is either a bare ':' (all indices) or an expression (possibly a range).
private parseSubscript(): Expression {
  const start = this.current.span.start;
  if (this.match(TokenKind.Colon)) {
    return { kind: "ColonExpr", span: this.spanFrom(start) };
  }
  return this.parseExpressionOrRange();
}
```

### 2.10 Annotations and string comments

```typescript
private parseAnnotation(): Annotation {
  const start = this.current.span.start;
  this.expect(TokenKind.Annotation);
  const classModification = this.parseClassModification();
  return { kind: "Annotation", span: this.spanFrom(start), classModification };
}

private parseOptionalStringComment(): string | null {
  if (this.check(TokenKind.StringLiteral)) {
    return this.advance().value as string;
  }
  return null;
}
```

---

## 3. Pratt (Precedence Climbing) Parser for Expressions

Expression parsing is where recursive descent on its own becomes awkward — Modelica has roughly 10 precedence levels and mixed associativity. A Pratt parser handles this with a single function and a binding-power table.

### 3.1 The core idea

Each infix operator has a **left binding power** and a **right binding power**. The parser tracks a minimum binding power (`minBP`). It stops collecting infix operators when it encounters one whose left binding power is less than `minBP`. The right binding power of the consumed operator becomes the `minBP` for the recursive right-operand parse.

- **Left-associative:** `right = left + 1`. After parsing `a + b`, the next `+` has left BP equal to `minBP`, so it does not get absorbed into the right operand — it becomes the next iteration at the outer level, producing `(a + b) + c`.
- **Right-associative:** `right = left - 1`. After parsing `a`, the `^` starts a right-operand parse with a lower `minBP`, so the next `^` *does* get absorbed — producing `a ^ (b ^ c)`.
- **Non-associative:** `right = left + 1` (same as left-associative). After `a < b`, the second `<` would need to nest inside the first's right operand, but the BP check prevents it — producing a parse error, which is correct for Modelica.

### 3.2 Precedence table

Modelica operator precedence from lowest to highest:

| Level | Operators | Associativity |
|---|---|---|
| 1 | `or` | left |
| 2 | `and` | left |
| 3 | `not` | prefix |
| 4 | `<`, `<=`, `>`, `>=`, `==`, `<>` | non-associative |
| 5 | `+`, `-`, `.+`, `.-` | left |
| 6 | `*`, `/`, `.*`, `./` | left |
| 7 | unary `+`, unary `-` | prefix |
| 8 | `^`, `.^` | right |

`if-then-else` expressions and unary `not` are handled as prefix constructs, not as infix operators.

```typescript
const enum BP {
  None           = 0,
  Or             = 2,
  And            = 4,
  Not            = 6,
  Comparison     = 8,
  Addition       = 10,
  Multiplication = 12,
  UnarySign      = 14,
  Power          = 16,
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
      return { left: BP.Power, right: BP.Power - 1 }; // right-associative
    default:
      return null;
  }
}
```

### 3.3 The parsing function

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
    const operand = this.parseExpression(BP.Not);
    left = { kind: "UnaryExpr", span: this.spanFrom(start), op: "not", operand };
  } else if (this.check(TokenKind.Minus) || this.check(TokenKind.Plus)) {
    const op = this.advance().kind === TokenKind.Minus ? "-" : "+";
    const operand = this.parseExpression(BP.UnarySign);
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

The function has two halves. The **prefix half** (top) parses atoms and prefix operators. The **infix loop** (bottom) repeatedly checks whether the next token is an infix operator with sufficient binding power; if so, it consumes the operator, recursively parses the right operand, and folds the result into `left`.

### 3.4 Component references and function calls

When the prefix parser encounters an identifier, it could be a variable reference (`x`), a dotted path (`R1.p.v`), or a function call (`sin(x)`, `der(x)`). These share a common prefix — parse the component reference first, then check for `(`:

```typescript
private parseComponentReferenceOrFunctionCall(start: SourceLocation): Expression {
  const ref = this.parseComponentReference();

  if (this.check(TokenKind.LParen)) {
    const args = this.parseFunctionArguments();
    return { kind: "FunctionCallExpr", span: this.spanFrom(start), name: ref, args };
  }

  return { kind: "ComponentReference", span: this.spanFrom(start), ref };
}
```

`der(x)` falls out naturally — the `der` keyword token is parsed as a component reference with a single part `{ name: "der", subscripts: [] }`, then the `(` triggers function-call parsing. No special case is needed.

### 3.5 Range expressions

Range expressions (`1:N`, `1:2:N`) are **not** handled as infix operators in the Pratt parser — the colon is not given a binding power. Instead, ranges are parsed as a post-Pratt check in contexts where ranges are expected (for-iterator ranges and array subscripts). This avoids ambiguity with the colon in `:=`.

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

### 3.6 Function arguments

Function arguments can be positional, named (`name = value`), or include for-iterators (for array comprehensions):

```typescript
private parseFunctionArguments(): FunctionArguments {
  this.expect(TokenKind.LParen);

  const positional: Expression[] = [];
  const named: { name: string; value: Expression }[] = [];
  let forIterators: ForIterator[] | null = null;

  if (!this.check(TokenKind.RParen)) {
    this.parseFunctionArgumentList(positional, named);
    if (this.match(TokenKind.For)) {
      forIterators = this.parseForIterators();
    }
  }

  this.expect(TokenKind.RParen);
  return { positional, named, forIterators };
}
```

Distinguishing named from positional arguments requires checking if the current token is an identifier followed by `=` (but not `==`). This is one of the places where two-token lookahead is useful — peek ahead to confirm `=` before consuming the identifier name.

### 3.7 If-expression

```typescript
private parseIfExpression(start: SourceLocation): IfExpr {
  const condition = this.parseExpression();
  this.expect(TokenKind.Then);
  const thenExpr = this.parseExpression();

  const elseIfs: { condition: Expression; value: Expression }[] = [];
  while (this.match(TokenKind.ElseIf)) {
    const c = this.parseExpression();
    this.expect(TokenKind.Then);
    const v = this.parseExpression();
    elseIfs.push({ condition: c, value: v });
  }

  this.expect(TokenKind.Else);
  const elseExpr = this.parseExpression();

  return { kind: "IfExpr", span: this.spanFrom(start), condition, thenExpr, elseIfs, elseExpr };
}
```

### 3.8 `tokenToOp` helper

After consuming an infix operator token in the Pratt loop, `tokenToOp` maps the `TokenKind` to the `BinaryOp` string expected by the AST node:

```typescript
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

## 4. Error Reporting and Recovery

### 4.1 Error reporting

The parser uses the current token's source location in all error messages:

```typescript
private error(message: string): Error {
  const loc = this.current.span.start;
  return new Error(`${loc.file}:${loc.line}:${loc.column}: ${message}`);
}
```

`expect` uses this to produce specific messages when a required token is missing. The default message names both the expected and the actual token kind; callers can supply a more descriptive message when the default is confusing:

```typescript
this.expect(TokenKind.Semicolon, "Expected ';' after class definition");
```

The class name match check at the end of `parseClassDefinition` is an example of a context-sensitive error:

```typescript
if ((endName.value as string) !== name) {
  throw this.error(
    `Mismatched class name: opened '${name}', closed '${endName.value}'`
  );
}
```

### 4.2 Panic mode (initial strategy)

The initial implementation uses **panic mode**: when an unexpected token is encountered, throw immediately. The error propagates up the call stack and is caught at the top-level entry point, which prints the message and exits. This stops at the first error.

Panic mode is sufficient for early development. It is simple, requires no extra bookkeeping, and produces precise error messages with source locations.

### 4.3 Error recovery (future improvement)

For better user experience, the parser can be extended to report multiple errors per run. The strategy is **synchronization**: catch the thrown error inside a section-parsing loop, skip tokens until a synchronization point, then resume. Synchronization points are tokens that reliably begin a new construct — typically:

- `;` (end of an element or equation)
- `end` (end of a class body)
- `equation`, `algorithm`, `public`, `protected` (beginning of a new section)
- `model`, `block`, `connector`, etc. (beginning of a new class definition)

This is an additive change to the existing structure — the recursive descent architecture naturally supports recovery because each parsing method has a clear scope within which it can catch and recover.

### 4.4 Expected-token sets (future improvement)

When `expect` fails, the error names one expected token. A richer version can collect the full set of tokens that would be valid at the current point and include them in the message:

```
tests/Bad.mo:7:3: Unexpected 'equation' — expected one of: identifier, 'extends', 'import'
```

This requires passing context from calling functions down into `expect`, which is a minor restructuring. It does not change the parser's correctness and can be deferred until the initial implementation is working.
