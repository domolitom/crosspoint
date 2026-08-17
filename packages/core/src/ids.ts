/**
 * Id generation, shared by single-node ops and whole-graph generation.
 *
 * Ids are derived from labels rather than being opaque counters because they are the
 * handle an agent uses to talk about a node — `auth-service` is something it can reason
 * about and refer back to, `n7` is not.
 */

/** Slugify a label into a readable, stable id. */
export function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'node';
}

export function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
