// The bottom of the sidebar: "+ New agent" (opens the command bar at its New agent step), then Add machine and
// Settings as two icon buttons. Replaces Herdr's two-row footer (Settings / Add machine).
// Narrow sidebar: just the + button.
import { View, div, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { run, theme, props, window } from "herdr";
import { TS, icon, openCommandBar, sidebarNarrow, toggleSidebar, togglePage } from "./ui.js";

export default class SidebarFoot extends View {
  render() {
    const t = theme();
    const slim = sidebarNarrow();
    const btn = (id, ic, tip, act) => div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded(7).cursor_pointer().text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(act).child(icon(ic, 14));
    // props.brand: the top row (logo, name, sidebar toggle) without Herdr's extra search icon: the search row
    // right under it is the one way to search. On macOS the traffic lights sit to the left of the logo.
    if (props()?.brand) {
      const mac = window()?.platform === "macos", lights = mac && !window()?.fullscreen;
      if (slim) return h_flex().size_full().bg(t.chrome).justify_center().items_center()
        .when(!mac, (el) => el.child(btn("sb-toggle", "panel-left", "Show the full sidebar", () => toggleSidebar())));
      return h_flex().size_full().bg(t.chrome).pl(lights ? 76 : 14).pr(8).gap(8).items_center().text_size(13.5)
        .child(image("frame/welcome/herdr.png").size(20).rounded(5).flex_none())
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child("Herdr"))
        .child(btn("sb-toggle", "panel-left", "Collapse the sidebar", () => toggleSidebar()));
    }
    // props.search: the same mod draws the "Search or run a command" row under the brand.
    if (props()?.search) {
      if (slim) return div().size_full().bg(t.chrome);
      return h_flex().size_full().px(8).pb(6).items_center().bg(t.chrome)
        .child(h_flex().id("sb-search").flex_1().min_w(0).h(30).px(10).gap(8).items_center().rounded(8).bg(t.surface).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => run("mod.open", { name: "command-bar" }))
          .child(icon("search", 13))
          .child(div().flex_1().min_w(0).truncate().text_size(TS.body).child("Search or run a command"))
          .child(div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(11).text_color(t.dim).child("⌘K")));
    }
    const newAgent = () => openCommandBar({});
    const link = (id, ic, label, act) => h_flex().id(id).h(26).px(6).gap(6).items_center().rounded(6).cursor_pointer().text_size(TS.body).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(act).child(icon(ic, 13)).child(label);
    // The narrow rail: the way back to the full sidebar, and New agent.
    if (slim) return v_flex().size_full().pt(8).gap(4).items_center().bg(t.chrome).border_t(1).border_color(t.border)
      .child(btn("sf-new", "plus", "New agent", newAgent))
      .child(btn("sf-expand", "panel-left", "Show the full sidebar", () => toggleSidebar()));
    // "+ New agent" on top; under it a quiet row of icons (Arc's bottom bar): whole-app views on the left,
    // machine and settings on the right. Names are in the tooltips.
    return v_flex().size_full().px(8).pt(8).gap(4).bg(t.chrome).border_t(1).border_color(t.border)
      .child(h_flex().id("sf-new").h(32).flex_none().px(10).gap(8).items_center().rounded(8).bg(t.surface).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click(newAgent)
        .child(icon("plus", 14, t.foreground))
        .child(div().flex_1().min_w(0).truncate().text_size(TS.item).font_medium().text_color(t.foreground).child("New agent")))
      .child(h_flex().h(28).flex_none().gap(2).items_center()
        .child(btn("sf-board", "layers", "Board: every space by status (⌃⌘B)", () => togglePage("board")))
        .child(btn("sf-team", "users", "Team Map (⌃⌘T)", () => togglePage("team")))
        .child(div().flex_1())
        .child(btn("sf-machine", "server", "Add machine…", () => run("mod.open", { name: "machine-add" })))
        .child(btn("sf-settings", "settings", "Settings", () => run("app.settings"))));
  }
}
