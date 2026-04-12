export interface SourceFile {
  filePath: string;
  source: string;
}

/**
 * Reads a Modelica source file from disk.
 *
 * @param filePath - Path to the .mo file
 * @returns An object containing the original path and the UTF-8 file contents
 */
export async function readSourceFile(filePath: string): Promise<SourceFile> {
  const source = await Deno.readTextFile(filePath);
  return { filePath, source };
}
