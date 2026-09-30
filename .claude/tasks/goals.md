# Goals — Persistent Terminal Tabs

> Long-term outcomes for this repo. Short-term work lives in `tasks.md`.

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
