import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/*
 * Recap engine. For a chat, read its transcript and ask a cheap, context-STRIPPED `claude -p` (Haiku) for a
 * short {title, recap}. "Stripped" = no MCP, no setting-sources, no tools — that keeps the cached default system
 * prompt (cheap to read) but drops the ~$0.05 harness overhead; a real call lands ~$0.02. We DON'T pass a custom
 * --system-prompt (that busts the shared cache and costs MORE). The title feeds the tab name; the recap is the
 * searchable summary. Generation is on-demand (manual ✨ button / explicit bulk) — never a silent background loop.
 */

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_DIR = path.join(os.homedir(), '.codex', 'sessions');
const GROK_DIR = path.join(os.homedir(), '.grok', 'sessions');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RecapSource = 'claude' | 'codex' | 'grok';

export interface Recap {
  title: string;
  recap: string;
  /** Which transcript supplied this result — persisted by the caller to prevent later ambiguity. */
  source: RecapSource;
  /** Codex's own session id, when `source === 'codex'`. */
  codexSessionId?: string;
  /** Grok's own session id, when `source === 'grok'`. */
  grokSessionId?: string;
}

export interface RecapOptions {
  model?: string;
  /** Needed for the final best-effort Codex/Grok cwd fallback. */
  cwd?: string;
  /** A tab running Codex inside a legacy Claude shell must prefer Codex over an old Claude transcript with the
   *  same PTT id. */
  preferCodex?: boolean;
  /** Codex rollout uuid saved after a prior exact live-process match. */
  codexSessionId?: string;
  /** A tab running Grok inside a legacy Claude shell must prefer Grok over an old Claude transcript. */
  preferGrok?: boolean;
  /** Grok session uuid saved after a prior exact live-process match. */
  grokSessionId?: string;
}

/** session_meta.cwd from a codex rollout's head (best-effort). The first line is session_meta but it EMBEDS the
 *  full base_instructions blob (tens of KB), so parsing the whole line from a bounded read fails — instead regex
 *  the first `"cwd":"…"` out of the head chunk; in session_meta it precedes base_instructions. */
function codexRolloutCwd(file: string): string | undefined {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(8192);
      const n = fs.readSync(fd, b, 0, 8192, 0);
      const head = b.subarray(0, n).toString('utf8');
      const m = head.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (!m) return undefined;
      return JSON.parse(`"${m[1]}"`) as string; // unescape \uXXXX etc.
    } finally { fs.closeSync(fd); }
  } catch { return undefined; }
}

/**
 * Locate a Codex chat's rollout under ~/.codex/sessions (files are rollout-<ts>-<uuid>.jsonl). A tab whose id IS
 * a codex uuid (imported from an existing session) matches by filename. A codex chat STARTED by PTT has its own
 * uuid — `AgentSpec.newArgs` is empty for codex, the tab id is never pinned — so fall back to the NEWEST rollout
 * whose session_meta.cwd equals the tab's cwd: the latest codex convo in that folder. Best-effort by design.
 */
function codexSessionId(file: string): string | undefined {
  const m = path.basename(file).match(/^rollout-[^-]+(?:-[^-]+){2}-(.+)\.jsonl$/);
  // The timestamp itself contains hyphens, so prefer a UUID-shaped suffix rather than relying on field count.
  const uuid = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return uuid?.[1] ?? m?.[1];
}

function codexTranscriptFile(id: string, cwd?: string, knownSessionId?: string): string | undefined {
  const found: Array<{ f: string; m: number }> = [];
  const stack = [CODEX_DIR];
  let scanned = 0;
  try {
    while (stack.length && scanned < 5000) {
      const dir = stack.pop() as string;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        scanned++;
        if (e.isDirectory()) stack.push(path.join(dir, e.name));
        else if (e.name.endsWith('.jsonl')) {
          const f = path.join(dir, e.name);
          if (knownSessionId && e.name.includes(knownSessionId)) return f;
          if (e.name.includes(id)) return f;
          let m = 0; try { m = fs.statSync(f).mtimeMs; } catch { continue; }
          found.push({ f, m });
        }
      }
    }
  } catch { return undefined; }
  if (!cwd) return undefined;
  found.sort((a, b) => b.m - a.m);
  for (const { f } of found.slice(0, 200)) if (codexRolloutCwd(f) === cwd) return f;
  return undefined;
}

function grokHistoryIn(dir: string): string | undefined {
  const history = path.join(dir, 'chat_history.jsonl');
  try { if (fs.existsSync(history)) return history; } catch { /* missing */ }
  return undefined;
}

/** Grok groups sessions as ~/.grok/sessions/<url-encoded-cwd>/<uuid>/. Paths longer than 255 bytes use a
 *  slug+hash folder plus a `.cwd` sidecar with the original path. */
function grokCwdMatches(groupDir: string, cwd: string): boolean {
  if (path.basename(groupDir) === encodeURIComponent(cwd)) return true;
  try { return fs.readFileSync(path.join(groupDir, '.cwd'), 'utf8').trim() === cwd; }
  catch { return false; }
}

/**
 * Locate a Grok chat under ~/.grok/sessions. A first-class Grok tab pins `--session-id` to the PTT uuid, so
 * the folder name IS the tab id. A Grok process typed into an older Claude-labelled PTT tab has its own uuid —
 * callers pass that as `knownSessionId` after a live-process match. Last resort: newest session whose group
 * cwd equals the tab's cwd (only for explicit Grok tabs).
 */
export function grokTranscriptFile(id: string, cwd?: string, knownSessionId?: string): string | undefined {
  const want = knownSessionId || id;
  const found: Array<{ f: string; m: number; group: string }> = [];
  try {
    for (const group of fs.readdirSync(GROK_DIR, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const groupDir = path.join(GROK_DIR, group.name);
      let sessions: fs.Dirent[];
      try { sessions = fs.readdirSync(groupDir, { withFileTypes: true }); } catch { continue; }
      for (const session of sessions) {
        if (!session.isDirectory()) continue;
        const dir = path.join(groupDir, session.name);
        const file = grokHistoryIn(dir);
        if (!file) continue;
        if (session.name === want) return file;
        let m = 0; try { m = fs.statSync(file).mtimeMs; } catch { continue; }
        found.push({ f: file, m, group: groupDir });
      }
    }
  } catch { return undefined; }
  if (!cwd) return undefined;
  const inCwd = found.filter((x) => grokCwdMatches(x.group, cwd)).sort((a, b) => b.m - a.m);
  return inCwd[0]?.f;
}

export function grokSessionIdFromFile(file: string): string | undefined {
  const id = path.basename(path.dirname(file));
  return UUID_RE.test(id) ? id : undefined;
}

function recapSourceOf(file: string): RecapSource {
  if (file.includes(`${path.sep}.codex${path.sep}sessions${path.sep}`)) return 'codex';
  if (file.includes(`${path.sep}.grok${path.sep}sessions${path.sep}`)) return 'grok';
  return 'claude';
}

/** Locate a session transcript. A live Grok/Codex process inside an older Claude-labelled PTT tab is preferred
 *  so we never recap a leftover Claude jsonl (or the newest other chat in the same folder) by accident. */
export function transcriptFile(id: string, opts: RecapOptions = {}): string | undefined {
  const grok = () => grokTranscriptFile(id, opts.cwd, opts.grokSessionId);
  const codex = () => codexTranscriptFile(id, opts.cwd, opts.codexSessionId);
  if (opts.preferGrok) {
    const f = grok();
    if (f) return f;
  }
  if (opts.preferCodex) {
    const f = codex();
    if (f) return f;
  }
  let dirs: string[];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { dirs = []; }
  for (const d of dirs) {
    const f = path.join(PROJECTS_DIR, d, `${id}.jsonl`);
    try { if (fs.existsSync(f)) return f; } catch { /* keep scanning */ }
  }
  if (opts.preferGrok || opts.grokSessionId) {
    const f = grok();
    if (f) return f;
  }
  return opts.preferCodex || opts.codexSessionId ? codex() : undefined;
}

/** mtime of a chat's transcript (0 if none) — lets callers skip re-recapping a chat that hasn't changed. */
export function transcriptMtime(id: string, opts: RecapOptions = {}): number {
  const f = transcriptFile(id, opts);
  if (!f) return 0;
  try { return fs.statSync(f).mtimeMs; } catch { return 0; }
}

/** Stream a transcript line-by-line (Grok's first rows are 70–120 KB skill dumps; a byte head/tail never
 *  sees a complete user turn). Skip enormous non-message lines; keep the first ask + recent turns. */
function condense(file: string): string {
  const turns: string[] = [];
  try {
    const fd = fs.openSync(file, 'r');
    try {
      let leftover = '';
      const buf = Buffer.alloc(64 * 1024);
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (n <= 0) break;
        leftover += buf.toString('utf8', 0, n);
        const lines = leftover.split('\n');
        leftover = lines.pop() ?? '';
        for (const ln of lines) takeTurn(ln, turns);
      }
      if (leftover) takeTurn(leftover, turns);
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
  if (turns.length === 0) return '';
  const picked = turns.length <= 16 ? turns : [turns[0], '…', ...turns.slice(-14)];
  return picked.join('\n').slice(0, 7000);
}

function takeTurn(raw: string, turns: string[]): void {
  const t = raw.trim();
  if (t[0] !== '{') return;
  // Skip giant tool dumps unless they carry the actual user prompt (cheap pre-filter).
  if (t.length > 400_000 && !t.includes('<user_query>')) return;
  let r: { type?: string; content?: unknown; message?: { content?: unknown }; payload?: { type?: string; role?: string; content?: unknown } };
  try { r = JSON.parse(t); } catch { return; }
  // Three transcript dialects share this parser: Claude (~/.claude/projects) rows are {type:'user'|'assistant',
  // message:{content}} with 'text' blocks; Codex rollouts (~/.codex/sessions) are {type:'response_item',
  // payload:{type:'message', role, content}} with 'input_text'/'output_text' blocks; Grok chat_history.jsonl
  // is {type:'user'|'assistant', content} with optional <user_query> wrapping.
  let who: 'user' | 'assistant' | undefined;
  let c: unknown;
  if (r.type === 'user' || r.type === 'assistant') {
    who = r.type;
    c = r.message?.content ?? r.content;
  } else if (r.type === 'response_item' && r.payload?.type === 'message' && (r.payload.role === 'user' || r.payload.role === 'assistant')) {
    who = r.payload.role;
    c = r.payload.content;
  } else return;
  let txt = '';
  if (typeof c === 'string') txt = c;
  else if (Array.isArray(c)) {
    txt = c
      .filter((b): b is { type: string; text: string } =>
        !!b && ['text', 'input_text', 'output_text'].includes((b as { type?: string }).type ?? '') && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text)
      .join(' ');
  }
  txt = txt.replace(/\s+/g, ' ').trim();
  const query = txt.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (query) txt = query[1].replace(/\s+/g, ' ').trim();
  if (!txt || txt.startsWith('<') || txt.startsWith('Caveat:')) return;
  turns.push(`${who === 'user' ? 'User' : 'Assistant'}: ${txt.slice(0, 600)}`);
}

const PROMPT =
  'Summarize this terminal AI-coding chat to label its tab. Return ONLY minified JSON, no prose, no code fence: ' +
  '{"title":"3-6 word topic","recap":"1-2 sentences: the goal and the latest state"}.';

/** Grok already writes generated_title + session_summary next to chat_history.jsonl. Use them only when Haiku
 *  cannot produce a recap — they are a title more than a latest-state recap. */
function grokSummaryFallback(file: string | undefined): Recap | null {
  if (!file || recapSourceOf(file) !== 'grok') return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'summary.json'), 'utf8')) as {
      generated_title?: unknown;
      session_summary?: unknown;
      last_turn_summary?: unknown;
    };
    const title = String(raw.generated_title ?? raw.session_summary ?? '').trim().slice(0, 70);
    const recap = String(raw.session_summary || raw.last_turn_summary || '').trim().slice(0, 500);
    return title || recap
      ? { title, recap, source: 'grok', grokSessionId: grokSessionIdFromFile(file) }
      : null;
  } catch {
    return null;
  }
}

const STRIP_ARGS = [
  '-p', '--output-format', 'json',
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--setting-sources', '', '--allowedTools', '',
];

/**
 * Generate {title, recap} for a chat via the stripped Haiku call. Async; resolves null on any failure (no
 * transcript, empty convo, CLI error, unparseable output) — recaps are best-effort and must never throw.
 * `cwd` is the tab's folder — it powers the codex fallback lookup (unpinned codex ids match by cwd, not id).
 */
export function generateRecap(id: string, opts: RecapOptions = {}): Promise<Recap | null> {
  const model = opts?.model ?? 'claude-haiku-4-5';
  return new Promise((resolve) => {
    const file = transcriptFile(id, opts);
    if (!file) { resolve(null); return; }
    const convo = condense(file);
    if (!convo) { resolve(grokSummaryFallback(file)); return; }
    const input = `${PROMPT}\n\nCONVERSATION:\n${convo}`;
    let done = false;
    const finish = (r: Recap | null) => { if (!done) { done = true; resolve(r); } };
    let child: cp.ChildProcess;
    try {
      child = cp.execFile('claude', ['--model', model, ...STRIP_ARGS], { timeout: 90000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) { finish(grokSummaryFallback(file)); return; }
        try {
          const result = String((JSON.parse(stdout) as { result?: unknown }).result ?? '');
          const m = result.match(/\{[\s\S]*\}/); // tolerate a ```json fence or stray prose around the object
          if (!m) { finish(null); return; }
          const obj = JSON.parse(m[0]) as { title?: unknown; recap?: unknown };
          const title = String(obj.title ?? '').trim().slice(0, 70);
          const recap = String(obj.recap ?? '').trim().slice(0, 500);
          const source = recapSourceOf(file);
          finish(title || recap ? {
            title, recap, source,
            codexSessionId: source === 'codex' ? codexSessionId(file) : undefined,
            grokSessionId: source === 'grok' ? grokSessionIdFromFile(file) : undefined,
          } : grokSummaryFallback(file));
        } catch { finish(grokSummaryFallback(file)); }
      });
    } catch { finish(null); return; }
    try { child.stdin?.end(input); } catch { finish(null); }
  });
}
