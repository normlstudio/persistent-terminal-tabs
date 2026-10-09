import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ProjectFolder {
  name: string;
  cwd: string;
  usedAt?: number;
}

export function normalizeFolder(folder: string): string {
  if (folder === '~') folder = os.homedir();
  else if (folder.startsWith(`~${path.sep}`)) folder = path.join(os.homedir(), folder.slice(2));
  return path.normalize(folder);
}

export function folderProject(folder: string): ProjectFolder {
  const cwd = normalizeFolder(folder);
  return { name: path.basename(cwd) || cwd, cwd };
}

export async function isDirectory(folder: string): Promise<boolean> {
  try { return (await fs.promises.stat(folder)).isDirectory(); } catch { return false; }
}

/** Shared across windows; re-read before each write so another window's recent choices are preserved. */
export class ProjectStore {
  constructor(readonly file = path.join(os.homedir(), '.terminal-tabs', 'projects.json')) {}

  recent(): ProjectFolder[] {
    try {
      const data: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(data)) return [];
      return data.filter((p): p is ProjectFolder => p && typeof p.name === 'string' &&
        p.name.trim() && typeof p.cwd === 'string' && path.isAbsolute(p.cwd))
        .map((p) => ({ name: p.name, cwd: normalizeFolder(p.cwd), usedAt: Number(p.usedAt) || 0 }))
        .sort((a, b) => (b.usedAt ?? 0) - (a.usedAt ?? 0));
    } catch { return []; }
  }

  remember(project: ProjectFolder): ProjectFolder {
    const saved = { ...project, name: project.name.trim() || folderProject(project.cwd).name,
      cwd: normalizeFolder(project.cwd), usedAt: Date.now() };
    const items = [saved, ...this.recent().filter((p) => p.cwd !== saved.cwd)].slice(0, 100);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(items, null, 2) + '\n', 'utf8');
    fs.renameSync(temp, this.file);
    return saved;
  }
}

/** Saved aliases win over workspace/session-derived names, and equal paths appear only once. */
export function mergeProjects(...lists: readonly ProjectFolder[][]): ProjectFolder[] {
  const found = new Map<string, ProjectFolder>();
  for (const list of lists) for (const p of list) {
    if (!path.isAbsolute(p.cwd)) continue;
    const cwd = normalizeFolder(p.cwd);
    if (!found.has(cwd)) found.set(cwd, { ...p, cwd });
  }
  return [...found.values()];
}

/** Rank name matches before full-path matches; bound visible results while searching the whole index. */
export function searchProjects(projects: ProjectFolder[], query: string, limit = 200): ProjectFolder[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return projects.slice(0, limit);
  const fuzzy = (text: string, word: string): boolean => {
    let i = 0;
    for (const c of text) if (c === word[i]) i++;
    return i === word.length;
  };
  return projects.map((project, index) => {
    const name = project.name.toLowerCase(), cwd = project.cwd.toLowerCase();
    const scores = words.map((word) => name === word ? -1 : name.startsWith(word) ? 0 : name.includes(word) ? 1 :
      fuzzy(name, word) ? 2 : fuzzy(cwd, word) ? 3 : Infinity);
    return { project, index, score: Math.max(...scores) };
  }).filter((p) => Number.isFinite(p.score)).sort((a, b) => a.score - b.score ||
    (b.project.usedAt ?? 0) - (a.project.usedAt ?? 0) || a.project.name.length - b.project.name.length || a.index - b.index)
    .slice(0, limit).map((p) => p.project);
}

const SKIP = new Set(['node_modules', 'vendor', 'out', 'dist', 'build', 'coverage', '__pycache__',
  'venv', 'env', 'target', 'Pods', 'DerivedData']);

export interface FolderScanOptions {
  canceled?: () => boolean;
  onBatch?: (projects: ProjectFolder[]) => void;
  maxDirectories?: number;
  maxDepth?: number;
}

/** Directory names only: no file content reads, no symlink traversal, no synchronous recursive walk. */
export async function discoverProjectFolders(roots: string[], options: FolderScanOptions = {}): Promise<{ truncated: boolean }> {
  const limit = options.maxDirectories ?? 8000;
  const depthLimit = options.maxDepth ?? 8;
  // Each workspace root has its own budget: a huge code/runtime root must not starve a document root.
  const queue = [...new Set(roots.map(normalizeFolder).filter(path.isAbsolute))]
    .map((cwd) => ({ cwd, depth: 0, budget: { count: 1 } }));
  const seen = new Set(queue.map((p) => p.cwd));
  let batch: ProjectFolder[] = [];
  let truncated = false;
  for (let i = 0; i < queue.length; i++) {
    if (options.canceled?.()) break;
    const { cwd, depth, budget } = queue[i];
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(cwd, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      if (depth >= depthLimit) { truncated = true; continue; }
      const child = path.join(cwd, entry.name);
      if (seen.has(child)) continue;
      if (budget.count >= limit) { truncated = true; continue; }
      budget.count++;
      seen.add(child);
      batch.push(folderProject(child));
      queue.push({ cwd: child, depth: depth + 1, budget });
    }
    if (batch.length >= 100 || i === queue.length - 1) {
      options.onBatch?.(batch);
      batch = [];
    }
  }
  if (batch.length && !options.canceled?.()) options.onBatch?.(batch);
  return { truncated };
}
