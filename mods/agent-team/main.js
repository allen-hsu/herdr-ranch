// Agent team: who works with the focused agent, and what they said to each other.
//   Herdr agents  terminals it started with `hc run` (Claude Code, Codex, Grok, Cursor, Gemini...): status,
//                 what each is doing, messages each way; click to jump there
//   Subagents     Claude Code subagents (Agent tool) inside its session
//   Sessions      other Claude sessions it messaged (SendMessage over a socket)
//   Timeline      spawns, its messages, replies, completion notices (newest first)
// Data: ./team.py (local files + hc). Refreshes every 5 s while shown.
// Opened as an overlay (mod.open agent-team, or openOverlay with props {lead}) it is the Team Map: a sequence
// diagram — one column per agent with a status card, each message an arrow between columns.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Popover } from "gpui-base";
import { exec, appHome, focused, agents, theme, run, props, closeOverlay, openOverlay } from "herdr";
import { NewTeam } from "./newteam.js";
import { agentName } from "./agentname.js";
import { TS, SPACE, C, tint, escChip, dialogTitle, icon, statusMark } from "./ui.js";

const clock = (t) => {
  if (!t) return "";
  const d = new Date(t * 1000), hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()}`;
};
const k = (n) => (n == null ? "" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const since = (t) => { if (!t) return ""; const s = Date.now() / 1000 - t; return s < 60 ? "now" : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
const ago = (t) => { const s = since(t); return !s ? "" : s === "now" ? "just now" : `${s} ago`; };
const hhmm = (t) => { const d = new Date(t * 1000); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
// Team Map timeline ranges (secs null: the whole team run).
const RANGES = [{ id: "10m", name: "10m", secs: 600 }, { id: "1h", name: "1h", secs: 3600 }, { id: "all", name: "All", secs: null }];
// The first lines of a reply, for the drawer: markdown marks dropped, cut at about three lines (CJK counts double).
const excerpt = (text, room = 165) => {
  const s = String(text ?? "").replace(/[*`#]+/g, "").replace(/\s+/g, " ").trim();
  let w = 0, i = 0;
  for (const ch of s) { w += ch.codePointAt(0) > 0x2e7f ? 2 : 1; if (w > room) break; i += ch.length; }
  return i < s.length ? `${s.slice(0, i).trimEnd()}…` : s;
};
const AGENT = { "claude-code": "Claude Code", codex: "Codex", grok: "Grok", "cursor-agent": "Cursor", cursor: "Cursor", gemini: "Gemini", pi: "pi", opencode: "OpenCode" };

export default class AgentTeam extends View {
  init(_props, cx) {
    this.addr = null; this.data = null; this.open = new Set(); this.showDone = false;
    const p = props() ?? {};
    if (p.view === "new") { this.form = new NewTeam(p, cx); return; }
    this.map = Boolean(p.overlay);
    this.overlay = p.overlay;
    this.pinned = p.lead ?? null; // map: the lead it shows (null: follow the focused agent)
    this.sel = p.sel ?? null; // a member to select on open (e.g. from the sidebar)
    this.range = "all"; // map: the timeline range, see RANGES
    this.teams = null; // map: every lead that has a team (from team.py --teams), for the picker
    this.w = 980;
    this.load(cx);
    cx.timer.every(5000, (cx) => this.load(cx));
  }

  target() {
    if (this.map && this.pinned) return this.pinned;
    const f = focused();
    return f?.agent ?? (agents().some((a) => a.address === f?.terminal) ? f.terminal : null);
  }

  load(cx) {
    const addr = this.target();
    if (!addr && !this.map) return; // the map still lists the teams with no agent focused
    if (this.busy && addr === this.addr) return;
    if (addr !== this.addr) { this.addr = addr; this.data = null; this.lastOut = null; this.open = new Set(); }
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [appHome() + "/mods/agent-team/team.py", ...(addr ? [addr] : []), ...(this.map ? ["--teams"] : [])], { timeout: 30000 });
        if (addr === this.addr && r.stdout && r.stdout === this.lastOut) { this.busy = false; return; } // nothing new: no redraw
        if (addr === this.addr) this.lastOut = r.stdout;
        const d = r.stdout ? JSON.parse(r.stdout) : { ok: false, error: (r.stderr || "no output").trim().split("\n").pop() };
        if (addr === this.addr) { this.data = d; if (d.teams) this.teams = d.teams; }
      } catch (e) { if (addr === this.addr) this.data = { ok: false, error: String(e.message ?? e) }; }
      this.busy = false;
      cx.notify();
    });
  }

  h(t, title, right) {
    return h_flex().px(SPACE.dialog).pt(14).pb(6).gap(6).items_center().text_size(11).font_semibold()
      .child(div().text_color(t.dim).child(title)).child(div().flex_1())
      .when(right != null, (el) => el.child(div().text_color(t.dim).child(String(right))));
  }
  note(t, s) { return div().px(SPACE.dialog).py(4).text_size(TS.small).text_color(t.dim).child(s); }
  // Finished members show as done; live ones by their own status.
  dot(t, m) { return statusMark(t, m.state === "finished" ? "done" : m.status); }
  doing(m) {
    if (m.state === "finished") return m.exit != null && m.exit !== 0 ? `exited ${m.exit}` : "finished";
    if (m.tool) return `${m.tool.name}${m.tool.target ? ` · ${m.tool.target}` : ""}`;
    return m.text || m.task || m.program || m.title || "";
  }
  msgs(t, m) {
    const s = [m.msgs_to ? `→${m.msgs_to}` : "", m.msgs_from ? `←${m.msgs_from}` : ""].filter(Boolean).join(" ");
    return s ? div().flex_none().text_size(TS.tiny).text_color(t.muted).tooltip(`${m.msgs_to || 0} sent to it · ${m.msgs_from || 0} from it`).child(s) : null;
  }

  member(t, m, i, kind) {
    const live = agents().find((a) => a.address === m.id);
    const prog = live?.program;
    const pic = prog?.icon ? (prog.tint ? svg(prog.icon).size(14).text_color(prog.color ?? t.foreground) : image(prog.icon).w(14).h(14)) : null;
    const who = kind === "herdr" ? `${AGENT[m.agent] ?? m.agent ?? "program"}${m.template ? ` · ${m.template}` : ""}` : `${m.type ?? "subagent"}${m.background ? " · background" : ""}`;
    const right = [m.ctx != null ? `${Math.round(m.ctx)}%` : "", m.out ? `${k(m.out)} out` : ""].filter(Boolean).join(" · ");
    const jump = kind === "herdr" && m.state === "live";
    return h_flex().id(`tm-${kind}-${i}`).px(SPACE.dialog).py(6).gap(8).items_start().pl(14 + ((m.depth ?? 1) - 1) * 14)
      .when(jump, (e) => e.cursor_pointer().hover((x) => x.bg(t.hover)).tooltip("Go to this agent").on_click(() => run("agent.focus", { terminal: m.id })))
      .child(div().w(14).flex_none().mt(2).flex().justify_center().child(this.dot(t, m)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(6).items_center().min_w(0)
          .when(Boolean(pic), (e) => e.child(pic))
          .child(div().flex_1().min_w(0).truncate().text_size(TS.body).text_color(m.state === "finished" ? t.muted : t.foreground).child(m.name))
          .when(Boolean(this.msgs(t, m)), (e) => e.child(this.msgs(t, m))))
        .child(div().truncate().text_size(TS.tiny).text_color(t.dim).child(`${who}${right ? ` · ${right}` : ""}${m.started ? ` · ${since(m.started)}` : ""}`))
        .child(div().truncate().text_size(TS.small).text_color(m.status === "blocked" ? C(t).status.blocked : t.muted).child(this.doing(m))));
  }

  event(t, e, i) {
    const glyph = { spawn: "✦", to: "→", from: "←", note: "✓", "hc-run": "✦", "hc-send": "→" }[e.k] ?? "·";
    const st = C(t).status;
    const color = e.k === "from" ? t.accent : e.k === "note" ? (e.status === "completed" ? st.done : t.dim) : e.k.startsWith("hc") || e.k === "spawn" ? st.working : t.muted;
    const via = e.via === "herdr" ? "Herdr" : e.via === "session" ? "session" : e.via === "sub" ? "subagent" : "";
    const what = e.k === "spawn" ? `started ${e.agent ?? "subagent"}${e.bg ? " (background)" : ""}` : e.k === "hc-run" ? "started in Herdr" : "";
    return h_flex().id(`te-${i}`).px(SPACE.dialog).py(4).gap(6).items_start().text_size(TS.small)
      .tooltip(`${clock(e.at)} ${glyph} ${e.name ?? e.who ?? ""} (${via})${e.times ? ` ×${e.times}` : ""}\n${e.text}`)
      .child(div().flex_none().w(34).text_color(t.dim).child(clock(e.at)))
      .child(div().flex_none().w(10).mt(1).text_color(color).child(e.k === "note" ? icon("check", 10, color) : glyph))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(4).min_w(0)
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(String(e.name ?? e.who ?? "?")))
          .when(Boolean(e.times), (x) => x.child(div().flex_none().text_color(t.dim).child(`×${e.times}`))))
        .child(div().truncate().text_color(t.muted).child(what || e.text || "")));
  }

  body(t) {
    const d = this.data;
    const note = (s) => [div().p(16).text_size(TS.body).text_color(t.dim).child(s)];
    if (!this.addr) return note("Select an agent to see its team.");
    if (!d) return note("Reading…");
    if (!d.ok) return note(`Unavailable: ${d.error}`);
    const herdr = d.herdr ?? [], subs = d.subs ?? [];
    const running = subs.filter((s) => s.state !== "finished");
    const out = [v_flex().px(SPACE.dialog).pt(12).gap(2)
      .child(div().text_size(TS.item).font_semibold().text_color(t.foreground).truncate().child(d.lead?.name ?? this.addr))
      .child(div().text_size(TS.small).text_color(t.dim).child(`${herdr.length} Herdr agent${herdr.length === 1 ? "" : "s"} · ${subs.length} subagent${subs.length === 1 ? "" : "s"}${running.length ? ` (${running.length} running)` : ""} · ${(d.sessions ?? []).length} session${(d.sessions ?? []).length === 1 ? "" : "s"}`))];
    if (!herdr.length && !subs.length && !(d.events ?? []).length) {
      out.push(this.note(t, "No teammates yet. They show up here when this agent starts others — any CLI through Herdr (hc run --bg codex \"…\"), or Claude Code subagents."));
      return out;
    }
    out.push(this.h(t, "Herdr agents", herdr.length || null));
    if (!herdr.length) out.push(this.note(t, d.lead?.claude ? "None started through Herdr (hc run)." : "None."));
    herdr.forEach((m, i) => out.push(this.member(t, m, i, "herdr")));
    if (subs.length) {
      const done = subs.filter((s) => s.state === "finished");
      out.push(this.h(t, "Subagents", running.length ? `${running.length} running · ${done.length} done` : `${done.length} done`));
      const shown = [...running].reverse().concat(this.showDone ? [...done].reverse() : [...done].reverse().slice(0, Math.max(0, 6 - running.length)));
      shown.forEach((m, i) => out.push(this.member(t, m, i, "sub")));
      const hidden = subs.length - shown.length;
      if (hidden > 0 || this.showDone) out.push(div().id("tm-more").px(SPACE.dialog).py(4).text_size(TS.small).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { this.showDone = !this.showDone; cx.notify(); }).child(this.showDone ? "Show fewer" : `Show ${hidden} more finished`));
    }
    if ((d.sessions ?? []).length) {
      out.push(this.h(t, "Sessions", d.sessions.length));
      d.sessions.forEach((s, i) => out.push(h_flex().id(`ts-${i}`).px(SPACE.dialog).py(4).gap(8).text_size(TS.meta).child(div().flex_none().flex().items_center().child(icon("arrow-left-right", 12, t.accent))).child(div().truncate().text_color(t.foreground).child(s.name))));
    }
    out.push(this.h(t, "Timeline", (d.events ?? []).length ? "newest first" : null));
    if (!(d.events ?? []).length) out.push(this.note(t, "No messages yet."));
    (d.events ?? []).slice(0, 60).forEach((e, i) => out.push(this.event(t, e, i)));
    out.push(this.note(t, "→ the lead's message · ← a reply · ✦ started · ✓ finished/notice. Hover a line for the full text."));
    return out;
  }

  // ---------- Team Map (sequence diagram) ----------
  columns(d) {
    const leadAgent = agents().find((x) => x.address === d.lead?.id);
    const cols = [{ key: "lead", ids: [d.lead?.id, "lead"], name: (leadAgent && agentName(leadAgent)) || d.lead?.name || this.addr, vendor: AGENT[d.lead?.agent === "claude" ? "claude-code" : d.lead?.agent] ?? d.lead?.agent ?? "",
      status: d.lead?.status?.state ?? "idle", state: "live", doing: d.lead?.status?.msg ?? "", lead: true, addr: d.lead?.id }];
    // A member restarted under the same name (e.g. a checker) is one column: keep the newest.
    const byName = new Map();
    for (const m of d.herdr ?? []) { const o = byName.get(m.name); if (!o || (m.started ?? 0) > (o.started ?? 0)) byName.set(m.name, m); }
    const herdr = [...byName.values()].sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
    const subs = [...(d.subs ?? [])].sort((a, b) => (a.state === "finished" ? 1 : 0) - (b.state === "finished" ? 1 : 0) || (b.last ?? 0) - (a.last ?? 0));
    const recent = new Set((d.events ?? []).slice(0, 40).map((e) => e.who));
    const pool = [...herdr, ...subs.filter((s) => s.state !== "finished" || recent.has(s.id)),
      ...(d.sessions ?? []).map((s) => ({ id: s.id, name: s.name, agent: "session", state: "live", status: "idle", kind: "session", addr: s.addr }))];
    for (const m of pool.slice(0, 7)) cols.push({ key: m.id, ids: [m.id, m.name], name: m.name, vendor: m.kind === "session" ? "Claude session" : m.kind === "sub" ? `subagent · ${m.type ?? ""}` : `${AGENT[m.agent] ?? m.agent ?? ""}${m.role ? ` · ${m.role}` : ""}`,
      status: m.status, state: m.state, doing: m.state === "finished" ? (m.role ? `${m.role} · finished` : "finished") : this.doing(m), addr: m.kind === "herdr" && m.state === "live" ? m.id : m.kind === "session" ? m.addr : null,
      out: m.out, ctx: m.ctx, m });
    if (pool.length > 7) cols.push({ key: "others", ids: [], name: `${pool.length - 7} more`, vendor: "", status: "idle", state: "finished", doing: "", others: true });
    return cols;
  }

  card(t, c, i, w) {
    const sel = this.sel === c.key;
    return v_flex().id(`mc-${i}`).w(w).h(84).flex_none().px(8).py(6).gap(1).rounded(8)
      .bg(sel ? t.selected ?? t.raised : t.surface).cursor_pointer().when(!sel, (e) => e.hover((x) => x.bg(t.hover)))
      .tooltip(sel ? "Click again to close details" : "Details")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { this.sel = sel ? null : c.key; cx.notify(); })
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(statusMark(t, c.state === "finished" ? "done" : c.status))
        .child(div().flex_1().min_w(0).truncate().text_size(TS.body).font_semibold().text_color(t.foreground).child(c.name)))
      .child(div().truncate().text_size(TS.tiny).text_color(t.dim).child(c.lead ? `lead · ${c.vendor}` : c.vendor))
      .child(div().truncate().text_size(TS.small).text_color(c.status === "blocked" ? C(t).status.blocked : t.muted).child(c.doing || (c.state === "finished" ? "finished" : "")));
  }

  // ---------- Team Map: timeline lanes + a drawer ----------
  // Section label, the same style as ui.js heading(): 11 semibold dim, sentence case.
  label(t, text) { return div().flex_none().text_size(11).font_semibold().text_color(t.dim).child(text); }
  leadName(id, fallback) { return agentName(agents().find((x) => x.address === id)) || fallback || id; }
  // Show one lead's team (null: follow the focused agent again).
  pick(id, cx) { this.pinned = id; this.pickOpen = false; this.closed = false; this.load(cx); cx.notify(); }
  newTeam(t, id, primary = false) {
    return h_flex().id(id).h(28).px(10).gap(6).items_center().flex_none().rounded(7).text_size(TS.body).cursor_pointer()
      .when(primary, (e) => e.bg(t.accent).text_color(C(t).on.accent))
      .when(!primary, (e) => e.text_color(t.foreground).border_1().border_color(t.border).hover((x) => x.bg(t.hover)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => openOverlay({ mod: "team-launch", kind: "dialog", width: 560, height: 228, props: {} }))
      .child(icon("plus", 14, primary ? C(t).on.accent : t.dim)).child("New team…");
  }

  // Header dropdown: follow the focused agent (default), or stay on one team.
  teamPicker(t, teams) {
    const cur = this.addr, team = teams.find((x) => x.id === cur), agent = agents().find((a) => a.address === cur);
    const stop = (_e, cx) => cx.stop_propagation();
    const row = (id, mark, text, right, on) => h_flex().id(`tp-${id ?? "follow"}`).h(30).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).hover((e) => e.bg(t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => this.pick(id, cx))
      .child(div().w(16).flex_none().flex().justify_center().child(mark))
      .child(div().flex_1().min_w(0).truncate().text_size(TS.item).text_color(t.foreground).child(text))
      .when(right != null, (e) => e.child(div().flex_none().text_size(TS.small).text_color(t.dim).child(right)));
    const trigger = h_flex().id("mp-pick").w(260).h(28).px(8).gap(8).items_center().rounded(7).border_1()
      .border_color(this.pickOpen ? t.accent : t.input).bg(t.background).cursor_pointer()
      .child(div().w(16).flex_none().flex().justify_center().child(cur ? statusMark(t, agent?.status ?? team?.status ?? "none") : icon("users", 12, t.dim)))
      .child(div().flex_1().min_w(0).truncate().text_size(TS.body).text_color(cur ? t.foreground : t.muted).child(cur ? this.leadName(cur, this.data?.lead?.name ?? team?.name) : "No agent focused"))
      .when(!this.pinned, (e) => e.child(div().flex_none().text_size(TS.small).text_color(t.dim).child("focused")))
      .child(icon("chevron-down", 14, t.dim));
    const list = v_flex().id("mp-pick-list").w(300).max_h(420).mt(4).p(4).gap(1).rounded(9).border_1().border_color(t.border).bg(t.popover).overflow_y_scrollbar()
      .child(row(null, icon("circle-dot", 12, this.pinned ? t.dim : t.accent), "Follow the focused agent", null, !this.pinned))
      .child(div().h(1).mx(4).my(3).flex_none().bg(t.border))
      .when(!teams.length, (e) => e.child(div().px(8).py(6).text_size(TS.meta).text_color(t.dim).child("No teams yet")))
      .children(teams.map((x) => row(x.id, statusMark(t, agents().find((a) => a.address === x.id)?.status ?? x.status), this.leadName(x.id, x.name),
        `${x.members} member${x.members === 1 ? "" : "s"}`, this.pinned === x.id)));
    // The wrapper keeps a press on the dropdown from dragging the window.
    return div().id("mp-pick-wrap").flex_none().on_mouse_down("left", stop)
      .child(Popover.new("mp-team").open(Boolean(this.pickOpen)).on_open_change((o, cx) => { this.pickOpen = o; cx.notify(); }).trigger(trigger).content(list));
  }

  // The current agent has no team: the teams to pick from, or what a team is when there are none.
  noTeam(t, teams, who) {
    if (!teams.length) return v_flex().flex_1().min_h(0).items_center().justify_center().gap(12).pb(40)
      .child(icon("users", 16, t.dim))
      .child(div().max_w(440).text_center().text_size(TS.body).text_color(t.muted)
        .child("A team is a lead agent plus the agents and sub-agents it starts. Its map shows when each one ran and what they said to each other."))
      .child(this.newTeam(t, "mp-new-empty", true));
    const row = (x, i) => {
      const a = agents().find((y) => y.address === x.id);
      return h_flex().id(`tl-${i}`).h(44).px(SPACE.card).gap(10).items_center().flex_none().rounded(8).bg(t.surface).cursor_pointer().hover((e) => e.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.pick(x.id, cx))
        .child(div().w(16).flex_none().flex().justify_center().child(statusMark(t, a?.status ?? x.status)))
        .child(div().flex_1().min_w(0).truncate().text_size(TS.item).text_color(t.foreground).child(this.leadName(x.id, x.name)))
        .child(div().flex_none().text_size(TS.meta).text_color(t.muted).child(`${x.members} member${x.members === 1 ? "" : "s"}`))
        .child(div().w(96).flex_none().text_right().text_size(TS.meta).text_color(t.dim).child(x.started ? `started ${ago(x.started)}` : ""))
        .child(icon("chevron-right", 12, t.dim));
    };
    return v_flex().flex_1().min_w(0).h_full().px(SPACE.dialog).pb(SPACE.dialog).gap(4)
      .child(div().pb(8).text_size(TS.body).text_color(t.muted).child(who ? `${who} has no team yet. Pick a team to see its map.` : "No agent is focused. Pick a team to see its map."))
      .child(h_flex().h(24).gap(6).items_center().flex_none().child(this.label(t, "Teams")).child(div().text_size(11).text_color(t.dim).child(String(teams.length))))
      .child(v_flex().id("mp-teams").flex_1().min_h(0).gap(4).overflow_y_scrollbar().children(teams.map(row)));
  }

  mapView(t) {
    const d = this.data, teams = this.teams ?? [];
    const PADX = SPACE.dialog, DRAWER = 376;
    const note = (s) => div().px(PADX).py(8).text_size(TS.body).text_color(t.dim).child(s);
    const head = h_flex().h(52).px(PADX).gap(12).items_center().flex_none()
      .child(dialogTitle(t, "Team map"))
      .child(this.teamPicker(t, teams))
      .child(div().flex_1())
      .child(this.newTeam(t, "mp-new"))
      .child(escChip(t, "mp-close", () => closeOverlay(this.overlay)));
    const root = v_flex().id("team-map").size_full().bg(t.popover ?? t.chrome).text_color(t.foreground)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.w) > 4) { this.w = size.width; cx.notify(); } }).child(head);
    if (!d) return root.child(note("Reading…"));
    if (!d.ok) return root.child(note(`Unavailable: ${d.error}`));
    const rows = d.lead ? this.members(d) : [];
    if (rows.length < 2) return root.child(h_flex().flex_1().min_h(0)
      .child(this.noTeam(t, teams.filter((x) => x.id !== this.addr), rows[0]?.name))
      .when(Boolean(rows[0]) && teams.some((x) => x.id !== this.addr), (e) => e.child(this.drawer(t, d, rows[0], false))));
    if (!rows.some((c) => c.key === this.sel)) this.sel = (rows.find((c) => !c.lead && c.state !== "finished") ?? rows[rows.length - 1])?.key ?? null;
    const selCol = this.closed ? null : rows.find((c) => c.key === this.sel);
    const now = Date.now() / 1000;
    const evs = d.events ?? [];
    // The range: the whole team run (first member start → now, or the last activity once all finished), or its last 10m / 1h.
    const times = [...rows.map((c) => c.start).filter(Boolean), ...evs.map((e) => e.at).filter(Boolean)];
    const first = times.length ? Math.min(...times) : now - 600;
    const live = rows.some((c) => !c.lead && c.state !== "finished");
    const end = live ? now : Math.max(first, ...rows.map((c) => c.end ?? c.start ?? first), ...evs.map((e) => e.at ?? first));
    const win = RANGES.find((r) => r.id === this.range)?.secs;
    const t0 = win ? Math.max(first, end - win) : first, t1 = Math.max(end, t0 + 60), span = t1 - t0;
    const NAME = 190, DUR = 44;
    const trackW = Math.max(120, this.w - (selCol ? DRAWER : 0) - PADX * 2 - 18 - NAME - DUR - 24);
    const xOf = (at) => Math.max(0, Math.min(trackW, ((at - t0) / span) * trackW));
    const long = span > 20 * 3600;
    const day = (at) => { const x = new Date(at * 1000); return `${x.getMonth() + 1}/${x.getDate()}`; };
    // A tick's label: the clock time; over a long run midnight reads as the date, so days stay told apart.
    const hm = (at) => { const x = new Date(at * 1000); return long && !x.getHours() && !x.getMinutes() ? day(at) : hhmm(at); };
    // Ticks: round clock times, 3–5 labels in all with the one at the right end.
    const LW = 40, endLabel = live ? "now" : long ? `${day(t1)} ${hhmm(t1)}` : hhmm(t1), endW = live ? 28 : long ? 78 : LW;
    const step = [60, 120, 180, 300, 600, 900, 1200, 1800, 3600, 7200, 10800, 14400, 21600, 43200, 86400, 172800, 604800].find((s) => span / s <= 4) ?? Math.ceil(span / 4 / 604800) * 604800;
    const tz = new Date().getTimezoneOffset() * 60;
    let ticks = [];
    for (let at = Math.ceil((t0 - tz) / step) * step + tz; at < t1; at += step) {
      const x = xOf(at);
      if (x + LW + 8 <= trackW - endW && (!ticks.length || x >= ticks[ticks.length - 1].x + LW + 8)) ticks.push({ at, x });
    }
    if (ticks.length < 2) ticks = [0, 1 / 3, 2 / 3].map((f) => ({ at: Math.round((t0 + f * span) / 60) * 60, x: f * trackW }));
    const waiting = rows.filter((c) => c.state !== "finished" && (c.status === "blocked" || c.status === "error"));
    const S = C(t).status, on = C(t).on.status;
    const banner = waiting.length ? h_flex().mx(PADX).mb(8).px(SPACE.card).py(8).gap(10).items_center().flex_none().rounded(8).bg(S.blocked).opacity(0.92)
      .child(h_flex().flex_none().gap(6).items_center().child(icon("triangle-alert", 14, on))
        .child(div().text_size(TS.body).font_semibold().text_color(on).child(`${waiting.map((c) => c.name).join(", ")} ${waiting.length === 1 ? "needs" : "need"} you`)))
      .child(div().flex_1().min_w(0).truncate().text_size(TS.meta).text_color(on).child(waiting[0].doing || "a permission prompt or a question is waiting"))
      .when(Boolean(waiting[0].addr), (e) => e.child(div().id("mp-goto").px(10).py(3).rounded(6).bg(tint(on, 0.2)).text_size(TS.meta).text_color(on).cursor_pointer()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => run("agent.focus", { terminal: waiting[0].addr })).child("Go to agent")))
      : null;
    const mark = (c) => statusMark(t, c.state === "finished" ? "done" : c.status);
    const lane = (c, i) => {
      const sel = c.key === this.sel && !this.closed;
      const a = c.start ?? t0, b = c.state === "finished" ? (c.end ?? a) : now;
      const color = c.status === "blocked" || c.status === "error" ? S.blocked : c.state === "finished" ? t.dim : c.lead ? t.accent : S.working;
      // Only what falls inside the range is drawn; a bar that started before it is cut at the left edge.
      const shown = b >= t0 && a <= t1, x0 = xOf(Math.max(a, t0)), bw = Math.max(4, xOf(Math.min(b, t1)) - x0);
      const mine = evs.filter((e) => !c.lead && c.ids.includes(e.who) && e.at >= t0 && e.at <= t1);
      const track = div().relative().w(trackW).h(18).flex_none().overflow_hidden()
        .child(div().absolute().left(0).right(0).top(8).h(2).rounded(1).bg(t.border).opacity(0.5))
        .children(ticks.map((k) => div().absolute().left(k.x).top(2).w(1).h(14).bg(t.border).opacity(0.5)))
        .when(shown, (x) => x.child(div().absolute().left(Math.min(x0, trackW - bw)).top(5).w(bw).h(8).rounded(4).bg(color).opacity(c.state === "finished" ? 0.55 : 0.9)
          .when(c.state !== "finished" && c.status === "working", (y) => y.loop("opacity", { from: 0.55, to: 0.95, period: 1600 }))))
        .children(mine.slice(0, 40).map((e) => div().absolute().left(Math.max(0, Math.min(trackW - 6, xOf(e.at) - 3))).top(0).size(6).rounded(3)
          .bg(e.k === "from" ? t.accent : e.k === "note" ? S.done : t.foreground)));
      const dur = c.start ? (b - a < 60 ? "<1m" : b - a < 3600 ? `${Math.round((b - a) / 60)}m` : `${(Math.round((b - a) / 360) / 10)}h`) : "";
      return h_flex().id(`ln-${i}`).h(36).mx(8).px(8).gap(8).items_center().rounded(6).cursor_pointer().flex_none()
        .when(sel, (x) => x.bg(t.selected)).when(!sel, (x) => x.hover((h) => h.bg(t.hover)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.sel = c.key; this.closed = false; cx.notify(); })
        .child(div().w(18).flex_none().flex().justify_center().child(mark(c)))
        .child(v_flex().w(NAME).flex_none().min_w(0)
          .child(div().truncate().text_size(TS.body).text_color(sel || c.state !== "finished" ? t.foreground : t.muted).when(c.lead, (x) => x.font_semibold()).child(c.name))
          .child(div().truncate().text_size(TS.small).text_color(t.dim).child(c.lead ? `lead · ${c.vendor}` : c.vendor)))
        .child(track)
        .child(div().w(DUR).flex_none().text_right().text_size(TS.meta).text_color(t.dim).child(dur));
    };
    // Timeline header: the label, the range control, and the legend on the right.
    const seg = h_flex().flex_none().p(2).gap(1).rounded(7).bg(t.surface).children(RANGES.map((r) => {
      const cur = (this.range ?? "all") === r.id;
      return div().id(`rg-${r.id}`).h(20).px(8).flex().items_center().rounded(5).text_size(TS.meta).cursor_pointer()
        .text_color(cur ? t.foreground : t.muted).when(cur, (e) => e.bg(t.selected)).when(!cur, (e) => e.hover((x) => x.bg(t.hover)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.range = r.id; cx.notify(); }).child(r.name);
    }));
    const key = (swatch, text) => h_flex().flex_none().gap(4).items_center().child(swatch).child(div().child(text));
    const dot = (color) => div().size(6).flex_none().rounded(3).bg(color);
    const legend = h_flex().flex_none().gap(12).items_center().text_size(TS.meta).text_color(t.muted)
      .child(key(div().w(14).h(6).flex_none().rounded(3).bg(S.working), "ran"))
      .child(key(dot(t.foreground), "lead → it")).child(key(dot(t.accent), "its reply")).child(key(dot(S.done), "finished"));
    const n = rows.length - 1;
    const bar = h_flex().h(32).px(PADX).gap(10).items_center().flex_none()
      .child(this.label(t, "Timeline"))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`${n} member${n === 1 ? "" : "s"}`))
      .child(seg).child(div().flex_1().min_w(0)).child(legend);
    const axis = h_flex().h(20).px(PADX).gap(8).items_center().flex_none().text_size(TS.small).text_color(t.dim)
      .child(div().w(18 + NAME + 8).flex_none())
      .child(div().relative().w(trackW).h(20).flex_none()
        .children(ticks.map((k) => div().absolute().left(k.x).top(3).w(LW).child(hm(k.at))))
        .child(div().absolute().right(0).top(3).w(endW).text_right().child(endLabel)))
      .child(div().w(DUR).flex_none());
    const left = v_flex().flex_1().min_w(0).h_full()
      .child(bar).child(axis)
      .child(v_flex().id("mp-lanes").flex_1().min_h(0).pb(12).overflow_y_scrollbar().children(rows.map(lane)));
    return root
      .when(Boolean(banner), (e) => e.child(banner))
      .child(h_flex().flex_1().min_h(0).child(left).when(Boolean(selCol), (e) => e.child(this.drawer(t, d, selCol))));
  }

  // Every teammate (no cap), lead first, then by start time: what the timeline and its drawer show.
  members(d) {
    const cols = [{ key: "lead", ids: [d.lead?.id, "lead"], name: agentName(agents().find((x) => x.address === d.lead?.id)) || d.lead?.name || this.addr,
      vendor: AGENT[d.lead?.agent === "claude" ? "claude-code" : d.lead?.agent] ?? d.lead?.agent ?? "", status: d.lead?.status?.state ?? "idle", state: "live",
      doing: d.lead?.status?.msg ?? "", lead: true, addr: d.lead?.id, start: null, end: null }];
    const byName = new Map();
    for (const m of d.herdr ?? []) { const o = byName.get(m.name); if (!o || (m.started ?? 0) > (o.started ?? 0)) byName.set(m.name, m); }
    const pool = [...byName.values(), ...(d.subs ?? []),
      ...(d.sessions ?? []).map((s) => ({ id: s.id, name: s.name, agent: "session", state: "live", status: "idle", kind: "session", addr: s.addr }))];
    pool.sort((a, b) => (a.started ?? 9e12) - (b.started ?? 9e12));
    for (const m of pool) cols.push({ key: m.id, ids: [m.id, m.name], name: m.name,
      vendor: m.kind === "session" ? "Claude session" : m.kind === "sub" ? `subagent · ${m.type ?? ""}` : `${AGENT[m.agent] ?? m.agent ?? ""}${m.role ? ` · ${m.role}` : ""}`,
      status: m.status, state: m.state, doing: m.state === "finished" ? (m.role ? `${m.role} · finished` : "finished") : this.doing(m),
      addr: m.kind === "herdr" && m.state === "live" ? m.id : m.kind === "session" ? m.addr : null, out: m.out, ctx: m.ctx, m,
      start: m.started ?? null, end: m.ended ?? m.last ?? null });
    const first = Math.min(...cols.map((c) => c.start ?? Infinity), ...(d.events ?? []).map((e) => e.at ?? Infinity));
    cols[0].start = Number.isFinite(first) ? first : null;
    return cols;
  }

  // What a member is doing right now, for the drawer: [icon name, text, color].
  nowLine(t, c, m) {
    const S = C(t).status, tool = m.tool ? `${m.tool.name}${m.tool.target ? ` · ${m.tool.target}` : ""}` : "";
    if (c.state === "finished") return ["circle-check", m.exit != null && m.exit !== 0 ? `Exited with code ${m.exit}${c.end ? ` · ${ago(c.end)}` : ""}` : `Finished${c.end ? ` ${ago(c.end)}` : ""}`, t.muted];
    if (c.status === "blocked" || c.status === "error") return ["triangle-alert", `Waiting for you${tool ? ` · ${tool}` : ""}`, S.blocked];
    if (c.status === "working") return tool ? ["wrench", tool, t.foreground] : ["brain", "Thinking…", t.foreground];
    if (m.kind === "session") return ["arrow-left-right", "Another Claude session", t.muted];
    return ["clock", m.last ? `Idle since ${hhmm(m.last)} (${ago(m.last)})` : "Idle", t.muted];
  }

  drawer(t, d, c, closable = true) {
    const m = c.lead ? { ...(d.lead?.info ?? {}), started: d.lead?.started } : c.m ?? {};
    const mine = (e) => c.lead ? true : c.ids.includes(e.who);
    const evs = (d.events ?? []).filter(mine);
    const spawn = evs.find((e) => e.k === "spawn" || e.k === "hc-run");
    const sec = (title) => div().pt(12).pb(4).text_size(11).font_semibold().text_color(t.dim).child(title);
    const para = (txt, color) => div().text_size(TS.meta).text_color(color ?? t.muted).child(txt);
    const out = [];
    out.push(h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(TS.item).font_semibold().text_color(t.foreground).child(c.name))
      .when(closable, (e) => e.child(div().id("dr-x").size(22).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim).hover((x) => x.bg(t.hover)).tooltip("Hide details")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { this.closed = true; cx.notify(); }).child(icon("x", 14, t.dim)))));
    out.push(div().text_size(TS.small).text_color(t.dim).child([c.lead ? "lead" : "", c.vendor, m.model, m.started ? `started ${ago(m.started)}` : ""].filter(Boolean).join(" · ")));
    if (c.addr) out.push(div().id("dr-go").mt(8).h(28).px(10).flex().items_center().justify_center().rounded(7).bg(t.accent).text_size(TS.body).text_color(C(t).on.accent)
      .cursor_pointer().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => run("agent.focus", { terminal: c.addr })).child("Go to agent"));
    // Now: what it is doing, how full its context is, what it has cost, and the start of its last reply.
    const [ni, nt, nc] = this.nowLine(t, c, m);
    out.push(sec("Now"));
    out.push(h_flex().gap(6).items_start().min_w(0).child(div().mt(2).flex_none().child(icon(ni, 12, nc === t.foreground ? t.dim : nc))).child(div().flex_1().min_w(0).text_size(TS.body).text_color(nc).child(nt)));
    if (c.lead && c.doing) out.push(div().pl(18).pt(2).text_size(TS.meta).text_color(t.muted).child(c.doing));
    const stat = (name, text) => h_flex().flex_none().gap(4).items_center().child(icon(name, 12, t.dim)).child(div().child(text));
    const stats = [m.ctx != null ? stat("gauge", `Context ${Math.round(m.ctx)}%`) : null, m.out ? stat("zap", `${k(m.out)} tokens out`) : null,
      m.cost != null ? stat("coins", `$${Number(m.cost).toFixed(2)}`) : null].filter(Boolean);
    if (stats.length) out.push(h_flex().pt(6).gap(12).flex_wrap().text_size(TS.meta).text_color(t.muted).children(stats));
    const last = m.reply || m.text;
    if (last) { out.push(sec("Last reply")); out.push(para(excerpt(last))); }
    if (spawn?.prompt && !c.lead) { out.push(sec("Task it was given")); out.push(para(spawn.prompt)); }
    if ((m.steps ?? []).length) { out.push(sec("Recent steps")); for (const [i, st] of [...m.steps].reverse().entries()) out.push(h_flex().id(`dr-st-${i}`).gap(6).items_center().min_w(0).child(icon("wrench", 12, t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(TS.small).text_color(t.muted).child(`${st.tool}${st.target ? ` · ${st.target}` : ""}`))); }
    if ((m.screen ?? []).length) { out.push(sec("Screen")); out.push(v_flex().p(6).rounded(6).bg(t.popover ?? t.chrome).children(m.screen.map((l, i) => div().id(`dr-sc-${i}`).truncate().text_size(TS.tiny).text_color(t.muted).font_family("Menlo").child(l)))); }
    // The conversation, oldest first like a chat: the lead's messages on the left, the member's replies on the right.
    const msgs = evs.filter((e) => e.k !== "spawn" && e.k !== "hc-run").slice(0, c.lead ? 12 : 30).reverse();
    out.push(sec(c.lead ? "Latest messages" : `Conversation (${msgs.length})`));
    if (!msgs.length) out.push(para("None yet."));
    for (const [i, e] of msgs.entries()) {
      const reply = e.k === "from", notice = e.k === "note";
      const who = notice ? "notice" : reply ? (c.lead ? e.name ?? e.who : c.name) : (c.lead ? `→ ${e.name ?? e.who}` : "lead");
      out.push(h_flex().id(`dr-m-${i}`).mt(6).when(reply, (x) => x.justify_end())
        .child(v_flex().max_w(300).p(8).rounded(10).gap(2)
          .bg(reply ? tint(t.accent, 0.13) : t.popover ?? t.chrome)
          .child(h_flex().gap(6).text_size(TS.small).child(div().text_color(reply ? t.accent : t.dim).child(who)).child(div().text_color(t.dim).child(clock(e.at)))
            .when(Boolean(e.verdict), (x) => { const ok = e.verdict === "APPROVE", vc = ok ? C(t).status.done : C(t).status.blocked;
              return x.child(h_flex().gap(2).items_center().child(icon(ok ? "check" : "x", 12, vc)).child(div().font_semibold().text_color(vc).child(ok ? "APPROVED" : "CHANGES"))); }))
          .child(div().text_size(TS.body).text_color(t.foreground).child((e.full || e.text || "").slice(0, 600)))));
    }
    // A card on the dialog: the surface tier is its edge, no border.
    return div().w(376).h_full().flex_none().pr(12).pb(12)
      .child(v_flex().id("mp-drawer").size_full().rounded(8).bg(t.surface)
        .child(v_flex().id("dr-scroll").flex_1().min_h(0).px(SPACE.card + 4).py(12).overflow_y_scrollbar().children(out)));
  }

  render() {
    const t = theme();
    if (this.form) return this.form.render(t);
    if (this.map) return this.mapView(t);
    return v_flex().id("agent-team").size_full().bg(t.chrome)
      .child(v_flex().id("at-scroll").flex_1().min_h(0).overflow_y_scrollbar().children([...this.body(t), div().h(16)]));
  }
}
