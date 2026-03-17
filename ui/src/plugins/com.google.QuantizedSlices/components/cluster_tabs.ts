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
import {Tabs} from '../../../widgets/tabs';
import type {TabsTab} from '../../../widgets/tabs';
import {
  S,
  activeCluster,
  addCluster,
  removeCluster,
  renameCluster,
  switchCluster,
} from '../state';
import type {Cluster} from '../state';

// Module-level editing state (survives across redraws).
let editingClusterId: string | null = null;
let editingName = '';

function commitRename(): void {
  if (editingClusterId) {
    renameCluster(editingClusterId, editingName);
    editingClusterId = null;
    m.redraw();
  }
}

function cancelRename(): void {
  editingClusterId = null;
  m.redraw();
}

function renderTabTitle(cl: Cluster): m.Children {
  if (editingClusterId === cl.id) {
    return m('input.qs-cluster-rename', {
      value: editingName,
      oninput: (e: Event) => {
        editingName = (e.target as HTMLInputElement).value;
      },
      onblur: () => commitRename(),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') commitRename();
        if (e.key === 'Escape') cancelRename();
      },
      oncreate: (vnode: m.VnodeDOM) => {
        const input = vnode.dom as HTMLInputElement;
        input.focus();
        input.select();
      },
      onclick: (e: Event) => e.stopPropagation(),
    });
  }

  const count = cl.traces.length;
  return m('span.qs-cluster-name', [
    cl.name,
    count > 1 ? m('span.qs-cluster-count', ` (${count})`) : null,
  ]);
}

export interface ClusterTabsAttrs {
  // Content to render for the active cluster tab.
  readonly contentForCluster?: (cl: Cluster) => m.Children;
}

export class ClusterTabs implements m.ClassComponent<ClusterTabsAttrs> {
  view({attrs}: m.CVnode<ClusterTabsAttrs>): m.Children {
    if (S.clusters.length === 0) return null;

    const cl = activeCluster();
    const contentFn = attrs.contentForCluster;

    const tabs: TabsTab[] = S.clusters.map((c) => ({
      key: c.id,
      title: renderTabTitle(c),
      content: contentFn && c.id === cl?.id ? contentFn(c) : null,
      closeButton: true,
    }));

    return m(Tabs, {
      className: 'qs-cluster-tabs',
      tabs,
      activeTabKey: S.activeClusterId ?? undefined,
      onTabChange: (key: string) => {
        // If we were editing, commit first.
        if (editingClusterId) commitRename();
        switchCluster(key);
      },
      onTabClose: (key: string) => {
        if (editingClusterId === key) editingClusterId = null;
        removeCluster(key);
      },
      onTabDblClick: (key: string) => {
        const target = S.clusters.find((c) => c.id === key);
        if (!target) return;
        editingClusterId = key;
        editingName = target.name;
        m.redraw();
      },
    });
  }
}

/** Helper: create a new empty cluster (for an "add tab" button). */
export function addEmptyCluster(name?: string): void {
  addCluster(name ?? 'New cluster', []);
}
