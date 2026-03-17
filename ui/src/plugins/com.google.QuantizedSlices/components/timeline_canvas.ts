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

import {MergedSlice} from '../models/types';
import {stateColor, stateLabel, nameColor, isDark} from '../utils/colors';
import {fmtDur, fmtPct} from '../utils/format';

const LONG_PKG_PREFIX = 'com.redfin.android.core.activity.launch.deeplink.';

export interface HitRect {
  x: number;
  y: number;
  w: number;
  h: number;
  d: MergedSlice;
}

/**
 * Parameters for rendering a mini canvas timeline.
 */
export interface RenderParams {
  seq: MergedSlice[];
  totalDur: number;
  highlightIdx?: number;
}

/**
 * Renders a compact two-row timeline onto a canvas element.
 * Top row: thread state colors. Bottom row: slice name colors.
 * Returns hit-test rectangles for tooltip interaction.
 */
export function renderMiniCanvas(
  canvas: HTMLCanvasElement,
  params: RenderParams,
): HitRect[] {
  const {seq, totalDur, highlightIdx} = params;
  const dpr = window.devicePixelRatio || 1;
  const parent = canvas.parentElement;
  if (!parent) return [];
  const cssW = parent.clientWidth - 16;
  const cssH = 30;
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];
  ctx.scale(dpr, dpr);

  const dark = isDark();
  ctx.fillStyle = dark ? '#17171a' : '#ffffff';
  ctx.fillRect(0, 0, cssW, cssH);

  const dimmed = highlightIdx != null;
  const hits: HitRect[] = [];
  const scale = cssW / totalDur;
  for (let i = 0; i < seq.length; i++) {
    const d = seq[i];
    const x = d.tsRel * scale;
    const w = Math.max(d.dur * scale, 0.5);
    ctx.globalAlpha = dimmed && i !== highlightIdx ? 0.25 : 1;
    ctx.fillStyle = stateColor(d);
    ctx.fillRect(x, 0, w, 12);
    ctx.fillStyle = d.name ? nameColor(d.name) : dark ? '#1c1c26' : '#ede9e2';
    ctx.fillRect(x, 14, w, 16);
    hits.push({x, y: 0, w, h: cssH, d});
  }
  ctx.globalAlpha = 1;
  return hits;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Positions and populates the `.qs-tooltip` element based on a mouse event
 * over a timeline canvas. Finds the hovered slice from `hits` and renders
 * its details.
 */
export function showTooltip(
  e: MouseEvent,
  hits: HitRect[],
  totalDur: number,
): void {
  const tip = document.querySelector<HTMLElement>('.qs-tooltip');
  if (!tip) return;
  const canvas = e.target as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const hit = hits
    .slice()
    .reverse()
    .find((r) => mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h);

  if (!hit) {
    tip.style.display = 'none';
    return;
  }

  const d = hit.d;
  const rows: Array<[string, string, string | null]> = [
    ['state', stateLabel(d), stateColor(d)],
    ['io_wait', d.io_wait !== null ? String(d.io_wait) : '\u2014', null],
    ['blocked', d.blocked_function ?? '\u2014', null],
    ['dur', fmtDur(d.dur) + '  (' + fmtPct(d.dur, totalDur) + ')', null],
    ['start', '+' + fmtDur(d.tsRel), null],
    ['depth', d.depth !== null ? String(d.depth) : '\u2014', null],
    ['\u00d7merged', String(d._merged), null],
  ];

  const nameDisplay = escapeHtml(
    (d.name ?? 'null').replace(LONG_PKG_PREFIX, ''),
  );

  tip.innerHTML =
    `<div class="qs-tooltip-name">${nameDisplay}</div>` +
    '<div class="qs-tooltip-grid">' +
    rows
      .map(
        ([k, v, col]) =>
          `<span class="qs-tooltip-key">${escapeHtml(k)}</span>` +
          `<span class="qs-tooltip-val"${col ? ` style="color:${escapeHtml(col)}"` : ''}>${escapeHtml(v)}</span>`,
      )
      .join('') +
    '</div>';

  tip.style.display = 'block';
  const TW = tip.offsetWidth || 300;
  const TH = tip.offsetHeight || 160;
  const VW = window.innerWidth;
  const VH = window.innerHeight;
  let tx = e.clientX + 16;
  let ty = e.clientY - 8;
  if (tx + TW > VW - 8) tx = e.clientX - TW - 12;
  if (ty + TH > VH - 8) ty = VH - TH - 8;
  tip.style.left = tx + 'px';
  tip.style.top = ty + 'px';
}

/**
 * Hides the `.qs-tooltip` element.
 */
export function hideTooltip(): void {
  const tip = document.querySelector<HTMLElement>('.qs-tooltip');
  if (tip) tip.style.display = 'none';
}
