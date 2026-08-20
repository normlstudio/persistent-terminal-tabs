# Persistent Terminal Tabs

Browser-style tabs for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [Grok](https://grok.x.ai), and [Antigravity](https://antigravity.google/docs/cli/using/) (`agy`) sessions inside VS Code.

Group chats, keep them alive across reloads, drop the ones you are done with, and search them later by an AI recap. Closing a tab is safe: the session detaches instead of dying. Only **Drop** removes it.

## What you get

- **Grouped tabs** in a sidebar panel. Drag to reorder or move between groups.
- **Crash persistence** via tmux on macOS/Linux. Reload reattaches the live process. A reboot cold-resumes from the transcript.
- **Claude, Codex, Grok, and Antigravity.** New Chat / New Codex Chat / New Grok Chat / New Antigravity Chat. Recap and resume work for all four, including a Grok, Codex, or `agy` process typed into an older Claude-labelled tab.
- **✨ Regenerate Name + Recap.** Reads the chat transcript and writes a short title plus a searchable summary. Manual rename is never overwritten.
- **Search recaps** across current tabs and dropped-chat history.
- **Suspend** one chat or every closed chat to free RAM. Click the grey row to resume.

Status dots:

| Dot | Meaning |
|-----|---------|
| 🟢 | Open in this window |
| 🟡 | Running in the background — click to reattach |
| ⚪ | Suspended — click to resume from transcript |

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
2. **+** starts a new chat in `📥 New`. Type `claude`, `codex`, `grok`, or `agy` in the shell — or use **New Codex / Grok / Antigravity Chat**.
3. Drag chats into groups. Click a group to open it as one split tab.
4. Press ✨ on a chat to generate a name and recap.
5. Close a tab to park it (🟡). **Drop** (trash) to remove it. **Suspend** (⏳ / 🌙) to free RAM.

Layout is saved per VS Code workspace under `~/.terminal-tabs/`.

## Settings

See **Persistent Terminal Tabs** in VS Code settings. The important ones:

- `terminalTabs.openOnStartup` / `autoOpenLimit` — how many tabs reopen automatically
- `terminalTabs.closeToDrop` — off by default (close parks; Drop deletes)
- `terminalTabs.useTmux` — live persistence
- `terminalTabs.defaultAgent` — `claude` · `codex` · `grok` · `agy`
- `terminalTabs.autoRecapOnOpen` — refresh the recap when a transcript has grown

## Develop

```bash
npm install
npm run compile
```

Then **Run and Debug → Run Terminal Tabs** (F5) to open an Extension Development Host.

```bash
npx vsce package
```

## License

MIT © Max Tymoshyn
