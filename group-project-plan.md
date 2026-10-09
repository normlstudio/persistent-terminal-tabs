# PTT — group projects

Add group opens VS Code's searchable project picker. Recent projects appear first, with a meaningful name and the full folder path. Typing filters names and paths while PTT discovers folders inside the open workspace. Browse selects a folder outside the workspace; a pencil beside a project changes its saved name.

Choosing a project creates a group named after it. Its plus button and the toolbar's New Chat commands open shells in that folder. The folder is stored on the group, so even an empty group remembers it after reload. Claude, Codex, Grok and Antigravity share this behavior.

Existing groups get a Choose Project Folder action. Changing the group folder affects future chats. Existing conversations retain their own folders so resume remains reliable. A missing group folder must be repaired before a new chat starts.

Implementation steps:

1. Store an explicit group folder and named project history.
2. Add the searchable native picker, bounded asynchronous workspace discovery, folder browsing and name editing.
3. Connect group creation and new-chat launch, including plain terminals without tmux.
4. Test cancellation, search, persistence, missing folders and inheritance; compile and package the installed extension.

Folder discovery skips hidden and generated dependency/build directories, never follows symlink loops, and searches up to eight levels and 8,000 directories per workspace root. Each root has its own budget so a large codebase cannot crowd out Reels in a document workspace. The picker shows up to 200 matches, ranking project names ahead of path-only matches. Additional search roots can be configured in PTT settings. Recent project history is shared across VS Code windows on this machine.

Durable task: `.claude/tasks/items/task-015-add-group-project-picker.md`.

Delivered as PTT 1.3.0 and installed locally. All 27 tests pass. To load it, run **Developer: Reload Window**, then **Add Group → type re → choose Reels → group +**. Use the result's pencil to save another name; use a group's folder button to change its future-chat folder.
