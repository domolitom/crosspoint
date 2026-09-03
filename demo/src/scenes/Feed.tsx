import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';

import feed from '../../public/changes.json';
import { theme } from '../theme';
import { Rise } from '../Title';

/**
 * The change feed, from the real `/api/changes` response the capture run recorded.
 *
 * Not retyped for the film. This is the whole argument the product makes — that a graph
 * edit reads as an instruction — so a hand-written mock of the payload would be exactly
 * the wrong thing to put on screen.
 */

type Entry = { kind: string; actor?: string; op: Record<string, any> };

/** One entry as a diff line, because that is how the receiving agent is meant to read it. */
function line(op: Record<string, any>): { sign: string; text: string; tint: string } {
  switch (op.op) {
    case 'add_node_at':
    case 'add_node':
      return { sign: '+', text: `node "${op.label}"`, tint: theme.green };
    case 'add_edge':
      return { sign: '+', text: `edge ${op.source} → ${op.target}`, tint: theme.green };
    case 'update_node':
      return {
        sign: '~',
        text: op.color ? `node ${op.id}   colour: ${op.color}` : `node ${op.id}`,
        tint: op.color === 'red' ? theme.red : theme.amber,
      };
    case 'delete_node':
      return { sign: '−', text: `node ${op.id}`, tint: theme.red };
    default:
      return { sign: '~', text: op.op, tint: theme.slate };
  }
}

export const Feed: React.FC = () => {
  const frame = useCurrentFrame();
  const entries = feed.entries as Entry[];

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 44,
        padding: '0 160px',
      }}
    >
      <Rise delay={0} distance={16}>
        <div
          style={{
            fontFamily: theme.sans,
            fontSize: 46,
            fontWeight: 500,
            color: theme.ink,
            letterSpacing: -1,
            textAlign: 'center',
          }}
        >
          The agent reads the diff, not the picture.
        </div>
      </Rise>

      <div
        style={{
          width: 1120,
          borderRadius: 16,
          border: `1px solid ${theme.border}`,
          background: 'rgba(8,12,23,0.72)',
          boxShadow: '0 30px 80px rgba(0,0,0,0.5)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '16px 26px',
            borderBottom: `1px solid ${theme.border}`,
            fontFamily: theme.mono,
            fontSize: 18,
            color: theme.inkFaint,
            letterSpacing: 0.4,
          }}
        >
          get_changes()
        </div>

        <div style={{ padding: '26px 26px 30px' }}>
          {entries.map((entry, i) => {
            const { sign, text, tint } = line(entry.op);
            return (
              <Rise key={i} delay={18 + i * 16} distance={12}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 20,
                    padding: '11px 0',
                    fontFamily: theme.mono,
                    fontSize: 30,
                  }}
                >
                  <span style={{ color: tint, width: 26, fontWeight: 700 }}>{sign}</span>
                  <span style={{ color: theme.ink }}>{text}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ color: theme.inkFaint, fontSize: 20 }}>{entry.actor}</span>
                </div>
              </Rise>
            );
          })}

          {/* The point of the shot: what is *not* here. */}
          <Rise delay={18 + entries.length * 16 + 22} distance={12}>
            <div
              style={{
                marginTop: 14,
                paddingTop: 22,
                borderTop: `1px dashed ${theme.border}`,
                fontFamily: theme.mono,
                fontSize: 24,
                color: theme.inkFaint,
                display: 'flex',
                alignItems: 'baseline',
                gap: 20,
              }}
            >
              <span style={{ width: 26, textDecoration: 'line-through' }}>~</span>
              <span style={{ textDecoration: 'line-through' }}>move_node notify</span>
              <span style={{ marginLeft: 8, fontFamily: theme.sans, fontStyle: 'italic' }}>
                filtered — moving a box is not a message
              </span>
            </div>
          </Rise>
        </div>
      </div>

      <div
        style={{
          opacity: interpolate(frame, [86, 104], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          fontFamily: theme.sans,
          fontSize: 30,
          color: theme.inkDim,
          textAlign: 'center',
        }}
      >
        Two edits. No prose. No ambiguity about which one mattered.
      </div>
    </div>
  );
};
