import * as vscode from 'vscode';
import { NEW_GROUP, StateStore, agentDisplayName } from './state';

/** A row in the panel: a group header, or a chat tab inside one. */
export type Node =
  | { kind: 'group'; name: string }
  | { kind: 'tab'; id: string; group: string };

/**
 * What a drag changed — tells the renderer how to reconcile the native strip to the new state with the
 * MINIMUM work (the smooth-drag fix). A group reorder re-lays the open tabs in the new order; a tab move
 * is spliced surgically into just the target group. `movedIds` is enough — the renderer reads the new
 * positions (and the now-current target group, post auto-rename) straight from the store.
 */
export type Arrange =
  | { kind: 'group-order' }
  | { kind: 'tab-move'; movedIds: string[] };

// The tree's own drag MIME (lower-cased view id) — lets it accept drops of its own rows.
const MIME = 'application/vnd.code.tree.terminaltabs.tree';
// Fake scheme used only to hang a FileDecoration (label tint) on the active group row.
const DECO_SCHEME = 'terminaltabs';

/**
 * Group row icon. The bare `folder` (and `file`) codicon is SPECIAL in VS Code: `ThemeIcon.Folder`. When the
 * item also has a `resourceUri` (ours do — it's the hook the active-row green tint hangs on), VS Code reads it
 * as "ask the file-icon theme for THIS resource's folder icon." Our `terminaltabs://` URI is fake, so the theme
 * returns nothing and the row renders BLANK — the empty left side Max kept seeing. Every OTHER codicon
 * (`folder-opened`, `inbox`, …) renders literally. So we use `folder-opened`: grey by default, green when the
 * group is active ("click a folder → it turns colourful"). An explicit user-set `g.color` still wins when set.
 */
function groupIcon(name: string, color: string | undefined, active: boolean): vscode.ThemeIcon {
  const glyph = name === NEW_GROUP ? 'inbox' : 'folder-opened';
  if (active) return new vscode.ThemeIcon(glyph, new vscode.ThemeColor('charts.green'));
  return new vscode.ThemeIcon(glyph, new vscode.ThemeColor(color ?? 'icon.foreground'));
}

/**
 * The "Terminal Tabs" Activity Bar panel.
 *
 * FLAT by design: group headers and their chats are siblings at one level, none collapsible.
 * A collapsible parent toggles on click (collapse + my forced re-expand = the "jump" Max saw) and
 * adds an indent that misreads as hierarchy — this is a tab strip, not a file tree. Flat kills both:
 * clicking a group can't collapse it, and there's no indent. The active group is outlined by tinting
 * its row green (FileDecorationProvider, like Git colors filenames) + a green open-folder icon —
 * a real highlight that never shifts layout.
 *
 * Also the drag surface where the locked arrangement (R3/R4) is edited — the native strip can't be read back.
 */
export class TabsTree
  implements
    vscode.TreeDataProvider<Node>,
    vscode.TreeDragAndDropController<Node>,
    vscode.FileDecorationProvider
{
  readonly dropMimeTypes = [MIME];
  readonly dragMimeTypes = [MIME];

  private readonly _changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._changed.event;

  private readonly _decoChanged = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._decoChanged.event;

  constructor(
    private readonly store: StateStore,
    private readonly isOpen: (id: string) => boolean,
    // after a drag: reconcile the native strip to the new state (group reorder = re-lay; tab move = surgical splice)
    private readonly onArrange: (a: Arrange) => void,
    // tmux session alive for this id but NOT attached here? -> the 🟡 detached state (running in the background)
    private readonly sessionAlive: (id: string) => boolean = () => false,
    // session produced pane output within the last poll+hold window -> the 🔵 working state (agent streaming /
    // thinking / running a tool). Overrides 🟢/🟡; implies a live process, so it can't apply to a ⚪ tab.
    private readonly isWorking: (id: string) => boolean = () => false,
  ) {}

  private activeGroup: string | undefined;

  refresh(): void {
    this._changed.fire();
  }

  /** Mark a group active (green row + open-folder icon). Re-renders + re-tints only if it changed. */
  setActiveGroup(name: string | undefined): void {
    if (this.activeGroup === name) return;
    this.activeGroup = name;
    this._changed.fire();
    this._decoChanged.fire(undefined); // re-query row tints
  }

  // ---- flat tree: every group header + every chat is a top-level, non-collapsible row ----
  getChildren(node?: Node): Node[] {
    if (node) return []; // flat — nothing nests
    const rows: Node[] = [];
    for (const g of this.store.groups) {
      rows.push({ kind: 'group', name: g.name });
      for (const id of g.sessionIds) rows.push({ kind: 'tab', id, group: g.name });
    }
    return rows;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const g = this.store.groups.find((x) => x.name === node.name);
      const count = g?.sessionIds.length ?? 0;
      const active = node.name === this.activeGroup;
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
      item.id = `group:${node.name}`;
      item.description = String(count);
      item.contextValue = 'group';
      // resourceUri is only a hook for provideFileDecoration() to tint the active row green.
      item.resourceUri = vscode.Uri.parse(`${DECO_SCHEME}://group/${encodeURIComponent(node.name)}`);
      item.iconPath = groupIcon(node.name, g?.color, active);
      // click the group → open/regroup it as one split-tab (idempotent; selection/tint still fire too)
      item.command = { command: 'terminalTabs.openGroup', title: 'Open Group', arguments: [node] };
      return item;
    }
    const meta = this.store.meta(node.id);
    const item = new vscode.TreeItem(meta?.title || node.id.slice(0, 8), vscode.TreeItemCollapsibleState.None);
    item.id = `tab:${node.id}`;
    item.description = agentDisplayName(meta);
    item.contextValue = 'tab';
    // Four-state dot: 🔵 Working (producing output right now — beats 🟢/🟡) · 🟢 Open (attached, idle) ·
    // 🟡 Detached (tmux running in background, click to reattach) · ⚪ Suspended (no tmux — a pointer; click to
    // cold-resume from transcript).
    const open = this.isOpen(node.id);
    const detached = !open && this.sessionAlive(node.id);
    const working = (open || detached) && this.isWorking(node.id);
    const state = working ? '🔵 Working — producing output right now'
      : open ? '🟢 Open — attached & idle'
      : detached ? '🟡 Detached — running in background; click to reattach'
      : '⚪ Suspended — no process; click to resume from transcript';
    // Tooltip: state, then the AI recap (the searchable summary), then the folder. Press ✨ to (re)generate the recap.
    const tip = new vscode.MarkdownString(undefined, true);
    tip.appendMarkdown(`**${meta?.title || node.id.slice(0, 8)}**\n\n${state}\n\n`);
    tip.appendMarkdown(meta?.recap ? `${meta.recap}\n\n` : '_No recap yet — press ✨ to generate._\n\n');
    if (meta?.cwd) tip.appendMarkdown(`\`${meta.cwd}\``);
    item.tooltip = tip;
    item.iconPath = new vscode.ThemeIcon(
      open || detached ? 'circle-filled' : 'circle-outline', // filled = a process is running (blue working / green idle / yellow detached)
      working ? new vscode.ThemeColor('charts.blue')
        : open ? new vscode.ThemeColor('charts.green')
        : detached ? new vscode.ThemeColor('charts.yellow')
        : undefined,
    );
    // single click opens / focuses the terminal
    item.command = { command: 'terminalTabs.openTab', title: 'Open', arguments: [node] };
    return item;
  }

  /** Tint the active group's row label green (no badge, no layout shift). */
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== DECO_SCHEME || !this.activeGroup) return undefined;
    const name = decodeURIComponent(uri.path.replace(/^\//, ''));
    if (name !== this.activeGroup) return undefined;
    return new vscode.FileDecoration(undefined, 'Active group', new vscode.ThemeColor('charts.green'));
  }

  // ---- drag & drop: reorder within a group, move across groups (writes R3/R4 order) ----
  handleDrag(source: readonly Node[], data: vscode.DataTransfer): void {
    const tabs = source.flatMap((n) => (n.kind === 'tab' ? [n.id] : []));
    if (tabs.length) {
      data.set(MIME, new vscode.DataTransferItem({ kind: 'tabs', ids: tabs }));
      return;
    }
    const grp = source.find((n): n is { kind: 'group'; name: string } => n.kind === 'group');
    if (grp) data.set(MIME, new vscode.DataTransferItem({ kind: 'group', name: grp.name }));
  }

  handleDrop(target: Node | undefined, data: vscode.DataTransfer): void {
    const item = data.get(MIME);
    if (!item) return;
    const payload = item.value as
      | { kind: 'tabs'; ids: string[] }
      | { kind: 'group'; name: string }
      | undefined;
    if (!payload) return;

    // --- dragging a GROUP -> reorder groups ---
    if (payload.kind === 'group') {
      const beforeName =
        target?.kind === 'group' ? target.name : target?.kind === 'tab' ? target.group : undefined;
      if (beforeName === payload.name) return;
      this.store.moveGroupBefore(payload.name, beforeName);
      this.onArrange({ kind: 'group-order' }); // group order changed -> re-lay open tabs in the new order
      return;
    }

    // --- dragging CHAT(S) -> move/reorder within or across groups ---
    const ids = payload.ids;
    if (!ids?.length) return;
    let group: string;
    let beforeId: string | undefined;
    if (!target) {
      group = this.store.groups[this.store.groups.length - 1]?.name ?? '📥 New';
    } else if (target.kind === 'group') {
      group = target.name; // onto a header -> append to that group
    } else {
      group = target.group; // onto a tab -> insert before it
      beforeId = target.id;
    }
    this.store.moveBefore(ids, group, beforeId);
    this.onArrange({ kind: 'tab-move', movedIds: ids }); // surgical splice into the target, live
  }
}
