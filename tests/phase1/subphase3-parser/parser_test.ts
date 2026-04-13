import { assert, assertEquals, assertThrows } from "@std/assert";
import { Parser } from "../../../src/phase1/parser.ts";
import type {
  AlgorithmSection,
  Annotation,
  AssignmentStatement,
  BinaryExpr,
  ClassDefinition,
  ClassModification,
  ComponentDeclaration,
  ConnectEquation,
  ElementModification,
  ExtendsClause,
  FunctionCallExpr,
  ImportClause,
  Modification,
  ShortClassDefinition,
  SimpleEquation,
  StoredDefinition,
  UnaryExpr,
} from "../../../src/phase1/data-structures.ts";

// =============================================================================
// Helpers
// =============================================================================

function parse(source: string, file = "test.mo"): StoredDefinition {
  return new Parser(source, file).parse();
}

function parseClass(source: string): ClassDefinition | ShortClassDefinition {
  return parse(source).classDefinitions[0].definition;
}

// deno-lint-ignore no-explicit-any
function firstElement(modelSource: string): any {
  return (parseClass(modelSource) as ClassDefinition).elements[0];
}

function firstEquation(modelSource: string): SimpleEquation {
  return (parseClass(modelSource) as ClassDefinition)
    .equationSections[0].equations[0] as SimpleEquation;
}

// Wrap an expression in a minimal model equation and return the parsed RHS.
// Note: range expressions are not handled here because ':' is not an infix
// operator in the Pratt parser. Test ranges in for-iterator contexts instead.
// deno-lint-ignore no-explicit-any
function parseExpr(exprSource: string): any {
  const sd = parse(`model _M equation _e = ${exprSource}; end _M;`);
  return ((sd.classDefinitions[0].definition as ClassDefinition)
    .equationSections[0].equations[0] as SimpleEquation).rhs;
}

// =============================================================================
// 1. Basic structure
// =============================================================================

Deno.test("U-PAR-1: Parser is exported and constructible", () => {
  const p = new Parser("", "test.mo");
  assert(p !== null && p !== undefined);
});

Deno.test("U-PAR-2: Parser instance has a parse method", () => {
  assertEquals(typeof new Parser("", "test.mo").parse, "function");
});

Deno.test("U-PAR-3: Empty source returns a StoredDefinition with empty class list", () => {
  const sd = parse("");
  assertEquals(sd.kind, "StoredDefinition");
  assertEquals(sd.classDefinitions.length, 0);
});

// =============================================================================
// 2. StoredDefinition and within clause
// =============================================================================

Deno.test("U-PAR-4: withinPath is null when no within clause is present", () => {
  assertEquals(parse("").withinPath, null);
});

Deno.test("U-PAR-5: 'within;' produces withinPath null (no name given)", () => {
  assertEquals(parse("within;").withinPath, null);
});

Deno.test("U-PAR-6: 'within Foo;' produces a single-part withinPath", () => {
  const wp = parse("within Foo;").withinPath!;
  assertEquals(wp.isGlobal, false);
  assertEquals(wp.parts.length, 1);
  assertEquals(wp.parts[0].name, "Foo");
});

Deno.test("U-PAR-7: 'within Foo.Bar;' produces a two-part withinPath", () => {
  const wp = parse("within Foo.Bar;").withinPath!;
  assertEquals(wp.parts.length, 2);
  assertEquals(wp.parts[0].name, "Foo");
  assertEquals(wp.parts[1].name, "Bar");
});

Deno.test("U-PAR-8: Multiple class definitions are all collected", () => {
  assertEquals(parse("model A end A; model B end B;").classDefinitions.length, 2);
});

// =============================================================================
// 3. Class definitions
// =============================================================================

Deno.test("U-PAR-9: Minimal model: kind, restriction, name", () => {
  const def = parseClass("model M end M;") as ClassDefinition;
  assertEquals(def.kind, "ClassDefinition");
  assertEquals(def.restriction, "model");
  assertEquals(def.name, "M");
});

Deno.test("U-PAR-10: Spot-check class restriction keywords", () => {
  const cases: Array<[string, string]> = [
    ["block", "block"],
    ["record", "record"],
    ["connector", "connector"],
    ["package", "package"],
    ["function", "function"],
    ["type", "type"],
    ["class", "class"],
  ];
  for (const [kw, expected] of cases) {
    assertEquals(
      (parseClass(`${kw} M end M;`) as ClassDefinition).restriction,
      expected,
      `restriction for keyword '${kw}'`,
    );
  }
});

Deno.test("U-PAR-11: 'operator function' and 'operator record' two-word restrictions", () => {
  assertEquals(
    (parseClass("operator function M end M;") as ClassDefinition).restriction,
    "operator function",
  );
  assertEquals(
    (parseClass("operator record M end M;") as ClassDefinition).restriction,
    "operator record",
  );
});

Deno.test("U-PAR-12: encapsulated and partial prefix flags", () => {
  const def = parseClass("encapsulated partial model M end M;") as ClassDefinition;
  assertEquals(def.isEncapsulated, true);
  assertEquals(def.isPartial, true);
});

Deno.test("U-PAR-13: pure and impure function prefix flags", () => {
  assertEquals((parseClass("pure function F end F;") as ClassDefinition).isPure, true);
  assertEquals((parseClass("impure function F end F;") as ClassDefinition).isImpure, true);
});

Deno.test("U-PAR-14: final prefix on a class definition", () => {
  assertEquals(parse("final model M end M;").classDefinitions[0].isFinal, true);
});

Deno.test("U-PAR-15: Mismatched class end-name throws with descriptive message", () => {
  assertThrows(() => parse("model Foo end Bar;"), Error, "Mismatched");
});

Deno.test("U-PAR-16: Short type specialization", () => {
  const def = parseClass("type Length = Real;") as ShortClassDefinition;
  assertEquals(def.kind, "ShortClassDefinition");
  assertEquals(def.restriction, "type");
  assertEquals(def.name, "Length");
  assertEquals(def.baseType!.parts[0].name, "Real");
  assertEquals(def.enumeration, null);
});

Deno.test("U-PAR-17: Short enumeration class", () => {
  const def = parseClass("type Dir = enumeration(x, y, z);") as ShortClassDefinition;
  assertEquals(def.kind, "ShortClassDefinition");
  assertEquals(def.enumeration!.length, 3);
  assertEquals(def.enumeration![0].name, "x");
  assertEquals(def.enumeration![2].name, "z");
});

// =============================================================================
// 4. Component declarations
// =============================================================================

Deno.test("U-PAR-18: Simple component declaration", () => {
  const cd = firstElement("model M Real x; end M;") as ComponentDeclaration;
  assertEquals(cd.kind, "ComponentDeclaration");
  assertEquals(cd.name, "x");
  assertEquals(cd.typeName.parts[0].name, "Real");
  assertEquals(cd.visibility, "public");
});

Deno.test("U-PAR-19: parameter variability", () => {
  const cd = firstElement("model M parameter Real m; end M;") as ComponentDeclaration;
  assertEquals(cd.variability, "parameter");
});

Deno.test("U-PAR-20: constant and discrete variability", () => {
  assertEquals(
    (firstElement("model M constant Real c; end M;") as ComponentDeclaration).variability,
    "constant",
  );
  assertEquals(
    (firstElement("model M discrete Real d; end M;") as ComponentDeclaration).variability,
    "discrete",
  );
});

Deno.test("U-PAR-21: input and output causality", () => {
  assertEquals(
    (firstElement("model M input Real u; end M;") as ComponentDeclaration).causality,
    "input",
  );
  assertEquals(
    (firstElement("model M output Real y; end M;") as ComponentDeclaration).causality,
    "output",
  );
});

Deno.test("U-PAR-22: flow and stream prefixes", () => {
  assertEquals(
    (firstElement("model M flow Real i; end M;") as ComponentDeclaration).isFlow,
    true,
  );
  assertEquals(
    (firstElement("model M stream Real h; end M;") as ComponentDeclaration).isStream,
    true,
  );
});

Deno.test("U-PAR-23: Array subscripts in component declaration", () => {
  const cd = firstElement("model M Real[3] v; end M;") as ComponentDeclaration;
  assertEquals(cd.arraySubscripts.length, 1);
});

Deno.test("U-PAR-24: Component with class modification (start value)", () => {
  const cd = firstElement("model M Real x(start = 0.0); end M;") as ComponentDeclaration;
  const classMod = cd.modification!.classModification!;
  assertEquals(classMod.kind, "ClassModification");
  assertEquals(classMod.arguments.length, 1);
  assertEquals(classMod.arguments[0].name.parts[0].name, "start");
});

// =============================================================================
// 5. extends and import clauses
// =============================================================================

Deno.test("U-PAR-25: extends clause", () => {
  const ext = firstElement("model M extends Base; end M;") as ExtendsClause;
  assertEquals(ext.kind, "ExtendsClause");
  assertEquals(ext.baseName.parts[0].name, "Base");
  assertEquals(ext.visibility, "public");
});

Deno.test("U-PAR-26: import clause — simple dotted path", () => {
  const imp = firstElement("model M import Foo.Bar; end M;") as ImportClause;
  assertEquals(imp.kind, "ImportClause");
  assertEquals(imp.path.parts.length, 2);
  assertEquals(imp.path.parts[0].name, "Foo");
  assertEquals(imp.path.parts[1].name, "Bar");
});

Deno.test("U-PAR-27: import clause — wildcard", () => {
  const imp = firstElement("model M import Foo.*; end M;") as ImportClause;
  assertEquals(imp.isWildcard, true);
});

Deno.test("U-PAR-28: import clause — alias", () => {
  const imp = firstElement("model M import F = Foo.Bar; end M;") as ImportClause;
  assertEquals(imp.alias, "F");
});

// =============================================================================
// 6. Modifications
// =============================================================================

Deno.test("U-PAR-29: Binding expression modification", () => {
  const cd = firstElement("model M Real x = 1.0; end M;") as ComponentDeclaration;
  assertEquals(cd.modification!.bindingExpression!.kind, "RealLiteral");
});

Deno.test("U-PAR-30: Nested modification (three levels deep)", () => {
  const cd = firstElement("model M R1 r(p(v(start = 0))); end M;") as ComponentDeclaration;
  const level1 = cd.modification!.classModification!;
  const level2 = level1.arguments[0].modification!.classModification!;
  const level3 = level2.arguments[0].modification!.classModification!;
  assertEquals(level3.arguments[0].name.parts[0].name, "start");
});

Deno.test("U-PAR-31: each and final in element modification", () => {
  const cd = firstElement(
    "model M R1[3] r(each final x = 0); end M;",
  ) as ComponentDeclaration;
  const em = cd.modification!.classModification!.arguments[0];
  assertEquals(em.isEach, true);
  assertEquals(em.isFinal, true);
});

// =============================================================================
// 7. Equation sections
// =============================================================================

Deno.test("U-PAR-32: Equation section is parsed; isInitial is false", () => {
  const def = parseClass("model M equation x = 0; end M;") as ClassDefinition;
  assertEquals(def.equationSections.length, 1);
  assertEquals(def.equationSections[0].isInitial, false);
});

Deno.test("U-PAR-33: initial equation section has isInitial true", () => {
  const def = parseClass("model M initial equation x = 0; end M;") as ClassDefinition;
  assertEquals(def.equationSections[0].isInitial, true);
});

Deno.test("U-PAR-34: Simple equation", () => {
  assertEquals(firstEquation("model M equation x = 1.0; end M;").kind, "SimpleEquation");
});

Deno.test("U-PAR-35: Connect equation", () => {
  const def = parseClass("model M equation connect(p, n); end M;") as ClassDefinition;
  const eq = def.equationSections[0].equations[0] as ConnectEquation;
  assertEquals(eq.kind, "ConnectEquation");
  assertEquals(eq.from.parts[0].name, "p");
  assertEquals(eq.to.parts[0].name, "n");
});

Deno.test("U-PAR-36: For equation", () => {
  const def = parseClass(
    "model M equation for i in 1:N loop x[i] = 0; end for; end M;",
  ) as ClassDefinition;
  // deno-lint-ignore no-explicit-any
  const eq = def.equationSections[0].equations[0] as any;
  assertEquals(eq.kind, "ForEquation");
  assertEquals(eq.iterators[0].name, "i");
  assertEquals(eq.equations.length, 1);
});

Deno.test("U-PAR-37: If equation", () => {
  const def = parseClass(
    "model M equation if x > 0 then y = 1; end if; end M;",
  ) as ClassDefinition;
  assertEquals(def.equationSections[0].equations[0].kind, "IfEquation");
});

Deno.test("U-PAR-38: When equation", () => {
  const def = parseClass(
    "model M equation when x > 1 then y = 0; end when; end M;",
  ) as ClassDefinition;
  assertEquals(def.equationSections[0].equations[0].kind, "WhenEquation");
});

Deno.test("U-PAR-39: Function-call equation (no '=' following the call)", () => {
  const def = parseClass(
    'model M equation assert(x > 0, "msg"); end M;',
  ) as ClassDefinition;
  // deno-lint-ignore no-explicit-any
  const eq = def.equationSections[0].equations[0] as any;
  assertEquals(eq.kind, "FunctionCallEquation");
  assertEquals(eq.name.parts[0].name, "assert");
});

// =============================================================================
// 8. Algorithm sections
// =============================================================================

Deno.test("U-PAR-40: Algorithm section is parsed; isInitial is false", () => {
  const def = parseClass("model M algorithm x := 1; end M;") as ClassDefinition;
  assertEquals(def.algorithmSections.length, 1);
  assertEquals(def.algorithmSections[0].isInitial, false);
});

Deno.test("U-PAR-41: initial algorithm section has isInitial true", () => {
  const def = parseClass("model M initial algorithm x := 1; end M;") as ClassDefinition;
  assertEquals(def.algorithmSections[0].isInitial, true);
});

Deno.test("U-PAR-42: Assignment statement", () => {
  const def = parseClass("model M algorithm x := 1; end M;") as ClassDefinition;
  assertEquals(def.algorithmSections[0].statements[0].kind, "AssignmentStatement");
});

Deno.test("U-PAR-43: Tuple assignment statement", () => {
  const def = parseClass("model M algorithm (a, b) := f(x); end M;") as ClassDefinition;
  const stmt = def.algorithmSections[0].statements[0] as AssignmentStatement;
  assertEquals(stmt.kind, "AssignmentStatement");
  // target is a TupleTarget: { components: ComponentReference[] }
  assert("components" in stmt.target);
  assertEquals((stmt.target as { components: unknown[] }).components.length, 2);
});

Deno.test("U-PAR-44: return and break statements", () => {
  assertEquals(
    (parseClass("function F algorithm return; end F;") as ClassDefinition)
      .algorithmSections[0].statements[0].kind,
    "ReturnStatement",
  );
  assertEquals(
    (parseClass("function F algorithm break; end F;") as ClassDefinition)
      .algorithmSections[0].statements[0].kind,
    "BreakStatement",
  );
});

Deno.test("U-PAR-45: For statement", () => {
  const def = parseClass(
    "model M algorithm for i in 1:N loop x := 0; end for; end M;",
  ) as ClassDefinition;
  assertEquals(def.algorithmSections[0].statements[0].kind, "ForStatement");
});

Deno.test("U-PAR-46: While statement", () => {
  const def = parseClass(
    "model M algorithm while x > 0 loop x := x - 1; end while; end M;",
  ) as ClassDefinition;
  assertEquals(def.algorithmSections[0].statements[0].kind, "WhileStatement");
});

// =============================================================================
// 9. Expressions
// =============================================================================

Deno.test("U-PAR-47: Integer literal expression", () => {
  const e = parseExpr("42");
  assertEquals(e.kind, "IntegerLiteral");
  assertEquals(e.value, 42);
});

Deno.test("U-PAR-48: Real literal expression", () => {
  const e = parseExpr("3.14");
  assertEquals(e.kind, "RealLiteral");
  assertEquals(e.value, 3.14);
});

Deno.test("U-PAR-49: String literal expression", () => {
  const e = parseExpr('"hello"');
  assertEquals(e.kind, "StringLiteral");
  assertEquals(e.value, "hello");
});

Deno.test("U-PAR-50: Boolean literal expressions", () => {
  const t = parseExpr("true");
  assertEquals(t.kind, "BooleanLiteral");
  assertEquals(t.value, true);
  const f = parseExpr("false");
  assertEquals(f.value, false);
});

Deno.test("U-PAR-51: Unary minus expression", () => {
  const e = parseExpr("-x") as UnaryExpr;
  assertEquals(e.kind, "UnaryExpr");
  assertEquals(e.op, "-");
});

Deno.test("U-PAR-52: Unary not expression", () => {
  const e = parseExpr("not x") as UnaryExpr;
  assertEquals(e.kind, "UnaryExpr");
  assertEquals(e.op, "not");
});

Deno.test("U-PAR-53: Binary arithmetic expression", () => {
  const e = parseExpr("x + y") as BinaryExpr;
  assertEquals(e.kind, "BinaryExpr");
  assertEquals(e.op, "+");
});

Deno.test("U-PAR-54: Multiplication binds tighter than addition", () => {
  // 1 + 2 * 3  →  BinaryExpr(+, 1, BinaryExpr(*, 2, 3))
  const e = parseExpr("1 + 2 * 3") as BinaryExpr;
  assertEquals(e.op, "+");
  assertEquals(e.right.kind, "BinaryExpr");
  assertEquals((e.right as BinaryExpr).op, "*");
});

Deno.test("U-PAR-55: ^ is right-associative", () => {
  // 2 ^ 3 ^ 4  →  BinaryExpr(^, 2, BinaryExpr(^, 3, 4))
  const e = parseExpr("2 ^ 3 ^ 4") as BinaryExpr;
  assertEquals(e.op, "^");
  assertEquals(e.right.kind, "BinaryExpr");
  assertEquals((e.right as BinaryExpr).op, "^");
});

Deno.test("U-PAR-56: Component reference expression", () => {
  const e = parseExpr("x.y.z");
  assertEquals(e.kind, "ComponentReference");
  assertEquals(e.ref.parts.length, 3);
  assertEquals(e.ref.parts[0].name, "x");
  assertEquals(e.ref.parts[2].name, "z");
});

Deno.test("U-PAR-57: Global component reference (leading dot)", () => {
  const e = parseExpr(".Foo.bar");
  assertEquals(e.kind, "ComponentReference");
  assertEquals(e.ref.isGlobal, true);
  assertEquals(e.ref.parts.length, 2);
});

Deno.test("U-PAR-58: Function call expression", () => {
  const e = parseExpr("sin(x)") as FunctionCallExpr;
  assertEquals(e.kind, "FunctionCallExpr");
  assertEquals(e.name.parts[0].name, "sin");
  assertEquals(e.args.positional.length, 1);
});

Deno.test("U-PAR-59: der(x) produces a FunctionCallExpr with name 'der'", () => {
  const e = parseExpr("der(x)") as FunctionCallExpr;
  assertEquals(e.kind, "FunctionCallExpr");
  assertEquals(e.name.parts[0].name, "der");
});

Deno.test("U-PAR-60: Array construction expression", () => {
  const e = parseExpr("{1, 2, 3}");
  assertEquals(e.kind, "ArrayConstructExpr");
  assertEquals(e.elements.length, 3);
});

Deno.test("U-PAR-61: Two-part range in a for-iterator", () => {
  const def = parseClass(
    "model M equation for i in 1:N loop x = 0; end for; end M;",
  ) as ClassDefinition;
  // deno-lint-ignore no-explicit-any
  const fe = def.equationSections[0].equations[0] as any;
  const range = fe.iterators[0].range;
  assertEquals(range.kind, "RangeExpr");
  assertEquals(range.step, null);
});

Deno.test("U-PAR-62: Three-part range (with step) in a for-iterator", () => {
  const def = parseClass(
    "model M equation for i in 1:2:N loop x = 0; end for; end M;",
  ) as ClassDefinition;
  // deno-lint-ignore no-explicit-any
  const fe = def.equationSections[0].equations[0] as any;
  assert(fe.iterators[0].range.step !== null);
});

Deno.test("U-PAR-63: If-expression", () => {
  const e = parseExpr("if x > 0 then 1 else 0");
  assertEquals(e.kind, "IfExpr");
  assertEquals(e.elseIfs.length, 0);
  assert(e.elseExpr !== null);
});

Deno.test("U-PAR-64: Named function arguments", () => {
  const e = parseExpr("f(x = 1, y = 2)") as FunctionCallExpr;
  assertEquals(e.kind, "FunctionCallExpr");
  assertEquals(e.args.positional.length, 0);
  assertEquals(e.args.named.length, 2);
  assertEquals(e.args.named[0].name, "x");
  assertEquals(e.args.named[1].name, "y");
});

// =============================================================================
// 10. Annotations and string comments
// =============================================================================

Deno.test("U-PAR-65: Annotation on a component declaration", () => {
  const cd = firstElement(
    "model M Real x annotation(Color = 1); end M;",
  ) as ComponentDeclaration;
  assert(cd.annotation !== null);
  assertEquals(cd.annotation!.kind, "Annotation");
});

Deno.test("U-PAR-66: Annotation at class level", () => {
  const def = parseClass(
    'model M annotation(version = "1.0"); end M;',
  ) as ClassDefinition;
  assert(def.annotation !== null);
  assertEquals(def.annotation!.kind, "Annotation");
});

Deno.test("U-PAR-67: String comment on a component declaration", () => {
  const cd = firstElement(
    'model M Real x "the x variable"; end M;',
  ) as ComponentDeclaration;
  assertEquals(cd.comment, "the x variable");
});

// =============================================================================
// 11. Error reporting
// =============================================================================

Deno.test("U-PAR-68: Mismatched class end-name throws with descriptive message", () => {
  assertThrows(() => parse("model Foo end Bar;"), Error, "Mismatched");
});

Deno.test("U-PAR-69: Missing semicolon after class definition throws", () => {
  // After parsing 'model M end M', the parser expects ';'. Seeing 'model' instead throws.
  assertThrows(() => parse("model M end M model N end N;"), Error);
});

Deno.test("U-PAR-70: Error message includes file:line:col prefix", () => {
  assertThrows(
    () => new Parser("model Foo end Bar;", "test.mo").parse(),
    Error,
    "test.mo:",
  );
});

// =============================================================================
// 12. End-to-end
// =============================================================================

Deno.test("U-PAR-71: SpringMassDamper.mo parses to the expected structure", async () => {
  const source = await Deno.readTextFile("tests/models/SpringMassDamper.mo");
  const sd = new Parser(source, "SpringMassDamper.mo").parse();

  assertEquals(sd.kind, "StoredDefinition");
  assertEquals(sd.withinPath, null);
  assertEquals(sd.classDefinitions.length, 1);
  assertEquals(sd.classDefinitions[0].isFinal, false);

  const def = sd.classDefinitions[0].definition as ClassDefinition;
  assertEquals(def.kind, "ClassDefinition");
  assertEquals(def.restriction, "model");
  assertEquals(def.name, "SpringMassDamper");

  // 5 component declarations: x, v, m, k, d
  assertEquals(def.elements.length, 5);
  assertEquals((def.elements[0] as ComponentDeclaration).name, "x");
  assertEquals((def.elements[1] as ComponentDeclaration).name, "v");
  assertEquals((def.elements[2] as ComponentDeclaration).variability, "parameter");

  // 1 equation section with 2 equations
  assertEquals(def.equationSections.length, 1);
  assertEquals(def.equationSections[0].isInitial, false);
  assertEquals(def.equationSections[0].equations.length, 2);

  // Both equations are simple equations
  assertEquals(def.equationSections[0].equations[0].kind, "SimpleEquation");
  assertEquals(def.equationSections[0].equations[1].kind, "SimpleEquation");

  // No algorithm sections
  assertEquals(def.algorithmSections.length, 0);
});
