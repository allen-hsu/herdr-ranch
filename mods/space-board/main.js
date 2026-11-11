// Board: every space as a card in Todo / In progress / In review / Done, Orca-style, as an overlay over the window
// (⌃⌘B or the Board button; Esc or × closes, nothing underneath changes).
// A card goes where you drag it (kept in shared "board.columns"); until then it is placed automatically: an agent
// working or needing you -> In progress; an open PR -> In review; agents but none working -> In progress; none -> Todo.
// Drop on "Pinned" to keep a card at the top. Click a card to go to that space.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, agents, panes, run, theme, props, shared, setShared, closeOverlay, exec } from "herdr";
import { TS, SPACE } from "./ui.js";
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
const ago = (ms) => { const s = ms / 1000; return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };

export default class Board extends View {
  init(_p, cx) {
    this.overlay = props()?.overlay;
    this.search = InputState.new({ placeholder: "Search spaces" });
    this.search.on("change", (_e, cx) => cx.notify());
    this.drag = null; this.over = null; this.moved = false;
    this.prs = new PRCache(); this.slugs = {}; this.prDirty = false;
    this.refreshSlugs(cx);
    // Data only (Herdr redraws on its own when spaces / agents change): new PR info redraws once.
    cx.timer.every(30000, (cx) => this.refreshSlugs(cx));
    cx.timer.every(5000, (cx) => { if (this.prDirty) { this.prDirty = false; cx.notify(); } });
    this.inputFocused = false;
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
    const q = this.search.value().trim().toLowerCase();
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
    }).filter((c) => !q || c.s.name.toLowerCase().includes(q) || (c.s.branch ?? "").toLowerCase().includes(q) || c.mine.some((a) => (agentName(a) ?? "").toLowerCase().includes(q)));
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

  // A card in Herdr's list style: no outline; a background tier, hover lighter, the current space selected,
  // a red edge when something in it needs you.
  card(t, c) {
    const s = c.s, dragging = this.drag?.id === s.id;
    const shown = c.mine.slice(0, 4);
    return v_flex().id(`card-${s.id}`).relative().px(10).py(8).gap(3).rounded(7).cursor_pointer().flex_none()
      .bg(s.active ? t.selected : t.surface).hover((x) => x.bg(t.hover))
      .when(c.need, (x) => x.child(div().absolute().left(0).top(8).bottom(8).w(2).rounded(1).bg(t.blocked)))
      .when(dragging && this.moved, (x) => x.opacity(0.35))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.drag = { id: s.id, from: c.pinned ? "pinned" : c.col }; this.moved = false; })
      .on_click(() => { if (this.moved) return; run("space.select", { id: s.id }); closeOverlay(this.overlay); })
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(div().w(14).flex_none().flex().justify_center().child(this.mark(t, c.mine)))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(s.name))
        .when(Boolean(c.pr), (x) => x.child(div().flex_none().text_size(TS.meta).text_color(prColor(c.pr, t)).tooltip(prTip(c.pr)).child(`#${c.pr.number}`)))
        .when(c.manual, (x) => x.child(div().id(`auto-${s.id}`).flex_none().text_size(TS.meta).text_color(t.dim).hover((h) => h.text_color(t.foreground))
          .tooltip("You placed this card. Click to let it follow its agents and PR again.")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); this.setCol(s.id, null); cx.notify(); }).child("↺"))))
      .when(Boolean(s.branch), (x) => x.child(div().pl(20).truncate().text_size(TS.meta).text_color(t.dim)
        .child(`${s.branch}${c.worktree ? " · worktree" : ""}`)))
      .children(shown.map((a) => h_flex().pl(20).gap(6).items_center().min_w(0)
        .child(div().w(12).flex_none().flex().justify_center().child(a.status === "working" ? svg("mods/workspace-chrome/spinner.svg").size(10).text_color(t.working).spin(900)
          : a.status === "blocked" ? div().size(6).rounded(3).bg(t.blocked) : svg("mods/workspace-chrome/circle-check.svg").size(10).text_color(a.status === "done" ? t.done : t.dim)))
        .child(div().flex_1().min_w(0).truncate().text_size(TS.meta).text_color(a.status === "idle" ? t.muted : t.foreground).child(agentName(a) || a.program?.name || a.address))))
      .when(c.mine.length > shown.length, (x) => x.child(div().pl(20).text_size(TS.meta).text_color(t.dim).child(`+${c.mine.length - shown.length} more`)));
  }

  drop(target, cx) {
    if (this.drag && this.moved) {
      if (target === "pinned") this.setPinned(this.drag.id, true);
      else if (target) { if (this.drag.from === "pinned") this.setPinned(this.drag.id, false); this.setCol(this.drag.id, target); }
    }
    this.drag = null; this.over = null;
    cx.notify();
  }

  zone(t, id, child) {
    const hot = this.drag && this.moved && this.over === id;
    return child.when(Boolean(hot), (x) => x.bg(t.hover))
      .on_mouse_move((_e, cx) => { if (this.drag) { if (this.over !== id) { this.over = id; if (id !== this.drag.from) this.moved = true; cx.notify(); } } })
      .on_mouse_up("left", (_e, cx) => this.drop(id, cx));
  }

  render() {
    const t = theme();
    const cards = this.cards();
    const pinned = cards.filter((c) => c.pinned);
    const dragging = Boolean(this.drag && this.moved);
    const head = h_flex().gap(12).items_center().flex_none()
      .child(div().font_semibold().text_color(t.foreground).child("Board"))
      .child(Input.new(this.search).w(260).h(32).px(10).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground))
      .child(div().flex_1())
      .child(div().id("bd-close").size(26).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim).hover((x) => x.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => closeOverlay(this.overlay)).child(svg("mods/pane/close.svg").size(13)));
    const pinRow = this.zone(t, "pinned", h_flex().min_h(32).px(8).gap(6).items_center().flex_wrap().rounded(7).flex_none()
      .child(div().text_size(TS.meta).text_color(t.dim).child(pinned.length ? "Pinned" : dragging ? "Drop to pin" : "Pinned — drag a card here to keep it on top"))
      .children(pinned.map((c) => h_flex().id(`pin-${c.s.id}`).h(26).px(8).gap(6).items_center().rounded(6).bg(t.surface).cursor_pointer().hover((x) => x.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.drag = { id: c.s.id, from: "pinned" }; this.moved = false; })
        .on_click(() => { if (this.moved) return; run("space.select", { id: c.s.id }); closeOverlay(this.overlay); })
        .child(this.mark(t, c.mine)).child(div().text_color(t.foreground).child(c.s.name))
        .child(div().id(`unpin-${c.s.id}`).text_color(t.dim).hover((x) => x.text_color(t.foreground)).tooltip("Unpin")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); this.setPinned(c.s.id, false); cx.notify(); })
          .child(svg("mods/pane/close.svg").size(10))))));
    const column = (col) => {
      const list = cards.filter((c) => c.col === col.id && !c.pinned).sort((a, b) => (b.need - a.need) || (b.s.active - a.s.active));
      const tint = col.id === "progress" ? t.working : col.id === "review" ? (t.done ?? t.accent) : col.id === "done" ? t.accent : t.dim;
      return this.zone(t, col.id, v_flex().id(`col-${col.id}`).flex_1().min_w(0).h_full().rounded(8).p(4)
        .child(h_flex().h(28).px(6).gap(8).items_center().flex_none()
          .child(div().size(7).rounded(4).bg(tint))
          .child(div().font_semibold().text_color(t.foreground).child(col.name))
          .child(div().text_size(TS.meta).text_color(t.dim).child(String(list.length))))
        .child(v_flex().id(`colbody-${col.id}`).flex_1().min_h(0).pt(4).gap(6).overflow_y_scrollbar()
          .when(!list.length, (x) => x.child(div().px(6).py(6).text_size(TS.meta).text_color(t.dim).child(dragging ? "Drop here" : "Nothing here")))
          .children(list.map((c) => this.card(t, c)))));
    };
    return v_flex().id("board").size_full().p(16).gap(10).bg(t.popover).text_size(13).text_color(t.foreground)
      .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.drag = null; this.over = null; cx.notify(); } })
      .child(head).child(pinRow)
      .child(h_flex().flex_1().min_h(0).gap(12).children(COLS.map(column)))
      .child(h_flex().justify_end().text_size(TS.meta).text_color(t.dim).flex_none().child("drag to move · click to open · ↺ back to automatic · esc close"));
  }
}
