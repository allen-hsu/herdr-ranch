// Agent team: who works with the focused agent, and what they said to each other.
//   Herdr agents  terminals it started with `hc run` (Claude Code, Codex, Grok, Cursor, Gemini...): status,
//                 what each is doing, messages each way; click to jump there
//   Subagents     Claude Code subagents (Agent tool) inside its session
//   Sessions      other Claude sessions it messaged (SendMessage over a socket)
//   Timeline      spawns, its messages, replies, completion notices (newest first)
// Data: ./team.py (local files + hc). Refreshes every 5 s while shown.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, focused, agents, theme, run } from "herdr";

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
    this.load(cx);
    cx.timer.every(5000, (cx) => this.load(cx));
  }

  target() {
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

  render() {
    const t = theme();
    return v_flex().id("agent-team").size_full().bg(t.chrome)
      .child(v_flex().id("at-scroll").flex_1().min_h(0).overflow_y_scrollbar().children([...this.body(t), div().h(16)]));
  }
}
