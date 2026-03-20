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
import {Button} from '../../widgets/button';

const BYTES_PER_ROW = 16;
const ROW_HEIGHT = 20;
const OVERSCAN = 10;
const MIN_STRING_LEN = 4;
const MAX_STRINGS = 5000;

// ── Region mapping ──────────────────────────────────────────────────────────

interface RegionSpan {
  offsetStart: number;
  offsetEnd: number;
  vmaBase: number;
}

function buildRegionMap(
  regions: {addrStart: string; addrEnd: string}[],
): RegionSpan[] {
  const map: RegionSpan[] = [];
  let offset = 0;
  for (const r of regions) {
    const start = parseInt(r.addrStart, 16);
    const end = parseInt(r.addrEnd, 16);
    const size = end - start;
    map.push({offsetStart: offset, offsetEnd: offset + size, vmaBase: start});
    offset += size;
  }
  return map;
}

function offsetToVmaAddr(
  offset: number,
  regionMap: RegionSpan[],
): number | undefined {
  for (const r of regionMap) {
    if (offset >= r.offsetStart && offset < r.offsetEnd) {
      return r.vmaBase + (offset - r.offsetStart);
    }
  }
  return undefined;
}

// ── String extraction ───────────────────────────────────────────────────────

interface ExtractedString {
  offset: number;
  str: string;
}

function extractStrings(
  data: Uint8Array,
  minLen = MIN_STRING_LEN,
): ExtractedString[] {
  const results: ExtractedString[] = [];
  let current = '';
  let startOffset = 0;
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b >= 0x20 && b < 0x7f) {
      if (current.length === 0) startOffset = i;
      current += String.fromCharCode(b);
    } else {
      if (current.length >= minLen) {
        results.push({offset: startOffset, str: current});
      }
      current = '';
    }
  }
  if (current.length >= minLen) {
    results.push({offset: startOffset, str: current});
  }
  return results;
}

// ── Row formatting ──────────────────────────────────────────────────────────

function formatRow(
  data: Uint8Array,
  offset: number,
  totalLen: number,
  vmaAddr?: number,
  addrWidth?: number,
): string {
  const hex: string[] = [];
  const ascii: string[] = [];
  for (let j = 0; j < BYTES_PER_ROW; j++) {
    const pos = offset + j;
    if (pos < totalLen) {
      const b = data[pos];
      hex.push(b.toString(16).padStart(2, '0'));
      ascii.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.');
    } else {
      hex.push('  ');
      ascii.push(' ');
    }
  }
  const fileOffset = offset.toString(16).padStart(8, '0');
  const hexStr = `${hex.slice(0, 8).join(' ')}  ${hex.slice(8).join(' ')}`;
  const asciiStr = `|${ascii.join('')}|`;
  if (vmaAddr !== undefined) {
    const w = addrWidth ?? 12;
    const addr = vmaAddr.toString(16).padStart(w, '0');
    return `${addr}  ${fileOffset}  ${hexStr}  ${asciiStr}`;
  }
  return `${fileOffset}  ${hexStr}  ${asciiStr}`;
}

// ── Component ───────────────────────────────────────────────────────────────

interface HexViewAttrs {
  buffer: ArrayBuffer;
  name: string;
  regions?: {addrStart: string; addrEnd: string}[];
  initialStringFilter?: string;
  onClose?: () => void;
}

export class HexView implements m.ClassComponent<HexViewAttrs> {
  private scrollTop = 0;
  private containerHeight = 600;
  private showStrings = false;
  private stringFilter = '';
  private stringMinLen = MIN_STRING_LEN;
  private highlightRow: number | null = null;
  private scrollNode: HTMLDivElement | null = null;
  private highlightTimer: ReturnType<typeof setTimeout> | undefined;
  private appliedFilter: string | undefined;

  // Cached
  private cachedBuffer: ArrayBuffer | undefined;
  private cachedData: Uint8Array | undefined;
  private cachedRegions: {addrStart: string; addrEnd: string}[] | undefined;
  private cachedRegionMap: RegionSpan[] | undefined;
  private cachedStringsBuffer: ArrayBuffer | undefined;
  private cachedStrings: ExtractedString[] = [];

  private getData(buffer: ArrayBuffer): Uint8Array {
    if (buffer !== this.cachedBuffer) {
      this.cachedBuffer = buffer;
      this.cachedData = new Uint8Array(buffer);
    }
    return this.cachedData!;
  }

  private getRegionMap(
    regions?: {addrStart: string; addrEnd: string}[],
  ): RegionSpan[] | undefined {
    if (regions !== this.cachedRegions) {
      this.cachedRegions = regions;
      this.cachedRegionMap =
        regions !== undefined && regions.length > 0
          ? buildRegionMap(regions)
          : undefined;
    }
    return this.cachedRegionMap;
  }

  private getAddrWidth(regionMap?: RegionSpan[]): number | undefined {
    if (regionMap === undefined || regionMap.length === 0) return undefined;
    const last = regionMap[regionMap.length - 1];
    const maxAddr = last.vmaBase + (last.offsetEnd - last.offsetStart);
    return maxAddr > 0xffffffff ? 12 : 8;
  }

  private getStrings(buffer: ArrayBuffer, data: Uint8Array): ExtractedString[] {
    if (!this.showStrings) return [];
    if (buffer !== this.cachedStringsBuffer) {
      this.cachedStringsBuffer = buffer;
      this.cachedStrings = extractStrings(data);
    }
    return this.cachedStrings;
  }

  private scrollToRow(row: number) {
    const target = Math.max(0, row * ROW_HEIGHT - this.containerHeight / 3);
    if (this.scrollNode !== null) {
      this.scrollNode.scrollTop = target;
      this.scrollTop = target;
    }
    this.highlightRow = row;
    if (this.highlightTimer !== undefined) clearTimeout(this.highlightTimer);
    this.highlightTimer = setTimeout(() => {
      this.highlightRow = null;
      m.redraw();
    }, 2000);
  }

  private scrollToOffset(byteOffset: number) {
    this.scrollToRow(Math.floor(byteOffset / BYTES_PER_ROW));
  }

  onremove() {
    if (this.highlightTimer !== undefined) clearTimeout(this.highlightTimer);
  }

  view(vnode: m.Vnode<HexViewAttrs>) {
    const {buffer, name, regions, initialStringFilter, onClose} = vnode.attrs;
    const data = this.getData(buffer);
    const totalRows = Math.ceil(data.byteLength / BYTES_PER_ROW);
    const regionMap = this.getRegionMap(regions);
    const addrWidth = this.getAddrWidth(regionMap);

    // Apply initial filter once
    if (
      initialStringFilter !== undefined &&
      initialStringFilter !== this.appliedFilter
    ) {
      this.appliedFilter = initialStringFilter;
      this.stringFilter = initialStringFilter;
      this.showStrings = true;
    }

    const allStrings = this.getStrings(buffer, data);
    const strings =
      this.stringMinLen > MIN_STRING_LEN
        ? allStrings.filter((s) => s.str.length >= this.stringMinLen)
        : allStrings;
    const filteredStrings =
      this.stringFilter !== ''
        ? strings.filter((s) =>
            s.str.toLowerCase().includes(this.stringFilter.toLowerCase()),
          )
        : strings;
    const displayStrings = filteredStrings.slice(0, MAX_STRINGS);

    const startRow = Math.max(
      0,
      Math.floor(this.scrollTop / ROW_HEIGHT) - OVERSCAN,
    );
    const endRow = Math.min(
      totalRows,
      Math.ceil((this.scrollTop + this.containerHeight) / ROW_HEIGHT) +
        OVERSCAN,
    );

    const lines: string[] = [];
    for (let i = startRow; i < endRow; i++) {
      const offset = i * BYTES_PER_ROW;
      const vmaAddr =
        regionMap !== undefined
          ? offsetToVmaAddr(offset, regionMap)
          : undefined;
      lines.push(formatRow(data, offset, data.byteLength, vmaAddr, addrWidth));
    }

    return m('.hex-view', [
      // Toolbar
      m(
        '.hex-toolbar',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '8px',
          },
        },
        [
          m('h2', {style: {fontSize: '1rem', margin: 0}}, name),
          m(
            'span',
            {style: {fontSize: '0.8rem', opacity: 0.5}},
            `${(data.byteLength / 1024).toFixed(1)} KiB`,
          ),
          m('.spacer', {style: {flex: 1}}),
          m(Button, {
            label: this.showStrings ? 'Hide Strings' : 'Strings',
            minimal: true,
            compact: true,
            active: this.showStrings,
            onclick: () => {
              this.showStrings = !this.showStrings;
            },
          }),
          onClose !== undefined &&
            m(Button, {
              label: 'Close',
              minimal: true,
              compact: true,
              onclick: onClose,
            }),
        ],
      ),

      // Content
      m('.hex-content', {style: {display: 'flex', gap: '0'}}, [
        // Hex dump
        m(
          '.hex-dump',
          {style: {flex: 1, minWidth: 0}},
          m(
            'div',
            {
              style: {
                height: `${this.containerHeight}px`,
                overflow: 'auto',
                position: 'relative',
              },
              oncreate: (vn: m.VnodeDOM) => {
                const node = vn.dom as HTMLDivElement;
                this.scrollNode = node;
                const h = Math.min(
                  window.innerHeight - 200,
                  totalRows * ROW_HEIGHT,
                );
                this.containerHeight = Math.max(200, h);
                m.redraw();
              },
              onscroll: (e: Event) => {
                this.scrollTop = (e.currentTarget as HTMLDivElement).scrollTop;
              },
            },
            m(
              'div',
              {
                style: {
                  height: `${totalRows * ROW_HEIGHT}px`,
                  position: 'relative',
                },
              },
              [
                // Highlight
                this.highlightRow !== null &&
                  this.highlightRow >= startRow &&
                  this.highlightRow < endRow &&
                  m('div', {
                    style: {
                      position: 'absolute',
                      top: `${this.highlightRow * ROW_HEIGHT}px`,
                      height: `${ROW_HEIGHT}px`,
                      left: 0,
                      right: 0,
                      background: 'rgba(56, 189, 248, 0.15)',
                      pointerEvents: 'none',
                    },
                  }),
                // Hex rows
                m(
                  'pre',
                  {
                    style: {
                      position: 'absolute',
                      top: `${startRow * ROW_HEIGHT}px`,
                      left: 0,
                      padding: '0 8px',
                      margin: 0,
                      fontFamily: 'monospace',
                      fontSize: '12px',
                      lineHeight: `${ROW_HEIGHT}px`,
                    },
                  },
                  lines.join('\n'),
                ),
              ],
            ),
          ),
        ),

        // Strings panel
        this.showStrings &&
          m(
            '.hex-strings-panel',
            {
              style: {
                width: '300px',
                borderLeft: '1px solid var(--md-sys-color-outline-variant)',
                display: 'flex',
                flexDirection: 'column',
                height: `${this.containerHeight}px`,
              },
            },
            [
              // Header
              m(
                '.hex-strings-header',
                {style: {padding: '4px 8px', flexShrink: 0}},
                [
                  m('input', {
                    type: 'text',
                    placeholder: 'Filter strings\u2026',
                    value: this.stringFilter,
                    style: {
                      width: '100%',
                      fontSize: '0.75rem',
                      padding: '2px 6px',
                      marginBottom: '4px',
                    },
                    oninput: (e: Event) => {
                      this.stringFilter = (e.target as HTMLInputElement).value;
                    },
                  }),
                  m(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        gap: '4px',
                        alignItems: 'center',
                        fontSize: '10px',
                        opacity: 0.6,
                      },
                    },
                    [
                      m(
                        'span',
                        filteredStrings.length === strings.length
                          ? `${strings.length.toLocaleString()} strings`
                          : `${filteredStrings.length.toLocaleString()} / ${strings.length.toLocaleString()}`,
                      ),
                      m('span', 'min'),
                      m('input', {
                        type: 'number',
                        min: 4,
                        max: 999,
                        value: this.stringMinLen,
                        style: {
                          width: '3rem',
                          fontSize: '10px',
                          padding: '1px 2px',
                          textAlign: 'center',
                        },
                        oninput: (e: Event) => {
                          const v = parseInt(
                            (e.target as HTMLInputElement).value,
                            10,
                          );
                          if (isFinite(v) && v >= 4) this.stringMinLen = v;
                        },
                      }),
                    ],
                  ),
                ],
              ),
              // List
              m(
                '.hex-strings-list',
                {style: {flex: 1, overflow: 'auto'}},
                displayStrings.map((s) => {
                  const vma =
                    regionMap !== undefined
                      ? offsetToVmaAddr(s.offset, regionMap)
                      : undefined;
                  return m(
                    'div',
                    {
                      key: s.offset,
                      style: {
                        padding: '1px 8px',
                        fontSize: '11px',
                        fontFamily: 'monospace',
                        cursor: 'pointer',
                        borderBottom:
                          '1px solid var(--md-sys-color-outline-variant)',
                        display: 'flex',
                        gap: '6px',
                      },
                      onclick: () => {
                        this.scrollToOffset(s.offset);
                        navigator.clipboard.writeText(s.str).catch(() => {});
                      },
                      title: `Click to jump & copy`,
                    },
                    [
                      m(
                        'span',
                        {style: {opacity: 0.4, flexShrink: 0}},
                        (vma ?? s.offset)
                          .toString(16)
                          .padStart(
                            vma !== undefined ? addrWidth ?? 8 : 8,
                            '0',
                          ),
                      ),
                      m(
                        'span',
                        {
                          style: {
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          },
                        },
                        s.str,
                      ),
                    ],
                  );
                }),
                filteredStrings.length > MAX_STRINGS &&
                  m(
                    'div',
                    {
                      style: {
                        padding: '4px 8px',
                        fontSize: '10px',
                        opacity: 0.5,
                        textAlign: 'center',
                      },
                    },
                    `Showing ${MAX_STRINGS.toLocaleString()} of ${filteredStrings.length.toLocaleString()}`,
                  ),
              ),
            ],
          ),
      ]),
    ]);
  }
}
