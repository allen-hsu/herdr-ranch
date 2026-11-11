// Board: every space as a card in Todo / In progress / In review / Done, Orca-style, as an overlay over the window
// (⌃⌘B or the Board button; Esc or × closes, nothing underneath changes).
// A card goes where you drag it (kept in shared "board.columns"); until then it is placed automatically: an agent
// working or needing you -> In progress; an open PR -> In review; agents but none working -> In progress; none -> Todo.
// Pin a card (hover → pin icon) to keep it at the top of its column. Click a card to go to that space.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Popover } from "gpui-base";
import { spaces, agents, panes, run, theme, props, shared, setShared, closeOverlay, exec } from "herdr";
import { TS, dialogTitle, escChip } from "./ui.js";
import { agentName } from "./agentname.js";
import { PRCache, prColor, prTip, repoSlug } from "./prs.js";
import { place } from "./folders.js";
import { programIcon } from "./agentrows.js";

const COLS = [
  { id: "todo", name: "Todo", icon: "circle" },
  { id: "progress", name: "In progress", icon: "spinner" },
  { id: "review", name: "In review", icon: "circle-check" },
  { id: "done", name: "Done", icon: "check" },
];
const COL_W = 280, COL_GAP = 12;
const ago = (ms) => { const s = ms / 1000; return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };

export default class Board extends View {
  init(_p, cx) {
    this.overlay = props()?.overlay;
    this.only = null; // space picked in the dropdown (null: all spaces)
    this.pickOpen = false;
    this.drag = null; this.over = null; this.moved = false;
    this.prs = new PRCache(); this.slugs = {}; this.prDirty = false;
    this.refreshSlugs(cx);
    // Data only (Herdr redraws on its own when spaces / agents change): new PR info redraws once.
    cx.timer.every(30000, (cx) => this.refreshSlugs(cx));
    cx.timer.every(5000, (cx) => { if (this.prDirty) { this.prDirty = false; cx.notify(); } });
  }

  // GitHub owner/name per space folder, for its PR (one git call per folder, cached).
  refreshSlugs(cx) {
    cx.spawn(async (cx) => {
      const ps = panes();
      for (const s of spaces().filter((x) => !x.machine)) {
        const dir = place(s, ps);
        if (!dir || this.slugs[dir] !== undefined) continue;
        const sl = await repoSlug({ dir }).catch(() => null);
        this.slugs[dir] = sl ? `${sl.owner}/${sl.name}` : null;
      }
      cx.notify();
    });
  }

  cards() {
    const ps = panes(), all = agents().filter((a) => !a.address.includes("/"));
    const manual = shared("board.columns") ?? {}, pinned = new Set(shared("board.pinned") ?? []);
    return spaces().filter((s) => !s.machine).map((s) => {
      const dir = place(s, ps) ?? s.folder ?? "";
      const mine = all.filter((a) => a.space === s.id);
      const slug = this.slugs[dir];
      const pr = slug && s.branch ? this.prs.get(slug, s.branch, null, () => { this.prDirty = true; }) : null;
      const busy = mine.some((a) => a.status === "working" || a.status === "blocked");
      const auto = busy ? "progress" : pr ? "review" : mine.length ? "progress" : "todo";
      const col = COLS.some((c) => c.id === manual[s.id]) ? manual[s.id] : auto;
      return { s, dir, mine, pr, col, manual: Boolean(manual[s.id]), pinned: pinned.has(s.id),
        worktree: dir.includes("/.herdr/worktrees/"), need: mine.some((a) => a.status === "blocked") };
    });
  }

  setCol(id, col) {
    const m = { ...(shared("board.columns") ?? {}) };
    if (col) m[id] = col; else delete m[id];
    setShared("board.columns", m);
  }
  setPinned(id, on) {
    const p = new Set(shared("board.pinned") ?? []);
    on ? p.add(id) : p.delete(id);
    setShared("board.pinned", [...p]);
  }

  mark(t, mine) {
    if (mine.some((a) => a.status === "blocked")) return div().size(12).rounded(6).bg(t.blocked).flex().items_center().justify_center().text_size(TS.tiny).font_bold().text_color("#fff").child("!");
    if (mine.some((a) => a.status === "working")) return svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900);
    if (mine.some((a) => a.status === "done")) return div().size(8).rounded(4).bg(t.done ?? t.accent);
    return mine.length ? div().size(8).rounded(4).border_1().border_color(t.dim) : div().size(5).rounded(3).bg(t.border);
  }

  // Agent status: only states worth seeing get a mark (idle agents stay plain, so nothing looks "finished" by mistake).
  agentMark(t, a) {
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(10).text_color(t.working).spin(900);
    if (a.status === "blocked") return div().size(6).rounded(3).bg(t.blocked);
    if (a.status === "done") return svg("mods/workspace-chrome/check.svg").size(10).text_color(t.done ?? t.accent);
    return div();
  }

  // A card in Herdr's list style: no outline, a background tier, hover lighter, the current space selected,
  // a red edge and "needs you" when an agent in it is waiting.
  card(t, c) {
    const s = c.s, dragging = this.drag?.id === s.id;
    const shown = c.mine.slice(0, 3);
    const name = s.name === "~" ? "Home" : s.name;
    const branch = s.branch && s.branch !== "main" && s.branch !== "master" && s.branch !== s.name ? s.branch : null;
    const hovered = this.hover === s.id;
    return v_flex().id(`card-${s.id}`).relative().w_full().px(12).py(10).gap(4).rounded(8).cursor_pointer().flex_none()
      .bg(s.active ? t.selected : t.surface).hover((x) => x.bg(t.hover))
      .on_hover((h, cx) => { const v = h ? s.id : this.hover === s.id ? null : this.hover; if (v !== this.hover) { this.hover = v; cx.notify(); } })
      .when(c.need, (x) => x.child(div().absolute().left(0).top(10).bottom(10).w(2).rounded(1).bg(t.blocked)))
      .when(dragging && this.moved, (x) => x.opacity(0.35))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.drag = { id: s.id, from: c.col }; this.moved = false; })
      .on_click(() => { if (this.moved) return; run("space.select", { id: s.id }); closeOverlay(this.overlay); })
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(div().w(16).flex_none().flex().justify_center().child(this.mark(t, c.mine)))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(name))
        .when(Boolean(c.pr), (x) => x.child(div().flex_none().text_size(11).text_color(prColor(c.pr, t)).tooltip(prTip(c.pr)).child(`#${c.pr.number}`)))
        .when(c.manual, (x) => x.child(div().id(`auto-${s.id}`).flex_none().text_size(11).text_color(t.dim).hover((h) => h.text_color(t.foreground))
          .tooltip("You placed this card. Click to let it follow its agents and PR again.")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); this.setCol(s.id, null); cx.notify(); }).child("↺")))
        .when(c.pinned || hovered, (x) => x.child(div().id(`pin-${s.id}`).flex_none().size(18).flex().items_center().justify_center().rounded(4)
          .hover((h) => h.bg(t.raised)).tooltip(c.pinned ? "Unpin" : "Pin to the top of its column")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); this.setPinned(s.id, !c.pinned); cx.notify(); })
          .child(svg(`mods/workspace-chrome/${c.pinned && hovered ? "pin-off" : "pin"}.svg`).size(11).text_color(c.pinned ? t.foreground : t.dim)))))
      .when(c.need, (x) => x.child(div().pl(22).text_size(11).text_color(t.blocked).child("needs you")))
      .when(Boolean(branch || c.worktree), (x) => x.child(div().pl(22).truncate().text_size(11).text_color(t.dim)
        .child([branch, c.worktree ? "worktree" : null].filter(Boolean).join(" · "))))
      .children(shown.map((a) => h_flex().pl(22).gap(6).items_center().min_w(0)
        .child(div().w(10).flex_none().flex().justify_center().child(this.agentMark(t, a)))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(a.status === "idle" ? t.muted : t.foreground).child(agentName(a) || a.program?.name || a.address))))
      .when(c.mine.length > shown.length, (x) => x.child(div().pl(38).text_size(11).text_color(t.dim).child(`+${c.mine.length - shown.length} more`)));
  }

  drop(target, cx) {
    if (this.drag && this.moved && target && target !== this.drag.from) this.setCol(this.drag.id, target);
    this.drag = null; this.over = null;
    cx.notify();
  }

  zone(t, id, child) {
    return child
      .on_mouse_move((_e, cx) => { if (this.drag) { if (this.over !== id) { this.over = id; if (id !== this.drag.from) this.moved = true; cx.notify(); } } })
      .on_mouse_up("left", (_e, cx) => this.drop(id, cx));
  }

  // Space picker: a dropdown in Herdr's field style; picking one shows only that space's card.
  spacePicker(t, all) {
    const cur = all.find((c) => c.s.id === this.only);
    const label = (c) => (c.s.name === "~" ? "Home" : c.s.name);
    const pick = (id) => (_e, cx) => { this.only = id; this.pickOpen = false; cx.notify(); };
    const row = (id, mark, text, right, on) => h_flex().id(`pk-${id ?? "all"}`).h(30).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).hover((e) => e.bg(t.hover)).on_click(pick(id))
      .child(div().w(16).flex_none().flex().justify_center().child(mark))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(text))
      .when(right != null, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(right)));
    const trigger = h_flex().id("bd-pick").w(260).h(36).px(10).gap(8).items_center().rounded(9).border_1()
      .border_color(this.pickOpen ? t.accent : t.input).bg(t.background).cursor_pointer()
      .child(div().w(16).flex_none().flex().justify_center().child(cur ? this.mark(t, cur.mine) : svg("mods/workspace-chrome/layers.svg").size(14).text_color(t.dim)))
      .child(div().flex_1().min_w(0).truncate().text_size(12.8).text_color(cur ? t.foreground : t.muted).child(cur ? label(cur) : "All spaces"))
      .child(svg("mods/workspace-chrome/chevron-down.svg").size(13).flex_none().text_color(t.dim));
    const list = v_flex().id("bd-pick-list").w(260).mt(4).p(4).gap(1).rounded(9).border_1().border_color(t.border).bg(t.popover)
      .child(row(null, svg("mods/workspace-chrome/layers.svg").size(13).text_color(t.dim), "All spaces", String(all.length), !cur))
      .child(div().h(1).mx(4).my(3).bg(t.border))
      .children(all.map((c) => row(c.s.id, this.mark(t, c.mine), label(c), c.mine.length ? `${c.mine.length} agent${c.mine.length > 1 ? "s" : ""}` : null, c.s.id === this.only)));
    return Popover.new("bd-space").open(this.pickOpen).on_open_change((o, cx) => { this.pickOpen = o; cx.notify(); })
      .trigger(trigger).content(list);
  }

  render() {
    const t = theme();
    const all = this.cards();
    if (this.only && !all.some((c) => c.s.id === this.only)) this.only = null;
    const cards = this.only ? all.filter((c) => c.s.id === this.only) : all;
    const dragging = Boolean(this.drag && this.moved);
    const head = h_flex().gap(12).items_center().flex_none()
      .child(h_flex().gap(8).items_baseline().flex_none().child(dialogTitle(t, "Board")).child(div().text_size(11).text_color(t.dim).child(`${all.length} spaces`)))
      .child(this.spacePicker(t, all))
      .child(div().flex_1())
      .child(escChip(t, "bd-esc", () => closeOverlay(this.overlay)));
    const column = (col) => {
      const list = cards.filter((c) => c.col === col.id).sort((a, b) => (b.pinned - a.pinned) || (b.need - a.need) || (b.s.active - a.s.active));
      const tint = col.id === "progress" ? t.working : col.id === "review" ? (t.done ?? t.accent) : col.id === "done" ? t.accent : t.dim;
      const target = dragging && this.drag.from !== col.id;
      return this.zone(t, col.id, v_flex().id(`col-${col.id}`).w(COL_W).flex_none().h_full().gap(6)
        .child(h_flex().h(28).px(4).gap(8).items_center().flex_none()
          .child(div().size(7).rounded(4).bg(tint))
          .child(div().text_size(13).font_semibold().text_color(t.foreground).child(col.name))
          .child(div().text_size(11).text_color(t.dim).child(String(list.length))))
        .child(v_flex().id(`colbody-${col.id}`).flex_1().min_h(0).gap(6).rounded(8).overflow_y_scrollbar()
          .when(target, (x) => x.p(4).border_1().border_dashed().border_color(this.over === col.id ? t.accent : t.input).when(this.over === col.id, (y) => y.bg(t.hover)))
          .children(list.map((c) => this.card(t, c)))));
    };
    return v_flex().id("board").size_full().p(18).gap(14).bg(t.popover).text_size(13).text_color(t.foreground)
      .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.drag = null; this.over = null; cx.notify(); } })
      .child(head)
      .child(h_flex().flex_1().min_h(0).gap(COL_GAP).children(COLS.flatMap((c, i) => i ? [div().w(1).h_full().flex_none().bg(t.border), column(c)] : [column(c)])));
  }
}
