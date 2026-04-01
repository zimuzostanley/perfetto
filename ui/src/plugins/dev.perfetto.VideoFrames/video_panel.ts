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

import m from 'mithril';
import {BLOB} from '../../trace_processor/query_result';
import {Trace} from '../../public/trace';
import {TrackEventDetailsPanel} from '../../public/details_panel';
import {TrackEventSelection} from '../../public/selection';

interface FrameEntry {
  id: number;
  ts: bigint;
}

export class VideoFramePanel implements TrackEventDetailsPanel {
  private trace: Trace;
  private entries: FrameEntry[];
  private imageUrl?: string;
  private currentIdx = 0;
  private playing = false;
  private playTimer?: ReturnType<typeof setInterval>;

  constructor(trace: Trace, entries: FrameEntry[]) {
    this.trace = trace;
    this.entries = entries;
  }

  async load(sel: TrackEventSelection) {
    this.stop();
    const idx = this.entries.findIndex((e) => e.id === sel.eventId);
    if (idx >= 0) {
      this.currentIdx = idx;
      await this.loadFrame(idx);
    }
  }

  private async loadFrame(idx: number) {
    if (idx < 0 || idx >= this.entries.length) return;
    this.currentIdx = idx;

    if (this.imageUrl) {
      URL.revokeObjectURL(this.imageUrl);
      this.imageUrl = undefined;
    }

    const id = this.entries[idx].id;
    const res = await this.trace.engine.query(
      `SELECT video_frame_image(${id}) AS img`,
    );
    const row = res.firstRow({img: BLOB});
    if (row.img.length > 0) {
      const imgBlob = new Blob([row.img], {type: 'image/jpeg'});
      this.imageUrl = URL.createObjectURL(imgBlob);
    }
    m.redraw();
  }

  render() {
    const total = this.entries.length;
    const idx = this.currentIdx;

    return m(
      '.pf-video-frame-panel',
      m(
        '.pf-video-frame-controls',
        m(
          'button',
          {
            onclick: () => this.prev(),
            disabled: idx <= 0,
          },
          '\u25C0',
        ),
        m(
          'button',
          {
            onclick: () => this.togglePlay(),
          },
          this.playing ? '\u23F8' : '\u25B6',
        ),
        m(
          'button',
          {
            onclick: () => this.next(),
            disabled: idx >= total - 1,
          },
          '\u25B6',
        ),
        m('span.pf-video-frame-counter', `${idx + 1} / ${total}`),
      ),
      this.imageUrl
        ? m('img.pf-video-frame-image', {src: this.imageUrl})
        : m('div.pf-video-frame-loading', 'Loading...'),
    );
  }

  private prev() {
    if (this.currentIdx > 0) {
      this.loadFrame(this.currentIdx - 1);
    }
  }

  private next() {
    if (this.currentIdx < this.entries.length - 1) {
      this.loadFrame(this.currentIdx + 1);
    }
  }

  private togglePlay() {
    if (this.playing) {
      this.stop();
    } else {
      this.play();
    }
    m.redraw();
  }

  private play() {
    this.playing = true;
    this.playTimer = setInterval(() => {
      if (this.currentIdx < this.entries.length - 1) {
        this.loadFrame(this.currentIdx + 1);
      } else {
        this.stop();
        m.redraw();
      }
    }, 33); // ~30fps playback
  }

  private stop() {
    this.playing = false;
    if (this.playTimer) {
      clearInterval(this.playTimer);
      this.playTimer = undefined;
    }
  }
}
