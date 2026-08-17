import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react';

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
  /** Absent in the panel at maximum depth, where lensing further is refused. */
  onLens?: () => void;
  /** True while this node's label is being edited in place. */
  editing?: boolean;
  /** Called with the new label. Not called when the label is unchanged. */
  onRename?: (label: string) => void;
  onCancelRename?: () => void;
  /** Called once when a resize gesture ends, never per frame. */
  onResize?: (size: { w: number; h: number }, position: { x: number; y: number }) => void;
  /** Floor for the resizer, mirroring the core clamp. */
  minWidth?: number;
  minHeight?: number;
};

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
      <Handle type="target" position={Position.Top} />
      {data.editing ? (
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
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}
