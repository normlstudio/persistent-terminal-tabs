# Persistent Terminal Tabs

Browser-style tabs for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [Grok](https://grok.x.ai), and [Antigravity](https://antigravity.google/docs/cli/using/) (`agy`) sessions inside VS Code.

Group chats, keep them alive across reloads, drop the ones you are done with, and search them later by an AI recap. Closing a tab is safe: the session detaches instead of dying. Only **Drop** removes it.

## What you get

- **Grouped tabs** in a sidebar panel. Drag to reorder or move between groups.
- **Project folders per group.** Add Group opens a searchable picker with named recent projects and workspace folders. New chats inherit the chosen folder, including in an empty group.
- **Crash persistence** via tmux on macOS/Linux. Reload reattaches the live process. A reboot cold-resumes from the transcript.
- **Claude, Codex, Grok, and Antigravity.** New Chat / New Codex Chat / New Grok Chat / New Antigravity Chat. Recap and resume work for all four, including a Grok, Codex, or `agy` process typed into an older Claude-labelled tab.
- **✨ Regenerate Name + Recap.** Reads the chat transcript and writes a short title plus a searchable summary. Tries Claude Haiku first, then Codex (`gpt-5.4-mini`), then Grok if a login expires, a CLI is missing, or a call fails. Uses each CLI’s existing login. Manual rename is never overwritten.
- **Search recaps** across current tabs and dropped-chat history.
- **Suspend** one chat or every closed chat to free RAM. Click the grey row to resume.

Status dots:

| Dot | Meaning |
|-----|---------|
| 🔵 | Codex reports an active turn — streaming, thinking, or running a tool |
| 🟢 | Open — terminal attached |
| 🟡 | Running in the background — click to reattach |
| ⚪ | Suspended — click to resume from transcript |

🔵 follows the foreground Codex process’s live terminal-title indicator, including detached chats. Idle animations, typing, old output, and pending approval do not trigger blue. Other agents keep their attachment colors; their work state is not inferred. Turn blue off with `terminalTabs.showWorkingDot`; tune polling with `terminalTabs.workingPollSeconds` (default 8 seconds). Blue clears on the next poll with no extra hold.

## Requirements

- VS Code 1.85+
- [tmux](https://github.com/tmux/tmux) on macOS/Linux (recommended). Windows runs without tmux (plain terminals, no live reattach).
- The agent CLIs you use (`claude`, `codex`, `grok`, `agy`) on `PATH`

## Install

Marketplace publish is the next step. Until then:

1. Download the latest `.vsix` from [Releases](https://github.com/Norml-Studio/persistent-terminal-tabs/releases).
2. VS Code → Extensions → **…** → **Install from VSIX…**

Or from a terminal:

```bash
code --install-extension persistent-terminal-tabs-1.0.0.vsix
```

Then **Developer: Reload Window**.

## Daily use

1. Open the **Persistent Terminal Tabs** view (Activity Bar, or `Cmd+Alt+T` / `Ctrl+Alt+T`).
2. **Add Group** opens **Choose Project Folder**. Type a few letters (for example, `re` for Reels), choose a named project with its full path, or use **Browse**. The pencil beside a result sets its saved project name. PTT remembers recent choices across windows.
3. **+** starts a new chat in the selected/open group and inherits its folder. The group's inline **+** targets that group directly. With no PTT group in context, it falls back to `📥 New`. Type `claude`, `codex`, `grok`, or `agy` in the shell — or use **New Codex / Grok / Antigravity Chat**.
4. Drag chats into groups. Click a group to open it as one split tab. Use the group's folder action or right-click → **Choose Project Folder** to change the folder for future chats. Hover the group to see its path. Existing chats keep their own folders for resume.
5. Press ✨ on a chat to generate a name and recap.
6. Close a tab to park it (🟡). **Drop** (trash) to remove it. **Suspend** (⏳ / 🌙) to free RAM.

Folder discovery searches open workspace roots asynchronously, skipping hidden, build and dependency folders and symlink directories. Each root has a limit of eight levels and 8,000 directories; up to 200 matching suggestions are shown, with name matches first. Browse can select any accessible folder. If a group's folder moves or becomes unavailable, choose a replacement before creating another chat.

Layout is saved per VS Code workspace under `~/.terminal-tabs/`.

## Settings

See **Persistent Terminal Tabs** in VS Code settings. The important ones:

- `terminalTabs.openOnStartup` / `autoOpenLimit` — how many tabs reopen automatically
- `terminalTabs.closeToDrop` — off by default (close parks; Drop deletes)
- `terminalTabs.useTmux` — live persistence
- `terminalTabs.defaultAgent` — `claude` · `codex` · `grok` · `agy`
- `terminalTabs.projectSearchRoots` — additional absolute folders to discover in the project picker (`~` supported)
- `terminalTabs.autoRecapOnOpen` — refresh the recap when a transcript has grown

## Develop

```bash
npm install
npm run compile
npm test
```

Then **Run and Debug → Run Terminal Tabs** (F5) to open an Extension Development Host.

```bash
npx vsce package
```

## License

MIT © Max Tymoshyn
