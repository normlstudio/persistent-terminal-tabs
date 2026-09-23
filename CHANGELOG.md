# Changelog

## 1.2.0

- New 🔵 **working** dot: a chat shows blue while its agent is actively producing output — streaming a reply, thinking, or running a tool — as distinct from 🟢 attached-but-idle and 🟡 detached. Detected by diffing the chat's visible terminal between polls (the on-screen "esc to interrupt" line changes every 1-2s while busy; tmux's own activity clock, it turns out, sits stale for minutes while a modern agent TUI works). Lights up for background (detached) chats too, and works for Claude, Codex, Grok, and Antigravity alike; a ⚪ suspended tab is never blue.
- Dot polling is now `terminalTabs.workingPollSeconds` (default 8s, was a fixed 15s), so 🟡/⚪ transitions are more responsive too. New knobs: `terminalTabs.showWorkingDot` (off = old three-state dot), `terminalTabs.workingHoldSeconds` (blue linger across quiet gaps, default 20s).
- **Diagnose Dots** and the status-bar tooltip now report the 🔵 working count.

## 1.1.3

- Name + recap generation falls back from Claude Haiku to Codex, then Grok, using existing CLI logins
- Bounded, restricted background calls and sanitized provider failure messages replace silent authentication failures
- Keeps the original transcript identity and manually set names when another CLI generates the recap

## 1.1.2

- Regenerate Name + Recap now produces entity-first titles (lead, client, company, project, site, or repo) and concrete latest-state recaps instead of generic workflow labels
- Removed the Show Group as Grid / Collapse Grid feature; groups now stay in the terminal panel split view
- New Chat (including Codex, Grok, and Antigravity variants) now joins the selected/open group and inherits its folder; with no group context it still falls back to `📥 New`
- Detects the conflicting internal `norml.persistent-terminal-tabs` build before registering any views or listeners, preventing split ownership that left open chats yellow

## 1.1.1

- Panel row description (and native tab prefix) shows the agent — Claude, Codex, Grok, Gemini — instead of the folder name

## 1.1.0

- Antigravity CLI (`agy`) recap, rename, resume, and **New Antigravity Chat**
- Live-binds `agy` typed into an older Claude-labelled tab to `~/.gemini/antigravity-cli/brain/<id>/` transcripts

## 1.0.0

First public release.

- Browser-style grouped tabs for Claude Code, Codex, and Grok terminal sessions
- Crash-persistent tmux sessions (macOS / Linux): close detaches, reload reattaches, Drop kills
- AI recap + naming (✨) from Claude, Codex, and Grok transcripts
- Search recaps across current tabs and dropped-chat history
- New Chat / New Codex Chat / New Grok Chat
- Suspend a tab or all closed tabs to free RAM; click to resume from transcript
- Per-workspace saved layout (groups, order, titles)
