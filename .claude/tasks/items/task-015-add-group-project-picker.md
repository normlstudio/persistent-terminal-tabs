---
id: "TASK-015"
title: "Add named project folders to terminal groups"
status: "done"
queue: "done"
priority: "P1"
rank: 1
goals: ["GOAL-02"]
depends_on: []
milestone: null
plan: null
issue: null
---

## Outcome

Choose a named project once when creating a group; every new chat in it starts in the chosen folder without a manual cd.

## Source

[Max Tymoshyn's original request, October 9, 2026](../captures/2026-10-09-group-project-picker.md). English; explicit planning and execution requested.

## Scope

Public PTT repository: group state, shared named recent project cache, native QuickPick, asynchronous folder discovery, new group and choose-project commands, launch cwd, tests and release docs. Preserve the internal archive and existing conversations.

## Acceptance

- [x] Add Group asks for a searchable named folder; cancel creates nothing.
- [x] Names and full paths are visible, recent selections persist and aliases can be edited.
- [x] Workspace folders are discoverable by typing; browsing and configured extra roots cover other locations.
- [x] An empty group's explicit folder survives serialization/reload; all new-chat commands inherit it.
- [x] Plain and tmux terminals receive the chosen cwd; stale folders do not silently create new chats at home.
- [x] Changing group projects or moving chats preserves existing session cwd and resume identity.
- [x] Compile, meaningful regression tests, package inspection and local install succeed.

## Steps

1. Add persistent group cwd and a filesystem-backed named-project history.
2. Implement native picker with workspace discovery, browse and rename.
3. Connect creation/reassignment and launch inheritance; expose group path.
4. Verify regression cases; package/install public PTT and record evidence.

## Priority reason

Done: implemented and installed Max's current improvement, eliminating repeated manual project navigation.

## Blocker

None. Public checkout is clean; no matching existing issues, PRs or claims. Drive Products/Projects have no matching PTT home; no second task store identified.

## Next action

Max runs Developer: Reload Window to load the installed update, then tries Add Group → type re → choose his Reels folder → group plus. Live visual confirmation is not claimed; automated command/picker tests, actual workspace discovery and installed package parity establish implementation completion.

## Evidence

Audited origin/main `5a7b3dd`, recent authors and all available issues/PRs. Current implementation only infers cwd from existing chats; empty groups launch at home. Plain fallback does not set TerminalOptions.cwd. No workflows, webhooks, rulesets or deployments found; coordination branch reserved by the claim.

Implementation compiled and 27 tests passed using the installed Node 22.22.2. Tests cover picker cancel/rename/browse/typed paths, bounded directory scanning, alias/cache persistence, explicit empty groups, legacy inference, real registered commands for all four agents, split anchoring, default reassignment without changing old chats, duplicate project group names, missing-folder refusal, and the real tmux launch builder's cwd argument. Initial Node 16 test invocation could not run pre-existing t.after fixtures; no test source workaround was added.

Actual Work Root workspace directory scan: 27,040 candidates; the `re` query lists Max's Reels folder at rank 7 and the Norml Studio/Zhenia counterparts at ranks 8/9. Scan reached its documented bounds; Browse remains available. Measurements were directory-only, with no file content reads.

Packaged and installed `maxtymosh.persistent-terminal-tabs@1.3.0` through VS Code's supported CLI. All five changed compiled modules match the installed extension byte for byte. Final VSIX SHA256: `5cdbdfe363457fb499a0bc76fe1e57188b223f359d990ffb3bdedcf60cbaf75a`. Private `.claude` planning is excluded from the package. The running window was not forcibly reloaded.

## Execution claim

Max Tymoshyn; session `codex-ptt-project-picker-20261009`; remote claim `0611a55cdb304fe3a052d3b5f10e2195`, integration branch main. Existing clean public checkout retained; no temporary worktree needed. Literal boundaries are in the shared claim ledger.

Implementation ships in `feat(groups): add searchable named project folders` on origin/main. The remote ledger retains integration/release evidence after the final ownership check and push.

## Decisions and changes

Native QuickPick uses workspace roots and configurable extra roots. Recent names default to the final directory name. Group project changes only future-chat defaults. Old groups retain dominant-cwd inference until explicitly assigned.

## Suggested skills

Provisional: norml-tasks for durable scope/status, norml-git for ownership and release parity, dev-changelog for final change/decision logging.
