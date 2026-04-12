import { parseArgs } from "./infrastructure/cli.ts";
import { readSourceFile } from "./infrastructure/fileReader.ts";

if (import.meta.main) {
  let filePath: string;
  try {
    filePath = parseArgs(Deno.args);
  } catch (err) {
    console.error((err as Error).message);
    Deno.exit(1);
  }

  try {
    await readSourceFile(filePath);
  } catch (err) {
    const message = (err as Error).message;
    // Deno surfaces OS errors like "No such file or directory" — pass them through
    console.error(message);
    Deno.exit(1);
  }
}
