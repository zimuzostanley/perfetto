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
import {App} from '../../public/app';
import {Button} from '../../widgets/button';
import {Spinner} from '../../widgets/spinner';
import {Tree, TreeNode} from '../../widgets/tree';
import {DataGrid} from '../../components/widgets/datagrid/datagrid';
import {
  type SchemaRegistry,
  type CellRenderResult,
} from '../../components/widgets/datagrid/datagrid_schema';
import {type Row, type SqlValue} from '../../trace_processor/query_result';
import {ProcessStringsPage} from './strings_page';
import {HexView} from './hex_view';
import {
  SmapsConnection,
  aggregateSmaps,
  aggregateSharedMappings,
  type ProcessInfo,
  type SmapsAggregated,
  type SmapsEntry,
  type SmapsRollup,
  type ProcessStringsResult,
} from './smaps_connection';

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmtSize(bytes: number): string {
  if (bytes === 0) return '\u2014';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KiB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MiB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GiB`;
}

function sizeRenderer(value: SqlValue): CellRenderResult {
  const n = Number(value);
  return {
    content: n > 0 ? fmtSize(n * 1024) : '\u2014',
    align: 'right',
    nullish: n === 0,
  };
}

function fmtSizeKb(kb: number): string {
  return kb > 0 ? fmtSize(kb * 1024) : '\u2014';
}

// ── VMA filters ─────────────────────────────────────────────────────────────

type VmaType = 'all' | 'file' | 'anon';

function classifyEntry(e: SmapsEntry): 'file' | 'anon' {
  if (e.dev !== '00:00' && e.inode !== 0) return 'file';
  return 'anon';
}

interface VmaFilters {
  type: VmaType;
  r: boolean | null;
  w: boolean | null;
  x: boolean | null;
}

function matchesFilters(e: SmapsEntry, f: VmaFilters): boolean {
  if (f.type !== 'all' && classifyEntry(e) !== f.type) return false;
  if (f.r !== null && (e.perms[0] === 'r') !== f.r) return false;
  if (f.w !== null && (e.perms[1] === 'w') !== f.w) return false;
  if (f.x !== null && (e.perms[2] === 'x') !== f.x) return false;
  return true;
}

function filterAggregated(
  aggregated: SmapsAggregated[],
  filters: VmaFilters,
): SmapsAggregated[] {
  if (
    filters.type === 'all' &&
    filters.r === null &&
    filters.w === null &&
    filters.x === null
  ) {
    return aggregated;
  }
  return aggregated
    .map((g) => {
      const entries = g.entries.filter((e) => matchesFilters(e, filters));
      if (entries.length === 0) return null;
      if (entries.length === g.entries.length) return g;
      const agg: SmapsAggregated = {
        name: g.name,
        count: entries.length,
        sizeKb: 0,
        rssKb: 0,
        pssKb: 0,
        sharedCleanKb: 0,
        sharedDirtyKb: 0,
        privateCleanKb: 0,
        privateDirtyKb: 0,
        swapKb: 0,
        swapPssKb: 0,
        entries,
      };
      for (const e of entries) {
        agg.sizeKb += e.sizeKb;
        agg.rssKb += e.rssKb;
        agg.pssKb += e.pssKb;
        agg.sharedCleanKb += e.sharedCleanKb;
        agg.sharedDirtyKb += e.sharedDirtyKb;
        agg.privateCleanKb += e.privateCleanKb;
        agg.privateDirtyKb += e.privateDirtyKb;
        agg.swapKb += e.swapKb;
        agg.swapPssKb += e.swapPssKb;
      }
      return agg;
    })
    .filter((g): g is SmapsAggregated => g !== null);
}

// ── DataGrid schemas ────────────────────────────────────────────────────────

const PROCESS_SCHEMA: SchemaRegistry = {
  process: {
    pid: {title: 'PID', columnType: 'quantitative'},
    name: {title: 'Process', columnType: 'text'},
    oomLabel: {title: 'State', columnType: 'text'},
    pssKb: {
      title: 'PSS',
      columnType: 'quantitative',
      cellRenderer: sizeRenderer,
    },
    rssKb: {
      title: 'RSS',
      columnType: 'quantitative',
      cellRenderer: sizeRenderer,
    },
    privateDirtyKb: {
      title: 'Priv Dirty',
      columnType: 'quantitative',
      cellRenderer: sizeRenderer,
    },
    privateCleanKb: {
      title: 'Priv Clean',
      columnType: 'quantitative',
      cellRenderer: sizeRenderer,
    },
    swapKb: {
      title: 'Swap',
      columnType: 'quantitative',
      cellRenderer: sizeRenderer,
    },
    sizeKb: {
      title: 'VSS',
      columnType: 'quantitative',
      cellRenderer: sizeRenderer,
    },
  },
};

const SHARED_SCHEMA: SchemaRegistry = {
  mapping: {
    name: {title: 'Mapping', columnType: 'text'},
    processCount: {title: 'Processes', columnType: 'quantitative'},
    pssKb: {
      title: 'PSS',
      columnType: 'quantitative',
      cellRenderer: sizeRenderer,
    },
    rssKb: {
      title: 'RSS',
      columnType: 'quantitative',
      cellRenderer: sizeRenderer,
    },
    sizeKb: {
      title: 'VSS',
      columnType: 'quantitative',
      cellRenderer: sizeRenderer,
    },
  },
};

// ── Page component ──────────────────────────────────────────────────────────

interface SmapsExplorerPageAttrs {
  app: App;
}

export class SmapsExplorerPage
  implements m.ClassComponent<SmapsExplorerPageAttrs>
{
  private conn = new SmapsConnection();
  private connectStatus: string | null = null;
  private error: string | null = null;
  private processes: ProcessInfo[] | null = null;
  private rollups = new Map<number, SmapsRollup>();
  private smapsData = new Map<number, SmapsAggregated[]>();
  private expandedPid: number | null = null;
  private loadingPid: number | null = null;
  private enriching = false;
  private enrichProgress: {done: number; total: number} | null = null;
  private vmaFilters: VmaFilters = {type: 'all', r: null, w: null, x: null};
  private stringsData: ProcessStringsResult | null = null;
  private hexViewData: {
    buffer: ArrayBuffer;
    name: string;
    regions?: {addrStart: string; addrEnd: string}[];
    initialFilter?: string;
  } | null = null;

  view(vnode: m.Vnode<SmapsExplorerPageAttrs>) {
    const {app} = vnode.attrs;

    // Overlay views
    if (this.hexViewData !== null) {
      const hv = this.hexViewData;
      return m(HexView, {
        buffer: hv.buffer,
        name: hv.name,
        regions: hv.regions,
        initialStringFilter: hv.initialFilter,
        onClose: () => {
          this.hexViewData = null;
        },
      });
    }
    if (this.stringsData !== null) {
      return m(ProcessStringsPage, {
        data: this.stringsData,
        onClose: () => {
          this.stringsData = null;
        },
      });
    }

    return m('.smaps-explorer', {style: {padding: '16px', height: '100%'}}, [
      // Header
      this.renderHeader(app),

      // Error
      this.error !== null &&
        m(
          '.smaps-error',
          {
            style: {
              padding: '8px 12px',
              background: 'var(--md-sys-color-error-container)',
              color: 'var(--md-sys-color-on-error-container)',
              borderRadius: '4px',
              marginBottom: '8px',
            },
          },
          this.error,
        ),

      // Connect
      !this.conn.connected && this.processes === null && this.renderConnect(),

      // Enrichment progress
      this.enriching &&
        this.enrichProgress !== null &&
        m(
          '.smaps-progress',
          {style: {marginBottom: '8px', fontSize: '0.8rem', opacity: 0.6}},
          `Fetching rollups: ${this.enrichProgress.done}/${this.enrichProgress.total}`,
        ),

      // VMA filters
      this.processes !== null && this.renderFilters(),

      // Process table
      this.processes !== null && this.renderProcessTable(app),

      // Shared mappings
      this.smapsData.size >= 2 &&
        this.processes !== null &&
        this.renderSharedMappings(),
    ]);
  }

  // ── Header ──────────────────────────────────────────────────────────────

  private renderHeader(_app: App): m.Children {
    return m(
      '.smaps-header',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          marginBottom: '8px',
        },
      },
      [
        m('h1', {style: {fontSize: '1.25rem', margin: 0}}, 'Smaps Explorer'),
        this.conn.connected &&
          m(
            'span',
            {style: {fontSize: '0.8rem', opacity: 0.6}},
            `${this.processes?.length ?? 0} processes`,
          ),
        this.conn.connected &&
          !this.conn.isRoot &&
          m(
            'span',
            {
              style: {
                fontSize: '0.75rem',
                padding: '2px 6px',
                background: 'var(--md-sys-color-tertiary-container)',
                borderRadius: '4px',
              },
            },
            'Not rooted',
          ),
        m('.spacer', {style: {flex: 1}}),
        this.conn.connected &&
          m(Button, {
            label: 'Refresh',
            icon: 'refresh',
            minimal: true,
            onclick: () => this.refreshProcesses(),
          }),
        this.conn.connected &&
          this.conn.isRoot &&
          !this.enriching &&
          m(Button, {
            label: 'Scan All',
            icon: 'search',
            minimal: true,
            onclick: () => this.enrichAll(),
          }),
        this.conn.connected &&
          m(Button, {
            label: 'Disconnect',
            icon: 'link_off',
            minimal: true,
            onclick: () => {
              this.conn.disconnect();
              this.processes = null;
              this.smapsData.clear();
              this.rollups.clear();
              this.expandedPid = null;
              m.redraw();
            },
          }),
      ],
    );
  }

  // ── Connection ──────────────────────────────────────────────────────────

  private renderConnect(): m.Children {
    return m(
      '.smaps-connect',
      {style: {textAlign: 'center', padding: '48px'}},
      [
        m(Button, {
          label: this.connectStatus ?? 'Connect USB Device',
          icon: 'usb',
          disabled: this.connectStatus !== null,
          onclick: () => this.handleConnect(),
        }),
        m(
          'p',
          {style: {marginTop: '8px', fontSize: '0.8rem', opacity: 0.6}},
          'Enable USB debugging. Stop adb first: ',
          m('code', 'adb kill-server'),
        ),
      ],
    );
  }

  private async handleConnect(): Promise<void> {
    try {
      this.connectStatus = 'Connecting\u2026';
      this.error = null;
      m.redraw();
      await this.conn.connect((msg) => {
        this.connectStatus = msg;
        m.redraw();
      });
      this.connectStatus = null;
      await this.refreshProcesses();
    } catch (e) {
      this.connectStatus = null;
      this.error = e instanceof Error ? e.message : 'Connection failed';
      m.redraw();
    }
  }

  private async refreshProcesses(): Promise<void> {
    try {
      this.processes = await this.conn.getProcessList();
      this.processes.sort((a, b) => a.name.localeCompare(b.name));
      m.redraw();
      // Auto-enrich in background
      if (this.conn.isRoot && !this.enriching) {
        this.enrichAll();
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to get processes';
      m.redraw();
    }
  }

  private async enrichAll(): Promise<void> {
    if (this.processes === null || this.enriching) return;
    this.enriching = true;
    m.redraw();
    try {
      this.rollups = await this.conn.enrichProcesses(
        this.processes,
        (done, total) => {
          this.enrichProgress = {done, total};
          m.redraw();
        },
      );
    } catch {
      // Ignore enrichment failures
    } finally {
      this.enriching = false;
      this.enrichProgress = null;
      m.redraw();
    }
  }

  // ── VMA filters ─────────────────────────────────────────────────────────

  private renderFilters(): m.Children {
    const f = this.vmaFilters;
    const typeBtn = (type: VmaType, label: string) =>
      m(Button, {
        label,
        minimal: true,
        compact: true,
        active: f.type === type,
        onclick: () => {
          this.vmaFilters = {...f, type};
        },
      });
    const permBtn = (perm: 'r' | 'w' | 'x', val: boolean | null) =>
      m(Button, {
        label: perm,
        minimal: true,
        compact: true,
        active: val === true,
        onclick: () => {
          const next = val === null ? true : val === true ? false : null;
          if (perm === 'r') this.vmaFilters = {...f, r: next};
          else if (perm === 'w') this.vmaFilters = {...f, w: next};
          else this.vmaFilters = {...f, x: next};
        },
      });

    return m(
      '.smaps-filters',
      {
        style: {
          display: 'flex',
          gap: '4px',
          alignItems: 'center',
          marginBottom: '8px',
        },
      },
      [
        typeBtn('all', 'All'),
        typeBtn('file', 'File'),
        typeBtn('anon', 'Anon'),
        m('span', {
          style: {
            width: '1px',
            height: '16px',
            background: 'var(--md-sys-color-outline)',
            margin: '0 4px',
          },
        }),
        permBtn('r', f.r),
        permBtn('w', f.w),
        permBtn('x', f.x),
      ],
    );
  }

  // ── Process table (DataGrid) ────────────────────────────────────────────

  private renderProcessTable(app: App): m.Children {
    if (this.processes === null) return null;

    const rows: Row[] = this.processes.map((p) => {
      const r = this.rollups.get(p.pid);
      return {
        pid: p.pid,
        name: p.name,
        oomLabel: p.oomLabel,
        pssKb: r?.pssKb ?? 0,
        rssKb: r?.rssKb ?? 0,
        privateDirtyKb: r?.privateDirtyKb ?? 0,
        privateCleanKb: r?.privateCleanKb ?? 0,
        swapKb: r?.swapKb ?? 0,
        sizeKb: r?.sizeKb ?? 0,
      };
    });

    return m('.smaps-process-section', [
      m(DataGrid, {
        schema: PROCESS_SCHEMA,
        rootSchema: 'process',
        data: rows,
        initialColumns: [
          {id: 'pid', field: 'pid'},
          {id: 'name', field: 'name'},
          {id: 'oomLabel', field: 'oomLabel'},
          {id: 'pssKb', field: 'pssKb', sort: 'DESC' as const},
          {id: 'rssKb', field: 'rssKb'},
          {id: 'privateDirtyKb', field: 'privateDirtyKb'},
          {id: 'privateCleanKb', field: 'privateCleanKb'},
          {id: 'swapKb', field: 'swapKb'},
          {id: 'sizeKb', field: 'sizeKb'},
        ],
      }),

      // Expanded process smaps detail (TreeView below DataGrid)
      this.expandedPid !== null && this.renderSmapsTree(this.expandedPid, app),

      // PID selector
      this.conn.isRoot &&
        m(
          '.smaps-pid-select',
          {
            style: {
              display: 'flex',
              gap: '8px',
              alignItems: 'center',
              margin: '8px 0',
            },
          },
          [
            m('span', {style: {fontSize: '0.8rem'}}, 'Inspect:'),
            m(
              'select',
              {
                style: {fontSize: '0.8rem', padding: '2px 4px'},
                value: this.expandedPid ?? '',
                onchange: (e: Event) => {
                  const val = parseInt(
                    (e.target as HTMLSelectElement).value,
                    10,
                  );
                  if (isFinite(val)) {
                    this.expandedPid = val;
                    this.loadSmaps(val);
                  } else {
                    this.expandedPid = null;
                  }
                },
              },
              [
                m('option', {value: ''}, 'Select process\u2026'),
                ...(this.processes ?? []).map((p) =>
                  m('option', {value: p.pid}, `${p.pid} \u2014 ${p.name}`),
                ),
              ],
            ),
          ],
        ),
    ]);
  }

  // ── Smaps TreeView ──────────────────────────────────────────────────────

  private async loadSmaps(pid: number): Promise<void> {
    if (this.loadingPid === pid || this.smapsData.has(pid)) return;
    this.loadingPid = pid;
    m.redraw();
    try {
      const entries = await this.conn.getSmapsForPid(pid);
      this.smapsData.set(pid, aggregateSmaps(entries));
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to load smaps';
    } finally {
      if (this.loadingPid === pid) this.loadingPid = null;
      m.redraw();
    }
  }

  private renderSmapsTree(pid: number, app: App): m.Children {
    if (this.loadingPid === pid) {
      return m('.smaps-loading', {style: {padding: '16px'}}, m(Spinner));
    }
    const rawAgg = this.smapsData.get(pid);
    if (rawAgg === undefined) {
      return m(
        '.smaps-empty',
        {style: {padding: '8px', opacity: 0.5, fontSize: '0.8rem'}},
        'Loading smaps\u2026',
      );
    }

    const aggregated = filterAggregated(rawAgg, this.vmaFilters);
    const process = this.processes?.find((p) => p.pid === pid);
    const processName = process?.name ?? '';

    return m('.smaps-tree', {style: {margin: '8px 0'}}, [
      // Action bar
      m(
        '.smaps-actions',
        {
          style: {
            display: 'flex',
            gap: '8px',
            alignItems: 'center',
            marginBottom: '4px',
          },
        },
        [
          m(
            'span',
            {style: {fontSize: '0.85rem', fontWeight: 500}},
            `${processName} (${pid})`,
          ),
          m(
            'span',
            {style: {fontSize: '0.75rem', opacity: 0.5}},
            `${aggregated.length} mappings`,
          ),
          m('.spacer', {style: {flex: 1}}),
          m(Button, {
            label: 'strings',
            minimal: true,
            compact: true,
            onclick: () => this.startStringsScan(pid, processName),
          }),
          m(Button, {
            label: 'heap dump',
            minimal: true,
            compact: true,
            onclick: () => this.captureHeap(pid, processName, app),
          }),
        ],
      ),

      // VMA groups tree
      m(
        Tree,
        aggregated.map((g) =>
          m(
            TreeNode,
            {
              key: g.name,
              left: m(
                'span',
                {
                  style: {
                    display: 'flex',
                    gap: '12px',
                    fontFamily: 'monospace',
                    fontSize: '0.75rem',
                  },
                },
                [
                  m(
                    'span',
                    {
                      style: {
                        width: '220px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      },
                      title: g.name,
                    },
                    g.name || '[anonymous]',
                  ),
                  m(
                    'span',
                    {style: {width: '2rem', textAlign: 'right', opacity: 0.4}},
                    String(g.count),
                  ),
                  m(
                    'span',
                    {style: {width: '5rem', textAlign: 'right'}},
                    fmtSizeKb(g.pssKb),
                  ),
                  m(
                    'span',
                    {
                      style: {
                        width: '5rem',
                        textAlign: 'right',
                        opacity: 0.5,
                      },
                    },
                    fmtSizeKb(g.rssKb),
                  ),
                  m(Button, {
                    label: 'dump',
                    minimal: true,
                    compact: true,
                    onclick: (e: Event) => {
                      e.stopPropagation();
                      this.dumpVmaGroup(pid, processName, g);
                    },
                  }),
                ],
              ),
              startsCollapsed: true,
            },
            // Individual VMAs inside this group
            g.entries.map((e) =>
              m(TreeNode, {
                key: e.addrStart,
                left: m(
                  'span',
                  {
                    style: {
                      display: 'flex',
                      gap: '8px',
                      fontFamily: 'monospace',
                      fontSize: '0.7rem',
                      opacity: 0.7,
                    },
                  },
                  [
                    m('span', `${e.addrStart}-${e.addrEnd}`),
                    m('span', {style: {width: '2.5rem'}}, e.perms),
                    m(
                      'span',
                      {style: {width: '5rem', textAlign: 'right'}},
                      fmtSizeKb(e.pssKb),
                    ),
                    m(
                      'span',
                      {style: {width: '5rem', textAlign: 'right'}},
                      fmtSizeKb(e.rssKb),
                    ),
                  ],
                ),
              }),
            ),
          ),
        ),
      ),
    ]);
  }

  // ── VMA dump ────────────────────────────────────────────────────────────

  private async dumpVmaGroup(
    pid: number,
    processName: string,
    group: SmapsAggregated,
  ): Promise<void> {
    try {
      this.error = `Dumping ${group.name}\u2026`;
      m.redraw();
      const regions = group.entries
        .filter((e) => e.perms[0] === 'r')
        .map((e) => ({addrStart: e.addrStart, addrEnd: e.addrEnd}));
      const data = await this.conn.dumpVmaMemory(pid, regions, (status) => {
        this.error = status;
        m.redraw();
      });
      this.error = null;
      this.hexViewData = {
        buffer: data.buffer as ArrayBuffer,
        name: `${processName}_${group.name}`,
        regions,
      };
      m.redraw();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'VMA dump failed';
      m.redraw();
    }
  }

  // ── Shared mappings ─────────────────────────────────────────────────────

  private renderSharedMappings(): m.Children {
    if (this.processes === null) return null;
    const mappings = aggregateSharedMappings(this.smapsData, this.processes);
    if (mappings.length === 0) return null;

    const rows: Row[] = mappings.map((mp) => ({
      name: mp.name,
      processCount: mp.processCount,
      pssKb: mp.pssKb,
      rssKb: mp.rssKb,
      sizeKb: mp.sizeKb,
    }));

    return m('.smaps-shared', {style: {marginTop: '16px'}}, [
      m(
        'h2',
        {style: {fontSize: '1rem', marginBottom: '8px'}},
        `Shared Mappings (${mappings.length})`,
      ),
      m(DataGrid, {
        schema: SHARED_SCHEMA,
        rootSchema: 'mapping',
        data: rows,
        initialColumns: [
          {id: 'name', field: 'name'},
          {id: 'processCount', field: 'processCount'},
          {id: 'pssKb', field: 'pssKb', sort: 'DESC' as const},
          {id: 'rssKb', field: 'rssKb'},
          {id: 'sizeKb', field: 'sizeKb'},
        ],
      }),
    ]);
  }

  // ── Heap dump ─────────────────────────────────────────────────────────

  private async captureHeap(
    pid: number,
    name: string,
    app: App,
  ): Promise<void> {
    try {
      this.error = null;
      const data = await this.conn.captureHeapDump(pid, (status) => {
        this.error = status;
        m.redraw();
      });
      this.error = null;
      m.redraw();
      await app.openTraceFromBuffer({
        buffer: data.buffer as ArrayBuffer,
        title: `${name} (${pid})`,
        fileName: `${name}_${pid}.hprof`,
      });
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Heap dump failed';
      m.redraw();
    }
  }

  // ── Strings scan ──────────────────────────────────────────────────────

  private async startStringsScan(
    pid: number,
    processName: string,
  ): Promise<void> {
    if (!this.conn.isRoot) return;
    try {
      let aggregated = this.smapsData.get(pid);
      if (aggregated === undefined) {
        this.error = 'Fetching smaps\u2026';
        m.redraw();
        const entries = await this.conn.getSmapsForPid(pid);
        aggregated = aggregateSmaps(entries);
        this.smapsData.set(pid, aggregated);
        this.error = null;
      }

      const allEntries = aggregated.flatMap((a) => a.entries);
      const readable = allEntries.filter((e) => e.perms[0] === 'r');

      const liveData: ProcessStringsResult = {
        pid,
        processName,
        regions: readable.map((e) => ({
          addrStart: e.addrStart,
          addrEnd: e.addrEnd,
          perms: e.perms,
          name: e.name,
          sizeKb: e.sizeKb,
          stringCount: 0,
        })),
        strings: [],
        scanning: true,
        scannedVmas: 0,
        totalVmas: readable.length,
      };
      this.stringsData = liveData;
      m.redraw();

      await this.conn.grepVmaStrings(
        pid,
        allEntries,
        (newStrings, regions, completed, total) => {
          for (const s of newStrings) liveData.strings.push(s);
          liveData.regions = regions;
          liveData.scannedVmas = completed;
          liveData.totalVmas = total;
          this.stringsData = {...liveData, strings: [...liveData.strings]};
          m.redraw();
        },
      );

      liveData.scanning = false;
      this.stringsData = {...liveData, strings: [...liveData.strings]};
      m.redraw();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'String scan failed';
      m.redraw();
    }
  }
}
