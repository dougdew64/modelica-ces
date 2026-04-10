# Infrastructure

This document describes the scaffolding that sits above the compiler phases. It covers the entry point, command-line interface, and file I/O — the machinery that accepts a Modelica source file and feeds it into the compiler pipeline.

Scope:
- Command-line argument handling
- Reading a Modelica source file from disk
- Passing file contents into the compiler pipeline
- Top-level error reporting

---

## Command-Line Argument Handling

The compiler entry point must accept a single command-line argument: the path to a Modelica source file (conventionally with a `.mo` extension). For example:

```
deno run main.ts tests/SpringMassDamper.mo
```

The argument is a file path, not file contents. The entry point is responsible for validating that an argument was provided and that it refers to a file that exists and is readable before any compiler phase is invoked. If no argument is provided, or the path is invalid, the program should print a clear error message and exit with a non-zero status code.

At this stage only a single file argument is supported. Multi-file compilation and package directories are not considered here.

---

## Reading the Source File

Once the file path has been validated, the entry point reads the entire file contents into memory as a string. Modelica source files are UTF-8 encoded text. The string is then passed directly to the lexer as the starting point of the compiler pipeline.

The file path itself is retained alongside the contents. It is threaded through the lexer and parser so that every token and AST node can record which file it came from. This is essential for producing accurate error messages that include a file name, line number, and column number.

Reading the entire file into memory up front is appropriate here. Modelica source files are not large enough to warrant streaming, and having the full source string available makes it straightforward to compute line/column information from byte offsets when errors are reported.
