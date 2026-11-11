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
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, focused, agents, theme, run, props, closeOverlay, openOverlay } from "herdr";
import { NewTeam } from "./newteam.js";
import { agentName } from "./agentname.js";
import { TS, SPACE } from "./ui.js";

const clock = (t) => {
  if (!t) return "";
  const d = new Date(t * 1000), hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()}`;
};
const k = (n) => (n == null ? "" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const since = (t) => { if (!t) return ""; const s = Date.now() / 1000 - t; return s < 60 ? "now" : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
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
    if (!addr || this.busy) return;
    if (addr !== this.addr) { this.addr = addr; this.data = null; this.open = new Set(); }
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [appHome() + "/mods/agent-team/team.py", addr], { timeout: 30000 });
        const d = r.stdout ? JSON.parse(r.stdout) : { ok: false, error: (r.stderr || "no output").trim().split("\n").pop() };
        if (addr === this.addr) this.data = d;
      } catch (e) { if (addr === this.addr) this.data = { ok: false, error: String(e.message ?? e) }; }
      this.busy = false;
      cx.notify();
    });
  }

  h(t, title, right) {
    return h_flex().px(SPACE.dialog).pt(14).pb(6).gap(6).items_center().text_size(TS.small).font_medium()
      .child(div().text_color(t.dim).child(title.toUpperCase())).child(div().flex_1())
      .when(right != null, (el) => el.child(div().text_color(t.dim).child(String(right))));
  }
  note(t, s) { return div().px(SPACE.dialog).py(4).text_size(TS.small).text_color(t.dim).child(s); }
  dot(t, m) {
    const c = m.state === "finished" ? t.dim : m.status === "blocked" ? t.blocked : m.status === "working" ? t.working : m.status === "error" ? t.blocked : t.done;
    return div().w(7).h(7).rounded(4).flex_none().bg(c).when(m.status === "working" && m.state !== "finished", (d) => d.loop("opacity", { from: 0.35, to: 1, period: 1200 }));
  }
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
    const icon = prog?.icon ? (prog.tint ? svg(prog.icon).size(14).text_color(prog.color ?? t.foreground) : image(prog.icon).w(14).h(14)) : null;
    const who = kind === "herdr" ? `${AGENT[m.agent] ?? m.agent ?? "program"}${m.template ? ` · ${m.template}` : ""}` : `${m.type ?? "subagent"}${m.background ? " · background" : ""}`;
    const right = [m.ctx != null ? `${Math.round(m.ctx)}%` : "", m.out ? `${k(m.out)} out` : ""].filter(Boolean).join(" · ");
    const jump = kind === "herdr" && m.state === "live";
    return h_flex().id(`tm-${kind}-${i}`).px(SPACE.dialog).py(6).gap(8).items_start().pl(14 + ((m.depth ?? 1) - 1) * 14)
      .when(jump, (e) => e.cursor_pointer().hover((x) => x.bg(t.hover)).tooltip("Go to this agent").on_click(() => run("agent.focus", { terminal: m.id })))
      .child(div().mt(4).child(this.dot(t, m)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(6).items_center().min_w(0)
          .when(Boolean(icon), (e) => e.child(icon))
          .child(div().flex_1().min_w(0).truncate().text_size(TS.body).text_color(m.state === "finished" ? t.muted : t.foreground).child(m.name))
          .when(Boolean(this.msgs(t, m)), (e) => e.child(this.msgs(t, m))))
        .child(div().truncate().text_size(TS.tiny).text_color(t.dim).child(`${who}${right ? ` · ${right}` : ""}${m.started ? ` · ${since(m.started)}` : ""}`))
        .child(div().truncate().text_size(TS.small).text_color(m.status === "blocked" ? t.blocked : t.muted).child(this.doing(m))));
  }

  event(t, e, i) {
    const glyph = { spawn: "✦", to: "→", from: "←", note: "✓", "hc-run": "✦", "hc-send": "→" }[e.k] ?? "·";
    const color = e.k === "from" ? t.accent : e.k === "note" ? (e.status === "completed" ? t.done : t.dim) : e.k.startsWith("hc") || e.k === "spawn" ? t.working : t.muted;
    const via = e.via === "herdr" ? "Herdr" : e.via === "session" ? "session" : e.via === "sub" ? "subagent" : "";
    const what = e.k === "spawn" ? `started ${e.agent ?? "subagent"}${e.bg ? " (background)" : ""}` : e.k === "hc-run" ? "started in Herdr" : "";
    return h_flex().id(`te-${i}`).px(SPACE.dialog).py(4).gap(6).items_start().text_size(TS.small)
      .tooltip(`${clock(e.at)} ${glyph} ${e.name ?? e.who ?? ""} (${via})${e.times ? ` ×${e.times}` : ""}\n${e.text}`)
      .child(div().flex_none().w(34).text_color(t.dim).child(clock(e.at)))
      .child(div().flex_none().w(10).text_color(color).child(glyph))
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
      d.sessions.forEach((s, i) => out.push(h_flex().id(`ts-${i}`).px(SPACE.dialog).py(4).gap(8).text_size(TS.meta).child(div().text_color(t.accent).child("⇄")).child(div().truncate().text_color(t.foreground).child(s.name))));
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
    const dotC = c.state === "finished" ? t.dim : c.status === "blocked" || c.status === "error" ? t.blocked : c.status === "working" ? t.working : t.done;
    const sel = this.sel === c.key;
    return v_flex().id(`mc-${i}`).w(w).h(84).flex_none().px(8).py(6).gap(1).rounded(8).border_1()
      .border_color(sel ? t.accent : t.border).bg(sel ? t.selected ?? t.raised : t.surface).cursor_pointer().hover((x) => x.bg(t.hover))
      .when(c.lead && !sel, (e) => e.border_dashed())
      .tooltip(sel ? "Click again to close details" : "Details")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { this.sel = sel ? null : c.key; cx.notify(); })
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(div().w(7).h(7).rounded(4).flex_none().bg(dotC).when(c.status === "working" && c.state !== "finished", (d) => d.loop("opacity", { from: 0.35, to: 1, period: 1200 })))
        .child(div().flex_1().min_w(0).truncate().text_size(TS.body).font_semibold().text_color(t.foreground).child(c.name)))
      .child(div().truncate().text_size(TS.tiny).text_color(t.dim).child(c.lead ? `lead · ${c.vendor}` : c.vendor))
      .child(div().truncate().text_size(TS.small).text_color(c.status === "blocked" ? t.blocked : t.muted).child(c.doing || (c.state === "finished" ? "finished" : "")));
  }

  mapView(t) {
    const d = this.data;
    const note = (s) => div().p(20).text_size(TS.body).text_color(t.dim).child(s);
    const head = h_flex().h(40).px(SPACE.dialog).gap(8).items_center().border_b(1).border_color(t.border).flex_none()
      .child(div().text_size(TS.item).font_semibold().text_color(t.foreground).child("Team map"))
      .child(div().flex_1().min_w(0).truncate().text_size(TS.meta).text_color(t.dim).child(d?.lead ? `· ${agentName(agents().find((x) => x.address === d.lead.id)) || d.lead.name}` : ""))
      .child(div().id("mp-new").px(8).py(2).rounded(6).text_size(TS.small).cursor_pointer().text_color(t.foreground).border_1().border_color(t.border).hover((x) => x.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => openOverlay({ mod: "team-launch", kind: "dialog", width: 560, height: 228, props: {} })).child("New team…"))
      .child(div().id("mp-follow").px(8).py(2).rounded(6).text_size(TS.small).cursor_pointer().text_color(this.pinned ? t.muted : t.foreground).when(!this.pinned, (e) => e.bg(t.raised))
        .hover((x) => x.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.pinned = this.pinned ? null : this.addr; this.load(cx); cx.notify(); }).child(this.pinned ? "Follow focused agent" : "Following focused agent"))
      .child(div().id("mp-close").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim).hover((x) => x.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => closeOverlay(this.overlay)).child("×"));
    const root = v_flex().id("team-map").size_full().bg(t.popover ?? t.chrome).on_size_change((size, cx) => { if (Math.abs(size.width - this.w) > 4) { this.w = size.width; cx.notify(); } }).child(head);
    if (!this.addr) return root.child(note("Focus an agent, then open the map."));
    if (!d) return root.child(note("Reading…"));
    if (!d.ok) return root.child(note(`Unavailable: ${d.error}`));
    const rows = this.members(d);
    if (!rows.some((c) => c.key === this.sel)) this.sel = (rows.find((c) => !c.lead && c.state !== "finished") ?? rows[rows.length - 1])?.key ?? null;
    const now = Date.now() / 1000;
    const evs = d.events ?? [];
    const times = [...rows.map((c) => c.start).filter(Boolean), ...evs.map((e) => e.at).filter(Boolean)];
    const t0 = times.length ? Math.min(...times) : now - 600;
    const live = rows.some((c) => !c.lead && c.state !== "finished");
    const t1 = Math.max(live ? now : Math.max(...rows.map((c) => c.end ?? c.start ?? t0), ...evs.map((e) => e.at ?? t0)), t0 + 60);
    const RIGHT = 380, NAME = 190, DUR = 44, PADX = SPACE.dialog;
    const trackW = Math.max(120, this.w - RIGHT - PADX * 2 - 18 - NAME - DUR - 24);
    const xOf = (at) => Math.max(0, Math.min(trackW, ((at - t0) / (t1 - t0)) * trackW));
    const hm = (at) => { const x = new Date(at * 1000); return `${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}`; };
    const waiting = rows.filter((c) => c.state !== "finished" && (c.status === "blocked" || c.status === "error"));
    const banner = waiting.length ? h_flex().px(PADX).py(8).gap(10).items_center().flex_none().bg(t.blocked).opacity(0.92)
      .child(div().text_size(TS.body).font_semibold().text_color("#fff").child(`⚠ ${waiting.map((c) => c.name).join(", ")} ${waiting.length === 1 ? "needs" : "need"} you`))
      .child(div().flex_1().min_w(0).truncate().text_size(TS.meta).text_color("#fff").child(waiting[0].doing || "a permission prompt or a question is waiting"))
      .when(Boolean(waiting[0].addr), (e) => e.child(div().id("mp-goto").px(10).py(3).rounded(6).bg("#ffffff33").text_size(TS.meta).text_color("#fff").cursor_pointer()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => run("agent.focus", { terminal: waiting[0].addr })).child("Go to agent")))
      : null;
    const mark = (c) => c.state === "finished" ? svg("mods/workspace-chrome/circle-check.svg").size(12).text_color(t.dim)
      : c.status === "working" ? svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)
      : c.status === "blocked" || c.status === "error" ? div().size(12).rounded(6).bg(t.blocked).flex().items_center().justify_center().text_size(TS.tiny).font_bold().text_color("#fff").child("!")
      : div().size(8).rounded(4).border_1().border_color(t.dim);
    const lane = (c, i) => {
      const sel = c.key === this.sel;
      const a = c.start ?? t0, b = c.state === "finished" ? (c.end ?? a) : now;
      const color = c.status === "blocked" || c.status === "error" ? t.blocked : c.state === "finished" ? t.dim : c.lead ? t.accent : t.working;
      const mine = evs.filter((e) => !c.lead && c.ids.includes(e.who));
      const track = div().relative().w(trackW).h(16).flex_none()
        .child(div().absolute().left(0).right(0).top(7).h(2).rounded(1).bg(t.border).opacity(0.5))
        .child(div().absolute().left(xOf(a)).top(4).w(Math.max(4, xOf(b) - xOf(a))).h(8).rounded(4).bg(color).opacity(c.state === "finished" ? 0.55 : 0.9)
          .when(c.state !== "finished" && c.status === "working", (x) => x.loop("opacity", { from: 0.55, to: 0.95, period: 1600 })))
        .children(mine.slice(0, 40).map((e, k) => div().absolute().left(Math.max(0, xOf(e.at) - 2)).top(1).size(4).rounded(2)
          .bg(e.k === "from" ? t.accent : e.k === "note" ? t.done : t.foreground).opacity(0.85)));
      const dur = c.start ? (b - a < 60 ? "<1m" : b - a < 3600 ? `${Math.round((b - a) / 60)}m` : `${(Math.round((b - a) / 360) / 10)}h`) : "";
      return h_flex().id(`ln-${i}`).h(34).px(PADX).gap(8).items_center().cursor_pointer().flex_none()
        .when(sel, (x) => x.bg(t.selected)).when(!sel, (x) => x.hover((h) => h.bg(t.hover)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.sel = c.key; cx.notify(); })
        .child(div().w(18).flex_none().flex().justify_center().child(mark(c)))
        .child(v_flex().w(NAME).flex_none().min_w(0)
          .child(div().truncate().text_size(TS.body).text_color(sel || c.state !== "finished" ? t.foreground : t.muted).when(c.lead, (x) => x.font_semibold()).child(c.name))
          .child(div().truncate().text_size(TS.small).text_color(t.dim).child(c.lead ? `lead · ${c.vendor}` : c.vendor)))
        .child(track)
        .child(div().w(DUR).flex_none().text_right().text_size(TS.meta).text_color(t.dim).child(dur));
    };
    const axis = h_flex().h(22).px(PADX).gap(8).items_center().flex_none().text_size(TS.small).text_color(t.dim).border_b(1).border_color(t.border)
      .child(div().w(18 + NAME + 8).flex_none().child(`${rows.length - 1} member${rows.length === 2 ? "" : "s"}`))
      .child(h_flex().w(trackW).flex_none().justify_between().child(div().child(hm(t0))).child(div().child(live ? "now" : hm(t1))))
      .child(div().w(DUR).flex_none());
    const left = v_flex().flex_1().min_w(0).h_full()
      .child(axis)
      .child(v_flex().id("mp-lanes").flex_1().min_h(0).overflow_y_scrollbar().children(rows.map(lane)));
    const selCol = rows.find((c) => c.key === this.sel);
    return root
      .when(Boolean(banner), (e) => e.child(banner))
      .child(h_flex().flex_1().min_h(0).child(left).when(Boolean(selCol), (e) => e.child(this.drawer(t, d, selCol))))
      .child(h_flex().h(26).px(PADX).gap(14).items_center().border_t(1).border_color(t.border).text_size(TS.small).text_color(t.dim).flex_none()
        .child(div().child("bar: when it ran")).child(div().text_color(t.foreground).child("• lead → it")).child(div().text_color(t.accent).child("• its reply"))
        .child(div().text_color(t.done).child("• finished")).child(div().flex_1()).child(div().child("Click a row for its conversation")));
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

  drawer(t, d, c) {
    const m = c.m ?? {};
    const mine = (e) => c.lead ? true : c.ids.includes(e.who);
    const evs = (d.events ?? []).filter(mine);
    const spawn = evs.find((e) => e.k === "spawn" || e.k === "hc-run");
    const sec = (title) => div().pt(12).pb(4).text_size(TS.tiny).font_medium().text_color(t.dim).child(title.toUpperCase());
    const para = (txt, color) => div().text_size(TS.meta).text_color(color ?? t.muted).child(txt);
    const out = [];
    out.push(h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(TS.item).font_semibold().text_color(t.foreground).child(c.name))
      .child(div().id("dr-x").size(22).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim).hover((x) => x.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { this.sel = null; cx.notify(); }).child("×")));
    out.push(div().text_size(TS.small).text_color(t.dim).child([c.lead ? "lead" : "", c.vendor, m.state === "finished" ? "finished" : m.status, m.out ? `${k(m.out)} tokens out` : "", m.ctx != null ? `context ${Math.round(m.ctx)}%` : "", m.started ? `started ${since(m.started)} ago` : ""].filter(Boolean).join(" · ")));
    if (c.addr) out.push(div().id("dr-go").mt(8).h(28).px(10).flex().items_center().justify_center().rounded(7).bg(t.accent).text_size(TS.body).text_color(t.accent_foreground ?? "#fff")
      .cursor_pointer().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => run("agent.focus", { terminal: c.addr })).child("Go to agent"));
    if (c.doing) { out.push(sec("Now")); out.push(para(c.doing, t.foreground)); }
    if (spawn?.prompt && !c.lead) { out.push(sec("Task it was given")); out.push(para(spawn.prompt)); }
    if ((m.steps ?? []).length) { out.push(sec("Recent steps")); for (const [i, st] of [...m.steps].reverse().entries()) out.push(div().id(`dr-st-${i}`).truncate().text_size(TS.small).text_color(t.muted).child(`▸ ${st.tool}${st.target ? ` · ${st.target}` : ""}`)); }
    if ((m.screen ?? []).length) { out.push(sec("Screen")); out.push(v_flex().p(6).rounded(6).bg(t.surface).children(m.screen.map((l, i) => div().id(`dr-sc-${i}`).truncate().text_size(TS.tiny).text_color(t.muted).font_family("Menlo").child(l)))); }
    // The conversation, oldest first like a chat: the lead's messages on the left, the member's replies on the right.
    const msgs = evs.filter((e) => e.k !== "spawn" && e.k !== "hc-run").slice(0, c.lead ? 12 : 30).reverse();
    out.push(sec(c.lead ? "Latest messages" : `Conversation (${msgs.length})`));
    if (!msgs.length) out.push(para("None yet."));
    for (const [i, e] of msgs.entries()) {
      const reply = e.k === "from", notice = e.k === "note";
      const who = notice ? "notice" : reply ? (c.lead ? e.name ?? e.who : c.name) : (c.lead ? `→ ${e.name ?? e.who}` : "lead");
      out.push(h_flex().id(`dr-m-${i}`).mt(6).when(reply, (x) => x.justify_end())
        .child(v_flex().max_w(300).p(8).rounded(10).gap(2)
          .bg(reply ? t.accent + "22" : notice ? (t.popover ?? t.chrome) : t.surface).when(notice, (x) => x.border_1().border_color(t.border))
          .child(h_flex().gap(6).text_size(TS.small).child(div().text_color(reply ? t.accent : t.dim).child(who)).child(div().text_color(t.dim).child(clock(e.at)))
            .when(Boolean(e.verdict), (x) => x.child(div().font_semibold().text_color(e.verdict === "APPROVE" ? t.done : t.blocked).child(e.verdict === "APPROVE" ? "✓ APPROVED" : "✗ CHANGES"))))
          .child(div().text_size(TS.body).text_color(t.foreground).child((e.full || e.text || "").slice(0, 600)))));
    }
    return v_flex().id("mp-drawer").w(380).h_full().flex_none().border_l(1).border_color(t.border).bg(t.chrome)
      .child(v_flex().id("dr-scroll").flex_1().min_h(0).px(SPACE.dialog).py(12).overflow_y_scrollbar().children(out));
  }

  render() {
    const t = theme();
    if (this.form) return this.form.render(t);
    if (this.map) return this.mapView(t);
    return v_flex().id("agent-team").size_full().bg(t.chrome)
      .child(v_flex().id("at-scroll").flex_1().min_h(0).overflow_y_scrollbar().children([...this.body(t), div().h(16)]));
  }
}
