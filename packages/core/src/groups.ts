/** Space between a group's container and its members, and above them for the name. */
export const GROUP_PAD = 16;
export const GROUP_LABEL = 22;

export interface GroupRect {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One container per named group, wrapping its members. Derived, never stored. */
export function groupRects(boxes: { x: number; y: number; w: number; h: number; group?: unknown }[]): GroupRect[] {
  const byName = new Map<string, { x: number; y: number; right: number; bottom: number }>();
  for (const b of boxes) {
    if (typeof b.group !== 'string') continue;
    const r = byName.get(b.group);
    byName.set(b.group, {
      x: Math.min(r?.x ?? Infinity, b.x),
      y: Math.min(r?.y ?? Infinity, b.y),
      right: Math.max(r?.right ?? -Infinity, b.x + b.w),
      bottom: Math.max(r?.bottom ?? -Infinity, b.y + b.h),
    });
  }
  return [...byName].map(([name, r]) => ({
    name,
    x: r.x - GROUP_PAD,
    y: r.y - GROUP_PAD - GROUP_LABEL,
    w: r.right - r.x + 2 * GROUP_PAD,
    h: r.bottom - r.y + 2 * GROUP_PAD + GROUP_LABEL,
  }));
}
