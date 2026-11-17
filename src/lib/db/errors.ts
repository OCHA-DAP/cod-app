// DuckDB's OutOfMemoryException, which the WASM build surfaces as a plain Error.
export function isOutOfMemory(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("Out of Memory Error");
}
