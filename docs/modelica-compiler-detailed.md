# Modelica Compiler: Detailed Technical Overview

A Modelica compiler is not merely a syntactic parser. It transforms hierarchical, object-oriented model descriptions into a simulatable system of algebraic-differential equations (DAEs). This requires extensive mathematical symbolic preprocessing. The transformation occurs in five phases:

1. Syntactic Parsing
2. Flattening
3. Equation Processing
4. Symbolic Preprocessing
5. Code Generation and Numerical Solving

This document describes each phase in full detail.

---

## Phase 1: Syntactic Parsing

Syntactic parsing converts raw Modelica source text into a structured in-memory representation called an **Abstract Syntax Tree (AST)**. At this stage, only **structure** matters, not **meaning**.

### 1.1 What syntactic parsing does

Given Modelica text like:

```modelica
model SpringMassDamper
  Real x(start = 1.0);
  Real v(start = 0.0);
  parameter Real m = 1.0;
  parameter Real k = 10.0;
  parameter Real d = 0.5;
equation
  v = der(x);
  m * der(v) = -k * x - d * v;
end SpringMassDamper;
```

The parser answers: "Is this syntactically valid Modelica, and what are its structural components?" It produces a tree that says:

- This is a **model** named `SpringMassDamper`
- It has **variable declarations**: `x` (with a modification `start = 1.0`), `v` (with a modification `start = 0.0`), `m`, `k`, `d`
- Some are marked with the `parameter` prefix
- There is an **equation section** containing two equations
- The first equation has a `der()` call on the right side
- The second equation is a force balance: mass times acceleration (`m * der(v)`) equals the sum of spring and damping forces (`-k * x - d * v`)

### 1.2 What syntactic parsing does NOT do

This is a critical distinction. At this stage, the parser does **not**:

- Know that `der(x)` means "the time derivative of x" in any mathematical sense
- Know that `x` and `v` are state variables
- Know that this represents a spring-mass-damper system
- Check that the number of equations matches the number of unknowns
- Distinguish between parameters (known constants) and unknowns (to be solved)
- Do anything with the equations mathematically

It treats `der` the same way it treats any other function call. It treats `m * der(v) = -k * x - d * v` as an expression tree with no understanding that this is Newton's second law (force balance with inertia).

### 1.3 Sub-stage 1: Lexing (tokenization)

Converts a stream of characters into tokens:

```
"model"              -> TOKEN_MODEL
"SpringMassDamper"   -> TOKEN_IDENTIFIER("SpringMassDamper")
"Real"               -> TOKEN_IDENTIFIER("Real")
"x"                  -> TOKEN_IDENTIFIER("x")
"("                  -> TOKEN_LPAREN
"start"              -> TOKEN_IDENTIFIER("start")
"="                  -> TOKEN_EQUALS
"1.0"                -> TOKEN_REAL(1.0)
")"                  -> TOKEN_RPAREN
";"                  -> TOKEN_SEMICOLON
...
```

The lexer handles: whitespace, comments, string literals, numeric literals, and reserved keywords (`model`, `equation`, `end`, `parameter`, `if`, `for`, `connect`, etc.).

The lexer is typically implemented as a state machine or a simple character-by-character scanner. Several Modelica-specific details deserve attention:

- **Keywords vs identifiers:** The lexer first matches the general identifier pattern (a letter followed by letters, digits, or underscores). It then checks a keyword table: if the matched text is `model`, `equation`, `parameter`, etc., the token becomes a keyword token; otherwise it remains an identifier. Crucially, `Real`, `Integer`, `Boolean`, and `String` are **not keywords** — they are ordinary identifiers that happen to name built-in types. They are resolved during later semantic analysis, not during lexing. This means the lexer produces `TOKEN_IDENTIFIER("Real")`, not a special `TOKEN_REAL_TYPE`.

- **Nested comments:** Unlike C and Java, Modelica supports nested block comments: `/* outer /* inner */ still in outer */`. The lexer must maintain a nesting depth counter and only end the comment when the counter returns to zero, rather than simply scanning for the first `*/`.

- **Quoted identifiers:** Modelica allows identifiers to be enclosed in single quotes: `'my.unusual" variable name'`. Inside quotes, nearly any character is legal, including spaces, dots, and double quotes. The lexer must recognize the opening single quote and switch to a different scanning mode until the closing single quote. This is important because Modelica Standard Library components sometimes use quoted identifiers for names that contain special characters.

- **Numeric literals:** The lexer must distinguish integers (`42`), reals (`3.14`), and reals with exponents (`1.5e-3`). Edge cases include `1.` (a real, not an integer followed by a dot) and the interaction with the range operator `1:10` (integer, colon, integer — not a real number).

### 1.4 Sub-stage 2: Parsing (syntax analysis)

Takes the token stream and builds a tree according to Modelica's grammar rules. The grammar defines valid structures. For example, a simplified grammar rule might say:

```
class_definition :=
    "model" IDENTIFIER
        { element ";" }
    "equation"
        { equation ";" }
    "end" IDENTIFIER ";"
```

This is written in **EBNF (Extended Backus-Naur Form)** notation, a standard way of describing language grammars. The key symbols are:

- `{ ... }` means **zero or more** repetitions (not literal curly braces in the source)
- `[ ... ]` means **zero or one** (optional)
- `" "` means a **literal keyword or token**
- `|` means **alternatives** (or)

So `{ element ";" }` means "zero or more occurrences of an element followed by a semicolon" — expressing that a model can have any number of variable declarations. Similarly, `{ equation ";" }` means the equation section can contain any number of equations.

If the tokens don't match any valid grammar rule, you get a **syntax error**. If they do match, you get an AST node.

#### Parser implementation

The standard approach for a Modelica parser is **recursive descent** — a hand-written parser where each grammar rule becomes a function. For example, `parseClassDefinition()` would consume the `model` keyword, an identifier, a sequence of elements, an optional `equation` section, and the closing `end` plus identifier. Each subrule (elements, equations, expressions) is itself a function that calls further subrules.

Recursive descent works well for Modelica because the grammar is mostly **LL(1)** — at any point, you can determine which grammar rule to apply by looking at the current token (one token of lookahead). When the parser sees `parameter`, it knows a parameter declaration follows. When it sees `equation`, it knows the declaration section is over and the equation section begins.

The main exception is **expression parsing**, where operator precedence and associativity must be handled correctly. The expression `a + b * c ^ d` must parse as `a + (b * (c ^ d))`, respecting that `^` binds tighter than `*`, which binds tighter than `+`. This is typically handled with a **Pratt parser** (also called precedence climbing), which assigns a binding power to each operator and uses it to decide when to stop collecting operands. Modelica has roughly 10 precedence levels, including arithmetic operators, comparison operators (`<`, `>`, `==`, `<>`), logical operators (`and`, `or`, `not`), and the `if-then-else` expression form.

**Modifications** are a parsing challenge specific to Modelica. The modification syntax `(start = 1.0, fixed = true)` after a variable declaration can nest arbitrarily deep — a modification can contain class modifications, which can contain element modifications, which can contain expressions with their own nested function calls and parentheses. The parser must handle this recursion correctly, distinguishing modification parentheses from expression parentheses based on context.

An alternative to hand-written recursive descent is using a **parser generator** like ANTLR, which generates a parser from a grammar specification. The Modelica specification includes a formal grammar in an appendix that is close to usable as input for such tools, though it typically requires some adaptation to handle ambiguities and edge cases.

### 1.5 Modelica-specific syntax features

Compared to languages like C++ or Java, Modelica's grammar has distinctive features the parser must handle:

- **Equation sections** vs **algorithm sections** — A model body can contain `equation` sections (declarative, order-independent mathematical relationships) and `algorithm` sections (imperative, sequential assignments like in conventional programming). The parser must distinguish them because they have different syntax: equations use `=` between two expressions, while algorithms use `:=` for assignment. A single model can contain multiple alternating sections.

- **Modifications** — The `(start = 1.0)` syntax on declarations is called a modification. Modifications can nest deeply: `Resistor R1(p(v(start = 0)))` modifies the start value of the voltage on pin `p` of resistor `R1`. The parser must handle this recursive structure, which does not exist in most other languages. Modifications can appear on variable declarations, `extends` clauses, and inside `redeclare` statements.

- **Annotations** — Structurally complex metadata attached to models, variables, and equations. Annotations use the same modification syntax as declarations but can be very large (hundreds of key-value pairs for graphical layout, documentation, and tool-specific hints). The parser must parse them structurally, but the compiler mostly ignores their content — annotations are consumed by GUI tools for diagram rendering and documentation generation.

- **Connect equations** — `connect(port_a, port_b)` looks syntactically like a function call but has completely different semantics. The parser produces a distinct AST node for connect statements (not a function call node), because later phases process them according to connection semantics rather than function call semantics.

- **Class prefixes** — `model`, `block`, `connector`, `record`, `package`, `function`, and `type` are all variants of class definition. They share the same basic grammar structure but differ in what they allow inside them. For example, a `connector` can contain variable declarations but not equation sections. A `function` has algorithm sections but not equation sections. A `package` contains other class definitions but not equations. The parser can use a single grammar rule for all class forms and defer the restriction checking to a later semantic validation phase.

- **Inheritance and redeclaration** — `extends Base(modifications)` brings in all declarations and equations from a base class. `redeclare` allows a subclass to replace a component or type from the parent. These create parsing complexity because `extends` can appear mixed with regular declarations, and `redeclare` modifies the meaning of an inherited element — though the parser only needs to capture the syntax, not resolve the semantics.

- **For-equations** — `for i in 1:N loop ... end for` inside equation sections. These generate multiple equations from a template. The parser produces a loop AST node containing the iterator variable, the range expression, and the body equations. The loop is not unrolled during parsing — that happens during flattening, after the range bounds are known.

- **If-equations** — `if condition then ... elseif ... else ... end if` inside equation sections. These are conditional equations, not control flow statements. Every branch must provide the same number of equations for the same variables, because the equation count must be deterministic. The parser captures the structure; the branch consistency check happens during flattening or equation processing.

### 1.6 Output: the AST

The AST is a tree of nodes. Conceptually for the SpringMassDamper example:

```
ModelDefinition("SpringMassDamper")
├── VariableDeclaration(type="Real", name="x")
│   └── Modification("start", Literal(1.0))
├── VariableDeclaration(type="Real", name="v")
│   └── Modification("start", Literal(0.0))
├── VariableDeclaration(prefix="parameter", type="Real", name="m")
│   └── Modification("=", Literal(1.0))
├── VariableDeclaration(prefix="parameter", type="Real", name="k")
│   └── Modification("=", Literal(10.0))
├── VariableDeclaration(prefix="parameter", type="Real", name="d")
│   └── Modification("=", Literal(0.5))
└── EquationSection
    ├── Equation(lhs=Ref("v"), rhs=Call("der", Ref("x")))
    └── Equation(lhs=BinaryOp("*", Ref("m"), Call("der", Ref("v"))),
                 rhs=BinaryOp("-",
                     BinaryOp("*", Ref("k"), Ref("x")),
                     BinaryOp("*", Ref("d"), Ref("v"))))
```

This tree is purely structural. It is a faithful representation of **what was written**, not what it **means**. The meaning comes in the later phases.

---

## Phase 2: Flattening

Flattening is where Modelica diverges sharply from conventional language compilation. In a language like Java, after parsing you move to type checking and code generation. In Modelica, you must take the object-oriented, hierarchical model description and collapse it into a **single flat list of variables and equations** — because that is what a DAE solver needs.

### 2.1 Why flattening is necessary

Modelica is designed for modular modeling. You build complex systems by composing smaller models:

```modelica
connector Pin
  Real v;
  flow Real i;
end Pin;

model Battery
  Pin p, n;
  parameter Real V = 12.0;
equation
  p.v - n.v = V;
  p.i + n.i = 0;
end Battery;

model Switch
  Pin p, n;
  parameter Real Ron = 1e-5;
  parameter Real Roff = 1e5;
  Boolean closed;
equation
  closed = time >= 0.5;
  p.v - n.v = (if closed then Ron else Roff) * p.i;
  p.i + n.i = 0;
end Switch;

model Resistor
  Pin p, n;
  parameter Real R = 1.0;
equation
  p.v - n.v = R * p.i;
  p.i + n.i = 0;
end Resistor;

model Capacitor
  Pin p, n;
  parameter Real C = 1e-3;
equation
  C * der(p.v - n.v) = p.i;
  p.i + n.i = 0;
end Capacitor;

model SimpleCircuit
  Battery B(V = 12.0);
  Switch S;
  Resistor R1(R = 100.0);
  Capacitor C1(C = 1e-6);
equation
  connect(B.p, S.p);
  connect(S.n, R1.p);
  connect(R1.n, C1.p);
  connect(C1.n, B.n);
end SimpleCircuit;
```

This is hierarchical. `SimpleCircuit` contains four component instances that are themselves models with their own variables and equations. The solver cannot work with this hierarchy — it needs a flat system. Flattening produces that.

Note two things about this circuit. First, it is physically complete — a battery drives current through a switch, resistor, and capacitor in a series loop. Second, the `Switch` model introduces a **conditional expression** (`if closed then Ron else Roff`) and a **time-dependent Boolean** (`closed = time >= 0.5`). These will become important in later phases when we discuss event detection and handling.

### 2.2 Component instantiation

Every component declaration creates an instance. `R1` is an instance of `Resistor`, which itself contains instances `p` and `n` of type `Pin`. Similarly, `B` is an instance of `Battery` and `S` is an instance of `Switch`. The flattener walks this hierarchy and creates fully qualified variable names:

```
B.p.v       (Real)
B.p.i       (Real, flow)
B.n.v       (Real)
B.n.i       (Real, flow)
B.V         (parameter Real, value = 12.0)
S.p.v       (Real)
S.p.i       (Real, flow)
S.n.v       (Real)
S.n.i       (Real, flow)
S.Ron       (parameter Real, value = 1e-5)
S.Roff      (parameter Real, value = 1e5)
S.closed    (Boolean)
R1.p.v      (Real)
R1.p.i      (Real, flow)
R1.n.v      (Real)
R1.n.i      (Real, flow)
R1.R        (parameter Real, value = 100.0)
C1.p.v      (Real)
C1.p.i      (Real, flow)
C1.n.v      (Real)
C1.n.i      (Real, flow)
C1.C        (parameter Real, value = 1e-6)
```

Every variable in the entire model tree gets a unique flat name. Notice that `S.closed` is a Boolean — the flattener does not care about its type beyond recording it. Also notice the difference between parameters (known values like `B.V`, `S.Ron`, `R1.R`) and unknowns (like `B.p.v`, `S.closed`) — both get flat names, but parameters will be removed from the unknown set later.

### 2.3 Equation collection

Each model contributes its equations, with variable references prefixed by the instance path:

From `Battery B`:
```
B.p.v - B.n.v = B.V
B.p.i + B.n.i = 0
```

From `Switch S`:
```
S.closed = time >= 0.5
S.p.v - S.n.v = (if S.closed then S.Ron else S.Roff) * S.p.i
S.p.i + S.n.i = 0
```

From `Resistor R1`:
```
R1.p.v - R1.n.v = R1.R * R1.p.i
R1.p.i + R1.n.i = 0
```

From `Capacitor C1`:
```
C1.C * der(C1.p.v - C1.n.v) = C1.p.i
C1.p.i + C1.n.i = 0
```

The switch contributes three equations — one for the Boolean `closed`, one for the voltage-current relationship (which depends on the switch state), and the flow conservation equation. The `if` expression is preserved as-is at this stage; the flattener does not evaluate it or reason about events.

### 2.4 Connect equation resolution

This is one of the most important and subtle parts of flattening. `connect` statements are not function calls — they are declarative assertions about physical connections. The flattener must process them according to Modelica's connection semantics.

`connect(B.p, S.p)` means the connectors `B.p` and `S.p` are physically joined. The rules are:

- **Across variables** (non-flow, like voltage): set equal

  ```
  B.p.v = S.p.v
  ```

- **Flow variables** (like current): sum to zero at the connection point

  ```
  B.p.i + S.p.i = 0
  ```

The remaining three connections follow the same rules:

`connect(S.n, R1.p)`:
```
S.n.v = R1.p.v
S.n.i + R1.p.i = 0
```

`connect(R1.n, C1.p)`:
```
R1.n.v = C1.p.v
R1.n.i + C1.p.i = 0
```

`connect(C1.n, B.n)`:
```
C1.n.v = B.n.v
C1.n.i + B.n.i = 0
```

The four connections form a series loop: battery positive terminal to switch input, switch output to resistor, resistor to capacitor, capacitor back to battery negative terminal.

#### Connection sets: the general algorithm

The SimpleCircuit example has only pairwise connections — each `connect` joins exactly two connectors. But in general, multiple connectors can be connected to the same node. Consider a T-junction where three resistors meet:

```modelica
  connect(R1.n, R2.p);
  connect(R2.p, R3.p);
```

Here `R1.n`, `R2.p`, and `R3.p` are all connected to the same electrical node. The flattener cannot process each `connect` statement in isolation — it must first collect all connectors that are transitively connected into a **connection set**, then generate equations for the entire set at once.

The algorithm is:

1. **Build connection sets.** Start with each connector in its own set. For each `connect(a, b)` statement, merge the sets containing `a` and `b`. This is a classic **union-find** (disjoint set) problem. After processing all connect statements, each connection set contains all connectors that are directly or transitively connected.

2. **Generate equations for each connection set.** For a set containing connectors `{c1, c2, ..., cn}`:
   - For each **across variable** (non-flow): set all equal to each other. This produces `n - 1` equations: `c1.v = c2.v`, `c2.v = c3.v`, etc.
   - For each **flow variable**: sum all flows to zero. This produces 1 equation: `c1.i + c2.i + ... + cn.i = 0`.

For the T-junction example, the connection set is `{R1.n, R2.p, R3.p}`, producing:

```
R1.n.v = R2.p.v
R2.p.v = R3.p.v
R1.n.i + R2.p.i + R3.p.i = 0
```

The across-variable equations chain the voltages pairwise (any spanning tree of equalities works). The flow equation sums all currents at the node to zero — this is Kirchhoff's current law, emerging automatically from the connection semantics.

For the SimpleCircuit series loop, each connection set contains exactly two connectors, so the rules produce the pairwise equations shown above. The general algorithm handles arbitrary topologies correctly.

### 2.5 Inheritance resolution

If a model uses `extends`, the flattener merges in the parent's variables and equations:

```modelica
model TwoPin
  Pin p, n;
  Real v;
  Real i;
equation
  v = p.v - n.v;
  i = p.i;
  p.i + n.i = 0;
end TwoPin;

model Resistor2
  extends TwoPin;
  parameter Real R = 1.0;
equation
  v = R * i;
end Resistor2;
```

The flattener treats `Resistor2` as if all of `TwoPin`'s declarations and equations were written directly inside it. The result is equivalent to:

```modelica
model Resistor2
  Pin p, n;
  Real v;
  Real i;
  parameter Real R = 1.0;
equation
  v = p.v - n.v;
  i = p.i;
  p.i + n.i = 0;
  v = R * i;
end Resistor2;
```

#### Multiple inheritance

Modelica supports multiple `extends` clauses in the same class:

```modelica
model HeatedResistor
  extends TwoPin;
  extends HeatTransfer;
  parameter Real R = 1.0;
equation
  v = R * i;
  heatPort.Q_flow = R * i^2;
end HeatedResistor;
```

The flattener merges declarations and equations from both parent classes. If both parents declare a component with the same name, the declarations must be compatible (same type, compatible modifications) — otherwise it is an error. Modelica does not have the "diamond problem" of C++ because there is no virtual dispatch; inheritance is purely structural merging of declarations and equations.

#### Redeclare

The `redeclare` keyword allows a derived class or instance to **replace** an inherited component or type with a different one:

```modelica
model GenericCircuit
  replaceable model ResistorModel = Resistor;
  ResistorModel R1;
end GenericCircuit;

model SpecificCircuit
  extends GenericCircuit(redeclare model ResistorModel = HeatedResistor);
end SpecificCircuit;
```

Here `SpecificCircuit` inherits from `GenericCircuit` but replaces the `ResistorModel` type with `HeatedResistor`. The flattener must resolve the redeclaration before instantiating `R1` — it needs to know that `R1` is a `HeatedResistor`, not a plain `Resistor`, so it can create the correct set of variables and equations.

Redeclare interacts with `constrainedby` clauses, which limit what a replaceable component can be replaced with:

```modelica
  replaceable model ResistorModel = Resistor constrainedby TwoPin;
```

This means `ResistorModel` can be redeclared to any model that is a subtype of `TwoPin`. The flattener must verify that the replacement satisfies this constraint. This is one of the few places where Modelica requires subtype checking.

### 2.6 Modification application

When `SimpleCircuit` declares `Resistor R1(R = 100.0)`, the `R = 100.0` is a modification that overrides the default `R = 1.0` in the `Resistor` class. Modifications can be deeply nested:

```modelica
model System
  SubModel s(subComponent(param = 5.0));
end System;
```

Here the modification reaches two levels deep: inside the instance `s`, find the sub-component `subComponent`, and set its parameter `param` to 5.0.

The flattener must trace through the hierarchy and apply each modification at the correct level. The algorithm works top-down:

1. Start at the top-level model. For each component declaration, collect the modifications specified at the declaration site.
2. Look up the class of the component being instantiated. The class itself may have default values (e.g., `parameter Real R = 1.0`).
3. **Merge** the outer modification with the inner default. Outer modifications take precedence — they override inner defaults. This is how `R = 100.0` in `SimpleCircuit` overrides `R = 1.0` in `Resistor`.
4. Recurse into sub-components, carrying along any nested modifications that apply to deeper levels.

The merge step is where subtlety arises. Consider:

```modelica
model Inner
  parameter Real a = 1.0;
  parameter Real b = 2.0;
end Inner;

model Middle
  Inner x(a = 10.0);
end Middle;

model Outer
  Middle m(x(b = 20.0));
end Outer;
```

When flattening `Outer`, the component `m.x` has `a = 10.0` from `Middle`'s declaration and `b = 20.0` from `Outer`'s modification. Neither overrides the other — they modify different parameters. The flattener must merge them to get `m.x(a = 10.0, b = 20.0)`.

But if `Outer` instead said `m(x(a = 30.0))`, then the outer modification `a = 30.0` would override the inner modification `a = 10.0` from `Middle`. The rule is: **the outermost modifier wins**, where "outermost" means closest to the point of instantiation in the model hierarchy.

Modifications also interact with inheritance. When a class uses `extends Base(param = 5.0)`, the modification on the extends clause is applied during the merge of the base class into the derived class, following the same precedence rules.

### 2.7 Conditional components and for-loop expansion

#### Conditional components

A component declaration can include an `if` condition that determines whether the component exists at all:

```modelica
model OptionalHeating
  parameter Boolean useHeatPort = false;
  HeatPort heatPort if useHeatPort;
equation
  if useHeatPort then
    heatPort.Q_flow = dissipatedPower;
  end if;
end OptionalHeating;
```

If `useHeatPort` is `false`, the `heatPort` component does not exist — it is not instantiated, it has no variables, and any equations referencing it are removed. The flattener must evaluate the condition (which must be a parameter expression, known at compile time) and either include or exclude the component and its associated equations.

This is different from the `Switch` model's `if` expression, which is a runtime conditional inside an equation. Conditional components are resolved during flattening and eliminated before equation processing ever sees the system. Runtime conditionals (like `if closed then Ron else Roff`) are preserved through flattening and handled later by event detection.

#### Array components and for-loop expansion

```modelica
model Chain
  parameter Integer N = 5;
  Resistor r[N];
equation
  for i in 1:N-1 loop
    connect(r[i].n, r[i+1].p);
  end for;
end Chain;
```

The flattener must evaluate `N` (which must be a parameter expression), expand the array `r` into individual instances `r[1]`, `r[2]`, ... `r[5]`, each with its own full set of variables (`r[1].p.v`, `r[1].p.i`, `r[1].n.v`, etc.), then unroll the for-loop into concrete connect statements:

```
connect(r[1].n, r[2].p)
connect(r[2].n, r[3].p)
connect(r[3].n, r[4].p)
connect(r[4].n, r[5].p)
```

Each of these connect statements is then processed by the connection resolution algorithm described in section 2.4. The resulting flat system for `Chain` with `N = 5` has 5 resistors × 5 variables each = 25 component variables, 5 × 2 = 10 component equations, and 4 × 2 = 8 connection equations.

For-loops can also appear outside of connect statements, generating families of regular equations:

```modelica
equation
  for i in 1:N loop
    r[i].p.v = V_supply;
  end for;
```

This unrolls into N separate equations. The flattener must handle arbitrarily nested for-loops and for-loops over multiple iterators (`for i in 1:N, j in 1:M loop`).

### 2.8 Output: the flat system

After flattening `SimpleCircuit`, you have:

**Variables:**
```
B.p.v, B.p.i, B.n.v, B.n.i             (unknowns)
S.p.v, S.p.i, S.n.v, S.n.i, S.closed   (unknowns)
R1.p.v, R1.p.i, R1.n.v, R1.n.i         (unknowns)
C1.p.v, C1.p.i, C1.n.v, C1.n.i         (unknowns)
B.V = 12.0                              (known parameter)
S.Ron = 1e-5, S.Roff = 1e5              (known parameters)
R1.R = 100.0                            (known parameter)
C1.C = 1e-6                             (known parameter)
```

**Equations:**
```
B.p.v - B.n.v = B.V                                          (from Battery)
B.p.i + B.n.i = 0                                            (from Battery)
S.closed = time >= 0.5                                        (from Switch)
S.p.v - S.n.v = (if S.closed then S.Ron else S.Roff) * S.p.i (from Switch)
S.p.i + S.n.i = 0                                            (from Switch)
R1.p.v - R1.n.v = R1.R * R1.p.i                              (from Resistor)
R1.p.i + R1.n.i = 0                                          (from Resistor)
C1.C * der(C1.p.v - C1.n.v) = C1.p.i                         (from Capacitor)
C1.p.i + C1.n.i = 0                                          (from Capacitor)
B.p.v = S.p.v                                                (connect, across)
B.p.i + S.p.i = 0                                            (connect, flow)
S.n.v = R1.p.v                                               (connect, across)
S.n.i + R1.p.i = 0                                           (connect, flow)
R1.n.v = C1.p.v                                              (connect, across)
R1.n.i + C1.p.i = 0                                          (connect, flow)
C1.n.v = B.n.v                                               (connect, across)
C1.n.i + B.n.i = 0                                           (connect, flow)
```

17 unknown variables, 17 equations. This is now a flat DAE system — no hierarchy, no classes, no connect statements, no inheritance. Just variables and equations. Notice that the system is considerably larger than the four component models might suggest — the connection equations alone account for nearly half the total. Also notice that the conditional expression in the switch equation and the Boolean variable `S.closed` are carried through unchanged. The flattener's job is structural expansion, not mathematical analysis.

### 2.9 What flattening does NOT do

- Does not determine which variables are states, algebraic, or derivatives
- Does not reduce the index of the DAE system
- Does not sort or partition the equations
- Does not simplify or optimize anything mathematically
- Does not check for structural singularity

The flat system is the **input** to the equation processing phase. It is the bridge between the object-oriented modeling world and the mathematical world.

---

## Phase 3: Equation Processing

Equation processing takes the flat list of variables and equations from the flattener and begins to analyze it as a **mathematical system**. The goal is to understand the structure of the DAE system before applying heavy symbolic algorithms.

### 3.1 Starting point

From flattening, you have a bag of equations and a bag of variables. Nothing is sorted. Nothing is classified. You just know: here are N equations and M variables.

The first question is fundamental: **what kind of system is this?**

### 3.2 Variable classification

Not all variables play the same role. Equation processing must categorize every variable.

**Parameters** and **constants** are already identified from the flattening stage and are not unknowns. Remove them from consideration. Though both are "known values," they are distinct in Modelica:

- A **`parameter`** is fixed for a given simulation run but can be changed between runs. For example, `parameter Real R = 100.0` — you might simulate with `R = 100` and then again with `R = 200`. Parameters are set at initialization time and never change during integration.
- A **`constant`** is truly fixed and can never change, across any simulation. For example, `constant Real pi = 3.14159265`. Constants can always be folded into expressions at compile time.

This distinction matters because parameters may need to remain as named values in the generated code (to allow reconfiguration without recompilation), while constants can be unconditionally inlined.

After removing parameters and constants, what remains are the unknowns, which fall into several categories.

Consider the SpringMassDamper flat equation set:

```
E1:  v = der(x)
E2:  m * der(v) = -k * x - d * v
```

With parameters `m`, `k`, `d` already known, the unknowns are `x`, `v`, `der(x)`, and `der(v)`. They play different roles:

- `x` appears inside `der()`, so it is a **state variable** (also called a differential variable)
- `v` also appears inside `der()`, so it is also a **state variable**
- `der(x)` is the **derivative** of `x` — it is also an unknown, often written as x_dot or dx/dt
- `der(v)` is the **derivative** of `v` — also an unknown

In this system there are no algebraic variables — all unknowns are either states or derivatives. In more complex models, **algebraic variables** also arise — these are unknowns that appear in equations but never inside `der()`. For example, if the model included an external force:

```
E1:  v = der(x)
E2:  m * der(v) = -k * x - d * v + F
E3:  F = sin(time)
```

Here `F` is an algebraic variable. It must be solved at each time step but is not integrated.

This classification matters because the numerical solver treats states and algebraic variables fundamentally differently. States are integrated over time. Algebraic variables are solved at each time step.

### 3.3 Incidence analysis

The equation-variable relationships are stored in an **incidence matrix** (or equivalently, a bipartite graph). For a system with equations E1..En and unknowns U1..Um:

For the SpringMassDamper, the equations are:

```
E1:  v = der(x)
E2:  m * der(v) = -k * x - d * v
```

With parameters `m`, `k`, `d` removed, the incidence matrix over the unknowns is:

```
        x    v    der(x)    der(v)
E1:     0    1    1         0
E2:     1    1    0         1
```

A 1 means the variable appears in that equation. This matrix is the foundation of almost everything that follows — matching, sorting, partitioning, and index reduction all operate on it.

#### Building the incidence matrix from expression trees

The incidence matrix is constructed by walking each equation's expression tree and collecting the variables that appear. For each equation, the algorithm is a recursive traversal:

- **Literal node** (e.g., `1.0`, `true`): contributes no variables.
- **Variable reference** (e.g., `x`, `R1.p.v`): look up the variable. If it is a parameter or constant, ignore it (it is known). If it is an unknown, add it to this equation's incidence set.
- **`der()` call**: the argument is a variable reference. Add the derivative variable (e.g., `der(x)`) to the incidence set. Also note that the argument variable is a state variable (it appears inside `der()`).
- **Binary operator** (e.g., `a + b`, `a * b`): recurse into both operands.
- **Function call** (e.g., `sin(x)`): recurse into each argument.
- **If-expression** (e.g., `if c then a else b`): recurse into the condition and both branches. All variables from all branches are included in the incidence — even the branch not currently active — because structural analysis must account for all possibilities.

For the SpringMassDamper equation `m * der(v) = -k * x - d * v`, the walk proceeds:

1. LHS: `m * der(v)` → `m` is a parameter (skip), `der(v)` adds `der(v)` to the set and marks `v` as a state.
2. RHS: `-k * x - d * v` → `k` is a parameter (skip), `x` is an unknown (add), `d` is a parameter (skip), `v` is an unknown (add).
3. Incidence set for this equation: `{x, v, der(v)}`.

The result is typically stored as a sparse data structure (list of variable indices per equation, or adjacency lists for the bipartite graph) rather than a dense matrix, since real models can have thousands of equations and variables but each equation typically involves only a handful of variables.

### 3.4 Equation-variable matching

This is a core structural analysis step. You need to determine: **which equation should be used to solve for which variable?**

Think of it as a bipartite graph problem. On one side are equations, on the other are unknowns. An edge connects an equation to a variable if that variable appears in that equation.

For the spring-mass-damper:

```
E1:  v = der(x)                    -> involves v, der(x)
E2:  m * der(v) = -k * x - d * v   -> involves x, v, der(v)
```

Unknowns: `x`, `v`, `der(x)`, `der(v)`. Four unknowns and two equations seems wrong. It is expected. The "missing" equations are implicit: the solver will integrate `der(x)` to get `x`, and integrate `der(v)` to get `v`. The solver framework provides the relationship between each state and its derivative. What you actually need to match are equations to derivatives. The solver handles state-derivative pairs internally.

Both `x` and `v` are state variables (both appear inside `der()`). The integrator maintains their values. So the unknowns to solve for at each time step are `der(x)` and `der(v)`.

A valid matching:

```
E1 -> solves for der(x)
E2 -> solves for der(v)
(Solver) -> integrates der(x) to advance x, integrates der(v) to advance v
```

**How E1 solves for der(x):** Equation 1 is `v = der(x)`. At any given time step, `v` is known (the integrator maintains it as a state). This equation rearranges trivially to: `der(x) = v`. One equation in one unknown.

**How E2 solves for der(v):** Equation 2 is `m * der(v) = -k * x - d * v`. At any given time step, `m`, `k`, `d` are known parameters, and `x` and `v` are known states maintained by the integrator. This equation rearranges to: `der(v) = (-k * x - d * v) / m`. One equation in one unknown.

**The evaluation order is therefore:**
1. Solve E1 for `der(x)` — since `v` is known from the integrator, this gives `der(x) = v`
2. Solve E2 for `der(v)` — since `x` and `v` are known from the integrator, this gives `der(v) = (-k * x - d * v) / m`
3. The integrator takes `der(x)` and `der(v)` and advances `x` and `v` to the next time step

Note that in this system, E1 and E2 are actually independent — neither depends on the output of the other, since both only require states (which the integrator provides). They could be evaluated in either order, or even in parallel.

**The key principle:** an equation can "solve for" a variable only if, at the point of evaluation, every other unknown in that equation has already been determined. The BLT sorting ensures this ordering exists.

For larger systems, this matching is found using algorithms on bipartite graphs, most commonly the **Hopcroft-Karp** algorithm or **Hungarian algorithm** for maximum matching. If no perfect matching exists, the system is **structurally singular** — it cannot be solved, and you report an error.

### 3.5 BLT decomposition (causality and sorting)

Once you have a matching, you need to determine the **order** in which to evaluate the equations. Some equations can be solved independently. Others form interdependent systems that must be solved simultaneously.

**Sequential case:**

```
E1:  a = f(time)
E2:  b = g(a)
E3:  c = h(a, b)
E4:  d = p(c)
```

With matching E1->a, E2->b, E3->c, E4->d, there is a clear sequential order: solve E1 first, then E2, then E3, then E4. Each equation, once its predecessors are solved, becomes a single equation in one unknown.

**Algebraic loop case:**

```
E1:  a = f(time)
E2:  b = g(a, c)
E3:  c = h(b)
```

Here E2 needs `c` (from E3) and E3 needs `b` (from E2). They form an **algebraic loop** — a coupled subsystem that must be solved simultaneously, typically with an iterative nonlinear solver like Newton's method.

**BLT (Block Lower Triangular) decomposition** is the algorithm that identifies this structure. It takes the matched equation system and produces an ordered sequence of **blocks**:

```
Block 1: { E1 -> a }          (scalar, sequential)
Block 2: { E2 -> b, E3 -> c }  (coupled, algebraic loop)
```

BLT decomposition uses **Tarjan's algorithm** for finding strongly connected components in the directed graph of equation dependencies. Each strongly connected component becomes a block. The blocks are then topologically sorted.

#### How the directed graph is built

Start with the matching: each equation Ei is matched to a variable Uj (meaning "Ei solves for Uj"). Now build a directed graph where the nodes are equation-variable pairs (Ei, Uj), and there is an edge from (Ei, Uj) to (Ek, Ul) whenever equation Ei uses variable Ul — that is, Ei depends on a variable that is solved by a different equation Ek. In other words: "Ei needs the result of Ek before it can be evaluated."

#### Worked example

Consider a four-equation system with matching:

```
E1 -> a:   a = sin(time)
E2 -> b:   b = 2 * a + c
E3 -> c:   c = b + 1
E4 -> d:   d = a + c
```

The dependency edges are:
- E2 uses `a` (solved by E1) and `c` (solved by E3) → edges E2→E1, E2→E3
- E3 uses `b` (solved by E2) → edge E3→E2
- E4 uses `a` (solved by E1) and `c` (solved by E3) → edges E4→E1, E4→E3
- E1 uses only `time` (not solved by any equation) → no outgoing edges

Tarjan's algorithm does a depth-first search on this graph and identifies **strongly connected components** (SCCs) — maximal sets of nodes where every node is reachable from every other node. Here:

- E1 has no outgoing edges to other SCCs → it is its own SCC: `{E1}`
- E2→E3 and E3→E2 form a cycle → they are one SCC: `{E2, E3}`
- E4 depends on E1 and E3 but nothing depends on E4 → it is its own SCC: `{E4}`

The topological sort of the SCCs gives the evaluation order:

```
Block 1: { E1 -> a }           (scalar — compute a = sin(time))
Block 2: { E2 -> b, E3 -> c }  (coupled — algebraic loop, solve simultaneously)
Block 3: { E4 -> d }           (scalar — compute d = a + c)
```

This is the BLT form. Block 1 must be evaluated first because blocks 2 and 3 depend on `a`. Block 2 must be evaluated before block 3 because block 3 depends on `c`. Within block 2, `b` and `c` are mutually dependent and must be solved by an iterative method.

This is crucial for efficiency. A system of 10,000 equations might decompose into 9,950 scalar blocks (trivially solvable one at a time) and a few small coupled blocks. This is far cheaper than solving a 10,000x10,000 nonlinear system.

### 3.6 DAE index detection

The **differentiation index** of a DAE system is a precise measure of how far the system is from being an ordinary differential equation (ODE). It determines which numerical methods will work and what symbolic transformations are needed.

#### Formal definition

Consider a DAE system written as:

```
F(t, y, y') = 0
```

where `y` is the full vector of unknowns (states and algebraic variables) and `y'` is its time derivative. The **differentiation index** ν is the minimum number of times the system must be differentiated with respect to time so that from the augmented system {F, dF/dt, d²F/dt², ..., d^νF/dt^ν}, the complete derivative vector `y'` can be expressed as a continuous function of `(t, y)`.

In other words: after ν differentiations, the augmented system can be algebraically reduced to an ODE `y' = φ(t, y)`.

The key word is **complete** — every component of `y'` must be determined, including the derivatives of algebraic variables.

#### Index classifications

- **Index 0:** The system `F(t, y, y') = 0` can already be solved for `y'` directly — it is an ODE. Zero differentiations needed.

- **Index 1:** The system has algebraic variables whose values can be determined directly from the original equations (without differentiation), but one differentiation is needed to determine the *derivatives* of those algebraic variables. Example: `y1' = f(y1, y2)`, `0 = g(y1, y2)` where `∂g/∂y2 ≠ 0`. Here `y2` can be solved from `g` directly, and `y1' = f(y1, y2)` is immediate. But `y2'` requires differentiating the constraint `g`: `g_y1 * y1' + g_y2 * y2' = 0`, giving `y2' = -(g_y2)^(-1) * g_y1 * y1'`. One differentiation → index 1.

- **Index 2:** One differentiation of the constraint is needed before the algebraic variable can be determined, plus one more for its derivative. Arises in some controlled systems and simplified mechanical models.

- **Index 3:** Two differentiations of the constraint are needed before the algebraic variable can be determined, plus one more for its derivative. Constrained mechanical systems (like the pendulum) naturally produce index-3 DAEs. This is the most common high-index case in Modelica models.

#### Worked example: the pendulum

The pendulum system in first-order form:

```
E1:  der(x) = vx
E2:  der(y) = vy
E3:  m * der(vx) = -lambda * x
E4:  m * der(vy) = -lambda * y - m*g
E5:  x^2 + y^2 = L^2
```

The full unknown vector is `y = (x, y, vx, vy, lambda)`. Of these, `x`, `y`, `vx`, `vy` are state variables (they appear inside `der()`) and `lambda` is algebraic (it never appears inside `der()` — it is the tension force in the pendulum rod, a Lagrange multiplier). We need to determine the complete `y' = (der(x), der(y), der(vx), der(vy), der(lambda))` as a function of `(t, y)`.

**Starting point (0 differentiations).** From the equations as written:

- From E1: `der(x) = vx` — determined. ✓
- From E2: `der(y) = vy` — determined. ✓
- From E3: `der(vx) = -lambda * x / m` — but `lambda` is unknown. ✗
- From E4: `der(vy) = -lambda * y / m - g` — but `lambda` is unknown. ✗
- From E5: `x² + y² = L²` — a constraint on positions, tells us nothing about `lambda`.
- `der(lambda)` — unknown, and no equation mentions it.

Three components of `y'` remain undetermined: `der(vx)`, `der(vy)`, and `der(lambda)`. The bottleneck is `lambda` — it cannot be solved from any equation in the original system.

**First differentiation.** Differentiate E5 with respect to time:

```
E5':  2*x*der(x) + 2*y*der(y) = 0
```

Substituting E1 and E2: `x*vx + y*vy = 0`. This is a **hidden velocity constraint** — it restricts the relationship between positions and velocities. It does not involve `lambda`. We still cannot determine `lambda`, `der(vx)`, `der(vy)`, or `der(lambda)`.

**Second differentiation.** Differentiate E5' with respect to time:

```
E5'':  2*der(x)² + 2*x*der(der(x)) + 2*der(y)² + 2*y*der(der(y)) = 0
```

Since `der(der(x)) = der(vx)` and `der(der(y)) = der(vy)`, substitute E3 and E4:

```
vx² + x*(-lambda*x/m) + vy² + y*(-lambda*y/m - g) = 0
(vx² + vy²) - lambda*(x² + y²)/m - y*g = 0
(vx² + vy²) - lambda*L²/m - y*g = 0
```

**Now `lambda` is determined:**

```
lambda = m * (vx² + vy² - y*g) / L²
```

With `lambda` known, `der(vx)` and `der(vy)` follow immediately from E3 and E4. But `der(lambda)` is still unknown — we have an expression for `lambda` as a function of `y`, but not for its time derivative.

**Third differentiation.** Differentiate the expression for `lambda`:

```
der(lambda) = m * (2*vx*der(vx) + 2*vy*der(vy) - vy*g) / L²
```

All quantities on the right — `vx`, `vy`, `der(vx)`, `der(vy)` — are now known. So `der(lambda)` is determined. ✓

**After 3 differentiations,** all five components of `y'` are expressible as functions of `(t, y)`. The differentiation index is **3**.

#### Why the count is 3, not 2

It is natural to think the index should be 2: only two differentiations of the constraint are needed to reach the second derivatives `der(vx)` and `der(vy)`, and to determine `lambda`. But the formal definition requires the **complete** derivative vector `y'`, including `der(lambda)`. Since `lambda` is part of the unknown vector `y`, its derivative `der(lambda)` must also be determined. Computing `der(lambda)` requires differentiating the expression for `lambda`, which amounts to a third differentiation of the original constraint.

The cascade of hidden constraints provides an intuitive picture:

| Level | Constraint | What it determines |
|---|---|---|
| 0 (original) | x² + y² = L² | Restricts positions |
| 1 (1st derivative) | x·vx + y·vy = 0 | Restricts velocities |
| 2 (2nd derivative) | (vx² + vy²) − lambda·L²/m − y·g = 0 | Determines lambda |
| 3 (3rd derivative) | (expression involving der(lambda)) | Determines der(lambda) |

Each differentiation reveals a constraint that was hidden in the original formulation. Three levels of differentiation = index 3.

#### Practical note: structural vs formal index

The **Pantelides algorithm** (described in Phase 4) works at a structural level. For the pendulum, it needs only **2 iterations** — two differentiations of the constraint — to achieve a complete equation-variable matching. It does not need the third differentiation because `der(lambda)` is not a variable that appears in the structural matching; the numerical solver handles the algebraic variable's derivative implicitly through its BDF discretization.

So the formal differentiation index is 3, but the number of structural index reduction steps (Pantelides iterations) is 2. Both numbers are correct — they measure different things. For a Modelica compiler, the Pantelides iteration count is the operationally relevant number, but understanding the formal index explains why the unreduced system causes numerical problems.

#### Why high-index DAEs are problematic

Standard numerical solvers (like BDF methods used in IDA) work by discretizing derivatives: they approximate `der(x)` at the current time step using values of `x` from previous time steps. For an index-1 system, this discretization produces a well-conditioned algebraic system at each step.

For a high-index system, the problem is fundamentally different. The constraint `x² + y² = L²` must be satisfied exactly at every time step, but the solver does not "know" about this constraint in a structural sense — it only sees residuals to drive to zero. Small numerical errors in satisfying the constraint accumulate over time, causing **drift**: the pendulum mass gradually moves off the circle. The solver can force the residual to be small at each step, but the underlying constraint violation grows.

More precisely, for an index-3 system, the numerical error in the constraint grows as `O(h^(k-2))` where `h` is the step size and `k` is the order of the BDF method. For the pendulum, this means the position constraint drifts linearly with time regardless of step size — fundamentally unacceptable for long simulations.

Index reduction eliminates this problem by replacing the original constraint with its differentiated forms, which are structurally compatible with the solver's discretization. The original constraint is then maintained as an invariant that is exactly satisfied by correct initial conditions and preserved (up to solver tolerance) by the reduced system.

#### Structural detection

At this stage, equation processing **detects** that the index may be high but does not yet fix it. The detection is structural: during the matching phase, if an equation cannot be matched because it contains only variables that are already determined by integration (as with the pendulum's position constraint), this signals a high-index problem. Fixing it — index reduction — belongs to the symbolic preprocessing phase.

### 3.7 Output

At the end of this phase you have:

1. **Classified variables** — states, derivatives, algebraic, parameters, constants
2. **Incidence matrix** — which variables appear in which equations
3. **Equation-variable matching** — which equation solves for which unknown
4. **BLT decomposition** — ordered blocks, with algebraic loops identified
5. **Index assessment** — whether the system is high-index and needs reduction

This is a fully analyzed structural picture of the DAE system. It tells you the shape of the problem. But the equations are still in their original symbolic form, and high-index problems have not been resolved yet.

---

## Phase 4: Symbolic Preprocessing

This is the mathematically heaviest phase. The equation processing phase gave you a structural picture of the DAE system — classified variables, incidence matrix, matching, BLT decomposition, and an index assessment. Symbolic preprocessing now **transforms** the system into one that a numerical solver can actually handle efficiently.

### 4.1 Index Reduction — The Central Problem

This is the primary reason symbolic preprocessing exists. As discussed, physical models naturally produce high-index DAEs, and numerical solvers need index-0 or index-1 systems.

The core idea of index reduction is: **differentiate constraint equations** to introduce derivatives that allow the system to be solved. But you cannot just blindly differentiate — you need to know *which* equations to differentiate and *how many times*. This is what the **Pantelides algorithm** determines.

### 4.2 The Pantelides Algorithm

**Worked example — the pendulum:**

The system (using second-order derivatives written as two first-order equations):

```
E1:  der(x) = vx
E2:  der(y) = vy
E3:  m * der(vx) = -lambda * x
E4:  m * der(vy) = -lambda * y - m*g
E5:  x^2 + y^2 = L^2
```

Variables: `x`, `y`, `vx`, `vy`, `lambda`, and derivatives `der(x)`, `der(y)`, `der(vx)`, `der(vy)`.

States are `x`, `y`, `vx`, `vy` (they appear inside `der()`). The integrator handles the state-derivative relationships. So the unknowns to be solved at each time step are: `der(x)`, `der(y)`, `der(vx)`, `der(vy)`, and `lambda`.

That is 5 unknowns and 5 equations. The dimensions match. But try to find a valid matching.

E5 is `x^2 + y^2 = L^2`. At any time step, `x` and `y` are known from the integrator. This equation contains **no unknowns** — it is a constraint that is either satisfied or violated. There is nothing to solve for. It cannot be matched.

This is the structural signature of a high-index system: the matching algorithm fails because a constraint equation contains only variables that are already determined by integration.

**Pantelides works iteratively:**

**Iteration 1:** Attempt matching. E5 cannot be matched — it contains no unknowns. So differentiate E5:

```
E5':  2*x*der(x) + 2*y*der(y) = 0
```

This new equation involves `der(x)` and `der(y)`, which are unknowns. Add E5' to the system. But you have added an equation without adding a variable — the system is now over-determined (6 equations, 5 unknowns).

The resolution: one of the states that was being integrated must be **demoted**. Since E5 constrains the relationship between `x` and `y`, one of them (say `x`) is no longer treated as a free state integrated by the solver. Instead, `x` itself becomes an algebraic unknown, and `der(x)` was already an unknown. The system now has 6 unknowns and 6 equations.

**Iteration 2:** Attempt matching again. Does it work now? Let us trace through. E5' involves `der(x)` and `der(y)`. These also appear in E1 and E2. We might successfully match, but it turns out we still have a problem — `lambda` only appears in E3 and E4, and after tracing through the matching, we find another equation that cannot be matched. We need to differentiate again.

Differentiate E5':

```
E5'':  2*der(x)^2 + 2*x*der(der(x)) + 2*der(y)^2 + 2*y*der(der(y)) = 0
```

This introduces `der(der(x))` and `der(der(y))`, which are `der(vx)` and `der(vy)`. Another state gets demoted. Now the matching succeeds.

**The Pantelides algorithm in summary:**

1. Try to find a complete matching on the equation-variable bipartite graph
2. If an equation cannot be matched, differentiate it
3. Add the differentiated equation, promote the new derivative variables to unknowns, demote a state
4. Repeat until matching succeeds

The algorithm always terminates for structurally valid systems.

### 4.3 The Dummy Derivative Method

There is a subtlety in the index reduction above. When we demoted `x` from a state to an algebraic variable, we made a choice. We could have demoted `y` instead. In some systems, the correct choice depends on the current values of the variables — it can change during simulation.

#### The problem with static choice

Consider the pendulum again. During index reduction, we needed to demote one of `x` or `y` from a state to an algebraic variable. If we permanently choose to demote `x`, we are saying "compute `x` algebraically from the constraint, and integrate `y`." This works well when the pendulum is swinging mostly vertically — `y` is changing smoothly, and `x` can be computed from `x = sqrt(L^2 - y^2)`.

But when the pendulum is near the horizontal position (`y ≈ 0`), the derivative `dx/dy` becomes very large — `x` is changing rapidly while `y` is nearly stationary. At this point, we should be integrating `x` and computing `y` from the constraint. If we stick with the original choice, the numerical solver will struggle with poorly conditioned equations and may fail entirely.

#### The dummy derivative method

The **dummy derivative method** (by Mattsson and Söderlind) handles this. Instead of permanently choosing which state to demote, it treats the choice as a **runtime decision** based on numerical pivoting.

The mechanism works as follows:

1. **During compilation:** identify all state variables that are candidates for demotion at each index reduction step. For the pendulum, both `x` and `y` are candidates at the first reduction step. Mark all of them as **potential dummy derivatives** — their derivatives may or may not actually be integrated at any given time.

2. **In the generated code:** at each time step, the solver must choose which candidates to keep as true states and which to treat as algebraic. This choice is made by examining the **Jacobian** of the constraint equations with respect to the candidate states. The candidate whose constraint equation has the largest partial derivative (best numerical conditioning) is demoted — its derivative becomes the "dummy" that is computed algebraically rather than integrated.

3. **When the choice changes:** if the pivoting selects a different variable to demote than the previous step, a **state swap** occurs. The variable that was algebraic becomes a state (the solver must start integrating it), and the variable that was a state becomes algebraic. The solver must handle this transition smoothly, typically by reinitializing the integrator for the newly promoted state.

For the pendulum: near the vertical, `y` is the better state and `der(x)` is the dummy. Near the horizontal, `x` is the better state and `der(y)` is the dummy. The dummy derivative method switches between these automatically.

This adds significant implementation complexity — the generated code must include the pivoting logic, and the solver interface must support dynamic state swapping. A simpler first implementation can use a static choice (which works for many practical models) and add dynamic pivoting later.

### 4.4 Symbolic Differentiation

Index reduction requires differentiating equations symbolically. This means you need a symbolic math engine that operates on your expression trees.

Given an expression tree for `x^2 + y^2 = L^2`, you need to produce the expression tree for its total time derivative. The rules are the standard calculus chain rule applied structurally:

```
d/dt(x^2)     = 2*x * der(x)
d/dt(y^2)     = 2*y * der(y)
d/dt(L^2)     = 0              (L is a parameter)
d/dt(f + g)   = d/dt(f) + d/dt(g)
d/dt(f * g)   = f * d/dt(g) + g * d/dt(f)
d/dt(sin(f))  = cos(f) * d/dt(f)
```

This operates on the AST expression nodes. The output is a new expression tree. The differentiation engine is a straightforward recursive tree transformation — each node type has a rule. The complete rule set for Modelica includes:

**Arithmetic:**
```
d/dt(c)         = 0                              (c is a constant or parameter)
d/dt(x)         = der(x)                         (x is a time-varying variable)
d/dt(f + g)     = d/dt(f) + d/dt(g)
d/dt(f - g)     = d/dt(f) - d/dt(g)
d/dt(f * g)     = f * d/dt(g) + g * d/dt(f)      (product rule)
d/dt(f / g)     = (g * d/dt(f) - f * d/dt(g)) / g^2   (quotient rule)
d/dt(f ^ n)     = n * f^(n-1) * d/dt(f)          (power rule, n constant)
d/dt(-f)        = -d/dt(f)
```

**Built-in functions:**
```
d/dt(sin(f))    = cos(f) * d/dt(f)
d/dt(cos(f))    = -sin(f) * d/dt(f)
d/dt(exp(f))    = exp(f) * d/dt(f)
d/dt(log(f))    = d/dt(f) / f
d/dt(sqrt(f))   = d/dt(f) / (2 * sqrt(f))
d/dt(abs(f))    = sign(f) * d/dt(f)
d/dt(tan(f))    = d/dt(f) / cos(f)^2
```

**Higher-order derivatives:**
```
d/dt(der(x))    = der(der(x))
```

This last rule is important for index reduction — when differentiating an equation that already contains `der(x)`, the result contains `der(der(x))`, which is a second derivative. For a system originally written in terms of first-order derivatives (as Modelica models typically are), this introduces new variables. The Pantelides algorithm handles this by recognizing that `der(der(x)) = der(vx)` when the model has `der(x) = vx`.

**Conditional expressions:** The derivative of `if c then a else b` is `if c then d/dt(a) else d/dt(b)` — the condition `c` is not differentiated because it is a Boolean (not a continuous function). This is valid as long as `a` and `b` are continuous and equal at the switching point — a requirement that the modeler must ensure and that the event handling mechanism enforces.

The expressions it produces can be large and redundant, which leads to the next concern.

### 4.5 Symbolic Simplification

After differentiation (and other transformations), expressions can be bloated:

```
2*x*der(x) + 2*y*der(y) + 0 + 0*x + 0*y
```

Simplification cleans this up:

```
2*x*der(x) + 2*y*der(y)
```

This is not just cosmetic. Unsimplified expressions produce slower generated code and can cause numerical issues. Typical simplification rules:

- `0 + a -> a`
- `0 * a -> 0`
- `1 * a -> a`
- `a - a -> 0`
- Constant folding: `2 * 3 -> 6`
- Common subexpression identification

The simplifier is implemented as a **bottom-up tree rewrite**: after building an expression tree node, apply simplification rules before returning it. This way, when you construct `Add(Literal(0), x)`, the constructor immediately returns `x` instead of creating a node. This keeps the tree clean as it is built, rather than requiring a separate simplification pass.

A more aggressive approach is **hash-consing** (also called common subexpression elimination at the tree level): maintain a global table of expression nodes, and when constructing a new node, first check if an identical node already exists. If so, reuse it. This turns the expression representation into a **DAG** (directed acyclic graph) rather than a tree, which can significantly reduce memory usage and enables O(1) equality checks between expressions.

You do not need a full computer algebra system. A modest rule-based simplifier operating on the expression tree is sufficient for most Modelica compilation. The key is to apply the rules consistently so that later phases (incidence analysis, code generation) work with clean, minimal expressions.

### 4.6 Alias Elimination

Flattening often produces many trivial equality equations from connections. Consider the SimpleCircuit example, which has four across-variable equations from its connections:

```
B.p.v = S.p.v
S.n.v = R1.p.v
R1.n.v = C1.p.v
C1.n.v = B.n.v
```

None of these need to be "solved" — each just says two variables are the same thing. **Alias elimination** identifies these trivial equalities, picks one variable as the representative, and substitutes it everywhere. The equation is removed and the alias variable is eliminated.

This can cascade. The connection structure of the SimpleCircuit forms a series loop, so the four across-variable aliases reduce the 16 pin voltage variables down to just the voltages at the four distinct circuit nodes. Similarly, the flow conservation equations from connections are simple sum-to-zero constraints that, combined with the `p.i + n.i = 0` equations from each component, may allow further elimination.

More generally, **negated aliases** like `a = -b` and **constant aliases** like `a = 0` or `a = 3.7` are also eliminated.

In large models, alias elimination can remove a substantial fraction of the variables and equations — sometimes 30-50%. This is a significant reduction before the expensive structural algorithms run. For the SimpleCircuit, the 17-variable flat system shrinks considerably once aliases are resolved.

### 4.7 Tearing

After BLT decomposition identifies algebraic loops (coupled blocks of equations), those blocks must be solved by an iterative numerical solver at runtime. The cost of the iterative solver depends heavily on the size of the system it is given.

**Tearing** reduces the effective size of algebraic loops. The idea: within a coupled block, choose a small subset of variables as **tearing variables** (iteration variables). Assume values for those variables. Then solve the remaining equations in the block sequentially (they become a cascade of scalar assignments). Finally, check the remaining equations (the **residual equations**) — if they are not satisfied, update the tearing variables and iterate.

**Example — a coupled block of 4 equations in 4 unknowns:**

```
E1:  a = f(b, c)
E2:  b = g(a, d)
E3:  c = h(a, b)
E4:  d = p(b, c)
```

Without tearing, the numerical solver iterates over all 4 variables simultaneously — a 4-dimensional nonlinear solve.

With tearing, suppose we choose `b` and `c` as tearing variables:

1. Guess `b` and `c`
2. E1: compute `a = f(b, c)` — known
3. E4: compute `d = p(b, c)` — known
4. Check E2: is `b = g(a, d)` satisfied? (residual for `b`)
5. Check E3: is `c = h(a, b)` satisfied? (residual for `c`)

Now the iterative solver only works with a 2-dimensional problem (iterating on `b` and `c`), and at each iteration evaluates E1 and E4 as simple assignments. This is cheaper than a 4-dimensional solve.

Finding the optimal tearing (minimum tearing variables) is NP-hard, but good heuristics exist and even modest tearing dramatically improves performance for large algebraic loops.

### 4.8 Output

At the end of this phase you have:

1. **An index-1 (or index-0) DAE system** — index reduction has been applied, additional differentiated equations and dummy derivatives are in place
2. **A reduced variable set** — aliases eliminated, constants propagated
3. **Simplified expressions** — symbolically cleaned up
4. **BLT-sorted blocks with tearing information** — each block is either a scalar assignment or a torn algebraic loop with identified tearing variables and residual equations
5. **Complete solution procedure** — a deterministic recipe: "evaluate these blocks in this order, with these iteration variables for loops"

This is essentially a **simulation program** described in terms of mathematical operations. The final step — code generation — translates this into actual executable code that calls a numerical DAE solver.

---

## Phase 5: Code Generation and Numerical Solving

This is the final phase. You have a fully analyzed, index-reduced, sorted, torn system. You now need to turn it into something that actually **runs** — something that produces trajectories of variable values over time.

### 5.1 How DAE solvers work

Before discussing code generation, you need to understand what the numerical solver expects, because the generated code is shaped entirely by the solver's interface.

The most common DAE solver used in Modelica tools is **IDA** from the SUNDIALS suite. IDA solves systems of the form:

```
F(t, y, y_dot) = 0
```

Where `t` is time, `y` is the vector of state variables, and `y_dot` is the vector of their time derivatives. At each time step, IDA provides trial values of `y` and `y_dot`, and your code must compute the **residual vector** `F`. IDA then adjusts `y` and `y_dot` until the residuals are close enough to zero.

So the fundamental contract is: you give the solver a function that computes residuals, and the solver drives them to zero while advancing time.

For an ODE system (index-0), simpler solvers can be used. The interface is:

```
y_dot = f(t, y)
```

You provide a function that computes derivatives given current states. Solvers like **CVODE** (also from SUNDIALS), or classic Runge-Kutta methods, work with this form. If your index reduction has fully reduced the system to explicit ODE form, this is the simpler path.

### 5.2 Generated code structure

The generated code typically consists of several functions that the solver calls at different points. Think of it as filling in a template.

#### 5.2.1 Initialization function

Sets up the initial state of the system. This is itself a nontrivial problem — often more complex than the time-stepping simulation that follows.

#### Why initialization is hard

During time-stepping, the solver knows the current values of all state variables (from the previous step) and only needs to compute derivatives and algebraic variables. But at time zero, **nothing is known yet**. The system must find values for all states, all derivatives, and all algebraic variables simultaneously, such that every equation is satisfied.

The user provides `start` values for some variables (e.g., `Real x(start = 1.0)`), but these are only **initial guesses**, not hard constraints — unless the variable also has the attribute `fixed = true`, which means "this variable must have exactly this value at time zero." For state variables, `fixed = true` is the default. For algebraic variables, it is not.

For the SpringMassDamper:
- `x(start = 1.0)` — state variable, `fixed = true` by default, so `x(0) = 1.0` is a hard constraint.
- `v(start = 0.0)` — state variable, `fixed = true` by default, so `v(0) = 0.0` is a hard constraint.
- `der(x)` and `der(v)` — must be computed from the equations.

With `x = 1.0` and `v = 0.0` fixed, the equations become:
```
E1:  0.0 = der(x)          →  der(x) = 0.0
E2:  1.0 * der(v) = -10.0 * 1.0 - 0.5 * 0.0  →  der(v) = -10.0
```

This is straightforward. But for the SimpleCircuit, initialization is more involved — the system must find consistent voltages and currents throughout the circuit at `time = 0`, when the switch is open (`time < 0.5`, so `closed = false`). With `Roff = 1e5`, the circuit has essentially no current flow, and the capacitor voltage starts at zero (its default start value). The initialization solver must verify that these values satisfy all 17 equations simultaneously.

#### Structure of the initialization problem

The initialization problem uses the **same equations** as the runtime system, plus additional equations from `fixed = true` constraints, minus the integration relationships (since there is no "previous time step" to integrate from). Every state variable with `fixed = true` adds an equation `x = start_value`, and in return, the integration relationship `x = integral(der(x))` is removed (since there is no integration history).

This changes the variable classification: during initialization, states are unknowns just like algebraic variables. The BLT decomposition must be recomputed for this different system. The initialization BLT may have larger algebraic loops than the runtime BLT, because variables that are "known from the integrator" during runtime are now unknowns that must be solved for.

For large models, the initialization system can be substantial — a model with 500 state variables and 2000 algebraic variables requires solving a system of 2500 equations at time zero.

```cpp
void initialize(SimulationState& state) {
    // Set parameter values
    state.m = 1.0;
    state.k = 10.0;
    state.d = 0.5;

    // Set initial guesses from start attributes
    state.x = 1.0;  // from Real x(start = 1.0, fixed = true)
    state.v = 0.0;  // from Real v(start = 0.0, fixed = true)

    // Solve initial system to find consistent
    // values for all unknowns including der(x) and der(v)
    // This uses a separate BLT decomposition specific to initialization
    solveInitialSystem(state);
}
```

If the initialization solver fails to converge (no consistent solution exists, or the start values are too far from a solution for Newton's method to find it), the simulation cannot begin. Diagnosing initialization failures — determining which equations are contradictory or which start values are problematic — is one of the more difficult usability challenges in Modelica tools.

#### 5.2.2 Residual function (for DAE solvers)

This is the core. Called potentially thousands of times per time step. It must be fast.

```cpp
void residual(double t, double* y, double* ydot, double* res) {
    // Unpack state vector
    double x = y[0];
    double v = y[1];
    double der_x = ydot[0];
    double der_v = ydot[1];

    // Parameters
    double m = 1.0;
    double k = 10.0;
    double d = 0.5;

    // Residual for E1: v = der(x)  ->  v - der(x) = 0
    res[0] = v - der_x;

    // Residual for E2: m*der(v) = -k*x - d*v  ->  m*der(v) + k*x + d*v = 0
    res[1] = m * der_v + k * x + d * v;
}
```

For larger systems, the BLT decomposition determines the structure:

```cpp
void residual(double t, double* y, double* ydot, double* res) {
    // Unpack states
    // ...

    // Block 1: scalar assignment
    double a = sin(t);

    // Block 2: scalar assignment (depends on block 1)
    double b = 3.0 * a + 2.0;

    // Block 3: algebraic loop (torn)
    // Tearing variables: c, d
    // Solved by Newton iteration
    solveTornBlock3(a, b, &c, &d);

    // Block 4: scalar assignment
    double e = c + d;

    // Compute residuals for state equations
    res[0] = der_x - e;
    res[1] = ...;
}
```

The sequential blocks become straight-line assignments. The algebraic loops become calls to a nonlinear solver (Newton's method) with the tearing structure baked in.

#### 5.2.3 ODE right-hand-side function (for ODE solvers)

If the system has been fully reduced to explicit ODE form, you generate the derivative computation instead:

```cpp
void derivatives(double t, double* y, double* ydot) {
    double x = y[0];
    double v = y[1];

    double m = 1.0;
    double k = 10.0;
    double d = 0.5;

    // BLT-sorted evaluation
    double der_x = v;                        // from E1, solved for der(x)
    double der_v = (-k * x - d * v) / m;     // from E2, solved for der(v)

    ydot[0] = der_x;
    ydot[1] = der_v;
}
```

Notice how the BLT ordering appears directly as the order of assignment statements. This is why the symbolic preprocessing matters so much — it has already determined which equation solves for which variable. In this case, both equations only depend on states (maintained by the integrator), so either could be evaluated first.

#### 5.2.4 Jacobian function (optional but important)

DAE and stiff ODE solvers need the Jacobian matrix — the matrix of partial derivatives dF/dy and dF/dy_dot. The solver can approximate this by finite differences (perturbing each variable and recomputing residuals), but this is expensive for large systems.

Symbolic preprocessing can compute the Jacobian analytically by differentiating the residual expressions with respect to each state. This produces another generated function:

```cpp
void jacobian(double t, double* y, double* ydot, double** J) {
    double m = 1.0;
    double k = 10.0;
    double d = 0.5;

    // The Jacobian is J = dF/dy + alpha * dF/dy_dot
    // where alpha is a scalar provided by the solver.
    //
    // For res[0] = v - der_x:
    //   dres[0]/dx = 0,  dres[0]/dv = 1,  dres[0]/dder_x = -1,  dres[0]/dder_v = 0
    //
    // For res[1] = m*der_v + k*x + d*v:
    //   dres[1]/dx = k,  dres[1]/dv = d,  dres[1]/dder_x = 0,  dres[1]/dder_v = m

    J[0][0] = 0.0;    // dres[0]/dx
    J[0][1] = 1.0;    // dres[0]/dv
    J[1][0] = k;      // dres[1]/dx
    J[1][1] = d;      // dres[1]/dv
}
```

For large sparse systems, the sparsity pattern (which entries are nonzero) is known from the incidence matrix, and sparse matrix techniques are used.

#### 5.2.5 Event detection and handling

Modelica models can contain discontinuities. The `Switch` model in the SimpleCircuit provides a concrete example:

```modelica
closed = time >= 0.5;
p.v - n.v = (if closed then Ron else Roff) * p.i;
```

Before `time = 0.5`, the switch is open and uses resistance `Roff` (1e5 ohms — essentially no current flows). After `time = 0.5`, it closes and uses `Ron` (1e-5 ohms — essentially a short circuit). The transition is a **discontinuity** — the resistance changes abruptly by ten orders of magnitude.

The solver must detect the exact moment `time` crosses 0.5 (an **event** or **zero crossing**). Generated code includes **zero-crossing functions** that the solver monitors:

```cpp
void zeroCrossings(double t, double* y, double* zc) {
    zc[0] = t - 0.5;  // solver watches for sign change
}
```

When a zero crossing is detected, the solver stops, the model is re-evaluated with the new branch of the if-expression (switching from `Roff` to `Ron`), and integration resumes. The state variables (like the capacitor voltage) are continuous across the event, but the algebraic variables (currents, non-state voltages) may change abruptly and must be recomputed. This re-initialization uses the same BLT-sorted block structure as the normal residual evaluation, but with the new active branch of the conditional.

### 5.3 The simulation loop

Putting it all together, the simulation driver looks roughly like this:

```cpp
int main() {
    SimulationState state;
    initialize(state);

    // Create solver instance
    IDA* solver = createSolver(
        numStates,
        residualFunction,
        jacobianFunction,
        zeroCrossingFunction
    );

    // Set initial conditions
    solver->setInitialConditions(state.y, state.ydot);

    // Time stepping
    double tStart = 0.0;
    double tEnd = 10.0;
    double tOutput = 0.01;  // output interval

    for (double t = tStart; t < tEnd; t += tOutput) {
        // Solver advances to next output time
        // Internally it takes many smaller steps
        // It calls residual() many times per step
        // It detects and handles events
        solver->advanceTo(t + tOutput);

        // Record outputs
        writeResults(t, state);
    }

    return 0;
}
```

The solver does the heavy numerical lifting. Your generated code provides the mathematical content — residuals, Jacobians, zero crossings, initialization.

### 5.4 What gets generated in practice

Real Modelica compilers typically generate C code (not C++), because C has simpler calling conventions, wider compiler availability, and the generated code is mostly straight-line arithmetic with no need for object-oriented features. The generated files are:

- **Model equations** — residual function, sorted blocks, torn loop solvers
- **Initialization** — initial value problem setup and solving
- **Jacobian** — analytical or sparsity pattern for the solver
- **Events** — zero-crossing functions and event handlers
- **Output** — mapping from internal variable indices to named results
- **Simulation harness** — main loop, solver configuration, result file writing

These are compiled, linked against the solver library (SUNDIALS, or a custom solver), and the resulting executable produces simulation results — typically a time series of all variable values written to a file.

### 5.5 The result

What started as a hierarchical, object-oriented Modelica model:

```modelica
model SimpleCircuit
  Battery B(V = 12.0);
  Switch S;
  Resistor R1(R = 100.0);
  Capacitor C1(C = 1e-6);
equation
  connect(B.p, S.p);
  connect(S.n, R1.p);
  connect(R1.n, C1.p);
  connect(C1.n, B.n);
end SimpleCircuit;
```

Has been transformed through five phases — parsing, flattening, equation processing, symbolic preprocessing, code generation — into a compiled executable that numerically integrates the resulting DAE system, detects the switching event at `time = 0.5`, and produces voltage and current waveforms over time. The result shows the capacitor voltage ramping from 0 toward 12V after the switch closes, with the RC time constant governing the charging rate.

---

## Summary

What starts as a hierarchical, object-oriented Modelica model passes through five phases:

1. **Syntactic Parsing** — text to AST (structural representation, no mathematical meaning)
2. **Flattening** — hierarchy to flat variable/equation lists (component instantiation, connect resolution, inheritance, modifications, for-loop expansion)
3. **Equation Processing** — structural analysis (variable classification, incidence matrix, bipartite matching, BLT decomposition via Tarjan's algorithm, index detection)
4. **Symbolic Preprocessing** — mathematical transformation (index reduction via Pantelides, dummy derivatives, symbolic differentiation, simplification, alias elimination, tearing)
5. **Code Generation** — executable output (residual functions, Jacobians, event handling, initialization, solver integration via SUNDIALS)

The result is a compiled executable that numerically integrates the DAE system and produces simulation trajectories.

## Key Algorithms

| Algorithm | Purpose | Phase |
|---|---|---|
| Hopcroft-Karp / Hungarian | Bipartite graph matching (equation-variable assignment) | Equation Processing |
| Tarjan's algorithm | Strongly connected components (BLT decomposition) | Equation Processing |
| Pantelides algorithm | Structural index reduction | Symbolic Preprocessing |
| Dummy derivative method | Robust dynamic state selection | Symbolic Preprocessing |
| Tearing heuristics | Algebraic loop size reduction | Symbolic Preprocessing |
| Newton's method | Iterative nonlinear solving of algebraic loops | Code Generation / Runtime |
| IDA / CVODE (SUNDIALS) | Numerical DAE/ODE integration | Code Generation / Runtime |

## Key Concepts

| Concept | Definition |
|---|---|
| AST | Abstract Syntax Tree — structured representation of parsed source code |
| DAE | Differential-Algebraic Equation system — equations mixing derivatives and algebraic constraints |
| State variable | A variable that appears inside `der()`; integrated over time by the solver |
| Algebraic variable | An unknown that does not appear inside `der()`; solved at each time step |
| Incidence matrix | Binary matrix recording which variables appear in which equations |
| Matching | Assignment of each equation to the one variable it will solve for |
| BLT decomposition | Ordering of equation blocks; identifies sequential vs coupled (algebraic loop) blocks |
| DAE index | Measure of how many times constraints must be differentiated to reach ODE form |
| Algebraic loop | A set of mutually dependent equations that must be solved simultaneously |
| Tearing variable | A variable chosen as the iteration variable in a torn algebraic loop |
| Residual | The value F(t, y, y_dot) that the solver drives to zero |
| Zero crossing | A discontinuity event detected by monitoring a sign change in a function |
| Alias | A variable trivially equal to another; eliminated by substitution |
| Across variable | A connector variable (like voltage) set equal in connections |
| Flow variable | A connector variable (like current) that sums to zero at connection nodes |
| Modification | An override of a default value in a component instantiation |
