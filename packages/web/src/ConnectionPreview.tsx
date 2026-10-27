import { useStore, type ConnectionLineComponentProps, type Position } from '@xyflow/react';
import { createContext, useContext, type MutableRefObject } from 'react';

import { curve } from './DirectedEdge';
import { dropTarget, pointOn, rectOf, type EndPoint } from './edgePoints';

/** The fixed end of the connection being drawn, set when the drag starts. */
export type ConnectionStart = { nodeId: string } & EndPoint;

export const ConnectionStartContext = createContext<MutableRefObject<ConnectionStart | null> | null>(null);

/**
 * The line while an edge is being drawn or an end is being moved, with a dot on the point it
 * will land on. Both ends come from the same rules the drop uses, so what you see is what you get.
 */
export function ConnectionPreview({ fromNode, fromX, fromY, fromPosition, pointer, toPosition }: ConnectionLineComponentProps) {
  const start = useContext(ConnectionStartContext)?.current;
  const nodes = useStore((s) => s.nodeLookup);
  const [tx, ty, zoom] = useStore((s) => s.transform);
  // `pointer` is screen pixels from the pane's corner, not flow coordinates.
  const flowPointer = { x: (pointer.x - tx) / zoom, y: (pointer.y - ty) / zoom };

  const from =
    start && start.nodeId === fromNode.id
      ? { ...pointOn(rectOf(fromNode), start), position: start.side as Position }
      : { x: fromX, y: fromY, position: fromPosition };
  const target = dropTarget(nodes.values(), flowPointer, zoom, fromNode.id);
  const to = target
    ? { ...pointOn(target.rect, target), position: target.side as Position }
    : { ...flowPointer, position: toPosition };

  const [path] = curve(from, to, 0);
  return (
    <g>
      <path d={path} fill="none" className="react-flow__connection-path" />
      <circle cx={from.x} cy={from.y} r={4} className="cp-connection-dot" />
      {target && <circle cx={to.x} cy={to.y} r={4} className="cp-connection-dot" />}
    </g>
  );
}
