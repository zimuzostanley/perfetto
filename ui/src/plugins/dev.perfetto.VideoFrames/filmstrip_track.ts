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

import {Time, time} from '../../base/time';
import {Trace} from '../../public/trace';
import {
  TrackRenderContext,
  TrackRenderer,
  TrackMouseEvent,
} from '../../public/track';
import {BLOB, LONG, NUM} from '../../trace_processor/query_result';
import {TrackEventSelection} from '../../public/selection';
import {TrackEventDetailsPanel} from '../../public/details_panel';
import {SourceDataset} from '../../trace_processor/dataset';
import {VideoFramePanel} from './video_panel';

const TRACK_HEIGHT = 80;
const THUMB_PAD = 2;

interface FrameEntry {
  id: number;
  ts: bigint;
}

// Decoded image cache. Keyed by frame id.
const imageCache = new Map<number, HTMLImageElement>();
const loadingIds = new Set<number>();

export class FilmstripTrack implements TrackRenderer {
  readonly rootTableName = 'slice';
  private readonly trace: Trace;
  private readonly uri: string;
  private entries: FrameEntry[] = [];
  private loaded = false;

  constructor(trace: Trace, uri: string) {
    this.trace = trace;
    this.uri = uri;
    this.loadEntries();
  }

  private async loadEntries() {
    const res = await this.trace.engine.query(`
      INCLUDE PERFETTO MODULE android.video_frames;
      SELECT id, ts FROM android_video_frames ORDER BY ts
    `);
    const it = res.iter({id: NUM, ts: LONG});
    for (; it.valid(); it.next()) {
      this.entries.push({id: it.id, ts: it.ts});
    }
    this.loaded = true;
  }

  getHeight(): number {
    return TRACK_HEIGHT;
  }

  render(ctx: TrackRenderContext): void {
    if (!this.loaded || this.entries.length === 0) return;

    const {timescale, size, visibleWindow} = ctx;
    const c = ctx.ctx;
    const startT = visibleWindow.start.toTime('floor');
    const endT = visibleWindow.end.toTime('ceil');
    const thumbH = size.height - THUMB_PAD * 2;
    const thumbW = Math.round(thumbH * (16 / 9));
    const minGap = thumbW + THUMB_PAD;

    const lo = this.lowerBound(startT);
    const hi = this.upperBound(endT);
    let lastPx = -Infinity;

    for (let i = lo; i < hi; i++) {
      const e = this.entries[i];
      const px = timescale.timeToPx(Time.fromRaw(e.ts));
      if (px - lastPx < minGap) continue;

      const x = Math.round(px);
      const y = THUMB_PAD;

      // Background.
      c.fillStyle = '#e0e0e0';
      c.fillRect(x, y, thumbW, thumbH);

      const img = imageCache.get(e.id);
      if (img && img.complete && img.naturalWidth > 0) {
        c.drawImage(img, x, y, thumbW, thumbH);
        c.strokeStyle = '#bbb';
        c.lineWidth = 1;
        c.strokeRect(x, y, thumbW, thumbH);
      } else {
        this.loadImage(e.id);
        c.fillStyle = '#999';
        c.font = '10px Roboto Condensed';
        c.textAlign = 'center';
        c.fillText('...', x + thumbW / 2, y + thumbH / 2 + 3);
        c.textAlign = 'start';
      }
      lastPx = px;
    }
  }

  private async loadImage(id: number) {
    if (imageCache.has(id) || loadingIds.has(id)) return;
    loadingIds.add(id);
    try {
      const res = await this.trace.engine.query(
        `SELECT video_frame_image(${id}) AS img`,
      );
      const row = res.firstRow({img: BLOB});
      if (row.img.length === 0) return;
      const imgBlob = new Blob([row.img], {type: 'image/jpeg'});
      const url = URL.createObjectURL(imgBlob);
      const img = new Image();
      img.src = url;
      img.onload = () => {
        imageCache.set(id, img);
        URL.revokeObjectURL(url);
        this.trace.raf.scheduleCanvasRedraw();
      };
    } finally {
      loadingIds.delete(id);
    }
  }

  onMouseClick(event: TrackMouseEvent): boolean {
    const entry = this.findNearest(event);
    if (!entry) return false;
    this.trace.selection.selectTrackEvent(this.uri, entry.id);
    return true;
  }

  detailsPanel(_sel: TrackEventSelection): TrackEventDetailsPanel | undefined {
    return new VideoFramePanel(this.trace, this.entries);
  }

  getDataset(): SourceDataset | undefined {
    return new SourceDataset({
      schema: {id: NUM, ts: LONG, frame_number: NUM},
      src: 'android_video_frames',
    });
  }

  private findNearest(event: TrackMouseEvent): FrameEntry | undefined {
    if (this.entries.length === 0) return undefined;
    const t = event.timescale.pxToHpTime(event.x).toTime('round');
    // Binary search for the closest entry.
    let lo = 0;
    let hi = this.entries.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (this.entries[m].ts < t) lo = m + 1;
      else hi = m;
    }
    // lo is the first entry >= t. Check lo and lo-1 for closest.
    let best = this.entries[lo];
    if (lo > 0) {
      const prev = this.entries[lo - 1];
      const dLo = BigInt(best.ts) - BigInt(t);
      const dPrev = BigInt(t) - BigInt(prev.ts);
      if (dPrev < dLo) best = prev;
    }
    return best;
  }

  private lowerBound(t: time): number {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (this.entries[m].ts < t) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  private upperBound(t: time): number {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (this.entries[m].ts <= t) lo = m + 1;
      else hi = m;
    }
    return lo;
  }
}
