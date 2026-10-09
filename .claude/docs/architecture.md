# Persistent Terminal Tabs — architecture decisions

> Updated: Oct 9, 2026

## Group projects

- `[DECISION]` The existing panel remains the single arrangement source of truth. Clicking a group still opens its native split tab. Add Group and the dedicated Choose Project Folder action use a native VS Code QuickPick.
- `[DECISION]` `Group.cwd` is the explicit new-chat default and `Group.projectName` stores the chosen project's display name. Empty groups retain both. Explicitly assigned groups do not auto-rename from their chats. Legacy groups still infer a dominant cwd (newest wins ties); the unbound inbox defaults to home.
- Existing `SessionMeta.cwd` remains authoritative for conversation recovery. Changing a group's project or moving a chat does not rewrite existing session metadata or issue cd to a running process.
- New-chat commands validate an explicit group folder before adding state or creating a terminal. Missing folders require repair; no silent fallback to home. `TerminalOptions.cwd` and tmux's `new-session -c` receive the resolved session folder.
- Named recent projects are stored locally in `~/.terminal-tabs/projects.json`, separately from workspace slices. Default names use the final folder component; picker pencil edits aliases. Read-before-write plus atomic replace preserve sequential choices across windows. At most 100 recent folders are retained.
- Directory discovery uses asynchronous filesystem directory listings of local workspace roots and `terminalTabs.projectSearchRoots`. It reads no file contents, skips hidden/generated directories and symlink directories, and stops at eight levels and 8,000 directories per root. Each root has a separate budget so large runtime trees cannot starve document roots.
- Search ranks exact/prefix/substring/fuzzy project-name matches before path-only matches, with recent and short names prioritized within matching tiers. Only 200 suggestions render; Browse and typed absolute paths remain available. Discovery repaints are throttled and canceled when the picker closes.

## Planning

[Repository tasks](../tasks/tasks.md) retain their established legacy format. New concrete work uses individual task records alongside the existing index. No v3 migration or GitHub issue sync is configured for this repository; historical tasks remain intact.
