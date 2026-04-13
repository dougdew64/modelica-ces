import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import { parseArgs } from "../../src/infrastructure/cli.ts";
import { readSourceFile } from "../../src/infrastructure/fileReader.ts";

const SPRING_MASS_DAMPER_PATH = "tests/models/SpringMassDamper.mo";
const BAD_SYNTAX_PATH = "tests/models/BadSyntax.mo";

// =============================================================================
// Command-Line Argument Handling — Unit Tests
// =============================================================================

Deno.test("U-CLI-1: no argument provided throws an error", () => {
  assertThrows(
    () => parseArgs([]),
    Error,
  );
});

Deno.test("U-CLI-2: valid file path argument returns the path string", () => {
  const result = parseArgs([SPRING_MASS_DAMPER_PATH]);
  assertEquals(result, SPRING_MASS_DAMPER_PATH);
});

Deno.test("U-CLI-3: multiple arguments throws an error", () => {
  assertThrows(
    () => parseArgs(["a.mo", "b.mo"]),
    Error,
  );
});

// =============================================================================
// Command-Line Argument Handling — Integration Tests
// =============================================================================

Deno.test("I-CLI-1: no argument exits with non-zero code and prints an error", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "src/main.ts"],
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(),
  });
  const { code, stderr } = await cmd.output();
  const errorText = new TextDecoder().decode(stderr);
  assertNotEquals(code, 0);
  assertMatch(errorText, /file path/i);
});

Deno.test("I-CLI-2: non-existent file exits with non-zero code and prints an error", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "src/main.ts", "missing.mo"],
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(),
  });
  const { code, stderr } = await cmd.output();
  const errorText = new TextDecoder().decode(stderr);
  assertNotEquals(code, 0);
  assertMatch(errorText, /not found|no such file/i);
});

Deno.test("I-CLI-3: valid file exits with code zero", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "src/main.ts", SPRING_MASS_DAMPER_PATH],
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(),
  });
  const { code } = await cmd.output();
  assertEquals(code, 0);
});

// =============================================================================
// File Reading — Unit Tests
// =============================================================================

Deno.test("U-FILE-1: reading a valid .mo file returns a non-empty string", async () => {
  const result = await readSourceFile(SPRING_MASS_DAMPER_PATH);
  assertNotEquals(result.source.length, 0);
});

Deno.test("U-FILE-2: returned value contains both filePath and source", async () => {
  const result = await readSourceFile(SPRING_MASS_DAMPER_PATH);
  assertEquals(typeof result.filePath, "string");
  assertEquals(typeof result.source, "string");
  assertEquals(result.filePath, SPRING_MASS_DAMPER_PATH);
});

Deno.test("U-FILE-3: file contents match what is on disk", async () => {
  const result = await readSourceFile(SPRING_MASS_DAMPER_PATH);
  const expected = await Deno.readTextFile(SPRING_MASS_DAMPER_PATH);
  assertEquals(result.source, expected);
});

// =============================================================================
// File Reading — Integration Tests
// =============================================================================

Deno.test("I-FILE-1: valid file is read end-to-end with exit code zero and no errors", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "src/main.ts", SPRING_MASS_DAMPER_PATH],
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(),
  });
  const { code, stderr } = await cmd.output();
  const errorText = new TextDecoder().decode(stderr);
  assertEquals(code, 0);
  assertEquals(errorText, "");
});

// =============================================================================
// Parser Integration — Integration Tests
// =============================================================================

Deno.test("I-PARSE-1: syntactically invalid file exits with non-zero code", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "src/main.ts", BAD_SYNTAX_PATH],
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(),
  });
  const { code } = await cmd.output();
  assertNotEquals(code, 0);
});

Deno.test("I-PARSE-2: syntactically invalid file prints a file:line:col error message to stderr", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "src/main.ts", BAD_SYNTAX_PATH],
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(),
  });
  const { stderr } = await cmd.output();
  const errorText = new TextDecoder().decode(stderr);
  assertMatch(errorText, /BadSyntax\.mo:\d+:\d+:/);
});
