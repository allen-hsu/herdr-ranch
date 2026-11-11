// Space picker for the agent board (opened with mod.open as a popup). Writes the board's filter to
// shared state "agent-board.filter": "all" | "current" | { spaces: [ids] }.
// Spaces with agents, grouped by space-folders folders (folder checkbox = all its spaces).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, spaces, panes, focused, theme, shared, setShared } from "herdr";
import { folderOf, loadFolders } from "./folders.js";
import { TS, C, field, icon, statusMark } from "./ui.js";

const FILTER = "agent-board.filter";
const ORDER = ["blocked", "idle", "working", "done"];
const RANK = { blocked: 0, error: 0, idle: 1, working: 2, done: 3 };
const norm = (s) => (s === "error" ? "blocked" : s);
const label = (name) => (name === "~" || !name ? "~ Home" : name);
const getFilter = () => { const f = shared(FILTER); return f === "current" || (f && Array.isArray(f.spaces)) ? f : "all"; };
const SEARCH_FROM = 7;

export default class BoardPicker extends View {
  init(_props, cx) {
    this.folders = { list: [], of: {} };
    this.open = new Set();
    this.search = InputState.new({ placeholder: "Search spaces" });
    this.search.on("change", (_e, cx) => cx.notify());
    cx.spawn(async (cx) => { this.folders = await loadFolders(); cx.notify(); });
  }

  dots(t, items) {
    const c = {};
    for (const a of items) c[norm(a.status)] = (c[norm(a.status)] ?? 0) + 1;
    return h_flex().flex_none().gap(6).items_center().children(ORDER.filter((s) => c[s]).map((s) =>
      h_flex().gap(4).items_center().child(statusMark(t, s, { size: 10 })).child(div().text_size(TS.small).text_color(t.dim).child(String(c[s])))));
  }

  render() {
    const t = theme();
    const everyone = agents();
    const f = getFilter();
    const picked = new Set(f !== "all" && f !== "current" ? f.spaces : []);
    const ps = panes();
    const withAgents = spaces().filter((s) => everyone.some((a) => a.space === s.id));
    const urgency = (s) => Math.min(...everyone.filter((a) => a.space === s.id).map((a) => RANK[a.status] ?? 9));
    withAgents.sort((a, b) => urgency(a) - urgency(b));
    const showSearch = withAgents.length >= SEARCH_FROM;
    const q = showSearch ? this.search.value().trim().toLowerCase() : "";
    const hit = (s) => !q || label(s.name).toLowerCase().includes(q);
    const groups = (this.folders.list ?? []).map((folder) => ({ folder, spaces: withAgents.filter((s) => folderOf(s, this.folders, ps) === folder.id) })).filter((g) => g.spaces.length);
    const inFolder = new Set(groups.flatMap((g) => g.spaces.map((s) => s.id)));
    const loose = withAgents.filter((s) => !inFolder.has(s.id));

    const set = (v) => setShared(FILTER, v);
    const toggle = (ids, off) => {
      const next = new Set(picked);
      for (const id of ids) off ? next.delete(id) : next.add(id);
      set(next.size ? { spaces: [...next] } : "all");
    };
    const check = (on, partial) => div().w(14).h(14).flex_none().rounded(3).border(1).border_color(on || partial ? t.accent : t.input)
      .flex().items_center().justify_center().when(on, (el) => el.bg(t.accent).child(icon("check", 12, C(t).on.accent)))
      .when(partial && !on, (el) => el.child(div().w(6).h(2).bg(t.accent)));
    const radio = (on) => div().w(14).h(14).flex_none().rounded(7).border(1).border_color(on ? t.accent : t.input)
      .flex().items_center().justify_center().when(on, (el) => el.child(div().w(6).h(6).rounded(3).bg(t.accent)));
    const row = (id, indent) => h_flex().id(id).w_full().pl(8 + indent).pr(8).h(28).flex_none().gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover));
    const name = (text, strong) => div().flex_1().min_w(0).truncate().text_size(TS.body).text_color(t.foreground).when(strong, (el) => el.font_medium()).child(text);

    const rows = [
      row("p-all", 0).on_click(() => set("all")).child(radio(f === "all")).child(name("All spaces")).child(div().text_size(TS.small).text_color(t.dim).child(String(everyone.length))),
      row("p-cur", 0).on_click(() => set("current")).child(radio(f === "current"))
        .child(name(`Current · ${label(spaces().find((s) => s.id === focused()?.space)?.name)}`)),
      div().my(4).h(1).flex_none().bg(t.border),
    ];
    for (const g of groups) {
      const members = g.spaces.filter(hit);
      if (!members.length) continue;
      const ids = g.spaces.map((s) => s.id);
      const all = ids.every((id) => picked.has(id)), some = ids.some((id) => picked.has(id));
      const open = Boolean(q) || this.open.has(g.folder.id);
      rows.push(row(`p-f-${g.folder.id}`, 0).on_click(() => toggle(ids, all))
        .child(check(all, some))
        .child(div().id(`p-fo-${g.folder.id}`).p(2).rounded(4).hover((s) => s.bg(t.raised))
          .on_click((_e, cx) => { cx.stop_propagation(); open ? this.open.delete(g.folder.id) : this.open.add(g.folder.id); cx.notify(); })
          .child(icon(open ? "chevron-down" : "chevron-right", 12, t.muted)))
        .child(name(`${g.folder.name}  (${ids.length})`, true))
        .child(this.dots(t, everyone.filter((a) => ids.includes(a.space)))));
      if (open) for (const s of members) {
        const on = picked.has(s.id);
        rows.push(row(`p-s-${s.id}`, 26).on_click(() => toggle([s.id], on)).child(check(on)).child(name(label(s.name))).child(this.dots(t, everyone.filter((a) => a.space === s.id))));
      }
    }
    for (const s of loose.filter(hit)) {
      const on = picked.has(s.id);
      rows.push(row(`p-s-${s.id}`, 0).on_click(() => toggle([s.id], on)).child(check(on)).child(name(label(s.name))).child(this.dots(t, everyone.filter((a) => a.space === s.id))));
    }
    if (rows.length === 3) rows.push(div().px(8).py(6).text_size(TS.meta).text_color(t.dim).child("No spaces with agents."));

    return v_flex().id("board-picker").w(300).p(6).gap(4)
      .child(div().px(8).pt(2).pb(2).text_size(11).font_semibold().text_color(t.dim).child("Show agents from"))
      .when(showSearch, (el) => el.child(div().px(2).child(field(t, this.search, { size: "panel", icon: "ranch/icons/search.svg" }))))
      .child(v_flex().id("p-list").max_h(320).overflow_y_scrollbar().children(rows));
  }
}
