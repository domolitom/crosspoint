import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

import { theme } from './theme';

/**
 * A line of text that rises into place.
 *
 * `spring` for the movement and a plain `interpolate` for the fade: springs overshoot,
 * which is what makes the motion feel physical, but an overshooting opacity clips at 1 and
 * produces a visible flicker at the top of the curve.
 */
export const Rise: React.FC<{
  children: React.ReactNode;
  delay?: number;
  distance?: number;
}> = ({ children, delay = 0, distance = 28 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame: frame - delay,
    fps,
    config: { damping: 200, mass: 0.7 },
  });
  const opacity = interpolate(frame - delay, [0, 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        opacity,
        transform: `translateY(${interpolate(progress, [0, 1], [distance, 0])}px)`,
      }}
    >
      {children}
    </div>
  );
};

/** The word-mark, letter-spaced wide enough to read as a mark rather than a sentence. */
export const Wordmark: React.FC<{ delay?: number }> = ({ delay = 0 }) => (
  <Rise delay={delay}>
    <div
      style={{
        fontFamily: theme.sans,
        fontSize: 92,
        fontWeight: 600,
        letterSpacing: -2,
        color: theme.ink,
      }}
    >
      Crosspoint
    </div>
  </Rise>
);

export const Subtitle: React.FC<{ children: React.ReactNode; delay?: number }> = ({
  children,
  delay = 0,
}) => (
  <Rise delay={delay} distance={18}>
    <div
      style={{
        fontFamily: theme.sans,
        fontSize: 34,
        fontWeight: 400,
        color: theme.inkDim,
        letterSpacing: -0.4,
      }}
    >
      {children}
    </div>
  </Rise>
);
