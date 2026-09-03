import type { Page } from 'playwright-core';

/**
 * A synthetic cursor, drawn by the page itself.
 *
 * Playwright's mouse leaves no pointer in a recording, so a drag films as a node sliding
 * around by itself — which reads as an animation rather than as someone using the app. The
 * events it dispatches are real, though, so a listener in the page can draw one. Injected
 * with `addInitScript` so it survives the reloads between shots.
 */
export const CURSOR_SCRIPT = `(() => {
  const dot = document.createElement('div');
  Object.assign(dot.style, {
    position: 'fixed', width: '20px', height: '20px', borderRadius: '50%',
    background: 'rgba(37,99,235,0.30)', border: '2px solid rgba(255,255,255,0.95)',
    boxShadow: '0 2px 12px rgba(15,23,42,0.40)', pointerEvents: 'none',
    zIndex: '2147483647', transform: 'translate(-50%,-50%)',
    left: '-200px', top: '-200px',
    transition: 'width 90ms ease, height 90ms ease, background 90ms ease',
  });
  const attach = () => document.body && document.body.appendChild(dot);
  if (document.body) attach(); else addEventListener('DOMContentLoaded', attach);
  addEventListener('mousemove', (e) => {
    dot.style.left = e.clientX + 'px';
    dot.style.top = e.clientY + 'px';
  }, true);
  addEventListener('mousedown', () => {
    Object.assign(dot.style, { width: '13px', height: '13px', background: 'rgba(37,99,235,0.8)' });
  }, true);
  addEventListener('mouseup', () => {
    Object.assign(dot.style, { width: '20px', height: '20px', background: 'rgba(37,99,235,0.30)' });
  }, true);
})();`;

export const beat = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until a predicate holds, so a shot never films a half-rendered canvas. */
export async function hold(label: string, fn: () => Promise<boolean>, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await beat(50);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

/** React Flow animates `fitView`; filming before it settles films the camera moving. */
export async function settle(page: Page) {
  let previous: string | null = null;
  let stable = 0;
  await hold('the viewport to stop moving', async () => {
    const now = await page.evaluate(() => {
      const vp = document.querySelector('.react-flow__viewport');
      return vp ? getComputedStyle(vp).transform : 'none';
    });
    stable = now === previous ? stable + 1 : 0;
    previous = now;
    return stable >= 4;
  });
  await beat(150);
}

export async function nodeBox(page: Page, id: string) {
  const box = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
  if (!box) throw new Error(`node ${id} has no box`);
  return box;
}

export const centreOf = (b: { x: number; y: number; width: number; height: number }) => ({
  x: b.x + b.width / 2,
  y: b.y + b.height / 2,
});

/**
 * Move the pointer the way a hand does: many small steps, eased.
 *
 * Playwright's own `steps` option interpolates linearly, which films as a robot. The ease
 * matters more than it sounds — a constant-velocity cursor is the single strongest tell
 * that a screen recording is synthetic.
 */
export async function glide(
  page: Page,
  to: { x: number; y: number },
  from?: { x: number; y: number },
  frames = 24,
) {
  const start = from ?? to;
  for (let i = 1; i <= frames; i++) {
    const t = i / frames;
    const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(
      start.x + (to.x - start.x) * ease,
      start.y + (to.y - start.y) * ease,
    );
    await beat(12);
  }
}

export async function dragSlowly(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  await glide(page, from, { x: from.x - 90, y: from.y - 60 }, 18);
  await beat(220);
  await page.mouse.down();
  await beat(160);
  await glide(page, to, from, 30);
  await beat(200);
  await page.mouse.up();
  await beat(320);
}

/** Type at a human cadence rather than instantly. */
export async function typeSlowly(page: Page, text: string, delay = 55) {
  await page.keyboard.type(text, { delay });
}
