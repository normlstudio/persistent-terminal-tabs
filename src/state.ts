import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The permanent inbox group new/unsorted sessions land in. */
export const NEW_GROUP = '📥 New';

/** Which CLI agent runs in a tab. Drives how it's launched/resumed. `undefined` == 'claude' (back-compat). */
export type AgentKind = 'claude' | 'codex' | 'grok' | 'agy';

export interface SessionMeta {
  title: string;
  project: string;
  cwd: string;
  /** The agent CLI this tab runs. Omitted on old slices -> treated as 'claude'. */
  agent?: AgentKind;
  /** AI-generated searchable summary of the chat (goal + latest state). Refreshed on demand; frozen into the
   *  history ledger when the chat is dropped. */
  recap?: string;
  /** Transcript mtime when `recap`/auto-`title` were last generated — skip re-recapping an unchanged chat. */
  recapAt?: number;
  /** Agent that supplied the last recap. This is deliberately separate from `agent`: an older Claude-labelled PTT
   *  tab can have Codex running inside it, but changing `agent` would break that tab's Claude resume recipe. */
  recapAgent?: AgentKind;
  /** Codex's own rollout uuid used for the last recap. Once a live Codex process is identified, keep this stable
   *  link so future refreshes do not guess between several Codex chats that share the same cwd. */
  recapSessionId?: string;
  /** Exact Codex rollout uuid powering this PTT tab. Persisted as soon as a live Codex process is observed, not
   *  only after a recap, so an older Claude-labelled tab resumes the right Codex chat after Cmd+R. */
  codexSessionId?: string;
  /** Exact Grok session uuid powering this PTT tab. Same role as `codexSessionId`: Grok typed into an older
   *  Claude-labelled shell has its own id, and we must not change `agent` or the Claude resume recipe breaks. */
  grokSessionId?: string;
  /** Exact Antigravity (`agy`) conversation uuid. Same role as `grokSessionId`. */
  agySessionId?: string;
  /** true once the user manually renamed the chat — auto-naming/recap then never overwrites the title. */
  titleLocked?: boolean;
}

/** Short label for the panel description / native tab prefix. Bound session ids win over `agent`. */
export function agentDisplayName(meta?: SessionMeta): string {
  if (!meta) return 'Claude';
  if (meta.agySessionId || meta.recapAgent === 'agy' || meta.agent === 'agy') return 'Gemini';
  if (meta.grokSessionId || meta.recapAgent === 'grok' || meta.agent === 'grok') return 'Grok';
  if (meta.codexSessionId || meta.recapAgent === 'codex' || meta.agent === 'codex') return 'Codex';
  return 'Claude';
}

export interface Group {
  name: string;
  /** Optional VS Code ThemeColor id (e.g. "charts.blue") for the group icon. */
  color?: string;
  sessionIds: string[];
  /** true = name is auto-derived from the chats inside; false/undefined = user-named (don't touch). */
  auto?: boolean;
}

export interface StateData {
  groups: Group[];
  sessions: Record<string, SessionMeta>;
}

const STATE_DIR = path.join(os.homedir(), '.terminal-tabs');
const WORKSPACES_DIR = path.join(STATE_DIR, 'workspaces');
const INDEX_FILE = path.join(STATE_DIR, 'index.json');
const LEGACY_FILE = path.join(STATE_DIR, 'state.json'); // pre-partition single global file
const CODEX_LINKS_FILE = path.join(STATE_DIR, 'codex-links.json');
const GROK_LINKS_FILE = path.join(STATE_DIR, 'grok-links.json');
const AGY_LINKS_FILE = path.join(STATE_DIR, 'agy-links.json');

type IdLinks = Record<string, string>;

function readLinks(file: string): IdLinks {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as IdLinks;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeLinks(file: string, links: IdLinks): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(links, null, 2) + '\n');
    fs.renameSync(temp, file);
  } catch { /* best effort; the workspace slice remains a second copy */ }
}

/**
 * Crash-safe PTT-id → Codex-rollout ledger. It deliberately lives outside workspace slices: an older extension
 * host may save stale in-memory slice metadata during shutdown, but it cannot erase this recovery link. Every
 * future StateStore load merges the ledger back into the slice before any terminal can be resumed or suspended.
 */
export function rememberCodexLink(pttId: string, codexSessionId: string): void {
  if (!pttId || !codexSessionId) return;
  const links = readLinks(CODEX_LINKS_FILE);
  if (links[pttId] === codexSessionId) return;
  links[pttId] = codexSessionId;
  writeLinks(CODEX_LINKS_FILE, links);
}

export function rememberGrokLink(pttId: string, grokSessionId: string): void {
  if (!pttId || !grokSessionId) return;
  const links = readLinks(GROK_LINKS_FILE);
  if (links[pttId] === grokSessionId) return;
  links[pttId] = grokSessionId;
  writeLinks(GROK_LINKS_FILE, links);
}

export function rememberAgyLink(pttId: string, agySessionId: string): void {
  if (!pttId || !agySessionId) return;
  const links = readLinks(AGY_LINKS_FILE);
  if (links[pttId] === agySessionId) return;
  links[pttId] = agySessionId;
  writeLinks(AGY_LINKS_FILE, links);
}

export function emptyStateData(): StateData {
  return { groups: [{ name: NEW_GROUP, sessionIds: [] }], sessions: {} };
}

/** Filesystem-safe slice name from a workspace key (its .code-workspace path or root folder). */
export function workspaceSlug(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'no-folder';
}

/** Where one workspace's slice of saved tabs lives. */
export function workspaceStatePath(key: string): string {
  return path.join(WORKSPACES_DIR, `${workspaceSlug(key)}.json`);
}

function readData(file: string): StateData | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as StateData;
    if (!Array.isArray(parsed.groups)) parsed.groups = [];
    if (!parsed.sessions || typeof parsed.sessions !== 'object') parsed.sessions = {};
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The single source of truth for ONE workspace: ordered groups -> ordered session ids, plus
 * per-session metadata. The open set IS the saved set (R3). Persisted atomically to
 * ~/.terminal-tabs/workspaces/<slug>.json so each VS Code window restores only its own tabs (R8),
 * with a readable ~/.terminal-tabs/index.json across all slices for cross-chat handoff (R9).
 */
export class StateStore {
  private data: StateData;
  private file: string;
  private key: string;

  constructor(file: string, key: string, data?: StateData) {
    this.file = file;
    this.key = key;
    this.data = data ?? emptyStateData();
    for (const [id, codexSessionId] of Object.entries(readLinks(CODEX_LINKS_FILE))) {
      const meta = this.data.sessions[id];
      if (!meta) continue;
      meta.codexSessionId = codexSessionId;
      meta.recapAgent = 'codex';
      meta.recapSessionId = codexSessionId;
    }
    for (const [id, grokSessionId] of Object.entries(readLinks(GROK_LINKS_FILE))) {
      const meta = this.data.sessions[id];
      if (!meta) continue;
      meta.grokSessionId = grokSessionId;
      // Don't overwrite a Codex recapAgent — a tab can't be both, but keep the last exact live bind if one raced.
      if (meta.recapAgent !== 'codex' && meta.recapAgent !== 'agy') {
        meta.recapAgent = 'grok';
        meta.recapSessionId = grokSessionId;
      }
    }
    for (const [id, agySessionId] of Object.entries(readLinks(AGY_LINKS_FILE))) {
      const meta = this.data.sessions[id];
      if (!meta) continue;
      meta.agySessionId = agySessionId;
      if (meta.recapAgent !== 'codex' && meta.recapAgent !== 'grok') {
        meta.recapAgent = 'agy';
        meta.recapSessionId = agySessionId;
      }
    }
    // Guarantee the inbox always exists.
    this.ensureGroup(NEW_GROUP);
  }

  /**
   * Load the slice for one workspace. First run migrates the pre-partition global state.json into
   * whichever workspace loads first, then consumes it (rename) so other windows don't re-adopt it.
   */
  static forWorkspace(key: string): StateStore {
    const file = workspaceStatePath(key);
    const own = readData(file);
    if (own) return new StateStore(file, key, own);
    const legacy = readData(LEGACY_FILE);
    if (legacy) {
      const store = new StateStore(file, key, legacy);
      store.save();
      try { fs.renameSync(LEGACY_FILE, `${LEGACY_FILE}.migrated-${workspaceSlug(key)}`); } catch { /* best effort */ }
      return store;
    }
    return new StateStore(file, key);
  }

  get filePath(): string {
    return this.file;
  }
  get workspaceKey(): string {
    return this.key;
  }

  get groups(): Group[] {
    return this.data.groups;
  }

  meta(id: string): SessionMeta | undefined {
    return this.data.sessions[id];
  }

  /** Every saved session id, in group then in-group order. */
  allIds(): string[] {
    return this.data.groups.flatMap((g) => g.sessionIds);
  }

  has(id: string): boolean {
    return this.data.groups.some((g) => g.sessionIds.includes(id));
  }

  groupOf(id: string): Group | undefined {
    return this.data.groups.find((g) => g.sessionIds.includes(id));
  }

  ensureGroup(name: string, color?: string, auto?: boolean): Group {
    let g = this.data.groups.find((x) => x.name === name);
    if (!g) {
      g = { name, color, sessionIds: [], auto };
      this.data.groups.push(g);
    } else if (color && !g.color) {
      g.color = color;
    }
    return g;
  }

  /** Create a new group positioned RIGHT AFTER the inbox (📥 New), not at the end. No-op if it exists. */
  addGroupAfterInbox(name: string, auto?: boolean): Group {
    const existing = this.data.groups.find((x) => x.name === name);
    if (existing) return existing;
    const g: Group = { name, sessionIds: [], auto };
    const inboxIdx = this.data.groups.findIndex((x) => x.name === NEW_GROUP);
    this.data.groups.splice(inboxIdx >= 0 ? inboxIdx + 1 : 0, 0, g);
    return g;
  }

  /** Smallest "Group N" not already taken — the instant default name for a new group. */
  nextGroupName(): string {
    for (let n = 1; ; n++) {
      const name = `Group ${n}`;
      if (!this.data.groups.some((g) => g.name === name)) return name;
    }
  }

  /** Add (or update) a session, appending it to a group if not already saved. */
  add(id: string, meta: SessionMeta, group: string = NEW_GROUP): void {
    this.data.sessions[id] = meta;
    if (!this.has(id)) {
      this.ensureGroup(group).sessionIds.push(id);
    }
  }

  drop(id: string): void {
    for (const g of this.data.groups) {
      const i = g.sessionIds.indexOf(id);
      if (i >= 0) g.sessionIds.splice(i, 1);
    }
    delete this.data.sessions[id];
  }

  /** Remove a whole group; returns the dropped ids. The inbox is emptied but kept. */
  dropGroup(name: string): string[] {
    const g = this.data.groups.find((x) => x.name === name);
    if (!g) return [];
    const ids = [...g.sessionIds];
    for (const id of ids) delete this.data.sessions[id];
    if (name === NEW_GROUP) {
      g.sessionIds = [];
    } else {
      this.data.groups = this.data.groups.filter((x) => x.name !== name);
    }
    return ids;
  }

  /** Move ids into targetGroup, inserted before beforeId (or appended). Preserves metadata + order. */
  moveBefore(ids: string[], targetGroup: string, beforeId?: string): void {
    const set = new Set(ids);
    for (const g of this.data.groups) g.sessionIds = g.sessionIds.filter((i) => !set.has(i));
    const g = this.ensureGroup(targetGroup);
    let idx = beforeId ? g.sessionIds.indexOf(beforeId) : g.sessionIds.length;
    if (idx < 0) idx = g.sessionIds.length;
    g.sessionIds.splice(idx, 0, ...ids.filter((i) => this.data.sessions[i]));
  }

  /** Reorder groups: move `name` to just before `beforeName` (or to the end if omitted). */
  moveGroupBefore(name: string, beforeName?: string): void {
    const from = this.data.groups.findIndex((g) => g.name === name);
    if (from < 0) return;
    const [g] = this.data.groups.splice(from, 1);
    let to = beforeName ? this.data.groups.findIndex((x) => x.name === beforeName) : this.data.groups.length;
    if (to < 0) to = this.data.groups.length;
    this.data.groups.splice(to, 0, g);
  }

  /** Rename a group, keeping its order/membership. No-op if the new name is taken. */
  renameGroup(oldName: string, newName: string): void {
    const g = this.data.groups.find((x) => x.name === oldName);
    if (g && newName && !this.data.groups.some((x) => x.name === newName)) g.name = newName;
  }

  /** Atomic write (temp file + rename) so a crash mid-write can't corrupt state, then refresh the index. */
  save(): void {
    fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
    this.updateIndex();
  }

  /** A readable central map of every workspace slice — so a fresh Claude session can discover them (R9). */
  private updateIndex(): void {
    let idx: Record<string, unknown> = {};
    try { idx = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { /* first write */ }
    idx[workspaceSlug(this.key)] = {
      workspace: this.key,
      file: this.file,
      groups: this.data.groups.length,
      sessions: Object.keys(this.data.sessions).length,
      updated: new Date().toISOString(),
    };
    try {
      const tmp = `${INDEX_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), 'utf8');
      fs.renameSync(tmp, INDEX_FILE);
    } catch { /* best effort */ }
  }
}
