# Infrastructure Test Plan

## Overview

This document defines the tests for the compiler infrastructure: command-line argument handling and source file reading. Tests are written before implementation (TDD). All tests in this document are failing until the corresponding implementation is in place.

Test source file: `tests/infrastructure/infrastructure_test.ts`

---

## Command-Line Argument Handling

The entry point accepts a single argument: the path to a Modelica source file. Argument validation must occur before any compiler phase is invoked.

### Unit Tests

These tests target the argument-parsing and validation logic directly, independent of the process entry point. The implementation should expose this logic as a testable function.

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-CLI-1 | No argument provided | `args = []` | Throws or returns an error indicating no file path was provided |
| U-CLI-2 | Valid file path provided | `args = ["tests/SpringMassDamper.mo"]` | Returns the file path string without error |
| U-CLI-3 | Multiple arguments provided | `args = ["a.mo", "b.mo"]` | Throws or returns an error indicating only one file is supported |

### Integration Tests

These tests spawn the compiled entry point as a subprocess and verify its observable behavior: stdout/stderr output and exit code.

| # | Test | Invocation | Expected Exit Code | Expected Output |
|---|------|------------|--------------------|-----------------|
| I-CLI-1 | No argument | `deno run src/main.ts` | Non-zero | Error message indicating a file path is required |
| I-CLI-2 | File does not exist | `deno run src/main.ts missing.mo` | Non-zero | Error message indicating the file was not found |
| I-CLI-3 | File exists and is readable | `deno run src/main.ts tests/SpringMassDamper.mo` | Zero | No error output |

---

## Reading the Source File

Once the file path is validated, the entry point reads the entire file into memory as a UTF-8 string. The file path is retained alongside the contents and both are passed to the next compiler phase.

### Unit Tests

These tests target the file-reading logic directly.

| # | Test | Input | Expected Result |
|---|------|-------|----------------|
| U-FILE-1 | Read a valid `.mo` file | Path to `tests/SpringMassDamper.mo` | Returns a non-empty UTF-8 string containing the file contents |
| U-FILE-2 | Returned value includes file path | Path to `tests/SpringMassDamper.mo` | Returned object contains both `filePath` (the original path string) and `source` (the file contents string) |
| U-FILE-3 | File contents match known content | Path to `tests/SpringMassDamper.mo` | The `source` string matches the exact contents of the file on disk |

### Integration Tests

| # | Test | Invocation | Expected Result |
|---|------|------------|----------------|
| I-FILE-1 | Valid file is read end-to-end | `deno run src/main.ts tests/SpringMassDamper.mo` | Program completes with exit code zero; no file-read errors reported |
