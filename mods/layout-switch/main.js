// Layout switcher. Data-driven: lists every layout Herdr knows (layouts()), marks the shown one,
// and shows each layout's shortcut from keys.json (a binding to layout.switch:<name>).
// Optional props on the block: { "labels": { "command": "Overview" }, "hide": ["win98"], "order": ["command", "pair"],
// "board": "space-board" (a Board button that opens that mod), "panel": "panel" (right-panel toggle) }.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { run, shared, layouts, keys, props, theme, layout } from "herdr";
import { TS } from "./ui.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
}

const pretty = (k) => k.replace(/ctrl-/g, "⌃").replace(/alt-/g, "⌥").replace(/shift-/g, "⇧").replace(/cmd-/g, "⌘").toUpperCase();

export default class LayoutSwitch extends View {
  items() {
    const p = props() ?? {};
    const hide = new Set(Array.isArray(p.hide) ? p.hide : []);
    const order = Array.isArray(p.order) ? p.order : [];
    const labels = p.labels && typeof p.labels === "object" ? p.labels : {};
    const shortcut = {};
    for (const b of keys()) {
      const m = /^layout\.switch:(.+)$/.exec(b.action ?? "");
      if (m && b.section === "global" && !shortcut[m[1]]) shortcut[m[1]] = pretty(b.keys);
    }
    const rank = (n) => (order.includes(n) ? order.indexOf(n) : order.length);
    return layouts().filter((n) => !hide.has(n))
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
      .map((name) => ({ name, label: typeof labels[name] === "string" ? labels[name] : name, key: shortcut[name] }));
  }

  render() {
    const t = theme();
    const current = shared("layout");
    const panel = props()?.panel;
    const panelKey = keys().find((b) => b.section === "global" && b.action === `layout.toggle:${panel}`)?.keys;
    // Optional props.board: a mod opened as an overlay (e.g. "space-board"), shown as a "Board" button.
    const board = props()?.board;
    const boardKey = board && keys().find((b) => b.section === "global" && b.action === `mod.open:${board}`)?.keys;
    return h_flex().id("layout-switch").size_full().pl(board ? 3 : 10).pr(10).gap(3).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
      // Same button as the tab bar's Files / Changes (h 26, px 8, gap 5, 14px icon) so the row reads as one.
      .when(Boolean(board), (el) => el.child(h_flex().id("ls-board").h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(TS.body).cursor_pointer()
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(`Board: every space by status${boardKey ? ` (${pretty(boardKey)})` : ""}`)
        .on_click(() => run("mod.open", { name: board }))
        .child(svg("mods/workspace-chrome/layers.svg").size(14)).child("Board")))
      .children(this.items().map((i) => {
        const on = i.name === current;
        return div().id(`ls-${i.name}`).px(8).py(2).rounded(6).text_size(TS.body).cursor_pointer()
          .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(i.key ? `${i.label} (${i.key})` : i.label)
          .on_click(() => run("layout.switch", { name: i.name }))
          .child(i.label);
      }))
      // Optional props.panel: id of a layout node this button shows/hides (e.g. the right panel).
      .when(Boolean(panel), (el) => {
        const shown = !find(layout(), panel)?.hidden;
        return el.child(div().w(1).h(14).mx(4).bg(t.border)).child(div().id("ls-panel").size(26).flex().items_center().justify_center().rounded(6).cursor_pointer()
          .text_color(shown ? t.foreground : t.dim).when(shown, (e) => e.bg(t.selected))
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(`${shown ? "Hide" : "Show"} the right panel${panelKey ? ` (${pretty(panelKey)})` : ""}`)
          .on_click(() => run("layout.toggle", { id: panel }))
          .child(svg("mods/workspace-chrome/panel-right.svg").size(14)));
      });
  }
}
