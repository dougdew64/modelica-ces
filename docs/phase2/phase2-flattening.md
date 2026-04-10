# Phase 2: Flattening — Implementation Details

This document describes how to implement the flattening phase of the Modelica compiler in TypeScript. Flattening takes the AST produced by parsing and collapses the object-oriented hierarchy into a single flat list of variables and equations — the input to equation processing.

The implementation is organized around a central question: given a top-level model name, how do you produce the flat system? The answer involves six operations that interleave with each other:

1. **Class lookup** — finding a class definition by name
2. **Inheritance resolution** — merging `extends` clauses into a class
3. **Modification merging** — combining outer and inner modifications
4. **Component instantiation** — recursively creating flat variables
5. **Equation collection** — gathering and prefixing equations
6. **Connect resolution** — turning connect statements into equations

These are not strictly sequential phases. Instantiating a component requires looking up its class, resolving inheritance on that class, merging modifications, and then recursing into its sub-components. The implementation is naturally recursive.

---

## Part 1: Data Structures

### 1.1 The flat system — the output

The end product of flattening is a `FlatSystem`: a bag of variables and a bag of equations with no hierarchy.

```typescript
interface FlatSystem {
  variables: FlatVariable[];
  equations: FlatEquation[];
}
```

#### Flat variables

Each flat variable has a fully qualified name (like `R1.p.v`), a type, and metadata about its role.

```typescript
interface FlatVariable {
  name: string;                    // fully qualified: "R1.p.v"
  typeName: string;                // "Real", "Integer", "Boolean", "String"
  variability: "parameter" | "constant" | "discrete" | "continuous";
  isFlow: boolean;
  isStream: boolean;
  causality: "input" | "output" | null;
  bindingExpression: FlatExpr | null;   // parameter/constant value or default
  attributes: VariableAttributes;
}

interface VariableAttributes {
  start: FlatExpr | null;
  fixed: FlatExpr | null;
  nominal: FlatExpr | null;
  min: FlatExpr | null;
  max: FlatExpr | null;
  unit: string | null;
  displayUnit: string | null;
  stateSelect: string | null;     // "never", "avoid", "default", "prefer", "always"
}
```

The `variability` field is derived from the prefix keywords. A variable declared with no variability prefix is `"continuous"` for `Real` types and `"discrete"` for `Integer`, `Boolean`, and `String` types. This default assignment can happen during flattening or be deferred to equation processing — either works since the type is known.

#### Flat equations

Flat equations use a separate expression representation from the AST. During flattening, all variable references are resolved to their fully qualified flat names, and all parameter expressions are evaluated where possible. The flat expression type is simpler than the AST expression type — no component references with dotted paths, just flat variable names.

```typescript
type FlatExpr =
  | { kind: "real"; value: number }
  | { kind: "integer"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "string"; value: string }
  | { kind: "variable"; name: string }       // flat name like "R1.p.v"
  | { kind: "time" }                          // the built-in time variable
  | { kind: "binary"; op: BinaryOp; left: FlatExpr; right: FlatExpr }
  | { kind: "unary"; op: UnaryOp; operand: FlatExpr }
  | { kind: "call"; name: string; args: FlatExpr[] }  // der, sin, cos, etc.
  | { kind: "if"; condition: FlatExpr; thenExpr: FlatExpr;
      elseIfs: { condition: FlatExpr; value: FlatExpr }[];
      elseExpr: FlatExpr };

interface FlatEquation {
  lhs: FlatExpr;
  rhs: FlatExpr;
  origin: string;    // human-readable: "from Resistor R1", "connect(B.p, S.p)"
}
```

The `origin` field is not used by later phases but is invaluable for debugging and error messages — when equation processing detects a structural singularity, it needs to tell the user which equations are involved, and "equation 47" is useless without knowing it came from the resistor's voltage law.

### 1.2 The class environment — the input context

The flattener needs to look up class definitions by name. After parsing, you have a collection of AST `ClassDefinition` nodes (possibly from multiple files). These are organized into a **class environment** — a lookup structure that maps qualified names to their definitions.

```typescript
class ClassEnvironment {
  private classes: Map<string, ClassDefinition>;

  constructor() {
    this.classes = new Map();
  }

  register(qualifiedName: string, def: ClassDefinition): void {
    this.classes.set(qualifiedName, def);
  }

  lookup(qualifiedName: string): ClassDefinition | null {
    return this.classes.get(qualifiedName) ?? null;
  }
}
```

For a simple initial implementation, qualified names are dot-separated strings: `"Modelica.Electrical.Analog.Basic.Resistor"`. The `register` method is called once per class after parsing, walking the nesting structure of packages to build the full qualified name.

#### Building the environment from parsed files

After parsing, each file produces a `StoredDefinition` that may contain nested class definitions (packages containing models, etc.). These must be walked to register every class:

```typescript
function buildClassEnvironment(files: StoredDefinition[]): ClassEnvironment {
  const env = new ClassEnvironment();

  for (const file of files) {
    const prefix = file.withinPath
      ? componentReferenceToString(file.withinPath)
      : "";

    for (const classDef of file.classDefinitions) {
      registerClassRecursive(env, prefix, classDef);
    }
  }

  return env;
}

function registerClassRecursive(
  env: ClassEnvironment,
  prefix: string,
  def: ClassDefinition
): void {
  const qualifiedName = prefix ? `${prefix}.${def.name}` : def.name;
  env.register(qualifiedName, def);

  // Register nested classes
  for (const element of def.elements) {
    if (element.kind === "ClassDefinition") {
      registerClassRecursive(env, qualifiedName, element);
    }
  }
}
```

#### Name resolution

When the flattener encounters a type reference like `Pin` inside the class `Resistor`, it must resolve `Pin` to its fully qualified name. Modelica's name resolution rules are:

1. Look in the current class's local scope (nested classes, imported names)
2. Look in the enclosing class (parent package)
3. Repeat up the package hierarchy
4. Look in the top-level scope

For an initial implementation, a simplified resolution strategy works: try the name as-is (it might already be fully qualified), then try prepending each enclosing scope:

```typescript
function resolveClassName(
  env: ClassEnvironment,
  name: string,
  enclosingScopes: string[]
): string {
  // Try the name directly (already qualified)
  if (env.lookup(name)) return name;

  // Try prepending enclosing scopes, innermost first
  for (let i = enclosingScopes.length - 1; i >= 0; i--) {
    const candidate = enclosingScopes[i] + "." + name;
    if (env.lookup(candidate)) return candidate;
  }

  throw new Error(`Class not found: ${name}`);
}
```

A full implementation would also handle `import` clauses, but the simplified version is sufficient for models that use fully qualified names or that are defined in a single file.

### 1.3 The modification environment

Modifications flow downward through the instantiation hierarchy. When flattening `Resistor R1(R = 100.0)`, the modification `R = 100.0` must be carried into the Resistor class and applied to the parameter `R`. Nested modifications like `m(x(b = 20.0))` must be split at each level — the part targeting the current level is applied, and the rest is passed to sub-components.

A modification environment is a map from component names to their modifications at the current level:

```typescript
type ModificationEnv = Map<string, MergedModification>;

interface MergedModification {
  bindingExpression: Expression | null;    // = expr (AST expression, not yet flattened)
  classModification: Map<string, MergedModification>;  // nested modifications
}
```

This is a recursive map. For the modification `m(x(a = 10.0, b = 20.0))`, the top-level map has one entry `"m"`, whose value has no binding expression but has a `classModification` map with one entry `"x"`, whose value has a `classModification` map with two entries `"a"` (binding `10.0`) and `"b"` (binding `20.0`).

#### Merging modifications

The critical rule is: **outer modifications win**. When two modifications target the same path, the one closer to the instantiation point takes precedence.

```typescript
function mergeModifications(
  outer: MergedModification | null,
  inner: MergedModification | null
): MergedModification | null {
  if (outer === null) return inner;
  if (inner === null) return outer;

  // Outer binding wins over inner binding
  const bindingExpression = outer.bindingExpression ?? inner.bindingExpression;

  // Merge sub-modifications: outer wins for each key
  const merged = new Map(inner.classModification);
  for (const [key, outerSub] of outer.classModification) {
    const innerSub = merged.get(key) ?? null;
    merged.set(key, mergeModifications(outerSub, innerSub)!);
  }

  return { bindingExpression, classModification: merged };
}
```

Consider the three-level example from the overview:

```
model Inner     ->  a = 1.0, b = 2.0
model Middle    ->  x(a = 10.0)
model Outer     ->  m(x(b = 20.0))
```

When flattening `Outer.m.x`:
- Inner defaults: `a → {binding: 1.0}`, `b → {binding: 2.0}`
- Middle's modification on `x`: `a → {binding: 10.0}`
- Outer's modification reaching `x`: `b → {binding: 20.0}`

Merge order: start with Inner defaults, merge Middle's modification (outer wins, so `a` becomes `10.0`), then merge Outer's modification (outer wins, so `b` becomes `20.0`). Result: `a = 10.0, b = 20.0`.

If Outer instead said `m(x(a = 30.0))`, the final merge would override Middle's `a = 10.0` with Outer's `a = 30.0`.

#### Converting AST modifications to merged form

The AST `Modification` node from parsing needs to be converted to `MergedModification` for the merge algorithm:

```typescript
function astModToMerged(mod: Modification | null): MergedModification | null {
  if (mod === null) return null;

  const classModification = new Map<string, MergedModification>();
  if (mod.classModification) {
    for (const arg of mod.classModification.arguments) {
      const name = componentReferenceToString(arg.name);
      classModification.set(name, astModToMerged(arg.modification) ?? {
        bindingExpression: null,
        classModification: new Map(),
      });
    }
  }

  return {
    bindingExpression: mod.bindingExpression,
    classModification,
  };
}
```

---

## Part 2: The Flattening Algorithm

### 2.1 Top-level entry point

```typescript
function flatten(
  env: ClassEnvironment,
  topLevelClassName: string
): FlatSystem {
  const variables: FlatVariable[] = [];
  const equations: FlatEquation[] = [];
  const connectStatements: { from: string; to: string; connectorType: string }[] = [];

  const classDef = env.lookup(topLevelClassName);
  if (!classDef) {
    throw new Error(`Top-level class not found: ${topLevelClassName}`);
  }

  // Resolve the class (merge inheritance)
  const resolved = resolveClass(env, topLevelClassName, classDef);

  // Instantiate all components
  flattenClass(
    env,
    resolved,
    "",                              // prefix (empty for top level)
    new Map(),                       // no outer modifications
    [topLevelClassName],             // enclosing scopes for name resolution
    variables,
    equations,
    connectStatements
  );

  // Process connect statements into equations
  const connectionEquations = resolveConnections(env, connectStatements, variables);
  equations.push(...connectionEquations);

  return { variables, equations };
}
```

### 2.2 Class resolution (inheritance)

Before a class can be instantiated, its `extends` clauses must be resolved. This merges elements and equations from all parent classes into the current class.

```typescript
interface ResolvedClass {
  restriction: ClassRestriction;
  name: string;
  elements: ResolvedElement[];
  equationSections: EquationSection[];
  algorithmSections: AlgorithmSection[];
}

interface ResolvedElement {
  declaration: ComponentDeclaration | ClassDefinition;
  fromExtends: string | null;        // name of base class, or null if local
}

function resolveClass(
  env: ClassEnvironment,
  qualifiedName: string,
  classDef: ClassDefinition
): ResolvedClass {
  const elements: ResolvedElement[] = [];
  const equationSections: EquationSection[] = [];
  const algorithmSections: AlgorithmSection[] = [];

  // First, process extends clauses
  for (const element of classDef.elements) {
    if (element.kind === "ExtendsClause") {
      const baseName = resolveClassName(
        env,
        componentReferenceToString(element.baseName),
        getEnclosingScopes(qualifiedName)
      );
      const baseDef = env.lookup(baseName);
      if (!baseDef) throw new Error(`Base class not found: ${baseName}`);

      // Recursively resolve the base class
      const resolvedBase = resolveClass(env, baseName, baseDef);

      // Merge base elements (checking for conflicts)
      for (const baseElement of resolvedBase.elements) {
        const existing = elements.find(e => getElementName(e) === getElementName(baseElement));
        if (existing) {
          // Both the current class and a base class declare the same name.
          // In Modelica, this is only allowed if the declarations are compatible.
          // For now, treat as an error.
          throw new Error(
            `Duplicate element '${getElementName(baseElement)}' from extends ${baseName}`
          );
        }
        elements.push({ ...baseElement, fromExtends: baseName });
      }

      // Merge base equations
      equationSections.push(...resolvedBase.equationSections);
      algorithmSections.push(...resolvedBase.algorithmSections);
    }
  }

  // Then, add local elements (non-extends)
  for (const element of classDef.elements) {
    if (element.kind !== "ExtendsClause" && element.kind !== "ImportClause") {
      elements.push({ declaration: element, fromExtends: null });
    }
  }

  // Add local equations
  equationSections.push(...classDef.equationSections);
  algorithmSections.push(...classDef.algorithmSections);

  return {
    restriction: classDef.restriction,
    name: classDef.name,
    elements,
    equationSections,
    algorithmSections,
  };
}
```

The key decision here is that `extends` elements are processed first, then local elements are added. This means local declarations can reference inherited components, and local equations can use inherited variables. If a local declaration has the same name as an inherited one, it is an error (unless it is a `redeclare`, handled below).

#### Helper: enclosing scopes

```typescript
function getEnclosingScopes(qualifiedName: string): string[] {
  // "A.B.C" -> ["A", "A.B", "A.B.C"]
  const parts = qualifiedName.split(".");
  const scopes: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    scopes.push(parts.slice(0, i + 1).join("."));
  }
  return scopes;
}
```

### 2.3 Component instantiation

This is the heart of flattening. For each component declaration in a resolved class, the flattener creates flat variables and recurses into sub-components.

```typescript
function flattenClass(
  env: ClassEnvironment,
  resolved: ResolvedClass,
  prefix: string,
  outerMods: Map<string, MergedModification>,
  enclosingScopes: string[],
  variables: FlatVariable[],
  equations: FlatEquation[],
  connectStatements: { from: string; to: string; connectorType: string }[]
): void {
  for (const element of resolved.elements) {
    if (element.declaration.kind === "ComponentDeclaration") {
      flattenComponent(
        env,
        element.declaration,
        prefix,
        outerMods,
        enclosingScopes,
        variables,
        equations,
        connectStatements
      );
    }
    // Nested class definitions do not produce variables directly —
    // they are only used when referenced as types.
  }

  // Collect equations from this class
  for (const section of resolved.equationSections) {
    for (const eq of section.equations) {
      flattenEquation(env, eq, prefix, equations, connectStatements);
    }
  }
}
```

#### Flattening a single component

```typescript
function flattenComponent(
  env: ClassEnvironment,
  decl: ComponentDeclaration,
  prefix: string,
  outerMods: Map<string, MergedModification>,
  enclosingScopes: string[],
  variables: FlatVariable[],
  equations: FlatEquation[],
  connectStatements: { from: string; to: string; connectorType: string }[]
): void {
  const fullName = prefix ? `${prefix}.${decl.name}` : decl.name;

  // Evaluate conditional component
  if (decl.conditionAttribute) {
    const condValue = evaluateParameterExpression(decl.conditionAttribute, prefix, outerMods);
    if (condValue === false) {
      // Component is disabled — skip entirely
      return;
    }
  }

  // Merge modifications:
  //   outer = modifications from the enclosing instantiation targeting this component
  //   local = modifications on this declaration
  const outerMod = outerMods.get(decl.name) ?? null;
  const localMod = astModToMerged(decl.modification);
  const merged = mergeModifications(outerMod, localMod);

  // Resolve the component's type
  const typeName = componentReferenceToString(decl.typeName);

  // Check if this is a built-in type (Real, Integer, Boolean, String)
  if (isBuiltinType(typeName)) {
    // This is a leaf variable — add it to the flat variable list
    const variable = createFlatVariable(fullName, typeName, decl, merged);
    variables.push(variable);
    return;
  }

  // Otherwise, look up the class and recurse
  const resolvedTypeName = resolveClassName(env, typeName, enclosingScopes);
  const classDef = env.lookup(resolvedTypeName);
  if (!classDef) {
    throw new Error(`Type not found: ${typeName} (resolved as ${resolvedTypeName})`);
  }

  // Handle array components
  if (decl.arraySubscripts.length > 0) {
    flattenArrayComponent(
      env, decl, classDef, resolvedTypeName, fullName,
      merged, enclosingScopes, variables, equations, connectStatements
    );
    return;
  }

  // Resolve inheritance on the component's class
  const resolvedType = resolveClass(env, resolvedTypeName, classDef);

  // Prepare sub-modifications: extract modifications targeting sub-components
  const subMods = merged?.classModification ?? new Map();

  // Recurse
  flattenClass(
    env,
    resolvedType,
    fullName,
    subMods,
    [...enclosingScopes, resolvedTypeName],
    variables,
    equations,
    connectStatements
  );
}
```

The recursion bottoms out at built-in types (`Real`, `Integer`, `Boolean`, `String`). When the component's type is `Real`, we create a `FlatVariable` and stop. When the type is a model or connector, we resolve that class and recurse into its sub-components.

#### Creating leaf variables

```typescript
function isBuiltinType(name: string): boolean {
  return name === "Real" || name === "Integer"
      || name === "Boolean" || name === "String";
}

function createFlatVariable(
  fullName: string,
  typeName: string,
  decl: ComponentDeclaration,
  merged: MergedModification | null
): FlatVariable {
  // Determine variability
  let variability: FlatVariable["variability"] = "continuous";
  if (decl.variability === "parameter") variability = "parameter";
  else if (decl.variability === "constant") variability = "constant";
  else if (decl.variability === "discrete") variability = "discrete";
  else if (typeName !== "Real") variability = "discrete";

  // Extract attributes from merged modifications
  const attributes = extractAttributes(merged);

  // The binding expression comes from the merged modification
  const bindingExpression = merged?.bindingExpression
    ? flattenExpression(merged.bindingExpression, "")   // parameter exprs have no prefix
    : null;

  return {
    name: fullName,
    typeName,
    variability,
    isFlow: decl.isFlow,
    isStream: decl.isStream,
    causality: decl.causality,
    bindingExpression,
    attributes,
  };
}
```

#### Extracting variable attributes from modifications

When a variable is declared as `Real x(start = 1.0, fixed = true)`, the modification contains attribute values that must be extracted:

```typescript
function extractAttributes(mod: MergedModification | null): VariableAttributes {
  const attrs: VariableAttributes = {
    start: null, fixed: null, nominal: null,
    min: null, max: null, unit: null,
    displayUnit: null, stateSelect: null,
  };

  if (!mod) return attrs;

  for (const [key, sub] of mod.classModification) {
    if (sub.bindingExpression) {
      const expr = flattenExpression(sub.bindingExpression, "");
      switch (key) {
        case "start":       attrs.start = expr; break;
        case "fixed":       attrs.fixed = expr; break;
        case "nominal":     attrs.nominal = expr; break;
        case "min":         attrs.min = expr; break;
        case "max":         attrs.max = expr; break;
        case "unit":
          if (expr.kind === "string") attrs.unit = expr.value;
          break;
        case "displayUnit":
          if (expr.kind === "string") attrs.displayUnit = expr.value;
          break;
        case "stateSelect":
          // stateSelect is an enumeration, stored as a string for now
          if (expr.kind === "variable") attrs.stateSelect = expr.name;
          break;
      }
    }
  }

  return attrs;
}
```

### 2.4 Array component expansion

When a component is declared with array subscripts (`Resistor r[N]`), the flattener must evaluate the dimension, then instantiate each element individually:

```typescript
function flattenArrayComponent(
  env: ClassEnvironment,
  decl: ComponentDeclaration,
  classDef: ClassDefinition,
  resolvedTypeName: string,
  baseName: string,
  merged: MergedModification | null,
  enclosingScopes: string[],
  variables: FlatVariable[],
  equations: FlatEquation[],
  connectStatements: { from: string; to: string; connectorType: string }[]
): void {
  // Evaluate array dimensions
  const dimensions: number[] = [];
  for (const sub of decl.arraySubscripts) {
    const val = evaluateParameterExpression(sub, "", new Map());
    if (typeof val !== "number" || !Number.isInteger(val)) {
      throw new Error(`Array dimension must be an integer constant, got: ${val}`);
    }
    dimensions.push(val as number);
  }

  // For simplicity, handle 1D arrays; multi-dimensional extends similarly
  if (dimensions.length === 1) {
    const n = dimensions[0];
    for (let i = 1; i <= n; i++) {
      const elementName = `${baseName}[${i}]`;
      const resolvedType = resolveClass(env, resolvedTypeName, classDef);
      const subMods = merged?.classModification ?? new Map();

      flattenClass(
        env,
        resolvedType,
        elementName,
        subMods,
        [...enclosingScopes, resolvedTypeName],
        variables,
        equations,
        connectStatements
      );
    }
  } else {
    // Multi-dimensional: generate nested indices like r[1,2]
    flattenMultiDimArray(
      env, classDef, resolvedTypeName, baseName,
      dimensions, [], merged, enclosingScopes,
      variables, equations, connectStatements
    );
  }
}

function flattenMultiDimArray(
  env: ClassEnvironment,
  classDef: ClassDefinition,
  resolvedTypeName: string,
  baseName: string,
  dimensions: number[],
  currentIndices: number[],
  merged: MergedModification | null,
  enclosingScopes: string[],
  variables: FlatVariable[],
  equations: FlatEquation[],
  connectStatements: { from: string; to: string; connectorType: string }[]
): void {
  if (currentIndices.length === dimensions.length) {
    const indexStr = currentIndices.join(",");
    const elementName = `${baseName}[${indexStr}]`;
    const resolvedType = resolveClass(env, resolvedTypeName, classDef);
    const subMods = merged?.classModification ?? new Map();

    flattenClass(
      env,
      resolvedType,
      elementName,
      subMods,
      [...enclosingScopes, resolvedTypeName],
      variables,
      equations,
      connectStatements
    );
    return;
  }

  const dim = currentIndices.length;
  for (let i = 1; i <= dimensions[dim]; i++) {
    flattenMultiDimArray(
      env, classDef, resolvedTypeName, baseName,
      dimensions, [...currentIndices, i],
      merged, enclosingScopes, variables, equations, connectStatements
    );
  }
}
```

### 2.5 Equation collection

Equations from each class are collected with variable references prefixed by the instance path. This requires walking the AST equation nodes and transforming expressions.

```typescript
function flattenEquation(
  env: ClassEnvironment,
  eq: EquationNode,
  prefix: string,
  equations: FlatEquation[],
  connectStatements: { from: string; to: string; connectorType: string }[]
): void {
  switch (eq.kind) {
    case "SimpleEquation": {
      const lhs = flattenExpression(eq.lhs, prefix);
      const rhs = flattenExpression(eq.rhs, prefix);
      equations.push({
        lhs,
        rhs,
        origin: prefix ? `from ${prefix}` : "top-level",
      });
      break;
    }

    case "ConnectEquation": {
      const from = prefixReference(componentReferenceToString(eq.from), prefix);
      const to = prefixReference(componentReferenceToString(eq.to), prefix);
      // We don't resolve connections yet — just collect them.
      // The connector type is needed later to know which variables are flow/across.
      connectStatements.push({ from, to, connectorType: "" });
      break;
    }

    case "ForEquation": {
      unrollForEquation(env, eq, prefix, equations, connectStatements);
      break;
    }

    case "IfEquation": {
      flattenIfEquation(env, eq, prefix, equations, connectStatements);
      break;
    }

    case "WhenEquation": {
      // When equations are preserved structurally for later phases.
      // For now, flatten them like if-equations.
      flattenWhenEquation(env, eq, prefix, equations, connectStatements);
      break;
    }
  }
}
```

#### Expression flattening

The key operation: transform AST expressions into flat expressions by prefixing variable references.

```typescript
function flattenExpression(expr: Expression, prefix: string): FlatExpr {
  switch (expr.kind) {
    case "IntegerLiteral":
      return { kind: "integer", value: expr.value };

    case "RealLiteral":
      return { kind: "real", value: expr.value };

    case "BooleanLiteral":
      return { kind: "boolean", value: expr.value };

    case "StringLiteral":
      return { kind: "string", value: expr.value };

    case "ComponentReference": {
      const refStr = componentReferenceToString(expr.ref);

      // Special case: "time" is a built-in variable, not prefixed
      if (refStr === "time") {
        return { kind: "time" };
      }

      const flatName = prefixReference(refStr, prefix);
      return { kind: "variable", name: flatName };
    }

    case "BinaryExpr":
      return {
        kind: "binary",
        op: expr.op,
        left: flattenExpression(expr.left, prefix),
        right: flattenExpression(expr.right, prefix),
      };

    case "UnaryExpr":
      return {
        kind: "unary",
        op: expr.op,
        operand: flattenExpression(expr.operand, prefix),
      };

    case "FunctionCallExpr": {
      const funcName = componentReferenceToString(expr.name);
      const args = expr.args.positional.map(a => flattenExpression(a, prefix));
      return { kind: "call", name: funcName, args };
    }

    case "IfExpr":
      return {
        kind: "if",
        condition: flattenExpression(expr.condition, prefix),
        thenExpr: flattenExpression(expr.thenExpr, prefix),
        elseIfs: expr.elseIfs.map(ei => ({
          condition: flattenExpression(ei.condition, prefix),
          value: flattenExpression(ei.value, prefix),
        })),
        elseExpr: flattenExpression(expr.elseExpr, prefix),
      };

    case "RangeExpr":
      // Ranges should have been evaluated during for-loop unrolling.
      // If one appears here, it is an error or needs special handling.
      throw new Error("Unexpected range expression in equation");

    default:
      throw new Error(`Unhandled expression kind: ${(expr as any).kind}`);
  }
}

function prefixReference(ref: string, prefix: string): string {
  if (prefix === "") return ref;
  return `${prefix}.${ref}`;
}

function componentReferenceToString(ref: ComponentReference): string {
  return ref.parts.map(p => {
    if (p.subscripts.length > 0) {
      // For flattened array references, subscripts are already evaluated
      // In a general implementation, you'd evaluate them here
      return p.name + "[" + p.subscripts.map(s => exprToString(s)).join(",") + "]";
    }
    return p.name;
  }).join(".");
}
```

### 2.6 For-loop unrolling

For-loops in equation sections are unrolled by evaluating the iterator range and generating equations for each value.

```typescript
function unrollForEquation(
  env: ClassEnvironment,
  forEq: ForEquation,
  prefix: string,
  equations: FlatEquation[],
  connectStatements: { from: string; to: string; connectorType: string }[]
): void {
  // Evaluate iterator ranges and produce all index combinations
  const iteratorValues = computeIteratorValues(forEq.iterators, prefix);

  // For each combination, substitute iterator values and flatten body equations
  for (const binding of iteratorValues) {
    for (const bodyEq of forEq.equations) {
      const substituted = substituteIterators(bodyEq, binding);
      flattenEquation(env, substituted, prefix, equations, connectStatements);
    }
  }
}

interface IteratorBinding {
  [name: string]: number;
}

function computeIteratorValues(
  iterators: ForIterator[],
  prefix: string
): IteratorBinding[] {
  if (iterators.length === 0) return [{}];

  const first = iterators[0];
  const rest = iterators.slice(1);

  // Evaluate the range expression to get concrete values
  const rangeValues = evaluateRange(first.range!, prefix);
  const restBindings = computeIteratorValues(rest, prefix);

  // Cartesian product
  const result: IteratorBinding[] = [];
  for (const val of rangeValues) {
    for (const restBinding of restBindings) {
      result.push({ [first.name]: val, ...restBinding });
    }
  }
  return result;
}

function evaluateRange(rangeExpr: Expression, prefix: string): number[] {
  // For a range expression start:stop or start:step:stop,
  // evaluate the bounds and produce the sequence.
  if (rangeExpr.kind === "RangeExpr") {
    const start = evaluateParameterExpression(rangeExpr.start, prefix, new Map()) as number;
    const stop = evaluateParameterExpression(rangeExpr.stop, prefix, new Map()) as number;
    const step = rangeExpr.step
      ? evaluateParameterExpression(rangeExpr.step, prefix, new Map()) as number
      : 1;

    const values: number[] = [];
    for (let i = start; step > 0 ? i <= stop : i >= stop; i += step) {
      values.push(i);
    }
    return values;
  }

  // Could also be a plain integer or an array expression
  throw new Error("Unsupported range expression");
}
```

#### Iterator substitution

When unrolling `for i in 1:N-1 loop connect(r[i].n, r[i+1].p); end for`, each occurrence of `i` in the body must be replaced with the concrete value. This is an AST-level substitution — walk the equation's expressions and replace `ComponentReference("i")` with `IntegerLiteral(value)`.

```typescript
function substituteIterators(eq: EquationNode, binding: IteratorBinding): EquationNode {
  switch (eq.kind) {
    case "SimpleEquation":
      return {
        ...eq,
        lhs: substituteInExpression(eq.lhs, binding),
        rhs: substituteInExpression(eq.rhs, binding),
      };

    case "ConnectEquation":
      return {
        ...eq,
        from: substituteInComponentRef(eq.from, binding),
        to: substituteInComponentRef(eq.to, binding),
      };

    case "ForEquation":
      // Nested for-loops: substitute in the body but not in the iterator name
      return {
        ...eq,
        equations: eq.equations.map(e => substituteIterators(e, binding)),
      };

    default:
      return eq; // extend for other equation types as needed
  }
}

function substituteInExpression(expr: Expression, binding: IteratorBinding): Expression {
  switch (expr.kind) {
    case "ComponentReference": {
      const name = componentReferenceToString(expr.ref);
      if (name in binding) {
        return {
          kind: "IntegerLiteral",
          span: expr.span,
          value: binding[name],
        };
      }
      // Also substitute within subscripts
      return {
        ...expr,
        ref: substituteInComponentRef(expr.ref, binding),
      };
    }

    case "BinaryExpr":
      return {
        ...expr,
        left: substituteInExpression(expr.left, binding),
        right: substituteInExpression(expr.right, binding),
      };

    case "UnaryExpr":
      return {
        ...expr,
        operand: substituteInExpression(expr.operand, binding),
      };

    case "FunctionCallExpr":
      return {
        ...expr,
        args: {
          ...expr.args,
          positional: expr.args.positional.map(a => substituteInExpression(a, binding)),
        },
      };

    case "IfExpr":
      return {
        ...expr,
        condition: substituteInExpression(expr.condition, binding),
        thenExpr: substituteInExpression(expr.thenExpr, binding),
        elseIfs: expr.elseIfs.map(ei => ({
          condition: substituteInExpression(ei.condition, binding),
          value: substituteInExpression(ei.value, binding),
        })),
        elseExpr: substituteInExpression(expr.elseExpr, binding),
      };

    default:
      return expr; // literals, etc. — no substitution needed
  }
}

function substituteInComponentRef(
  ref: ComponentReference,
  binding: IteratorBinding
): ComponentReference {
  return {
    ...ref,
    parts: ref.parts.map(part => ({
      ...part,
      subscripts: part.subscripts.map(s => substituteInExpression(s, binding)),
    })),
  };
}
```

After substitution, array subscripts that were expressions like `i+1` become `IntegerLiteral(2)` (when `i = 1`). The expression flattening step then converts these into the flat name `r[2].p`.

### 2.7 If-equation flattening

If-equations in the equation section are **conditional equations**, not control flow. During flattening, there are two cases:

1. **Parameter condition** — the condition can be evaluated at compile time. Only the active branch's equations are included; the others are discarded entirely.
2. **Non-parameter condition** — the condition depends on time-varying variables. All branches must be preserved in the flat system for later phases to handle.

```typescript
function flattenIfEquation(
  env: ClassEnvironment,
  ifEq: IfEquation,
  prefix: string,
  equations: FlatEquation[],
  connectStatements: { from: string; to: string; connectorType: string }[]
): void {
  // Try to evaluate the condition as a parameter expression
  for (const branch of ifEq.branches) {
    const condValue = tryEvaluateParameterExpression(branch.condition, prefix, new Map());

    if (condValue === true) {
      // This branch is unconditionally active — include its equations, skip the rest
      for (const eq of branch.equations) {
        flattenEquation(env, eq, prefix, equations, connectStatements);
      }
      return;
    }

    if (condValue === false) {
      // This branch is unconditionally inactive — skip it
      continue;
    }

    // Condition is not a parameter expression — preserve the if-equation structurally.
    // Convert the entire if-equation into flat equations with if-expressions.
    flattenRuntimeIfEquation(env, ifEq, prefix, equations, connectStatements);
    return;
  }

  // All branches were false — use the else branch
  for (const eq of ifEq.elseEquations) {
    flattenEquation(env, eq, prefix, equations, connectStatements);
  }
}
```

Runtime if-equations (where the condition depends on time-varying variables) must be converted into equations that contain if-expressions. Each branch must contribute the same number of equations for the same variables — this is a Modelica semantic rule that should be verified during flattening. The conversion takes the i-th equation from each branch and wraps them:

```typescript
function flattenRuntimeIfEquation(
  env: ClassEnvironment,
  ifEq: IfEquation,
  prefix: string,
  equations: FlatEquation[],
  connectStatements: { from: string; to: string; connectorType: string }[]
): void {
  // Each branch must have the same number of equations
  const numEqs = ifEq.branches[0].equations.length;
  for (const branch of ifEq.branches) {
    if (branch.equations.length !== numEqs) {
      throw new Error("If-equation branches must have the same number of equations");
    }
  }
  if (ifEq.elseEquations.length !== numEqs) {
    throw new Error("If-equation else branch must have the same number of equations");
  }

  // For each equation position, create a conditional equation
  for (let i = 0; i < numEqs; i++) {
    // Build: if c1 then lhs1 else if c2 then lhs2 ... else lhsN
    // for both lhs and rhs of the simple equations
    const branchEqs = ifEq.branches.map(b => b.equations[i] as SimpleEquation);
    const elseEq = ifEq.elseEquations[i] as SimpleEquation;

    const lhs = buildConditionalExpr(
      ifEq.branches.map(b => flattenExpression(b.condition, prefix)),
      branchEqs.map(eq => flattenExpression(eq.lhs, prefix)),
      flattenExpression(elseEq.lhs, prefix)
    );

    const rhs = buildConditionalExpr(
      ifEq.branches.map(b => flattenExpression(b.condition, prefix)),
      branchEqs.map(eq => flattenExpression(eq.rhs, prefix)),
      flattenExpression(elseEq.rhs, prefix)
    );

    equations.push({ lhs, rhs, origin: `${prefix} (conditional)` });
  }
}

function buildConditionalExpr(
  conditions: FlatExpr[],
  values: FlatExpr[],
  elseValue: FlatExpr
): FlatExpr {
  // If all values are identical, no conditional is needed
  // (common case: lhs is the same variable in all branches)
  if (values.every(v => flatExprEqual(v, values[0]))) {
    return values[0];
  }

  return {
    kind: "if",
    condition: conditions[0],
    thenExpr: values[0],
    elseIfs: conditions.slice(1).map((c, i) => ({
      condition: c,
      value: values[i + 1],
    })),
    elseExpr: elseValue,
  };
}
```

---

## Part 3: Connect Resolution

Connect resolution is the most algorithmically interesting part of flattening. It transforms `connect` statements into actual equations using the connection set algorithm described in the overview.

### 3.1 Union-Find data structure

The foundation is a union-find (disjoint set) structure for grouping connectors into connection sets:

```typescript
class UnionFind<T> {
  private parent: Map<string, string>;
  private rank: Map<string, number>;
  private members: Map<string, Set<string>>;

  constructor() {
    this.parent = new Map();
    this.rank = new Map();
    this.members = new Map();
  }

  makeSet(key: string): void {
    if (this.parent.has(key)) return;
    this.parent.set(key, key);
    this.rank.set(key, 0);
    this.members.set(key, new Set([key]));
  }

  find(key: string): string {
    let root = key;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // Path compression
    let current = key;
    while (current !== root) {
      const next = this.parent.get(current)!;
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;

    // Union by rank
    const rankA = this.rank.get(rootA)!;
    const rankB = this.rank.get(rootB)!;

    let newRoot: string, merged: string;
    if (rankA < rankB) {
      this.parent.set(rootA, rootB);
      newRoot = rootB;
      merged = rootA;
    } else if (rankA > rankB) {
      this.parent.set(rootB, rootA);
      newRoot = rootA;
      merged = rootB;
    } else {
      this.parent.set(rootB, rootA);
      this.rank.set(rootA, rankA + 1);
      newRoot = rootA;
      merged = rootB;
    }

    // Merge member sets
    const newMembers = this.members.get(newRoot)!;
    for (const m of this.members.get(merged)!) {
      newMembers.add(m);
    }
    this.members.delete(merged);
  }

  getSet(key: string): Set<string> {
    const root = this.find(key);
    return this.members.get(root)!;
  }

  getAllSets(): Set<string>[] {
    const roots = new Set<string>();
    for (const key of this.parent.keys()) {
      roots.add(this.find(key));
    }
    return Array.from(roots).map(r => this.members.get(r)!);
  }
}
```

### 3.2 Connector type information

To generate the correct equations, the connect resolver needs to know which variables inside a connector are flow variables and which are across (non-flow) variables. This information comes from the class definitions of the connector types.

```typescript
interface ConnectorInfo {
  variables: { name: string; isFlow: boolean }[];
}

function getConnectorInfo(
  env: ClassEnvironment,
  connectorPath: string,
  variables: FlatVariable[]
): ConnectorInfo {
  // Find all flat variables that are direct children of this connector
  const prefix = connectorPath + ".";
  const connectorVars: { name: string; isFlow: boolean }[] = [];

  for (const v of variables) {
    if (v.name.startsWith(prefix)) {
      const suffix = v.name.slice(prefix.length);
      // Only direct children (no dots in the suffix)
      if (!suffix.includes(".")) {
        connectorVars.push({
          name: suffix,
          isFlow: v.isFlow,
        });
      }
    }
  }

  return { variables: connectorVars };
}
```

This approach inspects the flat variable list directly rather than walking the class hierarchy again. Since flattening has already created all variables with their `isFlow` flags, we can just filter by prefix. This works because connectors in Modelica are shallow — their variables are primitive types (`Real`), not nested models.

### 3.3 The full connection resolution algorithm

```typescript
function resolveConnections(
  env: ClassEnvironment,
  connectStatements: { from: string; to: string }[],
  variables: FlatVariable[]
): FlatEquation[] {
  if (connectStatements.length === 0) return [];

  // Step 1: Build connection sets using union-find
  const uf = new UnionFind<string>();

  // Each connector mentioned in any connect statement gets a set
  for (const conn of connectStatements) {
    uf.makeSet(conn.from);
    uf.makeSet(conn.to);
    uf.union(conn.from, conn.to);
  }

  // Step 2: Get all unique connection sets
  const connectionSets = uf.getAllSets();

  // Step 3: For each connection set, generate equations
  const equations: FlatEquation[] = [];

  for (const connSet of connectionSets) {
    const connectors = Array.from(connSet);
    if (connectors.length < 2) continue;

    // Get connector variable info from the first connector
    // (all connectors in a set must have the same type)
    const info = getConnectorInfo(env, connectors[0], variables);

    for (const varInfo of info.variables) {
      if (varInfo.isFlow) {
        // Flow variable: sum to zero
        // c1.i + c2.i + ... + cn.i = 0
        const terms: FlatExpr[] = connectors.map(c => ({
          kind: "variable" as const,
          name: `${c}.${varInfo.name}`,
        }));

        const sum = terms.reduce<FlatExpr>((acc, term) => ({
          kind: "binary",
          op: "+",
          left: acc,
          right: term,
        }));

        equations.push({
          lhs: sum,
          rhs: { kind: "real", value: 0 },
          origin: `connect flow: {${connectors.join(", ")}}.${varInfo.name}`,
        });
      } else {
        // Across variable: chain equalities
        // c1.v = c2.v, c2.v = c3.v, ...
        for (let i = 0; i < connectors.length - 1; i++) {
          equations.push({
            lhs: { kind: "variable", name: `${connectors[i]}.${varInfo.name}` },
            rhs: { kind: "variable", name: `${connectors[i + 1]}.${varInfo.name}` },
            origin: `connect across: ${connectors[i]}.${varInfo.name} = ${connectors[i + 1]}.${varInfo.name}`,
          });
        }
      }
    }
  }

  return equations;
}
```

For the SimpleCircuit example with four pairwise connections, the union-find produces four connection sets of size 2 (since no connector appears in more than one connect statement). Each set generates one across equation and one flow equation, for a total of 8 connection equations.

For the T-junction example (`connect(R1.n, R2.p); connect(R2.p, R3.p)`), the union-find merges `R1.n`, `R2.p`, and `R3.p` into one set. The across variables produce 2 equations (`R1.n.v = R2.p.v`, `R2.p.v = R3.p.v`), and the flow variable produces 1 equation (`R1.n.i + R2.p.i + R3.p.i = 0`).

### 3.4 Unconnected connectors

A subtlety not mentioned in the overview: connectors that are declared but never appear in any `connect` statement also need equations. Modelica's rule is that an unconnected flow variable is set to zero:

```
If a flow variable is not connected, its value is 0.
```

This must be checked after all connection sets are built:

```typescript
function generateUnconnectedFlowEquations(
  variables: FlatVariable[],
  connectedFlowVars: Set<string>
): FlatEquation[] {
  const equations: FlatEquation[] = [];

  for (const v of variables) {
    if (v.isFlow && !connectedFlowVars.has(v.name)) {
      equations.push({
        lhs: { kind: "variable", name: v.name },
        rhs: { kind: "real", value: 0 },
        origin: `unconnected flow: ${v.name} = 0`,
      });
    }
  }

  return equations;
}
```

The `connectedFlowVars` set is built during `resolveConnections` by collecting all flow variable names that appear in any connection set.

---

## Part 4: Parameter Expression Evaluation

Several flattening operations require evaluating expressions at compile time:

- Array dimensions (`Resistor r[N]` — must know `N`)
- Conditional component conditions (`HeatPort hp if useHeatPort`)
- For-loop ranges (`for i in 1:N-1 loop`)
- Parameter binding expressions (`parameter Real R = 100.0`)

These expressions can only involve parameters, constants, literals, and basic arithmetic — no time-varying variables, no `der()`, no calls to non-constant functions.

### 4.1 A minimal evaluator

```typescript
type ParameterValue = number | boolean | string;

function evaluateParameterExpression(
  expr: Expression,
  prefix: string,
  paramValues: Map<string, ParameterValue>
): ParameterValue {
  switch (expr.kind) {
    case "IntegerLiteral":
    case "RealLiteral":
      return expr.value;

    case "BooleanLiteral":
      return expr.value;

    case "StringLiteral":
      return expr.value;

    case "ComponentReference": {
      const name = prefixReference(componentReferenceToString(expr.ref), prefix);
      const val = paramValues.get(name);
      if (val === undefined) {
        throw new Error(`Cannot evaluate parameter expression: unknown value for ${name}`);
      }
      return val;
    }

    case "BinaryExpr": {
      const left = evaluateParameterExpression(expr.left, prefix, paramValues);
      const right = evaluateParameterExpression(expr.right, prefix, paramValues);

      if (typeof left === "number" && typeof right === "number") {
        switch (expr.op) {
          case "+": return left + right;
          case "-": return left - right;
          case "*": return left * right;
          case "/": return left / right;
          case "^": return Math.pow(left, right);
          case "<": return left < right;
          case "<=": return left <= right;
          case ">": return left > right;
          case ">=": return left >= right;
          case "==": return left === right;
          case "<>": return left !== right;
        }
      }

      if (typeof left === "boolean" && typeof right === "boolean") {
        switch (expr.op) {
          case "and": return left && right;
          case "or": return left || right;
          case "==": return left === right;
          case "<>": return left !== right;
        }
      }

      throw new Error(`Cannot evaluate: ${expr.op} with operands of these types`);
    }

    case "UnaryExpr": {
      const operand = evaluateParameterExpression(expr.operand, prefix, paramValues);
      switch (expr.op) {
        case "-": return -(operand as number);
        case "+": return +(operand as number);
        case "not": return !(operand as boolean);
      }
      break;
    }

    case "FunctionCallExpr": {
      const funcName = componentReferenceToString(expr.name);
      const args = expr.args.positional.map(a =>
        evaluateParameterExpression(a, prefix, paramValues)
      );

      // Built-in math functions
      switch (funcName) {
        case "abs":   return Math.abs(args[0] as number);
        case "sqrt":  return Math.sqrt(args[0] as number);
        case "sin":   return Math.sin(args[0] as number);
        case "cos":   return Math.cos(args[0] as number);
        case "exp":   return Math.exp(args[0] as number);
        case "log":   return Math.log(args[0] as number);
        case "floor": return Math.floor(args[0] as number);
        case "ceil":  return Math.ceil(args[0] as number);
        case "mod":   return (args[0] as number) % (args[1] as number);
        case "min":   return Math.min(args[0] as number, args[1] as number);
        case "max":   return Math.max(args[0] as number, args[1] as number);
        case "integer": return Math.floor(args[0] as number);
      }

      throw new Error(`Cannot evaluate function call: ${funcName}`);
    }

    case "IfExpr": {
      const cond = evaluateParameterExpression(expr.condition, prefix, paramValues);
      if (cond === true) {
        return evaluateParameterExpression(expr.thenExpr, prefix, paramValues);
      }
      for (const ei of expr.elseIfs) {
        if (evaluateParameterExpression(ei.condition, prefix, paramValues) === true) {
          return evaluateParameterExpression(ei.value, prefix, paramValues);
        }
      }
      return evaluateParameterExpression(expr.elseExpr, prefix, paramValues);
    }

    default:
      throw new Error(`Cannot evaluate expression of kind: ${(expr as any).kind}`);
  }

  throw new Error("Unreachable");
}
```

#### Soft evaluation

Some callers need to *try* evaluating an expression without failing — for instance, if-equation flattening checks whether a condition is a compile-time constant, and falls back to runtime handling if not:

```typescript
function tryEvaluateParameterExpression(
  expr: Expression,
  prefix: string,
  paramValues: Map<string, ParameterValue>
): ParameterValue | null {
  try {
    return evaluateParameterExpression(expr, prefix, paramValues);
  } catch {
    return null;
  }
}
```

### 4.2 Parameter value collection

Before parameter expressions can be evaluated, the values of all parameters must be known. This creates an ordering dependency — parameter `a` might depend on parameter `b` (e.g., `parameter Real a = 2 * b`). Parameters must be evaluated in dependency order.

For a first implementation, a simple two-pass approach works:

1. First pass: collect all parameters with literal binding expressions (no dependencies)
2. Second pass: attempt to evaluate remaining parameters using values from pass 1; repeat until no more progress is made

```typescript
function collectParameterValues(variables: FlatVariable[]): Map<string, ParameterValue> {
  const values = new Map<string, ParameterValue>();

  // Collect parameters that need evaluation
  const pending: FlatVariable[] = [];

  for (const v of variables) {
    if (v.variability === "parameter" || v.variability === "constant") {
      if (v.bindingExpression) {
        // Try to evaluate immediately
        const val = tryEvaluateFlatExpr(v.bindingExpression, values);
        if (val !== null) {
          values.set(v.name, val);
        } else {
          pending.push(v);
        }
      }
    }
  }

  // Iteratively resolve dependent parameters
  let changed = true;
  while (changed && pending.length > 0) {
    changed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const v = pending[i];
      const val = tryEvaluateFlatExpr(v.bindingExpression!, values);
      if (val !== null) {
        values.set(v.name, val);
        pending.splice(i, 1);
        changed = true;
      }
    }
  }

  if (pending.length > 0) {
    const names = pending.map(v => v.name).join(", ");
    throw new Error(`Could not evaluate parameter values for: ${names}`);
  }

  return values;
}
```

In practice, the parameter evaluation and the component instantiation are interleaved — you evaluate a parameter's binding expression as soon as you encounter it during flattening, using the parameter values collected so far. This works because Modelica requires that parameter expressions form a DAG (no circular dependencies), and the natural top-down traversal visits parameters before the components that use them.

---

## Part 5: Redeclare and Replaceable

Redeclare is the most complex feature to implement in flattening. It allows replacing a type or component from a base class with a different one at the point of instantiation.

### 5.1 How redeclare works in the flattening flow

When the flattener processes `extends GenericCircuit(redeclare model ResistorModel = HeatedResistor)`:

1. Look up `GenericCircuit` and begin resolving it
2. In `GenericCircuit`, find the `replaceable model ResistorModel = Resistor` declaration
3. The `redeclare` modification says: replace `ResistorModel` with `HeatedResistor`
4. Before instantiating `R1` (which has type `ResistorModel`), substitute the new type

The key is that redeclarations are processed as **modifications on extends clauses**. They are part of the modification environment, but instead of modifying parameter values, they modify type bindings.

```typescript
interface TypeBindings {
  // Maps replaceable class names to their actual types
  typeMap: Map<string, string>;   // e.g., "ResistorModel" -> "HeatedResistor"
}
```

During flattening, when looking up the type of a component, check the type bindings first:

```typescript
function resolveComponentType(
  declaredType: string,
  typeBindings: TypeBindings,
  env: ClassEnvironment,
  enclosingScopes: string[]
): string {
  // Check if the type has been redeclared
  const rebound = typeBindings.typeMap.get(declaredType);
  const typeName = rebound ?? declaredType;

  return resolveClassName(env, typeName, enclosingScopes);
}
```

### 5.2 ConstrainedBy checking

When a replaceable component has a `constrainedby` clause, the replacement must be a subtype of the constraining type. In Modelica, subtyping is **structural** — type `A` is a subtype of `B` if `A` has at least all the components and equations that `B` has (with compatible types).

For a first implementation, a simple check suffices: verify that every component declared in the constraining type exists in the replacement type with a compatible type name:

```typescript
function checkConstrainedBy(
  env: ClassEnvironment,
  replacementName: string,
  constraintName: string
): void {
  const replacement = env.lookup(replacementName);
  const constraint = env.lookup(constraintName);
  if (!replacement || !constraint) {
    throw new Error(`Type not found during constrainedby check`);
  }

  const replacementResolved = resolveClass(env, replacementName, replacement);
  const constraintResolved = resolveClass(env, constraintName, constraint);

  // Every element in the constraint must exist in the replacement
  for (const constElement of constraintResolved.elements) {
    const constName = getElementName(constElement);
    const replElement = replacementResolved.elements.find(
      e => getElementName(e) === constName
    );
    if (!replElement) {
      throw new Error(
        `Redeclare violation: ${replacementName} is missing component '${constName}' ` +
        `required by constrainedby ${constraintName}`
      );
    }
  }
}
```

---

## Worked Example

Trace of flattening `SimpleCircuit` from the overview document:

**Input:** The AST for `SimpleCircuit`, `Battery`, `Switch`, `Resistor`, `Capacitor`, and `Pin` in the class environment.

**Step 1: Resolve `SimpleCircuit`** — no extends clauses, so the resolved class is just the class itself with four component declarations and four connect equations.

**Step 2: Flatten each component**

`Battery B(V = 12.0)`:
- Look up `Battery`. It has elements `Pin p`, `Pin n`, `parameter Real V = 12.0`.
- Outer modification: `V → {binding: 12.0}`. This matches the default, but the outer wins regardless.
- Recurse into `Pin p` with prefix `B.p`:
  - `Pin` has `Real v` and `flow Real i`.
  - `Real v` is a built-in type → create `FlatVariable("B.p.v", "Real", continuous, flow=false)`
  - `flow Real i` → create `FlatVariable("B.p.i", "Real", continuous, flow=true)`
- Recurse into `Pin n` → creates `B.n.v`, `B.n.i`
- `parameter Real V` → create `FlatVariable("B.V", "Real", parameter, binding=12.0)`
- Collect Battery's equations with prefix `B`:
  - `p.v - n.v = V` → `B.p.v - B.n.v = B.V`
  - `p.i + n.i = 0` → `B.p.i + B.n.i = 0`

`Switch S`: similarly creates `S.p.v`, `S.p.i`, `S.n.v`, `S.n.i`, `S.Ron`, `S.Roff`, `S.closed` and three equations (including the conditional `if S.closed then S.Ron else S.Roff`).

`Resistor R1(R = 100.0)`: creates `R1.p.v`, `R1.p.i`, `R1.n.v`, `R1.n.i`, `R1.R` (binding 100.0, overriding default 1.0) and two equations.

`Capacitor C1(C = 1e-6)`: creates `C1.p.v`, `C1.p.i`, `C1.n.v`, `C1.n.i`, `C1.C` (binding 1e-6) and two equations.

**Step 3: Resolve connections**

Four connect statements collected:
- `connect(B.p, S.p)` → union `B.p` and `S.p`
- `connect(S.n, R1.p)` → union `S.n` and `R1.p`
- `connect(R1.n, C1.p)` → union `R1.n` and `C1.p`
- `connect(C1.n, B.n)` → union `C1.n` and `B.n`

Four connection sets of size 2. For each, get connector info from the flat variables (each Pin has `v` (non-flow) and `i` (flow)):

- `{B.p, S.p}`: `B.p.v = S.p.v` (across), `B.p.i + S.p.i = 0` (flow)
- `{S.n, R1.p}`: `S.n.v = R1.p.v`, `S.n.i + R1.p.i = 0`
- `{R1.n, C1.p}`: `R1.n.v = C1.p.v`, `R1.n.i + C1.p.i = 0`
- `{C1.n, B.n}`: `C1.n.v = B.n.v`, `C1.n.i + B.n.i = 0`

**Result:** 22 flat variables (17 unknowns + 5 parameters), 17 equations. This matches the flat system shown in section 2.8 of the overview document.

---

## Testing

**Unit tests for modification merging:** Create `MergedModification` values for the three-level example (`Inner`/`Middle`/`Outer`) and verify the merge produces the correct result. Test that outer modifications override inner ones on the same path, and that non-overlapping modifications are preserved.

**Unit tests for union-find:** Test basic operations (make, union, find), path compression, and the `getAllSets` method. Verify the T-junction example produces one set of three connectors.

**Unit tests for connect resolution:** Given known flat variables and connect statements, verify the generated equations are correct. Test pairwise connections, T-junctions, and larger fan-outs.

**Integration tests:** Flatten the `SimpleCircuit` model end-to-end and verify the output matches the expected 17 variables and 17 equations. Flatten the `Chain` model with `N = 3` and verify the array expansion and for-loop unrolling produce the correct number of variables and equations.

**Round-trip tests:** Write a flat system printer that outputs the variable list and equation list in a readable format. Use this for snapshot testing — flatten a model, print the result, and compare against a known-good snapshot.
