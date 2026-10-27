import {
  Handle,
  NodeResizer,
  Position,
  useUpdateNodeInternals,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { borderPoint, describeCode, type CodeRef } from '@crosspoint/core';
import { useEffect, useState, type PointerEvent } from 'react';

import { handleId, pointStyle, type EndPoint } from './edgePoints';
import { LabelInput } from './LabelInput';

/**
 * The node body, replacing React Flow's built-in `default` type.
 *
 * Registered under the key `default` on purpose: every existing rule targets
 * `.react-flow__node-default` — the label-width clamp mirrored in `estimateNodeWidth`,
 * and all six colour fills — so overriding the built-in type keeps that styling rather
 * than requiring it to be duplicated under a new class.
 *
 * Replacing the built-in means rendering its handles here too; without them nothing can
 * be connected.
 */

export type CanvasNodeData = {
  label: string;
  /** Name of the diagram holding this node's detail, if any. */
  subcanvas?: string;
  /** The code this node stands for, if any. Rendered as one monospace line. */
  code?: CodeRef;
  /** Absent in the panel at maximum depth, where lensing further is refused. */
  onLens?: () => void;
  /** Called with the new label. Not called when the label is unchanged. */
  onRename?: (label: string) => void;
  onCancelRename?: () => void;
  /** Multi-line detail under the label. Absent means the node is just its name. */
  body?: string;
  /** Which field is open for editing, if either. */
  editing?: 'label' | 'body';
  /** Called with the new body. An empty string removes it. */
  onBodyCommit?: (body: string) => void;
  onBodyCancel?: () => void;
  /** Opens the body editor. Absent on a canvas that cannot edit. */
  onEditBody?: () => void;
  /** Called once when a resize gesture ends, never per frame. */
  onResize?: (size: { w: number; h: number }, position: { x: number; y: number }) => void;
  /** Floor for the resizer, mirroring the core clamp. */
  minWidth?: number;
  minHeight?: number;
  /** Off-midpoint points that edges are attached to, each rendered as its own handle. */
  anchors?: EndPoint[];
};

/**
 * Does this body hold a pipe table?
 *
 * Columns only line up in a monospace font, and a table in proportional text is unreadable —
 * but so is prose in monospace, so this switches rather than picking one for everything.
 * Deliberately a rendering detail: the body stays plain text, with nothing new in the model
 * and nothing new on the agent's surface.
 */
const isTable = (body: string) => body.split('\n').some((line) => line.trimStart().startsWith('|'));

/**
 * A band per side, every one of them a `source`.
 *
 * Each band spans its whole side, so an edge can start anywhere on the border; its centre is
 * the side's midpoint, so an end bound to the plain side id still lands on the predefined
 * point. `ConnectionMode.Loose` lets any of them receive an edge too.
 */
const SIDES = [
  ['top', Position.Top],
  ['right', Position.Right],
  ['bottom', Position.Bottom],
  ['left', Position.Left],
] as const;

export function CanvasNode({ id, data, selected }: NodeProps<Node<CanvasNodeData>>) {
  const linked = Boolean(data.subcanvas);
  const [hover, setHover] = useState<EndPoint | null>(null);

  // React Flow measures handles only when told to, so a new attachment point needs a nudge.
  const updateNodeInternals = useUpdateNodeInternals();
  const anchorKey = (data.anchors ?? []).map((a) => handleId(a.side, a.at)).join();
  useEffect(() => updateNodeInternals(id), [id, anchorKey, updateNodeInternals]);

  const trackBand = (event: PointerEvent) => {
    const node = (event.currentTarget as HTMLElement).closest('.react-flow__node');
    if (!node) return;
    const r = node.getBoundingClientRect();
    setHover(borderPoint({ x: r.left, y: r.top, w: r.width, h: r.height }, { x: event.clientX, y: event.clientY }));
  };

  return (
    <>
      {/* Handles only while selected, so an unselected canvas stays quiet. Resizing is
          persisted on end rather than per frame — the same rule `onNodeDragStop` follows,
          or one gesture would burn a rev per animation frame. */}
      <NodeResizer
        isVisible={Boolean(selected) && !data.editing}
        minWidth={data.minWidth ?? 120}
        minHeight={data.minHeight ?? 60}
        onResizeEnd={(_, params) =>
          data.onResize?.(
            { w: params.width, h: params.height },
            { x: params.x, y: params.y },
          )
        }
      />
      {SIDES.map(([side, position]) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={position}
          className={`cp-band cp-band-${side}`}
          onPointerMove={trackBand}
          onPointerLeave={() => setHover(null)}
        />
      ))}
      {data.anchors?.map((anchor) => (
        <Handle
          key={handleId(anchor.side, anchor.at)}
          id={handleId(anchor.side, anchor.at)}
          type="source"
          position={anchor.side as Position}
          isConnectable={false}
          className="cp-anchor"
          style={
            anchor.side === 'top' || anchor.side === 'bottom'
              ? { left: `${(anchor.at ?? 0.5) * 100}%` }
              : { top: `${(anchor.at ?? 0.5) * 100}%` }
          }
        />
      ))}
      {hover && <span className="cp-point-dot" style={pointStyle(hover)} />}
      {data.editing === 'label' ? (
        <LabelInput
          initial={data.label}
          ariaLabel="Node label"
          className="cp-node-input"
          autoWidth
          onCommit={(label) => data.onRename?.(label)}
          onCancel={() => data.onCancelRename?.()}
        />
      ) : (
        <span className="cp-node-label">{data.label}</span>
      )}

      {data.editing === 'body' ? (
        <LabelInput
          initial={data.body ?? ''}
          placeholder="detail…"
          ariaLabel="Node body"
          className="cp-node-body-input"
          multiline
          allowEmpty
          onCommit={(body) => data.onBodyCommit?.(body)}
          onCancel={() => data.onBodyCancel?.()}
        />
      ) : (
        data.body && (
          <span className={isTable(data.body) ? 'cp-node-body cp-node-mono' : 'cp-node-body'}>
            {data.body}
          </span>
        )
      )}
      {data.code && (
        <span className="cp-node-code" title={describeCode(data.code)}>
          {describeCode(data.code)}
        </span>
      )}
      {data.onEditBody && !data.body && data.editing === undefined && (
        <button
          type="button"
          className="cp-body-add"
          title="Add detail to this node"
          aria-label={`Add detail to ${data.label}`}
          // Same reasoning as the lens badge: swallow the press so adding detail does not
          // also select the node and start a drag.
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            data.onEditBody?.();
          }}
        >
          ≡
        </button>
      )}
      {data.onLens && (
        <button
          type="button"
          className={linked ? 'cp-lens cp-lens-linked' : 'cp-lens'}
          title={linked ? `Open subcanvas "${data.subcanvas}"` : 'Give this node a subcanvas'}
          aria-label={
            linked ? `Open subcanvas ${data.subcanvas}` : `Create subcanvas for ${data.label}`
          }
          // Stop the click reaching the node, or lensing would also select and could
          // begin a drag — the badge is a separate target so double-click still renames.
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            data.onLens?.();
          }}
        >
          ⧉
        </button>
      )}
    </>
  );
}
