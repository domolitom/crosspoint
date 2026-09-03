import React from 'react';
import { Composition } from 'remotion';

import { Demo, TOTAL } from './Demo';
import { FPS, HEIGHT, WIDTH } from './theme';

export const Root: React.FC = () => (
  <Composition
    id="Demo"
    component={Demo}
    durationInFrames={TOTAL}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
  />
);
