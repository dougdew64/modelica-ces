import { assert, assertEquals, assertInstanceOf } from "@std/assert";
import { KEYWORDS, TokenKind } from "../../../src/phase1/data-structures.ts";
import type {
  AlgorithmSection,
  Annotation,
  AssignmentStatement,
  BinaryExpr,
  ClassDefinition,
  ClassModification,
  ComponentDeclaration,
  ComponentReference,
  ConnectEquation,
  ConstrainedByClause,
  ElementModification,
  EquationSection,
  ExtendsClause,
  ExternalDeclaration,
  FunctionArguments,
  FunctionCallExpr,
  ImportClause,
  Modification,
  ShortClassDefinition,
  SimpleEquation,
  Span,
  SourceLocation,
  StoredDefinition,
  Token,
  UnaryExpr,
} from "../../../src/phase1/data-structures.ts";

// =============================================================================
// Helpers
// =============================================================================

function makeLocation(): SourceLocation {
  return { file: "test.mo", line: 1, column: 1, offset: 0 };
}

function makeSpan(): Span {
  return { start: makeLocation(), end: makeLocation() };
}

function makeRef(): ComponentReference {
  return { isGlobal: false, parts: [{ name: "x", subscripts: [] }] };
}

function makeArgs(): FunctionArguments {
  return { positional: [], named: [], forIterators: null };
}

// =============================================================================
// TokenKind enum
// =============================================================================

Deno.test("U-TK-1: TokenKind is exported and is a non-null object", () => {
  assert(TokenKind !== null && TokenKind !== undefined);
  assertEquals(typeof TokenKind, "object");
});

Deno.test("U-TK-2: literal kinds exist", () => {
  assertEquals(typeof TokenKind.IntegerLiteral, "number");
  assertEquals(typeof TokenKind.RealLiteral, "number");
  assertEquals(typeof TokenKind.StringLiteral, "number");
  assertEquals(typeof TokenKind.BooleanLiteral, "number");
});

Deno.test("U-TK-3: Identifier kind exists", () => {
  assertEquals(typeof TokenKind.Identifier, "number");
});

Deno.test("U-TK-4: spot-check keyword kinds exist", () => {
  assertEquals(typeof TokenKind.Algorithm, "number");
  assertEquals(typeof TokenKind.Model, "number");
  assertEquals(typeof TokenKind.Equation, "number");
  assertEquals(typeof TokenKind.Function, "number");
  assertEquals(typeof TokenKind.Within, "number");
});

Deno.test("U-TK-5: spot-check operator and punctuation kinds exist", () => {
  assertEquals(typeof TokenKind.LParen, "number");
  assertEquals(typeof TokenKind.Assign, "number");
  assertEquals(typeof TokenKind.EqualEqual, "number");
  assertEquals(typeof TokenKind.NotEqual, "number");
  assertEquals(typeof TokenKind.DotPower, "number");
});

Deno.test("U-TK-6: EOF kind exists", () => {
  assertEquals(typeof TokenKind.EOF, "number");
});

Deno.test("U-TK-7: all TokenKind values are unique", () => {
  const numericValues = Object.values(TokenKind).filter(
    (v) => typeof v === "number",
  ) as number[];
  const uniqueValues = new Set(numericValues);
  assertEquals(uniqueValues.size, numericValues.length);
});

Deno.test("U-TK-8: TokenKind has exactly 93 members", () => {
  // 4 literals + 1 identifier + 59 keywords + 28 operators/punctuation + 1 EOF
  const numericValues = Object.values(TokenKind).filter(
    (v) => typeof v === "number",
  );
  assertEquals(numericValues.length, 93);
});

// =============================================================================
// KEYWORDS map
// =============================================================================

Deno.test("U-KW-1: KEYWORDS is exported and is a Map", () => {
  assertInstanceOf(KEYWORDS, Map);
});

Deno.test("U-KW-2: KEYWORDS has exactly 59 entries", () => {
  assertEquals(KEYWORDS.size, 59);
});

Deno.test("U-KW-3: spot-check keyword mappings", () => {
  assertEquals(KEYWORDS.get("model"), TokenKind.Model);
  assertEquals(KEYWORDS.get("equation"), TokenKind.Equation);
  assertEquals(KEYWORDS.get("algorithm"), TokenKind.Algorithm);
  assertEquals(KEYWORDS.get("within"), TokenKind.Within);
});

Deno.test('U-KW-4: "true" and "false" map to their keyword kinds', () => {
  assertEquals(KEYWORDS.get("true"), TokenKind.True);
  assertEquals(KEYWORDS.get("false"), TokenKind.False);
});

Deno.test('U-KW-5: "der" maps to TokenKind.Der', () => {
  assertEquals(KEYWORDS.get("der"), TokenKind.Der);
});

Deno.test("U-KW-6: built-in type names are absent from KEYWORDS", () => {
  assert(!KEYWORDS.has("Real"));
  assert(!KEYWORDS.has("Integer"));
  assert(!KEYWORDS.has("Boolean"));
  assert(!KEYWORDS.has("String"));
});

Deno.test("U-KW-7: all keyword strings in KEYWORDS are lowercase", () => {
  for (const key of KEYWORDS.keys()) {
    assertEquals(key, key.toLowerCase());
  }
});

Deno.test("U-KW-8: every keyword TokenKind value is present in KEYWORDS", () => {
  const expectedKeywordKinds = [
    TokenKind.Algorithm, TokenKind.And, TokenKind.Annotation, TokenKind.Block,
    TokenKind.Break, TokenKind.Class, TokenKind.Connect, TokenKind.Connector,
    TokenKind.Constant, TokenKind.ConstrainedBy, TokenKind.Der,
    TokenKind.Discrete, TokenKind.Each, TokenKind.Else, TokenKind.ElseIf,
    TokenKind.ElseWhen, TokenKind.Encapsulated, TokenKind.End,
    TokenKind.Enumeration, TokenKind.Equation, TokenKind.Expandable,
    TokenKind.Extends, TokenKind.External, TokenKind.False, TokenKind.Final,
    TokenKind.Flow, TokenKind.For, TokenKind.Function, TokenKind.If,
    TokenKind.Import, TokenKind.Impure, TokenKind.In, TokenKind.Initial,
    TokenKind.Inner, TokenKind.Input, TokenKind.Loop, TokenKind.Model,
    TokenKind.Not, TokenKind.Operator, TokenKind.Or, TokenKind.Outer,
    TokenKind.Output, TokenKind.Package, TokenKind.Parameter, TokenKind.Partial,
    TokenKind.Protected, TokenKind.Public, TokenKind.Pure, TokenKind.Record,
    TokenKind.Redeclare, TokenKind.Replaceable, TokenKind.Return,
    TokenKind.Stream, TokenKind.Then, TokenKind.True, TokenKind.Type,
    TokenKind.When, TokenKind.While, TokenKind.Within,
  ];
  const mapValues = new Set(KEYWORDS.values());
  for (const kind of expectedKeywordKinds) {
    assert(
      mapValues.has(kind),
      `TokenKind.${TokenKind[kind]} is missing from KEYWORDS`,
    );
  }
});

// =============================================================================
// Source location types
// =============================================================================

Deno.test("U-SL-1: SourceLocation has correct property types", () => {
  const loc: SourceLocation = { file: "test.mo", line: 1, column: 1, offset: 0 };
  assertEquals(typeof loc.file, "string");
  assertEquals(typeof loc.line, "number");
  assertEquals(typeof loc.column, "number");
  assertEquals(typeof loc.offset, "number");
});

Deno.test("U-SL-2: Span has start and end SourceLocation properties", () => {
  const span: Span = { start: makeLocation(), end: makeLocation() };
  assertEquals(typeof span.start, "object");
  assertEquals(typeof span.end, "object");
  assertEquals(typeof span.start.offset, "number");
  assertEquals(typeof span.end.offset, "number");
});

// =============================================================================
// Token interface
// =============================================================================

Deno.test("U-TOK-1: keyword token has kind and span and no value", () => {
  const token: Token = { kind: TokenKind.Model, span: makeSpan() };
  assertEquals(typeof token.kind, "number");
  assertEquals(typeof token.span, "object");
  assert(token.value === undefined);
});

Deno.test("U-TOK-2: identifier token has string value", () => {
  const token: Token = {
    kind: TokenKind.Identifier,
    span: makeSpan(),
    value: "myVar",
  };
  assertEquals(typeof token.value, "string");
});

Deno.test("U-TOK-3: integer literal token has number value", () => {
  const token: Token = {
    kind: TokenKind.IntegerLiteral,
    span: makeSpan(),
    value: 42,
  };
  assertEquals(typeof token.value, "number");
});

Deno.test("U-TOK-4: boolean literal token has boolean value", () => {
  const token: Token = {
    kind: TokenKind.True,
    span: makeSpan(),
    value: true,
  };
  assertEquals(typeof token.value, "boolean");
});

// =============================================================================
// AST node kind discriminants
// =============================================================================

Deno.test('U-AST-1: StoredDefinition kind is "StoredDefinition"', () => {
  const node: StoredDefinition = {
    kind: "StoredDefinition",
    span: makeSpan(),
    withinPath: null,
    classDefinitions: [],
  };
  assertEquals(node.kind, "StoredDefinition");
});

Deno.test('U-AST-2: ClassDefinition kind is "ClassDefinition"', () => {
  const node: ClassDefinition = {
    kind: "ClassDefinition",
    span: makeSpan(),
    restriction: "model",
    name: "Test",
    isFinal: false,
    isEncapsulated: false,
    isPartial: false,
    isExpandable: false,
    isPure: false,
    isImpure: false,
    elements: [],
    equationSections: [],
    algorithmSections: [],
    externalDecl: null,
    annotation: null,
  };
  assertEquals(node.kind, "ClassDefinition");
});

Deno.test('U-AST-3: ShortClassDefinition kind is "ShortClassDefinition"', () => {
  const node: ShortClassDefinition = {
    kind: "ShortClassDefinition",
    span: makeSpan(),
    restriction: "type",
    name: "MyType",
    isFinal: false,
    isEncapsulated: false,
    isPartial: false,
    isExpandable: false,
    isPure: false,
    isImpure: false,
    baseType: makeRef(),
    arraySubscripts: [],
    modification: null,
    enumeration: null,
    annotation: null,
    comment: null,
  };
  assertEquals(node.kind, "ShortClassDefinition");
});

Deno.test('U-AST-4: ComponentDeclaration kind is "ComponentDeclaration"', () => {
  const node: ComponentDeclaration = {
    kind: "ComponentDeclaration",
    span: makeSpan(),
    visibility: "public",
    isFinal: false,
    isInner: false,
    isOuter: false,
    isRedeclare: false,
    isReplaceable: false,
    isFlow: false,
    isStream: false,
    variability: null,
    causality: null,
    typeName: makeRef(),
    name: "x",
    arraySubscripts: [],
    modification: null,
    conditionAttribute: null,
    constrainedBy: null,
    annotation: null,
    comment: null,
  };
  assertEquals(node.kind, "ComponentDeclaration");
});

Deno.test('U-AST-5: ExtendsClause kind is "ExtendsClause"', () => {
  const node: ExtendsClause = {
    kind: "ExtendsClause",
    span: makeSpan(),
    visibility: "public",
    baseName: makeRef(),
    modification: null,
    annotation: null,
  };
  assertEquals(node.kind, "ExtendsClause");
});

Deno.test('U-AST-6: ImportClause kind is "ImportClause"', () => {
  const node: ImportClause = {
    kind: "ImportClause",
    span: makeSpan(),
    visibility: "public",
    path: makeRef(),
    alias: null,
    isWildcard: false,
    importedNames: null,
  };
  assertEquals(node.kind, "ImportClause");
});

Deno.test('U-AST-7: ConstrainedByClause kind is "ConstrainedByClause"', () => {
  const node: ConstrainedByClause = {
    kind: "ConstrainedByClause",
    span: makeSpan(),
    typeName: makeRef(),
    modification: null,
  };
  assertEquals(node.kind, "ConstrainedByClause");
});

Deno.test('U-AST-8: Modification kind is "Modification"', () => {
  const node: Modification = {
    kind: "Modification",
    span: makeSpan(),
    classModification: null,
    bindingExpression: null,
  };
  assertEquals(node.kind, "Modification");
});

Deno.test('U-AST-9: ClassModification kind is "ClassModification"', () => {
  const node: ClassModification = {
    kind: "ClassModification",
    span: makeSpan(),
    arguments: [],
  };
  assertEquals(node.kind, "ClassModification");
});

Deno.test('U-AST-10: ElementModification kind is "ElementModification"', () => {
  const node: ElementModification = {
    kind: "ElementModification",
    span: makeSpan(),
    isFinal: false,
    isEach: false,
    name: makeRef(),
    modification: null,
  };
  assertEquals(node.kind, "ElementModification");
});

Deno.test('U-AST-11: Annotation kind is "Annotation"', () => {
  const classmod: ClassModification = {
    kind: "ClassModification",
    span: makeSpan(),
    arguments: [],
  };
  const node: Annotation = {
    kind: "Annotation",
    span: makeSpan(),
    classModification: classmod,
  };
  assertEquals(node.kind, "Annotation");
});

Deno.test('U-AST-12: EquationSection kind is "EquationSection"', () => {
  const node: EquationSection = {
    kind: "EquationSection",
    span: makeSpan(),
    isInitial: false,
    equations: [],
  };
  assertEquals(node.kind, "EquationSection");
});

Deno.test('U-AST-13: SimpleEquation kind is "SimpleEquation"', () => {
  const lhs = { kind: "IntegerLiteral" as const, span: makeSpan(), value: 0 };
  const node: SimpleEquation = {
    kind: "SimpleEquation",
    span: makeSpan(),
    lhs,
    rhs: lhs,
    annotation: null,
    comment: null,
  };
  assertEquals(node.kind, "SimpleEquation");
});

Deno.test('U-AST-14: ConnectEquation kind is "ConnectEquation"', () => {
  const node: ConnectEquation = {
    kind: "ConnectEquation",
    span: makeSpan(),
    from: makeRef(),
    to: makeRef(),
    annotation: null,
    comment: null,
  };
  assertEquals(node.kind, "ConnectEquation");
});

Deno.test('U-AST-15: AlgorithmSection kind is "AlgorithmSection"', () => {
  const node: AlgorithmSection = {
    kind: "AlgorithmSection",
    span: makeSpan(),
    isInitial: false,
    statements: [],
  };
  assertEquals(node.kind, "AlgorithmSection");
});

Deno.test('U-AST-16: AssignmentStatement kind is "AssignmentStatement"', () => {
  const rhs = { kind: "IntegerLiteral" as const, span: makeSpan(), value: 0 };
  const node: AssignmentStatement = {
    kind: "AssignmentStatement",
    span: makeSpan(),
    target: makeRef(),
    value: rhs,
  };
  assertEquals(node.kind, "AssignmentStatement");
});

Deno.test('U-AST-17: BinaryExpr kind is "BinaryExpr"', () => {
  const operand = { kind: "IntegerLiteral" as const, span: makeSpan(), value: 1 };
  const node: BinaryExpr = {
    kind: "BinaryExpr",
    span: makeSpan(),
    op: "+",
    left: operand,
    right: operand,
  };
  assertEquals(node.kind, "BinaryExpr");
});

Deno.test('U-AST-18: UnaryExpr kind is "UnaryExpr"', () => {
  const operand = { kind: "IntegerLiteral" as const, span: makeSpan(), value: 1 };
  const node: UnaryExpr = {
    kind: "UnaryExpr",
    span: makeSpan(),
    op: "-",
    operand,
  };
  assertEquals(node.kind, "UnaryExpr");
});

Deno.test('U-AST-19: FunctionCallExpr kind is "FunctionCallExpr"', () => {
  const node: FunctionCallExpr = {
    kind: "FunctionCallExpr",
    span: makeSpan(),
    name: makeRef(),
    args: makeArgs(),
  };
  assertEquals(node.kind, "FunctionCallExpr");
});

Deno.test('U-AST-20: ExternalDeclaration kind is "ExternalDeclaration"', () => {
  const node: ExternalDeclaration = {
    kind: "ExternalDeclaration",
    span: makeSpan(),
    language: null,
    functionName: null,
    args: [],
    returnVar: null,
    annotation: null,
  };
  assertEquals(node.kind, "ExternalDeclaration");
});
