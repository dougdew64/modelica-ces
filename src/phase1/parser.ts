import { Lexer } from "./lexer.ts";
import { TokenKind } from "./data-structures.ts";
import type {
  AlgorithmSection,
  Annotation,
  ArrayConstructExpr,
  AssignmentStatement,
  BinaryOp,
  BreakStatement,
  ClassDefinition,
  ClassModification,
  ClassRestriction,
  ComponentClause1,
  ComponentDeclaration,
  ComponentReference,
  ComponentReferencePart,
  ConnectEquation,
  ConstrainedByClause,
  DerClassDefinition,
  Element,
  ElementModification,
  ElementRedeclaration,
  ElementReplaceable,
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
  FunctionCallExpr,
  FunctionCallStatement,
  FunctionPartialApplicationExpr,
  IfEquation,
  IfExpr,
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
  Variability,
  Causality,
  Visibility,
  WhenEquation,
  WhenStatement,
  WhileStatement,
} from "./data-structures.ts";

// =============================================================================
// Binding powers for Pratt parser (Modelica 3.6 spec)
// =============================================================================

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

type Prefixes = {
  isFinal: boolean;
  isEncapsulated: boolean;
  isPartial: boolean;
  isExpandable: boolean;
  isPure: boolean;
  isImpure: boolean;
};

type ElementPrefixes = {
  isRedeclare: boolean;
  isFinal: boolean;
  isInner: boolean;
  isOuter: boolean;
  isReplaceable: boolean;
};

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
  // Primitives
  // ---------------------------------------------------------------------------

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

  private peekNextIs(kind: TokenKind): boolean {
    return this.next.kind === kind;
  }

  private spanFrom(start: SourceLocation): Span {
    return { start, end: this.previous.span.end };
  }

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

  private parseClassDefinition(
    isFinal: boolean,
  ): ClassDefinition | ShortClassDefinition | DerClassDefinition {
    const start = this.current.span.start;

    const isEncapsulated = this.match(TokenKind.Encapsulated);
    const isPartial      = this.match(TokenKind.Partial);
    const isExpandable   = this.match(TokenKind.Expandable);
    const isPure         = this.match(TokenKind.Pure);
    const isImpure       = this.match(TokenKind.Impure);

    const prefixes: Prefixes = { isFinal, isEncapsulated, isPartial, isExpandable, isPure, isImpure };
    const restriction = this.parseClassRestriction();

    const nameToken = this.expect(TokenKind.Identifier);
    const name      = nameToken.value as string;

    // Short class or der class: "=" ...
    if (this.match(TokenKind.Equals)) {
      if (this.match(TokenKind.Der)) {
        return this.parseDerClassBody(start, restriction, name, prefixes);
      }
      return this.parseShortClassBody(start, restriction, name, prefixes);
    }

    // Long class body: extending form (first extends in body) is recorded in
    // `def.extending` as well as added to `elements`.
    return this.parseLongClassBody(start, restriction, name, prefixes, null);
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

  private parseLongClassBody(
    start: SourceLocation,
    restriction: ClassRestriction,
    name: string,
    prefixes: Prefixes,
    extendingIn: { name: ComponentReference; modification: ClassModification | null } | null,
  ): ClassDefinition {
    // Optional description string after class header
    this.parseDescriptionString();

    let extending = extendingIn;
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
        this.advance(); // 'initial'
        this.advance(); // 'equation'
        equationSections.push(this.parseEquationSection(true));
      } else if (this.check(TokenKind.Initial) && this.peekNextIs(TokenKind.Algorithm)) {
        this.advance(); // 'initial'
        this.advance(); // 'algorithm'
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
        const before = elements.length;
        this.parseElement(currentVisibility, elements);
        // Spec: long-class-specifier has a second form beginning with `extends IDENT`.
        // We recognize it by lifting the first extends clause in the body into the
        // class definition's `extending` field (it remains in `elements` as well).
        if (extending === null && elements.length === before + 1) {
          const el = elements[before];
          if (el.kind === "ExtendsClause") {
            extending = {
              name: el.baseName,
              modification: el.modification !== null ? el.modification.classModification : null,
            };
          }
        }
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
      restriction, name,
      isFinal: prefixes.isFinal,
      isEncapsulated: prefixes.isEncapsulated,
      isPartial: prefixes.isPartial,
      isExpandable: prefixes.isExpandable,
      isPure: prefixes.isPure,
      isImpure: prefixes.isImpure,
      extending,
      constrainedBy: null, // populated by the caller when wrapped in replaceable ... constrainedby
      elements, equationSections, algorithmSections, externalDecl, annotation,
    };
  }

  private parseShortClassBody(
    start: SourceLocation,
    restriction: ClassRestriction,
    name: string,
    prefixes: Prefixes,
  ): ShortClassDefinition {
    // enumeration form
    if (this.match(TokenKind.Enumeration)) {
      this.expect(TokenKind.LParen);
      let isOpen = false;
      let enumeration: EnumerationLiteral[] | null = null;
      if (this.match(TokenKind.Colon)) {
        isOpen = true;
      } else {
        enumeration = this.parseEnumerationList();
      }
      this.expect(TokenKind.RParen);
      const comment    = this.parseDescriptionString();
      const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;
      return {
        kind: "ShortClassDefinition", span: this.spanFrom(start),
        restriction, name,
        isFinal: prefixes.isFinal,
        isEncapsulated: prefixes.isEncapsulated,
        isPartial: prefixes.isPartial,
        isExpandable: prefixes.isExpandable,
        isPure: prefixes.isPure,
        isImpure: prefixes.isImpure,
        basePrefix: { isInput: false, isOutput: false },
        isOpen,
        baseType: null, arraySubscripts: [], modification: null,
        enumeration,
        constrainedBy: null,
        annotation, comment,
      };
    }

    // type specialisation form: [ base-prefix ] type-specifier [ array-subscripts ] [ class-modification ]
    const isInput  = this.match(TokenKind.Input);
    const isOutput = !isInput && this.match(TokenKind.Output);

    const baseType       = this.parseComponentReference();
    const arraySubscripts = this.check(TokenKind.LBracket) ? this.parseArraySubscripts() : [];
    const modification   = this.check(TokenKind.LParen) ? this.parseClassModification() : null;
    const comment        = this.parseDescriptionString();
    const annotation     = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;

    return {
      kind: "ShortClassDefinition", span: this.spanFrom(start),
      restriction, name,
      isFinal: prefixes.isFinal,
      isEncapsulated: prefixes.isEncapsulated,
      isPartial: prefixes.isPartial,
      isExpandable: prefixes.isExpandable,
      isPure: prefixes.isPure,
      isImpure: prefixes.isImpure,
      basePrefix: { isInput, isOutput },
      isOpen: false,
      baseType, arraySubscripts, modification,
      enumeration: null,
      constrainedBy: null,
      annotation, comment,
    };
  }

  private parseDerClassBody(
    start: SourceLocation,
    restriction: ClassRestriction,
    name: string,
    prefixes: Prefixes,
  ): DerClassDefinition {
    // 'der' already consumed
    this.expect(TokenKind.LParen);
    const baseFunction = this.parseComponentReference();
    this.expect(TokenKind.Comma);
    const withRespectTo: string[] = [];
    withRespectTo.push(this.expect(TokenKind.Identifier).value as string);
    while (this.match(TokenKind.Comma)) {
      withRespectTo.push(this.expect(TokenKind.Identifier).value as string);
    }
    this.expect(TokenKind.RParen);
    const comment    = this.parseDescriptionString();
    const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;
    return {
      kind: "DerClassDefinition", span: this.spanFrom(start),
      restriction, name,
      isFinal: prefixes.isFinal,
      isEncapsulated: prefixes.isEncapsulated,
      isPartial: prefixes.isPartial,
      isExpandable: prefixes.isExpandable,
      isPure: prefixes.isPure,
      isImpure: prefixes.isImpure,
      baseFunction, withRespectTo,
      annotation, comment,
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
    const comment    = this.parseDescriptionString();
    const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;
    return { name, comment, annotation };
  }

  // ---------------------------------------------------------------------------
  // Elements
  // ---------------------------------------------------------------------------

  // parseElement writes directly into the parent's elements array, because one
  // component-clause can produce multiple ComponentDeclaration entries.
  private parseElement(visibility: Visibility, out: Element[]): void {
    const start = this.current.span.start;

    if (this.match(TokenKind.Import)) {
      const imp = this.parseImportClause(visibility, start);
      this.expect(TokenKind.Semicolon);
      out.push(imp);
      return;
    }

    if (this.match(TokenKind.Extends)) {
      const ext = this.parseExtendsClause(visibility, start);
      this.expect(TokenKind.Semicolon);
      out.push(ext);
      return;
    }

    const isRedeclare   = this.match(TokenKind.Redeclare);
    const isFinal       = this.match(TokenKind.Final);
    const isInner       = this.match(TokenKind.Inner);
    const isOuter       = this.match(TokenKind.Outer);
    const isReplaceable = this.match(TokenKind.Replaceable);

    if (this.isClassRestrictionStart()) {
      const classDef = this.parseClassDefinition(isFinal);
      // Optional constraining clause on a replaceable class
      let constrainedBy: ConstrainedByClause | null = null;
      if (isReplaceable && this.match(TokenKind.ConstrainedBy)) {
        constrainedBy = this.parseConstrainedByClause();
      }
      // Attach constrainedBy onto the class node (whichever form it is).
      if (constrainedBy) {
        if (classDef.kind === "ClassDefinition") {
          classDef.constrainedBy = constrainedBy;
        } else if (classDef.kind === "ShortClassDefinition") {
          classDef.constrainedBy = constrainedBy;
        }
      }
      this.expect(TokenKind.Semicolon);
      out.push(classDef);
      return;
    }

    this.parseComponentClause(
      visibility,
      { isRedeclare, isFinal, isInner, isOuter, isReplaceable },
      out,
    );
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
  // Component clause (may produce multiple ComponentDeclarations)
  // ---------------------------------------------------------------------------

  private parseComponentClause(
    visibility: Visibility,
    prefixes: ElementPrefixes,
    out: Element[],
  ): void {
    const isFlow   = this.match(TokenKind.Flow);
    const isStream = this.match(TokenKind.Stream);

    let variability: Variability = null;
    if      (this.match(TokenKind.Parameter)) variability = "parameter";
    else if (this.match(TokenKind.Constant))  variability = "constant";
    else if (this.match(TokenKind.Discrete))  variability = "discrete";

    let causality: Causality = null;
    if      (this.match(TokenKind.Input))  causality = "input";
    else if (this.match(TokenKind.Output)) causality = "output";

    const typeName = this.parseTypeName();
    const typeArraySubscripts = this.check(TokenKind.LBracket)
      ? this.parseArraySubscripts() : [];

    out.push(this.parseSingleComponentDeclaration(
      visibility, prefixes, isFlow, isStream, variability, causality,
      typeName, typeArraySubscripts,
    ));
    while (this.match(TokenKind.Comma)) {
      out.push(this.parseSingleComponentDeclaration(
        visibility, prefixes, isFlow, isStream, variability, causality,
        typeName, typeArraySubscripts,
      ));
    }
    this.expect(TokenKind.Semicolon);
  }

  private parseSingleComponentDeclaration(
    visibility: Visibility,
    prefixes: ElementPrefixes,
    isFlow: boolean,
    isStream: boolean,
    variability: Variability,
    causality: Causality,
    typeName: ComponentReference,
    typeArraySubscripts: Expression[],
  ): ComponentDeclaration {
    const start = this.current.span.start;

    const nameToken = this.expect(TokenKind.Identifier);
    const name      = nameToken.value as string;

    const nameArraySubscripts = this.check(TokenKind.LBracket)
      ? this.parseArraySubscripts() : [];

    const modification = this.check(TokenKind.LParen)
      || this.check(TokenKind.Equals)
      || this.check(TokenKind.Assign)
      ? this.parseModification() : null;

    const conditionAttribute = this.match(TokenKind.If)
      ? this.parseExpression() : null;

    const constrainedBy = this.match(TokenKind.ConstrainedBy)
      ? this.parseConstrainedByClause() : null;

    const comment    = this.parseDescriptionString();
    const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;

    return {
      kind: "ComponentDeclaration",
      span: this.spanFrom(start),
      visibility,
      isFinal: prefixes.isFinal,
      isInner: prefixes.isInner,
      isOuter: prefixes.isOuter,
      isRedeclare: prefixes.isRedeclare,
      isReplaceable: prefixes.isReplaceable,
      isFlow, isStream,
      variability, causality,
      typeName, typeArraySubscripts,
      name, nameArraySubscripts,
      modification, conditionAttribute, constrainedBy, annotation, comment,
    };
  }

  // Parse a "type name": dotted path, no subscripts at any level.
  private parseTypeName(): ComponentReference {
    const isGlobal = this.match(TokenKind.Dot);
    const parts: ComponentReferencePart[] = [];
    const firstName = this.expect(TokenKind.Identifier).value as string;
    parts.push({ name: firstName, subscripts: [] });
    while (this.check(TokenKind.Dot) && this.next.kind === TokenKind.Identifier) {
      this.advance(); // "."
      parts.push({ name: this.expect(TokenKind.Identifier).value as string, subscripts: [] });
    }
    return { isGlobal, parts };
  }

  private parseSimpleName(): ComponentReference {
    return this.parseTypeName();
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

    if (this.current.kind === TokenKind.Identifier && this.next.kind === TokenKind.Equals) {
      alias = this.advance().value as string;
      this.advance(); // "="
    }

    const firstId = this.expect(TokenKind.Identifier).value as string;
    const pathParts: ComponentReferencePart[] = [{ name: firstId, subscripts: [] }];

    if (this.check(TokenKind.DotStar)) {
      this.advance();
      isWildcard = true;
    } else {
      while (this.check(TokenKind.Dot)) {
        if (this.next.kind === TokenKind.LBrace) {
          this.advance(); // "."
          this.advance(); // "{"
          importedNames = [];
          importedNames.push(this.expect(TokenKind.Identifier).value as string);
          while (this.match(TokenKind.Comma)) {
            importedNames.push(this.expect(TokenKind.Identifier).value as string);
          }
          this.expect(TokenKind.RBrace);
          break;
        } else {
          this.advance(); // "."
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
    const start = this.current.span.start;

    if (this.match(TokenKind.Redeclare)) {
      return this.parseElementRedeclaration(start);
    }

    const isEach  = this.match(TokenKind.Each);
    const isFinal = this.match(TokenKind.Final);

    if (this.match(TokenKind.Replaceable)) {
      return this.parseElementReplaceable(start, isEach, isFinal);
    }

    return this.parseElementModification(start, isEach, isFinal);
  }

  private parseElementModification(
    start: SourceLocation,
    isEach: boolean,
    isFinal: boolean,
  ): ElementModification {
    const name = this.parseComponentReference();
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

  private parseElementReplaceable(
    start: SourceLocation,
    isEach: boolean,
    isFinal: boolean,
  ): ElementReplaceable {
    const element = this.parseReplaceableOrRedeclarationBody();
    const constrainedBy = this.match(TokenKind.ConstrainedBy)
      ? this.parseConstrainedByClause() : null;
    return {
      kind: "ElementReplaceable",
      span: this.spanFrom(start),
      isEach, isFinal, element, constrainedBy,
    };
  }

  private parseElementRedeclaration(start: SourceLocation): ElementRedeclaration {
    const isEach  = this.match(TokenKind.Each);
    const isFinal = this.match(TokenKind.Final);

    if (this.match(TokenKind.Replaceable)) {
      // redeclare [each] [final] element-replaceable
      const replStart = this.previous.span.start;
      const er = this.parseElementReplaceable(replStart, false, false);
      return {
        kind: "ElementRedeclaration",
        span: this.spanFrom(start),
        isEach, isFinal, element: er,
      };
    }

    const element = this.parseReplaceableOrRedeclarationBody();
    return {
      kind: "ElementRedeclaration",
      span: this.spanFrom(start),
      isEach, isFinal, element,
    };
  }

  // Parses either a short-class-definition or a component-clause1 as the body
  // of a `replaceable` or `redeclare` argument.
  private parseReplaceableOrRedeclarationBody(): ShortClassDefinition | ComponentClause1 {
    // Heuristic: if the next token looks like a class restriction, parse a
    // short class definition. Otherwise parse a component-clause1.
    if (this.isClassRestrictionStart()) {
      const classDef = this.parseClassDefinition(false);
      if (classDef.kind !== "ShortClassDefinition") {
        // The redeclare grammar expects a short class definition here. If we
        // get a long class definition, surface a clear error.
        throw this.error("Expected short class definition inside replaceable/redeclare argument");
      }
      return classDef;
    }
    return this.parseComponentClause1();
  }

  private parseComponentClause1(): ComponentClause1 {
    const start = this.current.span.start;
    const typeName = this.parseTypeName();
    const typeArraySubscripts = this.check(TokenKind.LBracket)
      ? this.parseArraySubscripts() : [];
    const name = this.expect(TokenKind.Identifier).value as string;
    const nameArraySubscripts = this.check(TokenKind.LBracket)
      ? this.parseArraySubscripts() : [];
    const modification = this.check(TokenKind.LParen)
      || this.check(TokenKind.Equals)
      || this.check(TokenKind.Assign)
      ? this.parseModification() : null;
    const comment = this.parseDescriptionString();
    return {
      kind: "ComponentClause1",
      span: this.spanFrom(start),
      typeName, typeArraySubscripts, name, nameArraySubscripts, modification, comment,
    };
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
      const comment    = this.parseDescriptionString();
      const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;
      return {
        kind: "FunctionCallEquation",
        span: this.spanFrom(start),
        name: lhs.name, args: lhs.args, annotation, comment,
      } as FunctionCallEquation;
    }

    this.expect(TokenKind.Equals);
    const rhs        = this.parseExpression();
    const comment    = this.parseDescriptionString();
    const annotation = this.check(TokenKind.Annotation) ? this.parseAnnotation() : null;
    return { kind: "SimpleEquation", span: this.spanFrom(start), lhs, rhs, annotation, comment } as SimpleEquation;
  }

  private parseConnectEquation(start: SourceLocation): ConnectEquation {
    this.expect(TokenKind.LParen);
    const from = this.parseComponentReference();
    this.expect(TokenKind.Comma);
    const to   = this.parseComponentReference();
    this.expect(TokenKind.RParen);
    const comment    = this.parseDescriptionString();
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
    const comment    = this.parseDescriptionString();
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
    const comment    = this.parseDescriptionString();
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
    const comment    = this.parseDescriptionString();
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
    const components: (ComponentReference | null)[] = [];

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
    const fnStart = this.current.span.start;
    const fnName = this.parseComponentReference();
    if (!this.check(TokenKind.LParen)) {
      throw this.error("Right-hand side of tuple assignment must be a function call");
    }
    const args = this.parseFunctionArguments();
    const value: FunctionCallExpr = {
      kind: "FunctionCallExpr",
      span: this.spanFrom(fnStart),
      name: fnName,
      args,
    };

    return {
      kind: "AssignmentStatement",
      span: this.spanFrom(start),
      target: { components },
      value,
    };
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
  // Annotations and description strings
  // ---------------------------------------------------------------------------

  private parseAnnotation(): Annotation {
    const start = this.current.span.start;
    this.expect(TokenKind.Annotation);
    const classModification = this.parseClassModification();
    return { kind: "Annotation", span: this.spanFrom(start), classModification };
  }

  // description-string := [ STRING { "+" STRING } ]
  private parseDescriptionString(): string | null {
    if (!this.check(TokenKind.StringLiteral)) return null;
    let result = this.advance().value as string;
    while (this.check(TokenKind.Plus) && this.peekNextIs(TokenKind.StringLiteral)) {
      this.advance(); // "+"
      result += this.advance().value as string;
    }
    return result;
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
      const operand = this.parseExpression(BP.Comparison);
      left = { kind: "UnaryExpr", span: this.spanFrom(start), op: "not", operand };
    } else if (this.check(TokenKind.Minus) || this.check(TokenKind.Plus)) {
      // Spec: unary sign's operand is parsed at multiplication level — absorbs *, /, ^.
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
      // Spec: ( initial | pure ) function-call-args as a primary expression
      const keyword = this.advance().kind === TokenKind.Initial ? "initial" : "pure";
      const args = this.parseFunctionArguments();
      left = {
        kind: "FunctionCallExpr",
        span: this.spanFrom(start),
        name: { isGlobal: false, parts: [{ name: keyword, subscripts: [] }] },
        args,
      };
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
      // Power is non-associative per spec: `factor := primary [ "^" primary ]`.
      // Reject chaining like `a ^ b ^ c`.
      if ((op === "^" || op === ".^")
          && (this.check(TokenKind.Power) || this.check(TokenKind.DotPower))) {
        throw this.error("Power operator is non-associative; use parentheses");
      }
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

  private parseArrayConstruct(start: SourceLocation): ArrayConstructExpr {
    const elements: Expression[] = [];
    let forIterators: ForIterator[] | null = null;

    if (!this.check(TokenKind.RBrace)) {
      elements.push(this.parseExpression());
      if (this.match(TokenKind.For)) {
        forIterators = this.parseForIterators();
      } else {
        while (this.match(TokenKind.Comma)) {
          if (this.check(TokenKind.RBrace)) break;
          elements.push(this.parseExpression());
        }
      }
    }
    this.expect(TokenKind.RBrace);
    return { kind: "ArrayConstructExpr", span: this.spanFrom(start), elements, forIterators };
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
    let seenNamed = false;
    while (true) {
      if (this.check(TokenKind.RParen)) break;

      if (this.current.kind === TokenKind.Identifier && this.next.kind === TokenKind.Equals) {
        const name = this.advance().value as string;
        this.advance(); // "="
        named.push({ name, value: this.parseExpression() });
        seenNamed = true;
      } else if (this.check(TokenKind.Function)) {
        if (seenNamed) {
          throw this.error("Positional argument after named argument is not allowed");
        }
        positional.push(this.parseFunctionPartialApplication());
      } else {
        if (seenNamed) {
          throw this.error("Positional argument after named argument is not allowed");
        }
        positional.push(this.parseExpression());
      }

      if (!this.match(TokenKind.Comma)) break;
    }
  }

  private parseFunctionPartialApplication(): FunctionPartialApplicationExpr {
    const start = this.current.span.start;
    this.expect(TokenKind.Function);
    const functionName = this.parseTypeName();
    this.expect(TokenKind.LParen);
    const namedArguments: { name: string; value: Expression }[] = [];
    if (!this.check(TokenKind.RParen)) {
      this.parseNamedOnlyArgumentList(namedArguments);
    }
    this.expect(TokenKind.RParen);
    return {
      kind: "FunctionPartialApplicationExpr",
      span: this.spanFrom(start),
      functionName, namedArguments,
    };
  }

  private parseNamedOnlyArgumentList(
    named: { name: string; value: Expression }[],
  ): void {
    while (true) {
      if (this.check(TokenKind.RParen)) break;
      if (!(this.current.kind === TokenKind.Identifier && this.next.kind === TokenKind.Equals)) {
        throw this.error("Expected named argument");
      }
      const name = this.advance().value as string;
      this.advance(); // "="
      named.push({ name, value: this.parseExpression() });
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
        // Non-associative per spec: `factor := primary [ "^" primary ]`
        return { left: BP.Power, right: BP.Power + 1 };
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
}
