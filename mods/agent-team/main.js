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
        const d = JSON.parse(r.stdout || "{}");
        if (addr === this.addr) this.data = d;
      } catch (e) { if (addr === this.addr) this.data = { ok: false, error: String(e.message ?? e) }; }
      this.busy = false;
      cx.notify();
    });
  }

  h(t, title, right) {
    return h_flex().px(14).pt(14).pb(6).gap(6).items_center().text_size(10.5).font_medium()
      .child(div().text_color(t.dim).child(title.toUpperCase())).child(div().flex_1())
      .when(right != null, (el) => el.child(div().text_color(t.dim).child(String(right))));
  }
  note(t, s) { return div().px(14).py(3).text_size(10.5).text_color(t.dim).child(s); }
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
    return s ? div().flex_none().text_size(10).text_color(t.muted).tooltip(`${m.msgs_to || 0} sent to it · ${m.msgs_from || 0} from it`).child(s) : null;
  }

  member(t, m, i, kind) {
    const live = agents().find((a) => a.address === m.id);
    const prog = live?.program;
    const icon = prog?.icon ? (prog.tint ? svg(prog.icon).size(14).text_color(prog.color ?? t.foreground) : image(prog.icon).w(14).h(14)) : null;
    const who = kind === "herdr" ? `${AGENT[m.agent] ?? m.agent ?? "program"}${m.template ? ` · ${m.template}` : ""}` : `${m.type ?? "subagent"}${m.background ? " · background" : ""}`;
    const right = [m.ctx != null ? `${Math.round(m.ctx)}%` : "", m.out ? `${k(m.out)} out` : ""].filter(Boolean).join(" · ");
    const jump = kind === "herdr" && m.state === "live";
    return h_flex().id(`tm-${kind}-${i}`).px(14).py(5).gap(8).items_start().pl(14 + ((m.depth ?? 1) - 1) * 14)
      .when(jump, (e) => e.cursor_pointer().hover((x) => x.bg(t.hover)).tooltip("Go to this agent").on_click(() => run("agent.focus", { terminal: m.id })))
      .child(div().mt(4).child(this.dot(t, m)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(6).items_center().min_w(0)
          .when(Boolean(icon), (e) => e.child(icon))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(m.state === "finished" ? t.muted : t.foreground).child(m.name))
          .when(Boolean(this.msgs(t, m)), (e) => e.child(this.msgs(t, m))))
        .child(div().truncate().text_size(10).text_color(t.dim).child(`${who}${right ? ` · ${right}` : ""}${m.started ? ` · ${since(m.started)}` : ""}`))
        .child(div().truncate().text_size(10.5).text_color(m.status === "blocked" ? t.blocked : t.muted).child(this.doing(m))));
  }

  event(t, e, i) {
    const glyph = { spawn: "✦", to: "→", from: "←", note: "✓", "hc-run": "✦", "hc-send": "→" }[e.k] ?? "·";
    const color = e.k === "from" ? t.accent : e.k === "note" ? (e.status === "completed" ? t.done : t.dim) : e.k.startsWith("hc") || e.k === "spawn" ? t.working : t.muted;
    const via = e.via === "herdr" ? "Herdr" : e.via === "session" ? "session" : e.via === "sub" ? "subagent" : "";
    const what = e.k === "spawn" ? `started ${e.agent ?? "subagent"}${e.bg ? " (background)" : ""}` : e.k === "hc-run" ? "started in Herdr" : "";
    return h_flex().id(`te-${i}`).px(14).py(3).gap(6).items_start().text_size(10.5)
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
    const note = (s) => [div().p(16).text_size(12).text_color(t.dim).child(s)];
    if (!this.addr) return note("Select an agent to see its team.");
    if (!d) return note("Reading…");
    if (!d.ok) return note(`Unavailable: ${d.error}`);
    const herdr = d.herdr ?? [], subs = d.subs ?? [];
    const running = subs.filter((s) => s.state !== "finished");
    const out = [v_flex().px(14).pt(12).gap(2)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).truncate().child(d.lead?.name ?? this.addr))
      .child(div().text_size(10.5).text_color(t.dim).child(`${herdr.length} Herdr agent${herdr.length === 1 ? "" : "s"} · ${subs.length} subagent${subs.length === 1 ? "" : "s"}${running.length ? ` (${running.length} running)` : ""} · ${(d.sessions ?? []).length} session${(d.sessions ?? []).length === 1 ? "" : "s"}`))];
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
      if (hidden > 0 || this.showDone) out.push(div().id("tm-more").px(14).py(4).text_size(10.5).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { this.showDone = !this.showDone; cx.notify(); }).child(this.showDone ? "Show fewer" : `Show ${hidden} more finished`));
    }
    if ((d.sessions ?? []).length) {
      out.push(this.h(t, "Sessions", d.sessions.length));
      d.sessions.forEach((s, i) => out.push(h_flex().id(`ts-${i}`).px(14).py(3).gap(8).text_size(11).child(div().text_color(t.accent).child("⇄")).child(div().truncate().text_color(t.foreground).child(s.name))));
    }
    out.push(this.h(t, "Timeline", (d.events ?? []).length ? "newest first" : null));
    if (!(d.events ?? []).length) out.push(this.note(t, "No messages yet."));
    (d.events ?? []).slice(0, 60).forEach((e, i) => out.push(this.event(t, e, i)));
    out.push(this.note(t, "→ the lead's message · ← a reply · ✦ started · ✓ finished/notice. Hover a line for the full text."));
    return out;
  }

  // ---------- Team Map (sequence diagram) ----------
  columns(d) {
    const cols = [{ key: "lead", ids: [d.lead?.id, "lead"], name: d.lead?.name ?? this.addr, vendor: AGENT[d.lead?.agent === "claude" ? "claude-code" : d.lead?.agent] ?? d.lead?.agent ?? "",
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
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_semibold().text_color(t.foreground).child(c.name)))
      .child(div().truncate().text_size(10).text_color(t.dim).child(c.lead ? `lead · ${c.vendor}` : c.vendor))
      .child(div().truncate().text_size(10.5).text_color(c.status === "blocked" ? t.blocked : t.muted).child(c.doing || (c.state === "finished" ? "finished" : "")));
  }

  mapView(t) {
    const d = this.data;
    const note = (s) => div().p(20).text_size(12).text_color(t.dim).child(s);
    const head = h_flex().h(40).px(14).gap(8).items_center().border_b(1).border_color(t.border).flex_none()
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Team map"))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(d?.lead?.name ? `· ${d.lead.name}` : ""))
      .child(div().id("mp-new").px(8).py(2).rounded(6).text_size(10.5).cursor_pointer().text_color(t.foreground).border_1().border_color(t.border).hover((x) => x.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => openOverlay({ mod: "agent-team", kind: "dialog", width: 620, height: 640, props: { view: "new" } })).child("New team…"))
      .child(div().id("mp-follow").px(8).py(2).rounded(6).text_size(10.5).cursor_pointer().text_color(this.pinned ? t.muted : t.foreground).when(!this.pinned, (e) => e.bg(t.raised))
        .hover((x) => x.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.pinned = this.pinned ? null : this.addr; this.load(cx); cx.notify(); }).child(this.pinned ? "Follow focused agent" : "Following focused agent"))
      .child(div().id("mp-close").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim).hover((x) => x.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => closeOverlay(this.overlay)).child("×"));
    const root = v_flex().id("team-map").size_full().bg(t.popover ?? t.chrome).on_size_change((size, cx) => { if (Math.abs(size.width - this.w) > 4) { this.w = size.width; cx.notify(); } }).child(head);
    if (!this.addr) return root.child(note("Focus an agent, then open the map."));
    if (!d) return root.child(note("Reading…"));
    if (!d.ok) return root.child(note(`Unavailable: ${d.error}`));
    const cols = this.columns(d);
    if (this.sel && !cols.some((c) => c.key === this.sel)) this.sel = null;
    const DRAWER = this.sel ? 330 : 0;
    const GUT = 46, PAD = 12, ROW = 40;
    const colW = Math.max(110, (this.w - DRAWER - GUT - PAD * 2) / cols.length);
    const cx = (i) => GUT + PAD + colW * i + colW / 2;
    const idx = (who) => { const i = cols.findIndex((c) => c.ids.includes(who)); return i >= 0 ? i : cols.findIndex((c) => c.others); };
    const evs = [...(d.events ?? [])].filter((e) => idx(e.who) >= 0).slice(0, 36).reverse();
    const H = Math.max(evs.length * ROW + 24, 120);
    const body = div().relative().w(GUT + PAD * 2 + colW * cols.length).h(H);
    cols.forEach((c, i) => body.child(div().absolute().left(cx(i)).top(0).w(1).h(H).bg(t.border)));
    let lastDay = null;
    const hm = (at) => { const x = new Date(at * 1000); return `${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}`; };
    evs.forEach((e, r) => {
      const y = r * ROW + 8;
      const m = idx(e.who);
      const day = e.at ? new Date(e.at * 1000).toDateString() : null;
      if (day && day !== lastDay && day !== new Date().toDateString()) {
        const x = new Date(e.at * 1000);
        body.child(div().absolute().left(6).top(y).text_size(9).text_color(t.muted).child(`${x.getMonth() + 1}/${x.getDate()}`));
      }
      lastDay = day;
      body.child(div().absolute().left(6).top(y + 12).w(GUT - 6).text_size(10).text_color(t.dim).child(e.at ? hm(e.at) : ""));
      if (m < 0) return;
      const tip = `${clock(e.at)} ${e.name ?? e.who ?? ""}${e.times ? ` ×${e.times}` : ""}\n${e.text}`;
      const selIdx = this.sel ? cols.findIndex((c) => c.key === this.sel) : -1;
      const faded = selIdx > 0 && m !== selIdx;
      if (e.k === "note") {
        const done = e.status === "completed";
        body.child(div().id(`mn-${r}`).absolute().left(cx(m) - 60).when(faded, (x) => x.opacity(0.25)).top(y + 8).w(120).h(20).flex().items_center().justify_center().rounded(10).border_1()
          .border_color(done ? t.done : t.border).bg(t.surface).text_size(10).text_color(done ? t.done : t.muted).tooltip(tip)
          .child(`${done ? "✓ finished" : "● " + (e.text.includes("waiting") ? "waiting" : e.status || "notice")}${e.times ? ` ×${e.times}` : ""}`));
        return;
      }
      const fromLead = e.k !== "from";
      const a = fromLead ? 0 : m, b = fromLead ? m : 0;
      if (a === b) return;
      const x1 = Math.min(cx(a), cx(b)) + 3, x2 = Math.max(cx(a), cx(b)) - 3, right = cx(b) > cx(a);
      const spawn = e.k === "spawn" || e.k === "hc-run";
      const color = spawn ? t.working : fromLead ? t.muted : t.accent;
      const label = spawn ? `✦ start${e.agent ? ` ${e.agent}` : ""}: ${e.text}` : e.text;
      const fade = (el) => (faded ? el.opacity(0.2) : el);
      body.child(fade(div().id(`ml-${r}`).absolute().left(x1 + 6).top(y + 2).w(x2 - x1 - 12).truncate().text_size(10.5)
        .text_color(spawn ? t.working : t.foreground).tooltip(tip).child(`${label}${e.times ? ` ×${e.times}` : ""}`)));
      if (spawn) for (let x = x1; x < x2 - 4; x += 9) body.child(fade(div().absolute().left(x).top(y + 22).w(Math.min(5, x2 - x)).h(2).rounded(1).bg(color)));
      else body.child(fade(div().absolute().left(x1).top(y + 22).w(x2 - x1).h(2).rounded(1).bg(color)));
      body.child(fade(div().absolute().left(right ? x2 - 7 : x1 - 1).top(y + 15).text_size(11).text_color(color).child(right ? "▶" : "◀")));
    });
    const cards = h_flex().pl(GUT + PAD).pr(PAD).pt(10).pb(8).flex_none().children(cols.map((c, i) => div().w(colW).flex_none().px(4).child(this.card(t, c, i, colW - 8))));
    const diagram = v_flex().flex_1().min_w(0).h_full()
      .child(cards)
      .child(evs.length ? v_flex().id("mp-scroll").flex_1().min_h(0).overflow_y_scrollbar().child(body) : note("No messages yet. Arrows appear as the lead starts agents and they report back."));
    const selCol = cols.find((c) => c.key === this.sel);
    return root
      .child(h_flex().flex_1().min_h(0).child(diagram).when(Boolean(selCol), (e) => e.child(this.drawer(t, d, selCol))))
      .child(h_flex().h(28).px(14).gap(14).items_center().border_t(1).border_color(t.border).text_size(10).text_color(t.dim).flex_none()
        .child(div().child("── lead → member")).child(div().text_color(t.accent).child("── reply")).child(div().text_color(t.working).child("╌╌ started"))
        .child(div().child("✓ finished")).child(div().flex_1()).child(div().child("Hover for full text · click a card for details")));
  }

  drawer(t, d, c) {
    const m = c.m ?? {};
    const mine = (e) => c.lead ? true : c.ids.includes(e.who);
    const evs = (d.events ?? []).filter(mine);
    const spawn = evs.find((e) => e.k === "spawn" || e.k === "hc-run");
    const sec = (title) => div().pt(12).pb(4).text_size(10).font_medium().text_color(t.dim).child(title.toUpperCase());
    const para = (txt, color) => div().text_size(11).text_color(color ?? t.muted).child(txt);
    const out = [];
    out.push(h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(c.name))
      .child(div().id("dr-x").size(22).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim).hover((x) => x.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { this.sel = null; cx.notify(); }).child("×")));
    out.push(div().text_size(10.5).text_color(t.dim).child([c.lead ? "lead" : "", c.vendor, m.state === "finished" ? "finished" : m.status, m.out ? `${k(m.out)} tokens out` : "", m.ctx != null ? `context ${Math.round(m.ctx)}%` : "", m.started ? `started ${since(m.started)} ago` : ""].filter(Boolean).join(" · ")));
    if (c.addr) out.push(div().id("dr-go").mt(8).h(28).px(10).flex().items_center().justify_center().rounded(7).bg(t.accent).text_size(11.5).text_color(t.accent_foreground ?? "#fff")
      .cursor_pointer().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => run("agent.focus", { terminal: c.addr })).child("Go to agent"));
    if (c.doing) { out.push(sec("Now")); out.push(para(c.doing, t.foreground)); }
    if (spawn?.prompt && !c.lead) { out.push(sec("Task it was given")); out.push(para(spawn.prompt)); }
    if ((m.steps ?? []).length) { out.push(sec("Recent steps")); for (const [i, st] of [...m.steps].reverse().entries()) out.push(div().id(`dr-st-${i}`).truncate().text_size(10.5).text_color(t.muted).child(`▸ ${st.tool}${st.target ? ` · ${st.target}` : ""}`)); }
    if ((m.screen ?? []).length) { out.push(sec("Screen")); out.push(v_flex().p(6).rounded(6).bg(t.surface).children(m.screen.map((l, i) => div().id(`dr-sc-${i}`).truncate().text_size(10).text_color(t.muted).font_family("Menlo").child(l)))); }
    const msgs = evs.filter((e) => e.k !== "spawn" && e.k !== "hc-run").slice(0, c.lead ? 12 : 30);
    out.push(sec(c.lead ? "Latest messages" : `Messages with the lead (${msgs.length})`));
    if (!msgs.length) out.push(para("None yet."));
    for (const [i, e] of msgs.entries()) {
      const dir = e.k === "from" ? `← ${c.lead ? e.name ?? e.who : "to lead"}` : e.k === "note" ? "✓ notice" : `→ ${c.lead ? e.name ?? e.who : "from lead"}`;
      out.push(v_flex().id(`dr-m-${i}`).mt(4).p(6).rounded(6).bg(t.surface).gap(2)
        .child(h_flex().gap(6).text_size(10).child(div().text_color(e.k === "from" ? t.accent : t.dim).child(dir)).child(div().flex_1()).child(div().text_color(t.dim).child(clock(e.at))))
        .child(div().text_size(10.5).text_color(t.foreground).child((e.full || e.text || "").slice(0, 500))));
    }
    return v_flex().id("mp-drawer").w(330).h_full().flex_none().border_l(1).border_color(t.border).bg(t.chrome)
      .child(v_flex().id("dr-scroll").flex_1().min_h(0).px(14).py(12).overflow_y_scrollbar().children(out));
  }

  render() {
    const t = theme();
    if (this.form) return this.form.render(t);
    if (this.map) return this.mapView(t);
    return v_flex().id("agent-team").size_full().bg(t.chrome)
      .child(v_flex().id("at-scroll").flex_1().min_h(0).overflow_y_scrollbar().children([...this.body(t), div().h(16)]));
  }
}
