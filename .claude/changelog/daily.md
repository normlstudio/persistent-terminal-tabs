# Daily changelog — Persistent Terminal Tabs

## Oct 9, 2026 — group project folders

- Added a searchable native project picker to Add Group, including named recent folders, full paths, browse, typed paths and project aliases.
- Added Choose Project Folder on group rows; new-chat commands inherit the explicit group cwd even when the group is empty. Fixed plain terminals to receive their session cwd.
- Added bounded asynchronous workspace-folder discovery with separate budgets per root and name-ranked suggestions. Actual Work Root search uncovered competition from broad runtime trees and hundreds of reference folders; independent budgets and shorter-name ranking keep Reels discoverable.
- Preserved existing chat folders and resume identities when assigning group defaults or moving chats. Missing explicit folders block a new chat until repaired.
- `[DECISION]` Group projects define future-chat defaults, while session cwd remains conversation-specific recovery data; recent project aliases are shared across windows in a separate local cache.
- Recorded TASK-015 and GOAL-02 in the established repository planning store; retained historical tasks and did not migrate the store.
- Compiled, passed all 27 tests on Node 22.22.2, packaged and installed public PTT 1.3.0, and verified the installed changed JavaScript matches the tested build byte for byte. Actual `re` search finds the three Reels folders at ranks 7–9. Live visual confirmation awaits Max's deliberate window reload.
