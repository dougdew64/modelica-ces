# Phase 5: Code Generation and Numerical Solving — Implementation Details

This document describes how to implement the code generation and numerical solving phase of the Modelica compiler. This phase takes the fully analyzed, index-reduced, BLT-sorted, torn system from Phase 4 and produces an executable simulation.

## Architecture

The project is developed in two stages: a CLI tool first, then a browser-based application later.

**Stage 1: CLI tool (Deno).** A command-line compiler and simulator. Takes `.mo` files as input, compiles them through Phases 1–4, runs the simulation via SUNDIALS IDA (compiled to WASM), and outputs results. No UI, no browser. This is simpler to build and provides a tight feedback loop for getting the compiler and solver correct.

**Stage 2: Browser application (later).** Reuses the same compiler and solver core from Stage 1, adding a drag-and-drop modeling UI that generates Modelica code, interactive simulation with instant feedback, and visualization of results.

The compiler and solver are written as a pure TypeScript library with no `Deno.*` API dependencies, so the same code runs in both Deno (CLI) and the browser. Only a thin platform-specific layer handles I/O differences (e.g., loading `.wasm` from disk vs. fetching over HTTP).

Phase 5 is different from Phases 1–4: it involves tight numerical loops (residual evaluation, Jacobian computation, Newton iteration) that run thousands of times per time step. The SUNDIALS IDA solver handles the core integration in both strategies below.

There are two strategies for how the simulation is produced. Both use SUNDIALS IDA for the integration loop, but they differ in how the model equations are represented. The Interactive Strategy generates JS closures and calls back from a pre-compiled SUNDIALS WASM module. The Export Strategy compiles the model equations to C alongside SUNDIALS into a native binary (or standalone WASM module).

### The user workflow

The two strategies are not competing alternatives — they are complementary stages in a modeling workflow:

1. **Interactive development (CLI and browser).** The user provides a Modelica model (via `.mo` file in the CLI, or via the browser editor later). Phases 1–4 run, the Interactive Strategy generates JS closures instantly, and the simulation executes immediately via the pre-compiled SUNDIALS WASM module. There is no compilation step, so the feedback loop is fast — change the model, see the results in seconds. This is the primary mode during model development.

2. **Export for production.** Once the user is satisfied that their model is correct, they can export it as a standalone executable. The Export Strategy generates C source code and compiles it (with SUNDIALS) into a native binary (or a standalone WASM module for server-side runtimes). This exported artifact has no dependency on Deno, the browser, the TypeScript compiler, or JS callbacks — it can be run on a server, embedded in a batch pipeline, or deployed as a standalone simulation tool. It is also faster for large models since everything runs as compiled native code.

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│   Stage 1 (CLI):     deno run cli.ts model.mo                    │
│   Stage 2 (Browser): User edits model in drag-and-drop UI        │
│            │                                                     │
│            ▼                                                     │
│   Phases 1–4 (TypeScript — pure library, no platform deps)       │
│            │                                                     │
│            ├───── "Simulate" ─────► Interactive (JS closures)    │
│            │                        Instant feedback             │
│            │                        CLI or browser               │
│            │                                                     │
│            └───── "Export" ───────► Export (C codegen)           │
│                                     Compile to WASM/native       │
│                                     Standalone executable        │
│                                     Runs anywhere                │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

The Interactive Strategy is implemented first. The Export Strategy is added later.

### Interactive Strategy: Generate JS, call back from WASM

The code generator emits JavaScript functions (closures) that implement the residual function. SUNDIALS IDA is pre-compiled to WASM once, and at each time step it calls back into the JS residual function. No per-model compilation step is needed — the residual function is constructed instantly by building a closure from generated code strings.

```
┌──────────────────────────────────────────────────────────┐
│  Deno (CLI) or Browser                                   │
│                                                          │
│  TypeScript (Phases 1–4)                                 │
│       │                                                  │
│       ▼                                                  │
│  JS Code Generation ──→ JS residual function (closure)   │
│                              │                           │
│  Pre-compiled WASM ◄─────────┘  (callback at each step)  │
│  (SUNDIALS IDA)                                          │
│       │                                                  │
│       ▼                                                  │
│  time series results                                     │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

This eliminates the compilation step entirely. The cost is that the residual function crosses the WASM-to-JS boundary at each solver call, and the model arithmetic runs as JIT-compiled JS rather than ahead-of-time compiled WASM. For interactive use during model development, this overhead is negligible.

### Export Strategy: Generate C, compile to standalone executable

The code generator emits C source that implements the residual function, and this C is compiled alongside SUNDIALS into a native binary via a standard C compiler (or into a standalone WASM module via Emscripten for server-side runtimes). The result is a self-contained executable with no browser, Deno, or JS runtime dependencies.

```
┌─────────────────────────────────┐
│  TypeScript (Deno or Browser)   │
│                                 │
│  Phase 1–4                      │
│                                 │
│  C Code Generation ─────────────┼──→ C source files
│                                 │     │
└─────────────────────────────────┘     │
                                        ▼
                              gcc/clang ──→ native binary
                              or
                              Emscripten ──→ standalone .wasm
```

The exported C code includes the simulation loop, SUNDIALS integration, and all model functions — no JS callbacks, no runtime dependency. It is typically compiled to a native binary for maximum performance, or to a standalone WASM module for server-side runtimes.

### Document organization

The document covers both strategies. The C code generation (Export Strategy) is presented first in Parts 1–3 because the concepts it introduces (variable mapping, expression translation, BLT block emission, torn block Newton solvers) apply equally to JS code generation. Part 5 then describes the Interactive Strategy by showing how the same structure is adapted to produce JS closures instead of C source.

1. **C code generation** (Export) — TypeScript that emits C source for standalone export
2. **The C runtime and SUNDIALS integration** — the static C simulation driver
3. **The WASM bridge for export** — Emscripten compilation for standalone WASM modules
4. **The full Phase 5 pipeline** — end-to-end flow for both strategies (Interactive first)
5. **JS code generation** (Interactive) — TypeScript that emits JS closures, with a pre-compiled SUNDIALS WASM module that calls back into them

The Interactive Strategy (Part 5) is implemented first. Parts 1–3 are implemented later when the export feature is added.

---

## Part 1: C Code Generation (Export Strategy)

### 1.1 What gets generated

This section describes the Export Strategy, where the model equations are compiled to C for standalone export. This is the second strategy to be implemented — the Interactive Strategy (JS callbacks for interactive simulation) is described in Part 5 and is implemented first.

The C code generator produces a self-contained C source file that can be compiled with SUNDIALS into a native binary (or standalone WASM module). It contains five functions:

1. `model_initialize` — sets parameters and solves the initial value problem
2. `model_residual` — computes the DAE residual vector F(t, y, y') for IDA
3. `model_root` — computes zero-crossing functions for event detection
4. `model_handle_event` — updates discrete state when an event occurs
5. `model_output` — copies variable values to an output buffer for TypeScript

Plus data declarations: parameter values, variable name mappings, and structural metadata (number of states, number of events, sparsity pattern).

### 1.2 The code generator structure

```typescript
interface CodeGenInput {
  // From Phase 4
  equations: FlatEquation[];
  unknowns: ClassifiedVariable[];
  parameters: Map<string, FlatVariable>;
  blocks: TornBlock[];
  matching: Matching;
  variableIndex: VariableIndex;
  dummyDerivativeGroups: DummyDerivativeGroup[];
  aliasMap: AliasMap;

  // Simulation settings
  startTime: number;
  stopTime: number;
  outputInterval: number;
  tolerance: number;
}

function generateC(input: CodeGenInput): string {
  const gen = new CCodeGenerator(input);
  return gen.generate();
}
```

The generator builds the C source string incrementally using a string buffer with indentation tracking:

```typescript
class CCodeGenerator {
  private input: CodeGenInput;
  private buf: string[];
  private indent: number;

  // Maps from flat variable names to their index in the state/algebraic vectors
  private stateIndex: Map<string, number>;
  private derivIndex: Map<string, number>;
  private algIndex: Map<string, number>;
  private paramIndex: Map<string, number>;

  // Zero-crossing information extracted from equations
  private zeroCrossings: ZeroCrossingInfo[];

  constructor(input: CodeGenInput) {
    this.input = input;
    this.buf = [];
    this.indent = 0;
    this.stateIndex = new Map();
    this.derivIndex = new Map();
    this.algIndex = new Map();
    this.paramIndex = new Map();
    this.zeroCrossings = [];

    this.buildVariableMaps();
    this.extractZeroCrossings();
  }

  private emit(line: string): void {
    this.buf.push("  ".repeat(this.indent) + line);
  }

  private emitBlank(): void {
    this.buf.push("");
  }

  generate(): string {
    this.emitHeader();
    this.emitDataStructures();
    this.emitInitialize();
    this.emitResidual();
    this.emitRootFinding();
    this.emitEventHandler();
    this.emitOutput();
    return this.buf.join("\n");
  }
}
```

### 1.3 Variable mapping

The solver works with flat arrays: `y[0]`, `y[1]`, ... for states and `ydot[0]`, `ydot[1]`, ... for derivatives. The code generator assigns each variable a slot:

```typescript
private buildVariableMaps(): void {
  let stateIdx = 0;
  let algIdx = 0;
  let paramIdx = 0;

  for (const v of this.input.unknowns) {
    switch (v.role) {
      case "state":
        this.stateIndex.set(v.name, stateIdx);
        this.derivIndex.set(v.derivativeOf!, stateIdx);
        stateIdx++;
        break;
      case "algebraic":
        this.algIndex.set(v.name, algIdx);
        algIdx++;
        break;
      // Derivatives are accessed as ydot[stateIndex], not separately indexed
    }
  }

  for (const [name] of this.input.parameters) {
    this.paramIndex.set(name, paramIdx);
    paramIdx++;
  }
}
```

### 1.4 Header and data structures

```typescript
private emitHeader(): void {
  this.emit("#include <math.h>");
  this.emit("#include <string.h>");
  this.emit("#include <ida/ida.h>");
  this.emit("#include <nvector/nvector_serial.h>");
  this.emit("#include <sunlinsol/sunlinsol_dense.h>");
  this.emit("#include <sunmatrix/sunmatrix_dense.h>");
  this.emit("#include <sundials/sundials_types.h>");
  this.emitBlank();
  this.emit(`#define NUM_STATES ${this.stateIndex.size}`);
  this.emit(`#define NUM_ALGEBRAIC ${this.algIndex.size}`);
  this.emit(`#define NUM_PARAMS ${this.paramIndex.size}`);
  this.emit(`#define NUM_EVENTS ${this.zeroCrossings.length}`);
  this.emit(`#define NUM_VARS_TOTAL ${this.stateIndex.size + this.algIndex.size}`);
  this.emitBlank();
}

private emitDataStructures(): void {
  this.emit("typedef struct {");
  this.indent++;
  this.emit("realtype params[NUM_PARAMS];");
  this.emit("realtype alg[NUM_ALGEBRAIC];");
  this.emit("int event_flags[NUM_EVENTS];");  // current boolean state of each event
  this.indent--;
  this.emit("} ModelData;");
  this.emitBlank();
}
```

The `ModelData` struct holds values that persist across residual calls but are not part of IDA's state vector: parameter values, algebraic variable scratch space, and the current boolean state of each event indicator.

### 1.5 Initialization function

The initialization function sets parameter values and computes consistent initial conditions. IDA provides `IDACalcIC` for computing consistent initial derivatives, but the states themselves must be set from the `start` attributes.

```typescript
private emitInitialize(): void {
  this.emit("void model_initialize(ModelData* md, realtype* y, realtype* ydot) {");
  this.indent++;

  // Set parameter values
  for (const [name, v] of this.input.parameters) {
    const idx = this.paramIndex.get(name)!;
    const value = v.bindingExpression
      ? this.evaluateConstant(v.bindingExpression)
      : 0.0;
    this.emit(`md->params[${idx}] = ${this.formatReal(value)}; /* ${name} */`);
  }
  this.emitBlank();

  // Set initial state values from start attributes
  for (const v of this.input.unknowns) {
    if (v.role === "state") {
      const idx = this.stateIndex.get(v.name)!;
      const flatVar = this.findFlatVariable(v.name);
      const startVal = flatVar?.attributes.start
        ? this.evaluateConstant(flatVar.attributes.start)
        : 0.0;
      this.emit(`y[${idx}] = ${this.formatReal(startVal)}; /* ${v.name} */`);
    }
  }
  this.emitBlank();

  // Set initial derivative guesses to zero
  // IDACalcIC will compute consistent values
  this.emit("memset(ydot, 0, NUM_STATES * sizeof(realtype));");
  this.emitBlank();

  // Initialize algebraic variables to zero (or start values if available)
  for (const v of this.input.unknowns) {
    if (v.role === "algebraic") {
      const idx = this.algIndex.get(v.name)!;
      const flatVar = this.findFlatVariable(v.name);
      const startVal = flatVar?.attributes.start
        ? this.evaluateConstant(flatVar.attributes.start)
        : 0.0;
      this.emit(`md->alg[${idx}] = ${this.formatReal(startVal)}; /* ${v.name} */`);
    }
  }
  this.emitBlank();

  // Initialize event flags
  this.emit("memset(md->event_flags, 0, NUM_EVENTS * sizeof(int));");

  this.indent--;
  this.emit("}");
  this.emitBlank();
}
```

### 1.6 Residual function

This is the core generated function. IDA calls it repeatedly at each time step. It must compute the residual vector `F(t, y, ydot) = 0`.

The function's structure directly mirrors the BLT block ordering from Phase 4. Scalar blocks become direct assignments. Torn algebraic loops become Newton iteration blocks.

```typescript
private emitResidual(): void {
  // IDA residual signature:
  //   int model_residual(realtype t, N_Vector yy, N_Vector yp, N_Vector rr, void* user_data)
  this.emit("int model_residual(realtype t, N_Vector yy, N_Vector yp, N_Vector rr, void* user_data) {");
  this.indent++;

  this.emit("ModelData* md = (ModelData*)user_data;");
  this.emit("realtype* y = N_VGetArrayPointer(yy);");
  this.emit("realtype* ydot = N_VGetArrayPointer(yp);");
  this.emit("realtype* res = N_VGetArrayPointer(rr);");
  this.emitBlank();

  // Unpack states and derivatives into named locals for readability
  this.emitUnpackStates();
  this.emitBlank();

  // Evaluate BLT blocks in order
  let residualIdx = 0;
  for (let blockIdx = 0; blockIdx < this.input.blocks.length; blockIdx++) {
    const block = this.input.blocks[blockIdx];
    this.emit(`/* Block ${blockIdx} */`);

    if (block.tearingVars.length === 0) {
      // Scalar or non-torn block
      for (let i = 0; i < block.innerEqs.length; i++) {
        const eqIdx = block.innerEqs[i];
        const varIdx = block.innerVars[i];
        const variable = this.input.variableIndex.variableAt(varIdx);
        const eq = this.input.equations[eqIdx];

        if (variable.role === "derivative") {
          // This equation determines a derivative — emit as residual
          this.emitResidualEquation(eq, residualIdx, variable);
          residualIdx++;
        } else if (variable.role === "algebraic") {
          // This equation determines an algebraic variable — emit as assignment
          this.emitAlgebraicAssignment(eq, variable);
        }
      }
    } else {
      // Torn block — emit Newton solver
      this.emitTornBlockSolver(block, blockIdx);
      // Residuals for the tearing variables
      for (const varIdx of block.tearingVars) {
        const variable = this.input.variableIndex.variableAt(varIdx);
        if (variable.role === "derivative") {
          residualIdx++;
        }
      }
    }
    this.emitBlank();
  }

  this.emit("return 0;");
  this.indent--;
  this.emit("}");
  this.emitBlank();
}
```

#### Unpacking states

```typescript
private emitUnpackStates(): void {
  for (const v of this.input.unknowns) {
    if (v.role === "state") {
      const idx = this.stateIndex.get(v.name)!;
      const cName = this.toCName(v.name);
      this.emit(`realtype ${cName} = y[${idx}];`);
    }
  }
  this.emitBlank();
  // Also unpack derivatives
  for (const v of this.input.unknowns) {
    if (v.role === "derivative") {
      const stateIdx = this.stateIndex.get(v.stateOf!)!;
      const cName = this.toCName(v.name);
      this.emit(`realtype ${cName} = ydot[${stateIdx}];`);
    }
  }
  this.emitBlank();
  // Unpack parameters
  for (const [name] of this.input.parameters) {
    const idx = this.paramIndex.get(name)!;
    const cName = this.toCName(name);
    this.emit(`realtype ${cName} = md->params[${idx}];`);
  }
}
```

#### Emitting a residual equation

For an equation `lhs = rhs` matched to a derivative variable, the residual is `lhs - rhs`:

```typescript
private emitResidualEquation(
  eq: FlatEquation,
  residualIdx: number,
  variable: ClassifiedVariable
): void {
  const lhsC = this.exprToC(eq.lhs);
  const rhsC = this.exprToC(eq.rhs);
  this.emit(`res[${residualIdx}] = (${lhsC}) - (${rhsC}); /* ${variable.name} */`);
}
```

#### Emitting an algebraic assignment

For a scalar block where an algebraic variable is solved directly from the equation, the code generator rearranges the equation into assignment form. In simple cases (`a = expr`), this is trivial. In the general case, the equation might need rearrangement.

For the initial implementation, handle the common case where one side of the equation is the matched variable:

```typescript
private emitAlgebraicAssignment(
  eq: FlatEquation,
  variable: ClassifiedVariable
): void {
  const cName = this.toCName(variable.name);
  const algIdx = this.algIndex.get(variable.name);

  // Check if lhs is the variable
  if (eq.lhs.kind === "variable" && eq.lhs.name === variable.name) {
    const rhsC = this.exprToC(eq.rhs);
    this.emit(`realtype ${cName} = ${rhsC};`);
    if (algIdx !== undefined) {
      this.emit(`md->alg[${algIdx}] = ${cName};`);
    }
    return;
  }

  // Check if rhs is the variable
  if (eq.rhs.kind === "variable" && eq.rhs.name === variable.name) {
    const lhsC = this.exprToC(eq.lhs);
    this.emit(`realtype ${cName} = ${lhsC};`);
    if (algIdx !== undefined) {
      this.emit(`md->alg[${algIdx}] = ${cName};`);
    }
    return;
  }

  // General case: solve lhs - rhs = 0 for the variable.
  // For scalar blocks this should be algebraically solvable in closed form,
  // but for a first implementation, emit as a residual with a comment.
  // A more sophisticated code generator would perform symbolic solve here.
  const lhsC = this.exprToC(eq.lhs);
  const rhsC = this.exprToC(eq.rhs);
  this.emit(`/* TODO: solve (${lhsC}) - (${rhsC}) = 0 for ${cName} */`);
  this.emit(`realtype ${cName} = 0.0; /* placeholder */`);
  if (algIdx !== undefined) {
    this.emit(`md->alg[${algIdx}] = ${cName};`);
  }
}
```

#### Emitting a torn algebraic loop solver

Torn blocks require an embedded Newton iteration. The code generator produces an inline Newton solver with the tearing structure baked in:

```typescript
private emitTornBlockSolver(block: TornBlock, blockIdx: number): void {
  const numTear = block.tearingVars.length;

  this.emit(`/* Torn block ${blockIdx}: ${numTear} tearing variables */`);
  this.emit("{");
  this.indent++;

  // Declare tearing variables with initial guesses from previous values
  for (const varIdx of block.tearingVars) {
    const v = this.input.variableIndex.variableAt(varIdx);
    const cName = this.toCName(v.name);
    const algIdx = this.algIndex.get(v.name);
    if (algIdx !== undefined) {
      this.emit(`realtype ${cName} = md->alg[${algIdx}];`);
    } else {
      this.emit(`realtype ${cName} = 0.0;`);
    }
  }
  this.emitBlank();

  // Newton iteration
  this.emit(`realtype tear_res[${numTear}];`);
  this.emit(`realtype tear_dx[${numTear}];`);
  this.emit("int newton_iter;");
  this.emit("for (newton_iter = 0; newton_iter < 100; newton_iter++) {");
  this.indent++;

  // Evaluate inner equations (sequential assignments given tearing vars)
  for (let i = 0; i < block.innerEqs.length; i++) {
    const eqIdx = block.innerEqs[i];
    const varIdx = block.innerVars[i];
    const v = this.input.variableIndex.variableAt(varIdx);
    const eq = this.input.equations[eqIdx];
    this.emitAlgebraicAssignment(eq, v);
  }
  this.emitBlank();

  // Evaluate residuals for tearing variables
  for (let i = 0; i < block.tearingVars.length; i++) {
    const eqIdx = block.residualEqs[i];
    const eq = this.input.equations[eqIdx];
    const lhsC = this.exprToC(eq.lhs);
    const rhsC = this.exprToC(eq.rhs);
    this.emit(`tear_res[${i}] = (${lhsC}) - (${rhsC});`);
  }
  this.emitBlank();

  // Convergence check
  this.emit("realtype tear_norm = 0.0;");
  this.emit(`for (int i = 0; i < ${numTear}; i++) tear_norm += tear_res[i] * tear_res[i];`);
  this.emit("if (tear_norm < 1e-12) break;");
  this.emitBlank();

  // Newton update using finite-difference Jacobian
  // For small torn blocks this is efficient — the Jacobian is numTear × numTear
  this.emitFiniteDifferenceNewtonUpdate(block, blockIdx);

  this.indent--;
  this.emit("}"); // end Newton loop
  this.emitBlank();

  // Store converged values
  for (const varIdx of block.tearingVars) {
    const v = this.input.variableIndex.variableAt(varIdx);
    const cName = this.toCName(v.name);
    const algIdx = this.algIndex.get(v.name);
    if (algIdx !== undefined) {
      this.emit(`md->alg[${algIdx}] = ${cName};`);
    }
  }

  this.indent--;
  this.emit("}");
}
```

The Newton update for small torn blocks uses a finite-difference Jacobian and a direct dense solve. For blocks of size 1 (the most common case), this simplifies to a scalar Newton step:

```typescript
private emitFiniteDifferenceNewtonUpdate(block: TornBlock, blockIdx: number): void {
  const n = block.tearingVars.length;

  if (n === 1) {
    // Scalar Newton: x_new = x - f(x) / f'(x)
    // f'(x) ≈ (f(x+h) - f(x)) / h
    const v = this.input.variableIndex.variableAt(block.tearingVars[0]);
    const cName = this.toCName(v.name);
    this.emit(`realtype tear_h = fmax(1e-8, fabs(${cName}) * 1e-8);`);
    this.emit(`${cName} += tear_h;`);

    // Re-evaluate inner equations and residual with perturbed value
    for (let i = 0; i < block.innerEqs.length; i++) {
      const eq = this.input.equations[block.innerEqs[i]];
      const iv = this.input.variableIndex.variableAt(block.innerVars[i]);
      this.emitAlgebraicAssignment(eq, iv);
    }
    const eq0 = this.input.equations[block.residualEqs[0]];
    const lhsC = this.exprToC(eq0.lhs);
    const rhsC = this.exprToC(eq0.rhs);
    this.emit(`realtype tear_res_pert = (${lhsC}) - (${rhsC});`);
    this.emit(`${cName} -= tear_h;`);
    this.emitBlank();
    this.emit(`realtype tear_deriv = (tear_res_pert - tear_res[0]) / tear_h;`);
    this.emit(`if (fabs(tear_deriv) > 1e-30) ${cName} -= tear_res[0] / tear_deriv;`);
  } else {
    // Multi-dimensional: finite-difference Jacobian + dense Gauss elimination
    this.emit(`realtype tear_J[${n}][${n}];`);
    this.emit(`realtype tear_res_pert[${n}];`);

    for (let j = 0; j < n; j++) {
      const v = this.input.variableIndex.variableAt(block.tearingVars[j]);
      const cName = this.toCName(v.name);
      this.emit(`{`);
      this.indent++;
      this.emit(`realtype tear_h = fmax(1e-8, fabs(${cName}) * 1e-8);`);
      this.emit(`${cName} += tear_h;`);

      // Re-evaluate inner equations
      for (let i = 0; i < block.innerEqs.length; i++) {
        const eq = this.input.equations[block.innerEqs[i]];
        const iv = this.input.variableIndex.variableAt(block.innerVars[i]);
        this.emitAlgebraicAssignment(eq, iv);
      }

      // Evaluate perturbed residuals
      for (let i = 0; i < n; i++) {
        const eq = this.input.equations[block.residualEqs[i]];
        const lhsC = this.exprToC(eq.lhs);
        const rhsC = this.exprToC(eq.rhs);
        this.emit(`tear_J[${i}][${j}] = ((${lhsC}) - (${rhsC}) - tear_res[${i}]) / tear_h;`);
      }
      this.emit(`${cName} -= tear_h;`);
      this.indent--;
      this.emit("}");
    }
    this.emitBlank();

    // Solve J * dx = -res using Gaussian elimination with partial pivoting
    this.emit(`/* Gauss elimination for ${n}x${n} system */`);
    this.emit(`memcpy(tear_dx, tear_res, ${n} * sizeof(realtype));`);
    this.emit(`for (int i = 0; i < ${n}; i++) tear_dx[i] = -tear_dx[i];`);
    this.emit(`gauss_solve_${n}(tear_J, tear_dx);`);

    // Apply update
    for (let j = 0; j < n; j++) {
      const v = this.input.variableIndex.variableAt(block.tearingVars[j]);
      const cName = this.toCName(v.name);
      this.emit(`${cName} += tear_dx[${j}];`);
    }
  }
}
```

For multi-dimensional torn blocks, the code generator emits a call to `gauss_solve_N` — a small inline Gaussian elimination routine. Since torn blocks are typically small (2–5 variables after tearing), a dense direct solve is appropriate. The runtime library (Part 2) provides these routines for common sizes.

### 1.7 Expression to C

The core translation: convert a `FlatExpr` to a C expression string.

```typescript
private exprToC(expr: FlatExpr): string {
  switch (expr.kind) {
    case "real":
      return this.formatReal(expr.value);

    case "integer":
      return `${expr.value}.0`;

    case "boolean":
      return expr.value ? "1" : "0";

    case "string":
      // Strings should not appear in numerical equations
      throw new Error("String in numerical equation");

    case "time":
      return "t";

    case "variable":
      return this.toCName(expr.name);

    case "binary": {
      const left = this.exprToC(expr.left);
      const right = this.exprToC(expr.right);

      switch (expr.op) {
        case "+": return `(${left} + ${right})`;
        case "-": return `(${left} - ${right})`;
        case "*": return `(${left} * ${right})`;
        case "/": return `(${left} / ${right})`;
        case "^": return `pow(${left}, ${right})`;
        // Elementwise operators are identical to scalar at runtime
        case ".+": return `(${left} + ${right})`;
        case ".-": return `(${left} - ${right})`;
        case ".*": return `(${left} * ${right})`;
        case "./": return `(${left} / ${right})`;
        case ".^": return `pow(${left}, ${right})`;
        // Comparison operators
        case "<":  return `(${left} < ${right})`;
        case "<=": return `(${left} <= ${right})`;
        case ">":  return `(${left} > ${right})`;
        case ">=": return `(${left} >= ${right})`;
        case "==": return `(${left} == ${right})`;
        case "<>": return `(${left} != ${right})`;
        // Logical operators
        case "and": return `(${left} && ${right})`;
        case "or":  return `(${left} || ${right})`;
        default:
          throw new Error(`Unknown binary op: ${expr.op}`);
      }
    }

    case "unary":
      const operand = this.exprToC(expr.operand);
      switch (expr.op) {
        case "-":   return `(-(${operand}))`;
        case "+":   return operand;
        case "not": return `(!(${operand}))`;
      }
      break;

    case "call": {
      const args = expr.args.map(a => this.exprToC(a));
      switch (expr.name) {
        case "der":
          // der(x) → the derivative variable's C name
          if (expr.args[0].kind === "variable") {
            const derName = `der(${expr.args[0].name})`;
            return this.toCName(derName);
          }
          throw new Error("der() with non-variable argument in generated code");
        case "abs":   return `fabs(${args[0]})`;
        case "sqrt":  return `sqrt(${args[0]})`;
        case "sin":   return `sin(${args[0]})`;
        case "cos":   return `cos(${args[0]})`;
        case "tan":   return `tan(${args[0]})`;
        case "asin":  return `asin(${args[0]})`;
        case "acos":  return `acos(${args[0]})`;
        case "atan":  return `atan(${args[0]})`;
        case "atan2": return `atan2(${args[0]}, ${args[1]})`;
        case "exp":   return `exp(${args[0]})`;
        case "log":   return `log(${args[0]})`;
        case "sign":  return `((${args[0]} > 0) - (${args[0]} < 0))`;
        case "floor": return `floor(${args[0]})`;
        case "ceil":  return `ceil(${args[0]})`;
        case "min":   return `fmin(${args[0]}, ${args[1]})`;
        case "max":   return `fmax(${args[0]}, ${args[1]})`;
        case "mod":   return `fmod(${args[0]}, ${args[1]})`;
        default:
          throw new Error(`Unknown function in code generation: ${expr.name}`);
      }
    }

    case "if": {
      const cond = this.exprToC(expr.condition);
      const thenC = this.exprToC(expr.thenExpr);
      const elseC = this.exprToC(expr.elseExpr);

      if (expr.elseIfs.length === 0) {
        return `((${cond}) ? (${thenC}) : (${elseC}))`;
      }

      // Nested if-else chain
      let result = `((${cond}) ? (${thenC}) : `;
      for (const ei of expr.elseIfs) {
        const eiCond = this.exprToC(ei.condition);
        const eiVal = this.exprToC(ei.value);
        result += `(${eiCond}) ? (${eiVal}) : `;
      }
      result += `(${elseC})`;
      result += ")".repeat(expr.elseIfs.length + 1);
      return result;
    }
  }

  throw new Error(`Unhandled expression kind: ${(expr as any).kind}`);
}
```

### 1.8 Name mangling

Modelica flat names like `R1.p.v` and `der(x)` are not valid C identifiers. The code generator converts them:

```typescript
private toCName(flatName: string): string {
  // der(x) → der_x
  // R1.p.v → R1_p_v
  // r[1].p.v → r_1_p_v
  return flatName
    .replace(/\./g, "_")
    .replace(/\[/g, "_")
    .replace(/\]/g, "")
    .replace(/\(/g, "_")
    .replace(/\)/g, "")
    .replace(/,/g, "_");
}

private formatReal(value: number): string {
  // Ensure the value has a decimal point so C treats it as double
  const s = value.toString();
  if (s.includes(".") || s.includes("e") || s.includes("E")) {
    return s;
  }
  return s + ".0";
}
```

### 1.9 Zero-crossing extraction

Event detection requires identifying comparison expressions in equations that switch between true and false during simulation. The code generator scans all equations for comparison operators and `time`-dependent conditions:

```typescript
interface ZeroCrossingInfo {
  expression: FlatExpr;      // the comparison expression (e.g., time >= 0.5)
  zeroCrossingExpr: FlatExpr; // the function to monitor (e.g., time - 0.5)
  affectedEquations: number[]; // equations that contain this condition
}

private extractZeroCrossings(): void {
  const seen = new Set<string>();

  for (let i = 0; i < this.input.equations.length; i++) {
    const eq = this.input.equations[i];
    this.findComparisons(eq.lhs, i, seen);
    this.findComparisons(eq.rhs, i, seen);
  }
}

private findComparisons(expr: FlatExpr, eqIdx: number, seen: Set<string>): void {
  if (expr.kind === "binary" && isComparisonOp(expr.op)) {
    // Convert comparison to zero-crossing function
    // a >= b  →  monitor (a - b), event when it crosses zero
    const zcExpr: FlatExpr = { kind: "binary", op: "-", left: expr.left, right: expr.right };
    const key = flatExprToString(zcExpr);

    if (!seen.has(key)) {
      seen.add(key);
      this.zeroCrossings.push({
        expression: expr,
        zeroCrossingExpr: zcExpr,
        affectedEquations: [eqIdx],
      });
    } else {
      // Add this equation to the existing zero-crossing's affected list
      const existing = this.zeroCrossings.find(zc => flatExprToString(zc.zeroCrossingExpr) === key);
      if (existing) existing.affectedEquations.push(eqIdx);
    }
  }

  // Recurse
  switch (expr.kind) {
    case "binary":
      this.findComparisons(expr.left, eqIdx, seen);
      this.findComparisons(expr.right, eqIdx, seen);
      break;
    case "unary":
      this.findComparisons(expr.operand, eqIdx, seen);
      break;
    case "call":
      for (const arg of expr.args) this.findComparisons(arg, eqIdx, seen);
      break;
    case "if":
      this.findComparisons(expr.condition, eqIdx, seen);
      this.findComparisons(expr.thenExpr, eqIdx, seen);
      for (const ei of expr.elseIfs) {
        this.findComparisons(ei.condition, eqIdx, seen);
        this.findComparisons(ei.value, eqIdx, seen);
      }
      this.findComparisons(expr.elseExpr, eqIdx, seen);
      break;
  }
}

function isComparisonOp(op: string): boolean {
  return op === "<" || op === "<=" || op === ">" || op === ">="
      || op === "==" || op === "<>";
}
```

### 1.10 Root-finding function

IDA monitors zero-crossing functions and stops integration when any of them change sign:

```typescript
private emitRootFinding(): void {
  this.emit("int model_root(realtype t, N_Vector yy, N_Vector yp, realtype* gout, void* user_data) {");
  this.indent++;
  this.emit("ModelData* md = (ModelData*)user_data;");
  this.emit("realtype* y = N_VGetArrayPointer(yy);");
  this.emit("realtype* ydot = N_VGetArrayPointer(yp);");
  this.emitBlank();
  this.emitUnpackStates();
  this.emitBlank();

  for (let i = 0; i < this.zeroCrossings.length; i++) {
    const zc = this.zeroCrossings[i];
    const zcC = this.exprToC(zc.zeroCrossingExpr);
    this.emit(`gout[${i}] = ${zcC};`);
  }

  this.emitBlank();
  this.emit("return 0;");
  this.indent--;
  this.emit("}");
  this.emitBlank();
}
```

### 1.11 Event handler

When IDA detects a root (zero crossing), the simulation loop calls this function to update discrete state:

```typescript
private emitEventHandler(): void {
  this.emit("void model_handle_event(ModelData* md, realtype t, realtype* y, realtype* ydot) {");
  this.indent++;

  // Update event flags based on current zero-crossing values
  for (let i = 0; i < this.zeroCrossings.length; i++) {
    const zc = this.zeroCrossings[i];
    const condC = this.exprToC(zc.expression);
    // Need to unpack states to evaluate the condition
    // For simplicity, inline the unpacking
    this.emit(`md->event_flags[${i}] = (${condC}) ? 1 : 0;`);
  }
  this.emitBlank();

  // After updating flags, the residual function will automatically
  // use the new branch of any if-expressions on the next evaluation.
  // IDA will recompute consistent derivatives via IDACalcIC or
  // by simply re-evaluating the residual.

  this.indent--;
  this.emit("}");
  this.emitBlank();
}
```

### 1.12 Output function

Copies all variable values to a flat buffer that TypeScript can read:

```typescript
private emitOutput(): void {
  this.emit("void model_output(ModelData* md, realtype t, realtype* y, realtype* ydot, realtype* out) {");
  this.indent++;

  let outIdx = 0;

  // Time
  this.emit(`out[${outIdx++}] = t;`);

  // States
  for (const v of this.input.unknowns) {
    if (v.role === "state") {
      const idx = this.stateIndex.get(v.name)!;
      this.emit(`out[${outIdx++}] = y[${idx}]; /* ${v.name} */`);
    }
  }

  // Derivatives
  for (const v of this.input.unknowns) {
    if (v.role === "derivative") {
      const idx = this.stateIndex.get(v.stateOf!)!;
      this.emit(`out[${outIdx++}] = ydot[${idx}]; /* ${v.name} */`);
    }
  }

  // Algebraic
  for (const v of this.input.unknowns) {
    if (v.role === "algebraic") {
      const idx = this.algIndex.get(v.name)!;
      this.emit(`out[${outIdx++}] = md->alg[${idx}]; /* ${v.name} */`);
    }
  }

  this.indent--;
  this.emit("}");
  this.emitBlank();

  // Also emit the output size and variable name table
  this.emit(`#define NUM_OUTPUTS ${outIdx}`);
}
```

---

## Part 2: The C Runtime

The generated C code links against a static runtime library that provides the SUNDIALS integration loop and the Newton solver utilities. For the Export Strategy, this runtime is compiled together with the generated model code into a native binary (or standalone WASM module). Only the model-specific code changes per simulation; the runtime is the same for all models.

### 2.1 File layout

```
runtime/
  solver_main.c       — simulation loop, IDA setup, event handling
  newton_small.c      — inline Gauss elimination for small torn blocks
  wasm_exports.c      — functions exported to JavaScript
  sundials/            — SUNDIALS source (IDA, NVector, SUNLinSol)
```

### 2.2 The simulation driver

```c
/* solver_main.c */

#include <ida/ida.h>
#include <nvector/nvector_serial.h>
#include <sunlinsol/sunlinsol_dense.h>
#include <sunmatrix/sunmatrix_dense.h>

/* Forward declarations — these are in the generated code */
extern void model_initialize(ModelData* md, realtype* y, realtype* ydot);
extern int  model_residual(realtype t, N_Vector yy, N_Vector yp, N_Vector rr, void* user_data);
extern int  model_root(realtype t, N_Vector yy, N_Vector yp, realtype* gout, void* user_data);
extern void model_handle_event(ModelData* md, realtype t, realtype* y, realtype* ydot);
extern void model_output(ModelData* md, realtype t, realtype* y, realtype* ydot, realtype* out);

typedef struct {
    /* Simulation configuration */
    realtype t_start;
    realtype t_end;
    realtype t_output;
    realtype tolerance;

    /* Output buffer: NUM_OUTPUTS values per output point */
    realtype* output_buffer;
    int output_count;
    int output_capacity;
} SimConfig;

int run_simulation(SimConfig* config) {
    SUNContext sunctx;
    int retval = SUNContext_Create(NULL, &sunctx);
    if (retval != 0) return -1;

    /* Create vectors */
    N_Vector yy = N_VNew_Serial(NUM_STATES, sunctx);
    N_Vector yp = N_VNew_Serial(NUM_STATES, sunctx);
    N_Vector avtol = N_VNew_Serial(NUM_STATES, sunctx);

    realtype* y = N_VGetArrayPointer(yy);
    realtype* ydot = N_VGetArrayPointer(yp);

    /* Initialize model */
    ModelData md;
    model_initialize(&md, y, ydot);

    /* Create IDA solver */
    void* ida_mem = IDACreate(sunctx);
    if (ida_mem == NULL) return -2;

    /* Set tolerances */
    realtype rtol = config->tolerance;
    N_VConst(config->tolerance, avtol);
    retval = IDAInit(ida_mem, model_residual, config->t_start, yy, yp);
    if (retval != IDA_SUCCESS) return -3;

    retval = IDASVtolerances(ida_mem, rtol, avtol);
    if (retval != IDA_SUCCESS) return -4;

    /* Set user data */
    retval = IDASetUserData(ida_mem, &md);

    /* Set up linear solver (dense) */
    SUNMatrix A = SUNDenseMatrix(NUM_STATES, NUM_STATES, sunctx);
    SUNLinearSolver LS = SUNLinSol_Dense(yy, A, sunctx);
    retval = IDASetLinearSolver(ida_mem, LS, A);

    /* Set up root finding for events */
    if (NUM_EVENTS > 0) {
        retval = IDARootInit(ida_mem, NUM_EVENTS, model_root);
    }

    /* Compute consistent initial conditions */
    /* IDA_YA_YDP_INIT: compute ydot and algebraic y from differential y */
    N_Vector id = N_VNew_Serial(NUM_STATES, sunctx);
    realtype* id_data = N_VGetArrayPointer(id);
    /* All states are differential (1.0); algebraic vars would be 0.0 */
    /* For now, all entries in the IDA state vector are differential states */
    for (int i = 0; i < NUM_STATES; i++) id_data[i] = 1.0;
    IDASetId(ida_mem, id);

    realtype t_ic = config->t_start + config->t_output * 0.01;
    retval = IDACalcIC(ida_mem, IDA_YA_YDP_INIT, t_ic);
    if (retval != IDA_SUCCESS) {
        /* IC calculation failed — proceed with user-provided guesses */
    }

    /* Record initial output */
    realtype out[NUM_OUTPUTS];
    model_output(&md, config->t_start, y, ydot, out);
    record_output(config, out);

    /* Time stepping */
    realtype t_current = config->t_start;
    realtype t_next;

    while (t_current < config->t_end) {
        t_next = t_current + config->t_output;
        if (t_next > config->t_end) t_next = config->t_end;

        retval = IDASolve(ida_mem, t_next, &t_current, yy, yp, IDA_NORMAL);

        if (retval == IDA_ROOT_RETURN) {
            /* Event detected — handle it */
            model_handle_event(&md, t_current, y, ydot);

            /* Re-initialize IDA after event */
            retval = IDAReInit(ida_mem, t_current, yy, yp);

            /* Recompute consistent IC after event */
            t_ic = t_current + config->t_output * 0.01;
            IDACalcIC(ida_mem, IDA_YA_YDP_INIT, t_ic);

            /* Don't record output at event time — continue to t_next */
            continue;
        }

        if (retval == IDA_SUCCESS) {
            /* Reached t_next — record output */
            model_output(&md, t_current, y, ydot, out);
            record_output(config, out);
        } else {
            /* Solver failed */
            break;
        }
    }

    /* Cleanup */
    IDAFree(&ida_mem);
    SUNLinSolFree(LS);
    SUNMatDestroy(A);
    N_VDestroy(yy);
    N_VDestroy(yp);
    N_VDestroy(avtol);
    N_VDestroy(id);
    SUNContext_Free(&sunctx);

    return config->output_count;
}

static void record_output(SimConfig* config, realtype* out) {
    if (config->output_count >= config->output_capacity) return;
    memcpy(
        config->output_buffer + config->output_count * NUM_OUTPUTS,
        out,
        NUM_OUTPUTS * sizeof(realtype)
    );
    config->output_count++;
}
```

### 2.3 Small Newton solver utilities

```c
/* newton_small.c */

/* Gauss elimination with partial pivoting for 2x2 system */
void gauss_solve_2(realtype J[2][2], realtype dx[2]) {
    /* Partial pivoting */
    if (fabs(J[1][0]) > fabs(J[0][0])) {
        realtype tmp;
        tmp = J[0][0]; J[0][0] = J[1][0]; J[1][0] = tmp;
        tmp = J[0][1]; J[0][1] = J[1][1]; J[1][1] = tmp;
        tmp = dx[0]; dx[0] = dx[1]; dx[1] = tmp;
    }

    if (fabs(J[0][0]) < 1e-30) return; /* singular */

    realtype factor = J[1][0] / J[0][0];
    J[1][1] -= factor * J[0][1];
    dx[1] -= factor * dx[0];

    if (fabs(J[1][1]) < 1e-30) return;
    dx[1] /= J[1][1];
    dx[0] = (dx[0] - J[0][1] * dx[1]) / J[0][0];
}

/* Gauss elimination for NxN (general, for larger torn blocks) */
void gauss_solve_n(int n, realtype* J, realtype* dx) {
    /* J is stored row-major as flat array: J[i*n + j] */
    for (int k = 0; k < n; k++) {
        /* Partial pivoting */
        int max_row = k;
        realtype max_val = fabs(J[k * n + k]);
        for (int i = k + 1; i < n; i++) {
            if (fabs(J[i * n + k]) > max_val) {
                max_val = fabs(J[i * n + k]);
                max_row = i;
            }
        }
        if (max_row != k) {
            for (int j = k; j < n; j++) {
                realtype tmp = J[k * n + j];
                J[k * n + j] = J[max_row * n + j];
                J[max_row * n + j] = tmp;
            }
            realtype tmp = dx[k]; dx[k] = dx[max_row]; dx[max_row] = tmp;
        }

        if (fabs(J[k * n + k]) < 1e-30) continue;

        /* Eliminate below */
        for (int i = k + 1; i < n; i++) {
            realtype factor = J[i * n + k] / J[k * n + k];
            for (int j = k + 1; j < n; j++) {
                J[i * n + j] -= factor * J[k * n + j];
            }
            dx[i] -= factor * dx[k];
        }
    }

    /* Back substitution */
    for (int i = n - 1; i >= 0; i--) {
        for (int j = i + 1; j < n; j++) {
            dx[i] -= J[i * n + j] * dx[j];
        }
        if (fabs(J[i * n + i]) > 1e-30) {
            dx[i] /= J[i * n + i];
        }
    }
}
```

---

## Part 3: The WASM Bridge (Export Strategy)

This section describes how to compile the exported C code into a standalone WASM module — one of the two compilation targets for the Export Strategy (the other being a native binary via `gcc`/`clang`, which requires no special bridge code). The WASM bridge for the Interactive Strategy (JS callbacks in the browser) is described in Part 5.

### 3.1 Building with Emscripten

When the export target is WASM (for server-side runtimes like Node.js), the generated C code and the runtime are compiled together into a single WASM module:

```bash
emcc \
  generated_model.c \
  runtime/solver_main.c \
  runtime/newton_small.c \
  sundials/src/ida/ida.c \
  sundials/src/ida/ida_ic.c \
  sundials/src/ida/ida_io.c \
  sundials/src/ida/ida_ls.c \
  sundials/src/nvector/serial/nvector_serial.c \
  sundials/src/sunlinsol/dense/sunlinsol_dense.c \
  sundials/src/sunmatrix/dense/sunmatrix_dense.c \
  sundials/src/sundials/sundials_math.c \
  sundials/src/sundials/sundials_nvector.c \
  sundials/src/sundials/sundials_matrix.c \
  sundials/src/sundials/sundials_linearsolver.c \
  sundials/src/sundials/sundials_context.c \
  -I sundials/include \
  -O2 \
  -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_wasm_simulate","_wasm_get_output_ptr","_wasm_get_num_outputs","_wasm_get_variable_names","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","getValue","UTF8ToString"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s TOTAL_MEMORY=16777216 \
  -o model.js
```

This produces `model.js` (the Emscripten loader) and `model.wasm` (the compiled binary). The `-s ALLOW_MEMORY_GROWTH=1` flag lets the WASM module allocate more memory if the output buffer grows.

For a browser-based workflow where compilation happens at runtime (the user writes a model, Phases 1–4 run, then Phase 5 must compile C to WASM), there are two approaches:

**Approach A: Server-side Emscripten.** Send the generated C source to a backend service that runs `emcc` and returns the WASM binary. This is simpler and avoids shipping the Emscripten toolchain to the browser.

**Approach B: Pre-compiled runtime, dynamic linking.** Pre-compile the SUNDIALS runtime and solver loop into a WASM module with dynamic linking support. The generated model code (which is small — just the residual, Jacobian, and initialization functions) can be compiled separately and linked at load time. Emscripten supports this via side modules (`-s SIDE_MODULE=1`). The runtime is compiled once as the main module, and each new model produces a small side module.

**Approach C: Interpreter-based.** Instead of generating C code and compiling it, generate a bytecode representation of the residual function and interpret it in WASM. This avoids the compilation step entirely but is slower at runtime. Suitable for small models; for large models, the compilation approach is worth the overhead.

**Approach D: JS callbacks into pre-compiled WASM.** Pre-compile the SUNDIALS runtime (IDA, NVector, SUNLinSol) into a WASM module once. The model-specific functions (residual, root-finding, event handling) are generated as JavaScript closures at runtime. The WASM solver calls back into these JS functions at each time step. This eliminates the compilation step entirely — the generated JS functions are constructed immediately from the Phase 4 output. The WASM module exports a simulation driver that accepts JS function references (registered via Emscripten's `addFunction` or a function pointer table) and calls them during integration. Torn algebraic loop Newton solvers can either be generated inline in JS or call a WASM-side utility for the linear algebra. Part 5 of this document describes this approach in detail.

Approach D (JS callbacks) is implemented first — it is the Interactive Strategy used during model development in the browser. The Export Strategy (C code generation) is added later. When the user exports, any of Approaches A–C can be used depending on the deployment target: Approach A for server-side WASM compilation, Approach B for pre-compiled runtime with dynamic model linking, or direct `gcc`/`clang` compilation for native binaries.

### 3.2 WASM export functions

The C code exports a small API that TypeScript calls:

```c
/* wasm_exports.c */

#include <stdlib.h>
#include <string.h>
#include <emscripten.h>

/* Global simulation state */
static SimConfig g_config;
static int g_initialized = 0;

EMSCRIPTEN_KEEPALIVE
int wasm_simulate(
    double t_start,
    double t_end,
    double t_output,
    double tolerance,
    int max_output_points
) {
    g_config.t_start = t_start;
    g_config.t_end = t_end;
    g_config.t_output = t_output;
    g_config.tolerance = tolerance;

    /* Allocate output buffer */
    g_config.output_capacity = max_output_points;
    g_config.output_count = 0;
    g_config.output_buffer = (realtype*)malloc(
        max_output_points * NUM_OUTPUTS * sizeof(realtype)
    );
    if (!g_config.output_buffer) return -1;

    int result = run_simulation(&g_config);

    return result;
}

EMSCRIPTEN_KEEPALIVE
double* wasm_get_output_ptr(void) {
    return g_config.output_buffer;
}

EMSCRIPTEN_KEEPALIVE
int wasm_get_num_outputs(void) {
    return NUM_OUTPUTS;
}

EMSCRIPTEN_KEEPALIVE
int wasm_get_output_count(void) {
    return g_config.output_count;
}

EMSCRIPTEN_KEEPALIVE
void wasm_free_output(void) {
    if (g_config.output_buffer) {
        free(g_config.output_buffer);
        g_config.output_buffer = NULL;
    }
}
```

### 3.3 TypeScript interface

The TypeScript side loads the WASM module, calls the simulation, and reads back results:

```typescript
interface SimulationResult {
  time: Float64Array;
  variables: Map<string, Float64Array>;
}

interface VariableMapping {
  name: string;
  outputIndex: number;
}

async function runSimulation(
  wasmModule: any,     // loaded Emscripten module
  variableMap: VariableMapping[],
  startTime: number,
  stopTime: number,
  outputInterval: number,
  tolerance: number
): Promise<SimulationResult> {
  const maxPoints = Math.ceil((stopTime - startTime) / outputInterval) + 10;

  // Run simulation
  const resultCount = wasmModule._wasm_simulate(
    startTime, stopTime, outputInterval, tolerance, maxPoints
  );

  if (resultCount < 0) {
    throw new Error(`Simulation failed with code ${resultCount}`);
  }

  // Read output buffer
  const numOutputs = wasmModule._wasm_get_num_outputs();
  const outputCount = wasmModule._wasm_get_output_count();
  const outputPtr = wasmModule._wasm_get_output_ptr();

  // outputPtr is a byte offset into the WASM heap
  // Each output point is numOutputs doubles
  const heapF64 = wasmModule.HEAPF64;
  const startOffset = outputPtr / 8; // byte offset to float64 index

  // Extract time array and variable arrays
  const time = new Float64Array(outputCount);
  const variables = new Map<string, Float64Array>();

  for (const v of variableMap) {
    variables.set(v.name, new Float64Array(outputCount));
  }

  for (let i = 0; i < outputCount; i++) {
    const base = startOffset + i * numOutputs;
    time[i] = heapF64[base]; // first output is always time

    for (const v of variableMap) {
      variables.get(v.name)![i] = heapF64[base + v.outputIndex];
    }
  }

  // Free the WASM-side output buffer
  wasmModule._wasm_free_output();

  return { time, variables };
}
```

### 3.4 Loading the WASM module

```typescript
async function loadSimulationModule(wasmUrl: string): Promise<any> {
  // Emscripten generates a JS loader that exports a factory function
  // Load it dynamically
  const Module = await import(wasmUrl);

  // The factory returns a promise that resolves when WASM is ready
  const instance = await Module.default();

  return instance;
}
```

### 3.5 The variable mapping

The code generator produces a variable mapping that tells TypeScript which output index corresponds to which variable name. This is generated alongside the C code:

```typescript
function generateVariableMapping(input: CodeGenInput): VariableMapping[] {
  const mapping: VariableMapping[] = [];
  let idx = 0;

  // Index 0 is always time
  mapping.push({ name: "time", outputIndex: idx++ });

  // States
  for (const v of input.unknowns) {
    if (v.role === "state") {
      mapping.push({ name: v.name, outputIndex: idx++ });
    }
  }

  // Derivatives
  for (const v of input.unknowns) {
    if (v.role === "derivative") {
      mapping.push({ name: v.name, outputIndex: idx++ });
    }
  }

  // Algebraic
  for (const v of input.unknowns) {
    if (v.role === "algebraic") {
      mapping.push({ name: v.name, outputIndex: idx++ });
    }
  }

  return mapping;
}
```

### 3.6 Alias reconstruction

Phase 4 eliminated alias variables to shrink the system. The output only contains representative variables, not aliases. To give the user access to aliased variables, reconstruct them from the alias map:

```typescript
function reconstructAliases(
  result: SimulationResult,
  aliasMap: AliasMap,
  allOriginalVariables: string[]
): SimulationResult {
  const extended = new Map(result.variables);

  for (const name of allOriginalVariables) {
    if (extended.has(name)) continue;

    const resolved = aliasMap.resolve(name);
    if ("constant" in resolved) {
      // Variable is a constant — fill with that value
      const arr = new Float64Array(result.time.length);
      arr.fill(resolved.constant);
      extended.set(name, arr);
    } else if (resolved.name !== name) {
      // Variable is an alias — copy from representative
      const source = extended.get(resolved.name);
      if (source) {
        if (resolved.sign === 1) {
          extended.set(name, new Float64Array(source));
        } else {
          const negated = new Float64Array(source.length);
          for (let i = 0; i < source.length; i++) negated[i] = -source[i];
          extended.set(name, negated);
        }
      }
    }
  }

  return { time: result.time, variables: extended };
}
```

---

## Part 4: The Full Phase 5 Pipeline

### 4.1 End-to-end flow (Interactive Strategy — implemented first)

This is the primary simulation path, used each time the user presses "Simulate" in the browser.

```typescript
interface SimulationOptions {
  startTime: number;
  stopTime: number;
  outputInterval: number;
  tolerance: number;
}

async function simulateInteractive(
  symbolicResult: SymbolicResult,
  allOriginalVariables: string[],
  options: SimulationOptions,
  solverModule: SundialsModule  // pre-loaded at app startup, reused across simulations
): Promise<SimulationResult> {
  // Step 1: Generate JS model functions (instant — no compilation)
  const modelFunctions = generateJSModelFunctions(symbolicResult);

  // Step 2: Register JS callbacks with the WASM solver
  const sim = solverModule.createSimulation({
    numStates: modelFunctions.numStates,
    numEvents: modelFunctions.numEvents,
    residual: modelFunctions.residual,
    rootFunction: modelFunctions.rootFunction,
    handleEvent: modelFunctions.handleEvent,
    initialize: modelFunctions.initialize,
  });

  // Step 3: Run simulation
  const rawResult = sim.run(
    options.startTime,
    options.stopTime,
    options.outputInterval,
    options.tolerance
  );

  // Step 4: Reconstruct aliased variables
  const fullResult = reconstructAliases(
    rawResult,
    symbolicResult.aliasMap,
    allOriginalVariables
  );

  // Step 5: Clean up registered function pointers
  sim.dispose();

  return fullResult;
}
```

This flow has no async compilation step — `generateJSModelFunctions` returns immediately. The SUNDIALS WASM module (`solverModule`) is loaded once at application startup and reused for every simulation. Each edit-simulate cycle calls only this function.

### 4.2 End-to-end flow (Export Strategy — implemented later)

This is the export path, used when the user clicks "Export" after finalizing their model.

```typescript
interface ExportOptions extends SimulationOptions {
  format: "c-source" | "wasm" | "native";
}

async function exportStandalone(
  symbolicResult: SymbolicResult,
  options: ExportOptions,
  compileService?: (cSource: string, format: string) => Promise<Uint8Array>
): Promise<{ cSource: string; binary?: Uint8Array }> {
  // Step 1: Generate C code (the same Phase 4 output, different code generator)
  const cSource = generateC({
    ...symbolicResult,
    startTime: options.startTime,
    stopTime: options.stopTime,
    outputInterval: options.outputInterval,
    tolerance: options.tolerance,
  });

  if (options.format === "c-source") {
    // User downloads the C source files and compiles themselves
    return { cSource };
  }

  if (!compileService) {
    throw new Error("Compilation service required for WASM/native export");
  }

  // Step 2: Compile to standalone binary (server-side)
  const binary = await compileService(cSource, options.format);

  return { cSource, binary };
}
```

The exported C source is self-contained — it includes the simulation loop, SUNDIALS integration calls, and all model functions. A user can compile it with:

```bash
# Native binary (typical use case)
gcc exported_model.c sundials/*.c -O2 -lm -o model

# Or WASM for server-side runtimes (Node.js, Deno, etc.)
emcc exported_model.c sundials/*.c -O2 -o model.wasm
```

The resulting executable reads simulation parameters, runs the integration, and writes results to stdout or a file — no browser, no JS runtime, no callbacks.

### 4.3 What the user receives

The `SimulationResult` contains:

- `time`: a `Float64Array` of time points
- `variables`: a `Map` from variable names to `Float64Array` time series

For the SpringMassDamper model with `startTime = 0`, `stopTime = 10`, `outputInterval = 0.01`:

```typescript
result.time           // Float64Array of 1001 points: [0.0, 0.01, 0.02, ...]
result.variables.get("x")      // Float64Array: position over time
result.variables.get("v")      // Float64Array: velocity over time
result.variables.get("der(x)") // Float64Array: equals v (trivial)
result.variables.get("der(v)") // Float64Array: acceleration
```

For the SimpleCircuit model, the result includes all pin voltages and currents (including aliased variables reconstructed from the alias map), showing the capacitor voltage ramping from 0V toward 12V after the switch closes at `t = 0.5`.

---

## Part 5: JS Code Generation (Interactive Strategy — Approach D)

This section describes the Interactive Strategy, where the model-specific code is generated as JavaScript functions rather than C code. SUNDIALS IDA runs as pre-compiled WASM in the browser; only the model equations are in JS, called back from the WASM solver at each time step.

### 5.1 The core idea

Instead of:
1. Generate C source → 2. Compile to WASM → 3. Run

The flow becomes:
1. Generate JS closure → 2. Run

The generated JS closure is a function that computes the residual vector. It is constructed by building a function body string from the BLT-sorted blocks (exactly as the C code generator builds a C source string) and wrapping it in a closure. The WASM-compiled SUNDIALS solver calls this function at each time step via a registered callback.

### 5.2 The JS code generator

The JS code generator mirrors the C code generator but emits JavaScript expressions instead of C expressions. It produces a set of model functions as closures:

```typescript
interface JSModelFunctions {
  numStates: number;
  numAlgebraic: number;
  numEvents: number;
  numOutputs: number;
  variableNames: string[];

  // These are JS functions that the WASM solver will call back into
  initialize: (y: Float64Array, ydot: Float64Array) => void;
  residual: (t: number, y: Float64Array, ydot: Float64Array, res: Float64Array) => number;
  rootFunction: (t: number, y: Float64Array, ydot: Float64Array, gout: Float64Array) => number;
  handleEvent: (t: number, y: Float64Array, ydot: Float64Array) => void;
  output: (t: number, y: Float64Array, ydot: Float64Array, out: Float64Array) => void;
}
```

```typescript
function generateJSModelFunctions(input: CodeGenInput): JSModelFunctions {
  const gen = new JSCodeGenerator(input);
  return gen.generate();
}

class JSCodeGenerator {
  private input: CodeGenInput;

  // Same variable index maps as CCodeGenerator
  private stateIndex: Map<string, number>;
  private derivIndex: Map<string, number>;
  private algIndex: Map<string, number>;
  private paramValues: Map<string, number>;
  private zeroCrossings: ZeroCrossingInfo[];

  constructor(input: CodeGenInput) {
    this.input = input;
    this.stateIndex = new Map();
    this.derivIndex = new Map();
    this.algIndex = new Map();
    this.paramValues = new Map();
    this.zeroCrossings = [];

    this.buildVariableMaps();
    this.extractZeroCrossings();
    this.collectParameterValues();
  }

  generate(): JSModelFunctions {
    return {
      numStates: this.stateIndex.size,
      numAlgebraic: this.algIndex.size,
      numEvents: this.zeroCrossings.length,
      numOutputs: 1 + this.stateIndex.size * 2 + this.algIndex.size,
      variableNames: this.buildVariableNameList(),
      initialize: this.generateInitialize(),
      residual: this.generateResidual(),
      rootFunction: this.generateRootFunction(),
      handleEvent: this.generateHandleEvent(),
      output: this.generateOutput(),
    };
  }
}
```

### 5.3 Generating the residual function

The residual function is the performance-critical piece. It is constructed by building a function body string and wrapping it in a closure that captures the parameter values and algebraic variable scratch space.

```typescript
private generateResidual():
  (t: number, y: Float64Array, ydot: Float64Array, res: Float64Array) => number
{
  // Capture values in closure scope
  const numAlg = this.algIndex.size;
  const alg = new Float64Array(numAlg);  // scratch space for algebraic variables
  const params = this.paramValues;
  const eventFlags = new Int32Array(this.zeroCrossings.length);

  // Build the function body as a string
  const lines: string[] = [];

  // Unpack states into local variables
  for (const v of this.input.unknowns) {
    if (v.role === "state") {
      const idx = this.stateIndex.get(v.name)!;
      const jsName = this.toJSName(v.name);
      lines.push(`const ${jsName} = y[${idx}];`);
    }
  }

  // Unpack derivatives
  for (const v of this.input.unknowns) {
    if (v.role === "derivative") {
      const idx = this.stateIndex.get(v.stateOf!)!;
      const jsName = this.toJSName(v.name);
      lines.push(`const ${jsName} = ydot[${idx}];`);
    }
  }

  // Unpack parameters (from captured closure variable)
  for (const [name, value] of params) {
    const jsName = this.toJSName(name);
    lines.push(`const ${jsName} = ${value};`);
  }

  lines.push("");

  // Emit BLT blocks
  let residualIdx = 0;
  for (let blockIdx = 0; blockIdx < this.input.blocks.length; blockIdx++) {
    const block = this.input.blocks[blockIdx];

    if (block.tearingVars.length === 0) {
      // Scalar / non-torn block
      for (let i = 0; i < block.innerEqs.length; i++) {
        const eqIdx = block.innerEqs[i];
        const varIdx = block.innerVars[i];
        const variable = this.input.variableIndex.variableAt(varIdx);
        const eq = this.input.equations[eqIdx];

        if (variable.role === "derivative") {
          const lhs = this.exprToJS(eq.lhs);
          const rhs = this.exprToJS(eq.rhs);
          lines.push(`res[${residualIdx}] = (${lhs}) - (${rhs});`);
          residualIdx++;
        } else if (variable.role === "algebraic") {
          this.emitJSAlgebraicAssignment(eq, variable, lines);
        }
      }
    } else {
      // Torn block — emit inline Newton solver
      this.emitJSTornBlock(block, blockIdx, lines);
      for (const varIdx of block.tearingVars) {
        const v = this.input.variableIndex.variableAt(varIdx);
        if (v.role === "derivative") residualIdx++;
      }
    }

    lines.push("");
  }

  lines.push("return 0;");

  // Construct the function from the body string.
  // The closure captures 'alg' (scratch space) and 'eventFlags'.
  const body = lines.join("\n");
  const fn = new Function("t", "y", "ydot", "res", "alg", "eventFlags", body) as
    (t: number, y: Float64Array, ydot: Float64Array, res: Float64Array,
     alg: Float64Array, eventFlags: Int32Array) => number;

  // Return a closure that binds the captured variables
  return (t: number, y: Float64Array, ydot: Float64Array, res: Float64Array): number => {
    return fn(t, y, ydot, res, alg, eventFlags);
  };
}
```

The key technique: the function body is built as a string of JS statements (assignments, residual computations, Newton loops), then instantiated once via `new Function()`. The resulting function is called thousands of times during simulation — it is not re-created per call. V8 and other JS engines will JIT-compile it to efficient machine code after the first few invocations.

The closure captures `alg` (a `Float64Array` for algebraic variable scratch space) and `eventFlags` (the current boolean state of each event indicator). These persist across residual calls, just like the `ModelData` struct in the C approach.

#### Security note

The `new Function()` call constructs code from strings generated internally by the compiler — the string content comes from the Phase 4 symbolic output, not from user text input. The Modelica source text was parsed into an AST in Phase 1 and all subsequent phases work with structured data. No raw user strings are interpolated into the function body.

### 5.4 Expression to JS

The JS expression generator is simpler than the C version — JavaScript's math operators and `Math.*` functions map directly:

```typescript
private exprToJS(expr: FlatExpr): string {
  switch (expr.kind) {
    case "real":
      return this.formatReal(expr.value);

    case "integer":
      return `${expr.value}`;

    case "boolean":
      return expr.value ? "1" : "0";

    case "time":
      return "t";

    case "variable":
      return this.toJSName(expr.name);

    case "binary": {
      const left = this.exprToJS(expr.left);
      const right = this.exprToJS(expr.right);

      switch (expr.op) {
        case "+": case ".+": return `(${left} + ${right})`;
        case "-": case ".-": return `(${left} - ${right})`;
        case "*": case ".*": return `(${left} * ${right})`;
        case "/": case "./": return `(${left} / ${right})`;
        case "^": case ".^": return `Math.pow(${left}, ${right})`;
        case "<":  return `(${left} < ${right} ? 1 : 0)`;
        case "<=": return `(${left} <= ${right} ? 1 : 0)`;
        case ">":  return `(${left} > ${right} ? 1 : 0)`;
        case ">=": return `(${left} >= ${right} ? 1 : 0)`;
        case "==": return `(${left} === ${right} ? 1 : 0)`;
        case "<>": return `(${left} !== ${right} ? 1 : 0)`;
        case "and": return `(${left} && ${right})`;
        case "or":  return `(${left} || ${right})`;
        default: throw new Error(`Unknown op: ${expr.op}`);
      }
    }

    case "unary": {
      const operand = this.exprToJS(expr.operand);
      switch (expr.op) {
        case "-":   return `(-(${operand}))`;
        case "+":   return operand;
        case "not": return `(!(${operand}) ? 1 : 0)`;
      }
      break;
    }

    case "call": {
      const args = expr.args.map(a => this.exprToJS(a));
      switch (expr.name) {
        case "der":
          if (expr.args[0].kind === "variable") {
            return this.toJSName(`der(${expr.args[0].name})`);
          }
          throw new Error("der() with non-variable argument");
        case "abs":   return `Math.abs(${args[0]})`;
        case "sqrt":  return `Math.sqrt(${args[0]})`;
        case "sin":   return `Math.sin(${args[0]})`;
        case "cos":   return `Math.cos(${args[0]})`;
        case "tan":   return `Math.tan(${args[0]})`;
        case "asin":  return `Math.asin(${args[0]})`;
        case "acos":  return `Math.acos(${args[0]})`;
        case "atan":  return `Math.atan(${args[0]})`;
        case "atan2": return `Math.atan2(${args[0]}, ${args[1]})`;
        case "exp":   return `Math.exp(${args[0]})`;
        case "log":   return `Math.log(${args[0]})`;
        case "sign":  return `Math.sign(${args[0]})`;
        case "floor": return `Math.floor(${args[0]})`;
        case "ceil":  return `Math.ceil(${args[0]})`;
        case "min":   return `Math.min(${args[0]}, ${args[1]})`;
        case "max":   return `Math.max(${args[0]}, ${args[1]})`;
        case "mod":   return `((${args[0]}) % (${args[1]}))`;
        default: throw new Error(`Unknown function: ${expr.name}`);
      }
    }

    case "if": {
      const cond = this.exprToJS(expr.condition);
      const then_ = this.exprToJS(expr.thenExpr);
      const else_ = this.exprToJS(expr.elseExpr);
      if (expr.elseIfs.length === 0) {
        return `((${cond}) ? (${then_}) : (${else_}))`;
      }
      let result = `((${cond}) ? (${then_}) : `;
      for (const ei of expr.elseIfs) {
        result += `(${this.exprToJS(ei.condition)}) ? (${this.exprToJS(ei.value)}) : `;
      }
      result += `(${else_})` + ")".repeat(expr.elseIfs.length + 1);
      return result;
    }
  }

  throw new Error(`Unhandled expr: ${(expr as any).kind}`);
}
```

### 5.5 Name mangling for JS

JS variable names are more permissive than C, but dots and parentheses are still illegal. The mangling is the same:

```typescript
private toJSName(flatName: string): string {
  return flatName
    .replace(/\./g, "_")
    .replace(/\[/g, "_")
    .replace(/\]/g, "")
    .replace(/\(/g, "_")
    .replace(/\)/g, "")
    .replace(/,/g, "_");
}
```

### 5.6 Algebraic assignments in JS

```typescript
private emitJSAlgebraicAssignment(
  eq: FlatEquation,
  variable: ClassifiedVariable,
  lines: string[]
): void {
  const jsName = this.toJSName(variable.name);
  const algIdx = this.algIndex.get(variable.name);

  if (eq.lhs.kind === "variable" && eq.lhs.name === variable.name) {
    lines.push(`let ${jsName} = ${this.exprToJS(eq.rhs)};`);
  } else if (eq.rhs.kind === "variable" && eq.rhs.name === variable.name) {
    lines.push(`let ${jsName} = ${this.exprToJS(eq.lhs)};`);
  } else {
    // General case — placeholder
    lines.push(`let ${jsName} = 0; /* TODO: solve for ${variable.name} */`);
  }

  if (algIdx !== undefined) {
    lines.push(`alg[${algIdx}] = ${jsName};`);
  }
}
```

### 5.7 Torn block Newton solver in JS

For torn algebraic loops, the JS code generator has two options:

**Option A: Inline JS Newton solver.** Generate the Newton iteration loop directly as JS code in the function body. This keeps everything in JS and avoids WASM calls during the inner Newton loop.

**Option B: Call WASM Newton solver.** The pre-compiled WASM module exports a small Newton solver utility. The JS code evaluates the inner equations and residuals, then calls into WASM for the linear algebra (Jacobian factorization and solve). This is faster for larger torn blocks where the linear algebra dominates.

For blocks of size 1–3, Option A is simpler and equally fast. For larger blocks, Option B is preferable. The code generator chooses based on block size:

```typescript
private emitJSTornBlock(block: TornBlock, blockIdx: number, lines: string[]): void {
  const n = block.tearingVars.length;

  lines.push(`{ /* Torn block ${blockIdx}: ${n} tearing variables */`);

  // Initialize tearing variables from previous values
  for (const varIdx of block.tearingVars) {
    const v = this.input.variableIndex.variableAt(varIdx);
    const jsName = this.toJSName(v.name);
    const algIdx = this.algIndex.get(v.name);
    if (algIdx !== undefined) {
      lines.push(`  let ${jsName} = alg[${algIdx}];`);
    } else {
      lines.push(`  let ${jsName} = 0;`);
    }
  }

  lines.push(`  const tear_res = new Float64Array(${n});`);
  lines.push(`  for (let _newton = 0; _newton < 100; _newton++) {`);

  // Evaluate inner equations
  for (let i = 0; i < block.innerEqs.length; i++) {
    const eq = this.input.equations[block.innerEqs[i]];
    const v = this.input.variableIndex.variableAt(block.innerVars[i]);
    const jsName = this.toJSName(v.name);

    if (eq.lhs.kind === "variable" && eq.lhs.name === v.name) {
      lines.push(`    ${jsName} = ${this.exprToJS(eq.rhs)};`);
    } else if (eq.rhs.kind === "variable" && eq.rhs.name === v.name) {
      lines.push(`    ${jsName} = ${this.exprToJS(eq.lhs)};`);
    }

    const algIdx = this.algIndex.get(v.name);
    if (algIdx !== undefined) {
      lines.push(`    alg[${algIdx}] = ${jsName};`);
    }
  }

  // Evaluate residuals
  for (let i = 0; i < n; i++) {
    const eq = this.input.equations[block.residualEqs[i]];
    const lhs = this.exprToJS(eq.lhs);
    const rhs = this.exprToJS(eq.rhs);
    lines.push(`    tear_res[${i}] = (${lhs}) - (${rhs});`);
  }

  // Convergence check
  lines.push(`    let _norm = 0;`);
  lines.push(`    for (let _i = 0; _i < ${n}; _i++) _norm += tear_res[_i] * tear_res[_i];`);
  lines.push(`    if (_norm < 1e-12) break;`);

  // Newton update
  if (n === 1) {
    this.emitJSScalarNewtonUpdate(block, lines);
  } else {
    this.emitJSMultiDimNewtonUpdate(block, lines);
  }

  lines.push(`  }`); // end Newton loop

  // Store converged values
  for (const varIdx of block.tearingVars) {
    const v = this.input.variableIndex.variableAt(varIdx);
    const jsName = this.toJSName(v.name);
    const algIdx = this.algIndex.get(v.name);
    if (algIdx !== undefined) {
      lines.push(`  alg[${algIdx}] = ${jsName};`);
    }
  }

  lines.push(`}`);
}

private emitJSScalarNewtonUpdate(block: TornBlock, lines: string[]): void {
  const v = this.input.variableIndex.variableAt(block.tearingVars[0]);
  const jsName = this.toJSName(v.name);

  lines.push(`    const _h = Math.max(1e-8, Math.abs(${jsName}) * 1e-8);`);
  lines.push(`    ${jsName} += _h;`);

  // Re-evaluate inner equations with perturbed value
  for (let i = 0; i < block.innerEqs.length; i++) {
    const eq = this.input.equations[block.innerEqs[i]];
    const iv = this.input.variableIndex.variableAt(block.innerVars[i]);
    const ivName = this.toJSName(iv.name);
    if (eq.lhs.kind === "variable" && eq.lhs.name === iv.name) {
      lines.push(`    ${ivName} = ${this.exprToJS(eq.rhs)};`);
    } else if (eq.rhs.kind === "variable" && eq.rhs.name === iv.name) {
      lines.push(`    ${ivName} = ${this.exprToJS(eq.lhs)};`);
    }
  }

  const eq0 = this.input.equations[block.residualEqs[0]];
  const lhs = this.exprToJS(eq0.lhs);
  const rhs = this.exprToJS(eq0.rhs);
  lines.push(`    const _res_pert = (${lhs}) - (${rhs});`);
  lines.push(`    ${jsName} -= _h;`);
  lines.push(`    const _deriv = (_res_pert - tear_res[0]) / _h;`);
  lines.push(`    if (Math.abs(_deriv) > 1e-30) ${jsName} -= tear_res[0] / _deriv;`);
}

private emitJSMultiDimNewtonUpdate(block: TornBlock, lines: string[]): void {
  const n = block.tearingVars.length;

  // Build finite-difference Jacobian
  lines.push(`    const _J = new Float64Array(${n * n});`);

  for (let j = 0; j < n; j++) {
    const v = this.input.variableIndex.variableAt(block.tearingVars[j]);
    const jsName = this.toJSName(v.name);

    lines.push(`    {`);
    lines.push(`      const _h = Math.max(1e-8, Math.abs(${jsName}) * 1e-8);`);
    lines.push(`      ${jsName} += _h;`);

    // Re-evaluate inner equations
    for (let i = 0; i < block.innerEqs.length; i++) {
      const eq = this.input.equations[block.innerEqs[i]];
      const iv = this.input.variableIndex.variableAt(block.innerVars[i]);
      const ivName = this.toJSName(iv.name);
      if (eq.lhs.kind === "variable" && eq.lhs.name === iv.name) {
        lines.push(`      ${ivName} = ${this.exprToJS(eq.rhs)};`);
      } else if (eq.rhs.kind === "variable" && eq.rhs.name === iv.name) {
        lines.push(`      ${ivName} = ${this.exprToJS(eq.lhs)};`);
      }
    }

    // Compute Jacobian column
    for (let i = 0; i < n; i++) {
      const eq = this.input.equations[block.residualEqs[i]];
      const lhsJS = this.exprToJS(eq.lhs);
      const rhsJS = this.exprToJS(eq.rhs);
      lines.push(`      _J[${i * n + j}] = ((${lhsJS}) - (${rhsJS}) - tear_res[${i}]) / _h;`);
    }

    lines.push(`      ${jsName} -= _h;`);
    lines.push(`    }`);
  }

  // Solve J * dx = -res via Gaussian elimination (inline JS for small n,
  // or call WASM utility for larger n)
  lines.push(`    const _dx = new Float64Array([${Array.from({length: n}, (_, i) => `-tear_res[${i}]`).join(", ")}]);`);
  lines.push(`    _gaussSolve(${n}, _J, _dx);`);

  // Apply update
  for (let j = 0; j < n; j++) {
    const v = this.input.variableIndex.variableAt(block.tearingVars[j]);
    const jsName = this.toJSName(v.name);
    lines.push(`    ${jsName} += _dx[${j}];`);
  }
}
```

The `_gaussSolve` function referenced in the multi-dimensional Newton update is injected into the closure scope. It can be either a pure JS implementation or a wrapper that calls the WASM-side Gauss solver:

```typescript
// Pure JS Gauss elimination — injected into closure scope
function gaussSolve(n: number, J: Float64Array, dx: Float64Array): void {
  for (let k = 0; k < n; k++) {
    // Partial pivoting
    let maxRow = k;
    let maxVal = Math.abs(J[k * n + k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(J[i * n + k]);
      if (v > maxVal) { maxVal = v; maxRow = i; }
    }
    if (maxRow !== k) {
      for (let j = k; j < n; j++) {
        const tmp = J[k * n + j]; J[k * n + j] = J[maxRow * n + j]; J[maxRow * n + j] = tmp;
      }
      const tmp = dx[k]; dx[k] = dx[maxRow]; dx[maxRow] = tmp;
    }

    if (Math.abs(J[k * n + k]) < 1e-30) continue;

    for (let i = k + 1; i < n; i++) {
      const factor = J[i * n + k] / J[k * n + k];
      for (let j = k + 1; j < n; j++) J[i * n + j] -= factor * J[k * n + j];
      dx[i] -= factor * dx[k];
    }
  }

  for (let i = n - 1; i >= 0; i--) {
    for (let j = i + 1; j < n; j++) dx[i] -= J[i * n + j] * dx[j];
    if (Math.abs(J[i * n + i]) > 1e-30) dx[i] /= J[i * n + i];
  }
}
```

To make `_gaussSolve` available inside the generated function body, inject it as an additional closure parameter:

```typescript
// In generateResidual():
const fn = new Function(
  "t", "y", "ydot", "res", "alg", "eventFlags", "_gaussSolve",
  body
);

return (t, y, ydot, res) => {
  return fn(t, y, ydot, res, alg, eventFlags, gaussSolve);
};
```

### 5.8 Generating the other model functions

The initialize, root-finding, event handler, and output functions follow the same pattern — build a function body string, wrap in a closure:

```typescript
private generateInitialize(): (y: Float64Array, ydot: Float64Array) => void {
  const lines: string[] = [];

  // Set initial state values
  for (const v of this.input.unknowns) {
    if (v.role === "state") {
      const idx = this.stateIndex.get(v.name)!;
      const flatVar = this.findFlatVariable(v.name);
      const startVal = flatVar?.attributes.start
        ? this.evaluateConstant(flatVar.attributes.start)
        : 0.0;
      lines.push(`y[${idx}] = ${startVal};`);
    }
  }

  // Zero out derivatives
  lines.push(`ydot.fill(0);`);

  const body = lines.join("\n");
  const fn = new Function("y", "ydot", body) as
    (y: Float64Array, ydot: Float64Array) => void;
  return fn;
}

private generateRootFunction():
  (t: number, y: Float64Array, ydot: Float64Array, gout: Float64Array) => number
{
  if (this.zeroCrossings.length === 0) {
    return (_t, _y, _ydot, _gout) => 0;
  }

  const lines: string[] = [];

  // Unpack states (same as in residual)
  for (const v of this.input.unknowns) {
    if (v.role === "state") {
      const idx = this.stateIndex.get(v.name)!;
      lines.push(`const ${this.toJSName(v.name)} = y[${idx}];`);
    }
  }

  // Unpack parameters
  for (const [name, value] of this.paramValues) {
    lines.push(`const ${this.toJSName(name)} = ${value};`);
  }

  // Emit zero-crossing functions
  for (let i = 0; i < this.zeroCrossings.length; i++) {
    const zc = this.zeroCrossings[i];
    lines.push(`gout[${i}] = ${this.exprToJS(zc.zeroCrossingExpr)};`);
  }

  lines.push("return 0;");

  const body = lines.join("\n");
  const fn = new Function("t", "y", "ydot", "gout", body) as
    (t: number, y: Float64Array, ydot: Float64Array, gout: Float64Array) => number;
  return fn;
}

private generateOutput():
  (t: number, y: Float64Array, ydot: Float64Array, out: Float64Array) => void
{
  const alg = new Float64Array(this.algIndex.size);
  const lines: string[] = [];
  let outIdx = 0;

  lines.push(`out[${outIdx++}] = t;`);

  for (const v of this.input.unknowns) {
    if (v.role === "state") {
      const idx = this.stateIndex.get(v.name)!;
      lines.push(`out[${outIdx++}] = y[${idx}];`);
    }
  }
  for (const v of this.input.unknowns) {
    if (v.role === "derivative") {
      const idx = this.stateIndex.get(v.stateOf!)!;
      lines.push(`out[${outIdx++}] = ydot[${idx}];`);
    }
  }
  for (const v of this.input.unknowns) {
    if (v.role === "algebraic") {
      const idx = this.algIndex.get(v.name)!;
      lines.push(`out[${outIdx++}] = alg[${idx}];`);
    }
  }

  const body = lines.join("\n");
  const fn = new Function("t", "y", "ydot", "out", "alg", body) as
    (t: number, y: Float64Array, ydot: Float64Array, out: Float64Array, alg: Float64Array) => void;
  return (t, y, ydot, out) => fn(t, y, ydot, out, alg);
}
```

### 5.9 The pre-compiled SUNDIALS WASM module

The SUNDIALS IDA solver is compiled to WASM once and shipped as a static asset. It exports a C API that the TypeScript side calls to set up and run simulations. The key difference from the Export Strategy is that the residual function is not compiled into the WASM module — instead, the WASM solver calls back into JS.

#### C-side: the callback-based simulation driver

```c
/* solver_callback.c — compiled once to WASM */

#include <ida/ida.h>
#include <nvector/nvector_serial.h>
#include <sunlinsol/sunlinsol_dense.h>
#include <sunmatrix/sunmatrix_dense.h>
#include <emscripten.h>

/*
 * The residual, root, and event functions are JS callbacks.
 * Emscripten allows calling JS functions from C via function pointers
 * registered with addFunction().
 *
 * These typedefs match the IDA callback signatures but operate on
 * raw double arrays rather than N_Vector (the WASM side unpacks).
 */

/* JS callback types (registered via Emscripten addFunction) */
typedef int (*js_residual_fn)(double t, double* y, double* ydot, double* res);
typedef int (*js_root_fn)(double t, double* y, double* ydot, double* gout);
typedef void (*js_event_fn)(double t, double* y, double* ydot);
typedef void (*js_output_fn)(double t, double* y, double* ydot, double* out);
typedef void (*js_init_fn)(double* y, double* ydot);

/* Global callback pointers — set by wasm_set_callbacks */
static js_residual_fn g_residual = NULL;
static js_root_fn g_root = NULL;
static js_event_fn g_event = NULL;
static js_output_fn g_output = NULL;
static js_init_fn g_init = NULL;

static int g_num_states = 0;
static int g_num_events = 0;
static int g_num_outputs = 0;

/* IDA residual wrapper: unpacks N_Vectors and calls JS */
static int ida_residual_wrapper(
    realtype t, N_Vector yy, N_Vector yp, N_Vector rr, void* user_data
) {
    double* y = N_VGetArrayPointer(yy);
    double* ydot = N_VGetArrayPointer(yp);
    double* res = N_VGetArrayPointer(rr);
    return g_residual(t, y, ydot, res);
}

/* IDA root wrapper */
static int ida_root_wrapper(
    realtype t, N_Vector yy, N_Vector yp, realtype* gout, void* user_data
) {
    double* y = N_VGetArrayPointer(yy);
    double* ydot = N_VGetArrayPointer(yp);
    return g_root(t, y, ydot, gout);
}

EMSCRIPTEN_KEEPALIVE
void wasm_set_callbacks(
    js_residual_fn residual,
    js_root_fn root,
    js_event_fn event,
    js_output_fn output,
    js_init_fn init,
    int num_states,
    int num_events,
    int num_outputs
) {
    g_residual = residual;
    g_root = root;
    g_event = event;
    g_output = output;
    g_init = init;
    g_num_states = num_states;
    g_num_events = num_events;
    g_num_outputs = num_outputs;
}

/* Output buffer */
static double* g_output_buffer = NULL;
static int g_output_count = 0;
static int g_output_capacity = 0;

static void record_output(double t, double* y, double* ydot) {
    if (g_output_count >= g_output_capacity) return;
    double* out = g_output_buffer + g_output_count * g_num_outputs;
    g_output(t, y, ydot, out);
    g_output_count++;
}

EMSCRIPTEN_KEEPALIVE
int wasm_simulate(
    double t_start, double t_end, double t_output, double tolerance,
    int max_output_points
) {
    SUNContext sunctx;
    SUNContext_Create(NULL, &sunctx);

    N_Vector yy = N_VNew_Serial(g_num_states, sunctx);
    N_Vector yp = N_VNew_Serial(g_num_states, sunctx);

    double* y = N_VGetArrayPointer(yy);
    double* ydot = N_VGetArrayPointer(yp);

    /* Initialize via JS callback */
    g_init(y, ydot);

    /* Allocate output buffer */
    g_output_capacity = max_output_points;
    g_output_count = 0;
    g_output_buffer = (double*)malloc(max_output_points * g_num_outputs * sizeof(double));

    /* Create IDA */
    void* ida_mem = IDACreate(sunctx);
    IDAInit(ida_mem, ida_residual_wrapper, t_start, yy, yp);

    N_Vector avtol = N_VNew_Serial(g_num_states, sunctx);
    N_VConst(tolerance, avtol);
    IDASVtolerances(ida_mem, tolerance, avtol);

    /* Linear solver */
    SUNMatrix A = SUNDenseMatrix(g_num_states, g_num_states, sunctx);
    SUNLinearSolver LS = SUNLinSol_Dense(yy, A, sunctx);
    IDASetLinearSolver(ida_mem, LS, A);

    /* All variables are differential */
    N_Vector id = N_VNew_Serial(g_num_states, sunctx);
    N_VConst(1.0, id);
    IDASetId(ida_mem, id);

    /* Root finding */
    if (g_num_events > 0) {
        IDARootInit(ida_mem, g_num_events, ida_root_wrapper);
    }

    /* Consistent IC */
    double t_ic = t_start + t_output * 0.01;
    IDACalcIC(ida_mem, IDA_YA_YDP_INIT, t_ic);

    /* Record initial output */
    record_output(t_start, y, ydot);

    /* Time stepping */
    double t_current = t_start;
    int retval;

    while (t_current < t_end) {
        double t_next = t_current + t_output;
        if (t_next > t_end) t_next = t_end;

        retval = IDASolve(ida_mem, t_next, &t_current, yy, yp, IDA_NORMAL);

        if (retval == IDA_ROOT_RETURN) {
            g_event(t_current, y, ydot);
            IDAReInit(ida_mem, t_current, yy, yp);
            t_ic = t_current + t_output * 0.01;
            IDACalcIC(ida_mem, IDA_YA_YDP_INIT, t_ic);
            continue;
        }

        if (retval == IDA_SUCCESS) {
            record_output(t_current, y, ydot);
        } else {
            break;
        }
    }

    /* Cleanup */
    IDAFree(&ida_mem);
    SUNLinSolFree(LS);
    SUNMatDestroy(A);
    N_VDestroy(yy);
    N_VDestroy(yp);
    N_VDestroy(avtol);
    N_VDestroy(id);
    SUNContext_Free(&sunctx);

    return g_output_count;
}

EMSCRIPTEN_KEEPALIVE
double* wasm_get_output_ptr(void) { return g_output_buffer; }

EMSCRIPTEN_KEEPALIVE
int wasm_get_output_count(void) { return g_output_count; }

EMSCRIPTEN_KEEPALIVE
void wasm_free_output(void) {
    free(g_output_buffer);
    g_output_buffer = NULL;
}
```

This is compiled once:

```bash
emcc \
  runtime/solver_callback.c \
  runtime/newton_small.c \
  sundials/src/ida/*.c \
  sundials/src/nvector/serial/*.c \
  sundials/src/sunlinsol/dense/*.c \
  sundials/src/sunmatrix/dense/*.c \
  sundials/src/sundials/*.c \
  -I sundials/include \
  -O2 \
  -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_wasm_simulate","_wasm_set_callbacks","_wasm_get_output_ptr","_wasm_get_output_count","_wasm_free_output","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["addFunction","removeFunction","ccall","cwrap","HEAPF64"]' \
  -s ALLOW_TABLE_GROWTH=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -o sundials_solver.js
```

The `-s ALLOW_TABLE_GROWTH=1` flag is critical — it enables `addFunction()`, which lets TypeScript register JS functions as callable function pointers from C.

### 5.10 TypeScript-side: registering callbacks and running

```typescript
interface SundialsModule {
  // Emscripten module instance
  _wasm_simulate: (
    t_start: number, t_end: number, t_output: number,
    tolerance: number, max_points: number
  ) => number;
  _wasm_set_callbacks: (
    residual: number, root: number, event: number,
    output: number, init: number,
    num_states: number, num_events: number, num_outputs: number
  ) => void;
  _wasm_get_output_ptr: () => number;
  _wasm_get_output_count: () => number;
  _wasm_free_output: () => void;

  addFunction: (fn: Function, signature: string) => number;
  removeFunction: (ptr: number) => void;
  HEAPF64: Float64Array;

  createSimulation(config: {
    numStates: number;
    numEvents: number;
    residual: Function;
    rootFunction: Function;
    handleEvent: Function;
    initialize: Function;
  }): SimulationHandle;
}

interface SimulationHandle {
  run(startTime: number, stopTime: number, outputInterval: number,
      tolerance: number): SimulationResult;
  dispose(): void;
}
```

The `createSimulation` method wraps the low-level Emscripten API:

```typescript
function createSimulationHandle(
  module: SundialsModule,
  modelFns: JSModelFunctions
): SimulationHandle {
  // The JS callbacks receive raw pointers (numbers) from WASM.
  // We need wrapper functions that convert pointers to Float64Array views.

  // Residual wrapper: (t, yPtr, ydotPtr, resPtr) => int
  const residualWrapper = (t: number, yPtr: number, ydotPtr: number, resPtr: number): number => {
    const y = new Float64Array(module.HEAPF64.buffer, yPtr, modelFns.numStates);
    const ydot = new Float64Array(module.HEAPF64.buffer, ydotPtr, modelFns.numStates);
    const res = new Float64Array(module.HEAPF64.buffer, resPtr, modelFns.numStates);
    return modelFns.residual(t, y, ydot, res);
  };

  // Root wrapper
  const rootWrapper = (t: number, yPtr: number, ydotPtr: number, goutPtr: number): number => {
    const y = new Float64Array(module.HEAPF64.buffer, yPtr, modelFns.numStates);
    const ydot = new Float64Array(module.HEAPF64.buffer, ydotPtr, modelFns.numStates);
    const gout = new Float64Array(module.HEAPF64.buffer, goutPtr, modelFns.numEvents);
    return modelFns.rootFunction(t, y, ydot, gout);
  };

  // Event wrapper
  const eventWrapper = (t: number, yPtr: number, ydotPtr: number): void => {
    const y = new Float64Array(module.HEAPF64.buffer, yPtr, modelFns.numStates);
    const ydot = new Float64Array(module.HEAPF64.buffer, ydotPtr, modelFns.numStates);
    modelFns.handleEvent(t, y, ydot);
  };

  // Output wrapper
  const outputWrapper = (t: number, yPtr: number, ydotPtr: number, outPtr: number): void => {
    const y = new Float64Array(module.HEAPF64.buffer, yPtr, modelFns.numStates);
    const ydot = new Float64Array(module.HEAPF64.buffer, ydotPtr, modelFns.numStates);
    const out = new Float64Array(module.HEAPF64.buffer, outPtr, modelFns.numOutputs);
    modelFns.output(t, y, ydot, out);
  };

  // Init wrapper
  const initWrapper = (yPtr: number, ydotPtr: number): void => {
    const y = new Float64Array(module.HEAPF64.buffer, yPtr, modelFns.numStates);
    const ydot = new Float64Array(module.HEAPF64.buffer, ydotPtr, modelFns.numStates);
    modelFns.initialize(y, ydot);
  };

  // Register JS functions as WASM-callable function pointers
  // Signature strings: 'i' = int, 'd' = double, 'v' = void
  // 'idiiii' = returns int, takes (double, int, int, int) — pointers are ints in WASM
  const residualPtr = module.addFunction(residualWrapper, "idiiii");
  const rootPtr = module.addFunction(rootWrapper, "idiiii");
  const eventPtr = module.addFunction(eventWrapper, "viii");
  const outputPtr = module.addFunction(outputWrapper, "vdiiii");
  const initPtr = module.addFunction(initWrapper, "vii");

  // Pass callbacks to WASM
  module._wasm_set_callbacks(
    residualPtr, rootPtr, eventPtr, outputPtr, initPtr,
    modelFns.numStates, modelFns.numEvents, modelFns.numOutputs
  );

  return {
    run(startTime, stopTime, outputInterval, tolerance): SimulationResult {
      const maxPoints = Math.ceil((stopTime - startTime) / outputInterval) + 10;
      const count = module._wasm_simulate(
        startTime, stopTime, outputInterval, tolerance, maxPoints
      );

      if (count < 0) throw new Error(`Simulation failed: ${count}`);

      // Read results from WASM heap
      const outPtr = module._wasm_get_output_ptr();
      const numOut = modelFns.numOutputs;
      const startOffset = outPtr / 8;

      const time = new Float64Array(count);
      const variables = new Map<string, Float64Array>();
      for (const name of modelFns.variableNames) {
        variables.set(name, new Float64Array(count));
      }

      // Variable names in order: time, states, derivatives, algebraic
      for (let i = 0; i < count; i++) {
        const base = startOffset + i * numOut;
        time[i] = module.HEAPF64[base];
        let idx = 1;
        for (const name of modelFns.variableNames) {
          variables.get(name)![i] = module.HEAPF64[base + idx];
          idx++;
        }
      }

      module._wasm_free_output();
      return { time, variables };
    },

    dispose(): void {
      module.removeFunction(residualPtr);
      module.removeFunction(rootPtr);
      module.removeFunction(eventPtr);
      module.removeFunction(outputPtr);
      module.removeFunction(initPtr);
    },
  };
}
```

### 5.11 Performance considerations

The WASM-to-JS call overhead for `addFunction`-registered callbacks is roughly 50–200 nanoseconds per call in modern browsers. For a simulation with 10,000 time steps and 10 residual evaluations per step, that is ~100,000 calls × ~100ns = ~10ms of overhead — negligible compared to the model evaluation time for any non-trivial model.

The real performance question is whether the model arithmetic (the BLT block evaluation) runs fast enough in JS. V8 JIT-compiles the generated function after a few invocations, producing machine code comparable to C for simple arithmetic. For models with hundreds of equations, the JS-generated residual function performs within 2–5x of the equivalent compiled WASM, which is acceptable for interactive use.

For models with thousands of equations where this overhead matters, the Export Strategy (compile C to a native binary) should be used. The two strategies share the same Phase 4 output — switching between them is a matter of calling `generateC()` vs `generateJSModelFunctions()`.

---

## Worked Example: Generated C for SpringMassDamper

**Input:** The SpringMassDamper model after Phases 1–4. Two states (`x`, `v`), two derivatives (`der(x)`, `der(v)`), three parameters (`m`, `k`, `d`), two equations, two scalar BLT blocks, no algebraic loops, no events.

**Generated C (simplified):**

```c
#include <math.h>
#include <string.h>
#include <ida/ida.h>
#include <nvector/nvector_serial.h>
#include <sunlinsol/sunlinsol_dense.h>
#include <sunmatrix/sunmatrix_dense.h>
#include <sundials/sundials_types.h>

#define NUM_STATES 2
#define NUM_ALGEBRAIC 0
#define NUM_PARAMS 3
#define NUM_EVENTS 0
#define NUM_OUTPUTS 5

typedef struct {
    realtype params[NUM_PARAMS];
    realtype alg[1]; /* minimum size 1 to avoid zero-length array */
    int event_flags[1];
} ModelData;

void model_initialize(ModelData* md, realtype* y, realtype* ydot) {
    md->params[0] = 1.0;   /* m */
    md->params[1] = 10.0;  /* k */
    md->params[2] = 0.5;   /* d */

    y[0] = 1.0;  /* x, start = 1.0 */
    y[1] = 0.0;  /* v, start = 0.0 */

    memset(ydot, 0, NUM_STATES * sizeof(realtype));
}

int model_residual(realtype t, N_Vector yy, N_Vector yp, N_Vector rr, void* user_data) {
    ModelData* md = (ModelData*)user_data;
    realtype* y = N_VGetArrayPointer(yy);
    realtype* ydot = N_VGetArrayPointer(yp);
    realtype* res = N_VGetArrayPointer(rr);

    realtype x = y[0];
    realtype v = y[1];

    realtype der_x = ydot[0];
    realtype der_v = ydot[1];

    realtype m = md->params[0];
    realtype k = md->params[1];
    realtype d = md->params[2];

    /* Block 0: E0 -> der(x) */
    res[0] = v - der_x;

    /* Block 1: E1 -> der(v) */
    res[1] = (m * der_v) - (-(k * x) - (d * v));

    return 0;
}

int model_root(realtype t, N_Vector yy, N_Vector yp, realtype* gout, void* user_data) {
    /* No events */
    return 0;
}

void model_handle_event(ModelData* md, realtype t, realtype* y, realtype* ydot) {
    /* No events */
}

void model_output(ModelData* md, realtype t, realtype* y, realtype* ydot, realtype* out) {
    out[0] = t;
    out[1] = y[0];   /* x */
    out[2] = y[1];   /* v */
    out[3] = ydot[0]; /* der(x) */
    out[4] = ydot[1]; /* der(v) */
}
```

This is 70 lines of C — readable, debuggable, and directly connected to the model equations. The BLT structure is visible: Block 0 and Block 1 are independent scalar residuals. The simulation loop in `solver_main.c` calls IDA with this residual function and produces the damped oscillation trajectories.

---

## Worked Example: Generated JS for SpringMassDamper

**Same input as above.** The JS code generator produces a residual closure. Here is the generated function body (the string passed to `new Function()`):

```javascript
// Unpack states
const x = y[0];
const v = y[1];

// Unpack derivatives
const der_x = ydot[0];
const der_v = ydot[1];

// Parameters (inlined as constants)
const m = 1;
const k = 10;
const d = 0.5;

// Block 0: E0 -> der(x)
res[0] = v - der_x;

// Block 1: E1 -> der(v)
res[1] = (m * der_v) - (-(k * x) - (d * v));

return 0;
```

This is wrapped in a closure:

```typescript
const alg = new Float64Array(0);   // no algebraic variables
const eventFlags = new Int32Array(0); // no events

const residualBody = `
const x = y[0];
const v = y[1];
const der_x = ydot[0];
const der_v = ydot[1];
const m = 1;
const k = 10;
const d = 0.5;
res[0] = v - der_x;
res[1] = (m * der_v) - (-(k * x) - (d * v));
return 0;
`;

const residualInner = new Function("t", "y", "ydot", "res", "alg", "eventFlags", residualBody);
const residual = (t, y, ydot, res) => residualInner(t, y, ydot, res, alg, eventFlags);
```

The generated code is nearly identical to the C version — the same BLT structure, the same equations, the same variable unpacking. The difference is that it runs as JIT-compiled JavaScript called back from the WASM-compiled IDA solver, rather than as statically compiled WASM.

For this 2-state system, the JS residual function body is 10 lines. For the SimpleCircuit (17 equations after alias elimination), it would be roughly 40 lines. The function construction is instant — no compilation latency.

---

## Testing

**C code generation tests (unit).** Generate C code for the SpringMassDamper and verify it compiles without errors. Check that the variable indices are consistent between the initialization, residual, and output functions. Check that the name mangling produces valid C identifiers for all flat names including array indices and `der()`.

**JS code generation tests (unit).** Generate JS model functions for the SpringMassDamper. Call the residual function directly (without the WASM solver) with known `y`, `ydot` arrays and verify it returns correct residuals. This can be tested entirely in Node.js or the browser without WASM.

**Residual correctness tests (both strategies).** For the SpringMassDamper, call the residual function with known `y`, `ydot` values and verify the residuals are correct:
- At `t = 0`, `y = [1.0, 0.0]`, `ydot = [0.0, -10.0]`: residuals should be `[0.0 - 0.0, 1.0*(-10.0) - (-10.0*1.0 - 0.5*0.0)]` = `[0.0, 0.0]` (consistent).
- At `t = 0`, `y = [1.0, 0.0]`, `ydot = [0.0, 0.0]`: residual[1] should be nonzero (inconsistent).
- Run the same test for the JS-generated residual function and the C-generated residual function; results must match.

**Event detection tests.** Generate code for the SimpleCircuit (both C and JS) and verify that one zero-crossing function is produced for the `time >= 0.5` condition. Verify the event handler updates the event flag.

**End-to-end tests (Export Strategy).** Compile the SpringMassDamper C code to a native binary (or WASM), run for 10 seconds, and verify the trajectory:
- `x(0) = 1.0`, `v(0) = 0.0`
- The solution is a damped oscillation with frequency `sqrt(k/m - (d/(2m))^2) = sqrt(10 - 0.0625) ≈ 3.15 rad/s`
- `x(t)` should decay toward 0 with envelope `exp(-d*t/(2m)) = exp(-0.25t)`
- Check a few sample points against a known-good numerical solution

**End-to-end tests (Interactive Strategy).** Run the same SpringMassDamper simulation using the JS callback approach with the pre-compiled SUNDIALS WASM module. Verify the trajectory matches Export Strategy results to solver tolerance. This confirms the WASM↔JS callback mechanism is working correctly.

**Cross-strategy comparison.** For a set of test models, run both strategies and verify that the results are identical (to solver tolerance). Any discrepancy indicates a bug in one of the code generators.

**Torn block tests.** Create a model with an algebraic loop. Generate code using both strategies. Verify the Newton solver converges in both cases. Check that the inner equations are evaluated in the correct order and that the residual equations are satisfied after convergence.

**Callback overhead test.** For a medium-sized model (50–100 equations), run the Interactive Strategy and measure the wall-clock time. Compare with the Export Strategy if available. Verify that the JS callback overhead is under 10% of total simulation time for this model size.

**WASM bridge tests.** Verify that the TypeScript-side result extraction correctly reads the WASM heap, that variable mappings are consistent, and that alias reconstruction produces correct values for aliased variables. Test that `dispose()` properly deregisters function pointers (no memory leak across successive simulations).
