# Herdr Space Folders

Herdr's spaces list with folders: colored, foldable folders above the loose spaces, filled by dragging or by rules on the folder a space works in, kept in a file in the home of the machine the spaces run on.

![Herdr Space Folders](preview.png)

## What you see

- **The Spaces header**, 31px: "Spaces" in `dim` 11.5px, then a folder-plus button and Herdr's + (a new space), each 26px.
- **Per machine** (a header per machine once another one is known, as in Herdr's list; each header gets a folder-plus next to its +): the machine's folders in their order, each followed by its spaces when unfolded, then the spaces in no folder.
- **A folder's row**, 30px like a space's: an 18px tile with 5px corners in the folder's color (one of the space avatars' six, `#22a99a #e3814f #5b8def #8b7cf6 #3fae6a #d9649a`, or `dim` grey) holding a white 13px folder icon, the name in `foreground` medium weight, a status glyph when folded and an agent in it is blocked or done, a `dim` "+", the count, and a chevron (down open, right folded).
- **Spaces in a folder** are Herdr's space rows indented to 26px; worktrees stay under their checkout.
- **A machine in a folder** (a folder on this computer whose rules take it in): the machine's header, indented to 26px like the folder's spaces, then its folders and spaces at 26px. It no longer has a group of its own below, and once every other machine is in a folder the "This computer" header goes too. The folder's count and folded status include the machine's spaces.
- **While dragging**: a space over a folder gives the folder an `accent` border on `selected`; a dragged folder goes half transparent and a 2px `accent` line shows where it lands; a space dragged out of a folder shows a dashed drop zone under the list, "Drop here to take it out of its folder".
- **A folder's menu** (right-click), 210 by 160: seven 20px color dots (the current one ringed in `foreground`), "New space here", "Edit folder…", "Delete folder".
- **Edit folder**, a 460px dialog: Name; "Start new spaces in" with "Choose…" on this computer; "Collect spaces from" with a hint; Cancel and Save.

## How it behaves

- Click a folder to fold or unfold it. Press on a space and release on a folder to file it there; on another space to move it to that place (`space.move`) and into that space's folder; anywhere else in the list to take it out of its folder. Press on a folder and release on another to reorder: down puts it after, up before. Only within a machine.
- A space's folder: the one it was dragged into; "" (dragged out) keeps it out; otherwise the folder whose rules match deepest into the folder its first terminal works in (`~/code/client` beats `~/code`; on a tie the first folder wins). A worktree goes with its checkout's space.
- A machine goes in the folder on this computer whose rules match deepest into its name or the folder one of its spaces works in; a rule like `vm-*` matches a name the way it matches a folder name.
- Rules, comma-separated, each take a folder and everything in it: starting with `/` or `~` they're paths (`~` any home: `/home/x`, `/Users/x`, `/root`), otherwise a folder name at any depth; `*` is any one folder name.
- A folder's + and "New space here" run `space.new` with the start folder (`~` made the machine's `$HOME`) and the machine; the first space that then appears on that machine goes in the folder (Herdr returns no id).
- Choosing a start folder while the rules are empty (or the same as it) sets the rules to it too.
- Every change is shown at once (shared `space-folders`, per machine, `""` for this computer) and written to `~/.config/herdr-space-folders.json` on that machine (`exec sh` with `on`, through a temp file). Every 15 seconds each connected machine's file is read again; a file whose `at` is newer than what's shown wins.

## Built from

- **Mod** `mods/space-folders/`: `mod.clone` of Herdr's `spaces` (0.1.10), so its git, worktree, machine and drag-to-reorder code is Herdr's. Added: folders in `grouped` (`foldered`, `folderHead`), the drop and reorder handlers, the menu (overlay props `folderMenu, machine`) and the edit dialog (overlay props `edit, machine`) as modes of the same mod.
- **Layout** `layouts/main-folders.json`: Herdr's `main` 0.1.10 with the `spaces` block's mod set to `space-folders`.
- **herdr**: `spaces`, `panes`, `machines`, `run` (`space.new`, `space.move`, `space.select`), `openOverlay`, `closeOverlay`, `props`, `shared` / `setShared` (`space-folders`, `space-folders.new`), `exec` (with `on`), `pickFolder`, `home`.
- **Icons**: Herdr's own, from `mods/workspace-chrome/` (folder, folder-plus, chevrons, plus).

## Watch out

- There's no drag and drop between elements in mods: it's press on one, release on another, as Herdr's own tabs and spaces do.
- Herdr doesn't reload a mod from a symlinked folder when a file changes; recreating the link (or a restart) does.
- An overlay opened while its mod reloads can come up late or not at all.
- Space ids are per machine: remote spaces show as `machine/id` here and are stored by their own id in that machine's file.
- Herdr's right-click menu on a space can't be extended without cloning it, so there's no "Move to folder" there: drag instead.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/space-folders` passes.
- The folder-plus button makes a folder and opens Edit folder; Save renames it.
- Dragging a space onto a folder files it; dragging it out puts it back; dragging a folder reorders the folders.
- A folder with a start folder opens its new spaces there, in the folder.
- A rule such as `herdr-*` collects the spaces working in matching folders.
- `~/.config/herdr-space-folders.json` changes with every edit, and another Herdr on the same machine shows the same folders.
