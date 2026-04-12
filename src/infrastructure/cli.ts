/**
 * Parses and validates command-line arguments.
 *
 * Expects exactly one argument: the path to a Modelica source file.
 * Throws if zero or more than one argument is provided.
 *
 * @param args - The raw argument array (e.g. Deno.args)
 * @returns The file path string
 */
export function parseArgs(args: string[]): string {
  if (args.length === 0) {
    throw new Error("A file path is required. Usage: modelica-ces <file.mo>");
  }
  if (args.length > 1) {
    throw new Error(
      "Only one file path is supported. Usage: modelica-ces <file.mo>",
    );
  }
  return args[0];
}
