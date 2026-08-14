import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';

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
};

export function CanvasNode({ data }: NodeProps<Node<CanvasNodeData>>) {
  const linked = Boolean(data.subcanvas);

  return (
    <>
      <Handle type="target" position={Position.Top} />
      <span className="cp-node-label">{data.label}</span>
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
