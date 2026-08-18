import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/*
 * Per-tab tmux persistence. Each chat is a tmux session `tt-<id8>` on a DEDICATED socket
 * (`terminal-tabs`) so it never collides with the user's cockpit `cc-*` sessions on the default
 * socket. A VS Code terminal launches `tmux new-session -A` (attach-or-create):
 *   - close the VS Code tab  -> the tmux client detaches, the session keeps running (R4/R5)
 *   - reopen / move / reload -> attach again, live `claude` output preserved (lossless, R3/R7)
 *   - actually drop a chat   -> kill-session (R1)
 * Big scrollback + mouse come from a tiny conf we own (R10). Mouse is ALWAYS ON: under tmux the wheel must go
 * through copy-mode to scroll a chat's history — with it off the wheel only sends arrow keys (scrolls the input
 * box). It's hardcoded (no toggle) because a togglable setting kept drifting off and breaking scroll on reload.
 */

const SOCKET = 'terminal-tabs';
const TT_DIR = path.join(os.homedir(), '.terminal-tabs');
const CONF = path.join(TT_DIR, 'tmux.conf');
// ZDOTDIR rc used only by the fallback shell: pre-fills a failed session's exact command (press Enter to re-run).
const RESUME_RC = path.join(TT_DIR, '.zshrc');
const CANDIDATES = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];

let cached: string | null | undefined;
export function tmuxPath(): string | null {
  if (cached !== undefined) return cached;
  for (const p of CANDIDATES) {
    try { if (fs.existsSync(p)) return (cached = p); } catch { /* ignore */ }
  }
  try { cached = cp.execSync('command -v tmux', { encoding: 'utf8' }).trim() || null; }
  catch { cached = null; }
  return cached;
}

export function tmuxAvailable(): boolean {
  return !!tmuxPath();
}

export const sessionName = (id: string): string => `tt-${id.slice(0, 8)}`;

/**
 * tmux socket selector. Addressing by NAME (`-L terminal-tabs`) expands to `${TMUX_TMPDIR:-/tmp}/tmux-<uid>/...`,
 * so the EXTENSION HOST (where list/kill run) and the SPAWNED TERMINAL (where new-session runs) resolve to DIFFERENT
 * dirs whenever their env differs — reads then see "no server" while the terminal reattaches fine (the all-grey-dots
 * bug: live sessions rendered ⚪ because listSessions came back empty). Fix: once a live socket FILE exists, address
 * it by ABSOLUTE PATH (`-S`), identical from every process. Fall back to `-L` only on first launch (no socket yet;
 * tmux creates it at the default /tmp, which the next call then finds by path).
 */
function socketArgs(): string[] {
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  const dirs = [process.env.TMUX_TMPDIR, '/tmp', '/private/tmp', process.env.TMPDIR].filter(Boolean) as string[];
  for (const d of dirs) {
    const p = path.join(d, `tmux-${uid}`, SOCKET);
    try { if (fs.existsSync(p)) return ['-S', p]; } catch { /* keep probing */ }
  }
  return ['-L', SOCKET];
}

/**
 * One-line snapshot of how this PROCESS resolves the socket — written to the diag log at activate so we can SEE
 * what the extension host (a different env than any shell) actually finds. If `resolved` points at a path but
 * `list` is 0 while a shell sees sessions, the host can't reach the server (the all-grey-dots bug); the probe
 * map shows which candidate dirs had the socket file. Diagnostic only; never throws.
 */
export function tmuxDiag(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  const probes = [
    ['TMUX_TMPDIR', process.env.TMUX_TMPDIR],
    ['/tmp', '/tmp'],
    ['/private/tmp', '/private/tmp'],
    ['TMPDIR', process.env.TMPDIR],
  ]
    .filter(([, d]) => d)
    .map(([label, d]) => {
      const p = path.join(d as string, `tmux-${uid}`, SOCKET);
      let ex = false; try { ex = fs.existsSync(p); } catch { /* ignore */ }
      return `${label}:${ex ? 'FOUND' : 'no'}`;
    });
  return `tmux=${tmuxPath()} resolved=[${socketArgs().join(' ')}] probes={${probes.join(', ')}} sessions=${listSessions().length}`;
}

function ensureConf(): void {
  try {
    fs.mkdirSync(path.dirname(CONF), { recursive: true });
    // Mouse is ALWAYS on. Under tmux the wheel must go through copy-mode to scroll a chat's history; with it OFF
    // the wheel only sends arrow keys (scrolls the input box). Max keeps tmux, so mouse-off is never wanted — and
    // a togglable setting kept drifting off and breaking scroll on reload. Hardcoded so that can never happen.
    fs.writeFileSync(
      CONF,
      [
        'set -g mouse on',
        'set -g history-limit 50000',
        'setw -g aggressive-resize on',
        // Copy a mouse selection STRAIGHT to the macOS clipboard (pbcopy), not just tmux's own buffer — so a
        // drag-select is immediately Cmd+V-pasteable everywhere. (Default `set-clipboard external` leaned on
        // OSC52, which VS Code doesn't honor reliably → "I copy but paste gives stale text".)
        'set -g set-clipboard on',
        'bind-key -T copy-mode    MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"',
        'bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"',
      ].join('\n') + '\n',
    );
  } catch { /* best effort */ }
}

/**
 * Apply our tmux conf (mouse ON + clipboard→pbcopy) to the ALREADY-RUNNING server so live sessions pick it up
 * without a reopen — corrects sessions created under an older conf (mouse off, or the flaky OSC52 clipboard).
 * Forces mouse on first as belt-and-suspenders, then source-files the whole conf. Never throws.
 */
export function applyTmuxConf(): void {
  ensureConf();
  const tmux = tmuxPath();
  if (!tmux) return;
  cp.execFile(tmux, [...socketArgs(), 'set', '-g', 'mouse', 'on'], () => { /* ignore */ });
  cp.execFile(tmux, [...socketArgs(), 'source-file', CONF], () => { /* ignore */ });
}

/**
 * Write the PTT ZDOTDIR rc, sourced by its tmux shells. It (1) restores a normal interactive zsh, (2) defines a
 * `claude` wrapper that pins THIS tab's id so a manually-run `claude` stays mappable to the tab, and (3) after a
 * failed restore, pre-fills the exact command (`print -z`) so one Enter re-runs it. zsh-only; other shells just
 * get a plain prompt (the env vars are ignored), which degrades gracefully.
 */
function ensureResumeRc(): void {
  try {
    fs.mkdirSync(TT_DIR, { recursive: true });
    fs.writeFileSync(
      RESUME_RC,
      [
        '# Persistent Terminal Tabs — ZDOTDIR rc for its tmux shells (clean new chats + the fallback shell).',
        '# Restore a normal interactive zsh, add a `claude` wrapper that pins this tab, then (on a failed restore)',
        '# pre-fill the exact command so one Enter re-runs it.',
        'export ZDOTDIR="$HOME"',
        '[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"',
        '',
        '# Keep the PTT tab id == the Claude session id so this tab can always be cold-restored. After cd-ing to',
        '# your folder, just type `claude` — it pins this tab (--resume if its transcript exists, else --session-id).',
        '# User-supplied session flags (--resume/--continue/--session-id/-r/-c) PASS THROUGH untouched — pinning on',
        '# top of them would send `--session-id <tab> --resume <other>` and the CLI rejects that pair (the red',
        '# "--session-id can only be used with…" error every manual resume used to hit in a PTT tab).',
        '# Use `command claude …` to bypass the wrapper entirely.',
        'if [ -n "$TT_SESSION_ID" ]; then',
        '  claude() {',
        '    case " $* " in',
        '      (*" --resume"*|*" --continue"*|*" --session-id"*|*" -r "*|*" -c "*)',
        '        command claude "$@"; return;;',
        '    esac',
        '    local _f',
        '    for _f in "$HOME"/.claude/projects/*/"$TT_SESSION_ID".jsonl(N); do',
        '      command claude --resume "$TT_SESSION_ID" "$@"; return',
        '    done',
        '    command claude --session-id "$TT_SESSION_ID" "$@"',
        '  }',
        '  # Same pinning for Grok: a first-class tab uses --session-id = PTT id. A Grok process that was typed',
        '  # into an older Claude-labelled tab is bound via TT_GROK_SESSION_ID (the live-detected Grok uuid).',
        '  grok() {',
        '    case " $* " in',
        '      (*" --resume"*|*" --continue"*|*" --session-id"*|*" -r "*|*" -c "*|*" -s "*)',
        '        command grok "$@"; return;;',
        '    esac',
        '    local _d',
        '    for _d in "$HOME"/.grok/sessions/*/"$TT_SESSION_ID"(N); do',
        '      [ -d "$_d" ] || continue',
        '      command grok --resume "$TT_SESSION_ID" "$@"; return',
        '    done',
        '    if [ -n "$TT_GROK_SESSION_ID" ]; then',
        '      command grok --resume "$TT_GROK_SESSION_ID" "$@"; return',
        '    fi',
        '    command grok --session-id "$TT_SESSION_ID" "$@"',
        '  }',
        'fi',
        '',
        'if [ -n "$TT_RESUME_CMD" ]; then',
        '  print -P "%F{yellow}↳ this session exited (status ${TT_RESUME_STATUS:-?}). Command ready below — press Enter to re-run and see why (or edit it):%f"',
        '  print -z -- "$TT_RESUME_CMD"',
        '  unset TT_RESUME_CMD TT_RESUME_STATUS',
        'fi',
      ].join('\n') + '\n',
    );
  } catch { /* best effort */ }
}

/** Does a transcript already exist for this id? (→ resume it; else start fresh with the id pinned). */
export function hasTranscript(id: string, cwd: string): boolean {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const direct = path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
  try { if (fs.existsSync(direct)) return true; } catch { /* ignore */ }
  try {
    for (const d of fs.readdirSync(root)) {
      if (fs.existsSync(path.join(root, d, `${id}.jsonl`))) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/** How to launch/resume one agent CLI. `{id}` in either arg template is replaced with the session id. */
export interface AgentSpec {
  /** The CLI binary/command, e.g. 'claude' or 'codex'. */
  command: string;
  /** Args used when a prior session exists (resume), e.g. '--resume {id}'. Empty => bare command. */
  resumeArgs: string;
  /** Args for a brand-new session, e.g. '--session-id {id}'. Empty => bare command. */
  newArgs: string;
}

/**
 * VS Code terminal launch config that attaches-or-creates this chat's tmux session:
 *   - EXISTING (hasPrior, a transcript exists) -> auto `<command> <resumeArgs>` (continue where you left off, R5)
 *   - NEW / no transcript                      -> a CLEAN interactive shell, agent NOT auto-run. Max cd's to the
 *     right folder and types `claude` himself (the ZDOTDIR `claude` wrapper pins this tab's id). This is the
 *     deliberate choice to NOT bury new chats in `~/.claude` and let Max pick the folder.
 * `-A` means a reload/move just re-attaches the live process (the command only runs on first create).
 *
 * Resilience: an EXISTING chat resumes in a LOGIN shell; if it exits NON-ZERO (resume failed / crashed) we hand
 * off to an interactive zsh whose ZDOTDIR rc pre-fills the exact command — one Enter re-runs it. A clean exit
 * drops to a normal shell so the tab stays alive (only closing the tab is a real drop, R1). DISABLE_AUTO_COMPACT
 * keeps a resume from silently auto-compacting (manual `/compact` still works).
 */
export function tmuxLaunch(
  id: string,
  cwd: string,
  agent: AgentSpec,
  hasPrior: boolean,
  note?: string,
  resumeId: string = id,
  extraExports: string = '',
): { shellPath: string; shellArgs: string[] } | null {
  const tmux = tmuxPath();
  if (!tmux) return null;
  ensureConf();
  ensureResumeRc();
  const dir = cwd || os.homedir();
  const shell = process.env.SHELL || '/bin/zsh';
  // A note is echoed once at the top of a clean shell — used for "cannot auto-resume" explanations so a dead
  // folder never yields a silent empty terminal. Sanitized: the whole script rides inside single quotes below.
  const banner = note ? `echo ${JSON.stringify(note.replace(/'/g, ''))}; ` : '';
  const extras = extraExports ? ` ${extraExports}` : '';
  let script: string;
  if (!hasPrior) {
    // NEW / no-transcript: clean interactive shell, agent NOT auto-run. TT_SESSION_ID + the ZDOTDIR rc give a
    // `claude` wrapper that pins this tab when Max runs it after cd-ing. No `~/.claude` auto-launch.
    script = `export DISABLE_AUTO_COMPACT=1 TT_SESSION_ID="${id}"${extras} ZDOTDIR="${TT_DIR}"; ${banner}exec ${shell} -i`;
  } else {
    // EXISTING: auto-resume; on non-zero exit hand off to the rc shell with the command pre-filled (and
    // TT_SESSION_ID set so the `claude` wrapper works there too).
    const tpl = agent.resumeArgs.replace(/\{id\}/g, resumeId).trim();
    const inner = tpl ? `${agent.command} ${tpl}` : agent.command;
    script =
      `export DISABLE_AUTO_COMPACT=1 TT_SESSION_ID="${id}"${extras}; ${inner}; __tt=$?; ` +
      `if [ $__tt -ne 0 ]; then export TT_RESUME_CMD="${inner}" TT_RESUME_STATUS=$__tt ZDOTDIR="${TT_DIR}"; exec ${shell} -i; ` +
      `else exec ${shell} -i; fi`;
  }
  const command = `${shell} -l -c '${script}'`;
  return {
    shellPath: tmux,
    shellArgs: [
      ...socketArgs(), '-f', CONF,
      'new-session', '-A', '-s', sessionName(id), '-c', dir, command,
    ],
  };
}

/** Best-effort exact rollout lookup under ~/.codex/sessions. */
function codexSessionFile(id: string): string | undefined {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const stack = [root];
  let scanned = 0;
  try {
    while (stack.length && scanned < 20000) {
      const dir = stack.pop() as string;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        scanned++;
        if (e.isDirectory()) stack.push(path.join(dir, e.name));
        else if (e.name.includes(id) && e.name.endsWith('.jsonl')) return path.join(dir, e.name);
      }
    }
  } catch { /* no codex sessions yet */ }
  return undefined;
}

/** Best-effort: does a Codex session transcript for this id already exist under ~/.codex/sessions? */
export function hasCodexSession(id: string): boolean {
  return !!codexSessionFile(id);
}

function grokSessionDir(id: string): string | undefined {
  const root = path.join(os.homedir(), '.grok', 'sessions');
  try {
    for (const group of fs.readdirSync(root, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const dir = path.join(root, group.name, id);
      try { if (fs.statSync(dir).isDirectory()) return dir; } catch { /* keep scanning */ }
    }
  } catch { /* no grok sessions yet */ }
  return undefined;
}

/** Best-effort: does a Grok session directory for this id already exist under ~/.grok/sessions? */
export function hasGrokSession(id: string): boolean {
  return !!grokSessionDir(id);
}

function grokHistoryPath(sessionDir: string | undefined): string | undefined {
  if (!sessionDir) return undefined;
  const history = path.join(sessionDir, 'chat_history.jsonl');
  try { if (fs.existsSync(history)) return history; } catch { /* missing */ }
  return undefined;
}

function readGrokActiveSessions(): Array<{ session_id: string; pid: number }> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.grok', 'active_sessions.json'), 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((row) => {
      if (!row || typeof row !== 'object') return [];
      const session_id = String((row as { session_id?: unknown }).session_id ?? '');
      const pid = Number((row as { pid?: unknown }).pid);
      return session_id && Number.isFinite(pid) ? [{ session_id, pid }] : [];
    });
  } catch {
    return [];
  }
}

/** One live tmux session on our socket, with best-effort RAM (RSS of the pane process subtree, in MB). */
export interface TmuxSessionInfo {
  id: string;       // the 8-char id (session name minus the 'tt-' prefix)
  name: string;     // full 'tt-xxxxxxxx'
  attached: boolean;
  command: string;  // foreground command in the active pane
  ramMB: number;    // ~RSS of the pane pid's process subtree (0 if unknown)
  activitySec: number; // epoch seconds of the session's last activity (0 if unknown) — drives idle auto-suspend
}

/**
 * Every tt-* session on our socket: attach state, foreground command, and ~RAM (so the Sessions view can show
 * what's actually eating memory). RAM = summed RSS of each pane pid's whole subtree (claude runs as a child of
 * the launch shell, so the shell pid alone undercounts). One `ps` pass, best-effort; never throws.
 */
export function listSessions(): TmuxSessionInfo[] {
  const tmux = tmuxPath();
  if (!tmux) return [];
  // Separator is `|`, NOT `\t`: tmux sanitizes control chars in -F output to `_` when the client has no UTF-8
  // locale — exactly the extension host's env (Electron, no LANG) — so tab-separated lines came back as one
  // underscore-joined blob, split() never split, and every id became "1df558b7_0_3355_zsh_…" (the all-grey-dots
  // bug: has(id) false for every saved tab). A printable separator survives any locale; the UTF-8 env is belt
  // and suspenders so #{pane_current_command} etc. are never sanitized either.
  const FMT = '#{session_name}|#{session_attached}|#{pane_pid}|#{pane_current_command}|#{session_activity}';
  const ENV = { ...process.env, LANG: process.env.LANG || 'en_US.UTF-8' };
  const probe = (sock: string[]): string | null => {
    try { return cp.execFileSync(tmux, [...sock, 'list-sessions', '-F', FMT], { encoding: 'utf8', env: ENV }); }
    catch { return null; } // no server reachable on THIS socket address
  };
  // Primary: the absolute-path socket (env-independent). Fallback: address by NAME (`-L`) — in case the host's
  // path probe missed the real socket dir. Either returning sessions wins; both empty => genuinely no sessions.
  let raw = probe(socketArgs());
  if (raw === null || raw.trim() === '') {
    const alt = probe(['-L', SOCKET]);
    if (alt !== null && alt.trim() !== '') raw = alt;
  }
  if (raw === null) return []; // no server / no sessions on any address
  const rss = new Map<string, number>();
  const kids = new Map<string, string[]>();
  try {
    for (const ln of cp.execFileSync('ps', ['-Ao', 'pid=,ppid=,rss='], { encoding: 'utf8' }).split('\n')) {
      const m = ln.trim().split(/\s+/);
      if (m.length !== 3) continue;
      rss.set(m[0], parseInt(m[2], 10) || 0);
      const a = kids.get(m[1]); if (a) a.push(m[0]); else kids.set(m[1], [m[0]]);
    }
  } catch { /* RAM unavailable -> ramMB stays 0 */ }
  const subtreeKB = (pid: string): number => {
    let tot = 0; const seen = new Set<string>(); const stack = [pid];
    while (stack.length) {
      const x = stack.pop() as string;
      if (seen.has(x)) continue; seen.add(x);
      tot += rss.get(x) ?? 0;
      for (const k of kids.get(x) ?? []) stack.push(k);
    }
    return tot;
  };
  const out: TmuxSessionInfo[] = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('tt-')) continue;
    const [name, attached, pid, command, activity] = line.split('|');
    out.push({
      id: name.slice(3),
      name,
      attached: attached === '1',
      command: command || '',
      ramMB: pid ? Math.round(subtreeKB(pid) / 1024) : 0,
      activitySec: parseInt(activity, 10) || 0,
    });
  }
  return out;
}

/**
 * Return the exact Codex rollout currently open by a PTT tmux session, when one can be observed. A legacy PTT tab
 * may be labelled/launchable as Claude while Max has typed `codex` into its shell, so its PTT id is unrelated to
 * Codex's rollout uuid. Codex keeps its active JSONL open; following the pane's process tree and inspecting those
 * file descriptors gives us the real conversation instead of guessing "newest Codex chat in this folder".
 *
 * macOS/Linux only (lsof); callers always retain a stored-id/cwd fallback for other platforms or exited sessions.
 */
export function liveCodexTranscript(id: string): string | undefined {
  const tmux = tmuxPath();
  if (!tmux) return undefined;
  try {
    const pane = cp.execFileSync(
      tmux,
      [...socketArgs(), 'list-panes', '-t', sessionName(id), '-F', '#{pane_pid}|#{pane_current_command}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim().split('\n')[0];
    const [root, command] = pane.split('|');
    if (!root) return undefined;
    // Avoid an expensive lsof tree walk for every ordinary Claude/shell tab (notably Refresh All Recaps). During
    // a Codex tool call this field can briefly be `bash`; a tab already bound to a rollout uses its saved id then.
    if (!/\bcodex\b/i.test(command ?? '')) return undefined;

    const children = new Map<string, string[]>();
    const commands = new Map<string, string>();
    for (const line of cp.execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) continue;
      const [, pid, ppid, processCommand] = match;
      if (!pid || !ppid) continue;
      commands.set(pid, processCommand);
      const list = children.get(ppid) ?? [];
      list.push(pid);
      children.set(ppid, list);
    }
    const pids: string[] = [];
    const seen = new Set<string>();
    const stack = [root];
    while (stack.length) {
      const pid = stack.pop() as string;
      if (seen.has(pid)) continue;
      seen.add(pid); pids.push(pid);
      for (const child of children.get(pid) ?? []) stack.push(child);
    }
    if (!pids.length) return undefined;
    // `codex resume <uuid>` does not keep its rollout JSONL open on every Codex build. The exact UUID is already
    // present in the process command, so resolve it before falling back to lsof. This is also the reliable path
    // immediately after recovering a blank legacy pane.
    for (const pid of pids) {
      const match = commands.get(pid)?.match(/\bcodex\s+resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\s|$)/i);
      if (match) {
        const file = codexSessionFile(match[1]);
        if (file) return file;
      }
    }
    const lsof = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((candidate) => fs.existsSync(candidate)) ?? 'lsof';
    const raw = cp.execFileSync(lsof, ['-Fn', '-p', pids.join(',')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const files = raw.split('\n')
      .filter((line) => line.startsWith('n') && /\/\.codex\/sessions\/.*\.jsonl$/.test(line.slice(1)))
      .map((line) => line.slice(1));
    let newest: { file: string; mtime: number } | undefined;
    for (const file of files) {
      try {
        const mtime = fs.statSync(file).mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { file, mtime };
      } catch { /* file rotated while inspecting it */ }
    }
    return newest?.file;
  } catch {
    return undefined;
  }
}

/**
 * Return the chat_history.jsonl of the Grok session currently open in a PTT tmux pane. Grok typed into an older
 * Claude-labelled tab has its own uuid (not the PTT id). Prefer ~/.grok/active_sessions.json (pid → session_id),
 * then `grok --resume <uuid>` in the process tree, then lsof of ~/.grok/sessions/<cwd>/<uuid>/.
 */
export function liveGrokTranscript(id: string): string | undefined {
  const tmux = tmuxPath();
  if (!tmux) return undefined;
  try {
    const pane = cp.execFileSync(
      tmux,
      [...socketArgs(), 'list-panes', '-t', sessionName(id), '-F', '#{pane_pid}|#{pane_current_command}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim().split('\n')[0];
    const [root, command] = pane.split('|');
    if (!root) return undefined;
    if (!/\bgrok\b/i.test(command ?? '')) return undefined;

    const children = new Map<string, string[]>();
    const commands = new Map<string, string>();
    for (const line of cp.execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) continue;
      const [, pid, ppid, processCommand] = match;
      if (!pid || !ppid) continue;
      commands.set(pid, processCommand);
      const list = children.get(ppid) ?? [];
      list.push(pid);
      children.set(ppid, list);
    }
    const pids: string[] = [];
    const seen = new Set<string>();
    const stack = [root];
    while (stack.length) {
      const pid = stack.pop() as string;
      if (seen.has(pid)) continue;
      seen.add(pid); pids.push(pid);
      for (const child of children.get(pid) ?? []) stack.push(child);
    }
    if (!pids.length) return undefined;

    const active = readGrokActiveSessions();
    const pidSet = new Set(pids);
    for (const row of active) {
      if (!pidSet.has(String(row.pid))) continue;
      const file = grokHistoryPath(grokSessionDir(row.session_id));
      if (file) return file;
    }

    for (const pid of pids) {
      const match = commands.get(pid)?.match(
        /\bgrok(?:-\S+)?\s+(?:--resume|-r|--session-id|-s)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\s|$)/i,
      );
      if (match) {
        const file = grokHistoryPath(grokSessionDir(match[1]));
        if (file) return file;
      }
    }

    const lsof = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((candidate) => fs.existsSync(candidate)) ?? 'lsof';
    const raw = cp.execFileSync(lsof, ['-Fn', '-p', pids.join(',')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const dirs = new Set<string>();
    for (const line of raw.split('\n')) {
      if (!line.startsWith('n')) continue;
      const m = line.slice(1).match(/\/\.grok\/sessions\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i);
      if (m) dirs.add(m[1]);
    }
    for (const sessionId of dirs) {
      const file = grokHistoryPath(grokSessionDir(sessionId));
      if (file) return file;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Truly end a chat (drop). Detaching keeps it alive; this kills it. */
export function killSession(id: string): void {
  const tmux = tmuxPath();
  if (!tmux) return;
  cp.execFile(tmux, [...socketArgs(), 'kill-session', '-t', sessionName(id)], () => { /* ignore */ });
}

/** Is the chat's tmux session alive (independent of any VS Code terminal)? */
export function hasSession(id: string): boolean {
  const tmux = tmuxPath();
  if (!tmux) return false;
  try {
    cp.execFileSync(tmux, [...socketArgs(), 'has-session', '-t', sessionName(id)], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The tmux session exists but its agent has EXITED (it's sitting at the bare fallback shell — a "dropped" tab).
 * Reliable across a busy agent: the pane's ROOT process is our launch wrapper `<shell> -l -c '… claude …'`,
 * which keeps the agent's name in its argv the entire time the agent is alive (even mid-tool, where the
 * foreground command is a transient `bash`). Only on agent exit does `exec <shell> -i` replace that argv with
 * a bare interactive shell — so "no claude/codex in the pane-root command line" == dropped. Reattaching such a
 * session would just show the dead shell; callers kill it first so `new-session -A` recreates + re-resumes it.
 */
export function sessionDropped(id: string): boolean {
  const tmux = tmuxPath();
  if (!tmux) return false;
  try {
    const pid = cp
      .execFileSync(tmux, [...socketArgs(), 'list-panes', '-t', sessionName(id), '-F', '#{pane_pid}'], { encoding: 'utf8' })
      .trim()
      .split('\n')[0];
    if (!pid) return false;
    const cmd = cp.execFileSync('ps', ['-ww', '-o', 'command=', '-p', pid], { encoding: 'utf8' }).trim();
    return !/\bclaude\b|\bcodex\b|\bgrok\b/i.test(cmd);
  } catch {
    return false; // no session (or can't tell) → treat as not-dropped; new-session -A will create it fresh
  }
}
