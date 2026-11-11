// Agent board: every agent as a card in Needs you / Idle / Working / Done columns, showing what it
// is doing right now (./live.py reads transcript tails), the task you gave it, context and cost.
// Click a card to focus that agent; props.open_layout (optional) also switches layout, e.g. "pair".
// "Spaces ▾" opens mods/agent-board-picker (props.picker_mod to use another); the selection lives in
// shared state "agent-board.filter": "all" | "current" | { spaces: [ids] }.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, agents, panes, spaces, focused, props, run, theme, shared, setShared, terminals, openOverlay } from "herdr";
import { folderOf, loadFolders } from "./folders.js";
import { agentName } from "./agentname.js";
import { TS } from "./ui.js";

// Workflow order, left to right: waiting on you -> not started / idle -> in progress -> finished.
const COLUMNS = [
  { status: "blocked", label: "Needs you" },
  { status: "idle", label: "Idle" },
  { status: "working", label: "Working" },
  { status: "done", label: "Done" },
];
const RANK = { blocked: 0, error: 0, idle: 1, working: 2, done: 3 };
const norm = (s) => (s === "error" ? "blocked" : s);
const since = (ms) => { const s = ms / 1000; return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };
const spaceLabel = (name) => (name === "~" ? "~ Home" : name || "~ Home");

const FILTER = "agent-board.filter";
const getFilter = () => { const f = shared(FILTER); return f === "current" || (f && Array.isArray(f.spaces)) ? f : "all"; };
const setFilter = (f) => setShared(FILTER, f);

function statusDots(t, items) {
  const counts = {};
  for (const a of items) counts[norm(a.status)] = (counts[norm(a.status)] ?? 0) + 1;
  return h_flex().gap(8).items_center().children(COLUMNS.map((c) => c.status).filter((s) => counts[s]).map((s) =>
    h_flex().gap(4).items_center().child(div().w(6).h(6).rounded(3).bg(t[s] ?? t.dim)).child(div().text_size(TS.small).text_color(t.dim).child(String(counts[s])))));
}

export default class AgentBoard extends View {
  init(_props, cx) {
    this.folders = { list: [], of: {} };
    cx.spawn(async (cx) => { this.folders = await loadFolders(); cx.notify(); });
    this.live = {};
    this.hideIdle = localStorage.getItem("hideIdle") === "1";
    this.changed = (() => { try { return JSON.parse(localStorage.getItem("changed") ?? "{}"); } catch { return {}; } })();
    this.poll(cx);
    cx.timer.every(3000, (cx) => this.poll(cx));
    cx.timer.every(15000, (cx) => cx.spawn(async (cx) => { this.folders = await loadFolders(); cx.notify(); }));
  }

  poll(cx) {
    if (this.busy) return;
    const list = agents().filter((a) => !a.address.includes("/")).map((a) => a.address);
    if (!list.length) { this.live = {}; return; }
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [appHome() + "/mods/agent-board/live.py", ...list], { timeout: 20000 });
        const next = JSON.parse(r.stdout || "{}");
        if (JSON.stringify(next) !== JSON.stringify(this.live)) { this.live = next; cx.notify(); }
      } catch {}
      this.busy = false;
    });
  }

  track(list, now) {
    let dirty = false;
    for (const a of list) {
      if (this.changed[a.address]?.s === a.status) continue;
      this.changed[a.address] = { s: a.status, at: now };
      dirty = true;
    }
    if (dirty) localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // ---------- shared: spaces that have agents, grouped by folder ----------
  groups(everyone) {
    const ps = panes();
    const list = this.folders?.list ?? [];
    const sp = spaces().filter((s) => everyone.some((a) => a.space === s.id));
    const urgency = (s) => Math.min(...everyone.filter((a) => a.space === s.id).map((a) => RANK[a.status] ?? 9));
    const folders = list.map((f) => ({ folder: f, spaces: [] }));
    const loose = [];
    for (const s of sp) {
      const fid = folderOf(s, this.folders, ps);
      const g = folders.find((x) => x.folder.id === fid);
      (g ? g.spaces : loose).push(s);
    }
    for (const g of folders) g.spaces.sort((a, b) => urgency(a) - urgency(b));
    loose.sort((a, b) => urgency(a) - urgency(b));
    return { folders: folders.filter((g) => g.spaces.length), loose, all: sp };
  }

  filtered(everyone) {
    const f = getFilter();
    if (f === "all") return everyone;
    if (f === "current") { const cur = focused()?.space; return everyone.filter((a) => a.space === cur); }
    const ids = new Set(f.spaces);
    return everyone.filter((a) => ids.has(a.space));
  }

  filterLabel(everyone) {
    const f = getFilter();
    if (f === "all") return "All spaces";
    if (f === "current") return `Current · ${spaceLabel(spaces().find((s) => s.id === focused()?.space)?.name)}`;
    const ids = new Set(f.spaces);
    const { folders } = this.groups(everyone);
    const whole = folders.filter((g) => g.spaces.every((s) => ids.has(s.id)));
    const covered = new Set(whole.flatMap((g) => g.spaces.map((s) => s.id)));
    const rest = f.spaces.filter((id) => !covered.has(id));
    const names = [...whole.map((g) => g.folder.name), ...rest.map((id) => spaceLabel(spaces().find((s) => s.id === id)?.name))];
    return names.length <= 2 ? names.join(", ") || "No spaces" : `${names.length} selected`;
  }

  // ---------- board ----------
  icon(t, prog) {
    if (!prog?.icon) return div().w(14).h(14).rounded(3).bg(prog?.tile ?? t.border);
    return prog.tint ? svg(prog.icon).size(14).text_color(prog.color ?? t.foreground) : image(prog.icon).size(14);
  }

  doing(t, a, l) {
    if (!l) return [t.dim, "…"];
    if (l.program) return [t.dim, l.program];
    if (a.status === "blocked") {
      if (l.tool?.name === "AskUserQuestion") return [t.blocked, `? ${l.tool.target}`];
      if (l.tool) return [t.blocked, `Needs approval · ${l.tool.name}${l.tool.target ? `: ${l.tool.target}` : ""}`];
      return [t.blocked, l.text ?? "Waiting for you"];
    }
    if (a.status === "working") {
      if (l.tool) return [t.working, `▶ ${l.tool.name}${l.tool.target ? ` · ${l.tool.target}` : ""}`];
      return [t.working, l.text ? `✎ ${l.text}` : "Thinking…"];
    }
    return [t.muted, l.text ? `✓ ${l.text}` : l.tool ? `✓ last: ${l.tool.name}` : "—"];
  }

  card(t, a, now) {
    const l = this.live[a.address];
    const pane = panes().find((p) => p.terminal === a.address);
    const project = (pane?.cwd ?? l?.cwd ?? "").split("/").filter(Boolean).pop() ?? "";
    const where = [spaceLabel(a.space_name), project !== a.space_name ? project : null, pane?.branch].filter(Boolean).join(" · ");
    const [dc, dt] = this.doing(t, a, l);
    const ctx = l?.ctx;
    const ctxColor = ctx >= 80 ? t.blocked : ctx >= 60 ? t.working : t.accent;
    const openLayout = props()?.open_layout;
    // Team role (members started with an hc template) or team size (leads with live members).
    const VENDOR = { claude: "Claude", codex: "Codex", grok: "Grok", cursor: "Cursor", gemini: "Gemini" };
    const tm = /^(.+)-(claude|codex|grok|cursor|gemini)$/.exec(l?.template ?? "");
    const lead = l?.parent ? agents().find((x) => x.address === l.parent) : null;
    let kids = 0;
    try { kids = (terminals() ?? []).filter((x) => x.parent === a.address && x.state !== "finished").length; } catch {}
    const roleChip = tm ? `${tm[1]} · ${VENDOR[tm[2]]}${lead ? ` · for ${agentName(lead)}` : ""}` : kids ? `lead · team of ${kids}` : null;
    return v_flex().id(`card-${a.address}`).mx(6).mb(6).px(10).py(8).gap(4).rounded(8)
      .bg(a.focused ? t.selected : t.surface).border(1).border_color(norm(a.status) === "blocked" ? t.blocked : t.border)
      .cursor_pointer().hover((s) => s.border_color(t.input))
      .on_click(() => { run("pane.focus", { pane: a.pane }); if (openLayout) run("layout.switch", { name: openLayout }); })
      .tooltip(openLayout ? "Open this agent" : "Focus this agent")
      .child(h_flex().gap(6).items_center()
        .child(this.icon(t, a.program))
        .child(div().flex_1().min_w(0).truncate().text_size(TS.item).font_semibold().text_color(t.foreground).child(agentName(a) || a.program?.name || a.address))
        .child(div().flex_none().text_size(TS.small).text_color(t.dim).child(since(now - (this.changed[a.address]?.at ?? now)))))
      .when(Boolean(where), (el) => el.child(div().truncate().text_size(TS.small).text_color(t.dim).child(where)))
      .when(Boolean(roleChip), (el) => el.child(h_flex().child(div().id(`role-${a.address}`).max_w_full().truncate().px(6).rounded(8).border_1().border_color(t.accent)
        .text_size(TS.tiny).text_color(t.accent).tooltip(kids && !tm ? "Open the Team map" : "Team role")
        .when(kids > 0 && !tm, (x) => x.cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "agent-team", kind: "window", key: `team-map-${a.address}`, width: 1000, height: 660, props: { lead: a.address } }); }))
        .child(roleChip))))
      .when(Boolean(l?.task), (el) => el.child(div().truncate().text_size(TS.meta).text_color(t.muted).child(`${l?.parent ? "Lead" : "You"}: ${l.task}`)))
      .child(div().text_size(TS.meta).text_color(dc).child(dt))
      .when(ctx != null || l?.cost != null, (el) => el.child(h_flex().gap(6).items_center().pt(2)
        .when(ctx != null, (el) => el
          .child(div().w(54).h(4).rounded(2).bg(t.border).child(div().h(4).rounded(2).bg(ctxColor).w(Math.max(1, Math.round(54 * Math.min(ctx, 100) / 100)))))
          .child(div().text_size(TS.small).text_color(ctx >= 60 ? ctxColor : t.dim).child(`${Math.round(ctx)}%`)))
        .child(div().flex_1())
        .when(l?.cost != null, (el) => el.child(div().text_size(TS.small).text_color(t.dim).child(`$${l.cost.toFixed(2)}`)))));
  }

  render() {
    const t = theme();
    const now = Date.now();
    const everyone = agents();
    this.track(everyone, now);
    const list = this.filtered(everyone).filter((a) => !(this.hideIdle && a.status === "idle"));
    const recent = (a, b) => (b.pinned - a.pinned) || (this.changed[b.address]?.at ?? 0) - (this.changed[a.address]?.at ?? 0);
    const f = getFilter();
    const pill = (id, label, on, onClick, tip) => div().id(id).px(9).py(2).rounded(6).cursor_pointer().text_size(TS.meta)
      .border(1).border_color(on ? t.accent : t.border).text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected))
      .hover((s) => s.text_color(t.foreground)).tooltip(tip).on_click(onClick).child(label);
    const bar = h_flex().px(6).h(32).flex_none().gap(8).items_center()
      .child(div().text_size(TS.body).font_semibold().text_color(t.foreground).child("Agents"))
      .child(div().text_size(TS.meta).text_color(t.dim).child(f === "all" ? String(everyone.length) : `${list.length} / ${everyone.length}`))
      .child(statusDots(t, list))
      .child(div().flex_1())
      .child(pill("flt-spaces", `${this.filterLabel(everyone)}  ▾`, f !== "all",
        () => run("mod.open", { name: props()?.picker_mod ?? "agent-board-picker" }),
        "Choose which spaces the board shows"))
      .when(f !== "all", (el) => el.child(pill("flt-clear", "×", false, () => setFilter("all"), "Show all spaces")))
      .child(pill("flt-idle", "Hide idle", this.hideIdle, (_e, cx) => { this.hideIdle = !this.hideIdle; localStorage.setItem("hideIdle", this.hideIdle ? "1" : "0"); cx.notify(); }, "Hide agents that are idle"));
    const board = h_flex().id("board-cols").flex_1().min_h(0).gap(6).items_start()
      .children(COLUMNS.map((col) => {
        const items = list.filter((a) => norm(a.status) === col.status).sort(recent);
        return v_flex().id(`col-${col.status}`).flex_1().min_w(0).h_full().rounded(10).bg(t.chrome).border(1).border_color(t.border)
          .child(h_flex().px(12).h(34).flex_none().gap(6).items_center()
            .child(div().w(7).h(7).rounded(4).bg(t[col.status] ?? t.dim))
            .child(div().text_size(TS.body).font_semibold().text_color(t.foreground).child(col.label))
            .child(div().text_size(TS.meta).text_color(t.dim).child(String(items.length))))
          .child(v_flex().id(`colbody-${col.status}`).flex_1().min_h(0).pt(2).overflow_y_scrollbar()
            .children(items.length ? items.map((a) => this.card(t, a, now)) : [div().px(12).py(6).text_size(TS.meta).text_color(t.dim).child("—")]));
      }));
    const empty = !list.length ? div().p(16).text_size(TS.body).text_color(t.dim).child(f === "current" ? "No agents in the selected space." : "No agents match this filter.") : null;
    return v_flex().id("agent-board").size_full().bg(t.canvas).p(6).gap(4).child(bar).child(empty ?? board);
  }
}
