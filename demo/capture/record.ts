import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BrowserContext, Page } from 'playwright-core';

import { ALL, LINKS, PLATFORM } from './graphs.js';
import {
  beat,
  centreOf,
  CURSOR_SCRIPT,
  dragSlowly,
  glide,
  hold,
  nodeBox,
  settle,
  typeSlowly,
} from './shot.js';
import { API, CANVAS, resolveFfmpeg, SHOT, startSet, type Set } from './stack.js';

/**
 * Film the real application.
 *
 * Every shot below drives the canvas the way a person would — real clicks, real typing,
 * real websocket round trips to a real server — and every "agent" action goes over the same
 * HTTP surface the MCP server uses. Nothing here is mocked, which is the only reason the
 * film is worth anything: the canvas has no error surface, so a staged recreation could
 * look perfect while the product was broken.
 */

const publicDir = fileURLToPath(new URL('../public', import.meta.url));

/** Playwright only writes webm. Remotion seeks per frame, and h264 seeks accurately. */
function toMp4(webm: string, name: string) {
  const out = join(publicDir, `${name}.mp4`);
  const ffmpeg = resolveFfmpeg();
  execFileSync(ffmpeg, [
    '-y', '-i', webm,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17',
    // yuv420p and an even frame size, or QuickTime and Chromium disagree about the file.
    '-pix_fmt', 'yuv420p',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-movflags', '+faststart',
    out,
  ], {
    stdio: 'ignore',
    /*
     * Run it from its own directory.
     *
     * The binary links its dylibs by bare name — `Library not loaded: libavdevice.dylib` —
     * and the loader resolves those against the working directory. Launched from anywhere
     * else it dies with SIGABRT and no stderr at all, which reads like a corrupt binary
     * rather than a path problem. Every other argument here is absolute for that reason.
     */
    cwd: dirname(ffmpeg),
  });
  return out;
}

/** `npx tsx capture/record.ts lens edit` films only those, so one bad shot is cheap to redo. */
const wanted = process.argv.slice(2);
const skip = (name: string) => wanted.length > 0 && !wanted.includes(name);

/** One shot: a fresh context so each clip is its own file, with the cursor injected. */
async function shoot(
  set: Set,
  name: string,
  body: (page: Page) => Promise<void>,
): Promise<void> {
  if (skip(name)) {
    console.log(`  ${name} — skipped`);
    return;
  }
  const raw = join(publicDir, '.raw', name);
  /*
   * Scale 1, matching the `--force-device-scale-factor=1` the browser was launched with.
   *
   * A context asking for 2 while the browser is pinned to 1 films a canvas that decays: the
   * parent graph's edges disappear after a second or so and the whole canvas goes blank a
   * few seconds later, while the DOM and the viewport transform stay perfectly correct. It
   * bought nothing either way — the footage is shown 1:1 in the composition, so rastering
   * at 2x only to downsample was pure work.
   */
  const context: BrowserContext = await set.browser.newContext({
    viewport: SHOT,
    deviceScaleFactor: 1,
    recordVideo: { dir: raw, size: SHOT },
  });
  await context.addInitScript(CURSOR_SCRIPT);
  const page = await context.newPage();

  await page.goto(CANVAS, { waitUntil: 'domcontentloaded' });
  await hold('a live connection', async () => (await page.locator('.status.ok').count()) > 0);

  try {
    await body(page);
  } finally {
    const video = page.video();
    await context.close(); // finalises the webm
    if (video) {
      const path = await video.path();
      const out = toMp4(path, name);
      await rm(raw, { recursive: true, force: true });
      console.log(`  ${name}.mp4`);
    }
  }
}

const setActive = (name: string) =>
  fetch(`${API}/api/diagrams/active`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });

async function main() {
  const set = await startSet();
  console.log('stack up');

  try {
    // ---- Setup: four empty diagrams, then the structure, then the links between them.
    for (const d of ALL) await set.createDiagram(d.name);
    for (const d of ALL) {
      await set.op({ op: 'generate_graph', nodes: d.nodes, edges: d.edges, replace: true }, d.name);
    }
    for (const l of LINKS) {
      await set.op({ op: 'update_node', id: l.node, subcanvas: l.subcanvas }, l.diagram);
    }
    /*
     * Wipe the top level again, because shot one has to film it arriving.
     *
     * Only when shot one is actually being filmed. Re-filming a later shot on its own would
     * otherwise leave every downstream shot staring at an empty canvas, which surfaces as a
     * timeout on a node selector rather than as "you skipped the shot that builds the graph".
     */
    if (!skip('generate')) {
      await set.op({ op: 'generate_graph', nodes: [], edges: [], replace: true }, PLATFORM.name);
    }
    await setActive(PLATFORM.name);
    console.log('fixtures ready');

    // ---- Shot 1: one op, thirty-one nodes, laid out by dagre.
    await shoot(set, 'generate', async (page) => {
      await settle(page);
      await beat(900);
      await set.op(
        { op: 'generate_graph', nodes: PLATFORM.nodes, edges: PLATFORM.edges, replace: true },
        PLATFORM.name,
      );
      await hold(
        'the platform to render',
        async () => (await page.locator('.react-flow__node').count()) >= 30,
      );
      await settle(page);
      await beat(1800);
      // Re-apply the subcanvas links so the lens badges are visible from here on.
      for (const l of LINKS.filter((l) => l.diagram === PLATFORM.name)) {
        await set.op({ op: 'update_node', id: l.node, subcanvas: l.subcanvas }, l.diagram);
      }
      await beat(1200);
    });

    // ---- Shot 2: three levels deep and back, through the lens.
    await shoot(set, 'lens', async (page) => {
      await settle(page);
      const payments = centreOf(await nodeBox(page, 'payments'));
      await glide(page, payments, { x: payments.x - 260, y: payments.y + 180 }, 26);
      await beat(500);

      await page.locator('.react-flow__node[data-id="payments"] .cp-lens').click();
      await hold('the panel to open', async () =>
        (await page.locator('.lens-panel .react-flow__node').count()) >= 10,
      );
      await beat(2200);

      // Deeper: the adapter inside the payment service.
      const adapter = await page
        .locator('.lens-panel .react-flow__node[data-id="adapter"]')
        .boundingBox();
      if (adapter) {
        const c = centreOf(adapter);
        await glide(page, c, payments, 24);
        await beat(400);
        await page
          .locator('.lens-panel .react-flow__node[data-id="adapter"] .cp-lens')
          .click({ force: true });
        await hold('the trail to reach three', async () =>
          (await page.locator('.lens-panel .lens-crumb').count()) >= 2,
        );
        await beat(2400);
      }

      // Walk back up by clicking the first crumb.
      const crumb = await page.locator('.lens-panel .lens-crumb').first().boundingBox();
      if (crumb) {
        await glide(page, centreOf(crumb), undefined, 18);
        await beat(350);
        await page.locator('.lens-panel .lens-crumb').first().click();
        await beat(1800);
      }
      await page.locator('.lens-close').click({ force: true });
      await beat(900);
    });

    // ---- Shot 3: the human edits. This is the request.
    const beforeEdits = (await set.graph(PLATFORM.name)).rev;
    await shoot(set, 'edit', async (page) => {
      await settle(page);
      await beat(700);

      // Drag a node somewhere deliberate.
      const notify = await nodeBox(page, 'notify');
      const from = centreOf(notify);
      await dragSlowly(page, from, { x: from.x + 190, y: from.y + 120 });
      await beat(600);

      // Create a node by double-clicking the pane, and name it inline.
      const pane = await page.locator('.react-flow__pane').boundingBox();
      if (pane) {
        const spot = { x: pane.x + pane.width * 0.28, y: pane.y + pane.height * 0.82 };
        await glide(page, spot, from, 22);
        await beat(300);
        await page.mouse.dblclick(spot.x, spot.y);
        await hold('the inline input', async () =>
          (await page.locator('.cp-node-input').count()) > 0,
        );
        await beat(400);
        await typeSlowly(page, 'Fraud check');
        await beat(500);
        await page.keyboard.press('Enter');
        await hold('the new node to reach the server', async () => {
          const g = await set.graph(PLATFORM.name);
          return g.nodes.some((n: any) => n.data.label === 'Fraud check');
        });
        await beat(900);
      }

      // Colour the payment service red: "this one is the problem".
      const pay = centreOf(await nodeBox(page, 'payments'));
      await glide(page, pay, undefined, 22);
      await page.locator('.react-flow__node[data-id="payments"]').click();
      await beat(500);
      const swatch = page.locator('.swatch[aria-label="red"]');
      const sbox = await swatch.boundingBox();
      if (sbox) {
        await glide(page, centreOf(sbox), pay, 24);
        await beat(300);
        await swatch.click();
        await beat(1500);
      }
    });

    // The feed the agent would read: the human's changes, layout noise filtered out.
    const feed = await set.changes(`?since=${beforeEdits}`);
    await writeFile(
      join(publicDir, 'changes.json'),
      JSON.stringify(
        {
          since: beforeEdits,
          entries: (feed.entries ?? []).map((e: any) => ({
            kind: e.kind,
            actor: e.actor,
            op: e.op,
          })),
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`  changes.json (${feed.entries?.length ?? 0} entries)`);

    // ---- Shot 4: the agent answers, and does not touch the arrangement.
    await shoot(set, 'invariant', async (page) => {
      await settle(page);
      await beat(1100);
      // Shot three creates this by hand. Filmed on its own, this shot has to stand it up.
      const graph = await set.graph(PLATFORM.name);
      if (!graph.nodes.some((n: any) => n.id === 'fraud-check')) {
        await set.op({ op: 'add_node', label: 'Fraud check', near: 'payments' }, PLATFORM.name);
      }
      await set.op({ op: 'add_node', label: 'Fraud rules engine', near: 'payments' }, PLATFORM.name);
      await beat(700);
      await set.op({ op: 'add_edge', source: 'fraud-check', target: 'fraud-rules-engine' }, PLATFORM.name);
      await beat(700);
      await set.op({ op: 'add_node', label: 'Decision audit log', near: 'payments' }, PLATFORM.name);
      await beat(600);
      await set.op({ op: 'add_edge', source: 'fraud-rules-engine', target: 'decision-audit-log' }, PLATFORM.name);
      await beat(2200);
    });

    console.log('\nfootage written to demo/public/');
  } finally {
    await set.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
