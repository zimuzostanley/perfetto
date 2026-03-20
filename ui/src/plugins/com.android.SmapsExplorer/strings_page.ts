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
import {DataGrid} from '../../components/widgets/datagrid/datagrid';
import {type SchemaRegistry} from '../../components/widgets/datagrid/datagrid_schema';
import {type Row, type SqlValue} from '../../trace_processor/query_result';
import {Button} from '../../widgets/button';
import {type ProcessStringsResult, type VmaString} from './smaps_connection';

// ── Schemas ─────────────────────────────────────────────────────────────────

const ALL_STRINGS_SCHEMA: SchemaRegistry = {
  string: {
    vmaAddr: {
      title: 'Address',
      columnType: 'quantitative',
      cellRenderer: (v: SqlValue) => ({
        content: Number(v).toString(16).padStart(8, '0'),
        align: 'left' as const,
      }),
    },
    vmaName: {title: 'VMA', columnType: 'text'},
    str: {title: 'String', columnType: 'text'},
  },
};

const DUPLICATES_SCHEMA: SchemaRegistry = {
  duplicate: {
    totalBytes: {title: 'Bytes', columnType: 'quantitative'},
    count: {title: 'Count', columnType: 'quantitative'},
    length: {title: 'Len', columnType: 'quantitative'},
    vmaCount: {title: 'VMAs', columnType: 'quantitative'},
    value: {title: 'String', columnType: 'text'},
  },
};

// ── Types ───────────────────────────────────────────────────────────────────

interface DuplicateGroup {
  value: string;
  count: number;
  totalBytes: number;
  vmaCount: number;
}

function computeDuplicates(strings: VmaString[]): DuplicateGroup[] {
  const groups = new Map<
    string,
    {count: number; totalBytes: number; vmaIndices: Set<number>}
  >();
  for (const s of strings) {
    const existing = groups.get(s.str);
    if (existing !== undefined) {
      existing.count++;
      existing.totalBytes += s.str.length;
      existing.vmaIndices.add(s.vmaIndex);
    } else {
      groups.set(s.str, {
        count: 1,
        totalBytes: s.str.length,
        vmaIndices: new Set([s.vmaIndex]),
      });
    }
  }
  const result: DuplicateGroup[] = [];
  for (const [value, g] of groups) {
    if (g.count < 2) continue;
    result.push({
      value,
      count: g.count,
      totalBytes: g.totalBytes,
      vmaCount: g.vmaIndices.size,
    });
  }
  result.sort((a, b) => b.totalBytes - a.totalBytes);
  return result;
}

// ── Component ───────────────────────────────────────────────────────────────

type Tab = 'all' | 'duplicates' | 'byvma';

interface ProcessStringsPageAttrs {
  data: ProcessStringsResult;
  onClose: () => void;
}

export class ProcessStringsPage
  implements m.ClassComponent<ProcessStringsPageAttrs>
{
  private tab: Tab = 'duplicates';
  private minLen = 4;
  private cachedStrings: VmaString[] | undefined;
  private cachedDups: DuplicateGroup[] = [];

  private getDups(strings: VmaString[]): DuplicateGroup[] {
    if (strings !== this.cachedStrings) {
      this.cachedStrings = strings;
      this.cachedDups = computeDuplicates(strings);
    }
    return this.cachedDups;
  }

  view(vnode: m.Vnode<ProcessStringsPageAttrs>) {
    const {data, onClose} = vnode.attrs;
    const {processName, pid, scanning, scannedVmas, totalVmas} = data;
    const strings =
      this.minLen > 4
        ? data.strings.filter((s) => s.str.length >= this.minLen)
        : data.strings;
    const dups = this.getDups(strings);

    return m('.smaps-strings', {style: {padding: '16px', height: '100%'}}, [
      // Header
      m(
        '.smaps-strings-header',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            marginBottom: '8px',
          },
        },
        [
          m(
            'h2',
            {style: {fontSize: '1rem', margin: 0}},
            `${processName} (${pid})`,
          ),
          m(
            'span',
            {style: {fontSize: '0.8rem', opacity: 0.5}},
            `${strings.length.toLocaleString()} strings`,
          ),
          dups.length > 0 &&
            m(
              'span',
              {style: {fontSize: '0.8rem', opacity: 0.5}},
              `${dups.length.toLocaleString()} duplicates`,
            ),
          m('.spacer', {style: {flex: 1}}),
          m(Button, {label: 'Close', minimal: true, onclick: onClose}),
        ],
      ),

      // Scanning progress
      scanning === true &&
        totalVmas !== undefined &&
        totalVmas > 0 &&
        m(
          '.smaps-progress',
          {style: {marginBottom: '8px', fontSize: '0.8rem', opacity: 0.6}},
          `Scanning VMAs: ${scannedVmas ?? 0}/${totalVmas}`,
        ),

      // Tab bar + min length
      m(
        '.smaps-strings-tabs',
        {
          style: {
            display: 'flex',
            gap: '4px',
            alignItems: 'center',
            marginBottom: '8px',
          },
        },
        [
          m(Button, {
            label: 'All',
            minimal: true,
            compact: true,
            active: this.tab === 'all',
            onclick: () => {
              this.tab = 'all';
            },
          }),
          m(Button, {
            label: 'Duplicates',
            minimal: true,
            compact: true,
            active: this.tab === 'duplicates',
            onclick: () => {
              this.tab = 'duplicates';
            },
          }),
          m(Button, {
            label: 'By VMA',
            minimal: true,
            compact: true,
            active: this.tab === 'byvma',
            onclick: () => {
              this.tab = 'byvma';
            },
          }),
          m('span', {style: {marginLeft: '8px', fontSize: '0.75rem'}}, 'min'),
          m('input', {
            type: 'number',
            min: 4,
            max: 999,
            value: this.minLen,
            style: {
              width: '3rem',
              fontSize: '0.75rem',
              padding: '2px 4px',
              textAlign: 'center',
            },
            oninput: (e: Event) => {
              const v = parseInt((e.target as HTMLInputElement).value, 10);
              if (isFinite(v) && v >= 4) this.minLen = v;
            },
          }),
        ],
      ),

      // Content
      this.tab === 'all'
        ? this.renderAllStrings(strings, data)
        : this.tab === 'duplicates'
          ? this.renderDuplicates(dups)
          : this.renderByVma(strings, data),
    ]);
  }

  private renderAllStrings(
    strings: VmaString[],
    data: ProcessStringsResult,
  ): m.Children {
    const rows: Row[] = strings.map((s) => ({
      vmaAddr: s.vmaAddr,
      vmaName: data.regions[s.vmaIndex]?.name ?? '',
      str: s.str,
    }));

    return m(DataGrid, {
      schema: ALL_STRINGS_SCHEMA,
      rootSchema: 'string',
      data: rows,
      fillHeight: true,
      initialColumns: [
        {id: 'vmaAddr', field: 'vmaAddr', sort: 'ASC' as const},
        {id: 'vmaName', field: 'vmaName'},
        {id: 'str', field: 'str'},
      ],
    });
  }

  private renderDuplicates(dups: DuplicateGroup[]): m.Children {
    const rows: Row[] = dups.map((d) => ({
      totalBytes: d.totalBytes,
      count: d.count,
      length: d.value.length,
      vmaCount: d.vmaCount,
      value: d.value,
    }));

    return m(DataGrid, {
      schema: DUPLICATES_SCHEMA,
      rootSchema: 'duplicate',
      data: rows,
      fillHeight: true,
      initialColumns: [
        {id: 'totalBytes', field: 'totalBytes', sort: 'DESC' as const},
        {id: 'count', field: 'count'},
        {id: 'length', field: 'length'},
        {id: 'vmaCount', field: 'vmaCount'},
        {id: 'value', field: 'value'},
      ],
    });
  }

  private renderByVma(
    strings: VmaString[],
    data: ProcessStringsResult,
  ): m.Children {
    // Build rows: one per VMA region with string count
    const vmaCounts = new Map<number, number>();
    for (const s of strings) {
      vmaCounts.set(s.vmaIndex, (vmaCounts.get(s.vmaIndex) ?? 0) + 1);
    }

    const BY_VMA_SCHEMA: SchemaRegistry = {
      vma: {
        addrStart: {title: 'Address', columnType: 'text'},
        perms: {title: 'Perms', columnType: 'text'},
        name: {title: 'Name', columnType: 'text'},
        stringCount: {title: 'Strings', columnType: 'quantitative'},
        sizeKb: {title: 'Size', columnType: 'quantitative'},
      },
    };

    const rows: Row[] = data.regions
      .map((r, i) => ({
        addrStart: r.addrStart,
        perms: r.perms,
        name: r.name,
        stringCount: vmaCounts.get(i) ?? 0,
        sizeKb: r.sizeKb,
      }))
      .filter((r) => (r.stringCount as number) > 0);

    return m(DataGrid, {
      schema: BY_VMA_SCHEMA,
      rootSchema: 'vma',
      data: rows,
      fillHeight: true,
      initialColumns: [
        {id: 'addrStart', field: 'addrStart'},
        {id: 'perms', field: 'perms'},
        {id: 'name', field: 'name'},
        {id: 'stringCount', field: 'stringCount', sort: 'DESC' as const},
        {id: 'sizeKb', field: 'sizeKb'},
      ],
    });
  }
}
