import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';

import { SCREEN } from './Screen';
import { theme } from './theme';
import { Rise } from './Title';

/**
 * The caption band under the screen.
 *
 * One idea per shot, in the band rather than over the footage. A caption laid on top of a
 * live canvas either covers a node or has to dodge one, and it has to dodge a *different*
 * one every time the layout changes — which it will, because dagre decides the layout.
 */
export const Caption: React.FC<{
  kicker?: string;
  children: React.ReactNode;
  delay?: number;
  align?: 'center' | 'left';
}> = ({ kicker, children, delay = 0, align = 'center' }) => (
  <div
    style={{
      position: 'absolute',
      left: SCREEN.x,
      width: SCREEN.width,
      top: SCREEN.y + SCREEN.height + 44,
      display: 'flex',
      flexDirection: 'column',
      alignItems: align === 'center' ? 'center' : 'flex-start',
      gap: 12,
      textAlign: align,
    }}
  >
    {kicker ? (
      <Rise delay={delay} distance={10}>
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 17,
            letterSpacing: 2.4,
            textTransform: 'uppercase',
            color: theme.accentLift,
          }}
        >
          {kicker}
        </div>
      </Rise>
    ) : null}
    <Rise delay={delay + 5} distance={14}>
      <div
        style={{
          fontFamily: theme.sans,
          fontSize: 40,
          fontWeight: 500,
          letterSpacing: -0.8,
          color: theme.ink,
          lineHeight: 1.25,
          maxWidth: 1240,
        }}
      >
        {children}
      </div>
    </Rise>
  </div>
);

/** A word inside a caption, in the app's own colour for the thing being pointed at. */
export const Tint: React.FC<{ children: React.ReactNode; color: string }> = ({
  children,
  color,
}) => <span style={{ color }}>{children}</span>;

/** Monospace, for anything that is literally an identifier in the product. */
export const Code: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span
    style={{
      fontFamily: theme.mono,
      fontSize: '0.86em',
      padding: '2px 9px',
      borderRadius: 6,
      background: 'rgba(148,163,184,0.14)',
      border: '1px solid rgba(148,163,184,0.20)',
      color: theme.ink,
    }}
  >
    {children}
  </span>
);

/** Fades a whole scene in and out, so cuts are never hard. */
export const Scene: React.FC<{
  durationInFrames: number;
  children: React.ReactNode;
  fade?: number;
}> = ({ durationInFrames, children, fade = 12 }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(
    frame,
    [0, fade, durationInFrames - fade, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
  return <div style={{ position: 'absolute', inset: 0, opacity }}>{children}</div>;
};
