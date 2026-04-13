import { parseArgs } from "./infrastructure/cli.ts";
import { readSourceFile } from "./infrastructure/fileReader.ts";
import { Parser } from "./phase1/parser.ts";

if (import.meta.main) {
  let filePath: string;
  try {
    filePath = parseArgs(Deno.args);
  } catch (err) {
    console.error((err as Error).message);
    Deno.exit(1);
  }

  try {
    const { filePath: fp, source } = await readSourceFile(filePath);
    const parser = new Parser(source, fp);
    parser.parse();
  } catch (err) {
    console.error((err as Error).message);
    Deno.exit(1);
  }
}
