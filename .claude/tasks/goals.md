# Goals — Persistent Terminal Tabs

> Long-term outcomes for this repo. Short-term work lives in `tasks.md`.

## Current focus — group projects

- [x] [GOAL-02] Select a named project once per group; all new chats open in its folder without manual cd. Source: [Max's October 9 request](captures/2026-10-09-group-project-picker.md). Success: searchable recent/workspace folders, explicit empty-group persistence and inherited launch cwd. Supporting task: [TASK-015](items/task-015-add-group-project-picker.md). Status: achieved through implementation and automated acceptance; 1.3.0 installed, live UI confirmation pending Max's window reload.

- [ ] [GOAL-01] Each tab's dot tells the truth about that session at a glance —
      not just process state (attached / detached / suspended) but **liveness**:
      a distinct **🔵 working** state while the agent is actively producing
      output, flipping to blue within ~one poll and back to 🟢/🟡 once it goes
      idle. Works for attached and detached (background) sessions alike; a
      suspended tab (no process) is never blue.

## September 29, 2026 — repair accepted

The Codex name/recap and false-blue repair is complete in installed 1.2.3;
see TASK-009/013/014 in [tasks.md](tasks.md). Max confirmed the live behavior.
GOAL-01 remains open only for the optional broader-agent work-state coverage;
Claude/Grok/Antigravity currently expose attachment state without guessed blue.
There is no remaining execution obligation for this repair conversation.
