# Group project picker request

Author: Max Tymoshyn. Date: October 9, 2026 (America/New_York).
Source: PTT conversation. Original language: English. No message URL exposed.

## Original request

I want to improve PTT. So when I click this “Add group” button, I do want to somehow choose or pick the dropdown from the common folders.

So what's the solution? What's the problem I want to solve?

When I open a new terminal, I need to write `cd` and enter the folder from which folder I’m going to start code or Claude. But I don't want to do that. I want it to be inherited from the group that I'm creating.

I'm creating a group and I want all the chats in this group, when I click plus, to spawn right away in the same folder. As soon as I spawn it from the group (the plus sign), I want it to open right away in the same folder, which is group-defining.

So pretty much I'm picking the project, kind of thing.

How to actually implement that I'm not sure. I do want to see the path in some dropdown, so I can see the last ones that I've picked. Probably for each path I should be able to add a name. It would pretty much be my projects. We can call it basically “projects” or whatever, but it would define which folder I'm going to open.

How to implement that I'm not sure with the capabilities that we have. But please plan this out and let's implement that, so I can just add a group and then it would ask me right away somehow which folder to open.

But I don't want it to ask which exact path every time, because this is going to be annoying. I would love to type and see the suggestions of which path or which project I want to create, which folder would be for this group.

I want named paths. Each path would be named by the last folder or the project, so it's meaningful. As soon as I click it from the dropdown or I start typing, it starts searching through my workspace and searching for this folder. Then I can just click and it's going to open, and then it's going to store this for the future. Later it’s just going to be some cache that I've used over time.

So I can click on the group and then it would show me the dropdown of the previous projects. In the search bar I can start typing and it's going to show me previous projects that I've used.

This kind of idea: plan this out with normal tasks and let's try to execute that. I'm not sure if it's going to be possible in VS Code, but I’m really starting to work with it for everything. I’m opening from the core, and I’m spending time to actually search what the project is. I would really love to pick that really fast out of a dropdown and maybe type a few letters.

For example, if I want “Reels” and then I'm typing “re” and it's popping up there, and I'm just clicking, and then boom — this group has this folder in the common. And every time that I spawn under this group, the chats would be spawned in the same folder.

## Organized meaning

Create project-bound groups through a native searchable picker. Preserve named recent folders and default names from final folder components. Search inside workspace folders; support choosing other folders. Every new chat inherits the explicit group folder without another picker. Preserve existing conversations when changing a group folder.

## Disposition

| Input | Destination |
|---|---|
| Avoid repeated cd; group defines the project folder | GOAL-02 / TASK-015 |
| Add Group asks which project; plus inherits it | TASK-015 creation and launch acceptance |
| Named paths, previous selections, searchable suggestions | TASK-015 native picker and shared recent cache |
| Reels from typing re | TASK-015 actual workspace discovery/ranking verification |
| Click group to choose project | Dedicated inline folder action/context command; ordinary group clicks retain established open/switch behavior |
| Plan and execute | TASK-015 current execution authorized |
