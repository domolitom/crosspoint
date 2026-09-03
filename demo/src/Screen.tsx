import React from 'react';
import { interpolate, OffthreadVideo, staticFile, useCurrentFrame } from 'remotion';

import { theme } from './theme';

/**
 * Where the footage sits. Fixed geometry, because every caption is positioned against it.
 *
 * The capture is 1520x950 and this shows it at 0.88, which is a downscale — upscaling
 * screen-recorded text is what makes a product demo look like a bootleg. The 196px left
 * underneath is the caption band, so no caption is ever laid over the canvas.
 */
export const SCREEN = { width: 1338, height: 836, x: 291, y: 44 };

/**
 * `OffthreadVideo`, not `Video`.
 *
 * `Video` drives a real `<video>` element and asks it to seek to the exact time of each
 * frame, which h264 does approximately. `OffthreadVideo` has ffmpeg extract the frame,
 * so a 30fps composition sampling 25fps footage lands on the right image every time.
 */
export const Screen: React.FC<{
  src: string;
  /** Seconds into the clip to start, for trimming a slow head off a shot. */
  from?: number;
  fadeIn?: number;
}> = ({ src, from = 0, fadeIn = 14 }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, fadeIn], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // A touch of travel on entry, so a cut between two static screens still has motion.
  const lift = interpolate(frame, [0, 26], [14, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        position: 'absolute',
        left: SCREEN.x,
        top: SCREEN.y,
        width: SCREEN.width,
        height: SCREEN.height,
        opacity,
        transform: `translateY(${lift}px)`,
        borderRadius: 14,
        overflow: 'hidden',
        border: `1px solid rgba(148,163,184,0.28)`,
        boxShadow: '0 40px 90px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04) inset',
        background: '#fff',
      }}
    >
      <OffthreadVideo
        src={staticFile(src)}
        startFrom={Math.round(from * 30)}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
    </div>
  );
};

/**
 * A ring drawn around a point on the screen, in *capture* coordinates.
 *
 * Callouts have to be authored against the 1520x950 recording — that is the only coordinate
 * space the footage can be measured in — so this converts, rather than making every caller
 * multiply by the display scale and get it subtly wrong.
 */
export const Spot: React.FC<{
  at: { x: number; y: number };
  delay?: number;
  size?: number;
  color?: string;
}> = ({ at, delay = 0, size = 120, color = theme.accentLift }) => {
  const frame = useCurrentFrame();
  const scale = SCREEN.width / 1520;
  const t = frame - delay;

  const grow = interpolate(t, [0, 18], [0.6, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const opacity = interpolate(t, [0, 12, 70, 90], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // A second ring, half a beat behind, reads as a pulse rather than a static circle.
  const pulse = interpolate(t % 45, [0, 45], [1, 1.9]);
  const pulseFade = interpolate(t % 45, [0, 45], [0.5, 0]);

  return (
    <div
      style={{
        position: 'absolute',
        left: SCREEN.x + at.x * scale,
        top: SCREEN.y + at.y * scale,
        width: size,
        height: size,
        marginLeft: -size / 2,
        marginTop: -size / 2,
        opacity,
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: '50%',
          border: `2px solid ${color}`,
          transform: `scale(${grow})`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: '50%',
          border: `2px solid ${color}`,
          transform: `scale(${pulse})`,
          opacity: pulseFade,
        }}
      />
    </div>
  );
};
