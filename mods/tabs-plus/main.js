// Modified from Herdr's built-in `tabs` mod (Apache-2.0; see /NOTICE). Changes by herdr-ranch: agent names on tabs, flash on done / needs-you, new-tab button after the last tab, page keys.
// Herdr's shipped tab bar (mods/tabs), cloned: tabs show their agent's name (lib/agentname.js) unless you named them.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, agents, run, openOverlay, theme, window, shared, layout, settings, props, nextCommand } from "herdr";
import { agentName } from "./agentname.js";
import { TS, C, tint, icon, statusMark, togglePage } from "./ui.js";
import { movePending } from "./accountswitch.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init(_props, cx) {
    // Keys for the full pages (keys.json: "tabs-plus.board", "tabs-plus.team"): this bar is always shown, so it answers.
    cx.spawn(async () => { for (;;) { const c = String(await nextCommand()).split(".").pop(); if (c === "board" || c === "team") togglePage(c); } });
    // Agents that were busy when the account was switched move once they are free (lib/accountswitch.js).
    cx.timer.every(15000, (cx) => { if (Object.keys(shared("accounts.pending") ?? {}).length && !this.moving) { this.moving = true; cx.spawn(async () => { try { await movePending(); } finally { this.moving = false; } }); } });
    // ranch: a tab whose agent finishes (or needs you) while you look elsewhere pulses: finished for a few
    // seconds, needs-you until you open it.
    this.prev = {};
    this.flash = {};
    // The pulse itself is native (.loop); this only redraws once when a finished-flash should end.
    cx?.timer?.every(1000, (cx) => { const now = Date.now(); if (Object.values(this.flash).some((f) => f.until < now)) cx.notify(); });
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      // ranch: a tab you named keeps its name; otherwise it shows its agent's name, as the sidebar does.
      const lead = agents().find((a) => a.tab === c.id && a.focused) ?? agents().find((a) => a.tab === c.id);
      const mineNamed = c.named && c.name !== program?.name && !/^tb\d+$/.test(c.name);
      const name = mineNamed ? c.name : (lead && agentName(lead)) || (/^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name);
      const now = Date.now();
      if (this.prev[c.id] !== c.status) {
        if ((c.status === "done" || c.status === "blocked") && !c.active) this.flash[c.id] = { kind: c.status, until: c.status === "blocked" ? Infinity : now + 4000 };
        this.prev[c.id] = c.status;
      }
      if (c.active || (this.flash[c.id] && this.flash[c.id].until < now) || (this.flash[c.id]?.kind === "blocked" && c.status !== "blocked")) delete this.flash[c.id];
      const fl = this.flash[c.id];
      const flashColor = fl ? C(t).status[fl.kind] : null;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(TS.item)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .when(Boolean(fl), (el) => el.bg(tint(flashColor, 0.18)).border_color(tint(flashColor, 0.6)).text_color(t.foreground).loop("opacity", { from: 0.55, to: 1, period: 900 }))
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working" || c.status === "blocked" || c.status === "done", el => el.child(statusMark(t, c.status)))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("ranch.panels") ?? shared("workspace.panels") ?? ["files", "changes"];
    const showPanelButtons = props()?.panel_buttons !== false;
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(TS.body).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).pr(0).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      // The sidebar hides completely; while it is hidden, the way back sits here, next to the window buttons.
      .when(Boolean(sidebar?.hidden), el => el.child(button("sidebar-show", icon("panel-left", 14), () => run("layout.show", { id: "sidebar" })).tooltip("Show the sidebar (⌘B)")))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item))
        // New tab sits right after the last tab, like a browser's.
        .child(button("tab-new", icon("plus", 14), () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })).tooltip("New tab or agent")))
      // The panel's own icon tabs already switch views: the layout can turn these two off ("panel_buttons": false).
      .when(showPanelButtons && enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(showPanelButtons && enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs/win-min.svg").size(16) : icon("minus", 14), () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : icon("square", 14), () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
