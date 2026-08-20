import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StateStore, StateData, NEW_GROUP, SessionMeta, AgentKind, workspaceSlug, rememberCodexLink, rememberGrokLink, rememberAgyLink } from './state';
import { TabsTree, Node, Arrange } from './tree';
import { tmuxAvailable, tmuxLaunch, killSession, hasTranscript, hasCodexSession, hasGrokSession, hasAgySession, AgentSpec, applyTmuxConf, listSessions, TmuxSessionInfo, tmuxDiag, liveCodexTranscript, liveGrokTranscript, liveAgyTranscript } from './tmux';
import { friendlyProject, discoverSessions, transcriptCwd, transcriptCwds } from './sessions';
import { recordHistory, readHistory, historyPath, HistoryEvent } from './history';
import { generateRecap, Recap, RecapOptions, RecapSource, transcriptMtime, grokSessionIdFromFile, agySessionIdFromFile } from './recaps';

/*
 * SLICE + GROUPS. Proven so far: close→drop, reload→restore-the-set, mass-close≠drop, stray-dispose.
 * Added now: groups render as split-tabs in the native strip (one tab per group), and the
 * Terminal Tabs sidebar panel (groups → chats, drag to reorder/regroup). Closing a group's tab
 * fires a close per pane → every chat in the group drops (the agreed semantics). Still plain
 * shells — tmux.ts (live reattach + mouse) + claude wiring come next.
 */

let store: StateStore;
let tree: TabsTree;
let out: vscode.OutputChannel;
let shuttingDown = false;
let counter = 0;
const liveTerminals = new Map<vscode.Terminal, string>();          // terminal -> session id
const pendingDrops = new Map<string, ReturnType<typeof setTimeout>>(); // id -> debounce timer
const STARTUP_GRACE_MS = 1500;
let graceUntil = 0;
let useTmux = false;
let view: vscode.TreeView<Node>;
let statusItem: vscode.StatusBarItem | undefined; // glanceable live-session count (also proves a reload loaded new code)
let burstedGroup: string | undefined; // the group currently shown as an editor-area grid (on-demand), if any

function log(msg: string): void {
  out?.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}
/**
 * Append a line to a persistent diag log on disk (`~/.terminal-tabs/diag.log`). Unlike the OutputChannel (which
 * vanishes on reload and only Max can see), this survives so the dot/socket behaviour INSIDE the extension host
 * — a different process+env than any shell — can be read back after a reload. Used to settle "is the build stale
 * or is listSessions empty in the host?" without a guessing round-trip. Best-effort; never throws.
 */
function diag(line: string): void {
  try {
    fs.mkdirSync(path.join(os.homedir(), '.terminal-tabs'), { recursive: true });
    fs.appendFileSync(path.join(os.homedir(), '.terminal-tabs', 'diag.log'), `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* best effort */ }
}
/**
 * Decisive dot probe: compute, with the EXACT predicates the tree uses (isOpen + sessionAliveCached), how many
 * saved tabs are Open/Detached/Suspended RIGHT NOW, and dump it + a few examples to the diag log. This settles
 * the contradiction (aliveIds is populated, yet rows render ⚪): if detached>0 here but the panel shows grey,
 * it's a VS Code render/caching miss (the computed yellow isn't painted); if detached=0, aliveIds is empty at
 * this instant (a reset we haven't accounted for) despite the activate snapshot. Never throws.
 */
function diagDots(when: string): void {
  let open = 0, detached = 0, suspended = 0;
  const ex: string[] = [];
  for (const id of store.allIds()) {
    const o = isOpen(id);
    const d = !o && sessionAliveCached(id);
    if (o) open++; else if (d) detached++; else suspended++;
    if (ex.length < 8) ex.push(`${id.slice(0, 8)}:${o ? 'O' : d ? 'D' : 'S'}`);
  }
  diag(`dots@${when} aliveIds=${aliveIds.size} liveTerms=${liveTerminals.size} saved=${store.allIds().length} → open=${open} detached=${detached} suspended=${suspended} | ${ex.join(' ')}`);
  // DEEP DUMP: the actual in-memory string values, so an id-format mismatch between the cache and the saved ids
  // (which is logically impossible from the code, yet the counts say it's happening) is exposed verbatim. Prints
  // what aliveIds holds, what a FRESH listSessions returns, the first saved id + its slice, and a direct has().
  try {
    const cached = [...aliveIds].slice(0, 6).map((x) => JSON.stringify(x)).join(',');
    const fresh = listSessions().slice(0, 6).map((s) => JSON.stringify(s.id)).join(',');
    const s0 = store.allIds()[0] ?? '';
    diag(`  DUMP@${when} aliveIds[0..6]=[${cached}] fresh[0..6]=[${fresh}] saved[0]=${JSON.stringify(s0)} sliced=${JSON.stringify(s0.slice(0, 8))} has(sliced)=${aliveIds.has(s0.slice(0, 8))}`);
  } catch (e) { diag(`  DUMP@${when} error: ${String(e)}`); }
}

/** Refresh the status-bar session counter: `● {detached}/{total}` live tmux sessions ({open here}). Click → Show Sessions. */
function updateStatus(): void {
  if (!statusItem) return;
  const total = aliveIds.size;
  const here = new Set([...liveTerminals.values()].map((id) => id.slice(0, 8)));
  const openHere = [...here].filter((id) => aliveIds.has(id)).length;
  statusItem.text = `$(terminal) ${total}`;
  statusItem.tooltip = `Persistent Terminal Tabs — ${total} live tmux session(s); ${openHere} open in this window.\nClick for the full session + RAM breakdown.`;
  statusItem.show();
}
function cfg<T>(key: string, dflt: T): T {
  return vscode.workspace.getConfiguration('terminalTabs').get<T>(key, dflt);
}
/** Per-agent launch recipe (command + resume/new arg templates), read from settings so Codex is tunable later. */
function agentSpec(kind: AgentKind): AgentSpec {
  if (kind === 'codex') {
    return {
      command: cfg('codexCommand', 'codex'),
      resumeArgs: cfg('codexResumeArgs', 'resume {id}'),
      newArgs: cfg('codexNewArgs', ''),
    };
  }
  if (kind === 'grok') {
    return {
      command: cfg('grokCommand', 'grok'),
      resumeArgs: cfg('grokResumeArgs', '--resume {id}'),
      newArgs: cfg('grokNewArgs', '--session-id {id}'),
    };
  }
  if (kind === 'agy') {
    return {
      command: cfg('agyCommand', 'agy'),
      resumeArgs: cfg('agyResumeArgs', '--conversation {id}'),
      newArgs: cfg('agyNewArgs', ''),
    };
  }
  return { command: cfg('claudeCommand', 'claude'), resumeArgs: '--resume {id}', newArgs: '--session-id {id}' };
}
/** Does a prior transcript exist for this id, under the agent's own store? (resume vs fresh). */
function hasPriorSession(id: string, cwd: string, kind: AgentKind): boolean {
  if (kind === 'codex') return hasCodexSession(id);
  if (kind === 'grok') return hasGrokSession(id);
  if (kind === 'agy') return hasAgySession(id);
  return hasTranscript(id, cwd);
}
/** Stable key for THIS window's workspace: its .code-workspace path, else root folder, else a shared empty-window slot. */
function workspaceKey(): string {
  const wf = vscode.workspace.workspaceFile;
  if (wf && wf.scheme === 'file') return wf.fsPath;
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'no-folder';
}
function isOpen(id: string): boolean {
  for (const v of liveTerminals.values()) if (v === id) return true;
  return false;
}
function terminalFor(id: string): vscode.Terminal | undefined {
  for (const [t, v] of liveTerminals) if (v === id) return t;
  return undefined;
}
/** Drop map entries whose terminal VS Code has already closed/disposed. A stale entry makes anchorFor hand
 *  back a dead parent, and splitting into a dead parent silently opens a NEW standalone tab instead of joining
 *  the group's split — the "clicking a chat doesn't join, I have to drag" bug. Prune before resolving anchors. */
function pruneDeadTerminals(): void {
  const alive = new Set(vscode.window.terminals);
  for (const [t] of [...liveTerminals]) if (!alive.has(t)) liveTerminals.delete(t);
}

/** 8-char ids of every LIVE tmux session (cached from one listSessions pass). Powers the 🟡 detached dot: a saved
 *  tab whose session is alive but isn't open here. Refreshed after actions + on a timer. */
let aliveIds = new Set<string>();
/** Re-read the live tmux set; returns whether it CHANGED (so the timer only re-renders when a dot would change). */
function refreshAlive(): boolean {
  let next: Set<string>;
  try { next = new Set(listSessions().map((s) => s.id)); } catch { return false; }
  const changed = next.size !== aliveIds.size || [...next].some((x) => !aliveIds.has(x));
  aliveIds = next;
  updateStatus(); // keep the status-bar counter honest on every poll
  return changed;
}

/** UUID from a Codex rollout path, if this is one of Codex's active JSONL files. */
function codexIdFromTranscript(file: string | undefined): string | undefined {
  return file?.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1];
}

/**
 * Permanently bind legacy Claude-labelled PTT tabs to the actual Codex rollout currently running in their tmux
 * pane. This is deliberately independent of recaps: a reload must be able to resume the right Codex chat even
 * if Max never pressed ✨. Only previously-unbound, foreground-Codex panes are inspected, keeping the lsof work
 * small. Default "chat N" tabs get one silent recap immediately so the recovered row becomes recognizable.
 */
function bindLiveCodexSessions(): boolean {
  if (!useTmux) return false;
  const candidates = listSessions().filter((s) => /\bcodex\b/i.test(s.command));
  const newlyBound: string[] = [];
  for (const session of candidates) {
    // tmux session names carry PTT's short eight-character prefix; state keeps the full UUID.
    const id = store.allIds().find((saved) => saved.startsWith(session.id));
    if (!id) continue;
    const meta = store.meta(id);
    if (!meta || meta.codexSessionId) continue;
    const codexSessionId = codexIdFromTranscript(liveCodexTranscript(session.id));
    if (!codexSessionId) continue;
    meta.codexSessionId = codexSessionId;
    meta.recapAgent = 'codex';
    meta.recapSessionId = codexSessionId;
    rememberCodexLink(id, codexSessionId);
    newlyBound.push(id);
  }
  if (!newlyBound.length) return false;
  store.save();
  for (const id of newlyBound) {
    const meta = store.meta(id);
    if (meta && /^chat \d+$/i.test(meta.title) && !meta.titleLocked) autoRecapOnOpen(id);
  }
  log(`⌁ bound ${newlyBound.length} live Codex tab(s) to their exact rollout`);
  return true;
}

/**
 * Same as bindLiveCodexSessions, for Grok typed into an older Claude-labelled PTT shell. Grok's session uuid is
 * not the PTT id unless the tab was created as a first-class Grok chat (`--session-id`). Bind before recap or
 * cold resume so ✨ and reopen hit the real ~/.grok/sessions conversation.
 */
function bindLiveGrokSessions(): boolean {
  if (!useTmux) return false;
  const candidates = listSessions().filter((s) => /\bgrok\b/i.test(s.command));
  const newlyBound: string[] = [];
  for (const session of candidates) {
    const id = store.allIds().find((saved) => saved.startsWith(session.id));
    if (!id) continue;
    const meta = store.meta(id);
    if (!meta || meta.grokSessionId) continue;
    const grokSessionId = grokSessionIdFromFile(liveGrokTranscript(session.id) ?? '');
    if (!grokSessionId) continue;
    meta.grokSessionId = grokSessionId;
    meta.recapAgent = 'grok';
    meta.recapSessionId = grokSessionId;
    rememberGrokLink(id, grokSessionId);
    newlyBound.push(id);
  }
  if (!newlyBound.length) return false;
  store.save();
  for (const id of newlyBound) {
    const meta = store.meta(id);
    if (meta && /^chat \d+$/i.test(meta.title) && !meta.titleLocked) autoRecapOnOpen(id);
  }
  log(`⌁ bound ${newlyBound.length} live Grok tab(s) to their exact session`);
  return true;
}

function bindLiveAgySessions(): boolean {
  if (!useTmux) return false;
  const candidates = listSessions().filter((s) => /\bagy\b/i.test(s.command));
  const newlyBound: string[] = [];
  for (const session of candidates) {
    const id = store.allIds().find((saved) => saved.startsWith(session.id));
    if (!id) continue;
    const meta = store.meta(id);
    if (!meta || meta.agySessionId) continue;
    const agySessionId = agySessionIdFromFile(liveAgyTranscript(session.id) ?? '');
    if (!agySessionId) continue;
    meta.agySessionId = agySessionId;
    meta.recapAgent = 'agy';
    meta.recapSessionId = agySessionId;
    rememberAgyLink(id, agySessionId);
    newlyBound.push(id);
  }
  if (!newlyBound.length) return false;
  store.save();
  for (const id of newlyBound) {
    const meta = store.meta(id);
    if (meta && /^chat \d+$/i.test(meta.title) && !meta.titleLocked) autoRecapOnOpen(id);
  }
  log(`⌁ bound ${newlyBound.length} live Antigravity tab(s) to their exact conversation`);
  return true;
}

function bindLiveForeignSessions(): boolean {
  const codex = bindLiveCodexSessions();
  const grok = bindLiveGrokSessions();
  const agy = bindLiveAgySessions();
  return codex || grok || agy;
}
/** Is this chat's tmux session alive (attached OR detached)? Reads the cache, keyed by 8-char id. */
function sessionAliveCached(id: string): boolean {
  return aliveIds.has(id.slice(0, 8));
}

/**
 * The live terminal a NEW pane of this group should split from — the group's LAST (most-recently-created) pane,
 * NOT the first. VS Code inserts a `{ parentTerminal }` split IMMEDIATELY AFTER its parent, so anchoring every
 * new pane to the first pane reversed the tail: creating [a,b,c] all split from `a` lands as [a,c,b] (the
 * panel-vs-native order mismatch — pick the middle row in the panel, hit the last native pane). Anchoring to the
 * last pane chains splits left-to-right, so native pane order == creation order == panel order.
 * Trusts liveTerminals (insertion order), so a just-created pane is a valid anchor mid-rebuild; callers prune
 * dead entries via pruneDeadTerminals() at handler entry, before any new terminal is created.
 */
function anchorFor(group: string): vscode.Terminal | undefined {
  let last: vscode.Terminal | undefined;
  for (const [t, id] of liveTerminals) if (store.groupOf(id)?.name === group) last = t;
  return last;
}

/** The folder a group "lives in": the most common cwd among its chats (newest wins ties). undefined if empty. */
function groupCwd(group: string): string | undefined {
  const g = store.groups.find((x) => x.name === group);
  if (!g) return undefined;
  const counts = new Map<string, number>();
  let best: string | undefined;
  let bestN = 0;
  for (const id of g.sessionIds) {              // in order, so the newest chat wins an equal count
    const cwd = store.meta(id)?.cwd;
    if (!cwd) continue;
    const n = (counts.get(cwd) ?? 0) + 1;
    counts.set(cwd, n);
    if (n >= bestN) { best = cwd; bestN = n; }
  }
  return best;
}

/** Where a new chat lands: the panel's selected group/tab, else the active terminal's group.
 *  Resolved through the live store so a stale selection (after an auto-rename) can't make a phantom group. */
function currentGroup(): string {
  const sel = view?.selection?.[0];
  if (sel?.kind === 'group' && store.groups.some((g) => g.name === sel.name)) return sel.name;
  if (sel?.kind === 'tab') {
    const g = store.groupOf(sel.id)?.name;
    if (g) return g;
  }
  const active = vscode.window.activeTerminal;
  if (active) {
    const id = liveTerminals.get(active);
    const g = id ? store.groupOf(id)?.name : undefined;
    if (g) return g;
  }
  return NEW_GROUP;
}

/**
 * Refresh every SAVED tab's cwd from its transcript so the panel shows each chat's REAL folder even before it's
 * opened (openTerminal self-heals only on open — until then an unopened tab kept the cwd cached at import, the
 * stale ".claude" Max saw). Panel-wide, one transcript-dir walk, no terminals opened. Keeps a cwd that moved or
 * unmounted (resolveLaunchCwd falls back to $HOME at open time); only overwrites with a folder that exists now.
 */
function reconcileCwds(): void {
  const ids = store.allIds().filter((id) => (store.meta(id)?.agent ?? 'claude') === 'claude');
  const map = transcriptCwds(ids);
  let changed = 0;
  for (const [id, cwd] of map) {
    const meta = store.meta(id);
    if (!meta || cwd === meta.cwd) continue;
    try { if (!fs.existsSync(cwd)) continue; } catch { continue; } // moved/unmounted — keep stored cwd
    meta.cwd = cwd;
    changed++;
  }
  if (changed) {
    reconcileAutoNames(); // refreshed folders may change an auto group's dominant-folder name
    store.save();
    log(`✎ cwd reconcile — refreshed ${changed} unopened tab folder(s) from transcripts`);
  }
}

/** Auto-name `auto` groups from the dominant folder of their chats (unique names only). */
function reconcileAutoNames(): void {
  for (const g of store.groups) {
    if (g.name === NEW_GROUP || g.auto !== true || g.sessionIds.length === 0) continue;
    const counts = new Map<string, number>();
    for (const id of g.sessionIds) {
      const f = friendlyProject(store.meta(id)?.cwd ?? '');
      if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    let best = '';
    let bestN = 0;
    for (const [f, n] of counts) if (n > bestN) { best = f; bestN = n; }
    if (best && best !== g.name && !store.groups.some((x) => x.name === best)) {
      log(`✎ auto-named group "${g.name}" → "${best}"`);
      store.renameGroup(g.name, best);
    }
  }
}

/**
 * The folder to launch/resume a session in — existence-checked, robust to moved or unmounted folders.
 * `claude --resume` only finds a session from `~/.claude/projects/<slug(cwd)>/`, so a stale/gone cwd → it
 * fails and the tab drops. Prefer the transcript's recorded cwd if it's still on disk, else the stored cwd
 * if it's on disk, else fall back to $HOME and flag `orphaned` (folder moved or drive unmounted — we can't
 * auto-find it; the launch then falls back cleanly instead of `cd`-failing into a cryptic bare shell).
 */
function resolveLaunchCwd(id: string, storedCwd: string, kind: AgentKind): { cwd: string; orphaned: boolean; recordedCwd?: string } {
  let tc: string | undefined;
  if (kind === 'claude') {
    tc = transcriptCwd(id);
    if (tc && fs.existsSync(tc)) return { cwd: tc, orphaned: false };
  }
  if (storedCwd && fs.existsSync(storedCwd)) return { cwd: storedCwd, orphaned: false };
  return { cwd: os.homedir(), orphaned: true, recordedCwd: tc || storedCwd || undefined };
}

function openTerminal(id: string, meta: SessionMeta, restored: boolean, editorColumn?: number): vscode.Terminal {
  const group = store.groupOf(id)?.name ?? NEW_GROUP;
  // `agent` remains the original tab recipe for compatibility, but a captured Codex/Grok session is authoritative
  // for recovery. This is what makes a legacy Claude-labelled shell reopen its real conversation after Cmd+R.
  const agySessionId = meta.agySessionId ?? (meta.recapAgent === 'agy' ? meta.recapSessionId : undefined);
  const grokSessionId = meta.grokSessionId ?? (meta.recapAgent === 'grok' ? meta.recapSessionId : undefined);
  const codexSessionId = meta.codexSessionId ?? (meta.recapAgent === 'codex' ? meta.recapSessionId : undefined);
  const kind: AgentKind = agySessionId ? 'agy' : grokSessionId ? 'grok' : codexSessionId ? 'codex' : meta.agent ?? 'claude';
  const resumeId = kind === 'agy' ? agySessionId ?? id : kind === 'grok' ? grokSessionId ?? id : kind === 'codex' ? codexSessionId ?? id : id;
  // Resolve + self-heal the REAL folder FIRST (the transcript's cwd is ground truth), so the label shows the
  // actual folder the session runs in — not a stale/default cwd cached at import (the ".claude" Max saw).
  const { cwd: realCwd, orphaned, recordedCwd } = resolveLaunchCwd(id, meta.cwd, kind);
  if (!orphaned && realCwd !== meta.cwd) { meta.cwd = realCwd; store.save(); } // self-heal a moved slice cwd
  const title = meta.title || id.slice(0, 8);
  // auto-name by the folder it runs in: "{folder} · {title}" (like Manage Terminals)
  const label = `${friendlyProject(meta.cwd)} · ${title}`;
  const opts: vscode.TerminalOptions = {
    name: label.length > 46 ? label.slice(0, 45) + '…' : label,
    isTransient: true,
  };
  if (editorColumn != null) {
    opts.location = { viewColumn: editorColumn as vscode.ViewColumn }; // burst: one cell of the editor grid
  } else {
    const anchor = anchorFor(group);
    if (anchor) opts.location = { parentTerminal: anchor }; // panel: split into the group's tab
  }
  // Auto-resume ONLY when a transcript actually exists; otherwise open a CLEAN shell (no auto-claude) so Max can
  // cd + run claude himself. This also keeps DATA-SAFETY: we NEVER auto `--session-id` (which could overwrite a
  // transcript) — a new session is pinned only when Max types `claude` (the wrapper picks --session-id vs --resume).
  const prior = hasPriorSession(resumeId, realCwd, kind);
  // ORPHANED + prior would auto-run a resume that CANNOT succeed: `claude --resume` only finds a transcript from
  // a dir munging to its project folder, and that folder's cwd is gone from disk. Auto-running it bricked the tab
  // ("No conversation found" → pre-fill → same error forever). Open a clean shell with an explanation instead.
  const doomed = prior && orphaned && kind === 'claude';
  const note = doomed
    ? `PTT: this chats folder is gone/moved (was: ${recordedCwd ?? 'unknown'}). Restore or recreate that folder, cd into it, then run: command claude --resume ${id}`
    : undefined;
  const pins = [
    grokSessionId && grokSessionId !== id ? `TT_GROK_SESSION_ID="${grokSessionId}"` : '',
    agySessionId && agySessionId !== id ? `TT_AGY_SESSION_ID="${agySessionId}"` : '',
  ].filter(Boolean).join(' ');
  const launch = useTmux
    ? tmuxLaunch(id, realCwd, agentSpec(kind), prior && !doomed, note, resumeId, pins)
    : null;
  if (launch) {
    opts.shellPath = launch.shellPath;
    opts.shellArgs = launch.shellArgs; // attach-or-create tt-<id>: close=detach, reopen=reattach
  }
  const term = vscode.window.createTerminal(opts);
  liveTerminals.set(term, id);
  if (!launch) {
    // plain-shell fallback marker; in tmux mode the terminal shows the live session itself
    term.sendText(`clear; echo "${restored ? '↻ restored' : '✚ new'} · ${group} · ${id.slice(0, 8)} · ${title}"`, true);
  }
  return term;
}

function newChat(agent: AgentKind = 'claude', targetGroup?: string): void {
  pruneDeadTerminals(); // so anchorFor below finds the group's LIVE pane (a stale one would open a new tab unsplit)
  const id = randomUUID();
  const title = `${agent === 'codex' ? 'codex' : agent === 'grok' ? 'grok' : agent === 'agy' ? 'agy' : 'chat'} ${++counter}`;
  // explicit target (the "+" on a group row, or the top "+" which pins 📥 New) wins over the selection
  const group = targetGroup ?? currentGroup();
  // inherit the target group's folder ONLY for a real group (the group "+"), so the chat lands next to its
  // group-mates. The inbox (📥 New) is a catch-all — the top "+" should open in the workspace root, not the
  // inbox's mixed cwd — so don't inherit when the target is 📥 New.
  const inherited = targetGroup && targetGroup !== NEW_GROUP ? groupCwd(group) : undefined;
  // Top "+" (no inherit): start the clean shell in HOME — neutral, never ~/.claude. Max cd's to the right folder.
  const cwd = inherited ?? os.homedir();
  const meta: SessionMeta = { title, project: 'slice', cwd, agent };
  store.add(id, meta, group);
  reconcileAutoNames();
  store.save();
  hist(id, 'add');
  const finalGroup = store.groupOf(id)?.name ?? group;
  // Open just the new chat: it splits into its group's live split (anchorFor=last keeps order) or opens as a
  // standalone tab. NEVER rerenderFrom here — with the chat pinned to 📥 New (index 0) that would re-open every
  // group below it (a 45-session stampede in lazy mode). Combine the group later to tidy native order if needed.
  // Reveal AND focus the new pane right away (the hover-split ask) — don't preserve focus on the panel. A
  // freshly-created terminal isn't reliably focusable in the same tick (VS Code is still wiring up the split),
  // so re-assert on the next tick too; a double show(false) is harmless if it already has focus.
  const term = openTerminal(id, meta, false);
  term.show(false);
  setTimeout(() => term.show(false), 0);
  tree?.refresh();
  log(`✚ added ${id.slice(0, 8)} "${title}" → ${finalGroup} (saved: ${store.allIds().length})`);
}

/** The "+" on a group row: spawn a chat straight into THAT group (skips select-then-drag). */
function newChatInGroup(node?: Node): void {
  const target = node?.kind === 'group' ? node.name : undefined;
  newChat(cfg<AgentKind>('defaultAgent', 'claude'), target);
}

async function addSession(): Promise<void> {
  const open = new Set(store.allIds());
  const picks = discoverSessions()
    .filter((s) => !open.has(s.id))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 300)
    .map((s) => ({
      label: `${friendlyProject(s.cwd)} · ${s.title}`,
      description: s.id.slice(0, 8),
      detail: s.cwd,
      sid: s.id,
      meta: { title: s.title, project: s.project, cwd: s.cwd } as SessionMeta,
    }));
  const pick = await vscode.window.showQuickPick(picks, {
    placeHolder: 'Add an existing Claude session as a tab',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!pick) return;
  const group = currentGroup();
  store.add(pick.sid, pick.meta, group);
  reconcileAutoNames();
  store.save();
  const finalGroup = store.groupOf(pick.sid)?.name ?? group;
  pruneDeadTerminals();
  openTerminal(pick.sid, pick.meta, true); // open just this one (splits into the group's live split, or standalone)
  terminalFor(pick.sid)?.show();
  tree?.refresh();
  log(`+ added existing ${pick.sid.slice(0, 8)} · ${friendlyProject(pick.meta.cwd)} → ${finalGroup}`);
}

function newGroup(): void {
  const name = store.nextGroupName();
  store.addGroupAfterInbox(name, true); // land at the TOP (right after 📥 New), not at the bottom
  store.save();
  tree?.refresh();
  log(`＋ group "${name}" after 📥 New (auto-names from its chats; right-click → Rename to fix a name)`);
}

/**
 * Render the saved state to the native strip — IDEMPOTENT. Tears down every terminal first
 * (untracking ours so their close isn't read as a drop; this also clears VS Code-revived `zsh`
 * ghosts), then rebuilds exactly the saved set, grouped + ordered. Running it twice = same result,
 * never duplicates. Used on startup restore AND by the "Open All" command.
 */
function renderAll(): void {
  for (const t of vscode.window.terminals) {
    liveTerminals.delete(t); // if it was ours, untrack BEFORE dispose so no drop fires
    t.dispose();
  }
  liveTerminals.clear();
  for (const id of store.allIds()) {
    openTerminal(id, store.meta(id) ?? { title: id.slice(0, 8), project: '', cwd: '' }, true);
  }
  tree?.refresh();
  const groups = store.groups.filter((g) => g.sessionIds.length).length;
  log(`⟳ rendered ${store.allIds().length} tab(s) across ${groups} group(s)`);
}

/** Panel index of a group by name (−1 if gone). */
function groupIndex(name: string): number {
  return store.groups.findIndex((g) => g.name === name);
}

/**
 * NATIVE ORDER FIX. VS Code can only *append* new terminals — there's no API to insert or reorder a
 * native tab — so to honor a panel reorder/insert we recreate the strip from the first changed group
 * to the end, in panel order. Groups BEFORE startIndex keep their existing (already-correct) native
 * tabs; everything from there down is disposed (untracked first → no drop) and rebuilt, so native
 * order == panel order. tmux makes the recreate lossless (detach → reattach). Cheaper than a full
 * renderAll when the change is near the bottom; equal to it at startIndex 0.
 */
function rerenderFrom(startIndex: number): void {
  const tail = store.groups.slice(Math.max(0, startIndex));
  const names = new Set(tail.map((g) => g.name));
  for (const [t, id] of [...liveTerminals]) {
    const g = store.groupOf(id)?.name;
    if (g && names.has(g)) { liveTerminals.delete(t); t.dispose(); } // untrack first -> no drop
  }
  for (const g of tail) {
    for (const id of g.sessionIds) {
      if (!isOpen(id)) {
        openTerminal(id, store.meta(id) ?? { title: id.slice(0, 8), project: '', cwd: '' }, true);
      }
    }
  }
  tree?.refresh();
  log(`⟳ re-rendered from group #${Math.max(0, startIndex)} (${tail.length} group(s); native order = panel)`);
}

/**
 * Like rerenderFrom, but re-creates ONLY currently-open terminals (closed/lazy tabs are left closed — no
 * stampede, the lazy-start contract). Used by the drag paths: reordering must never wake 40 sleeping sessions.
 * `alsoOpen` forces a few ids open even if currently closed (the moved tab in a front-insert fallback). Native
 * order among the open tabs == panel order, because we recreate in store order.
 */
function rerenderOpenFrom(startIndex: number, alsoOpen?: Set<string>): void {
  const tail = store.groups.slice(Math.max(0, startIndex));
  const names = new Set(tail.map((g) => g.name));
  const reopen = new Set<string>(alsoOpen ?? []);
  for (const [t, id] of [...liveTerminals]) {
    const gname = store.groupOf(id)?.name;
    if (gname && names.has(gname)) { reopen.add(id); liveTerminals.delete(t); t.dispose(); } // untrack first -> no drop
  }
  for (const g of tail) {
    for (const id of g.sessionIds) {
      if (reopen.has(id) && !isOpen(id)) {
        openTerminal(id, store.meta(id) ?? { title: id.slice(0, 8), project: '', cwd: '' }, true);
      }
    }
  }
  tree?.refresh();
  log(`⟳ re-laid open tabs from group #${Math.max(0, startIndex)} (${reopen.size} pane(s); closed untouched)`);
}

/**
 * SMOOTH DRAG. Reconcile the native strip to a tab move touching the MINIMUM — instead of rebuilding every
 * group from the drop point to the end (the old multi-second freeze, which in lazy mode also re-opened every
 * sleeping session). State already reflects the move; we read it back:
 *   - source group: dropping the moved pane is enough — the rest keep their order and the group tab stays put.
 *   - target group: dispose only the moved pane(s) + the panes AFTER the insertion point, then re-append
 *     [moved…, tail] into the SURVIVING group tab (tmux reattach = lossless), so native order == panel order.
 * Only OPEN tabs are ever (re)created. Front-insert / empty-target can't keep the tab anchored (VS Code can
 * only append a split), so those fall back to rerenderOpenFrom(target) — still open-only, still cheaper than
 * the old earliest-affected-to-end rebuild.
 */
function applyTabMove(movedIds: string[]): void {
  const toGroup = store.groupOf(movedIds[0])?.name; // re-read AFTER reconcileAutoNames (may have renamed it)
  const g = toGroup ? store.groups.find((x) => x.name === toGroup) : undefined;
  if (!g) { tree?.refresh(); return; }
  const openMoved = movedIds.filter(isOpen);
  if (openMoved.length === 0) { tree?.refresh(); return; } // moved a closed/lazy tab -> pure state, nothing to render

  // The target's open panes EXCLUDING the moved block (panel order), and where the moved block lands among them.
  const survivors = g.sessionIds.filter((id) => isOpen(id) && !movedIds.includes(id));
  const desiredFrom = g.sessionIds.filter((id) => survivors.includes(id) || openMoved.includes(id));
  const firstMovedAt = desiredFrom.findIndex((id) => openMoved.includes(id));

  // Front-insert (nothing survives before the moved block) or no anchor in the target -> the group's native
  // tab can't be kept in place; rebuild target-down, open-only (the moved tab is now in state but detached).
  if (firstMovedAt <= 0 || survivors.length === 0) {
    for (const id of openMoved) { const t = terminalFor(id); if (t) { liveTerminals.delete(t); t.dispose(); } }
    rerenderOpenFrom(groupIndex(g.name), new Set(openMoved));
    terminalFor(openMoved[0])?.show();
    log(`⇄ moved ${openMoved.length} tab(s) → "${g.name}" (front/empty -> re-laid target-down)`);
    return;
  }

  // Surgical splice: survivors[0..firstMovedAt-1] stay (they anchor the group tab); dispose the moved pane(s)
  // wherever they are now + the surviving tail, then re-append [moved…, tail] in panel order into that tab.
  const relay = desiredFrom.slice(firstMovedAt); // moved block + the surviving panes after it, in panel order
  for (const id of relay) { const t = terminalFor(id); if (t) { liveTerminals.delete(t); t.dispose(); } }
  const metaOf = (id: string) => store.meta(id) ?? { title: id.slice(0, 8), project: '', cwd: '' };
  for (const id of relay) openTerminal(id, metaOf(id), true);
  terminalFor(openMoved[0])?.show();
  log(`⇄ moved ${openMoved.length} tab(s) → "${toGroup}" (surgical; re-laid ${relay.length} pane(s))`);
}

// ---- on-demand GRID: burst the active group's chats into a grid in the EDITOR area, then dismiss it ----
// The panel stays the chats area; this is a momentary focus tool (keeps the clean files/chats split).

/** Auto grid shape — rows of ≤3, fewest rows, top rows fuller: 3→[3] 4→[2,2] 5→[3,2] 6→[3,3] 7→[3,2,2]. */
function gridRows(n: number): number[] {
  const rows = Math.max(1, Math.ceil(n / 3));
  const base = Math.floor(n / rows);
  const extra = n % rows; // the first `extra` rows get one more column
  return Array.from({ length: rows }, (_, r) => base + (r < extra ? 1 : 0));
}

/** Translate a row plan into a vscode.setEditorLayout argument (rows stacked top→bottom, columns inside each). */
function buildGridLayout(rows: number[]): unknown {
  if (rows.length === 1) {
    return { orientation: 0, groups: Array.from({ length: rows[0] }, () => ({})) };
  }
  return {
    orientation: 1,
    groups: rows.map((cols) => ({
      size: 1 / rows.length,
      groups: Array.from({ length: cols }, () => ({ size: 1 / cols })),
    })),
  };
}

const GRID_CAP = 9; // beyond this, cells get unreadable — the overflow stays in the panel

function setBursted(name: string | undefined): void {
  burstedGroup = name;
  vscode.commands.executeCommand('setContext', 'terminalTabs.bursted', !!name);
}

/** Move a group's chats into an editor-area grid (toggles; only one grid at a time). */
async function burstGroup(node?: Node): Promise<void> {
  const name = node?.kind === 'group' ? node.name : currentGroup();
  if (burstedGroup === name) { await collapseBurst(); return; } // same group -> toggle off
  if (burstedGroup) await collapseBurst();                      // one grid at a time
  const grp = store.groups.find((g) => g.name === name);
  if (!grp || grp.sessionIds.length === 0) {
    vscode.window.showInformationMessage(`“${name}” has no chats to show as a grid.`);
    return;
  }
  let ids = grp.sessionIds;
  if (ids.length > GRID_CAP) {
    log(`▦ grid: “${name}” has ${ids.length} chats — showing first ${GRID_CAP}, the rest stay in the panel`);
    ids = ids.slice(0, GRID_CAP);
  }
  // detach this group's panel terminals (untrack first -> no drop; tmux keeps the sessions alive)
  for (const [t, id] of [...liveTerminals]) {
    if (ids.includes(id)) { liveTerminals.delete(t); t.dispose(); }
  }
  const rows = gridRows(ids.length);
  await vscode.commands.executeCommand('vscode.setEditorLayout', buildGridLayout(rows));
  ids.forEach((id, i) =>
    openTerminal(id, store.meta(id) ?? { title: id.slice(0, 8), project: '', cwd: '' }, true, i + 1),
  );
  setBursted(name);
  tree?.refresh();
  log(`▦ grid: “${name}” → ${rows.join('+')} in the editor area (${ids.length} chats)`);
}

/** Collapse the editor grid back into the panel; chats return to their group tab, files reflow to one column. */
async function collapseBurst(): Promise<void> {
  if (!burstedGroup) return;
  const name = burstedGroup;
  setBursted(undefined);
  const ids = store.groups.find((g) => g.name === name)?.sessionIds ?? [];
  for (const [t, id] of [...liveTerminals]) {
    if (ids.includes(id)) { liveTerminals.delete(t); t.dispose(); } // untrack first -> no drop
  }
  // return the editor area to a single column so files are whole again
  await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{}] });
  const idx = groupIndex(name);
  rerenderFrom(idx >= 0 ? idx : 0); // rebuild from this group down so it lands in its panel position
  log(`▢ grid collapsed: “${name}” back to the panel`);
}

function openTab(node: Node): void {
  if (!node || node.kind !== 'tab') return;
  pruneDeadTerminals(); // so terminalFor/isOpen/laterOpen/anchorFor below see the real live set, not stale entries
  if (terminalFor(node.id)) { terminalFor(node.id)!.show(); return; }
  // Keep the native split order == panel order. VS Code can only APPEND a split, so a plain append is correct
  // ONLY when no already-open chat in this group sits AFTER this one in the panel. Otherwise appending would
  // land it out of order (the "remove the middle row drops the wrong pane" bug) — so rebuild this group's open
  // chats + this one in panel order (untrack-first dispose → no drop; tmux reattach is lossless), then focus it.
  const g = store.groups.find((x) => x.name === node.group);
  const panelIdx = g ? g.sessionIds.indexOf(node.id) : -1;
  const laterOpen = !!g && g.sessionIds.some((id, i) => i > panelIdx && isOpen(id));
  const metaOf = (id: string) => store.meta(id) ?? { title: id.slice(0, 8), project: '', cwd: '' };
  if (!laterOpen) {
    openTerminal(node.id, metaOf(node.id), true).show();
  } else {
    const order = g!.sessionIds.filter((id) => id === node.id || isOpen(id)); // open chats + this one, in panel order
    for (const [t, id] of [...liveTerminals]) {
      if (order.includes(id)) { liveTerminals.delete(t); t.dispose(); }
    }
    for (const id of order) openTerminal(id, metaOf(id), true);
    terminalFor(node.id)?.show();
  }
  autoRecapOnOpen(node.id); // transcript grew since last recap? refresh it silently in the background (never on a manual title)
  tree?.refresh();
}

/**
 * Open a whole group as ONE native split-tab, on demand — how a group renders grouped when
 * `openOnStartup` is off and you open things piecemeal (no 49-chat stampede). Idempotent: if the group
 * is already fully open it just focuses it; otherwise it tears down whatever chats of this group are
 * open (untrack first → no drop; tmux makes the rebuild lossless) and reopens them in order so they
 * form a single contiguous split-tab. Other groups are left untouched.
 */
/** All the group's chats open AND already ONE contiguous split (consecutive in creation/native order)? Then
 *  combining is a no-op (just focus). If they're open but SCATTERED as standalone tabs (the "I have to drag to
 *  trigger the split" symptom), this is false -> renderGroup re-lays them into one split. */
function groupAlreadyCombined(g: { sessionIds: string[] }): boolean {
  const open = g.sessionIds.filter(isOpen);
  if (open.length === 0 || open.length !== g.sessionIds.length) return false; // some chat is closed
  const liveOrder = [...liveTerminals.values()];
  const positions = open.map((id) => liveOrder.indexOf(id)).sort((a, b) => a - b);
  for (let i = 1; i < positions.length; i++) if (positions[i] !== positions[i - 1] + 1) return false; // scattered
  return true; // consecutive in creation order == one native split
}

async function renderGroup(name: string, force = false): Promise<void> {
  pruneDeadTerminals(); // accurate isOpen/anchor before deciding whether to re-lay
  const g = store.groups.find((x) => x.name === name);
  if (!g || g.sessionIds.length === 0) return;
  // The gentle path (a plain group-row click) skips the re-lay when the group already READS as one split, so
  // selecting a group doesn't thrash. But that read is a best-effort insertion-order heuristic — VS Code exposes
  // no API for true native split state — so it false-positives when a group's chats are open as SEPARATE tabs
  // (each opened individually is still contiguous in insertion order). An EXPLICIT Combine (`force`) must never
  // trust it, or it no-ops exactly when the user wants the merge ("nothing happens"). force → always re-lay.
  if (!force && groupAlreadyCombined(g)) { terminalFor(g.sessionIds[0])?.show(); return; }
  if (g.sessionIds.length > 12) {
    const go = await vscode.window.showWarningMessage(
      `“${name}” has ${g.sessionIds.length} chats — open them all as one split-tab?`, 'Open all', 'Cancel');
    if (go !== 'Open all') return;
  }
  for (const [t, id] of [...liveTerminals]) {
    if (g.sessionIds.includes(id)) { liveTerminals.delete(t); t.dispose(); }
  }
  for (const id of g.sessionIds) {
    openTerminal(id, store.meta(id) ?? { title: id.slice(0, 8), project: '', cwd: '' }, true);
  }
  terminalFor(g.sessionIds[0])?.show();
  tree?.refresh();
  log(`▣ opened group “${name}” as one split-tab (${g.sessionIds.length} chat(s))`);
}

/** Click a group row: render that group as one grouped split-tab (gentle — focuses if it already reads combined). */
function openGroup(node?: Node): void {
  const name = node?.kind === 'group' ? node.name : currentGroup();
  void renderGroup(name);
}

/** The split-horizontal button (and right-click → Combine): FORCE-merge a group's chats into one split-view tab,
 *  even when they already read as combined — the gentle openGroup path can no-op on that unreliable read, which is
 *  the "Combine does nothing" bug. Lossless: tmux reattaches every disposed pane as it's recreated. */
function combineGroup(node?: Node): void {
  const name = node?.kind === 'group' ? node.name : currentGroup();
  void renderGroup(name, true);
}

/** Drop one tab from the panel (kill its terminal + remove from state immediately). */
/** Append a session's current state to the append-only history ledger. Call BEFORE removing it. */
function hist(id: string, event: HistoryEvent): void {
  const m = store.meta(id);
  recordHistory({ event, id, title: m?.title ?? '', group: store.groupOf(id)?.name ?? '', cwd: m?.cwd ?? '', agent: m?.agent ?? 'claude', recap: m?.recap });
}

/**
 * Resolve recap input without changing `meta.agent`: that field is the launch/resume recipe, and older PTT tabs
 * often have a real Codex process inside a Claude-labelled shell. A live tmux→lsof match is exact; a previously
 * saved Codex rollout id is the safe post-exit fallback. Only explicit Codex tabs use the final cwd fallback.
 */
function recapBindId(r: Recap): string | undefined {
  if (r.source === 'agy') return r.agySessionId;
  if (r.source === 'grok') return r.grokSessionId;
  if (r.source === 'codex') return r.codexSessionId;
  return undefined;
}

function recapOptions(id: string, m?: SessionMeta): RecapOptions {
  const liveAgy = liveAgyTranscript(id);
  if (liveAgy) {
    return { cwd: m?.cwd, preferAgy: true, agySessionId: agySessionIdFromFile(liveAgy) };
  }
  if (m?.agySessionId || m?.recapAgent === 'agy' || m?.agent === 'agy') {
    return { cwd: m?.cwd, preferAgy: true, agySessionId: m?.agySessionId ?? m?.recapSessionId };
  }
  const liveGrok = liveGrokTranscript(id);
  if (liveGrok) {
    return { cwd: m?.cwd, preferGrok: true, grokSessionId: grokSessionIdFromFile(liveGrok) };
  }
  if (m?.grokSessionId || m?.recapAgent === 'grok' || m?.agent === 'grok') {
    return { cwd: m?.cwd, preferGrok: true, grokSessionId: m?.grokSessionId ?? m?.recapSessionId };
  }
  const live = liveCodexTranscript(id);
  if (live) {
    const match = live.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    return { cwd: m?.cwd, preferCodex: true, codexSessionId: match?.[1] };
  }
  if (m?.codexSessionId || m?.recapAgent === 'codex' || m?.agent === 'codex') {
    return { cwd: m?.cwd, preferCodex: true, codexSessionId: m?.codexSessionId ?? m?.recapSessionId };
  }
  return {};
}

function rememberRecapSource(id: string, meta: SessionMeta, opts: RecapOptions, source?: RecapSource, sessionId?: string): void {
  if (source === 'agy') {
    meta.recapAgent = 'agy';
    meta.recapSessionId = sessionId ?? opts.agySessionId;
    meta.agySessionId = sessionId ?? opts.agySessionId ?? meta.agySessionId;
    if (meta.agySessionId) rememberAgyLink(id, meta.agySessionId);
  } else if (source === 'grok') {
    meta.recapAgent = 'grok';
    meta.recapSessionId = sessionId ?? opts.grokSessionId;
    meta.grokSessionId = sessionId ?? opts.grokSessionId ?? meta.grokSessionId;
    if (meta.grokSessionId) rememberGrokLink(id, meta.grokSessionId);
  } else if (source === 'codex') {
    meta.recapAgent = 'codex';
    meta.recapSessionId = sessionId ?? opts.codexSessionId;
    meta.codexSessionId = sessionId ?? opts.codexSessionId ?? meta.codexSessionId;
    if (meta.codexSessionId) rememberCodexLink(id, meta.codexSessionId);
  } else if (source === 'claude') {
    meta.recapAgent = 'claude';
    meta.recapSessionId = undefined;
  }
}

/**
 * Recap a single chat on demand (the ✨ button): ask Haiku for a fresh {title, recap} from its transcript, store
 * the recap, and set the title UNLESS the user has manually renamed it (titleLocked). Best-effort + progress UI.
 */
async function regenerateChat(node?: Node): Promise<void> {
  if (!node || node.kind !== 'tab') return;
  const meta = store.meta(node.id);
  if (!meta) return;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `✨ Recapping “${meta.title}”…` },
    async () => {
      const opts = recapOptions(node.id, meta);
      const r = await generateRecap(node.id, opts);
      if (!r) {
        vscode.window.showWarningMessage('Could not recap this chat — no Claude, Codex, Grok, or Antigravity transcript yet, or the call failed.');
        return;
      }
      if (r.recap) meta.recap = r.recap;
      rememberRecapSource(node.id, meta, opts, r.source, recapBindId(r));
      meta.recapAt = transcriptMtime(node.id, recapOptions(node.id, meta));
      if (r.title && !meta.titleLocked) meta.title = r.title; // never clobber a manual name
      store.save();
      tree?.refresh();
      void relabelTerminal(node.id); // update the live tab name too if it's open
      log(`✨ recapped ${node.id.slice(0, 8)} → “${meta.title}”`);
    },
  );
}

/** Ids currently being auto-recapped — so a rapid re-open (or the catch-up render) can't spawn a second claude. */
const autoRecapping = new Set<string>();

/**
 * AUTO-RECAP ON OPEN (silent). When a chat is opened and its transcript has GROWN since its last recap, refresh
 * the recap quietly in the background — Max's "keep the summary current automatically" ask. Differences from the
 * ✨ button (`regenerateChat`): no progress UI, never blocks the open, and it's a no-op when nothing changed.
 * HARD RULE (Max): never clobber anything HE wrote by hand — a manually-renamed title (`titleLocked`) is left
 * exactly as is; only the AI-owned recap text is updated. The ✨ button stays the manual override either way.
 * Skips brand-new chats (no transcript → mtime 0 ≤ recapAt 0) so opening a fresh chat never spawns a claude.
 */
function autoRecapOnOpen(id: string): void {
  if (!cfg('autoRecapOnOpen', true) || !useTmux) return;
  const meta = store.meta(id);
  if (!meta || autoRecapping.has(id)) return;
  const opts = recapOptions(id, meta);
  if (transcriptMtime(id, opts) <= (meta.recapAt ?? 0)) return; // transcript hasn't grown since last recap → nothing to do
  autoRecapping.add(id);
  void (async () => {
    try {
      const r = await generateRecap(id, opts);
      if (r) {
        if (r.recap) meta.recap = r.recap;
        rememberRecapSource(id, meta, opts, r.source, recapBindId(r));
        meta.recapAt = transcriptMtime(id, recapOptions(id, meta));
        if (r.title && !meta.titleLocked) meta.title = r.title; // never overwrite a hand-set name
        store.save();
        tree?.refresh();
        void relabelTerminal(id);
        log(`✨ auto-recapped ${id.slice(0, 8)} on open → “${meta.title}”`);
      }
    } catch { /* best effort — a failed background recap is silent by design */ }
    finally { autoRecapping.delete(id); }
  })();
}

/** Re-recap every chat whose transcript changed since its last recap (skips up-to-date ones). Sequential so we
 *  never spawn dozens of claude processes at once; cancellable; cost is small per-chat Haiku calls. */
async function refreshAllRecaps(): Promise<void> {
  const stale = store.allIds().filter((id) => transcriptMtime(id, recapOptions(id, store.meta(id))) > (store.meta(id)?.recapAt ?? 0));
  if (!stale.length) { vscode.window.showInformationMessage('All recaps are up to date.'); return; }
  const go = await vscode.window.showWarningMessage(
    `Generate recaps for ${stale.length} chat(s) that changed? Small background Haiku calls, one at a time.`,
    'Generate', 'Cancel');
  if (go !== 'Generate') return;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Refreshing recaps…', cancellable: true },
    async (prog, token) => {
      let done = 0;
      for (const id of stale) {
        if (token.isCancellationRequested) break;
        const meta = store.meta(id);
        if (!meta) continue;
        prog.report({ message: `${++done}/${stale.length} · ${meta.title}`, increment: 100 / stale.length });
        const opts = recapOptions(id, meta);
        const r = await generateRecap(id, opts);
        if (r) {
          if (r.recap) meta.recap = r.recap;
          rememberRecapSource(id, meta, opts, r.source, recapBindId(r));
          meta.recapAt = transcriptMtime(id, recapOptions(id, meta));
          if (r.title && !meta.titleLocked) meta.title = r.title;
          store.save();
          tree?.refresh();
        }
      }
      log(`✨ refreshed recaps for ${done} chat(s)`);
    },
  );
}

/** Search recaps across CURRENT chats and the frozen HISTORY ledger; open a current chat, or just view a past one. */
async function searchRecaps(): Promise<void> {
  const q = (await vscode.window.showInputBox({ prompt: 'Search recaps — current chats + history', placeHolder: 'e.g. coxit, migration, survey' }))?.trim().toLowerCase();
  if (!q) return;
  type Hit = { id: string; title: string; recap: string; where: string; open: boolean };
  const hits: Hit[] = [];
  for (const id of store.allIds()) {
    const m = store.meta(id);
    if (!m) continue;
    if (`${m.title} ${m.recap ?? ''}`.toLowerCase().includes(q)) {
      hits.push({ id, title: m.title || id.slice(0, 8), recap: m.recap ?? '(no recap yet — press ✨)', where: store.groupOf(id)?.name ?? '', open: true });
    }
  }
  const seen = new Set(hits.map((h) => h.id));
  for (const e of readHistory().slice().reverse()) {
    if (seen.has(e.id)) continue;
    if (`${e.title} ${e.recap ?? ''}`.toLowerCase().includes(q)) {
      hits.push({ id: e.id, title: e.title || e.id.slice(0, 8), recap: e.recap ?? `${e.event} · ${e.group}`, where: e.group, open: false });
      seen.add(e.id);
    }
  }
  if (!hits.length) { vscode.window.showInformationMessage(`No recaps match “${q}”.`); return; }
  const pick = await vscode.window.showQuickPick(
    hits.map((h) => ({ label: `${h.open ? '$(comment)' : '$(history)'} ${h.title}`, description: h.where + (h.open ? '' : ' · history'), detail: h.recap, hit: h })),
    { placeHolder: `${hits.length} match(es) for “${q}” — open a current chat, or view a history entry`, matchOnDetail: true });
  if (!pick) return;
  if (pick.hit.open && store.has(pick.hit.id)) openTab({ kind: 'tab', id: pick.hit.id, group: store.groupOf(pick.hit.id)?.name ?? NEW_GROUP });
  else vscode.window.showInformationMessage(`History · ${pick.hit.id.slice(0, 8)} — ${pick.hit.recap}`);
}

/** Update an OPEN terminal's native tab name after a title change (best-effort; focuses it briefly). */
async function relabelTerminal(id: string): Promise<void> {
  const t = terminalFor(id);
  const meta = store.meta(id);
  if (!t || !meta) return;
  const label = `${friendlyProject(meta.cwd)} · ${meta.title || id.slice(0, 8)}`;
  t.show();
  try {
    await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: label.length > 46 ? label.slice(0, 45) + '…' : label });
  } catch { /* panel label already updated; native name fixes on next render */ }
}

/**
 * Show the history as a READ-ONLY record — like browser history. It only ever displays the ledger; the panel
 * NEVER auto-restores anything from here. If Max ever wants a past chat back, he reads its id/folder and does
 * it himself, deliberately. No automatic recovery, by design.
 */
function showHistory(): void {
  const entries = readHistory();
  if (!entries.length) {
    vscode.window.showInformationMessage('History is empty — it records as chats are created, closed, or dropped.');
    return;
  }
  const lines = [
    '# Persistent Terminal Tabs — History',
    '',
    '> Read-only record (like browser history) of every chat created / closed / dropped — newest first.',
    '> The panel never restores from here automatically; reopen anything yourself if you ever want to.',
    '',
  ];
  let day = '';
  for (const e of entries.slice().reverse()) {
    const d = e.ts.slice(0, 10);
    const t = e.ts.slice(11, 16);
    if (d !== day) { day = d; lines.push(`## ${d}`, ''); }
    lines.push(`- \`${t}\` **${e.event}** · ${e.title || '(untitled)'} · _${e.group || '—'}_ · \`${e.id.slice(0, 8)}\` · ${e.cwd || ''}`);
  }
  void vscode.workspace
    .openTextDocument({ content: lines.join('\n'), language: 'markdown' })
    .then((doc) => vscode.window.showTextDocument(doc, { preview: true }));
}

/** Map every saved tab id (8-char) -> its panel home, across ALL workspace slices (so a session belonging to
 *  another window isn't mistaken for an orphan). Used to label/triage the live tmux sessions. */
function indexAllSlices(): Map<string, { title: string; group: string; slug: string }> {
  const m = new Map<string, { title: string; group: string; slug: string }>();
  const dir = path.join(os.homedir(), '.terminal-tabs', 'workspaces');
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return m; }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as StateData;
      const slug = f.replace(/\.json$/, '');
      for (const g of d.groups ?? []) {
        for (const id of g.sessionIds ?? []) {
          m.set(id.slice(0, 8), { title: d.sessions?.[id]?.title ?? '', group: g.name, slug });
        }
      }
    } catch { /* skip a bad slice */ }
  }
  return m;
}

/** tt-* sessions alive in tmux but in NO PTT slice — pure leftover RAM, safe to kill. */
function listOrphans(): TmuxSessionInfo[] {
  const tracked = indexAllSlices();
  return listSessions().filter((s) => !tracked.has(s.id));
}

/**
 * Read-only view of every LIVE tmux session on our socket: which PTT tab it maps to (or ⚠️ orphan), attached
 * vs detached, and ~RAM — so Max can see what's actually loaded and Drop the heavy/unneeded ones. The lag isn't
 * usually orphans; it's that closing a tab now KEEPS its session alive (close-safe), so detached sessions
 * accumulate. This view + Drop (per tab) + Clean Orphans are the levers to reclaim RAM.
 */
function showSessions(): void {
  if (!useTmux) { vscode.window.showInformationMessage('tmux is off — no persistent sessions to list.'); return; }
  const sessions = listSessions();
  if (!sessions.length) { vscode.window.showInformationMessage('No live tmux sessions on the terminal-tabs socket.'); return; }
  const tracked = indexAllSlices();
  const here = workspaceSlug(store.workspaceKey);
  const totalRam = sessions.reduce((a, s) => a + s.ramMB, 0);
  const attached = sessions.filter((s) => s.attached).length;
  const orphans = sessions.filter((s) => !tracked.has(s.id));
  const byRam = (a: TmuxSessionInfo, b: TmuxSessionInfo) => b.ramMB - a.ramMB;
  const lines = [
    '# Persistent Terminal Tabs — live tmux sessions',
    '',
    `> **${sessions.length}** session(s) · **~${(totalRam / 1024).toFixed(1)} GB** · ${attached} attached · ${sessions.length - attached} detached · **${orphans.length} orphan(s)**.`,
    '> Closing a tab KEEPS its session alive (nothing lost) — so detached sessions are the RAM load. To free RAM: **Drop** a tab (trash), or **Clean Orphaned tmux Sessions** below.',
    '',
    '## Tracked in PTT (highest RAM first)',
  ];
  for (const s of sessions.filter((x) => tracked.has(x.id)).sort(byRam)) {
    const t = tracked.get(s.id)!;
    const where = t.slug === here ? '' : ` · _(${t.slug})_`;
    lines.push(`- \`tt-${s.id}\` · **${t.title || '(untitled)'}** · ${t.group}${where} · ${s.attached ? '🟢 attached' : '⚪ detached'} · ~${s.ramMB} MB`);
  }
  if (orphans.length) {
    lines.push(
      '',
      '## ⚠️ Orphans — alive in tmux, in NO PTT panel (leftovers)',
      '',
      `> ${orphans.length} session(s), ~${(orphans.reduce((a, s) => a + s.ramMB, 0) / 1024).toFixed(1)} GB. Not reachable from any panel. Run **PTT: Clean Orphaned tmux Sessions** to kill them (transcripts stay on disk).`,
      '',
    );
    for (const s of orphans.sort(byRam)) lines.push(`- \`tt-${s.id}\` · running \`${s.command}\` · ~${s.ramMB} MB`);
  }
  void vscode.workspace
    .openTextDocument({ content: lines.join('\n'), language: 'markdown' })
    .then((doc) => vscode.window.showTextDocument(doc, { preview: true }));
}

/** Kill every tt-* session that isn't in any PTT slice (reclaim leftover RAM). Confirms first; conversations
 *  keep their transcripts on disk and can be re-added later. Never auto-runs. */
async function cleanOrphans(): Promise<void> {
  if (!useTmux) { vscode.window.showInformationMessage('tmux is off — nothing to clean.'); return; }
  const orphans = listOrphans();
  if (!orphans.length) {
    vscode.window.showInformationMessage('No orphaned tmux sessions — every live session maps to a PTT tab.');
    return;
  }
  const ram = orphans.reduce((a, s) => a + s.ramMB, 0);
  const pick = await vscode.window.showWarningMessage(
    `Kill ${orphans.length} orphaned tmux session(s) (~${(ram / 1024).toFixed(1)} GB)? They're alive but in no PTT panel. Conversations stay on disk (resumable via “Add Existing Session…”).`,
    { modal: true },
    'Kill orphans',
  );
  if (pick !== 'Kill orphans') return;
  for (const s of orphans) killSession(s.id);
  log(`✗ cleaned ${orphans.length} orphaned tmux session(s) (~${(ram / 1024).toFixed(1)} GB)`);
  vscode.window.showInformationMessage(`Killed ${orphans.length} orphaned session(s).`);
}

/** The set of suspendable sessions: live tt-* that are DETACHED (no terminal viewing them in any window) and not
 *  open in THIS window. `idleBeforeSec`, if given, additionally requires the session's last activity to predate it
 *  (idle auto-suspend); omit it to take every detached session (the manual "Free RAM" button). */
function suspendable(idleBeforeSec?: number): TmuxSessionInfo[] {
  pruneDeadTerminals();
  const openHere = new Set([...liveTerminals.values()].map((id) => id.slice(0, 8)));
  return listSessions().filter(
    (s) => !s.attached && !openHere.has(s.id) && (idleBeforeSec === undefined || (s.activitySec > 0 && s.activitySec < idleBeforeSec)),
  );
}

/** Is this 8-char tmux id a Codex chat? Codex isn't pinned to the PTT id the way Claude is (`--session-id`), so a
 *  ⚪-suspended Codex chat can't cold-resume by id — it'd open fresh. So the AUTOMATIC + BULK suspenders skip Codex
 *  (it stays 🟡, reattaches live); only a deliberate per-chat ⏳ may ⚪ a Codex chat. Reattach (🟡) works regardless. */
function isCodexSession(eightCharId: string, liveCommand?: string): boolean {
  const full = store.allIds().find((x) => x.slice(0, 8) === eightCharId);
  const meta = full ? store.meta(full) : undefined;
  return /\bcodex\b/i.test(liveCommand ?? '') || meta?.agent === 'codex' || meta?.recapAgent === 'codex' || !!meta?.codexSessionId;
}

/**
 * Automatic/bulk cleanup is allowed to kill only sessions whose exact transcript is positively resumable. This
 * protects legacy Codex-in-Claude tabs even if Codex is temporarily reporting `bash` during a tool call and has
 * not been linked yet. An unknown clean shell costs RAM, but preserving it is safer than guessing and losing work.
 */
function canAutoSuspendSession(session: TmuxSessionInfo): boolean {
  if (isCodexSession(session.id, session.command)) return false;
  const full = store.allIds().find((id) => id.slice(0, 8) === session.id);
  const meta = full ? store.meta(full) : undefined;
  if (!full || !meta) return false;
  const grokId = meta.grokSessionId ?? (meta.agent === 'grok' || meta.recapAgent === 'grok' ? meta.recapSessionId : undefined);
  if (/\bgrok\b/i.test(session.command) || meta.agent === 'grok' || meta.recapAgent === 'grok' || !!meta.grokSessionId) {
    // Unbound live Grok (typed into a Claude-labelled tab) is not safely cold-resumable by PTT id.
    return !!(grokId && hasGrokSession(grokId));
  }
  const agyId = meta.agySessionId ?? (meta.agent === 'agy' || meta.recapAgent === 'agy' ? meta.recapSessionId : undefined);
  if (/\bagy\b/i.test(session.command) || meta.agent === 'agy' || meta.recapAgent === 'agy' || !!meta.agySessionId) {
    return !!(agyId && hasAgySession(agyId));
  }
  return hasPriorSession(full, meta.cwd, meta.agent ?? 'claude');
}

/** Per-chat ⏳ Suspend: send THIS chat to ⚪ — kill its tmux (frees its RAM) but keep the tab. Works from any state
 *  (🟢 open: closes the terminal too; 🟡 detached: just kills the session). Click the grey row later to cold-resume
 *  from its transcript. The deliberate "park this one, I'm done for now" button. */
function suspendTab(node?: Node): void {
  if (!node || node.kind !== 'tab') return;
  const t = terminalFor(node.id);
  if (t) { liveTerminals.delete(t); t.dispose(); } // untrack BEFORE dispose so onDidClose doesn't also act on it
  if (useTmux) killSession(node.id);
  refreshAlive();
  tree?.refresh();
  log(`💤 suspended ${node.id.slice(0, 8)} → ⚪ (tab kept; click to resume)`);
}

/**
 * Suspend (Free RAM): kill the tmux sessions of all CLOSED (🟡 detached) tabs, KEEP the tabs. The bulk version of
 * ⏳ — frees all background RAM at once. Lossless: each goes ⚪ and re-resumes from its transcript on next click
 * (hasPriorSession reads the transcript, not the live session). Only touches detached sessions — anything you're
 * viewing, here or in another window, is left alone.
 */
async function suspendClosed(): Promise<void> {
  if (!useTmux) { vscode.window.showInformationMessage('tmux is off — nothing to suspend.'); return; }
  const victims = suspendable().filter(canAutoSuspendSession);
  if (!victims.length) {
    vscode.window.showInformationMessage('Nothing to suspend — no closed sessions are running. (Open tabs keep their RAM; closed ones already freed it.)');
    return;
  }
  const ram = victims.reduce((a, s) => a + s.ramMB, 0);
  const pick = await vscode.window.showWarningMessage(
    `Suspend ${victims.length} closed session(s) and free ~${(ram / 1024).toFixed(1)} GB? The tabs stay in the panel (grey) and re-resume from their transcript on click. Any task still running in a closed tab stops.`,
    { modal: true },
    'Suspend & free RAM',
  );
  if (pick !== 'Suspend & free RAM') return;
  for (const s of victims) killSession(s.id);
  refreshAlive();
  tree?.refresh();
  log(`💤 suspended ${victims.length} closed session(s) (~${(ram / 1024).toFixed(1)} GB freed; tabs kept)`);
  vscode.window.showInformationMessage(`💤 Suspended ${victims.length} session(s), freed ~${(ram / 1024).toFixed(1)} GB. Click a grey tab to resume it.`);
}

/** Idle auto-suspend (runs at startup + every 30 min). Reaps detached sessions whose tmux activity is older than
 *  `autoSuspendHours` (0 = off). A session producing output keeps its activity fresh, so background work is spared;
 *  this only clears the genuinely-parked sessions — the multi-day pileup that thrashes a 24 GB box. Tabs are kept. */
function autoSuspendSweep(): void {
  if (!useTmux) return;
  const hours = cfg('autoSuspendHours', 12);
  if (!hours || hours <= 0) return;
  const victims = suspendable(Date.now() / 1000 - hours * 3600).filter(canAutoSuspendSession);
  if (!victims.length) return;
  const ram = victims.reduce((a, s) => a + s.ramMB, 0);
  for (const s of victims) killSession(s.id);
  refreshAlive();
  tree?.refresh();
  log(`💤 auto-suspended ${victims.length} session(s) idle > ${hours}h (~${(ram / 1024).toFixed(1)} GB freed; tabs kept, click to resume)`);
}

/**
 * Enforce "running ⟺ open" at startup. suspendOnClose kills a session on a deliberate close, but a window QUIT
 * (shuttingDown) deliberately does NOT — so the sessions that were open at quit are still alive in tmux on relaunch.
 * Past autoOpenLimit nothing auto-opens (lazy start), so those would be live-but-grey: the pileup, reborn each
 * reload. This kills any of THIS slice's sessions that aren't being opened now (and aren't attached in another
 * window), so a fresh window starts with grey = no tmux. Tabs are kept; they re-resume on click. Off if suspendOnClose is off.
 */
function suspendStrayOnStartup(): void {
  if (!useTmux || !cfg('suspendOnClose', false)) return; // default OFF: reloaded sessions stay 🟡 alive, not killed
  const mine = new Set(store.allIds().map((id) => id.slice(0, 8)));
  const victims = suspendable().filter((s) => mine.has(s.id) && canAutoSuspendSession(s));
  if (!victims.length) return;
  for (const s of victims) killSession(s.id);
  refreshAlive();
  tree?.refresh();
  log(`💤 startup: suspended ${victims.length} stray session(s) — grey = no tmux (running ⟺ open)`);
}

function dropTab(node: Node): void {
  if (!node || node.kind !== 'tab') return;
  const t = terminalFor(node.id);
  if (t) { liveTerminals.delete(t); t.dispose(); }
  if (store.has(node.id)) { hist(node.id, 'drop'); store.drop(node.id); store.save(); }
  if (useTmux) killSession(node.id); // an intentional drop ALWAYS ends the tmux session (R1), even if it had already left the set
  tree?.refresh();
  log(`✗ dropped ${node.id.slice(0, 8)} (panel)`);
}

/** Drop a whole group + all its chats. Inline 🗑 button on group rows — confirm first since one click kills N chats. */
async function dropGroup(node: Node): Promise<void> {
  if (!node || node.kind !== 'group') return;
  const ids = (store.groups.find((g) => g.name === node.name)?.sessionIds ?? []).slice();
  if (ids.length) {
    const pick = await vscode.window.showWarningMessage(
      `Drop group “${node.name}” and its ${ids.length} chat(s)? Kills their sessions and removes the tabs. Conversations stay on disk — re-add via History.`,
      { modal: true },
      'Drop group',
    );
    if (pick !== 'Drop group') return;
  }
  for (const id of ids) {
    const t = terminalFor(id);
    if (t) { liveTerminals.delete(t); t.dispose(); }
    if (useTmux) killSession(id);
  }
  if (burstedGroup === node.name) setBursted(undefined); // its grid is gone with it
  for (const id of ids) hist(id, 'drop-group');
  store.dropGroup(node.name);
  store.save();
  tree?.refresh();
  log(`✗ dropped group "${node.name}" (${ids.length} tab(s))`);
}

async function renameGroup(node: Node): Promise<void> {
  if (!node || node.kind !== 'group') return;
  if (node.name === NEW_GROUP) {
    vscode.window.showInformationMessage('The 📥 New inbox group can’t be renamed.');
    return;
  }
  const newName = (await vscode.window.showInputBox({ prompt: 'Rename group', value: node.name }))?.trim();
  if (!newName || newName === node.name) return;
  if (store.groups.some((g) => g.name === newName)) {
    vscode.window.showWarningMessage(`A group named “${newName}” already exists.`);
    return;
  }
  store.renameGroup(node.name, newName);
  const g = store.groups.find((x) => x.name === newName);
  if (g) g.auto = false; // user set the name explicitly -> stop auto-renaming it
  if (burstedGroup === node.name) setBursted(newName); // keep the grid pointing at the renamed group
  store.save();
  tree?.refresh();
  log(`✎ renamed group "${node.name}" → "${newName}"`);
}

async function renameTab(node: Node): Promise<void> {
  if (!node || node.kind !== 'tab') return;
  const meta = store.meta(node.id);
  const current = meta?.title ?? '';
  const next = (await vscode.window.showInputBox({ prompt: 'Rename chat', value: current }))?.trim();
  if (!next || next === current) return;
  if (meta) { meta.title = next; meta.titleLocked = true; } // a manual name locks out auto-recap renaming
  store.save();
  // rename the live terminal in place (no recreate -> it keeps its native split position)
  const t = terminalFor(node.id);
  if (t) {
    t.show();
    const label = `${friendlyProject(meta?.cwd ?? '')} · ${next}`;
    try {
      await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', {
        name: label.length > 46 ? label.slice(0, 45) + '…' : label,
      });
    } catch { /* panel label still updates; next full render fixes the native name */ }
  }
  tree?.refresh();
  log(`✎ renamed chat ${node.id.slice(0, 8)} → "${next}"`);
}

function commitDrop(id: string): void {
  pendingDrops.delete(id);
  if (shuttingDown) { log(`· drop SKIPPED (shutting down): ${id.slice(0, 8)}`); return; }
  if (!store.has(id)) return;
  const title = store.meta(id)?.title ?? '';
  hist(id, 'close');
  store.drop(id);
  if (useTmux) killSession(id); // close = drop = kill the tmux session (R1)
  store.save();
  tree?.refresh();
  log(`✗ dropped (closed tab): ${id.slice(0, 8)} "${title}" (saved: ${store.allIds().length})`);
}

/** Parse the legacy cockpit / Terminals Manager layout into ordered groups of session ids. */
function parseCockpitLayout(): Array<{ name: string; ids: string[] }> {
  const file = path.join(os.homedir(), '.claude', 'session-tracker', 'cockpit-layout.md');
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const UUID = /^\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
  const groups: Array<{ name: string; ids: string[] }> = [];
  let cur: { name: string; ids: string[] } | undefined;
  for (const line of text.split('\n')) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) { cur = { name: /not running/i.test(h[1]) ? '🗂 Parked' : h[1].trim(), ids: [] }; groups.push(cur); continue; }
    const m = line.match(UUID);
    if (m && cur) cur.ids.push(m[1]);
  }
  return groups.filter((g) => g.ids.length);
}

/**
 * Import the currently-open terminals from the old cockpit / Terminals Manager into THIS workspace's
 * tabs, preserving its groups + order. Resolves each session's cwd/title from its transcript
 * (`discoverSessions`). Adds to the saved set only — does NOT auto-spawn (use Open All / click a group),
 * so importing 40+ chats can't stampede the machine. Re-runnable: existing tabs are skipped.
 */
async function importFromCockpit(): Promise<void> {
  const layout = parseCockpitLayout();
  if (!layout.length) {
    vscode.window.showWarningMessage('No cockpit layout found at ~/.claude/session-tracker/cockpit-layout.md.');
    return;
  }
  const byId = new Map(discoverSessions().map((s) => [s.id, s]));
  let added = 0, already = 0, missing = 0;
  for (const g of layout) {
    store.ensureGroup(g.name, undefined, false); // explicit name → never auto-renamed
    for (const id of g.ids) {
      if (store.has(id)) { already++; continue; }
      const d = byId.get(id);
      if (!d) { missing++; continue; }
      store.add(id, { title: d.title, project: d.project, cwd: d.cwd }, g.name);
      added++;
    }
  }
  store.save();
  tree.refresh(); // panel only — Max opens groups on demand (or Open All) to avoid a 40-session stampede
  const extra = [already ? `${already} already present` : '', missing ? `${missing} without a transcript skipped` : '']
    .filter(Boolean).join(', ');
  vscode.window.showInformationMessage(
    `Imported ${added} terminal(s) into ${layout.length} group(s)${extra ? ' (' + extra + ')' : ''}. ` +
    `Click a group or run “Open All” to launch them.`
  );
  log(`⇩ imported from cockpit: +${added} added, ${already} dup, ${missing} missing → ${store.allIds().length} saved`);
}

function showState(): void {
  out.show(true);
  log('──── saved state ────');
  log(`workspace: ${store.workspaceKey}`);
  log(`file: ${store.filePath}`);
  for (const g of store.groups) {
    log(`  ## ${g.name} (${g.sessionIds.length})`);
    for (const id of g.sessionIds) log(`     ${id.slice(0, 8)}  ${store.meta(id)?.title ?? ''}`);
  }
  log(`──── ${store.allIds().length} saved · ${liveTerminals.size} live ────`);
}

export function activate(context: vscode.ExtensionContext): void {
  out = vscode.window.createOutputChannel('Persistent Terminal Tabs');
  const wsKey = workspaceKey();
  store = StateStore.forWorkspace(wsKey);
  shuttingDown = false;
  useTmux = cfg('useTmux', true) && tmuxAvailable();
  out.show(true);
  log(`▶ activated — ${store.allIds().length} saved tab(s) · tmux ${useTmux ? 'ON (lossless)' : 'off (plain shells)'}`);
  log(`  workspace: ${wsKey}`);
  log(`  state: ${store.filePath}`);

  // Status-bar session counter. Created early so updateStatus() (called from refreshAlive below) has a target.
  // Doubles as the unmistakable "this reload loaded NEW code" marker: if the `$(terminal) N` item appears, the
  // post-tri-state build is running — if it's absent, VS Code is still on a stale cached copy (Reload Window
  // doesn't reload a symlinked extension; only a full Cmd+Q does). Click → the live session + RAM breakdown.
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'terminalTabs.showSessions';
  context.subscriptions.push(statusItem);

  // Manage terminals ONLY in a workspace that already has a saved set. In every other window the
  // extension stays passive and never disposes the user's own terminals — this is what makes a
  // GLOBAL install safe across many windows (each restores only its own slice; the rest are untouched).
  const managed = store.allIds().length > 0;

  // Apply our tmux conf live (mouse ON + clipboard→pbcopy) so sessions created under an older conf scroll and
  // copy correctly without a reopen. Mouse is hardcoded on — scroll under tmux needs copy-mode (wheel).
  if (managed && useTmux) applyTmuxConf();

  // Heal every saved tab's folder from its transcript BEFORE the first paint, so unopened tabs show their real
  // folder (not the stale ".claude" cached at import). Cheap: one walk, head-reads only the saved ids.
  if (managed) reconcileCwds();

  // Seed the live-tmux set before the first paint, so dots render 🟢/🟡/⚪ correctly from the start (sessions that
  // survived the last quit show 🟡 detached, not ⚪). Cheap one-pass; kept fresh by actions + the catch-up below.
  if (managed && useTmux) {
    refreshAlive();
    bindLiveForeignSessions();
    log(`· startup: ${aliveIds.size} live tmux session(s) detected (0 here = empty at activate → catch-up re-polls)`);
    // Persist the host's real view so it can be read back after a reload (settles stale-build vs empty-listSessions).
    diag(`activate managed=${managed} useTmux=${useTmux} saved=${store.allIds().length} live=${aliveIds.size} | ${tmuxDiag()}`);
  } else {
    diag(`activate managed=${managed} useTmux=${useTmux} saved=${store.allIds().length} (alive-tracking OFF: ${!managed ? 'unmanaged window' : 'tmux unavailable'})`);
  }

  // Grace window: dispose untracked revivals (a default `zsh`) that surface right after startup.
  // Armed only in a managed window, so an unmanaged window never disposes a freshly-opened terminal.
  graceUntil = managed ? Date.now() + STARTUP_GRACE_MS : 0;
  setBursted(undefined); // burst is an in-session focus tool; reload always starts in the panel

  tree = new TabsTree(store, isOpen, (a: Arrange) => {
    store.save();
    pruneDeadTerminals(); // clear stale anchors before reconciling, so splits don't fall back to new tabs
    reconcileAutoNames(); // may rename auto groups; applyTabMove re-reads the target group AFTER this
    if (a.kind === 'group-order') {
      rerenderOpenFrom(0); // group order changed -> re-lay the OPEN tabs in the new order
    } else {
      applyTabMove(a.movedIds); // surgical: touch only the moved pane(s) + the target's tail (R3/R4)
    }
    tree.refresh();
  }, sessionAliveCached);
  view = vscode.window.createTreeView<Node>('terminalTabs.tree', {
    treeDataProvider: tree,
    dragAndDropController: tree,
    showCollapseAll: false,
  });

  context.subscriptions.push(
    out,
    view,
    // Tints the active group's row green (flat rows can't collapse, so there's no jump to fight).
    vscode.window.registerFileDecorationProvider(tree),
    // Highlight the active group (also what New Chat targets).
    view.onDidChangeSelection((e) => {
      const sel = e.selection[0];
      const g = sel?.kind === 'group' ? sel.name : sel?.kind === 'tab' ? store.groupOf(sel.id)?.name : undefined;
      tree.setActiveGroup(g);
    }),
    vscode.window.onDidOpenTerminal((t) => {
      if (Date.now() < graceUntil && !liveTerminals.has(t)) {
        log(`· disposed stray terminal during startup: "${t.name}"`);
        t.dispose();
      }
    }),
    // A terminal closed (tab closed, reload, crash, or process exit). DEFAULT IS SAFE: keep the tab AND its
    // tmux session — closing must be RECOVERABLE (Max lost chats to the old close=drop=kill rule). The tmux
    // session keeps running detached; the row just goes grey; click it to reattach. ONLY an explicit Drop
    // (trash) removes + kills. Opt back into close=drop=kill via `terminalTabs.closeToDrop`.
    vscode.window.onDidCloseTerminal((t) => {
      const id = liveTerminals.get(t);
      if (!id) return;
      liveTerminals.delete(t); // the terminal object is gone; the tmux session is untouched (still alive)
      if (shuttingDown) { log(`· close ignored (shutdown): ${id.slice(0, 8)}`); return; }
      if (!cfg('closeToDrop', false)) {
        // close-safe: the TAB is always kept. By DEFAULT closing only DETACHES — the tmux session keeps running in
        // the background (🟡), so closing/reload never stops work and reopening reattaches instantly. Opt into
        // suspendOnClose=true to instead kill the session on close (🟡→⚪, frees RAM, cold-resume on click). To free
        // a specific closed chat's RAM use the ⏳ Suspend button; for all of them use 🌙. NOTE: internal re-lays
        // untrack the terminal BEFORE dispose, so we only reach here on a REAL user close (Cmd+W / closing a split).
        if (useTmux && cfg('suspendOnClose', false)) {
          killSession(id);
          log(`💤 tab closed — SUSPENDED (session killed, tab kept; click to resume): ${id.slice(0, 8)}`);
        } else {
          log(`· tab closed — DETACHED (session alive in background 🟡; click to reattach): ${id.slice(0, 8)}`);
        }
        refreshAlive();
        tree?.refresh(); // dot goes 🟡 detached (or ⚪ if suspendOnClose) but the tab stays
        return;
      }
      const ms = cfg('closeDebounceMs', 800);
      log(`· close seen — closeToDrop on, debouncing ${ms}ms: ${id.slice(0, 8)}`);
      pendingDrops.set(id, setTimeout(() => commitDrop(id), ms));
    }),
    vscode.commands.registerCommand('terminalTabs.newChat', () => newChat(cfg<AgentKind>('defaultAgent', 'claude'), NEW_GROUP)),
    vscode.commands.registerCommand('terminalTabs.newChatInGroup', newChatInGroup),
    vscode.commands.registerCommand('terminalTabs.newCodexChat', () => newChat('codex', NEW_GROUP)),
    vscode.commands.registerCommand('terminalTabs.newGrokChat', () => newChat('grok', NEW_GROUP)),
    vscode.commands.registerCommand('terminalTabs.newAgyChat', () => newChat('agy', NEW_GROUP)),
    vscode.commands.registerCommand('terminalTabs.newGroup', newGroup),
    vscode.commands.registerCommand('terminalTabs.openAll', renderAll),
    vscode.commands.registerCommand('terminalTabs.openTab', openTab),
    vscode.commands.registerCommand('terminalTabs.openGroup', openGroup),
    vscode.commands.registerCommand('terminalTabs.combineGroup', combineGroup),
    vscode.commands.registerCommand('terminalTabs.dropTab', dropTab),
    vscode.commands.registerCommand('terminalTabs.dropGroup', dropGroup),
    vscode.commands.registerCommand('terminalTabs.renameGroup', renameGroup),
    vscode.commands.registerCommand('terminalTabs.renameTab', renameTab),
    vscode.commands.registerCommand('terminalTabs.regenerateChat', regenerateChat),
    vscode.commands.registerCommand('terminalTabs.refreshAllRecaps', refreshAllRecaps),
    vscode.commands.registerCommand('terminalTabs.searchRecaps', searchRecaps),
    vscode.commands.registerCommand('terminalTabs.burstGroup', burstGroup),
    vscode.commands.registerCommand('terminalTabs.collapseGrid', () => collapseBurst()),
    vscode.commands.registerCommand('terminalTabs.importCockpit', importFromCockpit),
    vscode.commands.registerCommand('terminalTabs.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('terminalTabs.showHistory', showHistory),
    vscode.commands.registerCommand('terminalTabs.showSessions', showSessions),
    vscode.commands.registerCommand('terminalTabs.cleanOrphans', cleanOrphans),
    vscode.commands.registerCommand('terminalTabs.suspendClosed', suspendClosed),
    vscode.commands.registerCommand('terminalTabs.suspendTab', suspendTab),
    vscode.commands.registerCommand('terminalTabs.showState', showState),
    // Diagnose the dots: re-poll tmux, FORCE a full tree re-render, log the predicate distribution, and report it.
    // Direct test of the "computed yellow but painted grey" hypothesis — if the dots go yellow right after running
    // this, it's a render/refresh miss (and this is the manual kick); if they stay grey, the log says why.
    vscode.commands.registerCommand('terminalTabs.diagDots', () => {
      const changed = refreshAlive();
      tree?.refresh();
      diagDots('manual');
      let open = 0, detached = 0, suspended = 0;
      for (const id of store.allIds()) { const o = isOpen(id); if (o) open++; else if (sessionAliveCached(id)) detached++; else suspended++; }
      vscode.window.showInformationMessage(
        `Dots: 🟢 ${open} open · 🟡 ${detached} detached · ⚪ ${suspended} suspended (of ${store.allIds().length}). Live tmux: ${aliveIds.size}. Forced a refresh${changed ? ' (live set changed)' : ''}. Logged to ~/.terminal-tabs/diag.log.`,
      );
    }),
  );

  // Seed the append-only history ledger ONCE with everything already saved, so the sessions that exist
  // right now (id + group + folder) are on record and recoverable — not just ones created from here on.
  if (managed && !fs.existsSync(historyPath())) {
    for (const id of store.allIds()) hist(id, 'snapshot');
    log(`▷ seeded history ledger with ${store.allIds().length} existing session(s) → ${historyPath()}`);
  }

  if (!managed) {
    // Unmanaged window (no saved tabs for this workspace): stay passive — leave every existing
    // terminal exactly where it is. This is the guard that makes a global install non-destructive.
    log('· passive — no saved tabs for this workspace; existing terminals left untouched');
  } else if (cfg('openOnStartup', true) && store.allIds().length <= cfg('autoOpenLimit', 8)) {
    renderAll(); // few tabs → safe to open them all at once (disposes revived ghosts + rebuilds the set)
  } else {
    // LAZY START. Opening 40+ Claude sessions at once loads every transcript into RAM simultaneously and
    // OOM-kills them — the exact crash Max hit. So past `autoOpenLimit` (or with openOnStartup off) we never
    // stampede: dispose revived ghosts, show the panel, and let each group/chat resume on demand when clicked.
    for (const t of vscode.window.terminals) { liveTerminals.delete(t); t.dispose(); }
    if (store.allIds().length) {
      log(`· lazy start — ${store.allIds().length} saved tab(s) shown; click a group/chat to open it (no stampede)`);
    }
  }
  tree.refresh();

  // Enforce "running ⟺ open" on a fresh window: kill this slice's sessions left alive by the last quit that aren't
  // being opened now, so grey = no tmux from the first paint. Then the idle backstop: auto-suspend parked sessions
  // (detached, long-idle) at startup + every 30 min, in case suspendOnClose is off or a session lingers cross-window.
  if (managed && useTmux) {
    suspendStrayOnStartup();
    const timer = setInterval(autoSuspendSweep, 30 * 60 * 1000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
    // Keep the 🟡/⚪ dots honest for changes we don't drive (a session dying on its own, another window
    // attaching/detaching): re-poll the live set every 15s and re-render only if it actually changed.
    const dotTimer = setInterval(() => {
      const bound = bindLiveForeignSessions();
      if (refreshAlive() || bound) tree?.refresh();
    }, 15000);
    context.subscriptions.push({ dispose: () => clearInterval(dotTimer) });
    // STARTUP CATCH-UP. The activate-time tmux query can come back EMPTY (the server isn't reachable from the
    // just-launched extension host yet), which renders every live session ⚪ instead of 🟡 and makes the idle
    // sweep a no-op. So re-poll a few times over the first few seconds — the dots self-correct the moment the
    // server answers, and the first real idle-suspend pass runs against a populated set. One-shots; tree?. guards.
    // Re-render UNCONDITIONALLY (not gated on the live set changing). The set is already populated at activate, so
    // a `changed`-gated refresh would no-op — leaving the single activate-time paint as the only render. If THAT
    // paint raced the view becoming ready (or VS Code restored a stale pre-reload render of the rows), the dots
    // would stay ⚪ forever with no re-render to correct them. Forcing a few repaints over the first seconds — once
    // the view is definitely live — repaints alive rows 🟡. Cheap (getTreeItem only recomputes visible rows).
    for (const ms of [400, 1200, 3000]) setTimeout(() => {
      refreshAlive();
      tree?.refresh();
      if (ms === 3000) diag(`catch-up@3000ms live=${aliveIds.size}`);
    }, ms);
    setTimeout(autoSuspendSweep, 4500);
    // Snapshot what the tree's OWN predicates resolve to, at activate-end and after everything settles — the
    // definitive read on why alive rows render ⚪ (see diagDots). These bracket the moment Max looks at the panel.
    diagDots('activate-end');
    setTimeout(() => diagDots('settled-6s'), 6000);
  }
}

export function deactivate(): void {
  shuttingDown = true;
  for (const t of pendingDrops.values()) clearTimeout(t);
  pendingDrops.clear();
  store?.save();
  log('▌ deactivate — shutting down; saved set preserved, no drops');
}
