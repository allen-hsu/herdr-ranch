// Generic tab strip for a layout `stack` node (use as its header). Reads the stack's children and
// active child from layout(); click selects with layout.select. Props: { "stack": "<id>",
// "labels": { "<child id>": "Label" }, "hide": ["<child id>"], "sync_panels": true } — children without a
// label show their id; hidden children get no tab but stay selectable (e.g. by the tab bar's buttons).
// sync_panels: add the children's ids to shared "workspace.panels", which Herdr's tab bar uses to remember
// per space which panel child was open (it only restores ids listed there).
// "icons": { "<child id>": "<lucide name>" } draws icon tabs instead of text; "panel": "<layout id>" adds a hide button.
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, props, run, theme, shared, setShared } from "herdr";
import { TS, icon } from "./ui.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
}

export default class StackTabs extends View {
  render() {
    const t = theme();
    const p = props() ?? {};
    const stack = find(layout(), p.stack);
    const labels = p.labels && typeof p.labels === "object" ? p.labels : {};
    const hide = new Set(Array.isArray(p.hide) ? p.hide : []);
    const all = (stack?.children ?? []).filter((c) => c?.id && !c.hidden);
    const kids = all.filter((c) => !hide.has(c.id));
    const active = stack?.active ?? kids[0]?.id;
    if (p.sync_panels) {
      const have = shared("workspace.panels") ?? ["files", "changes"];
      const missing = all.map((c) => c.id).filter((id) => !have.includes(id));
      if (missing.length) setShared("workspace.panels", [...have, ...missing]);
    }
    // Icon tabs (props.icons: { "<child id>": "<icon name>" }), Orca-style: one icon per view, its name on hover,
    // a line under the open one; on the right a button that hides the panel (props.panel: the panel's layout id).
    const icons = p.icons && typeof p.icons === "object" ? p.icons : null;
    const name = (c) => (typeof labels[c.id] === "string" ? labels[c.id] : c.id);
    if (icons) {
      return h_flex().id("stack-tabs").size_full().px(8).gap(2).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .children(kids.map((c) => {
          const on = c.id === active;
          return div().id(`st-${c.id}`).relative().w(32).h(28).flex_none().flex().items_center().justify_center().rounded(7).cursor_pointer()
            .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(name(c))
            .on_click(() => run("layout.select", { stack: p.stack, child: c.id }))
            .child(icons[c.id] ? icon(icons[c.id], 16) : div().text_size(TS.body).child(name(c).slice(0, 2)))
            .when(on, (el) => el.child(div().absolute().left(7).right(7).bottom(-4).h(2).rounded(1).bg(t.foreground)));
        }))
        .child(div().flex_1())
        .when(Boolean(active), (el) => el.child(div().flex_none().px(4).text_size(TS.body).text_color(t.dim).child(name(kids.find((c) => c.id === active) ?? { id: active }))))
        .when(typeof p.panel === "string", (el) => el.child(div().id("st-hide").w(30).h(28).flex_none().flex().items_center().justify_center().rounded(7).cursor_pointer()
          .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Hide this panel")
          .on_click(() => run("layout.toggle", { id: p.panel })).child(icon("panel-right", 16))));
    }
    return h_flex().id("stack-tabs").size_full().px(8).gap(2).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .children(kids.map((c) => {
        const on = c.id === active;
        return div().id(`st-${c.id}`).px(9).py(4).rounded(6).text_size(TS.body).cursor_pointer()
          .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected).font_medium())
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("layout.select", { stack: p.stack, child: c.id }))
          .child(typeof labels[c.id] === "string" ? labels[c.id] : c.id);
      }));
  }
}
