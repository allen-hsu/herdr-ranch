// worktrees: git worktree management for Herdr, in the spirit of Orca's.
// One mod, several views, picked by props (so any layout or mod can open them without importing code):
//   { view: "pill" }                               status-bar button: count · disk · cleanable; opens the window
//   { view: "window" }                             Resource Manager: CPU / memory per repo → worktree → terminal,
//                                                  disk use, clean-up list (opened by the pill)
//   { wt: "new" | "clean", root, on? }             dialogs for a repository (root = its main checkout)
//   { wt: "remove", root, path, on? }              delete one worktree, showing what would be lost
// Other mods open the dialogs with openOverlay({ mod: "worktrees", kind: "dialog", props: { wt, root, ... } }).
//   wt.js         the engine (create / inspect / remove / list / prune), argument-list git only
//   wtviews.js    the dialogs
//   resources.js  scan + pill + Resource Manager window
import { View, div } from "gpui-kit";
import { props, theme } from "herdr";
import { WorktreeDialog } from "./wtviews.js";
import { ResourcesPill, ResourcesWindow } from "./resources.js";

export default class Worktrees extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.wt) this.part = new WorktreeDialog({ ...p, overlay: p.overlay }, cx);
    else if (p.view === "window") this.part = new ResourcesWindow({ ...p, overlay: p.overlay }, cx);
    else this.part = new ResourcesPill(cx); // "pill", and the default when docked without props
  }
  render() {
    return this.part ? this.part.render(theme()) : div();
  }
}
