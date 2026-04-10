# Phase 4: Symbolic Preprocessing — Implementation Details

This document describes how to implement the symbolic preprocessing phase of the Modelica compiler in TypeScript. This phase takes the structural analysis from Phase 3 (classified variables, incidence matrix, matching, BLT decomposition, index assessment) and transforms the equation system into one that a numerical solver can handle efficiently.

This is the mathematically heaviest phase. It performs five operations:

1. **Alias elimination** — remove trivial equalities before the expensive algorithms run
2. **Symbolic differentiation** — the engine that index reduction depends on
3. **Index reduction (Pantelides algorithm)** — differentiate constraint equations to fix high-index problems
4. **Symbolic simplification** — clean up expressions after differentiation
5. **Tearing** — reduce the size of algebraic loops

Alias elimination runs first because it shrinks the system, making everything else faster. Symbolic differentiation is a utility used by index reduction. Index reduction is the central algorithm. Simplification runs after differentiation to clean up the resulting expressions. Tearing runs after the final BLT decomposition.

---

## Part 1: Alias Elimination

### 1.1 What aliases look like

Flattening produces many trivial equations from connection resolution. These take three forms:

- **Direct alias:** `a = b` — two variables are identical
- **Negated alias:** `a = -b` — one variable is the negation of another
- **Constant alias:** `a = 0` or `a = 3.7` — a variable equals a constant

These equations carry no mathematical content for the solver. Eliminating them before the structural algorithms run reduces the system size by 30–50% in typical models.

### 1.2 Detecting aliases

An equation is an alias if it has the form `variable = variable`, `variable = -variable`, or `variable = constant` (or any symmetric rearrangement). Detection requires inspecting the equation's flat expression structure:

```typescript
type AliasKind =
  | { kind: "direct"; a: string; b: string }         // a = b
  | { kind: "negated"; a: string; b: string }         // a = -b
  | { kind: "constant"; variable: string; value: number };  // a = c

function detectAlias(eq: FlatEquation): AliasKind | null {
  const lhs = eq.lhs;
  const rhs = eq.rhs;

  // a = b
  if (lhs.kind === "variable" && rhs.kind === "variable") {
    return { kind: "direct", a: lhs.name, b: rhs.name };
  }

  // a = -b
  if (lhs.kind === "variable" && rhs.kind === "unary"
      && rhs.op === "-" && rhs.operand.kind === "variable") {
    return { kind: "negated", a: lhs.name, b: rhs.operand.name };
  }

  // -a = b  (symmetric)
  if (lhs.kind === "unary" && lhs.op === "-"
      && lhs.operand.kind === "variable" && rhs.kind === "variable") {
    return { kind: "negated", a: rhs.name, b: lhs.operand.name };
  }

  // a = constant
  if (lhs.kind === "variable" && isConstantExpr(rhs)) {
    return { kind: "constant", variable: lhs.name, value: evalConstant(rhs) };
  }

  // constant = a  (symmetric)
  if (rhs.kind === "variable" && isConstantExpr(lhs)) {
    return { kind: "constant", variable: rhs.name, value: evalConstant(lhs) };
  }

  // a + b = 0  →  a = -b
  if (isZero(rhs) && lhs.kind === "binary" && lhs.op === "+") {
    if (lhs.left.kind === "variable" && lhs.right.kind === "variable") {
      return { kind: "negated", a: lhs.left.name, b: lhs.right.name };
    }
  }

  // a - b = 0  →  a = b
  if (isZero(rhs) && lhs.kind === "binary" && lhs.op === "-") {
    if (lhs.left.kind === "variable" && lhs.right.kind === "variable") {
      return { kind: "direct", a: lhs.left.name, b: lhs.right.name };
    }
  }

  return null;
}

function isConstantExpr(expr: FlatExpr): boolean {
  return expr.kind === "real" || expr.kind === "integer";
}

function isZero(expr: FlatExpr): boolean {
  return (expr.kind === "real" && expr.value === 0)
      || (expr.kind === "integer" && expr.value === 0);
}

function evalConstant(expr: FlatExpr): number {
  if (expr.kind === "real" || expr.kind === "integer") return expr.value;
  throw new Error("Not a constant");
}
```

### 1.3 The alias map

When an alias `a = b` is found, one variable becomes the **representative** and the other becomes an **alias**. All references to the alias are replaced with the representative throughout the system. The alias variable and its equation are removed.

The alias relationships can chain: `a = b`, `b = c` means both `a` and `b` should map to `c`. A union-find structure (reused from Phase 2) handles transitive closure:

```typescript
interface AliasEntry {
  representative: string;
  sign: 1 | -1;     // 1 for direct alias, -1 for negated alias
  offset: number;    // for constant aliases (representative is a synthetic constant)
}

class AliasMap {
  private parent: Map<string, string>;
  private signToParent: Map<string, 1 | -1>;
  private constants: Map<string, number>;

  constructor() {
    this.parent = new Map();
    this.signToParent = new Map();
    this.constants = new Map();
  }

  private findRoot(name: string): { root: string; sign: 1 | -1 } {
    let sign: 1 | -1 = 1;
    let current = name;

    while (this.parent.has(current) && this.parent.get(current) !== current) {
      sign = (sign * this.signToParent.get(current)!) as 1 | -1;
      current = this.parent.get(current)!;
    }

    return { root: current, sign };
  }

  addDirectAlias(a: string, b: string): void {
    const rootA = this.findRoot(a);
    const rootB = this.findRoot(b);
    if (rootA.root === rootB.root) return; // already aliased

    // Make b's root the parent of a's root
    this.parent.set(rootA.root, rootB.root);
    // sign: a = sign_a * rootA, b = sign_b * rootB, and a = b
    // so rootA = (sign_b / sign_a) * rootB
    this.signToParent.set(rootA.root, (rootA.sign * rootB.sign) as 1 | -1);
  }

  addNegatedAlias(a: string, b: string): void {
    const rootA = this.findRoot(a);
    const rootB = this.findRoot(b);
    if (rootA.root === rootB.root) return;

    this.parent.set(rootA.root, rootB.root);
    // a = -b, so rootA = -(sign_b / sign_a) * rootB
    this.signToParent.set(rootA.root, (-rootA.sign * rootB.sign) as 1 | -1);
  }

  addConstantAlias(variable: string, value: number): void {
    const root = this.findRoot(variable);
    this.constants.set(root.root, value * root.sign);
  }

  resolve(name: string): { name: string; sign: 1 | -1 } | { constant: number } {
    const { root, sign } = this.findRoot(name);

    if (this.constants.has(root)) {
      return { constant: this.constants.get(root)! * sign };
    }

    return { name: root, sign };
  }
}
```

### 1.4 Applying aliases to the system

After building the alias map, substitute throughout all remaining equations:

```typescript
function eliminateAliases(flat: FlatSystem): FlatSystem {
  const aliasMap = new AliasMap();
  const keptEquations: FlatEquation[] = [];

  // First pass: identify all aliases
  for (const eq of flat.equations) {
    const alias = detectAlias(eq);
    if (alias) {
      switch (alias.kind) {
        case "direct":
          aliasMap.addDirectAlias(alias.a, alias.b);
          break;
        case "negated":
          aliasMap.addNegatedAlias(alias.a, alias.b);
          break;
        case "constant":
          aliasMap.addConstantAlias(alias.variable, alias.value);
          break;
      }
      // This equation is consumed — do not keep it
    } else {
      keptEquations.push(eq);
    }
  }

  // Second pass: substitute aliases in remaining equations
  const substitutedEquations = keptEquations.map(eq => ({
    lhs: substituteAliases(eq.lhs, aliasMap),
    rhs: substituteAliases(eq.rhs, aliasMap),
    origin: eq.origin,
  }));

  // Remove aliased variables from the variable list
  const keptVariables = flat.variables.filter(v => {
    const resolved = aliasMap.resolve(v.name);
    return "name" in resolved && resolved.name === v.name;
  });

  return { variables: keptVariables, equations: substitutedEquations };
}

function substituteAliases(expr: FlatExpr, aliasMap: AliasMap): FlatExpr {
  switch (expr.kind) {
    case "variable": {
      const resolved = aliasMap.resolve(expr.name);
      if ("constant" in resolved) {
        return { kind: "real", value: resolved.constant };
      }
      if (resolved.name !== expr.name || resolved.sign !== 1) {
        const ref: FlatExpr = { kind: "variable", name: resolved.name };
        return resolved.sign === -1
          ? { kind: "unary", op: "-", operand: ref }
          : ref;
      }
      return expr;
    }

    case "binary":
      return {
        kind: "binary",
        op: expr.op,
        left: substituteAliases(expr.left, aliasMap),
        right: substituteAliases(expr.right, aliasMap),
      };

    case "unary":
      return {
        kind: "unary",
        op: expr.op,
        operand: substituteAliases(expr.operand, aliasMap),
      };

    case "call":
      return {
        kind: "call",
        name: expr.name,
        args: expr.args.map(a => substituteAliases(a, aliasMap)),
      };

    case "if":
      return {
        kind: "if",
        condition: substituteAliases(expr.condition, aliasMap),
        thenExpr: substituteAliases(expr.thenExpr, aliasMap),
        elseIfs: expr.elseIfs.map(ei => ({
          condition: substituteAliases(ei.condition, aliasMap),
          value: substituteAliases(ei.value, aliasMap),
        })),
        elseExpr: substituteAliases(expr.elseExpr, aliasMap),
      };

    default:
      return expr;
  }
}
```

### 1.5 Ordering: alias elimination runs first

Alias elimination runs before Phase 3's structural analysis (incidence, matching, BLT). The pipeline becomes:

```
Phase 2 output → alias elimination → Phase 3 (incidence, matching, BLT) → index reduction → ...
```

This means Phase 3 works with a smaller system. For the SimpleCircuit, the 17 variables and 17 equations shrink to roughly 10 variables and 10 equations after alias elimination removes the connection equalities. The Hopcroft-Karp and Tarjan algorithms then run on this smaller system.

---

## Part 2: Symbolic Differentiation

Symbolic differentiation is a utility used by the Pantelides algorithm. Given an expression tree, it produces a new expression tree representing the total time derivative.

### 2.1 The differentiation function

The function takes a `FlatExpr` and returns a `FlatExpr` representing `d/dt(expr)`. It needs to know which variables are time-varying (to distinguish them from parameters/constants):

```typescript
function differentiate(
  expr: FlatExpr,
  parameters: Map<string, FlatVariable>
): FlatExpr {
  switch (expr.kind) {
    case "real":
    case "integer":
    case "boolean":
    case "string":
      // Constants → 0
      return { kind: "real", value: 0 };

    case "time":
      // d/dt(time) = 1
      return { kind: "real", value: 1 };

    case "variable": {
      if (parameters.has(expr.name)) {
        // Parameter → 0
        return { kind: "real", value: 0 };
      }
      // Time-varying variable → der(variable)
      return { kind: "call", name: "der", args: [expr] };
    }

    case "unary": {
      // d/dt(-f) = -(d/dt(f))
      // d/dt(+f) = +(d/dt(f))
      const df = differentiate(expr.operand, parameters);
      return { kind: "unary", op: expr.op, operand: df };
    }

    case "binary":
      return differentiateBinary(expr, parameters);

    case "call":
      return differentiateCall(expr, parameters);

    case "if": {
      // d/dt(if c then a else b) = if c then d/dt(a) else d/dt(b)
      // The condition is not differentiated (it is Boolean).
      return {
        kind: "if",
        condition: expr.condition,
        thenExpr: differentiate(expr.thenExpr, parameters),
        elseIfs: expr.elseIfs.map(ei => ({
          condition: ei.condition,
          value: differentiate(ei.value, parameters),
        })),
        elseExpr: differentiate(expr.elseExpr, parameters),
      };
    }
  }
}
```

### 2.2 Binary operator differentiation

```typescript
function differentiateBinary(expr: BinaryExpr, parameters: Map<string, FlatVariable>): FlatExpr {
  const f = expr.left;
  const g = expr.right;
  const df = differentiate(f, parameters);
  const dg = differentiate(g, parameters);

  switch (expr.op) {
    case "+":
    case ".+":
      // d/dt(f + g) = df + dg
      return mkAdd(df, dg);

    case "-":
    case ".-":
      // d/dt(f - g) = df - dg
      return mkSub(df, dg);

    case "*":
    case ".*":
      // d/dt(f * g) = f * dg + g * df   (product rule)
      return mkAdd(mkMul(f, dg), mkMul(g, df));

    case "/":
    case "./":
      // d/dt(f / g) = (g * df - f * dg) / g^2   (quotient rule)
      return mkDiv(
        mkSub(mkMul(g, df), mkMul(f, dg)),
        mkPow(g, { kind: "real", value: 2 })
      );

    case "^":
    case ".^": {
      // If exponent is constant: d/dt(f^n) = n * f^(n-1) * df  (power rule)
      if (isConstantOrParam(g, parameters)) {
        return mkMul(
          mkMul(g, mkPow(f, mkSub(g, { kind: "real", value: 1 }))),
          df
        );
      }
      // General case: f^g where both vary — use logarithmic differentiation
      // d/dt(f^g) = f^g * (g' * ln(f) + g * f'/f)
      return mkMul(
        mkPow(f, g),
        mkAdd(
          mkMul(dg, mkCall("log", [f])),
          mkMul(g, mkDiv(df, f))
        )
      );
    }

    // Comparison and logical operators: these produce Booleans, not reals.
    // They should not appear as operands that need differentiation.
    // If they do, it is an error in the equation structure.
    default:
      throw new Error(`Cannot differentiate operator: ${expr.op}`);
  }
}

function isConstantOrParam(expr: FlatExpr, parameters: Map<string, FlatVariable>): boolean {
  switch (expr.kind) {
    case "real":
    case "integer":
      return true;
    case "variable":
      return parameters.has(expr.name);
    default:
      return false;
  }
}
```

### 2.3 Function call differentiation

```typescript
function differentiateCall(expr: FunctionCallExpr, parameters: Map<string, FlatVariable>): FlatExpr {
  const name = expr.name;

  // der(x) → der(der(x)), represented as a new derivative variable
  if (name === "der" && expr.args.length === 1) {
    return { kind: "call", name: "der", args: [expr] };
    // This produces der(der(x)). The Pantelides algorithm
    // will resolve this to a known derivative if one exists
    // (e.g., der(der(x)) = der(vx) when der(x) = vx).
  }

  // Single-argument math functions: chain rule
  if (expr.args.length === 1) {
    const f = expr.args[0];
    const df = differentiate(f, parameters);

    switch (name) {
      case "sin":
        // d/dt(sin(f)) = cos(f) * df
        return mkMul(mkCall("cos", [f]), df);

      case "cos":
        // d/dt(cos(f)) = -sin(f) * df
        return mkMul(mkNeg(mkCall("sin", [f])), df);

      case "tan":
        // d/dt(tan(f)) = df / cos(f)^2
        return mkDiv(df, mkPow(mkCall("cos", [f]), { kind: "real", value: 2 }));

      case "exp":
        // d/dt(exp(f)) = exp(f) * df
        return mkMul(mkCall("exp", [f]), df);

      case "log":
        // d/dt(log(f)) = df / f
        return mkDiv(df, f);

      case "sqrt":
        // d/dt(sqrt(f)) = df / (2 * sqrt(f))
        return mkDiv(df, mkMul({ kind: "real", value: 2 }, mkCall("sqrt", [f])));

      case "abs":
        // d/dt(abs(f)) = sign(f) * df
        return mkMul(mkCall("sign", [f]), df);

      case "asin":
        // d/dt(asin(f)) = df / sqrt(1 - f^2)
        return mkDiv(df, mkCall("sqrt", [mkSub({ kind: "real", value: 1 }, mkPow(f, { kind: "real", value: 2 }))]));

      case "acos":
        // d/dt(acos(f)) = -df / sqrt(1 - f^2)
        return mkNeg(mkDiv(df, mkCall("sqrt", [mkSub({ kind: "real", value: 1 }, mkPow(f, { kind: "real", value: 2 }))])));

      case "atan":
        // d/dt(atan(f)) = df / (1 + f^2)
        return mkDiv(df, mkAdd({ kind: "real", value: 1 }, mkPow(f, { kind: "real", value: 2 })));

      default:
        throw new Error(`Cannot differentiate function: ${name}`);
    }
  }

  // Two-argument functions
  if (expr.args.length === 2) {
    switch (name) {
      case "atan2": {
        // d/dt(atan2(y, x)) = (x * dy - y * dx) / (x^2 + y^2)
        const y = expr.args[0], x = expr.args[1];
        const dy = differentiate(y, parameters);
        const dx = differentiate(x, parameters);
        return mkDiv(
          mkSub(mkMul(x, dy), mkMul(y, dx)),
          mkAdd(mkPow(x, { kind: "real", value: 2 }), mkPow(y, { kind: "real", value: 2 }))
        );
      }
      default:
        throw new Error(`Cannot differentiate function: ${name}`);
    }
  }

  throw new Error(`Cannot differentiate function: ${name} with ${expr.args.length} arguments`);
}
```

### 2.4 Expression constructors

These helper functions build expression nodes. They are where simplification hooks in — each constructor applies basic simplification rules before returning:

```typescript
function mkAdd(a: FlatExpr, b: FlatExpr): FlatExpr {
  // 0 + b = b
  if (isZeroExpr(a)) return b;
  // a + 0 = a
  if (isZeroExpr(b)) return a;
  return { kind: "binary", op: "+", left: a, right: b };
}

function mkSub(a: FlatExpr, b: FlatExpr): FlatExpr {
  if (isZeroExpr(b)) return a;
  if (isZeroExpr(a)) return mkNeg(b);
  return { kind: "binary", op: "-", left: a, right: b };
}

function mkMul(a: FlatExpr, b: FlatExpr): FlatExpr {
  // 0 * b = 0
  if (isZeroExpr(a) || isZeroExpr(b)) return { kind: "real", value: 0 };
  // 1 * b = b
  if (isOneExpr(a)) return b;
  // a * 1 = a
  if (isOneExpr(b)) return a;
  return { kind: "binary", op: "*", left: a, right: b };
}

function mkDiv(a: FlatExpr, b: FlatExpr): FlatExpr {
  if (isZeroExpr(a)) return { kind: "real", value: 0 };
  if (isOneExpr(b)) return a;
  return { kind: "binary", op: "/", left: a, right: b };
}

function mkPow(base: FlatExpr, exp: FlatExpr): FlatExpr {
  if (isZeroExpr(exp)) return { kind: "real", value: 1 };
  if (isOneExpr(exp)) return base;
  return { kind: "binary", op: "^", left: base, right: exp };
}

function mkNeg(a: FlatExpr): FlatExpr {
  if (isZeroExpr(a)) return a;
  // -(-a) = a
  if (a.kind === "unary" && a.op === "-") return a.operand;
  return { kind: "unary", op: "-", operand: a };
}

function mkCall(name: string, args: FlatExpr[]): FlatExpr {
  return { kind: "call", name, args };
}

function isZeroExpr(e: FlatExpr): boolean {
  return (e.kind === "real" && e.value === 0) || (e.kind === "integer" && e.value === 0);
}

function isOneExpr(e: FlatExpr): boolean {
  return (e.kind === "real" && e.value === 1) || (e.kind === "integer" && e.value === 1);
}
```

By applying these rules inside the constructors, the differentiation engine produces simplified expressions as it goes, rather than building bloated trees that need a separate cleanup pass. For example, differentiating `x^2 + y^2 = L^2`:

- `d/dt(L^2)` → `mkMul(2, mkPow(L, 1))` → `mkMul(2, L)` → but `d/dt(L) = 0` (parameter), so the product rule gives `L^2 * 0 + 2*L * 0` → `mkMul(mkPow(L, {2}), {0})` → `0`. And `mkAdd(0, 0)` → `0`. Good — the parameter term disappears.
- `d/dt(x^2)` → `mkMul(mkMul(2, mkPow(x, 1)), der(x))` → `mkMul(mkMul(2, x), der(x))` → `2 * x * der(x)`. Clean.

### 2.5 Differentiating entire equations

An equation `lhs = rhs` is differentiated by differentiating both sides:

```typescript
function differentiateEquation(
  eq: FlatEquation,
  parameters: Map<string, FlatVariable>
): FlatEquation {
  return {
    lhs: differentiate(eq.lhs, parameters),
    rhs: differentiate(eq.rhs, parameters),
    origin: `${eq.origin} [differentiated]`,
  };
}
```

---

## Part 3: Index Reduction — The Pantelides Algorithm

### 3.1 The problem

Phase 3 may report unmatched equations — equations that cannot be assigned to any matchable variable because they contain only state variables (which the integrator provides). These are high-index constraints. The Pantelides algorithm resolves them by differentiating constraints and restructuring the variable classification.

### 3.2 Overview of the algorithm

The algorithm iterates:

1. Attempt a bipartite matching (reusing Hopcroft-Karp from Phase 3)
2. If all equations are matched, stop — the system is now index-1 or index-0
3. For each unmatched equation, differentiate it symbolically
4. Add the differentiated equation to the system
5. Promote new derivative variables to the matchable set; demote a state to algebraic
6. Rebuild the incidence matrix and go to step 1

### 3.3 Data structures for the evolving system

During Pantelides, the system changes — equations are added, variables are reclassified. We need a mutable representation:

```typescript
interface EvolvingSystem {
  equations: FlatEquation[];
  unknowns: ClassifiedVariable[];
  parameters: Map<string, FlatVariable>;

  // Track which equations are differentiated versions of which
  differentiatedFrom: Map<number, number>;   // new eq index → original eq index

  // Track state demotions for the dummy derivative method
  demotedStates: Set<string>;
  dummyCandidates: Map<number, string[]>;
    // For each Pantelides iteration (index reduction step),
    // which states were candidates for demotion
}
```

### 3.4 The Pantelides loop

```typescript
function pantelides(
  flat: FlatSystem,
  phase3Result: BLTDecomposition
): EvolvingSystem {
  // Start with the system from Phase 3
  const system: EvolvingSystem = {
    equations: [...phase3Result.system.equations],
    unknowns: [...phase3Result.system.unknowns],
    parameters: phase3Result.system.parameters,
    differentiatedFrom: new Map(),
    demotedStates: new Set(),
    dummyCandidates: new Map(),
  };

  let iteration = 0;
  const MAX_ITERATIONS = 100; // safety limit

  while (iteration < MAX_ITERATIONS) {
    // Rebuild variable index and incidence
    const varIndex = new VariableIndex(system.unknowns);
    const incidence = buildIncidenceMatrix(
      { unknowns: system.unknowns, equations: system.equations, parameters: system.parameters },
      varIndex
    );
    const matchableVars = getMatchableVariables(system.unknowns, varIndex);

    // Attempt matching
    const matching = hopcroftKarp(incidence, matchableVars);

    // Find unmatched equations
    const unmatched: number[] = [];
    for (let eq = 0; eq < matching.equationMatch.length; eq++) {
      if (matching.equationMatch[eq] === -1) {
        unmatched.push(eq);
      }
    }

    if (unmatched.length === 0) {
      // Success — complete matching found
      break;
    }

    // For each unmatched equation, differentiate and augment the system
    for (const eqIdx of unmatched) {
      augmentSystem(system, eqIdx, varIndex, incidence, matchableVars, iteration);
    }

    iteration++;
  }

  if (iteration >= MAX_ITERATIONS) {
    throw new Error("Pantelides algorithm did not converge — possible structural error");
  }

  return system;
}
```

### 3.5 Augmenting the system for one unmatched equation

This is the core of each Pantelides iteration. When equation `eqIdx` cannot be matched:

1. Differentiate it to produce a new equation
2. The new equation contains `der()` of variables from the original equation. Some of these `der()` terms may already exist as unknowns; others are new.
3. For any state variable in the original equation whose derivative is now a new unknown, we have added an unknown without adding a corresponding equation. To balance the system, we must demote a state — converting it from "known (from integrator)" to "algebraic unknown."

```typescript
function augmentSystem(
  system: EvolvingSystem,
  eqIdx: number,
  varIndex: VariableIndex,
  incidence: IncidenceMatrix,
  matchableVars: Set<number>,
  iteration: number
): void {
  const eq = system.equations[eqIdx];

  // Step 1: Differentiate the equation
  const diffEq = differentiateEquation(eq, system.parameters);

  // Step 2: Resolve higher-order derivatives
  // If the equation already contained der(x), the differentiated equation
  // will contain der(der(x)). We need to map this to an existing variable
  // or create a new one.
  const resolvedEq = resolveHigherDerivatives(diffEq, system);

  // Step 3: Add the new equation
  const newEqIdx = system.equations.length;
  system.equations.push(resolvedEq);
  system.differentiatedFrom.set(newEqIdx, eqIdx);

  // Step 4: Find new derivative variables introduced by differentiation
  const newDerVars = findNewDerivativeVariables(resolvedEq, system);

  // Step 5: For each new derivative, add it as a matchable unknown
  // and demote a corresponding state
  const candidates: string[] = [];

  for (const derVarName of newDerVars) {
    // The state variable that this derivative belongs to
    const stateName = getStateNameFromDer(derVarName);
    if (!stateName) continue;

    // Add the derivative as a new unknown
    system.unknowns.push({
      name: derVarName,
      role: "derivative",
      stateOf: stateName,
    });

    // Demote the state: change it from "state" to "algebraic"
    // This means the integrator no longer provides its value;
    // it must be solved from the equations.
    const stateVar = system.unknowns.find(v => v.name === stateName && v.role === "state");
    if (stateVar) {
      candidates.push(stateName);

      // For now, use static demotion — just change the role.
      // The dummy derivative method (section 3.8) makes this dynamic.
      stateVar.role = "algebraic";
      system.demotedStates.add(stateName);
    }
  }

  system.dummyCandidates.set(iteration, candidates);
}
```

### 3.6 Resolving higher-order derivatives

When differentiating an equation that contains `der(x)`, the result contains `der(der(x))`. If the model defines `der(x) = vx` (through an equation like `vx = der(x)` or `der(x) = vx`), then `der(der(x))` should be resolved to `der(vx)`.

```typescript
function resolveHigherDerivatives(
  eq: FlatEquation,
  system: EvolvingSystem
): FlatEquation {
  // Build a map: for each state x, if there's a derivative variable der(x),
  // check if der(x) is itself a state (i.e., appears inside another der()).
  // This would mean der(der(x)) = der(y) for some y.
  const derMap = buildDerivativeMap(system.unknowns);

  return {
    lhs: resolveHigherDerInExpr(eq.lhs, derMap),
    rhs: resolveHigherDerInExpr(eq.rhs, derMap),
    origin: eq.origin,
  };
}

function buildDerivativeMap(unknowns: ClassifiedVariable[]): Map<string, string> {
  // Maps variable names to their derivative variable names
  // e.g., "x" → "der(x)", "vx" → "der(vx)"
  const map = new Map<string, string>();
  for (const v of unknowns) {
    if (v.role === "state" && v.derivativeOf) {
      map.set(v.name, v.derivativeOf);
    }
  }
  return map;
}

function resolveHigherDerInExpr(expr: FlatExpr, derMap: Map<string, string>): FlatExpr {
  if (expr.kind === "call" && expr.name === "der" && expr.args.length === 1) {
    const arg = expr.args[0];

    // der(der(x)) — the argument is itself a der() call
    if (arg.kind === "call" && arg.name === "der" && arg.args.length === 1) {
      const innerArg = arg.args[0];
      if (innerArg.kind === "variable") {
        // der(der(x)): look up what der(x) maps to
        const derName = `der(${innerArg.name})`;
        // If der(x) is also a state with its own derivative, use that
        // e.g., if der(x) = vx and vx is a state, then der(der(x)) = der(vx)
        if (derMap.has(derName)) {
          // This shouldn't happen directly — der(x) is a derivative, not a state.
          // But the inner variable x might have der(x) aliased to another variable.
        }
        // More commonly: if the model has der(x) = vx (making vx the name of the derivative),
        // and vx is also a state, then der(vx) is the second derivative.
        // We need to check if the derivative variable is itself a state.
        // For the pendulum: der(x) = vx, and vx is a state, so der(der(x)) = der(vx).

        // For now, return as der(der(x)) — the system will create a new variable for it
        return expr;
      }
    }

    // der(variable) — check if the variable itself maps to a derivative
    if (arg.kind === "variable") {
      // Standard case: der(x) where x is a state. No resolution needed.
      return expr;
    }
  }

  // Recurse into sub-expressions
  switch (expr.kind) {
    case "binary":
      return {
        kind: "binary",
        op: expr.op,
        left: resolveHigherDerInExpr(expr.left, derMap),
        right: resolveHigherDerInExpr(expr.right, derMap),
      };
    case "unary":
      return {
        kind: "unary",
        op: expr.op,
        operand: resolveHigherDerInExpr(expr.operand, derMap),
      };
    case "call":
      return {
        kind: "call",
        name: expr.name,
        args: expr.args.map(a => resolveHigherDerInExpr(a, derMap)),
      };
    case "if":
      return {
        kind: "if",
        condition: resolveHigherDerInExpr(expr.condition, derMap),
        thenExpr: resolveHigherDerInExpr(expr.thenExpr, derMap),
        elseIfs: expr.elseIfs.map(ei => ({
          condition: resolveHigherDerInExpr(ei.condition, derMap),
          value: resolveHigherDerInExpr(ei.value, derMap),
        })),
        elseExpr: resolveHigherDerInExpr(expr.elseExpr, derMap),
      };
    default:
      return expr;
  }
}
```

### 3.7 Finding new derivative variables

After differentiation, scan the new equation for `der()` calls that reference variables not yet in the derivative variable list:

```typescript
function findNewDerivativeVariables(
  eq: FlatEquation,
  system: EvolvingSystem
): string[] {
  const existingDerNames = new Set(
    system.unknowns
      .filter(v => v.role === "derivative")
      .map(v => v.name)
  );

  const derCalls = new Set<string>();
  collectAllDerNames(eq.lhs, derCalls);
  collectAllDerNames(eq.rhs, derCalls);

  const newDers: string[] = [];
  for (const name of derCalls) {
    if (!existingDerNames.has(name)) {
      newDers.push(name);
    }
  }

  return newDers;
}

function collectAllDerNames(expr: FlatExpr, result: Set<string>): void {
  if (expr.kind === "call" && expr.name === "der" && expr.args.length === 1) {
    const arg = expr.args[0];
    if (arg.kind === "variable") {
      result.add(`der(${arg.name})`);
    }
  }

  switch (expr.kind) {
    case "binary":
      collectAllDerNames(expr.left, result);
      collectAllDerNames(expr.right, result);
      break;
    case "unary":
      collectAllDerNames(expr.operand, result);
      break;
    case "call":
      for (const a of expr.args) collectAllDerNames(a, result);
      break;
    case "if":
      collectAllDerNames(expr.condition, result);
      collectAllDerNames(expr.thenExpr, result);
      for (const ei of expr.elseIfs) {
        collectAllDerNames(ei.condition, result);
        collectAllDerNames(ei.value, result);
      }
      collectAllDerNames(expr.elseExpr, result);
      break;
  }
}

function getStateNameFromDer(derName: string): string | null {
  // "der(x)" → "x"
  const match = derName.match(/^der\((.+)\)$/);
  return match ? match[1] : null;
}
```

### 3.8 The Dummy Derivative Method

The Pantelides algorithm requires demoting states during index reduction. Which state to demote is a choice — and for some systems (like the pendulum), the best choice changes during simulation. The dummy derivative method defers this choice to runtime.

#### Compile-time preparation

During Pantelides, instead of permanently demoting one state, record all candidates:

```typescript
interface DummyDerivativeGroup {
  // The constraint equation that caused this index reduction step
  constraintEquation: number;

  // The differentiated equation added by Pantelides
  differentiatedEquation: number;

  // Candidate states that could be demoted at this step
  candidates: string[];

  // The statically chosen candidate (for initial implementation)
  staticChoice: string;
}
```

For the pendulum's first Pantelides iteration, E5 (`x^2 + y^2 = L^2`) is the constraint, E5' is the differentiated equation, and the candidates are `x` and `y`. The static choice picks whichever candidate has the largest absolute partial derivative in the constraint equation — for E5, `∂(x^2 + y^2)/∂x = 2x` and `∂(x^2 + y^2)/∂y = 2y`. If `|x| > |y|`, demote `x`; otherwise demote `y`. As a simple heuristic, just pick the first candidate.

#### Static implementation

For a first implementation, the static choice is sufficient. Many practical Modelica models do not require dynamic switching — the static choice works as long as the system does not pass through configurations where the chosen state's constraint derivative becomes zero.

```typescript
function selectStaticDummyDerivative(
  candidates: string[],
  constraintEq: FlatEquation,
  parameters: Map<string, FlatVariable>
): string {
  // Simple heuristic: pick the first candidate
  // A better heuristic: pick the candidate with the largest coefficient
  // in the constraint equation (by inspecting the expression structure)
  return candidates[0];
}
```

#### Dynamic implementation (deferred)

The full dummy derivative method requires generated code that, at each time step:

1. Evaluates the partial derivatives of the constraint with respect to each candidate state
2. Selects the candidate with the largest absolute partial derivative as the dummy
3. If the selection changes from the previous step, swaps the state/algebraic roles and reinitializes the integrator

This is a Phase 5 concern (code generation) rather than a Phase 4 concern. Phase 4's job is to record the candidate groups so that Phase 5 can generate the pivoting code. The `DummyDerivativeGroup` structure above carries this information forward.

---

## Part 4: Symbolic Simplification

### 4.1 When simplification runs

The expression constructors in Part 2 (`mkAdd`, `mkMul`, etc.) apply **local** simplification rules as expressions are built during differentiation. This handles the most common cases: eliminating additions of zero, multiplications by zero or one, and double negation.

After differentiation and index reduction are complete, a second **global** simplification pass can be run over the entire system to catch patterns that local rules miss — constant folding across sub-expressions, cancellation of identical terms, and normalization.

### 4.2 The simplification pass

```typescript
function simplifyExpression(expr: FlatExpr): FlatExpr {
  // Bottom-up: simplify children first, then this node
  switch (expr.kind) {
    case "binary": {
      const left = simplifyExpression(expr.left);
      const right = simplifyExpression(expr.right);

      // Constant folding
      if (isNumeric(left) && isNumeric(right)) {
        const result = evalBinaryNumeric(expr.op, numericValue(left), numericValue(right));
        if (result !== null) return { kind: "real", value: result };
      }

      // Algebraic identities (on top of what mkAdd/mkMul already catch)
      switch (expr.op) {
        case "+":
          if (isZeroExpr(left)) return right;
          if (isZeroExpr(right)) return left;
          // a + (-b) → a - b
          if (right.kind === "unary" && right.op === "-") {
            return simplifyExpression({ kind: "binary", op: "-", left, right: right.operand });
          }
          break;

        case "-":
          if (isZeroExpr(right)) return left;
          if (isZeroExpr(left)) return simplifyExpression(mkNeg(right));
          // a - a → 0
          if (flatExprStructuralEqual(left, right)) {
            return { kind: "real", value: 0 };
          }
          break;

        case "*":
          if (isZeroExpr(left) || isZeroExpr(right)) return { kind: "real", value: 0 };
          if (isOneExpr(left)) return right;
          if (isOneExpr(right)) return left;
          // (-1) * a → -a
          if (isNegOneExpr(left)) return simplifyExpression(mkNeg(right));
          if (isNegOneExpr(right)) return simplifyExpression(mkNeg(left));
          break;

        case "/":
          if (isZeroExpr(left)) return { kind: "real", value: 0 };
          if (isOneExpr(right)) return left;
          // a / a → 1 (assuming a ≠ 0)
          if (flatExprStructuralEqual(left, right)) {
            return { kind: "real", value: 1 };
          }
          break;

        case "^":
          if (isZeroExpr(right)) return { kind: "real", value: 1 };
          if (isOneExpr(right)) return left;
          break;
      }

      return { kind: "binary", op: expr.op, left, right };
    }

    case "unary": {
      const operand = simplifyExpression(expr.operand);
      if (expr.op === "-") {
        if (isZeroExpr(operand)) return operand;
        if (operand.kind === "unary" && operand.op === "-") return operand.operand;
        if (isNumeric(operand)) return { kind: "real", value: -numericValue(operand) };
      }
      return { kind: "unary", op: expr.op, operand };
    }

    case "call": {
      const args = expr.args.map(simplifyExpression);
      // Constant folding for built-in functions
      if (args.every(isNumeric)) {
        const result = evalBuiltinNumeric(expr.name, args.map(numericValue));
        if (result !== null) return { kind: "real", value: result };
      }
      return { kind: "call", name: expr.name, args };
    }

    case "if": {
      const condition = simplifyExpression(expr.condition);
      // If condition is a constant boolean, eliminate the if
      if (condition.kind === "boolean") {
        if (condition.value === true) {
          return simplifyExpression(expr.thenExpr);
        }
        if (expr.elseIfs.length > 0) {
          return simplifyExpression({
            kind: "if",
            condition: expr.elseIfs[0].condition,
            thenExpr: expr.elseIfs[0].value,
            elseIfs: expr.elseIfs.slice(1),
            elseExpr: expr.elseExpr,
          });
        }
        return simplifyExpression(expr.elseExpr);
      }
      return {
        kind: "if",
        condition,
        thenExpr: simplifyExpression(expr.thenExpr),
        elseIfs: expr.elseIfs.map(ei => ({
          condition: simplifyExpression(ei.condition),
          value: simplifyExpression(ei.value),
        })),
        elseExpr: simplifyExpression(expr.elseExpr),
      };
    }

    default:
      return expr;
  }
}
```

#### Helper functions

```typescript
function isNumeric(e: FlatExpr): boolean {
  return e.kind === "real" || e.kind === "integer";
}

function numericValue(e: FlatExpr): number {
  if (e.kind === "real" || e.kind === "integer") return e.value;
  throw new Error("Not numeric");
}

function isNegOneExpr(e: FlatExpr): boolean {
  return (e.kind === "real" && e.value === -1) || (e.kind === "integer" && e.value === -1);
}

function evalBinaryNumeric(op: string, a: number, b: number): number | null {
  switch (op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/": return b !== 0 ? a / b : null;
    case "^": return Math.pow(a, b);
    default: return null;
  }
}

function evalBuiltinNumeric(name: string, args: number[]): number | null {
  if (args.length === 1) {
    switch (name) {
      case "sin": return Math.sin(args[0]);
      case "cos": return Math.cos(args[0]);
      case "tan": return Math.tan(args[0]);
      case "exp": return Math.exp(args[0]);
      case "log": return args[0] > 0 ? Math.log(args[0]) : null;
      case "sqrt": return args[0] >= 0 ? Math.sqrt(args[0]) : null;
      case "abs": return Math.abs(args[0]);
      case "sign": return Math.sign(args[0]);
      default: return null;
    }
  }
  return null;
}

function flatExprStructuralEqual(a: FlatExpr, b: FlatExpr): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "variable":
      return a.name === (b as any).name;
    case "real":
    case "integer":
      return a.value === (b as any).value;
    case "boolean":
      return a.value === (b as any).value;
    case "time":
      return true;
    case "binary":
      return a.op === (b as any).op
        && flatExprStructuralEqual(a.left, (b as any).left)
        && flatExprStructuralEqual(a.right, (b as any).right);
    case "unary":
      return a.op === (b as any).op
        && flatExprStructuralEqual(a.operand, (b as any).operand);
    case "call":
      return a.name === (b as any).name
        && a.args.length === (b as any).args.length
        && a.args.every((arg, i) => flatExprStructuralEqual(arg, (b as any).args[i]));
    default:
      return false;
  }
}
```

### 4.3 Simplifying the full system

```typescript
function simplifySystem(system: EvolvingSystem): void {
  for (let i = 0; i < system.equations.length; i++) {
    system.equations[i] = {
      ...system.equations[i],
      lhs: simplifyExpression(system.equations[i].lhs),
      rhs: simplifyExpression(system.equations[i].rhs),
    };
  }
}
```

---

## Part 5: Tearing

### 5.1 The problem

After Pantelides and the final BLT decomposition, algebraic loops remain — blocks of mutually dependent equations that must be solved simultaneously. Without tearing, a block of `n` equations requires an `n`-dimensional Newton solve at each time step. Tearing reduces this to a `k`-dimensional solve where `k << n`.

### 5.2 Tearing within a block

Given a block of equations `{E1, ..., En}` matched to variables `{V1, ..., Vn}`, tearing selects a subset of variables as **tearing variables** (iteration variables) and a corresponding subset of equations as **residual equations**. The remaining equations become **inner equations** that can be solved sequentially once the tearing variables are assumed.

```typescript
interface TornBlock {
  // Tearing variables: the Newton solver iterates on these
  tearingVars: number[];     // variable indices
  residualEqs: number[];     // equation indices (one per tearing var)

  // Inner equations: solved sequentially given the tearing variables
  innerEqs: number[];        // equation indices, in evaluation order
  innerVars: number[];       // variable indices, one per inner equation (same order)
}
```

### 5.3 Tearing algorithm

The algorithm proceeds by trying to find variables in the block that, if assumed known, would break the most dependency cycles. A greedy heuristic works well in practice:

```typescript
function tearBlock(
  block: BLTBlock,
  incidence: IncidenceMatrix,
  matching: Matching
): TornBlock {
  if (block.kind === "scalar") {
    // Scalar blocks don't need tearing
    return {
      tearingVars: [],
      residualEqs: [],
      innerEqs: block.equations,
      innerVars: block.variables,
    };
  }

  const blockEqs = new Set(block.equations);
  const blockVars = new Set(block.variables);

  // Build the sub-graph for this block only
  const subAdj = new Map<number, Set<number>>(); // eq → set of eqs it depends on (within block)
  for (const eq of block.equations) {
    const deps = new Set<number>();
    for (const v of incidence.equationToVars[eq]) {
      if (!blockVars.has(v)) continue;
      const solvingEq = matching.variableMatch[v];
      if (solvingEq !== -1 && solvingEq !== eq && blockEqs.has(solvingEq)) {
        deps.add(solvingEq);
      }
    }
    subAdj.set(eq, deps);
  }

  // Greedy tearing: repeatedly find the variable that appears in the most
  // equations within the block and select it as a tearing variable.
  // Then remove the cycle it participates in and repeat.
  const tearingVars: number[] = [];
  const residualEqs: number[] = [];
  const removedEqs = new Set<number>();
  const removedVars = new Set<number>();

  while (hasCycle(block.equations, removedEqs, subAdj)) {
    // Find the variable with highest "connectivity" in remaining block
    let bestVar = -1;
    let bestCount = -1;

    for (const v of block.variables) {
      if (removedVars.has(v)) continue;
      let count = 0;
      for (const eq of incidence.varToEquations[v]) {
        if (blockEqs.has(eq) && !removedEqs.has(eq)) count++;
      }
      if (count > bestCount) {
        bestCount = count;
        bestVar = v;
      }
    }

    if (bestVar === -1) break;

    // The tearing variable is bestVar; its residual equation is the one
    // it was matched to
    const residualEq = matching.variableMatch[bestVar];
    tearingVars.push(bestVar);
    residualEqs.push(residualEq);
    removedVars.add(bestVar);
    removedEqs.add(residualEq);

    // Remove this equation from the sub-adjacency graph
    subAdj.delete(residualEq);
    for (const [, deps] of subAdj) {
      deps.delete(residualEq);
    }
  }

  // The remaining equations (not residual) are inner equations.
  // They must be topologically sorted.
  const innerEqs: number[] = [];
  const innerVars: number[] = [];
  const remainingEqs = block.equations.filter(eq => !removedEqs.has(eq));

  // Topological sort of remaining equations
  const sorted = topologicalSort(remainingEqs, subAdj);
  for (const eq of sorted) {
    innerEqs.push(eq);
    innerVars.push(matching.equationMatch[eq]);
  }

  return { tearingVars, residualEqs, innerEqs, innerVars };
}
```

#### Cycle detection

```typescript
function hasCycle(
  equations: number[],
  removed: Set<number>,
  adjacency: Map<number, Set<number>>
): boolean {
  const active = equations.filter(eq => !removed.has(eq));
  const visited = new Set<number>();
  const inStack = new Set<number>();

  function dfs(node: number): boolean {
    visited.add(node);
    inStack.add(node);

    const deps = adjacency.get(node);
    if (deps) {
      for (const dep of deps) {
        if (removed.has(dep)) continue;
        if (inStack.has(dep)) return true;
        if (!visited.has(dep) && dfs(dep)) return true;
      }
    }

    inStack.delete(node);
    return false;
  }

  for (const eq of active) {
    if (!visited.has(eq) && dfs(eq)) return true;
  }
  return false;
}
```

#### Topological sort

```typescript
function topologicalSort(
  equations: number[],
  adjacency: Map<number, Set<number>>
): number[] {
  const eqSet = new Set(equations);
  const visited = new Set<number>();
  const result: number[] = [];

  function visit(eq: number): void {
    if (visited.has(eq)) return;
    visited.add(eq);

    const deps = adjacency.get(eq);
    if (deps) {
      for (const dep of deps) {
        if (eqSet.has(dep)) visit(dep);
      }
    }

    result.push(eq);
  }

  for (const eq of equations) {
    visit(eq);
  }

  return result;
}
```

### 5.4 Tearing all blocks

```typescript
function tearAllBlocks(
  blocks: BLTBlock[],
  incidence: IncidenceMatrix,
  matching: Matching
): TornBlock[] {
  return blocks.map(block => tearBlock(block, incidence, matching));
}
```

---

## Part 6: Putting It Together

### 6.1 The full Phase 4 pipeline

```typescript
interface SymbolicResult {
  // The transformed system
  equations: FlatEquation[];
  unknowns: ClassifiedVariable[];
  parameters: Map<string, FlatVariable>;

  // Structural analysis of the transformed system
  blocks: TornBlock[];
  matching: Matching;
  incidence: IncidenceMatrix;
  variableIndex: VariableIndex;

  // Index reduction metadata
  dummyDerivativeGroups: DummyDerivativeGroup[];
  differentiatedEquations: Map<number, number>;

  // Alias information (for reconstructing eliminated variables in output)
  aliasMap: AliasMap;
}

function symbolicPreprocess(flat: FlatSystem): SymbolicResult {
  // Step 1: Alias elimination
  const aliasMap = new AliasMap();
  const reduced = eliminateAliases(flat);  // also populates aliasMap

  // Step 2: Initial structural analysis (Phase 3)
  const initial = processEquations(reduced);

  // Step 3: Index reduction (if needed)
  let system: EvolvingSystem;
  if (initial.isHighIndex) {
    system = pantelides(reduced, initial);
    simplifySystem(system);
  } else {
    system = {
      equations: initial.system.equations,
      unknowns: initial.system.unknowns,
      parameters: initial.system.parameters,
      differentiatedFrom: new Map(),
      demotedStates: new Set(),
      dummyCandidates: new Map(),
    };
  }

  // Step 4: Re-run structural analysis on the (possibly augmented) system
  const finalFlat: FlatSystem = {
    variables: system.unknowns.map(u => ({
      name: u.name,
      typeName: "Real",
      variability: u.role === "algebraic" ? "continuous" as const : "continuous" as const,
      isFlow: false,
      isStream: false,
      causality: null,
      bindingExpression: null,
      attributes: { start: null, fixed: null, nominal: null, min: null, max: null,
                    unit: null, displayUnit: null, stateSelect: null },
    })),
    equations: system.equations,
  };

  const final = processEquations(finalFlat);

  if (final.unmatchedEquations.length > 0) {
    throw new Error(
      `System is structurally singular after index reduction. ` +
      `${final.unmatchedEquations.length} equations could not be matched.`
    );
  }

  // Step 5: Tearing
  const tornBlocks = tearAllBlocks(final.blocks, final.incidence, final.matching);

  // Step 6: Build dummy derivative groups
  const dummyGroups: DummyDerivativeGroup[] = [];
  for (const [iteration, candidates] of system.dummyCandidates) {
    // Find the constraint and differentiated equations for this iteration
    // (simplified: just record the candidates)
    dummyGroups.push({
      constraintEquation: -1,  // would be populated from differentiatedFrom
      differentiatedEquation: -1,
      candidates,
      staticChoice: candidates[0],
    });
  }

  return {
    equations: system.equations,
    unknowns: system.unknowns,
    parameters: system.parameters,
    blocks: tornBlocks,
    matching: final.matching,
    incidence: final.incidence,
    variableIndex: final.variableIndex,
    dummyDerivativeGroups: dummyGroups,
    differentiatedEquations: system.differentiatedFrom,
    aliasMap,
  };
}
```

---

## Worked Example: Pendulum Index Reduction

**Starting system (5 equations, 5 matchable unknowns):**

```
E0: der(x) = vx         → involves der(x), vx (states: x, vx)
E1: der(y) = vy         → involves der(y), vy (states: y, vy)
E2: m * der(vx) = -lambda * x   → involves der(vx), lambda, x
E3: m * der(vy) = -lambda * y - m*g  → involves der(vy), lambda, y
E4: x^2 + y^2 = L^2    → involves x, y (states only — no matchable vars)
```

Matchable unknowns: `der(x)`, `der(y)`, `der(vx)`, `der(vy)`, `lambda`

**Initial matching attempt:**
- E0 → `der(x)` ✓
- E1 → `der(y)` ✓
- E2 → `der(vx)` ✓
- E3 → `der(vy)` ✓
- E4 → nothing ✗

**Pantelides iteration 1:**

Differentiate E4: `x^2 + y^2 = L^2`

```
d/dt(x^2 + y^2) = d/dt(L^2)
2*x*der(x) + 2*y*der(y) = 0
```

Simplification: `2*x*der(x) + 2*y*der(y) = 0`

This is E5. It involves `der(x)`, `der(y)`, `x`, `y`. The new `der()` calls (`der(x)` and `der(y)`) already exist as unknowns.

But we added an equation without adding a variable — system is 6 equations, 5 matchable unknowns. Demote state `x` to algebraic. Now `x` is matchable. System: 6 equations, 6 matchable unknowns.

**Matching attempt 2:**
- E0: `der(x) = vx` → involves `der(x)`, `vx` (both states... wait, `x` was demoted, but `vx` is still a state). Actually: `der(x)` is a derivative, `vx` is a state (still). `x` was demoted to algebraic.
- E4 was the original constraint; now it can match to `x` (algebraic).

Let's re-examine. Matchable unknowns: `der(x)`, `der(y)`, `der(vx)`, `der(vy)`, `lambda`, `x`.

- E0 → `der(x)` ✓
- E1 → `der(y)` ✓
- E2 → `der(vx)` or `lambda` or `x`
- E3 → `der(vy)` or `lambda`
- E4 → `x` ✓ (now `x` is matchable)
- E5 → `der(x)` or `der(y)` — but E0 and E1 already took them

Competition for `der(x)` and `der(y)`: E0, E1, and E5 all need them. Let Hopcroft-Karp resolve:

- E5 involves `der(x)` and `der(y)`. If E5 takes `der(x)`, then E0 must find another variable — but E0 only has `der(x)` as matchable. Deadlock.
- Actually E0 involves `der(x)` and `vx`. `vx` is a state, not matchable. So E0 can only match to `der(x)`.
- E5 must match to `der(y)`. Then E1 has no matchable variable (it only involves `der(y)` and `vy`).

E1 is unmatched. Pantelides continues.

**Pantelides iteration 2:**

Differentiate E5: `2*x*der(x) + 2*y*der(y) = 0`

```
d/dt(2*x*der(x) + 2*y*der(y)) = 0
2*der(x)*der(x) + 2*x*der(der(x)) + 2*der(y)*der(y) + 2*y*der(der(y)) = 0
```

Simplify: `2*der(x)^2 + 2*x*der(der(x)) + 2*der(y)^2 + 2*y*der(der(y)) = 0`

Now `der(der(x)) = der(vx)` (since `der(x) = vx` from E0) and `der(der(y)) = der(vy)`. These already exist. So this equation (E6) involves `der(x)`, `x`, `der(vx)`, `der(y)`, `y`, `der(vy)`.

Added equation E6 without new variables. Demote state `y` to algebraic. Now `y` is matchable.

Matchable unknowns: `der(x)`, `der(y)`, `der(vx)`, `der(vy)`, `lambda`, `x`, `y`.
7 unknowns, 7 equations (E0–E6).

**Matching attempt 3:**

- E0 → `der(x)` ✓
- E1 → `der(y)` ✓
- E2 → `der(vx)` ✓
- E3 → `der(vy)` ✓
- E4 → `x` ✓
- E5 → `y` ✓ (E5 involves `x`, `y`, `der(x)`, `der(y)` — `y` is available)
- E6 → `lambda` ✓ (E6 involves `der(x)`, `x`, `der(vx)`, `der(y)`, `y`, `der(vy)` — after substituting E2/E3, lambda appears)

Wait — E6 as written doesn't involve `lambda`. Let me re-examine. E6 is the second derivative of the constraint. After full expansion, it becomes `2*vx^2 + 2*x*der(vx) + 2*vy^2 + 2*y*der(vy) = 0`. Substituting `der(vx) = -lambda*x/m` from E2 and `der(vy) = (-lambda*y - m*g)/m` from E3 would introduce `lambda`, but this substitution happens at the matching level, not symbolically.

Structurally: E6 involves `der(vx)` and `der(vy)`. `lambda` appears in E2 and E3. The matching can route `lambda` through E2 or E3. Specifically:

- E6 → `der(vx)` — but E2 also needs `der(vx)`. Hopcroft-Karp resolves this by finding augmenting paths.

The final matching (one valid assignment):
- E0 → `der(x)`
- E1 → `der(y)`
- E4 → `x`
- E5 → `y`
- E6 → `der(vx)` (or `der(vy)`)
- E2 → `lambda` (since E2 involves `lambda` and `der(vx)`, and if E6 took `der(vx)`, E2 matches `lambda`)
- E3 → `der(vy)`

Complete matching. Pantelides terminates after 2 iterations.

Dummy derivative candidates: iteration 0 → {x, y}, iteration 1 → {y} (only y was a remaining state candidate). In the full dummy derivative method, both x and y would be candidates for dynamic pivoting at the first reduction step.

---

## Testing

**Alias elimination tests:** Test direct, negated, and constant aliases. Test transitive chains (`a = b`, `b = c` → `a` and `b` map to `c`). Test mixed chains (`a = b`, `b = -c` → `a` maps to `-c`). Verify that substitution in equations is correct.

**Symbolic differentiation tests:** Differentiate known expressions and compare results:
- `d/dt(x^2)` → `2*x*der(x)`
- `d/dt(x*y)` → `x*der(y) + y*der(x)`
- `d/dt(sin(x))` → `cos(x)*der(x)`
- `d/dt(parameter)` → `0`
- `d/dt(time)` → `1`
- `d/dt(if c then a else b)` → `if c then der(a) else der(b)`

**Simplification tests:** Verify that the simplifier produces clean expressions:
- `0 + x` → `x`
- `0 * x` → `0`
- `x - x` → `0`
- `2 * 3` → `6`
- `-(-x)` → `x`

**Pantelides tests:** Run the pendulum system through and verify: 2 iterations, E5 and E5' are differentiated, `x` and `y` are demoted, final matching is complete with 7 equations and 7 matchable unknowns.

**Tearing tests:** Construct the 4-equation algebraic loop from the overview (`a = f(b,c)`, `b = g(a,d)`, `c = h(a,b)`, `d = p(b,c)`). Verify that tearing selects 2 tearing variables and produces 2 inner equations that can be evaluated sequentially.

**Integration test:** Run the full pipeline (alias elimination → Phase 3 → Pantelides → simplification → final BLT → tearing) on the SimpleCircuit model. The circuit should require no index reduction (it is index-1), so Pantelides should not iterate. Verify the BLT structure and tearing of any algebraic loops.
