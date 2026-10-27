import assert from 'node:assert/strict';
import { test } from 'node:test';

import { snapToGuides } from './guides.js';

const box = (x: number, y: number, w = 100, h = 40) => ({ x, y, w, h });

test('a box near another top edge snaps onto it, and the guide spans both', () => {
  const snap = snapToGuides(box(300, 104), [box(0, 100)], 6);
  assert.equal(snap.dy, -4);
  assert.equal(snap.dx, 0, 'nothing in range on the other axis');
  const top = snap.guides.find((g) => g.axis === 'y' && g.at === 100)!;
  assert.ok(top, 'a horizontal guide on the shared top edge');
  assert.equal(top.from, 0);
  assert.equal(top.to, 400);
});

test('centres and right edges count, even for boxes of different sizes', () => {
  const centre = snapToGuides(box(53, 300, 60), [box(0, 0, 160)], 6);
  assert.equal(centre.dx, 80 - (53 + 30), 'centre onto centre');

  const right = snapToGuides(box(103, 300, 120), [box(0, 0, 227)], 6);
  assert.equal(103 + right.dx + 120, 227, 'right edge onto right edge, off the grid');
});

test('nothing within the threshold means no snap and no guides', () => {
  const snap = snapToGuides(box(300, 300), [box(0, 0)], 6);
  assert.deepEqual(snap, { dx: 0, dy: 0, guides: [], gaps: [] });
});

test('the nearest candidate wins', () => {
  const snap = snapToGuides(box(300, 103), [box(0, 100), box(600, 105)], 6);
  assert.equal(snap.dy, 2, '105 is 2 away, 100 is 3');
});

test('a box in a row snaps to the gap the row already uses', () => {
  // A and B are 60 apart; C dragged to the right of B lands 60 from it.
  const snap = snapToGuides(box(323, 0), [box(0, 0), box(160, 0)], 6);
  assert.equal(323 + snap.dx, 320);
  assert.ok(snap.gaps.some((g) => g.axis === 'x' && g.from === 100 && g.to === 160), 'the reference gap');
  assert.ok(snap.gaps.some((g) => g.axis === 'x' && g.from === 260 && g.to === 320), 'the new gap');
});

test('a box between two others snaps to the middle', () => {
  const snap = snapToGuides(box(197, 0), [box(0, 0), box(400, 0)], 6);
  assert.equal(197 + snap.dx, 200, "100 either side");
  assert.equal(snap.gaps.length, 2);
});

test('spacing works down a column too', () => {
  const snap = snapToGuides(box(0, 202), [box(0, 0), box(0, 100)], 6);
  // 0..40, 100..140 is a 60 gap; 140 + 60 = 200. Left edges already line up, so dx is 0.
  assert.equal(202 + snap.dy, 200);
  assert.ok(snap.gaps.some((g) => g.axis === 'y' && g.from === 140 && g.to === 200));
});

test('boxes outside the row do not set the spacing', () => {
  const snap = snapToGuides(box(323, 0), [box(0, 500), box(160, 500)], 6);
  assert.equal(snap.gaps.length, 0);
});
