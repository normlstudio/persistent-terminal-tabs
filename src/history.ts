import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * APPEND-ONLY history ledger. Every meaningful lifecycle event (a chat created, closed, dropped, moved,
 * renamed; a group dropped) is appended here and NEVER rewritten or removed. The whole point: nothing can be
 * silently lost again — given a session you can always look up its id, the group it lived in, its folder, and
 * when, then resume it. Written best-effort; history must never block or break a real operation.
 *
 * One JSON object per line at ~/.terminal-tabs/history.jsonl.
 */

const HISTORY_FILE = path.join(os.homedir(), '.terminal-tabs', 'history.jsonl');

export type HistoryEvent =
  | 'snapshot'   // existing session recorded (one-time seed of what was already there)
  | 'add'        // chat created / imported into a group
  | 'close'      // tab closed (debounced drop) — left the saved set
  | 'drop'       // explicitly dropped from the panel
  | 'drop-group' // a whole group was dropped
  | 'move'       // moved to another group
  | 'rename';    // chat or group renamed

export interface HistoryEntry {
  ts: string;          // ISO timestamp
  event: HistoryEvent;
  id: string;          // session id (the thing you resume)
  title: string;       // human title at the time
  group: string;       // the group it was in
  cwd: string;         // the folder it ran in (needed to resume correctly)
  agent: string;       // 'claude' | 'codex' | 'grok'
  recap?: string;      // the chat's last AI recap, frozen at this moment — searchable forever
  note?: string;       // e.g. rename old→new
}

export function historyPath(): string {
  return HISTORY_FILE;
}

/** Append one event. Never throws — history failing must not affect anything else. */
export function recordHistory(e: Omit<HistoryEntry, 'ts'>): void {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.appendFileSync(HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');
  } catch {
    /* best effort */
  }
}

/** Read the full ledger (chronological). For the "Show History" view / recovery. */
export function readHistory(): HistoryEntry[] {
  try {
    return fs
      .readFileSync(HISTORY_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as HistoryEntry);
  } catch {
    return [];
  }
}
