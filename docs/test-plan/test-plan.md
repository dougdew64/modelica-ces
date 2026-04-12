# Modelica CES Test Plan

## Overview

This document defines the overall testing strategy for the Modelica compiler, exporter, and simulation system. Detailed test plans for each phase are located in subdirectories mirroring the implementation documentation structure.

## Testing Approach

This project follows **Test-Driven Development (TDD)**. Failing tests are written before any implementation code exists. Implementation then proceeds until those tests pass.

## Test Organization

Test plan documents are organized to mirror the implementation documentation structure:

```
docs/test-plan/
├── test-plan.md                          (this document)
├── infrastructure/
├── phase1/
│   ├── subphase1-data-structures/
│   ├── subphase2-lexer/
│   └── subphase3-parser/
├── phase2/
├── phase3/
├── phase4/
└── phase5/
```

Test source files follow the same structure under `tests/`:

```
tests/
├── infrastructure/
├── phase1/
│   ├── subphase1-data-structures/
│   ├── subphase2-lexer/
│   └── subphase3-parser/
├── phase2/
├── phase3/
├── phase4/
└── phase5/
```

## Test Scope

### Unit Tests

Each phase and subphase has dedicated unit tests covering the behavior specified in the corresponding design document. Unit tests are isolated to the component under test.

### Integration Tests

Integration tests exercise the full compiler pipeline across multiple phases, verifying that phases compose correctly and that data flows properly from one phase to the next.

## End-to-End Test Cases

**SpringMassDamper.mo** is the primary end-to-end test case during initial development. It exercises the complete pipeline from parsing a Modelica source file through simulation output. As the project matures, many additional Modelica models will be added to broaden coverage of language features, edge cases, and simulation scenarios.

## Implementation Sequence

The first implementation target is the **infrastructure** phase: enabling the Deno application to accept a Modelica source file path as a command-line argument, then open and read that file. Tests for this infrastructure are written first, before any implementation.
