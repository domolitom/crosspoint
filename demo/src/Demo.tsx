import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';

import { Backdrop } from './Backdrop';
import { Caption, Code, Scene, Tint } from './Caption';
import { Feed } from './scenes/Feed';
import { Screen } from './Screen';
import { theme } from './theme';
import { Rise, Subtitle, Wordmark } from './Title';

/**
 * The film.
 *
 * One argument, in order: describing a system in prose is lossy, a graph is not, and the
 * graph is editable *by both sides* — so the edit becomes the request. Every screen here is
 * the real application, recorded by `npm run capture`.
 *
 * Clip lengths are the measured durations of that footage at 30fps. They are named rather
 * than inlined because a re-capture changes them, and a mismatch shows up as a frozen last
 * frame — which looks like a rendering bug rather than a timing one.
 */
const CLIP = {
  generate: 149, // 4.96s
  lens: 347, // 11.56s
  edit: 306, // 10.20s
  invariant: 193, // 6.44s
};

const OPEN = 96;
const PROBLEM = 126;
const FEED = 156;
const CLOSE = 126;

const at = (() => {
  let cursor = 0;
  return (length: number) => {
    const from = cursor;
    cursor += length;
    return { from, durationInFrames: length };
  };
})();

const open = at(OPEN);
const problem = at(PROBLEM);
const generate = at(CLIP.generate);
const lens = at(CLIP.lens);
const edit = at(CLIP.edit);
const feed = at(FEED);
const invariant = at(CLIP.invariant);
const close = at(CLOSE);

export const TOTAL =
  OPEN + PROBLEM + CLIP.generate + CLIP.lens + CLIP.edit + FEED + CLIP.invariant + CLOSE;

export const Demo: React.FC = () => (
  <AbsoluteFill style={{ background: theme.bg }}>
    <Backdrop />

    <Sequence {...open}>
      <Scene durationInFrames={open.durationInFrames}>
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', gap: 20 }}>
          <Wordmark />
          <Subtitle delay={9}>A visual channel in the conversation.</Subtitle>
        </AbsoluteFill>
      </Scene>
    </Sequence>

    <Sequence {...problem}>
      <Scene durationInFrames={problem.durationInFrames}>
        <AbsoluteFill
          style={{
            justifyContent: 'center',
            alignItems: 'center',
            gap: 26,
            padding: '0 220px',
            textAlign: 'center',
          }}
        >
          <Rise distance={18}>
            <div
              style={{
                fontFamily: theme.sans,
                fontSize: 52,
                fontWeight: 500,
                color: theme.ink,
                letterSpacing: -1.2,
                lineHeight: 1.2,
              }}
            >
              You describe a system in prose.
              <br />
              The agent guesses. You correct it — in more prose.
            </div>
          </Rise>
          <Rise delay={26} distance={14}>
            <div style={{ fontFamily: theme.sans, fontSize: 34, color: theme.inkDim }}>
              Crosspoint replaces that loop with a picture you can both edit.
            </div>
          </Rise>
        </AbsoluteFill>
      </Scene>
    </Sequence>

    <Sequence {...generate}>
      <Scene durationInFrames={generate.durationInFrames}>
        <Screen src="generate.mp4" />
        <Caption kicker="you ask">
          Thirty-one nodes, <Code>generate_graph</Code>, one op.
        </Caption>
      </Scene>
    </Sequence>

    <Sequence {...lens}>
      <Scene durationInFrames={lens.durationInFrames}>
        <Screen src="lens.mp4" />
        {/* Two captions, because the shot has two beats: open a subcanvas, then go deeper. */}
        <Sequence durationInFrames={170}>
          <Caption kicker="detail lives behind a node">
            Any node can hold another diagram — fully editable, in a lens beside it.
          </Caption>
        </Sequence>
        <Sequence from={170}>
          <Caption kicker="three levels deep">
            The trail remembers the way back. <Code>payments</Code> →{' '}
            <Code>psp-adapter</Code>
          </Caption>
        </Sequence>
      </Scene>
    </Sequence>

    <Sequence {...edit}>
      <Scene durationInFrames={edit.durationInFrames}>
        <Screen src="edit.mp4" />
        <Sequence durationInFrames={150}>
          <Caption kicker="you edit">
            Drag it. Double-click to add a step. Name it inline — no dialogs.
          </Caption>
        </Sequence>
        <Sequence from={150}>
          <Caption kicker="the edit is the request">
            Colour is a statement: <Tint color={theme.red}>this one is broken</Tint>.
          </Caption>
        </Sequence>
      </Scene>
    </Sequence>

    <Sequence {...feed}>
      <Scene durationInFrames={feed.durationInFrames}>
        <Feed />
      </Scene>
    </Sequence>

    <Sequence {...invariant}>
      <Scene durationInFrames={invariant.durationInFrames}>
        <Screen src="invariant.mp4" />
        <Caption kicker="the agent answers">
          It adds what you asked for — and cannot move what you arranged.
        </Caption>
      </Scene>
    </Sequence>

    <Sequence {...close}>
      <Scene durationInFrames={close.durationInFrames}>
        <AbsoluteFill
          style={{ justifyContent: 'center', alignItems: 'center', gap: 22, textAlign: 'center' }}
        >
          <Rise distance={20}>
            <div
              style={{
                fontFamily: theme.sans,
                fontSize: 64,
                fontWeight: 600,
                color: theme.ink,
                letterSpacing: -1.6,
              }}
            >
              The picture is how you talk to the agent.
            </div>
          </Rise>
          <Rise delay={22} distance={14}>
            <div style={{ fontFamily: theme.mono, fontSize: 28, color: theme.inkDim }}>
              github.com/domolitom/crosspoint
            </div>
          </Rise>
        </AbsoluteFill>
      </Scene>
    </Sequence>
  </AbsoluteFill>
);
