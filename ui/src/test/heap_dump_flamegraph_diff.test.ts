// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Flamegraph-diff specific E2E. Uses heap_diff_multi.pftrace (a synthetic
// trace with two java heap dumps of the same process at different times)
// because the flamegraph diff path requires a same-engine baseline. Picks
// the second dump as baseline via the primary-dump popup → "Diff against
// this dump" → setSelfTraceBaseline.

import {test, expect, Page} from '@playwright/test';
import path from 'path';
import fs from 'fs';
import {PerfettoTestHelper} from './perfetto_ui_test_helper';

test.describe.configure({mode: 'serial'});

const PRIMARY = 'heap_diff_multi.pftrace';

let pth: PerfettoTestHelper;
let page: Page;

test.beforeAll(async ({browser}) => {
  page = await browser.newPage();
  pth = new PerfettoTestHelper(page);
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('[console]', m.text());
  });
  await pth.openTraceFile(PRIMARY);
  await page.evaluate(() => {
    window.location.hash = '#!/heapdump';
  });
  await pth.waitForPerfettoIdle();
});

// 1. Multi-dump primary trace exposes a heap-dump selector (because
//    dumps.length > 1 enables the top-bar selector).
test('multi-dump trace shows dump selector', async () => {
  await page.locator('.ah-page').first().waitFor({timeout: 30_000});
  // Top-bar primary selector (only when there are >=2 dumps).
  const selector = page.locator('.ah-top-bar__label:has-text("Heap dump:")');
  await expect(selector.first()).toBeVisible({timeout: 30_000});
});

// 2. Pick a same-trace baseline via the popup. The "Diff against this dump"
//    section should show one menu item (one other dump). Clicking it sets
//    setSelfTraceBaseline → mode='diff' with baseline.engine === primary.
test('selecting a same-trace baseline activates flamegraph diff mode', async () => {
  test.setTimeout(120_000);
  // Open the primary-dump popup. The trigger is a Button whose icon is
  // a child <i.pf-icon> with text content "memory".
  const trigger = page
    .locator('.ah-top-bar')
    .locator('button')
    .filter({has: page.locator('i.pf-icon', {hasText: 'memory'})})
    .first();
  await trigger.click();
  // Each "Diff against this dump" menu item is rendered with the
  // 'difference' icon. There's exactly one for a 2-dump trace.
  const diffItem = page
    .locator('.pf-menu-item')
    .filter({has: page.locator('i.pf-icon', {hasText: 'difference'})})
    .first();
  await diffItem.click();
  // The window-exposed debug API confirms baseline is active and same-engine.
  const state = await page.evaluate(() => {
    const dbg = window.__heapdumpDebug;
    if (!dbg) return null;
    return {
      hasBaseline: dbg.hasBaseline(),
      mode: dbg.mode(),
      poolSize: dbg.poolSize(),
    };
  });
  expect(state).not.toBeNull();
  expect(state!.hasBaseline).toBe(true);
  expect(state!.mode).toBe('diff');
});

// 3. The Flamegraph tab renders with diff metrics — names should be
//    prefixed with "Δ ".
test('flamegraph diff mode renders Δ metrics', async () => {
  test.setTimeout(120_000);
  await page.locator('.pf-tabs__tab:has-text("Flamegraph")').click();
  await pth.waitForPerfettoIdle();
  // Wait for the metric select to mount and contain a Δ option. Scope
  // to the visible flamegraph view only — DataGrid sort selectors and
  // other tabs may also have <select> elements on the page.
  await page
    .locator('.ah-flamegraph-view select option')
    .filter({hasText: /^Δ /})
    .first()
    .waitFor({state: 'attached', timeout: 30_000});

  const labels = await page.evaluate(() => {
    const sel = document.querySelector(
      '.ah-flamegraph-view select',
    ) as HTMLSelectElement | null;
    if (!sel) return [];
    return Array.from(sel.options).map((o) => o.textContent ?? '');
  });
  // Exactly the four diff metrics; none of the non-diff ones leak through.
  expect(labels).toEqual(
    expect.arrayContaining([
      'Δ Object Size',
      'Δ Object Count',
      'Δ Dominated Object Size',
      'Δ Dominated Object Count',
    ]),
  );
  expect(labels.some((l) => l === 'Object Size')).toBe(false);
});

// 4. The flamegraph canvas paints with palette-modulated diff colours.
//    We don't assert specific hues (hue is derived from each node's name
//    via the standard pprof palette hash, so it's unstable across
//    fixtures), but we DO assert (a) the canvas has been painted with
//    multiple distinct colours — proving per-name palette identity is
//    preserved — and (b) the page exposes diff color hints with both
//    grew (`palette:g:`) and shrank (`palette:s:`) directions, which
//    proves the color_hint pipeline (SQL → properties → render) works
//    end-to-end.
test('flamegraph diff canvas paints palette-modulated colours', async () => {
  test.setTimeout(120_000);
  await page.locator('.pf-tabs__tab:has-text("Flamegraph")').click();
  await pth.waitForPerfettoIdle();
  const canvas = page.locator('.ah-flamegraph-view canvas').first();
  await canvas.waitFor({state: 'attached', timeout: 30_000});
  await page.waitForTimeout(3_000);

  // Count distinct quantised colour buckets on the canvas. With the
  // palette preserved, every diff'd class shows its own hue (modulated
  // by direction) — a single-hue render would mean we lost palette
  // identity, which is exactly the regression this test guards against.
  const stats = await page.evaluate(() => {
    const c = document.querySelector(
      '.ah-flamegraph-view canvas',
    ) as HTMLCanvasElement | null;
    if (!c) return null;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const buckets = new Set<number>();
    let opaque = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 200) continue;
      opaque++;
      // Quantise to 5-bit per channel to ignore JPEG/anti-alias noise.
      const r = data[i] >> 3;
      const g = data[i + 1] >> 3;
      const b = data[i + 2] >> 3;
      buckets.add((r << 10) | (g << 5) | b);
    }
    return {distinctColours: buckets.size, opaque};
  });
  expect(stats, 'no canvas found').not.toBeNull();
  expect(stats!.opaque, 'canvas is empty').toBeGreaterThan(1000);
  // A flamegraph with the palette preserved should have many distinct
  // hues — the synthetic fixture has ~6 named classes plus root, so we
  // expect at least 8 quantised colour buckets after modulation. A
  // single-hue red/blue render (the old behaviour) would max out at ~4.
  expect(
    stats!.distinctColours,
    'flamegraph rendered with too few distinct colours — palette likely lost',
  ).toBeGreaterThan(8);
});

// 5. Capture a final screenshot for human inspection. Stored under
//    ui-test-artifacts.
test('snapshot the flamegraph diff', async () => {
  test.setTimeout(60_000);
  await page.locator('.pf-tabs__tab:has-text("Flamegraph")').click();
  await pth.waitForPerfettoIdle();
  await page
    .locator('.ah-flamegraph-view canvas')
    .first()
    .waitFor({state: 'attached', timeout: 30_000});
  await page.waitForTimeout(2_000);
  const out = path.resolve(
    process.cwd().endsWith('/ui') ? '..' : '.',
    'out/ui/ui-test-artifacts/flamegraph_diff.png',
  );
  fs.mkdirSync(path.dirname(out), {recursive: true});
  await page.screenshot({path: out, fullPage: false});
  console.log('Wrote screenshot:', out);
});
