import { Lexer } from "./lexer.ts";
import { TokenKind } from "./data-structures.ts";
import type {
  AlgorithmSection,
  Annotation,
  AssignmentStatement,
  BinaryOp,
  BreakStatement,
  ClassDefinition,
  ClassModification,
  ClassRestriction,
  ComponentDeclaration,
  ComponentReference,
  ComponentReferencePart,
  ConnectEquation,
  ConstrainedByClause,
  ElementModification,
  EnumerationLiteral,
  EquationNode,
  EquationSection,
  ExtendsClause,
  Expression,
  ExternalDeclaration,
  ForEquation,
  ForIterator,
  ForStatement,
  FunctionArguments,
  FunctionCallEquation,
  FunctionCallStatement,
  IfEquation,
  IfStatement,
  ImportClause,
  Modification,
  ReturnStatement,
  ShortClassDefinition,
  SimpleEquation,
  SourceLocation,
  Span,
  Statement,
  StoredClassEntry,
  StoredDefinition,
  Token,
  UnaryOp,
  Visibility,
  WhenEquation,
  WhenStatement,
  WhileStatement,
} from "./data-structures.ts";

// =============================================================================
// Binding powers for Pratt parser
// =============================================================================

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

// =============================================================================
// Parser
// =============================================================================

export class Parser {
  private lexer: Lexer;
  private current: Token;
  private next: Token;
  private previous: Token;

  constructor(source: string, file: string) {
    this.lexer = new Lexer(source, file);
    this.current = this.lexer.nextToken();
    this.next = this.lexer.nextToken();
    this.previous = this.current;
  }

  // ---------------------------------------------------------------------------
  // Token consumption primitives
  // ---------------------------------------------------------------------------

  private peek(): TokenKind {
    return this.current.kind;
  }

  private check(kind: TokenKind): boolean {
    return this.current.kind === kind;
  }

  private advance(): Token {
    this.previous = this.current;
    this.current = this.next;
    this.next = this.lexer.nextToken();
    return this.previous;
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
    throw this.error(
      message ?? `Expected ${TokenKind[kind]}, got ${TokenKind[this.current.kind]}`,
    );
  }

  // Two-token lookahead: peek at the token after current.
  private peekNextIs(kind: TokenKind): boolean {
    return this.next.kind === kind;
  }

  // ---------------------------------------------------------------------------
  // Span helpers
  // ---------------------------------------------------------------------------

  private spanFrom(start: SourceLocation): Span {
    return { start, end: this.previous.span.end };
  }

  // ---------------------------------------------------------------------------
  // Error reporting
  // ---------------------------------------------------------------------------

  private error(message: string): Error {
    const loc = this.current.span.start;
    return new Error(`${loc.file}:${loc.line}:${loc.column}: ${message}`);
  }

  // ---------------------------------------------------------------------------
  // Top-level
  // ---------------------------------------------------------------------------

  parse(): StoredDefinition {
    const start = this.current.span.start;

    let withinPath: ComponentReference | null = null;
    if (this.match(TokenKind.Within)) {
      if (!this.check(TokenKind.Semicolon)) {
        withinPath = this.parseComponentReference();
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

    return {
      kind: "StoredDefinition",
      span: this.spanFrom(start),
      withinPath,
      classDefinitions,
    };
  }

  // ---------------------------------------------------------------------------
  // Class definitions
  // ---------------------------------------------------------------------------

  private parseClassDefinition(isFinal: boolean): ClassDefinition | ShortClassDefinition {
    const start = this.current.span.start;

    const isEncapsulated = this.match(TokenKind.Encapsulated);
    const isPartial      = this.match(TokenKind.Partial);
    const isExpandable   = this.match(TokenKind.Expandable);
    const isPure         = this.match(TokenKind.Pure);
    const isImpure       = this.match(TokenKind.Impure);

    const restriction = this.parseClassRestriction();
    const nameToken   = this.expect(TokenKind.Identifier);
    const name        = nameToken.value as string;

    if (this.match(TokenKind.Equals)) {
      return this.parseShortClassBody(start, restriction, name, {
        isFinal, isEncapsulated, isPartial, isExpandable, isPure, isImpure,
      });
    }

    // Optional string comment after class name
    const _openComment = this.parseOptionalStringComment();

    const elements: import("./data-structures.ts").Element[] = [];
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
        `Mismatched class name: opened '${name}', closed '${endName.value}'`,
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

  private parseShortClassBody(
    start: SourceLocation,
    restriction: ClassRestriction,
    name: string,
    prefixes: {
      isFinal: boolean; isEncapsulated: boolean; isPartial: boolean;
      isExpandable: boolean; isPure: boolean; isImpure: boolean;
    },
  ): ShortClassDefinition {
    if (this.match(TokenKind.Enumeration)) {
      this.expect(TokenKind.LParen);
      const enumeration = this.parseEnumerationList();
      this.expect(TokenKind.RParen);
      const comment    = this.parseOptionalStringComment();
      const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;
      return {
        kind: "ShortClassDefinition", span: this.spanFrom(start),
        ...prefixes, restriction, name,
        baseType: null, arraySubscripts: [], modification: null,
        enumeration, annotation, comment,
      };
    }

    const baseType       = this.parseComponentReference();
    const arraySubscripts = this.check(TokenKind.LBracket) ? this.parseArraySubscripts() : [];
    const modification   = this.check(TokenKind.LParen) ? this.parseClassModification() : null;
    const comment        = this.parseOptionalStringComment();
    const annotation     = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;

    return {
      kind: "ShortClassDefinition", span: this.spanFrom(start),
      ...prefixes, restriction, name,
      baseType, arraySubscripts, modification,
      enumeration: null, annotation, comment,
    };
  }

  private parseEnumerationList(): EnumerationLiteral[] {
    const literals: EnumerationLiteral[] = [];
    if (this.check(TokenKind.Identifier)) {
      literals.push(this.parseEnumerationLiteral());
      while (this.match(TokenKind.Comma)) {
        if (this.check(TokenKind.RParen)) break;
        literals.push(this.parseEnumerationLiteral());
      }
    }
    return literals;
  }

  private parseEnumerationLiteral(): EnumerationLiteral {
    const name       = this.expect(TokenKind.Identifier).value as string;
    const comment    = this.parseOptionalStringComment();
    const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;
    return { name, comment, annotation };
  }

  // ---------------------------------------------------------------------------
  // Elements
  // ---------------------------------------------------------------------------

  private parseElement(visibility: Visibility): import("./data-structures.ts").Element {
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

    const isRedeclare   = this.match(TokenKind.Redeclare);
    const isFinal       = this.match(TokenKind.Final);
    const isInner       = this.match(TokenKind.Inner);
    const isOuter       = this.match(TokenKind.Outer);
    const isReplaceable = this.match(TokenKind.Replaceable);

    if (this.isClassRestrictionStart()) {
      const classDef = this.parseClassDefinition(isFinal);
      this.expect(TokenKind.Semicolon);
      return classDef as unknown as import("./data-structures.ts").ClassDefinition;
    }

    return this.parseComponentDeclaration(visibility, {
      isRedeclare, isFinal, isInner, isOuter, isReplaceable,
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

  // ---------------------------------------------------------------------------
  // Component declarations
  // ---------------------------------------------------------------------------

  // Parse a type name: a dotted identifier path with no subscripts on individual parts.
  // Array dimensions on the type (e.g. Real[3]) are left for the caller to consume.
  private parseTypeName(): ComponentReference {
    const isGlobal = this.match(TokenKind.Dot);
    const parts: ComponentReferencePart[] = [];
    const firstName = this.expect(TokenKind.Identifier).value as string;
    parts.push({ name: firstName, subscripts: [] });
    while (this.check(TokenKind.Dot) && this.next.kind === TokenKind.Identifier) {
      this.advance(); // consume "."
      parts.push({ name: this.expect(TokenKind.Identifier).value as string, subscripts: [] });
    }
    return { isGlobal, parts };
  }

  private parseComponentDeclaration(
    visibility: Visibility,
    prefixes: {
      isRedeclare: boolean; isFinal: boolean;
      isInner: boolean; isOuter: boolean; isReplaceable: boolean;
    },
  ): ComponentDeclaration {
    const start = this.current.span.start;

    const isFlow   = this.match(TokenKind.Flow);
    const isStream = this.match(TokenKind.Stream);

    let variability: import("./data-structures.ts").Variability = null;
    if      (this.match(TokenKind.Parameter)) variability = "parameter";
    else if (this.match(TokenKind.Constant))  variability = "constant";
    else if (this.match(TokenKind.Discrete))  variability = "discrete";

    let causality: import("./data-structures.ts").Causality = null;
    if      (this.match(TokenKind.Input))  causality = "input";
    else if (this.match(TokenKind.Output)) causality = "output";

    const typeName        = this.parseTypeName();
    const typeSubscripts  = this.check(TokenKind.LBracket) ? this.parseArraySubscripts() : [];
    const nameToken       = this.expect(TokenKind.Identifier);
    const name            = nameToken.value as string;
    const nameSubscripts  = this.check(TokenKind.LBracket) ? this.parseArraySubscripts() : [];
    const arraySubscripts = [...typeSubscripts, ...nameSubscripts];

    const modification = this.check(TokenKind.LParen) || this.check(TokenKind.Equals)
      ? this.parseModification() : null;

    const conditionAttribute = this.match(TokenKind.If)
      ? this.parseExpression() : null;

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

  // ---------------------------------------------------------------------------
  // Extends and import clauses
  // ---------------------------------------------------------------------------

  private parseExtendsClause(visibility: Visibility, start: SourceLocation): ExtendsClause {
    const baseName   = this.parseComponentReference();
    const modification = this.check(TokenKind.LParen) ? this.parseModification() : null;
    const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;
    return { kind: "ExtendsClause", span: this.spanFrom(start), visibility, baseName, modification, annotation };
  }

  private parseImportClause(visibility: Visibility, start: SourceLocation): ImportClause {
    let alias: string | null = null;
    let isWildcard = false;
    let importedNames: string[] | null = null;

    // Alias form: identifier "=" path
    if (this.current.kind === TokenKind.Identifier && this.next.kind === TokenKind.Equals) {
      alias = this.advance().value as string;
      this.advance(); // consume "="
    }

    // Parse first identifier of path
    const firstId = this.expect(TokenKind.Identifier).value as string;
    const pathParts: ComponentReferencePart[] = [{ name: firstId, subscripts: [] }];

    // Continue parsing dotted path, watching for .* (DotStar token) and .{...}
    if (this.check(TokenKind.DotStar)) {
      this.advance(); // consume .*
      isWildcard = true;
    } else {
      while (this.check(TokenKind.Dot)) {
        if (this.next.kind === TokenKind.LBrace) {
          this.advance(); // consume "."
          this.advance(); // consume "{"
          importedNames = [];
          importedNames.push(this.expect(TokenKind.Identifier).value as string);
          while (this.match(TokenKind.Comma)) {
            importedNames.push(this.expect(TokenKind.Identifier).value as string);
          }
          this.expect(TokenKind.RBrace);
          break;
        } else {
          this.advance(); // consume "."
          pathParts.push({ name: this.expect(TokenKind.Identifier).value as string, subscripts: [] });
        }
      }
    }

    const path: ComponentReference = { isGlobal: false, parts: pathParts };
    return { kind: "ImportClause", span: this.spanFrom(start), visibility, path, alias, isWildcard, importedNames };
  }

  // ---------------------------------------------------------------------------
  // Modifications
  // ---------------------------------------------------------------------------

  private parseModification(): Modification {
    const start = this.current.span.start;
    const classModification = this.check(TokenKind.LParen) ? this.parseClassModification() : null;
    const bindingExpression = this.match(TokenKind.Equals) ? this.parseExpression() : null;
    return { kind: "Modification", span: this.spanFrom(start), classModification, bindingExpression };
  }

  private parseClassModification(): ClassModification {
    const start = this.current.span.start;
    this.expect(TokenKind.LParen);
    const args: ElementModification[] = [];
    if (!this.check(TokenKind.RParen)) {
      args.push(this.parseElementModification());
      while (this.match(TokenKind.Comma)) {
        if (this.check(TokenKind.RParen)) break;
        args.push(this.parseElementModification());
      }
    }
    this.expect(TokenKind.RParen);
    return { kind: "ClassModification", span: this.spanFrom(start), arguments: args };
  }

  private parseElementModification(): ElementModification {
    const start  = this.current.span.start;
    const isEach  = this.match(TokenKind.Each);
    const isFinal = this.match(TokenKind.Final);
    const name    = this.parseComponentReference();
    const modification = this.check(TokenKind.LParen) || this.check(TokenKind.Equals)
      ? this.parseModification() : null;
    return { kind: "ElementModification", span: this.spanFrom(start), isFinal, isEach, name, modification };
  }

  private parseConstrainedByClause(): ConstrainedByClause {
    const start      = this.current.span.start;
    const typeName   = this.parseComponentReference();
    const modification = this.check(TokenKind.LParen) ? this.parseClassModification() : null;
    return { kind: "ConstrainedByClause", span: this.spanFrom(start), typeName, modification };
  }

  // ---------------------------------------------------------------------------
  // Equation sections
  // ---------------------------------------------------------------------------

  private parseEquationSection(isInitial: boolean): EquationSection {
    const start = this.current.span.start;
    const equations: EquationNode[] = [];
    while (!this.isSectionEnd()) {
      equations.push(this.parseEquation());
      this.expect(TokenKind.Semicolon);
    }
    return { kind: "EquationSection", span: this.spanFrom(start), isInitial, equations };
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

  private parseEquation(): EquationNode {
    const start = this.current.span.start;

    if (this.match(TokenKind.Connect)) return this.parseConnectEquation(start);
    if (this.match(TokenKind.If))      return this.parseIfEquation(start);
    if (this.match(TokenKind.For))     return this.parseForEquation(start);
    if (this.match(TokenKind.When))    return this.parseWhenEquation(start);

    const lhs = this.parseExpression();

    if (lhs.kind === "FunctionCallExpr" && !this.check(TokenKind.Equals)) {
      const comment    = this.parseOptionalStringComment();
      const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;
      return {
        kind: "FunctionCallEquation",
        span: this.spanFrom(start),
        name: (lhs as import("./data-structures.ts").FunctionCallExpr).name,
        args: (lhs as import("./data-structures.ts").FunctionCallExpr).args,
        annotation, comment,
      } as FunctionCallEquation;
    }

    this.expect(TokenKind.Equals);
    const rhs        = this.parseExpression();
    const comment    = this.parseOptionalStringComment();
    const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;
    return { kind: "SimpleEquation", span: this.spanFrom(start), lhs, rhs, annotation, comment } as SimpleEquation;
  }

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

  private parseIfEquation(start: SourceLocation): IfEquation {
    const branches: { condition: Expression; equations: EquationNode[] }[] = [];

    const firstCondition = this.parseExpression();
    this.expect(TokenKind.Then);
    const firstEquations: EquationNode[] = [];
    while (!this.check(TokenKind.ElseIf) && !this.check(TokenKind.Else) && !this.check(TokenKind.End)) {
      firstEquations.push(this.parseEquation());
      this.expect(TokenKind.Semicolon);
    }
    branches.push({ condition: firstCondition, equations: firstEquations });

    while (this.match(TokenKind.ElseIf)) {
      const condition = this.parseExpression();
      this.expect(TokenKind.Then);
      const equations: EquationNode[] = [];
      while (!this.check(TokenKind.ElseIf) && !this.check(TokenKind.Else) && !this.check(TokenKind.End)) {
        equations.push(this.parseEquation());
        this.expect(TokenKind.Semicolon);
      }
      branches.push({ condition, equations });
    }

    const elseEquations: EquationNode[] = [];
    if (this.match(TokenKind.Else)) {
      while (!this.check(TokenKind.End)) {
        elseEquations.push(this.parseEquation());
        this.expect(TokenKind.Semicolon);
      }
    }

    this.expect(TokenKind.End);
    this.expect(TokenKind.If);
    const comment    = this.parseOptionalStringComment();
    const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;
    return { kind: "IfEquation", span: this.spanFrom(start), branches, elseEquations, annotation, comment };
  }

  private parseWhenEquation(start: SourceLocation): WhenEquation {
    const branches: { condition: Expression; equations: EquationNode[] }[] = [];

    const firstCondition = this.parseExpression();
    this.expect(TokenKind.Then);
    const firstEquations: EquationNode[] = [];
    while (!this.check(TokenKind.ElseWhen) && !this.check(TokenKind.End)) {
      firstEquations.push(this.parseEquation());
      this.expect(TokenKind.Semicolon);
    }
    branches.push({ condition: firstCondition, equations: firstEquations });

    while (this.match(TokenKind.ElseWhen)) {
      const condition = this.parseExpression();
      this.expect(TokenKind.Then);
      const equations: EquationNode[] = [];
      while (!this.check(TokenKind.ElseWhen) && !this.check(TokenKind.End)) {
        equations.push(this.parseEquation());
        this.expect(TokenKind.Semicolon);
      }
      branches.push({ condition, equations });
    }

    this.expect(TokenKind.End);
    this.expect(TokenKind.When);
    const comment    = this.parseOptionalStringComment();
    const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;
    return { kind: "WhenEquation", span: this.spanFrom(start), branches, annotation, comment };
  }

  // ---------------------------------------------------------------------------
  // Algorithm sections
  // ---------------------------------------------------------------------------

  private parseAlgorithmSection(isInitial: boolean): AlgorithmSection {
    const start = this.current.span.start;
    const statements: Statement[] = [];
    while (!this.isSectionEnd()) {
      statements.push(this.parseStatement());
      this.expect(TokenKind.Semicolon);
    }
    return { kind: "AlgorithmSection", span: this.spanFrom(start), isInitial, statements };
  }

  private parseStatement(): Statement {
    const start = this.current.span.start;

    if (this.check(TokenKind.LParen))  return this.parseTupleAssignment(start);
    if (this.match(TokenKind.If))      return this.parseIfStatement(start);
    if (this.match(TokenKind.For))     return this.parseForStatement(start);
    if (this.match(TokenKind.While))   return this.parseWhileStatement(start);
    if (this.match(TokenKind.When))    return this.parseWhenStatement(start);
    if (this.match(TokenKind.Return))  return { kind: "ReturnStatement",  span: this.spanFrom(start) } as ReturnStatement;
    if (this.match(TokenKind.Break))   return { kind: "BreakStatement",   span: this.spanFrom(start) } as BreakStatement;

    const ref = this.parseComponentReference();

    if (this.check(TokenKind.LParen)) {
      const args = this.parseFunctionArguments();
      return { kind: "FunctionCallStatement", span: this.spanFrom(start), name: ref, args } as FunctionCallStatement;
    }

    this.expect(TokenKind.Assign);
    const value = this.parseExpression();
    return { kind: "AssignmentStatement", span: this.spanFrom(start), target: ref, value } as AssignmentStatement;
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

  private parseIfStatement(start: SourceLocation): IfStatement {
    const branches: { condition: Expression; statements: Statement[] }[] = [];

    const firstCondition = this.parseExpression();
    this.expect(TokenKind.Then);
    const firstStatements: Statement[] = [];
    while (!this.check(TokenKind.ElseIf) && !this.check(TokenKind.Else) && !this.check(TokenKind.End)) {
      firstStatements.push(this.parseStatement());
      this.expect(TokenKind.Semicolon);
    }
    branches.push({ condition: firstCondition, statements: firstStatements });

    while (this.match(TokenKind.ElseIf)) {
      const condition = this.parseExpression();
      this.expect(TokenKind.Then);
      const stmts: Statement[] = [];
      while (!this.check(TokenKind.ElseIf) && !this.check(TokenKind.Else) && !this.check(TokenKind.End)) {
        stmts.push(this.parseStatement());
        this.expect(TokenKind.Semicolon);
      }
      branches.push({ condition, statements: stmts });
    }

    const elseStatements: Statement[] = [];
    if (this.match(TokenKind.Else)) {
      while (!this.check(TokenKind.End)) {
        elseStatements.push(this.parseStatement());
        this.expect(TokenKind.Semicolon);
      }
    }

    this.expect(TokenKind.End);
    this.expect(TokenKind.If);
    return { kind: "IfStatement", span: this.spanFrom(start), branches, elseStatements };
  }

  private parseForStatement(start: SourceLocation): ForStatement {
    const iterators = this.parseForIterators();
    this.expect(TokenKind.Loop);
    const statements: Statement[] = [];
    while (!this.check(TokenKind.End)) {
      statements.push(this.parseStatement());
      this.expect(TokenKind.Semicolon);
    }
    this.expect(TokenKind.End);
    this.expect(TokenKind.For);
    return { kind: "ForStatement", span: this.spanFrom(start), iterators, statements };
  }

  private parseWhileStatement(start: SourceLocation): WhileStatement {
    const condition = this.parseExpression();
    this.expect(TokenKind.Loop);
    const statements: Statement[] = [];
    while (!this.check(TokenKind.End)) {
      statements.push(this.parseStatement());
      this.expect(TokenKind.Semicolon);
    }
    this.expect(TokenKind.End);
    this.expect(TokenKind.While);
    return { kind: "WhileStatement", span: this.spanFrom(start), condition, statements };
  }

  private parseWhenStatement(start: SourceLocation): WhenStatement {
    const branches: { condition: Expression; statements: Statement[] }[] = [];

    const firstCondition = this.parseExpression();
    this.expect(TokenKind.Then);
    const firstStatements: Statement[] = [];
    while (!this.check(TokenKind.ElseWhen) && !this.check(TokenKind.End)) {
      firstStatements.push(this.parseStatement());
      this.expect(TokenKind.Semicolon);
    }
    branches.push({ condition: firstCondition, statements: firstStatements });

    while (this.match(TokenKind.ElseWhen)) {
      const condition = this.parseExpression();
      this.expect(TokenKind.Then);
      const stmts: Statement[] = [];
      while (!this.check(TokenKind.ElseWhen) && !this.check(TokenKind.End)) {
        stmts.push(this.parseStatement());
        this.expect(TokenKind.Semicolon);
      }
      branches.push({ condition, statements: stmts });
    }

    this.expect(TokenKind.End);
    this.expect(TokenKind.When);
    return { kind: "WhenStatement", span: this.spanFrom(start), branches };
  }

  // ---------------------------------------------------------------------------
  // Component references and array subscripts
  // ---------------------------------------------------------------------------

  private parseComponentReference(): ComponentReference {
    const isGlobal = this.match(TokenKind.Dot);
    const parts: ComponentReferencePart[] = [];

    const firstName = this.check(TokenKind.Der)
      ? (this.advance(), "der")
      : (this.expect(TokenKind.Identifier).value as string);
    const firstSubs = this.check(TokenKind.LBracket) ? this.parseArraySubscripts() : [];
    parts.push({ name: firstName, subscripts: firstSubs });

    while (this.match(TokenKind.Dot)) {
      const name = this.expect(TokenKind.Identifier).value as string;
      const subs  = this.check(TokenKind.LBracket) ? this.parseArraySubscripts() : [];
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

  private parseSubscript(): Expression {
    const start = this.current.span.start;
    if (this.match(TokenKind.Colon)) {
      return { kind: "ColonExpr", span: this.spanFrom(start) };
    }
    return this.parseExpressionOrRange();
  }

  // ---------------------------------------------------------------------------
  // Annotations and string comments
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // External declarations
  // ---------------------------------------------------------------------------

  private parseExternalDeclaration(): ExternalDeclaration {
    const start = this.current.span.start;

    const language = this.check(TokenKind.StringLiteral)
      ? (this.advance().value as string) : null;

    let returnVar: ComponentReference | null = null;
    let functionName: string | null = null;
    const args: Expression[] = [];

    if (this.check(TokenKind.Identifier)) {
      const id = this.advance().value as string;
      if (this.match(TokenKind.Equals)) {
        returnVar = { isGlobal: false, parts: [{ name: id, subscripts: [] }] };
        functionName = this.expect(TokenKind.Identifier).value as string;
      } else {
        functionName = id;
      }
      this.expect(TokenKind.LParen);
      if (!this.check(TokenKind.RParen)) {
        args.push(this.parseExpression());
        while (this.match(TokenKind.Comma)) {
          args.push(this.parseExpression());
        }
      }
      this.expect(TokenKind.RParen);
    }

    const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;
    this.expect(TokenKind.Semicolon);

    return { kind: "ExternalDeclaration", span: this.spanFrom(start), language, functionName, args, returnVar, annotation };
  }

  // ---------------------------------------------------------------------------
  // For iterators
  // ---------------------------------------------------------------------------

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
    const range     = this.match(TokenKind.In) ? this.parseExpressionOrRange() : null;
    return { name: nameToken.value as string, range };
  }

  // ---------------------------------------------------------------------------
  // Expression parsing (Pratt)
  // ---------------------------------------------------------------------------

  private parseExpression(minBP: number = BP.None): Expression {
    const start = this.current.span.start;
    let left: Expression;

    if (this.match(TokenKind.IntegerLiteral)) {
      left = { kind: "IntegerLiteral", span: this.spanFrom(start), value: this.previous.value as number };
    } else if (this.match(TokenKind.RealLiteral)) {
      left = { kind: "RealLiteral", span: this.spanFrom(start), value: this.previous.value as number };
    } else if (this.match(TokenKind.StringLiteral)) {
      left = { kind: "StringLiteral", span: this.spanFrom(start), value: this.previous.value as string };
    } else if (this.match(TokenKind.BooleanLiteral)) {
      left = { kind: "BooleanLiteral", span: this.spanFrom(start), value: this.previous.value as boolean };
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
    } else if (
      this.check(TokenKind.Identifier) || this.check(TokenKind.Dot) || this.check(TokenKind.Der)
    ) {
      left = this.parseComponentReferenceOrFunctionCall(start);
    } else {
      throw this.error(`Unexpected token in expression: ${TokenKind[this.current.kind]}`);
    }

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

  private parseExpressionOrRange(): Expression {
    const start = this.current.span.start;
    const first = this.parseExpression();

    if (!this.match(TokenKind.Colon)) return first;

    const second = this.parseExpression();

    if (!this.match(TokenKind.Colon)) {
      return { kind: "RangeExpr", span: this.spanFrom(start), start: first, step: null, stop: second };
    }

    const third = this.parseExpression();
    return { kind: "RangeExpr", span: this.spanFrom(start), start: first, step: second, stop: third };
  }

  private parseComponentReferenceOrFunctionCall(start: SourceLocation): Expression {
    const ref = this.parseComponentReference();
    if (this.check(TokenKind.LParen)) {
      const args = this.parseFunctionArguments();
      return { kind: "FunctionCallExpr", span: this.spanFrom(start), name: ref, args };
    }
    return { kind: "ComponentReference", span: this.spanFrom(start), ref };
  }

  private parseIfExpression(start: SourceLocation): import("./data-structures.ts").IfExpr {
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

  private parseArrayConstruct(start: SourceLocation): import("./data-structures.ts").ArrayConstructExpr {
    const elements: Expression[] = [];
    if (!this.check(TokenKind.RBrace)) {
      elements.push(this.parseExpression());
      while (this.match(TokenKind.Comma)) {
        if (this.check(TokenKind.RBrace)) break;
        elements.push(this.parseExpression());
      }
    }
    this.expect(TokenKind.RBrace);
    return { kind: "ArrayConstructExpr", span: this.spanFrom(start), elements };
  }

  private parseArrayConcat(start: SourceLocation): import("./data-structures.ts").ArrayConcatExpr {
    const rows: Expression[][] = [];
    if (!this.check(TokenKind.RBracket)) {
      const row: Expression[] = [this.parseExpressionOrRange()];
      while (this.match(TokenKind.Comma)) {
        row.push(this.parseExpressionOrRange());
      }
      rows.push(row);
      while (this.match(TokenKind.Semicolon)) {
        if (this.check(TokenKind.RBracket)) break;
        const r: Expression[] = [this.parseExpressionOrRange()];
        while (this.match(TokenKind.Comma)) {
          r.push(this.parseExpressionOrRange());
        }
        rows.push(r);
      }
    }
    this.expect(TokenKind.RBracket);
    return { kind: "ArrayConcatExpr", span: this.spanFrom(start), rows };
  }

  // ---------------------------------------------------------------------------
  // Function arguments
  // ---------------------------------------------------------------------------

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

  private parseFunctionArgumentList(
    positional: Expression[],
    named: { name: string; value: Expression }[],
  ): void {
    while (true) {
      if (this.check(TokenKind.RParen)) break;

      if (this.current.kind === TokenKind.Identifier && this.next.kind === TokenKind.Equals) {
        const name = this.advance().value as string;
        this.advance(); // consume "="
        named.push({ name, value: this.parseExpression() });
      } else {
        positional.push(this.parseExpression());
      }

      if (!this.match(TokenKind.Comma)) break;
    }
  }

  // ---------------------------------------------------------------------------
  // Binding power table and op mapping
  // ---------------------------------------------------------------------------

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

  // Suppress unused variable warning for peek()
  private _peek = this.peek.bind(this);
}
