# Changelog

## 1.1.3

- Name + recap generation falls back from Claude Haiku to Codex, then Grok, using existing CLI logins
- Bounded, restricted background calls and sanitized provider failure messages replace silent authentication failures
- Keeps the original transcript identity and manually set names when another CLI generates the recap

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
