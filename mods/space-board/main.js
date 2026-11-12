// Board: every space as a card in Todo / In progress / In review / Done, Orca-style, as an overlay over the window
// (⌃⌘B or the Board button; Esc or × closes, nothing underneath changes).
// By space: a card goes where you drag it (kept in shared "board.columns"); until then it is placed automatically:
// an agent working or needing you -> In progress; an open PR -> In review; agents finished and not looked at yet ->
// Done; everything idle, or no agent -> Todo. Pin a card (hover → pin) to keep it on top. Click a card to go there;
// hover → + starts an agent in that space.
// By agent: one card per agent, in Needs you / Working / Finished / Idle (not draggable: the agent's state decides).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Popover } from "gpui-base";
import { spaces, agents, panes, run, theme, props, shared, setShared, closeOverlay, exec } from "herdr";
import { TS, C, dialogTitle, escChip, icon, statusMark, statusOf, spaceName, openCommandBar } from "./ui.js";
import { agentName } from "./agentname.js";
import { PRCache, prColor, prTip, repoSlug } from "./prs.js";
import { place, loadFolders, folderOf } from "./folders.js";
import { programIcon } from "./agentrows.js";

const COLS = [
  { id: "todo", name: "Todo", icon: "circle" },
  { id: "progress", name: "In progress", icon: "spinner" },
  { id: "review", name: "In review", icon: "circle-check" },
  { id: "done", name: "Done", icon: "check" },
];
const AGENT_COLS = [
  { id: "blocked", name: "Needs you" },
  { id: "working", name: "Working" },
  { id: "done", name: "Finished" },
  { id: "idle", name: "Idle" },
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
    this.mode = localStorage.getItem("mode") === "agent" ? "agent" : "space"; // cards are spaces, or agents
    this.folders = { list: [], of: {} };
    this.since = {}; // agent address -> when its status last changed (ms), from herdr-core
    cx.spawn(async (cx) => { this.folders = await loadFolders(); cx.notify(); });
    this.refreshTimes(cx);
    cx.timer.every(30000, (cx) => this.refreshTimes(cx));
    this.refreshSlugs(cx);
    // Data only (Herdr redraws on its own when spaces / agents change): new PR info redraws once.
    cx.timer.every(30000, (cx) => this.refreshSlugs(cx));
    cx.timer.every(5000, (cx) => { if (this.prDirty) { this.prDirty = false; cx.notify(); } });
  }

  // When each agent's status last changed: herdr-core knows (status_ms); the app's agent list doesn't carry it.
  refreshTimes(cx) {
    cx.spawn(async (cx) => {
      const list = agents().filter((a) => !a.address.includes("/")).slice(0, 40);
      const got = await Promise.all(list.map((a) => exec("hc", ["get", a.address, "--json"], { timeout: 4000 }).then((r) => [a.address, JSON.parse(r.stdout || "{}").status_ms]).catch(() => [a.address, null])));
      const next = Object.fromEntries(got.filter(([, v]) => typeof v === "number"));
      if (JSON.stringify(next) !== JSON.stringify(this.since)) { this.since = next; cx.notify(); }
    });
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
      const busy = mine.some((a) => a.status === "working" || a.status === "blocked" || a.status === "error");
      const auto = busy ? "progress" : pr ? "review" : mine.some((a) => a.status === "done") ? "done" : "todo";
      const fid = folderOf(s, this.folders, ps);
      const last = Math.max(0, ...mine.map((a) => this.since[a.address] ?? 0));
      const col = COLS.some((c) => c.id === manual[s.id]) ? manual[s.id] : auto;
      return { s, dir, mine, pr, col, manual: Boolean(manual[s.id]), pinned: pinned.has(s.id), last,
        folder: (this.folders.list ?? []).find((f) => f.id === fid)?.name ?? null,
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

  mark(t, mine) { return statusMark(t, statusOf(mine)); }

  // Agent status: only states worth seeing get a mark (idle agents stay plain, so nothing looks "finished" by mistake).
  agentMark(t, a) {
    return a.status === "working" || a.status === "blocked" || a.status === "error" || a.status === "done" ? statusMark(t, a.status, { size: 10 }) : div();
  }

  // A card in Herdr's list style: no outline, a background tier, hover lighter, the current space selected,
  // a red edge and "needs you" when an agent in it is waiting.
  card(t, c) {
    const s = c.s, dragging = this.drag?.id === s.id;
    // Only agents doing something (or just finished) get a line; the rest are in the summary.
    const live = c.mine.filter((a) => a.status !== "idle");
    const shown = live.slice(0, 3);
    const name = spaceName(s.name);
    const st = C(t).status;
    const count = (k) => c.mine.filter((a) => (k === "blocked" ? a.status === "blocked" || a.status === "error" : a.status === k)).length;
    const parts = [["blocked", "needs you", st.blocked], ["working", "working", st.working], ["done", "finished", st.done], ["idle", "idle", t.dim]]
      .map(([k, label, color]) => ({ n: count(k), label, color })).filter((x) => x.n > 0);
    const branch = s.branch && s.branch !== "main" && s.branch !== "master" && s.branch !== s.name ? s.branch : null;
    const hovered = this.hover === s.id;
    return v_flex().id(`card-${s.id}`).relative().w_full().px(12).py(10).gap(4).rounded(8).cursor_pointer().flex_none()
      .bg(s.active ? t.selected : t.surface).hover((x) => x.bg(t.hover))
      .on_hover((h, cx) => { const v = h ? s.id : this.hover === s.id ? null : this.hover; if (v !== this.hover) { this.hover = v; cx.notify(); } })
      .when(c.need, (x) => x.child(div().absolute().left(0).top(10).bottom(10).w(2).rounded(1).bg(C(t).status.blocked)))
      .when(dragging && this.moved, (x) => x.opacity(0.35))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.drag = { id: s.id, from: c.col }; this.moved = false; })
      .on_click(() => { if (this.moved) return; run("space.select", { id: s.id }); closeOverlay(this.overlay); })
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(div().w(16).flex_none().flex().justify_center().child(this.mark(t, c.mine)))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(name))
        .when(Boolean(c.pr), (x) => x.child(div().flex_none().text_size(11).text_color(prColor(c.pr, t)).tooltip(prTip(c.pr)).child(`#${c.pr.number}`)))
        .when(c.manual, (x) => x.child(div().id(`auto-${s.id}`).flex_none().size(18).flex().items_center().justify_center().rounded(4).hover((h) => h.bg(t.raised))
          .tooltip("You placed this card. Click to let it follow its agents and PR again.")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); this.setCol(s.id, null); cx.notify(); }).child(icon("rotate-ccw", 12, t.dim))))
        .when(hovered, (x) => x.child(div().id(`add-${s.id}`).flex_none().size(18).flex().items_center().justify_center().rounded(4)
          .hover((h) => h.bg(t.raised)).tooltip(`New agent in ${name}`)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); closeOverlay(this.overlay); openCommandBar({ folder: { space: s.id, name } }); })
          .child(icon("plus", 12, t.muted))))
        .when(c.pinned || hovered, (x) => x.child(div().id(`pin-${s.id}`).flex_none().size(18).flex().items_center().justify_center().rounded(4)
          .hover((h) => h.bg(t.raised)).tooltip(c.pinned ? "Unpin" : "Pin to the top of its column")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); this.setPinned(s.id, !c.pinned); cx.notify(); })
          .child(icon(c.pinned && hovered ? "pin-off" : "pin", 12, c.pinned ? t.foreground : t.dim)))))
      .when(c.need, (x) => x.child(h_flex().pl(22).child(statusMark(t, "blocked", { label: true }))))
      // Where it is and when something last happened.
      .when(Boolean(c.folder || branch || c.worktree || c.last), (x) => x.child(div().pl(22).truncate().text_size(11).text_color(t.dim)
        .child([c.folder, branch, c.worktree ? "worktree" : null, c.last ? `${ago(Date.now() - c.last)} ago` : null].filter(Boolean).join(" · "))))
      // What its agents are up to, in one line.
      .when(parts.length > 0, (x) => x.child(h_flex().pl(22).gap(8).flex_wrap().text_size(11)
        .children(parts.map((p) => div().text_color(p.color).child(`${p.n} ${p.label}`)))))
      .when(!c.mine.length, (x) => x.child(div().pl(22).text_size(11).text_color(t.dim).child("no agents")))
      .children(shown.map((a) => h_flex().pl(22).gap(6).items_center().min_w(0)
        .child(div().w(10).flex_none().flex().justify_center().child(this.agentMark(t, a)))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(a.status === "idle" ? t.muted : t.foreground).child(agentName(a) || a.program?.name || a.address))))
      .when(live.length > shown.length, (x) => x.child(div().pl(38).text_size(11).text_color(t.dim).child(`+${live.length - shown.length} more`)));
  }

  // By agent: one card per agent. Click goes to its terminal.
  agentCard(t, a, c) {
    const when = this.since[a.address];
    return v_flex().id(`acard-${a.address}`).relative().w_full().px(12).py(9).gap(3).rounded(8).cursor_pointer().flex_none()
      .bg(a.focused ? t.selected : t.surface).hover((x) => x.bg(t.hover))
      .when(a.status === "blocked" || a.status === "error", (x) => x.child(div().absolute().left(0).top(9).bottom(9).w(2).rounded(1).bg(C(t).status.blocked)))
      .on_click(() => { run("pane.focus", { pane: a.pane }); closeOverlay(this.overlay); })
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(div().w(16).flex_none().flex().justify_center().child(programIcon(a.program, 13, t.muted) ?? statusMark(t, a.status)))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(agentName(a) || a.program?.name || a.address))
        .child(div().flex_none().child(statusMark(t, a.status))))
      .child(div().pl(22).truncate().text_size(11).text_color(t.dim)
        .child([c?.folder, c ? spaceName(c.s.name) : null, c?.s.branch && c.s.branch !== "main" && c.s.branch !== "master" ? c.s.branch : null, when ? `${ago(Date.now() - when)} ago` : null].filter(Boolean).join(" · ")));
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
    const label = (c) => spaceName(c.s.name);
    const pick = (id) => (_e, cx) => { this.only = id; this.pickOpen = false; cx.notify(); };
    const row = (id, mark, text, right, on) => h_flex().id(`pk-${id ?? "all"}`).h(30).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).hover((e) => e.bg(t.hover)).on_click(pick(id))
      .child(div().w(16).flex_none().flex().justify_center().child(mark))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(text))
      .when(right != null, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(right)));
    const trigger = h_flex().id("bd-pick").w(260).h(36).px(10).gap(8).items_center().rounded(9).border_1()
      .border_color(this.pickOpen ? t.accent : t.input).bg(t.background).cursor_pointer()
      .child(div().w(16).flex_none().flex().justify_center().child(cur ? this.mark(t, cur.mine) : icon("layers", 14, t.dim)))
      .child(div().flex_1().min_w(0).truncate().text_size(12.8).text_color(cur ? t.foreground : t.muted).child(cur ? label(cur) : "All spaces"))
      .child(icon("chevron-down", 14, t.dim));
    const list = v_flex().id("bd-pick-list").w(260).mt(4).p(4).gap(1).rounded(9).border_1().border_color(t.border).bg(t.popover)
      .child(row(null, icon("layers", 12, t.dim), "All spaces", String(all.length), !cur))
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
      .child(h_flex().h(28).p(2).gap(2).flex_none().rounded(7).bg(t.background).border_1().border_color(t.border)
        .children([["space", "By space"], ["agent", "By agent"]].map(([id, label]) => div().id(`bd-mode-${id}`).h_full().px(10).flex().items_center().rounded(5).text_size(TS.body).cursor_pointer()
          .text_color(this.mode === id ? t.foreground : t.muted).when(this.mode === id, (e) => e.bg(t.selected).font_medium())
          .on_click((_e, cx) => { this.mode = id; localStorage.setItem("mode", id); cx.notify(); }).child(label))))
      .child(div().flex_1())
      .child(escChip(t, "bd-esc", () => closeOverlay(this.overlay)));
    const column = (col) => {
      const list = cards.filter((c) => c.col === col.id).sort((a, b) => (b.pinned - a.pinned) || (b.need - a.need) || (b.s.active - a.s.active));
      const st = C(t).status, dotC = col.id === "progress" ? st.working : col.id === "review" ? st.done : col.id === "done" ? t.accent : t.dim;
      const target = dragging && this.drag.from !== col.id;
      return this.zone(t, col.id, v_flex().id(`col-${col.id}`).w(COL_W).flex_none().h_full().gap(6)
        .child(h_flex().h(28).px(4).gap(8).items_center().flex_none()
          .child(div().size(7).rounded(4).bg(dotC))
          .child(div().text_size(13).font_semibold().text_color(t.foreground).child(col.name))
          .child(div().text_size(11).text_color(t.dim).child(String(list.length))))
        .child(v_flex().id(`colbody-${col.id}`).flex_1().min_h(0).gap(6).rounded(8).overflow_y_scrollbar()
          .when(target, (x) => x.p(4).border_1().border_dashed().border_color(this.over === col.id ? t.accent : t.input).when(this.over === col.id, (y) => y.bg(t.hover)))
          .children(list.map((c) => this.card(t, c)))));
    };
    if (this.mode === "agent") {
      const st = C(t).status;
      const mine = agents().filter((a) => !a.address.includes("/") && cards.some((c) => c.s.id === a.space));
      const cardOf = (a) => cards.find((c) => c.s.id === a.space);
      const inCol = (id) => mine.filter((a) => (id === "blocked" ? a.status === "blocked" || a.status === "error" : id === "idle" ? !["blocked", "error", "working", "done"].includes(a.status) : a.status === id))
        .sort((a, b) => (this.since[b.address] ?? 0) - (this.since[a.address] ?? 0));
      const acol = (col) => { const list = inCol(col.id);
        return v_flex().id(`acol-${col.id}`).w(COL_W).flex_none().h_full().gap(6)
          .child(h_flex().h(28).px(4).gap(8).items_center().flex_none()
            .child(div().size(7).rounded(4).bg(st[col.id] ?? t.dim))
            .child(div().text_size(13).font_semibold().text_color(t.foreground).child(col.name))
            .child(div().text_size(11).text_color(t.dim).child(String(list.length))))
          .child(v_flex().id(`acolbody-${col.id}`).flex_1().min_h(0).gap(6).overflow_y_scrollbar().children(list.map((a) => this.agentCard(t, a, cardOf(a))))); };
      return v_flex().id("board").size_full().p(18).gap(14).bg(t.popover).text_size(13).text_color(t.foreground)
        .child(head)
        .child(h_flex().flex_1().min_h(0).gap(COL_GAP).children(AGENT_COLS.flatMap((c, i) => i ? [div().w(1).h_full().flex_none().bg(t.border), acol(c)] : [acol(c)])));
    }
    return v_flex().id("board").size_full().p(18).gap(14).bg(t.popover).text_size(13).text_color(t.foreground)
      .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.drag = null; this.over = null; cx.notify(); } })
      .child(head)
      .child(h_flex().flex_1().min_h(0).gap(COL_GAP).children(COLS.flatMap((c, i) => i ? [div().w(1).h_full().flex_none().bg(t.border), column(c)] : [column(c)])));
  }
}
