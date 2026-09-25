import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react';
import { describeCode, type CodeRef } from '@crosspoint/core';

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
 * A connection point per side, every one of them a `source`.
 *
 * The canvas runs in `ConnectionMode.Loose`, so any of these also accepts an incoming edge —
 * which is what lets a drag start from whichever side faces the other node. Which side an
 * edge is *drawn* on is computed in `DirectedEdge`, never stored: a saved side would be
 * geometry in the document, and layout is the human's, not the file's.
 */
const SIDES = [
  ['top', Position.Top],
  ['right', Position.Right],
  ['bottom', Position.Bottom],
  ['left', Position.Left],
] as const;

export function CanvasNode({ data, selected }: NodeProps<Node<CanvasNodeData>>) {
  const linked = Boolean(data.subcanvas);

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
      {SIDES.map(([id, position]) => (
        <Handle key={id} id={id} type="source" position={position} />
      ))}
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
