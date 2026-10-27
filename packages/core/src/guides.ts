/**
 * Alignment and equal-spacing guides for a box being dragged (#20, #21).
 *
 * Pure geometry over rectangles, so the canvas measures and this decides. Each axis is solved
 * on its own by the same code: the y axis runs the x-axis solver on transposed rectangles.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A guide line: `axis: 'x'` is a vertical line at x = `at`, spanning y from `from` to `to`. */
export interface Guide {
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
}

/** A gap of the matched size: along `axis` from `from` to `to`, drawn at cross position `at`. */
export interface Gap {
  axis: 'x' | 'y';
  from: number;
  to: number;
  at: number;
}

export interface Snap {
  dx: number;
  dy: number;
  guides: Guide[];
  gaps: Gap[];
}

type Found = { d: number; spacing?: Gap[] };

const transpose = (r: Rect): Rect => ({ x: r.y, y: r.x, w: r.h, h: r.w });
const lines = (r: Rect) => [r.x, r.x + r.w / 2, r.x + r.w];
const overlaps = (a: Rect, b: Rect) => a.y < b.y + b.h && b.y < a.y + a.h;

/** The smallest move along x, within `threshold`, that lines `m` up or matches a gap. */
function solve(m: Rect, others: Rect[], threshold: number): Found | null {
  let best: Found | null = null;
  const offer = (d: number, spacing?: Gap[]) => {
    if (Math.abs(d) > threshold) return;
    // Alignment wins a tie: it is the more common intent and the cheaper one to read.
    if (!best || Math.abs(d) < Math.abs(best.d) - 1e-9) best = { d, spacing };
  };

  for (const o of others) for (const a of lines(m)) for (const b of lines(o)) offer(b - a);

  // Spacing only counts within a row: boxes whose cross extent overlaps the moving one.
  const row = others.filter((o) => overlaps(o, m)).sort((a, b) => a.x - b.x);
  const pairs: { gap: number; segment: Gap }[] = [];
  for (let i = 1; i < row.length; i++) {
    const [p, q] = [row[i - 1], row[i]];
    const gap = q.x - (p.x + p.w);
    if (gap > 0) pairs.push({ gap, segment: { axis: 'x', from: p.x + p.w, to: q.x, at: midCross(p, q) } });
  }

  const centre = m.x + m.w / 2;
  const left = row.filter((o) => o.x + o.w <= centre).at(-1);
  const right = row.find((o) => o.x >= centre);
  const ends = (gap: number) => pairs.filter((p) => Math.abs(p.gap - gap) < 0.5).map((p) => p.segment);

  for (const { gap } of pairs) {
    if (left) {
      const d = left.x + left.w + gap - m.x;
      offer(d, [{ axis: 'x', from: left.x + left.w, to: left.x + left.w + gap, at: midCross(left, m) }, ...ends(gap)]);
    }
    if (right) {
      const d = right.x - gap - m.w - m.x;
      offer(d, [{ axis: 'x', from: right.x - gap, to: right.x, at: midCross(right, m) }, ...ends(gap)]);
    }
  }
  if (left && right && right.x - (left.x + left.w) > m.w) {
    const gap = (right.x - (left.x + left.w) - m.w) / 2;
    const x = left.x + left.w + gap;
    offer(x - m.x, [
      { axis: 'x', from: left.x + left.w, to: x, at: midCross(left, m) },
      { axis: 'x', from: x + m.w, to: right.x, at: midCross(right, m) },
    ]);
  }
  return best;
}

/** Halfway through where two boxes overlap across the axis, so a gap marker sits between them. */
function midCross(a: Rect, b: Rect) {
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return bottom > top ? (top + bottom) / 2 : (a.y + a.h / 2 + b.y + b.h / 2) / 2;
}

/** Every line of `m` that now coincides with a line of another box, drawn across both. */
function aligned(m: Rect, others: Rect[]): Guide[] {
  const guides: Guide[] = [];
  for (const a of lines(m)) {
    const hits = others.filter((o) => lines(o).some((b) => Math.abs(b - a) < 0.5));
    if (hits.length === 0) continue;
    const from = Math.min(m.y, ...hits.map((o) => o.y));
    const to = Math.max(m.y + m.h, ...hits.map((o) => o.y + o.h));
    guides.push({ axis: 'x', at: a, from, to });
  }
  return guides;
}

const flipGuide = (g: Guide): Guide => ({ ...g, axis: 'y' });
const flipGap = (g: Gap): Gap => ({ ...g, axis: 'y' });

/**
 * Where to nudge `moving` so it lines up with, or is evenly spaced from, `others`.
 *
 * Each axis snaps independently, and only within `threshold`; an axis with nothing in range
 * has a zero offset and the caller falls back to the grid.
 */
export function snapToGuides(moving: Rect, others: Rect[], threshold: number): Snap {
  const along = solve(moving, others, threshold);
  const across = solve(transpose(moving), others.map(transpose), threshold);
  const dx = along?.d ?? 0;
  const dy = across?.d ?? 0;
  const placed = { ...moving, x: moving.x + dx, y: moving.y + dy };

  const guides = [
    ...(along ? aligned(placed, others) : []),
    ...(across ? aligned(transpose(placed), others.map(transpose)).map(flipGuide) : []),
  ];
  const gaps = [...(along?.spacing ?? []), ...(across?.spacing ?? []).map(flipGap)];
  return { dx, dy, guides, gaps };
}
