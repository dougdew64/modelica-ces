// =============================================================================
// Source locations
// =============================================================================

export interface SourceLocation {
  file: string;
  line: number;   // 1-based
  column: number; // 1-based
  offset: number; // 0-based byte offset into the source string
}

export interface Span {
  start: SourceLocation;
  end: SourceLocation;
}

// =============================================================================
// Tokens
// =============================================================================

export enum TokenKind {
  // Literals (4)
  IntegerLiteral,
  RealLiteral,
  StringLiteral,
  BooleanLiteral,

  // Identifiers (1)
  Identifier,

  // Keywords (59)
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

  // Punctuation and operators (28)
  LParen,        // (
  RParen,        // )
  LBracket,      // [
  RBracket,      // ]
  LBrace,        // {
  RBrace,        // }
  Dot,           // .
  Comma,         // ,
  Semicolon,     // ;
  Colon,         // :
  Equals,        // =
  Assign,        // :=
  Plus,          // +
  Minus,         // -
  Star,          // *
  Slash,         // /
  Power,         // ^
  DotPlus,       // .+
  DotMinus,      // .-
  DotStar,       // .*
  DotSlash,      // ./
  DotPower,      // .^
  LessThan,      // <
  LessEqual,     // <=
  GreaterThan,   // >
  GreaterEqual,  // >=
  EqualEqual,    // ==
  NotEqual,      // <>

  // Special (1)
  EOF,
}

export interface Token {
  kind: TokenKind;
  span: Span;
  value?: string | number | boolean;
  // Identifier and StringLiteral: string
  // IntegerLiteral and RealLiteral: number
  // BooleanLiteral: boolean
  // Keywords and punctuation: undefined
}

// =============================================================================
// Keyword lookup
// =============================================================================

export const KEYWORDS: Map<string, TokenKind> = new Map([
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

// =============================================================================
// AST node types
// =============================================================================

// --- Component references ---

export interface ComponentReferencePart {
  name: string;
  subscripts: Expression[];
}

export interface ComponentReference {
  isGlobal: boolean;
  parts: ComponentReferencePart[];
}

// --- Top-level ---

export interface StoredDefinition {
  kind: "StoredDefinition";
  span: Span;
  withinPath: ComponentReference | null;
  classDefinitions: StoredClassEntry[];
}

export interface StoredClassEntry {
  isFinal: boolean;
  definition: ClassDefinition | ShortClassDefinition | DerClassDefinition;
}

// --- Class definitions ---

export type ClassRestriction =
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

export interface ClassDefinition {
  kind: "ClassDefinition";
  span: Span;
  restriction: ClassRestriction;
  name: string;
  isFinal: boolean;
  isEncapsulated: boolean;
  isPartial: boolean;
  isExpandable: boolean;
  isPure: boolean;
  isImpure: boolean;
  extending: { name: ComponentReference; modification: ClassModification | null } | null;
  constrainedBy: ConstrainedByClause | null;
  elements: Element[];
  equationSections: EquationSection[];
  algorithmSections: AlgorithmSection[];
  externalDecl: ExternalDeclaration | null;
  annotation: Annotation | null;
}

export interface ShortClassDefinition {
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
  basePrefix: { isInput: boolean; isOutput: boolean };
  isOpen: boolean;
  baseType: ComponentReference | null;
  arraySubscripts: Expression[];
  modification: ClassModification | null;
  enumeration: EnumerationLiteral[] | null;
  constrainedBy: ConstrainedByClause | null;
  annotation: Annotation | null;
  comment: string | null;
}

export interface DerClassDefinition {
  kind: "DerClassDefinition";
  span: Span;
  restriction: ClassRestriction;
  name: string;
  isFinal: boolean;
  isEncapsulated: boolean;
  isPartial: boolean;
  isExpandable: boolean;
  isPure: boolean;
  isImpure: boolean;
  baseFunction: ComponentReference;
  withRespectTo: string[];
  annotation: Annotation | null;
  comment: string | null;
}

export interface EnumerationLiteral {
  name: string;
  comment: string | null;
  annotation: Annotation | null;
}

// --- Elements ---

export type Element =
  | ComponentDeclaration
  | ExtendsClause
  | ImportClause
  | ClassDefinition
  | ShortClassDefinition
  | DerClassDefinition;

export type Visibility = "public" | "protected";
export type Variability = "parameter" | "constant" | "discrete" | null;
export type Causality = "input" | "output" | null;

export interface ComponentDeclaration {
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
  typeArraySubscripts: Expression[];
  name: string;
  nameArraySubscripts: Expression[];
  modification: Modification | null;
  conditionAttribute: Expression | null;
  constrainedBy: ConstrainedByClause | null;
  annotation: Annotation | null;
  comment: string | null;
}

// Non-recursive component clause used inside redeclarations and replaceables.
export interface ComponentClause1 {
  kind: "ComponentClause1";
  span: Span;
  typeName: ComponentReference;
  typeArraySubscripts: Expression[];
  name: string;
  nameArraySubscripts: Expression[];
  modification: Modification | null;
  comment: string | null;
}

export interface ExtendsClause {
  kind: "ExtendsClause";
  span: Span;
  visibility: Visibility;
  baseName: ComponentReference;
  modification: Modification | null;
  annotation: Annotation | null;
}

export interface ImportClause {
  kind: "ImportClause";
  span: Span;
  visibility: Visibility;
  path: ComponentReference;
  alias: string | null;
  isWildcard: boolean;
  importedNames: string[] | null;
}

export interface ConstrainedByClause {
  kind: "ConstrainedByClause";
  span: Span;
  typeName: ComponentReference;
  modification: ClassModification | null;
}

// --- Modifications ---

export interface Modification {
  kind: "Modification";
  span: Span;
  classModification: ClassModification | null;
  binding: { kind: "equals" | "assign"; value: Expression | "break" } | null;
}

export interface ClassModification {
  kind: "ClassModification";
  span: Span;
  arguments: (ElementModification | ElementReplaceable | ElementRedeclaration)[];
}

export interface ElementModification {
  kind: "ElementModification";
  span: Span;
  isFinal: boolean;
  isEach: boolean;
  name: ComponentReference;
  modification: Modification | null;
  descriptionString: string | null;
}

export interface ElementReplaceable {
  kind: "ElementReplaceable";
  span: Span;
  isEach: boolean;
  isFinal: boolean;
  element: ShortClassDefinition | ComponentClause1;
  constrainedBy: ConstrainedByClause | null;
}

export interface ElementRedeclaration {
  kind: "ElementRedeclaration";
  span: Span;
  isEach: boolean;
  isFinal: boolean;
  element: ShortClassDefinition | ComponentClause1 | ElementReplaceable;
}

// --- Annotation ---

export interface Annotation {
  kind: "Annotation";
  span: Span;
  classModification: ClassModification;
}

// --- Equation sections ---

export interface EquationSection {
  kind: "EquationSection";
  span: Span;
  isInitial: boolean;
  equations: EquationNode[];
}

export type EquationNode =
  | SimpleEquation
  | ConnectEquation
  | IfEquation
  | ForEquation
  | WhenEquation
  | FunctionCallEquation;

export interface SimpleEquation {
  kind: "SimpleEquation";
  span: Span;
  lhs: Expression;
  rhs: Expression;
  annotation: Annotation | null;
  comment: string | null;
}

export interface ConnectEquation {
  kind: "ConnectEquation";
  span: Span;
  from: ComponentReference;
  to: ComponentReference;
  annotation: Annotation | null;
  comment: string | null;
}

export interface IfEquation {
  kind: "IfEquation";
  span: Span;
  branches: { condition: Expression; equations: EquationNode[] }[];
  elseEquations: EquationNode[];
  annotation: Annotation | null;
  comment: string | null;
}

export interface ForEquation {
  kind: "ForEquation";
  span: Span;
  iterators: ForIterator[];
  equations: EquationNode[];
  annotation: Annotation | null;
  comment: string | null;
}

export interface WhenEquation {
  kind: "WhenEquation";
  span: Span;
  branches: { condition: Expression; equations: EquationNode[] }[];
  annotation: Annotation | null;
  comment: string | null;
}

export interface FunctionCallEquation {
  kind: "FunctionCallEquation";
  span: Span;
  name: ComponentReference;
  args: FunctionArguments;
  annotation: Annotation | null;
  comment: string | null;
}

// --- Algorithm sections ---

export interface AlgorithmSection {
  kind: "AlgorithmSection";
  span: Span;
  isInitial: boolean;
  statements: Statement[];
}

export type Statement =
  | AssignmentStatement
  | IfStatement
  | ForStatement
  | WhileStatement
  | WhenStatement
  | ReturnStatement
  | BreakStatement
  | FunctionCallStatement;

export type AssignmentTarget = ComponentReference | TupleTarget;

export interface TupleTarget {
  components: (ComponentReference | null)[];
}

export interface AssignmentStatement {
  kind: "AssignmentStatement";
  span: Span;
  target: AssignmentTarget;
  value: Expression;
}

export interface FunctionCallStatement {
  kind: "FunctionCallStatement";
  span: Span;
  name: ComponentReference;
  args: FunctionArguments;
}

export interface IfStatement {
  kind: "IfStatement";
  span: Span;
  branches: { condition: Expression; statements: Statement[] }[];
  elseStatements: Statement[];
}

export interface ForStatement {
  kind: "ForStatement";
  span: Span;
  iterators: ForIterator[];
  statements: Statement[];
}

export interface WhileStatement {
  kind: "WhileStatement";
  span: Span;
  condition: Expression;
  statements: Statement[];
}

export interface WhenStatement {
  kind: "WhenStatement";
  span: Span;
  branches: { condition: Expression; statements: Statement[] }[];
}

export interface ReturnStatement {
  kind: "ReturnStatement";
  span: Span;
}

export interface BreakStatement {
  kind: "BreakStatement";
  span: Span;
}

// --- Expressions ---

export type Expression =
  | IntegerLiteralExpr
  | RealLiteralExpr
  | StringLiteralExpr
  | BooleanLiteralExpr
  | ComponentReferenceExpr
  | BinaryExpr
  | UnaryExpr
  | IfExpr
  | FunctionCallExpr
  | FunctionPartialApplicationExpr
  | ArrayConstructExpr
  | ArrayConcatExpr
  | RangeExpr
  | EndExpr
  | ColonExpr;

export interface IntegerLiteralExpr {
  kind: "IntegerLiteral";
  span: Span;
  value: number;
}

export interface RealLiteralExpr {
  kind: "RealLiteral";
  span: Span;
  value: number;
}

export interface StringLiteralExpr {
  kind: "StringLiteral";
  span: Span;
  value: string;
}

export interface BooleanLiteralExpr {
  kind: "BooleanLiteral";
  span: Span;
  value: boolean;
}

export interface ComponentReferenceExpr {
  kind: "ComponentReference";
  span: Span;
  ref: ComponentReference;
}

export type BinaryOp =
  | "+" | "-" | "*" | "/" | "^"
  | ".+" | ".-" | ".*" | "./" | ".^"
  | "==" | "<>" | "<" | "<=" | ">" | ">="
  | "and" | "or";

export interface BinaryExpr {
  kind: "BinaryExpr";
  span: Span;
  op: BinaryOp;
  left: Expression;
  right: Expression;
}

export type UnaryOp = "-" | "+" | "not";

export interface UnaryExpr {
  kind: "UnaryExpr";
  span: Span;
  op: UnaryOp;
  operand: Expression;
}

export interface IfExpr {
  kind: "IfExpr";
  span: Span;
  condition: Expression;
  thenExpr: Expression;
  elseIfs: { condition: Expression; value: Expression }[];
  elseExpr: Expression;
}

export interface FunctionCallExpr {
  kind: "FunctionCallExpr";
  span: Span;
  name: ComponentReference;
  args: FunctionArguments;
}

export interface FunctionPartialApplicationExpr {
  kind: "FunctionPartialApplicationExpr";
  span: Span;
  functionName: ComponentReference;
  namedArguments: { name: string; value: Expression }[];
}

export interface FunctionArguments {
  positional: Expression[];
  named: { name: string; value: Expression }[];
  forIterators: ForIterator[] | null;
}

export interface ForIterator {
  name: string;
  range: Expression | null;
}

export interface ArrayConstructExpr {
  kind: "ArrayConstructExpr";
  span: Span;
  elements: Expression[];
  forIterators: ForIterator[] | null;
}

export interface ArrayConcatExpr {
  kind: "ArrayConcatExpr";
  span: Span;
  rows: Expression[][];
}

export interface RangeExpr {
  kind: "RangeExpr";
  span: Span;
  start: Expression;
  step: Expression | null;
  stop: Expression;
}

export interface EndExpr {
  kind: "EndExpr";
  span: Span;
}

export interface ColonExpr {
  kind: "ColonExpr";
  span: Span;
}

// --- External declarations ---

export interface ExternalDeclaration {
  kind: "ExternalDeclaration";
  span: Span;
  language: string | null;
  functionName: string | null;
  args: Expression[];
  returnVar: ComponentReference | null;
  annotation: Annotation | null;
}
