import { readFile } from "node:fs/promises";

/**
 * Parse a natural-language steps file: one step per line. Blank lines and lines
 * starting with '#' (comments) are ignored. Pure — unit-tested.
 */
export function parseSteps(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

export async function loadSteps(path: string): Promise<string[]> {
  const steps = parseSteps(await readFile(path, "utf8"));
  if (steps.length === 0) throw new Error(`no steps found in ${path}`);
  return steps;
}
