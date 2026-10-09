# Tasks — Persistent Terminal Tabs

> Format: `- [ ] [P0|P1|P2|P3] [TASK-NNN] Action — why / relevant path (GOAL-NN)`.

## Current mechanism — 1.2.3

Blue follows the foreground Codex process's native OSC busy-title indicator.
Terminal animation, typing, old transcript text and generic output changes are
not work signals. Blue clears on the next poll (default 8 seconds), without a
hold. Green means attached, yellow detached, and grey suspended. Other agents
retain attachment colors until a reliable work signal is implemented.

Name/recap lookup reads modern Codex paginated history through read-only local
app-server methods. Exact unique conversation names match full terminal titles,
including busy and approval decorations; known thread IDs remain persistent.

## Historical mechanism — superseded by 1.2.3

The former screen-change/busy-text heuristic below produced false positives and
is retained only as implementation history. It is not the current specification.

## Mechanism (decided — REVISED after live testing)

**First attempt (tmux `#{session_activity}`) was wrong** and is abandoned.
Measured on Max's real sessions: the activity clock sat **100–180 s stale**
while a Claude/Codex TUI was visibly working — modern agent TUIs batch their
redraws, so tmux's activity clock barely moves. Also found: the v1 build was
**never installed** (a window reload reloads the *old* packaged build). Both
fixed: bumped to **1.2.0** + a real install.

**Shipped mechanism — read the VISIBLE PANE per poll, two signals:**

1. **Busy marker** — `capturePane(id)` (tmux `capture-pane -p`, visible screen,
   works detached) then a `BUSY_MARKER` regex: `esc to interrupt`, its truncated
   `(2m 46s ·` elapsed-timer head, or `working…interrupt`. Every agent
   (Claude / Codex / Grok) shows this while a turn runs. Instant — no baseline
   poll needed. Live test: cleanly split 7 working / 24 live on Max's box.
2. **Pane changed** — whitespace-normalised, non-blank pane text differs from
   the last poll. Backstop for a narrow pane that truncated the marker away, or
   a plain build streaming in a shell. The non-blank guard kills the
   blank-pane-line-count false positive seen in testing.

Either fires → stamp `lastBusyMs[id]`; the dot then **holds blue for
`workingHoldSeconds`** (default 20) to bridge quiet gaps (long silent tool call,
between-turns pause) so it doesn't flap.

Cost: one small `capture-pane` per **live tmux session** (~24, not 100+ tabs)
per `workingPollSeconds`. Hooks still rejected for v1 (Claude-only, global
config mutation, no Codex/Grok coverage) — `TASK-007`.

Soft edges (acceptable — self-correct within `workingHoldSeconds`): a pane
literally showing the text "esc to interrupt" (catting a file, this note); a
shell with a live-clock prompt; the user mid-typing a long prompt.

**Config (`terminalTabs.*`):**
- `showWorkingDot` (bool, default true) — master switch; off ⇒ nothing is blue.
- `workingPollSeconds` (default 8, clamp 3–60) — poll cadence; also now drives
  the dot timer (was a hardcoded 15 s), so 🟡/⚪ transitions got snappier too.
- `workingHoldSeconds` (default 20, clamp 5–300) — blue linger after the pane
  last read busy.

**Dot precedence:** working → 🔵 `charts.blue` filled · else open → 🟢 · else
detached → 🟡 · else ⚪ outline.

## Now

No active execution work. Group projects shipped as 1.3.0; see TASK-015 under Done. The running window needs Developer: Reload Window to load the installed version.

This established legacy planning store has no v3 config or enabled GitHub issue mirror. Continue it in place; do not bulk-migrate historical records as part of this feature.

## Done — this round

- [x] [P1] [TASK-012] Refresh the dots on interaction, not just every
      `workingPollSeconds` — `pokeDots()` (deferred `refreshAlive()` + render)
      called from `openTab` (covers the already-open early-return), `openGroup`,
      and the Refresh command. `pokePending` flag coalesces rapid clicks.
      `src/extension.ts`. Note: an on-click refresh still respects
      `workingHoldSeconds` — a tab that finished < 20s ago stays 🔵 by design;
      lower `workingHoldSeconds` if that tail bothers Max.

## Someday — optional, outside the completed repair

- [ ] [P3] [TASK-007] Precision upgrade — optional Claude `Stop` /
      `UserPromptSubmit` hook writing `~/.terminal-tabs/activity/<id>` so the
      blue state is exact for Claude (no screen-based fallback; Codex already uses its native work indicator) — needs a `~/.claude/settings.json` opt-in
- [ ] [P3] [TASK-008] Distinguish 🔵 working from a "⏸ needs you" state
      (permission prompt / plan approval) — currently a blocked prompt falls
      back to 🟢/🟡 once the prompt paints and the marker clears
- [ ] [P3] [TASK-010] Verify a native Antigravity work-state signal before
      enabling blue for agy. Screen changes and busy-text guesses are retired.

## Blocked

## Done

- [x] [P1] [TASK-015] [Add named project folders to terminal groups](items/task-015-add-group-project-picker.md) — searchable folder picker, remembered names and explicit folder inheritance (GOAL-02). 27 tests passed; actual workspace `re` search finds Reels; installed 1.3.0 matches tested output. Live UI confirmation remains for Max after reload.

- [x] [P1] [TASK-001] Working-set tracking — `paneHash` + `lastBusyMs` maps,
      `workingCfg()` / `refreshWorking()` / `workingIds()` / `isWorkingCached()`;
      folded into the dot-timer poll; `refreshAlive()` returns a change when only
      the working set moved. `src/extension.ts`
- [x] [P1] [TASK-002] Blue dot — `isWorking` 5th ctor param on `TabsTree`, top
      precedence in `getTreeItem` (`circle-filled` + `charts.blue`), four-state
      tooltip line; wired `isWorkingCached` at the `new TabsTree(...)` call.
      `src/tree.ts`, `src/extension.ts`
- [x] [P1] [TASK-002b] Detection rewrite after live testing — `capturePane()` in
      `src/tmux.ts`; `BUSY_MARKER` + normalised pane-diff in `refreshWorking()`.
      tmux `session_activity` dropped from the calc (still used by
      `autoSuspendSweep`, untouched).
- [x] [P1] [TASK-003] Config — `showWorkingDot` (true), `workingPollSeconds`
      (8, 3–60), `workingHoldSeconds` (20, 5–300); `dotTimer` interval driven by
      `workingPollSeconds`. `package.json`, `src/extension.ts`
- [x] [P1] [TASK-004] `diagDots()` logs `working=`; Diagnose Dots toast +
      status-bar tooltip show the 🔵 tally. `src/extension.ts`
- [x] [P2] [TASK-005] Docs — README dot legend gains 🔵; CHANGELOG `## 1.2.0`
      entry; `.claude/**` added to `.vscodeignore`; `package.json` version
      1.1.3 → **1.2.0** (so VS Code actually reloads it).
- [x] [P1] [TASK-006] `npm run compile` clean · `npm test` 8/8 · `vsce package`
      → `persistent-terminal-tabs-1.2.0.vsix` (16 files) · unpacked into
      `~/.vscode/extensions/maxtymosh.persistent-terminal-tabs-1.2.0/` and
      verified the new symbols are in `out/extension.js`. `git status`: only my
      files touched; `src/recaps.ts` left as the other session's WIP; nothing
      staged, nothing committed.
- [x] [P1] [TASK-011] Live-validated the shipped mechanism against Max's real
      tmux socket: instant detection, 7/24 sessions flagged working, stable
      across 5 polls, this Claude session correctly among them.

### Historical verification — superseded by the 1.2.3 closeout

**Done:** compiles, tests 8/8, dot precedence + predicates read correctly,
`showWorkingDot:false` ⇒ `workingIds()` empty. Mechanism live-tested against the
real socket (TASK-011): the `BUSY_MARKER` + pane-diff logic, exactly as compiled
into `out/`, cleanly separated working from idle sessions and updated on the
first poll.

**Historical checklist (not pending for 1.2.3):**
1. **Reload Window** (Cmd+Shift+P → Developer: Reload Window). Full Cmd+Q +
   reopen if the dots don't change behaviour.
2. A tab with an agent mid-reply shows 🔵 within ≤ `workingPollSeconds` (8s);
   ~20s (`workingHoldSeconds`) after it finishes it returns to 🟢.
3. Close (detach) a mid-reply tab → its row still shows 🔵 (background work).
4. A ⚪ suspended tab never turns 🔵.
5. **Persistent Terminal Tabs: Diagnose Dots** → toast reports a 🔵 count and
   `~/.terminal-tabs/diag.log` has a `working=N` field.

---
*Never silently delete open work. Check it off, defer it with a reason, archive
it, or promote it to a linked project-lane plan.*

## Closeout — September 29, 2026

Source: [Max's closeout request](captures/2026-09-29-ptt-closeout.md).

- [x] [P1] [TASK-009] Updated extension loaded after reload; activation logged
  September 30 at 01:20 UTC (September 29 in New York). Max confirmed it seems working.
- [x] [P1] [TASK-013] Replace false-blue screen heuristics with native Codex
  work-state titles and remove the hold. Installed 1.2.3 matches the compiled
  JavaScript byte for byte; 16 tests pass. Commit `5d18cd6` is on origin/main.
- [x] [P1] [TASK-014] Restore modern Codex name/recap lookup, including busy
  and approval title decoration. Exact affected conversation read successfully;
  a real generation produced “Iryna — Shuttle Setup”. Conversation binding is
  saved. Live extension has also successfully saved other regenerated recaps.
  The affected tab still has its default “chat 12” title and no stored recap;
  its on-demand ✨ action can populate those. UI automation could not reliably
  target that action while the window was being used, so no live-state JSON
  was edited behind the running extension. This is a remaining optional
  per-tab generation, not an unresolved history lookup or release defect.

All 45 tmux sessions present before the install survived. No temporary worktree
was created. Optional TASK-007/008/010 remain deferred; they are not blockers
for closing this repair chat. The screen heuristic must not be reintroduced.
