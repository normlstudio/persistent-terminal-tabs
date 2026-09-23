# Goals — Persistent Terminal Tabs

> Long-term outcomes for this repo. Short-term work lives in `tasks.md`.

- [ ] [GOAL-01] Each tab's dot tells the truth about that session at a glance —
      not just process state (attached / detached / suspended) but **liveness**:
      a distinct **🔵 working** state while the agent is actively producing
      output, flipping to blue within ~one poll and back to 🟢/🟡 once it goes
      idle. Works for attached and detached (background) sessions alike; a
      suspended tab (no process) is never blue.
