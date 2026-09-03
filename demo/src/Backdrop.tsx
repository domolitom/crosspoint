import React from 'react';
import { useCurrentFrame } from 'remotion';

import { theme } from './theme';

/**
 * The film's background: a dark field with two slow-drifting blue glows.
 *
 * Deliberately animated off `frame` rather than a CSS animation. Remotion renders each
 * frame in a fresh page and screenshots it, so anything driven by wall-clock time renders
 * as a still image — every frame would show the animation at time zero.
 */
export const Backdrop: React.FC<{ intensity?: number }> = ({ intensity = 1 }) => {
  const frame = useCurrentFrame();
  const drift = Math.sin(frame / 90) * 60;
  const drift2 = Math.cos(frame / 70) * 45;

  return (
    <div style={{ position: 'absolute', inset: 0, background: theme.bg, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          width: 1600,
          height: 1600,
          left: -300 + drift,
          top: -700 + drift2,
          borderRadius: '50%',
          background: `radial-gradient(circle, rgba(37,99,235,${0.3 * intensity}) 0%, rgba(37,99,235,0) 62%)`,
          filter: 'blur(20px)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 1400,
          height: 1400,
          right: -400 - drift,
          bottom: -600 - drift2,
          borderRadius: '50%',
          background: `radial-gradient(circle, rgba(124,58,237,${0.22 * intensity}) 0%, rgba(124,58,237,0) 60%)`,
          filter: 'blur(20px)',
        }}
      />
      {/* A faint grid, echoing the canvas's own 15px dot grid. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `radial-gradient(${theme.border} 1px, transparent 1px)`,
          backgroundSize: '45px 45px',
          opacity: 0.5,
        }}
      />
    </div>
  );
};
