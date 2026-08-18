import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';

export interface DiscoveredSession {
  id: string;
  /** Project directory name under ~/.claude/projects (the cwd, slug-encoded). */
  project: string;
  /** Working directory, read from the transcript (best-effort). */
  cwd: string;
  title: string;
  mtimeMs: number;
}

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One bounded read at an offset. */
function readAt(file: string, offset: number, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, offset);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** First chunk of a (possibly huge) transcript — the FAST path; title + cwd usually live near the top,
 * but not always (see scanRows), so a miss here must escalate, never conclude. */
function readHead(file: string, bytes = 65536): string {
  return readAt(file, 0, bytes);
}

// A transcript's first cwd/title-bearing row can sit MEGABYTES in: fat file-history-snapshot rows at the
// head pushed one session's first `"cwd"` to byte ~544k, so any fixed-size head read silently misses it —
// the tab then adopts a garbage fallback cwd and `claude --resume` fails from the wrong folder.
const SCAN_CAP = 8 * 1024 * 1024;
const SCAN_CHUNK = 256 * 1024;

/** Parse one JSONL line and apply `visit`; undefined for blank / non-JSON / truncated lines. */
function visitLine<T>(line: string, visit: (row: Record<string, unknown>) => T | undefined): T | undefined {
  const t = line.trim();
  if (!t || t[0] !== '{') return undefined;
  try {
    return visit(JSON.parse(t));
  } catch {
    return undefined;
  }
}

/** Stream complete JSONL rows to `visit` in bounded chunks until it returns a value or `cap` bytes read. */
function scanRows<T>(
  file: string,
  visit: (row: Record<string, unknown>) => T | undefined,
  cap = SCAN_CAP
): T | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(SCAN_CHUNK);
    const decoder = new StringDecoder('utf8'); // keeps codepoints split across chunk edges intact
    let carry = '';
    let pos = 0;
    while (pos < cap) {
      const n = fs.readSync(fd, buf, 0, SCAN_CHUNK, pos);
      if (n <= 0) break;
      pos += n;
      carry += decoder.write(buf.subarray(0, n));
      const lines = carry.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        const hit = visitLine(line, visit);
        if (hit !== undefined) return hit;
      }
    }
    return visitLine(carry + decoder.end(), visit); // EOF can leave a final unterminated row
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function parseLines(head: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of head.split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // truncated final line from the head read — ignore
    }
  }
  return out;
}

function rowCwd(r: Record<string, unknown>): string | undefined {
  return typeof r.cwd === 'string' && r.cwd ? r.cwd : undefined;
}

function extractCwd(rows: Array<Record<string, unknown>>): string | undefined {
  for (const r of rows) {
    const c = rowCwd(r);
    if (c) return c;
  }
  return undefined;
}

/** Last cwd in the file's tail — message rows carry cwd all the way down, so the tail can answer
 * even when the whole scannable head is snapshot rows. One bounded read. */
function tailCwd(file: string): string | undefined {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return undefined;
  }
  const start = Math.max(0, size - SCAN_CHUNK);
  const lines = readAt(file, start, SCAN_CHUNK).split('\n');
  if (start > 0) lines.shift(); // first line starts mid-row
  for (let i = lines.length - 1; i >= 0; i--) {
    const c = visitLine(lines[i], rowCwd);
    if (c) return c;
  }
  return undefined;
}

/** cwd from anywhere in the transcript: streamed head scan first, tail as the backstop. Bounded IO. */
function fileCwd(file: string): string | undefined {
  return scanRows(file, rowCwd) ?? tailCwd(file);
}

/** Title candidate from one row: the first genuine human message (mirrors Claude's own resume titles). */
function rowTitle(r: Record<string, unknown>): string | undefined {
  if (r.type !== 'user' || r.isMeta) return undefined;
  const message = r.message as { content?: unknown } | undefined;
  const content = message?.content;
  let text: string | undefined;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const block = content.find(
      (b): b is { type: string; text: string } =>
        !!b && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string'
    );
    if (block) text = block.text;
    // arrays that are purely tool_result have no text block -> skip
  }
  if (!text) return undefined;
  text = text.trim();
  // skip injected system reminders, command wrappers, and tool noise
  if (!text || text.startsWith('<') || text.startsWith('Caveat:')) return undefined;
  return text.replace(/\s+/g, ' ').slice(0, 80);
}

function extractTitle(rows: Array<Record<string, unknown>>): string | undefined {
  for (const r of rows) {
    const t = rowTitle(r);
    if (t) return t;
  }
  return undefined;
}

/** Lossy decode of a project dir name back to a path — display fallback only. */
export function decodeProjectDir(name: string): string {
  return name.replace(/^-/, '/').replace(/-/g, '/');
}

/**
 * Friendly folder label from a cwd, for auto-naming a tab `{folder} · {title}`.
 * Mirrors the old cockpit's friendly_project(): the child under a known anchor
 * (Projects/Services/Products), else `Drive-root/child`, else the folder name.
 */
export function friendlyProject(cwd: string): string {
  if (!cwd) return '~';
  const parts = cwd.split('/').filter(Boolean);
  for (const anchor of ['Projects', 'Services', 'Products', 'Coordination']) {
    const i = parts.indexOf(anchor);
    if (i >= 0 && parts[i + 1]) return parts[i + 1];
  }
  for (const top of ['Norml Drive', 'Google Drive', 'My Drive', 'Local Sites']) {
    const i = parts.indexOf(top);
    if (i >= 0) return top + (parts[i + 1] ? '/' + parts[i + 1] : '');
  }
  return parts[parts.length - 1] || cwd;
}

function deriveSession(projectDir: string, file: string): DiscoveredSession | null {
  const id = path.basename(file, '.jsonl');
  if (!UUID_RE.test(id)) return null;
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const rows = parseLines(readHead(file));
  // Head window first (cheap), deep scan only on a miss; decodeProjectDir is lossy (real dashes/@/dots
  // all collapse to '-') and produces a non-path on Drive-mounted folders — it must stay the LAST resort.
  return {
    id,
    project: projectDir,
    cwd: extractCwd(rows) ?? fileCwd(file) ?? decodeProjectDir(projectDir),
    title: extractTitle(rows) ?? scanRows(file, rowTitle) ?? '(untitled)',
    mtimeMs,
  };
}

/** Scan every ~/.claude/projects/<project>/<id>.jsonl and derive session metadata. */
export function discoverSessions(): DiscoveredSession[] {
  let projects: string[] = [];
  try {
    projects = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return [];
  }
  const out: DiscoveredSession[] = [];
  for (const project of projects) {
    const dir = path.join(PROJECTS_DIR, project);
    let files: string[] = [];
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const s = deriveSession(project, path.join(dir, f));
      if (s) out.push(s);
    }
  }
  return out;
}

/** Look up one session by id across all projects (for "Add Existing Session…"). */
export function findSession(id: string): DiscoveredSession | undefined {
  return discoverSessions().find((s) => s.id === id);
}

/**
 * The cwd a session ACTUALLY ran in, read from its own transcript — the ground truth for `claude --resume`,
 * which only finds a session from its original folder. The cwd we cached in the slice goes STALE when the
 * user moves folders; resuming from a stale cwd fails ("No conversation found") and the tab drops to a shell.
 * Locates `<id>.jsonl` across project dirs, then reads cwd via the streamed scan + tail backstop —
 * NOT a fixed head window, which misses fat-headed transcripts and silently un-heals the tab.
 */
export function transcriptCwd(id: string): string | undefined {
  let dirs: string[];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return undefined; }
  for (const proj of dirs) {
    const f = path.join(PROJECTS_DIR, proj, `${id}.jsonl`);
    try { if (fs.existsSync(f)) return fileCwd(f); } catch { /* keep scanning */ }
  }
  return undefined;
}

/**
 * Batch form of transcriptCwd: resolve many sessions' real cwds in ONE walk of the projects dir, reading the
 * head of ONLY the wanted ids' transcripts. Used by the startup reconcile so UNopened tabs show their true
 * folder (not the stale cwd cached at import) — without the per-id readdir storm of calling transcriptCwd in a loop.
 */
export function transcriptCwds(ids: string[]): Map<string, string> {
  const want = new Set(ids);
  const out = new Map<string, string>();
  if (want.size === 0) return out;
  let projects: string[];
  try { projects = fs.readdirSync(PROJECTS_DIR); } catch { return out; }
  for (const proj of projects) {
    const dir = path.join(PROJECTS_DIR, proj);
    let files: string[];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      if (!want.has(id) || out.has(id)) continue;
      try {
        const cwd = fileCwd(path.join(dir, f));
        if (cwd) out.set(id, cwd);
      } catch { /* skip a transcript we can't read */ }
    }
  }
  return out;
}
