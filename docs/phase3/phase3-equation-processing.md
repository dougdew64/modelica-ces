# Phase 3: Equation Processing — Implementation Details

This document describes how to implement the equation processing phase of the Modelica compiler in TypeScript. Equation processing takes the flat system from Phase 2 (a bag of variables and equations) and produces a structural analysis: variable classification, incidence matrix, equation-variable matching, BLT decomposition, and an index assessment.

This phase does no symbolic transformation — it does not simplify expressions, differentiate equations, or reduce the DAE index. It analyzes the structure of the system and reports what it finds. Phase 4 (Symbolic Preprocessing) acts on this analysis.

The implementation has four parts built in sequence:

1. **Variable classification** — categorize each variable by its role
2. **Incidence analysis** — build the equation-variable bipartite graph
3. **Bipartite matching** — assign each equation to the variable it solves for
4. **BLT decomposition** — order the equations and identify algebraic loops

---

## Part 1: Variable Classification

### 1.1 The unknown set

The flat system from Phase 2 contains both known values (parameters, constants) and unknowns. Equation processing works only with the unknowns.

```typescript
type VariableRole =
  | "state"       // appears inside der(); integrated by the solver
  | "derivative"  // is der(x) for some state x; solved at each time step
  | "algebraic";  // appears in equations but never inside der()

interface ClassifiedVariable {
  name: string;
  role: VariableRole;
  stateOf?: string;     // if role is "derivative", the state variable name
  derivativeOf?: string; // if role is "state", the derivative variable name
}

interface EquationSystem {
  unknowns: ClassifiedVariable[];
  equations: IndexedEquation[];
  parameters: Map<string, FlatVariable>;  // kept for expression evaluation
}

interface IndexedEquation {
  index: number;
  lhs: FlatExpr;
  rhs: FlatExpr;
  origin: string;
}
```

### 1.2 Scanning for `der()` calls

The first step is to walk every equation's expression tree and find all `der()` calls. Each `der(x)` call tells us two things: `x` is a state variable, and `der(x)` is a derivative variable.

```typescript
function classifyVariables(flat: FlatSystem): EquationSystem {
  const parameters = new Map<string, FlatVariable>();
  const stateNames = new Set<string>();
  const allUnknownNames = new Set<string>();

  // Separate parameters/constants from unknowns
  for (const v of flat.variables) {
    if (v.variability === "parameter" || v.variability === "constant") {
      parameters.set(v.name, v);
    } else {
      allUnknownNames.add(v.name);
    }
  }

  // Scan all equations for der() calls to identify states
  const equations: IndexedEquation[] = flat.equations.map((eq, i) => ({
    index: i,
    lhs: eq.lhs,
    rhs: eq.rhs,
    origin: eq.origin,
  }));

  for (const eq of equations) {
    collectDerCalls(eq.lhs, stateNames);
    collectDerCalls(eq.rhs, stateNames);
  }

  // Build classified variable list
  const unknowns: ClassifiedVariable[] = [];

  for (const name of allUnknownNames) {
    if (stateNames.has(name)) {
      const derName = `der(${name})`;
      unknowns.push({
        name,
        role: "state",
        derivativeOf: derName,
      });
      unknowns.push({
        name: derName,
        role: "derivative",
        stateOf: name,
      });
    } else {
      unknowns.push({
        name,
        role: "algebraic",
      });
    }
  }

  return { unknowns, equations, parameters };
}
```

The `collectDerCalls` function walks an expression tree and adds the argument of every `der()` call to the state set:

```typescript
function collectDerCalls(expr: FlatExpr, stateNames: Set<string>): void {
  switch (expr.kind) {
    case "call":
      if (expr.name === "der" && expr.args.length === 1) {
        const arg = expr.args[0];
        if (arg.kind === "variable") {
          stateNames.add(arg.name);
        }
      }
      for (const arg of expr.args) {
        collectDerCalls(arg, stateNames);
      }
      break;

    case "binary":
      collectDerCalls(expr.left, stateNames);
      collectDerCalls(expr.right, stateNames);
      break;

    case "unary":
      collectDerCalls(expr.operand, stateNames);
      break;

    case "if":
      collectDerCalls(expr.condition, stateNames);
      collectDerCalls(expr.thenExpr, stateNames);
      for (const ei of expr.elseIfs) {
        collectDerCalls(ei.condition, stateNames);
        collectDerCalls(ei.value, stateNames);
      }
      collectDerCalls(expr.elseExpr, stateNames);
      break;

    // Literals, variable references, time — no der() calls
    default:
      break;
  }
}
```

### 1.3 Derivative variables as unknowns

A key point: `der(x)` is itself an unknown that must be solved for, not just a mathematical operation. When we encounter `v = der(x)`, the unknowns in this equation are `v` and `der(x)` — both must be in the unknown list and in the incidence matrix.

The derivative variable `der(x)` does not correspond to a `FlatVariable` from Phase 2 — it is synthesized during classification. Phase 2 produced the state variable `x`; Phase 3 creates the derivative variable `der(x)` as a companion.

### 1.4 Variable indexing

Many algorithms in this phase work with integer indices rather than variable names. Build a bidirectional mapping:

```typescript
class VariableIndex {
  private nameToIndex: Map<string, number>;
  private indexToVar: ClassifiedVariable[];

  constructor(unknowns: ClassifiedVariable[]) {
    this.nameToIndex = new Map();
    this.indexToVar = unknowns;
    for (let i = 0; i < unknowns.length; i++) {
      this.nameToIndex.set(unknowns[i].name, i);
    }
  }

  indexOf(name: string): number | undefined {
    return this.nameToIndex.get(name);
  }

  variableAt(index: number): ClassifiedVariable {
    return this.indexToVar[index];
  }

  get size(): number {
    return this.indexToVar.length;
  }
}
```

### 1.5 What the solver knows vs. what equations must determine

Before moving to incidence analysis, it is important to clarify what the numerical solver provides at each time step and what the equation system must compute. This determines which variables participate in the matching.

During time integration, the solver maintains the current values of all **state variables**. At each step, it asks: "given the current states, what are the derivatives and algebraic variables?" The equations must answer this question.

This means:
- **State variables** (`x`, `v`) are **known** at each time step (provided by the integrator)
- **Derivative variables** (`der(x)`, `der(v)`) are **unknowns** to solve for
- **Algebraic variables** (`F`, `lambda`) are **unknowns** to solve for

The matching algorithm matches equations to the unknowns — derivatives and algebraic variables — not to states. States participate in the incidence matrix (they appear in equations), but they are not matched.

However, there is an important subtlety for high-index systems. The Pantelides algorithm (Phase 4) may demote some state variables to algebraic unknowns, changing what the solver "knows." Equation processing performs the initial matching under the assumption that all states are known, then detects failures that indicate high-index problems. This detection is described in section 4.

---

## Part 2: Incidence Analysis

### 2.1 The incidence matrix

The incidence matrix records which unknowns appear in which equations. It is the foundation for matching and BLT decomposition.

```typescript
interface IncidenceMatrix {
  // For each equation index, the set of unknown variable indices that appear in it
  equationToVars: Set<number>[];

  // For each variable index, the set of equation indices it appears in
  varToEquations: Set<number>[];

  numEquations: number;
  numVariables: number;
}
```

Both views (equation→variables and variable→equations) are stored for efficiency — matching needs to iterate over a variable's equations, while BLT needs to iterate over an equation's variables. They must be kept in sync.

### 2.2 Building the incidence matrix

Walk each equation's expression tree and collect the unknown variables that appear:

```typescript
function buildIncidenceMatrix(
  system: EquationSystem,
  varIndex: VariableIndex
): IncidenceMatrix {
  const numEq = system.equations.length;
  const numVar = varIndex.size;

  const equationToVars: Set<number>[] = Array.from(
    { length: numEq }, () => new Set()
  );
  const varToEquations: Set<number>[] = Array.from(
    { length: numVar }, () => new Set()
  );

  for (const eq of system.equations) {
    const vars = new Set<number>();
    collectIncidence(eq.lhs, varIndex, system.parameters, vars);
    collectIncidence(eq.rhs, varIndex, system.parameters, vars);

    equationToVars[eq.index] = vars;
    for (const v of vars) {
      varToEquations[v].add(eq.index);
    }
  }

  return { equationToVars, varToEquations, numEquations: numEq, numVariables: numVar };
}
```

The `collectIncidence` function walks the expression tree:

```typescript
function collectIncidence(
  expr: FlatExpr,
  varIndex: VariableIndex,
  parameters: Map<string, FlatVariable>,
  result: Set<number>
): void {
  switch (expr.kind) {
    case "variable": {
      // Skip if it is a parameter or constant
      if (parameters.has(expr.name)) return;

      const idx = varIndex.indexOf(expr.name);
      if (idx !== undefined) {
        result.add(idx);
      }
      // If not found in varIndex, it might be a state variable.
      // States are in varIndex, so this should not happen for well-formed systems.
      break;
    }

    case "call": {
      if (expr.name === "der" && expr.args.length === 1) {
        // der(x) — add the derivative variable, not x
        const arg = expr.args[0];
        if (arg.kind === "variable") {
          const derName = `der(${arg.name})`;
          const idx = varIndex.indexOf(derName);
          if (idx !== undefined) {
            result.add(idx);
          }
          // Also add x itself (the state) — it appears in the equation
          // even though the solver provides it
          const stateIdx = varIndex.indexOf(arg.name);
          if (stateIdx !== undefined) {
            result.add(stateIdx);
          }
        }
      } else {
        // Regular function call — recurse into arguments
        for (const arg of expr.args) {
          collectIncidence(arg, varIndex, parameters, result);
        }
      }
      break;
    }

    case "binary":
      collectIncidence(expr.left, varIndex, parameters, result);
      collectIncidence(expr.right, varIndex, parameters, result);
      break;

    case "unary":
      collectIncidence(expr.operand, varIndex, parameters, result);
      break;

    case "if":
      collectIncidence(expr.condition, varIndex, parameters, result);
      collectIncidence(expr.thenExpr, varIndex, parameters, result);
      for (const ei of expr.elseIfs) {
        collectIncidence(ei.condition, varIndex, parameters, result);
        collectIncidence(ei.value, varIndex, parameters, result);
      }
      collectIncidence(expr.elseExpr, varIndex, parameters, result);
      break;

    case "time":
    case "real":
    case "integer":
    case "boolean":
    case "string":
      // No unknowns
      break;
  }
}
```

#### Design note: states in the incidence matrix

States appear in the incidence matrix even though the solver provides their values. This is because the incidence matrix records structural relationships that are needed for BLT decomposition and (later) for the Pantelides algorithm. During matching, states will not be matched to equations — only derivatives and algebraic variables are. But the incidence of states in equations determines the dependency structure that BLT decomposition needs.

An alternative design is to build two incidence structures: one including states (for BLT and Pantelides) and one excluding states (for matching). For simplicity, we use a single matrix and filter states out during matching.

---

## Part 3: Bipartite Matching

### 3.1 The matching problem

Given `n` equations and `m` unknowns that need to be solved for (derivatives + algebraic variables), find a one-to-one assignment of equations to unknowns such that each equation is assigned to a variable that appears in it. This is a maximum bipartite matching problem.

For the system to be solvable, the matching must be **perfect on the equation side** — every equation is matched. If there are more unknowns than equations, some unknowns remain undetermined (which is fine — the solver handles states). If there are more equations than matchable unknowns, the system is over-determined.

### 3.2 Matchable variables

Not all unknowns participate in matching. State variables are provided by the integrator and are not matched. Only derivatives and algebraic variables need to be solved for:

```typescript
function getMatchableVariables(
  unknowns: ClassifiedVariable[],
  varIndex: VariableIndex
): Set<number> {
  const matchable = new Set<number>();
  for (let i = 0; i < unknowns.length; i++) {
    if (unknowns[i].role === "derivative" || unknowns[i].role === "algebraic") {
      matchable.add(i);
    }
  }
  return matchable;
}
```

### 3.3 Hopcroft-Karp algorithm

The Hopcroft-Karp algorithm finds a maximum matching in a bipartite graph in O(E * sqrt(V)) time. It works by repeatedly finding **augmenting paths** — paths that alternate between unmatched and matched edges and can be used to increase the matching size.

The algorithm has two phases that alternate:
1. **BFS phase**: find the shortest augmenting paths from all unmatched equations simultaneously
2. **DFS phase**: use the BFS layering to find vertex-disjoint augmenting paths and augment along them

```typescript
interface Matching {
  // equationMatch[eqIdx] = varIdx that equation is matched to, or -1
  equationMatch: number[];
  // variableMatch[varIdx] = eqIdx that variable is matched to, or -1
  variableMatch: number[];
}

function hopcroftKarp(
  incidence: IncidenceMatrix,
  matchableVars: Set<number>
): Matching {
  const numEq = incidence.numEquations;
  const numVar = incidence.numVariables;

  const eqMatch = new Int32Array(numEq).fill(-1);
  const varMatch = new Int32Array(numVar).fill(-1);

  // Repeat: BFS to find layered graph, then DFS to find augmenting paths
  while (true) {
    const layers = bfsPhase(incidence, eqMatch, varMatch, matchableVars);
    if (layers === null) break; // no augmenting paths exist

    // Try to find augmenting paths from each unmatched equation
    for (let eq = 0; eq < numEq; eq++) {
      if (eqMatch[eq] === -1) {
        dfsAugment(eq, incidence, eqMatch, varMatch, matchableVars, layers);
      }
    }
  }

  return {
    equationMatch: Array.from(eqMatch),
    variableMatch: Array.from(varMatch),
  };
}
```

#### BFS phase

The BFS starts from all unmatched equations simultaneously and builds a layered graph. It alternates between "equation layers" and "variable layers," following unmatched edges from equations to variables and matched edges from variables back to equations.

```typescript
function bfsPhase(
  incidence: IncidenceMatrix,
  eqMatch: Int32Array,
  varMatch: Int32Array,
  matchableVars: Set<number>
): Map<number, number> | null {
  // layers[eqIdx] = BFS depth of this equation node
  const layers = new Map<number, number>();
  const queue: number[] = [];

  // Seed: all unmatched equations at layer 0
  for (let eq = 0; eq < incidence.numEquations; eq++) {
    if (eqMatch[eq] === -1) {
      layers.set(eq, 0);
      queue.push(eq);
    }
  }

  let foundAugmenting = false;
  let qi = 0;

  while (qi < queue.length) {
    const eq = queue[qi++];
    const eqLayer = layers.get(eq)!;

    // Follow unmatched edges from this equation to matchable variables
    for (const v of incidence.equationToVars[eq]) {
      if (!matchableVars.has(v)) continue;

      // Follow the matched edge back from this variable to its matched equation
      const matchedEq = varMatch[v];

      if (matchedEq === -1) {
        // This variable is unmatched — we found an augmenting path endpoint
        foundAugmenting = true;
      } else if (!layers.has(matchedEq)) {
        // New equation reached — add to next layer
        layers.set(matchedEq, eqLayer + 1);
        queue.push(matchedEq);
      }
    }
  }

  return foundAugmenting ? layers : null;
}
```

#### DFS phase

For each unmatched equation, attempt to find an augmenting path using the layered graph from BFS:

```typescript
function dfsAugment(
  eq: number,
  incidence: IncidenceMatrix,
  eqMatch: Int32Array,
  varMatch: Int32Array,
  matchableVars: Set<number>,
  layers: Map<number, number>
): boolean {
  const eqLayer = layers.get(eq);
  if (eqLayer === undefined) return false;

  for (const v of incidence.equationToVars[eq]) {
    if (!matchableVars.has(v)) continue;

    const matchedEq = varMatch[v];

    if (matchedEq === -1) {
      // Augmenting path found — augment
      eqMatch[eq] = v;
      varMatch[v] = eq;
      return true;
    }

    const matchedLayer = layers.get(matchedEq);
    if (matchedLayer !== undefined && matchedLayer === eqLayer! + 1) {
      // Follow the path deeper
      if (dfsAugment(matchedEq, incidence, eqMatch, varMatch, matchableVars, layers)) {
        // Augmenting path extends through here — augment this edge
        eqMatch[eq] = v;
        varMatch[v] = eq;
        return true;
      }
    }
  }

  // No augmenting path from this equation — remove from layers to prune future searches
  layers.delete(eq);
  return false;
}
```

### 3.4 Interpreting the matching result

After matching, check for completeness:

```typescript
function validateMatching(
  matching: Matching,
  system: EquationSystem,
  varIndex: VariableIndex
): { unmatchedEquations: number[]; isHighIndex: boolean } {
  const unmatched: number[] = [];

  for (let eq = 0; eq < matching.equationMatch.length; eq++) {
    if (matching.equationMatch[eq] === -1) {
      unmatched.push(eq);
    }
  }

  if (unmatched.length === 0) {
    return { unmatchedEquations: [], isHighIndex: false };
  }

  // Check if unmatched equations are constraints (contain only states)
  // — this signals a high-index problem
  let isHighIndex = false;
  for (const eq of unmatched) {
    const vars = system.equations[eq];
    // If this equation's matchable variables are all already matched
    // to other equations, it may be a high-index constraint
    isHighIndex = true;
  }

  return { unmatchedEquations: unmatched, isHighIndex };
}
```

When the matching is incomplete:

- **Some equations have no matchable variables** (all variables in the equation are states or parameters). This is the structural signature of a high-index constraint, like `x^2 + y^2 = L^2` in the pendulum. The equation constrains states but cannot solve for any derivative or algebraic variable. Phase 4 (Pantelides algorithm) will differentiate this equation to introduce derivative variables.

- **The system is structurally singular** — there are fewer matchable variables than equations even after accounting for high-index issues. This is a modeling error (e.g., contradictory equations, or more equations than unknowns).

The distinction between these cases is determined by Phase 4 — equation processing reports the unmatched equations and lets the next phase decide.

---

## Part 4: BLT Decomposition

### 4.1 Building the dependency graph

Given a valid matching, build a directed graph where each node is an equation-variable pair (Ei matched to Uj), and edges represent "Ei depends on the result of Ek."

```typescript
interface DependencyGraph {
  // adjacency[eqIdx] = list of equation indices that eqIdx depends on
  adjacency: number[][];
  numNodes: number;
}

function buildDependencyGraph(
  matching: Matching,
  incidence: IncidenceMatrix,
  matchableVars: Set<number>
): DependencyGraph {
  const numEq = incidence.numEquations;
  const adjacency: number[][] = Array.from({ length: numEq }, () => []);

  for (let eq = 0; eq < numEq; eq++) {
    if (matching.equationMatch[eq] === -1) continue;

    const matchedVar = matching.equationMatch[eq];

    // For each variable in this equation (other than the one it's matched to)
    for (const v of incidence.equationToVars[eq]) {
      if (v === matchedVar) continue;
      if (!matchableVars.has(v)) continue;

      // Which equation solves for this variable?
      const solvingEq = matching.variableMatch[v];
      if (solvingEq !== -1 && solvingEq !== eq) {
        // eq depends on solvingEq
        adjacency[eq].push(solvingEq);
      }
    }
  }

  return { adjacency, numNodes: numEq };
}
```

The edge `eq → solvingEq` means: "equation `eq` uses a variable that is solved by equation `solvingEq`, so `solvingEq` must be evaluated first."

Note that state variables are skipped (`!matchableVars.has(v)`) — states are known from the integrator and do not create dependencies between equations.

### 4.2 Tarjan's algorithm for strongly connected components

Tarjan's algorithm performs a single depth-first traversal and identifies all SCCs. It outputs the SCCs in reverse topological order — the first SCC output has no dependencies on later SCCs.

```typescript
interface SCC {
  equations: number[];    // indices of equations in this SCC
}

function tarjanSCC(graph: DependencyGraph): SCC[] {
  const n = graph.numNodes;
  const index = new Int32Array(n).fill(-1);
  const lowlink = new Int32Array(n).fill(-1);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const sccs: SCC[] = [];
  let nextIndex = 0;

  function strongConnect(v: number): void {
    index[v] = lowlink[v] = nextIndex++;
    stack.push(v);
    onStack[v] = 1;

    for (const w of graph.adjacency[v]) {
      if (index[w] === -1) {
        // w has not been visited — recurse
        strongConnect(w);
        lowlink[v] = Math.min(lowlink[v], lowlink[w]);
      } else if (onStack[w]) {
        // w is on the stack — it's part of the current SCC
        lowlink[v] = Math.min(lowlink[v], index[w]);
      }
    }

    // If v is a root node, pop the SCC
    if (lowlink[v] === index[v]) {
      const scc: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack[w] = 0;
        scc.push(w);
      } while (w !== v);
      sccs.push({ equations: scc });
    }
  }

  for (let v = 0; v < n; v++) {
    if (index[v] === -1) {
      strongConnect(v);
    }
  }

  // Tarjan's produces SCCs in reverse topological order.
  // Reverse to get evaluation order.
  sccs.reverse();

  return sccs;
}
```

#### Recursion depth

For large systems (10,000+ equations), the recursive Tarjan's implementation may exceed the JavaScript call stack. An iterative version using an explicit stack avoids this:

```typescript
function tarjanSCCIterative(graph: DependencyGraph): SCC[] {
  const n = graph.numNodes;
  const index = new Int32Array(n).fill(-1);
  const lowlink = new Int32Array(n).fill(-1);
  const onStack = new Uint8Array(n);
  const sccStack: number[] = [];
  const sccs: SCC[] = [];
  let nextIndex = 0;

  // Explicit call stack: each frame tracks (node, neighbor iterator position)
  interface Frame {
    node: number;
    neighborIdx: number;
    calledFrom: number; // neighbor that triggered this frame, or -1
  }

  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;

    const callStack: Frame[] = [{ node: root, neighborIdx: 0, calledFrom: -1 }];
    index[root] = lowlink[root] = nextIndex++;
    sccStack.push(root);
    onStack[root] = 1;

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      const v = frame.node;
      const neighbors = graph.adjacency[v];

      if (frame.neighborIdx < neighbors.length) {
        const w = neighbors[frame.neighborIdx];
        frame.neighborIdx++;

        if (index[w] === -1) {
          // Visit w: push new frame
          index[w] = lowlink[w] = nextIndex++;
          sccStack.push(w);
          onStack[w] = 1;
          callStack.push({ node: w, neighborIdx: 0, calledFrom: v });
        } else if (onStack[w]) {
          lowlink[v] = Math.min(lowlink[v], index[w]);
        }
      } else {
        // All neighbors processed — pop this frame
        callStack.pop();

        // Update parent's lowlink
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1].node;
          lowlink[parent] = Math.min(lowlink[parent], lowlink[v]);
        }

        // Check if v is SCC root
        if (lowlink[v] === index[v]) {
          const scc: number[] = [];
          let w: number;
          do {
            w = sccStack.pop()!;
            onStack[w] = 0;
            scc.push(w);
          } while (w !== v);
          sccs.push({ equations: scc });
        }
      }
    }
  }

  sccs.reverse();
  return sccs;
}
```

### 4.3 BLT blocks

Each SCC becomes a BLT block. A block with one equation is a **scalar block** (solved by direct assignment). A block with multiple equations is an **algebraic loop** (solved by iterative methods).

```typescript
type BlockKind = "scalar" | "algebraic_loop";

interface BLTBlock {
  kind: BlockKind;
  equations: number[];       // equation indices
  variables: number[];       // matched variable indices (same length as equations)
}

function buildBLT(
  sccs: SCC[],
  matching: Matching,
  graph: DependencyGraph
): BLTBlock[] {
  const blocks: BLTBlock[] = [];

  for (const scc of sccs) {
    // Skip unmatched equations
    const matchedEqs = scc.equations.filter(eq => matching.equationMatch[eq] !== -1);
    if (matchedEqs.length === 0) continue;

    const matchedVars = matchedEqs.map(eq => matching.equationMatch[eq]);

    if (matchedEqs.length === 1) {
      // Scalar block — but check for self-dependency
      const eq = matchedEqs[0];
      const v = matchedVars[0];
      const hasSelfDep = graph.adjacency[eq].includes(eq);

      blocks.push({
        kind: hasSelfDep ? "algebraic_loop" : "scalar",
        equations: matchedEqs,
        variables: matchedVars,
      });
    } else {
      blocks.push({
        kind: "algebraic_loop",
        equations: matchedEqs,
        variables: matchedVars,
      });
    }
  }

  return blocks;
}
```

A single-equation block can still be an algebraic loop if the equation depends on its own matched variable through a nonlinear path (self-dependency). For example, `x = sin(x)` — one equation, one unknown, but it cannot be solved by direct assignment. The self-loop check catches this.

### 4.4 The full BLT output

```typescript
interface BLTDecomposition {
  blocks: BLTBlock[];
  matching: Matching;
  incidence: IncidenceMatrix;
  variableIndex: VariableIndex;
  system: EquationSystem;

  // Index assessment
  unmatchedEquations: number[];
  isHighIndex: boolean;
}
```

---

## Part 5: Putting It Together

### 5.1 The top-level function

```typescript
function processEquations(flat: FlatSystem): BLTDecomposition {
  // Step 1: Classify variables
  const system = classifyVariables(flat);
  const varIndex = new VariableIndex(system.unknowns);

  // Step 2: Build incidence matrix
  const incidence = buildIncidenceMatrix(system, varIndex);

  // Step 3: Determine matchable variables (derivatives + algebraic)
  const matchableVars = getMatchableVariables(system.unknowns, varIndex);

  // Step 4: Find maximum bipartite matching
  const matching = hopcroftKarp(incidence, matchableVars);

  // Step 5: Validate matching
  const validation = validateMatching(matching, system, varIndex);

  // Step 6: Build dependency graph and BLT decomposition
  // (only if matching is complete or nearly so)
  let blocks: BLTBlock[] = [];
  if (validation.unmatchedEquations.length === 0) {
    const depGraph = buildDependencyGraph(matching, incidence, matchableVars);
    const sccs = tarjanSCCIterative(depGraph);
    blocks = buildBLT(sccs, matching, depGraph);
  }

  return {
    blocks,
    matching,
    incidence,
    variableIndex: varIndex,
    system,
    unmatchedEquations: validation.unmatchedEquations,
    isHighIndex: validation.isHighIndex,
  };
}
```

### 5.2 Consistency check: equation/variable counts

Before running the algorithms, a basic sanity check:

```typescript
function checkCounts(system: EquationSystem): void {
  const numEquations = system.equations.length;
  const numDerivatives = system.unknowns.filter(v => v.role === "derivative").length;
  const numAlgebraic = system.unknowns.filter(v => v.role === "algebraic").length;
  const numMatchable = numDerivatives + numAlgebraic;

  if (numEquations < numMatchable) {
    throw new Error(
      `Under-determined system: ${numEquations} equations but ${numMatchable} ` +
      `unknowns to solve for (${numDerivatives} derivatives + ${numAlgebraic} algebraic)`
    );
  }

  if (numEquations > numMatchable) {
    // This might be OK — could indicate high-index constraints.
    // Or it could be genuinely over-determined. Report as a warning.
    console.warn(
      `Potentially over-determined: ${numEquations} equations for ${numMatchable} ` +
      `matchable unknowns. May indicate high-index constraints.`
    );
  }
}
```

For an index-0 system (pure ODE), the number of equations should exactly equal the number of derivatives plus algebraic variables. For a high-index system like the pendulum, there will be more equations than matchable variables — the "extra" equations are constraints that Phase 4 must differentiate.

---

## Worked Example: SpringMassDamper

**Input flat system:**

Variables: `x` (continuous), `v` (continuous), `m` (parameter, 1.0), `k` (parameter, 10.0), `d` (parameter, 0.5)

Equations:
- E0: `v = der(x)`
- E1: `m * der(v) = -(k * x) - (d * v)`

**Step 1: Variable classification**

Scan for `der()` calls:
- E0 contains `der(x)` → `x` is a state
- E1 contains `der(v)` → `v` is a state

Classified unknowns (4 total):

| Index | Name | Role |
|---|---|---|
| 0 | `x` | state |
| 1 | `der(x)` | derivative |
| 2 | `v` | state |
| 3 | `der(v)` | derivative |

Parameters removed: `m`, `k`, `d`

**Step 2: Incidence matrix**

Walk E0 (`v = der(x)`):
- LHS: `v` → index 2 (state)
- RHS: `der(x)` → index 1 (derivative), also adds index 0 (`x`, state)
- E0 incidence: {0, 1, 2}

Walk E1 (`m * der(v) = -(k * x) - (d * v)`):
- LHS: `m` (parameter, skip), `der(v)` → index 3 (derivative), also adds index 2 (`v`, state)
- RHS: `k` (skip), `x` → index 0 (state), `d` (skip), `v` → index 2 (state)
- E1 incidence: {0, 2, 3}

```
        x(0)  der(x)(1)  v(2)  der(v)(3)
E0:      1      1         1      0
E1:      1      0         1      1
```

**Step 3: Matching**

Matchable variables: `der(x)` (index 1) and `der(v)` (index 3). States `x` and `v` are not matchable.

Hopcroft-Karp finds:
- E0 → `der(x)` (index 1)
- E1 → `der(v)` (index 3)

Complete matching — no unmatched equations.

**Step 4: Dependency graph**

E0 is matched to `der(x)`. E0 also involves `x` (state, skip) and `v` (state, skip). No dependencies on other equations.

E1 is matched to `der(v)`. E1 also involves `x` (state, skip) and `v` (state, skip). No dependencies on other equations.

Adjacency: E0 → [], E1 → []. No edges.

**Step 5: Tarjan's SCC**

Two nodes with no edges → two SCCs, each containing one equation.

**Step 6: BLT blocks**

```
Block 0: { E0 → der(x) }   (scalar)
Block 1: { E1 → der(v) }   (scalar)
```

Both blocks are scalar — no algebraic loops. They can be evaluated in either order (or in parallel) since neither depends on the other.

---

## Worked Example: Four-Equation System with Algebraic Loop

**Equations and matching:**

```
E0 → a:   a = sin(time)
E1 → b:   b = 2 * a + c
E2 → c:   c = b + 1
E3 → d:   d = a + c
```

All four variables are algebraic (no `der()` calls).

**Incidence:**

```
        a(0)  b(1)  c(2)  d(3)
E0:      1     0     0     0
E1:      1     1     1     0
E2:      0     1     1     0
E3:      1     0     1     1
```

**Matching:** E0→a, E1→b, E2→c, E3→d

**Dependency graph:**

- E0: uses nothing solved by other equations (only `time`) → []
- E1: uses `a` (E0) and `c` (E2) → [E0, E2]
- E2: uses `b` (E1) → [E1]
- E3: uses `a` (E0) and `c` (E2) → [E0, E2]

```
E0 → []
E1 → [E0, E2]
E2 → [E1]
E3 → [E0, E2]
```

**Tarjan's SCC:**

DFS from E0: E0 has no outgoing edges → SCC {E0}

DFS from E1: E1 → E0 (already done), E1 → E2 → E1 (cycle found) → SCC {E1, E2}

DFS from E3: E3 → E0 (done), E3 → E2 (done) → SCC {E3}

Reverse for topological order:

```
Block 0: { E0 → a }           (scalar)
Block 1: { E1 → b, E2 → c }  (algebraic loop)
Block 2: { E3 → d }           (scalar)
```

Block 0 must execute first (Block 1 depends on `a`). Block 1 is an algebraic loop — `b` and `c` are mutually dependent and must be solved simultaneously. Block 2 depends on `a` and `c`, which are both determined by earlier blocks.

---

## Worked Example: Pendulum (High-Index Detection)

**Equations:**

```
E0: der(x) = vx
E1: der(y) = vy
E2: m * der(vx) = -lambda * x
E3: m * der(vy) = -lambda * y - m * g
E4: x^2 + y^2 = L^2
```

**Variable classification:**

States: `x`, `y`, `vx`, `vy` (all appear inside `der()`)
Derivatives: `der(x)`, `der(y)`, `der(vx)`, `der(vy)`
Algebraic: `lambda`

Matchable: `der(x)`, `der(y)`, `der(vx)`, `der(vy)`, `lambda` — 5 matchable unknowns, 5 equations.

**Incidence (matchable variables only):**

```
           der(x)  der(y)  der(vx)  der(vy)  lambda
E0:          1       0       0        0        0
E1:          0       1       0        0        0
E2:          0       0       1        0        1
E3:          0       0       0        1        1
E4:          0       0       0        0        0
```

E4 (`x^2 + y^2 = L^2`) contains only state variables `x` and `y` — no matchable variables appear. It has an empty row in the matchable incidence.

**Matching attempt:**

- E0 → `der(x)` ✓
- E1 → `der(y)` ✓
- E2 → `der(vx)` or `lambda` — say `der(vx)` ✓
- E3 → `der(vy)` or `lambda` — say `der(vy)` ✓
- E4 → nothing available ✗

E4 cannot be matched. The matching has 4 matched equations and 1 unmatched equation.

**Index assessment:** E4 is an unmatched equation whose incidence set (over all variables, including states) is `{x, y}` — both states. This is the structural signature of a high-index constraint. The result reports `isHighIndex: true` with `unmatchedEquations: [4]`.

Phase 4 (Pantelides algorithm) will differentiate E4 to produce a new equation involving `der(x)` and `der(y)`, demote a state, and retry the matching.

---

## Testing

**Variable classification tests:** Given flat systems with known `der()` calls, verify that the correct variables are classified as states, derivatives, and algebraic. Test edge cases: a variable that appears both inside and outside `der()` (it is still a state), a system with no `der()` calls (all algebraic — a purely algebraic system), and nested `der()` calls (which should not occur in well-formed Modelica but should produce a clear error).

**Incidence matrix tests:** Build the incidence matrix for the SpringMassDamper and verify the entries match the hand-computed matrix. Test that parameters are excluded. Test that `der(x)` adds both the derivative variable and the state variable to the incidence.

**Matching tests:** Test with small systems where the matching is unambiguous. Test with systems that have multiple valid matchings (any is correct). Test structurally singular systems (no complete matching exists) and verify the error is reported. Test the pendulum system and verify E4 is unmatched.

**BLT decomposition tests:** Test the four-equation system with the algebraic loop and verify the block structure. Test a fully sequential system (all scalar blocks) and a fully coupled system (one big algebraic loop). Test that the topological order is correct — no block depends on a later block.

**Integration test:** Run the full `processEquations` pipeline on the SimpleCircuit flat system from Phase 2 and verify the output. The circuit has 17 equations and 17 matchable unknowns (no states with `der()` except the capacitor voltage); the BLT should show mostly scalar blocks with connection equation aliases, plus a few coupled blocks.
