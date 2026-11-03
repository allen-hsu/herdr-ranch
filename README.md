# Herdr Space Folders

![Herdr Space Folders: group your spaces in folders](social.png)

Folders for the spaces list of the [Herdr](https://herdr.dev) desktop app. Drag spaces into colored folders, fold the ones you're not working on, start new spaces right inside a folder, and let folders collect the spaces of a project by themselves.

![Space folders in the sidebar](preview.png)

- **Folders in the sidebar.** A folder has a colored tile like a space's avatar, a count, and folds away. A folded folder still shows when an agent in it is done or needs you.
- **Drag and drop.** Drop a space on a folder to file it, on a space to put it there and in that space's folder, or below the list to take it out. Drag folders to put them in order.
- **New spaces in a folder.** A folder's **+** (or **New space here**) opens a space in the folder's start folder, already in the folder.
- **Smart folders.** A folder collects the spaces working in folders that match its rules: `wbso-ai` (a folder name anywhere), `~/code/client-*` (a path, `*` for one folder name). When several folders match, the most specific rule wins: with `~/projects` on one folder and `~/projects/client` on another, spaces in `~/projects/client` go to the second. What you drag yourself goes first.
- **Machines in a folder.** A folder on this computer can take in another machine as well, with its header and its spaces: a rule that matches the machine's name (`vm-*`) or the folder one of its spaces works in puts it there, so throwaway VMs for a project land in that project's folder by themselves.
- **Keys that follow the list.** Option up and down (and Herdr's other next/previous space keys) go to the space above or below in the list as it shows, folders and all, past folded folders.
- **The same everywhere.** Folders are saved in the home of the machine the spaces run on (`~/.config/herdr-space-folders.json`), so every screen that connects to that machine shows the same folders.
- **Everything the spaces list already does.** It's Herdr's own spaces mod with folders added: worktrees under their repo, branch and ahead/behind, a group per machine, colors, the right-click menu.

![Editing a folder](edit.png)

Right-click a folder to color it, open a new space in it, edit it or delete it. **Edit folder…** sets its name, the folder new spaces start in (**Choose…** opens the system's folder picker) and the rules it collects spaces with.

## Install

Clone this repository and link the mod into Herdr's home:

```sh
git clone https://github.com/jankeesvw/herdr-space-folders.git ~/Documents/github.com/jankeesvw/herdr-space-folders
ln -s ~/Documents/github.com/jankeesvw/herdr-space-folders/mods/space-folders ~/.config/herdr-app/mods/space-folders
cp ~/Documents/github.com/jankeesvw/herdr-space-folders/layouts/main-folders.json ~/.config/herdr-app/layouts/
herdr-app do layout.switch --name main-folders
```

`main-folders` is Herdr's own `main` layout (0.1.10) with the spaces list swapped for this one. `ctrl-shift-l` switches back to any other layout.

Then add the `layout:main-folders` section of this repository's `keys.json` to `~/.config/herdr-app/keys.json`. Without it, `alt-up` and `alt-down` stay Herdr's own `space.prev` and `space.next`, which go by the order Herdr keeps the spaces in, not the order of the folders.

Herdr doesn't notice changes inside a symlinked mod folder, so after a `git pull` restart Herdr (or make the link again) to load the new version.

### Your own layout

In a layout of your own, point the spaces block at this mod:

```json
{ "id": "spaces", "type": "block", "size": { "weight": 1 }, "min": 90, "content": { "mod": "space-folders" } }
```

and give `keys.json` the same keys in a section named after that layout, `layout:<name>`.

## How folders are kept

Each machine's folders live in `~/.config/herdr-space-folders.json` in that machine's home: the folders in order (name, color, start folder, rules, folded) and which space went in which folder, by the id that machine knows the space by. A change shows at once and is written to the machine right away; changes from another screen come in within 15 seconds.

## License

MIT, except the code that came from Herdr's own spaces mod, which stays under the Apache License 2.0. See `LICENSE`.
