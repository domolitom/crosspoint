import { ViewportPortal, type Node } from '@xyflow/react';
import { groupRects } from '@crosspoint/core';
import { useMemo } from 'react';

/** A labelled container behind each group, from live positions so it follows a drag. */
export function Groups({ nodes }: { nodes: Node[] }) {
  const rects = useMemo(
    () =>
      groupRects(
        nodes
          .filter((n) => n.measured?.width)
          .map((n) => ({
            ...n.position,
            w: n.measured!.width!,
            h: n.measured!.height ?? 0,
            group: n.data.group,
          })),
      ),
    [nodes],
  );
  if (rects.length === 0) return null;
  return (
    <ViewportPortal>
      {rects.map((r) => (
        <div
          key={r.name}
          className="cp-group"
          data-group={r.name}
          style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
        >
          <span className="cp-group-label">{r.name}</span>
        </div>
      ))}
    </ViewportPortal>
  );
}
