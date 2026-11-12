// The bottom of the sidebar: "+ New agent" (opens the command bar at its New agent step), then Add machine and
// Settings as two icon buttons. Replaces Herdr's two-row footer (Settings / Add machine).
// Narrow sidebar: just the + button.
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { run, openOverlay, theme, layout } from "herdr";
import { TS, icon } from "./ui.js";

const find = (node, id) => { if (!node || typeof node !== "object") return null; if (node.id === id) return node;
  for (const c of node.children ?? []) { const f = find(c, id); if (f) return f; } return node.root ? find(node.root, id) : null; };
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

export default class SidebarFoot extends View {
  render() {
    const t = theme();
    const slim = narrow();
    const newAgent = () => openOverlay({ mod: "command-bar", kind: "popup", at: "top", offset: 90, width: 720, height: 470, props: { step: {} } });
    const btn = (id, ic, tip, act) => div().id(id).size(30).flex_none().flex().items_center().justify_center().rounded(7).cursor_pointer().text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(act).child(icon(ic, 14));
    if (slim) return h_flex().size_full().items_center().justify_center().bg(t.chrome).border_t(1).border_color(t.border).child(btn("sf-new", "plus", "New agent", newAgent));
    return h_flex().size_full().px(8).gap(4).items_center().bg(t.chrome).border_t(1).border_color(t.border)
      .child(h_flex().id("sf-new").flex_1().min_w(0).h(32).px(10).gap(8).items_center().rounded(8).bg(t.surface).cursor_pointer()
        .hover((s) => s.bg(t.hover)).tooltip("Start an agent: pick the folder, the agent, and type its task").on_click(newAgent)
        .child(icon("plus", 14, t.foreground))
        .child(div().flex_1().min_w(0).truncate().text_size(TS.item).font_medium().text_color(t.foreground).child("New agent")))
      .child(btn("sf-machine", "server", "Add machine…", () => run("mod.open", { mod: "machine-add" })))
      .child(btn("sf-settings", "settings", "Settings", () => run("app.settings")));
  }
}
