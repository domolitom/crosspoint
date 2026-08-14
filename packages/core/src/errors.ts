/**
 * Its own module so `generate.ts` can throw it without importing `ops.ts`, which
 * imports `generate.ts` in turn. Re-exported from `ops.ts` for callers that already
 * import it from there.
 */
export class GraphError extends Error {}
