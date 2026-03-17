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

import {MergedSlice, Slice} from './types';

function tokenDistance(a: MergedSlice, b: MergedSlice): number {
  let d = 0;
  if (a.state !== b.state) {
    d += 4;
  } else if (a.state === 'Uninterruptible Sleep' && a.io_wait !== b.io_wait) {
    d += 2;
  }
  if (a.name !== b.name) {
    d += a.name === null || b.name === null ? 1 : 2;
  }
  if (a.blocked_function !== b.blocked_function) {
    d += a.blocked_function === null || b.blocked_function === null ? 0.5 : 1;
  }
  return d;
}

function mergeCost(a: MergedSlice, b: MergedSlice): number {
  const dist = tokenDistance(a, b);
  if (dist === 0) {
    return 0.01 * Math.log1p((a.dur + b.dur) / 1e6);
  }
  const loser = a.dur <= b.dur ? a : b;
  const loserWeight =
    Math.log1p(loser.dur / 1e6) *
    (1 +
      (loser.name !== null ? 1 : 0) +
      (loser.blocked_function !== null ? 1 : 0));
  return dist * loserWeight;
}

function mergeTwo(a: MergedSlice, b: MergedSlice): MergedSlice {
  const winner = a.dur >= b.dur ? a : b;
  return {
    ts: a.ts,
    tsRel: a.tsRel,
    dur: a.dur + b.dur,
    state: winner.state,
    io_wait: winner.io_wait,
    name: winner.name,
    depth: winner.depth,
    blocked_function: winner.blocked_function,
    _merged: (a._merged || 1) + (b._merged || 1),
  };
}

export function buildMergeCache(rawData: Slice[]): Map<number, MergedSlice[]> {
  const cache = new Map<number, MergedSlice[]>();
  if (rawData.length === 0) return cache;

  let seq: MergedSlice[] = rawData.map((d) => ({
    ...d,
    tsRel: d.ts - rawData[0].ts,
    _merged: 1,
  }));
  cache.set(
    seq.length,
    seq.map((d) => ({...d})),
  );

  while (seq.length > 2) {
    let bestI = 0;
    let bestCost = Infinity;
    for (let i = 0; i < seq.length - 1; i++) {
      const c = mergeCost(seq[i], seq[i + 1]);
      if (c < bestCost) {
        bestCost = c;
        bestI = i;
      }
    }
    seq = [
      ...seq.slice(0, bestI),
      mergeTwo(seq[bestI], seq[bestI + 1]),
      ...seq.slice(bestI + 2),
    ];
    if (!cache.has(seq.length)) {
      cache.set(
        seq.length,
        seq.map((d) => ({...d})),
      );
    }
  }
  return cache;
}

export function getCompressed(
  cache: Map<number, MergedSlice[]>,
  origN: number,
  target: number,
): MergedSlice[] {
  const t = Math.max(2, target);
  let best = origN;
  for (const k of cache.keys()) {
    if (k >= t && k < best) best = k;
  }
  return cache.get(best) ?? cache.get(2) ?? [];
}
