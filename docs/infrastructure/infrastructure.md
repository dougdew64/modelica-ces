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
deno run main.ts tests/models/SpringMassDamper.mo
```

The argument is a file path, not file contents. The entry point is responsible for validating that an argument was provided and that it refers to a file that exists and is readable before any compiler phase is invoked. If no argument is provided, or the path is invalid, the program should print a clear error message and exit with a non-zero status code.

At this stage only a single file argument is supported. Multi-file compilation and package directories are not considered here.

---

## Reading the Source File

Once the file path has been validated, the entry point reads the entire file contents into memory as a string. Modelica source files are UTF-8 encoded text. The string is then passed directly to the lexer as the starting point of the compiler pipeline.

The file path itself is retained alongside the contents. It is threaded through the lexer and parser so that every token and AST node can record which file it came from. This is essential for producing accurate error messages that include a file name, line number, and column number.

Reading the entire file into memory up front is appropriate here. Modelica source files are not large enough to warrant streaming, and having the full source string available makes it straightforward to compute line/column information from byte offsets when errors are reported.

---

## Passing File Contents into the Compiler Pipeline

Once the source file has been read, `main.ts` passes the file path and source string to the `Parser` constructor and calls `parse()`:

```typescript
const { filePath, source } = await readSourceFile(filePath);
const parser = new Parser(source, filePath);
const ast = parser.parse();
```

The `Parser` constructor accepts both the source string and the file path. It passes them to the `Lexer` it creates internally, so that every token and AST node records the originating file path in its `span`. The file path is used as-is — it is whatever string the user provided on the command line, which may be a relative or absolute path.

`parse()` returns a `StoredDefinition` node — the root of the AST — or throws an `Error` if the source is not valid Modelica. At this stage `main.ts` does not do anything further with the AST; the return value is produced but not yet consumed by any subsequent compiler phase. Later phases will be invoked here in sequence as they are implemented.

---

## Top-Level Error Reporting

All errors thrown by the lexer and parser propagate as `Error` objects with a message of the form `file:line:col: message`. The top-level entry point in `main.ts` wraps the pipeline invocation in a `try/catch`, prints the error message to stderr, and exits with a non-zero status code:

```typescript
try {
  const { filePath, source } = await readSourceFile(filePath);
  const parser = new Parser(source, filePath);
  parser.parse();
} catch (err) {
  console.error((err as Error).message);
  Deno.exit(1);
}
```

This single `try/catch` handles all error cases that can arise during parsing — both I/O errors from `readSourceFile` (e.g., file not found) and parse errors from the lexer or parser (e.g., unexpected character, unexpected token). Both kinds of error produce an `Error` with a descriptive message, and both are handled the same way: print and exit.

The exit code is `1` for any error, consistent with conventional Unix tool behavior. The message is printed without any additional prefix or decoration — the `file:line:col: message` format from the lexer and parser is already self-describing. For I/O errors, Deno surfaces the OS error message (e.g., `No such file or directory`), which is similarly self-describing and is passed through unchanged.
