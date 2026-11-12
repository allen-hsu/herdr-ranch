// Agent rows as the sidebar's agent list draws them — icon, name, context bar and %, time since its state changed,
// status — plus its hc sub-agents and Claude background subagents. Shared lib (herdr-ranch/lib) so the
// the sidebar (space-folders) and the Board show agents the same way.
import { div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, terminals, exec, home, appHome, readTextFile, run, openOverlay } from "herdr";
import { TS, C, statusMark, openPage, icon } from "./ui.js";
import { agentName } from "./agentname.js";
import { accountDirOf, accountsInfo, shortNames } from "./accounts.js";

const SNAPSHOT = "/.cache/herdr-claude-status/claude-statusline.json";
const isClaude = (a) => a.app === "claude-code" || a.program?.key === "claude";

export function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export function programIcon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// Context %, background subagents and "since" times, refreshed while the view lives.
export class AgentData {
  constructor() {
    this.ctx = {}; this.csubs = {}; this.pidOf = {}; this.sidOf = {};
    this.acctOf = {}; this.acctNames = null; this.acctAt = 0; // agents on another account than the system login
    try { this.changed = JSON.parse(localStorage.getItem("agent-changed") ?? "{}"); } catch { this.changed = {}; }
  }
  start(cx) {
    this.refresh(cx);
    cx.timer.every(4000, (cx) => this.refresh(cx));
  }
  since(a) { return this.changed[a.address]?.at ?? 0; }
  // The short name of the account an agent runs under, or null on the system login. Which account comes free
  // with terminals() (its argv); the names are asked once a minute, and only while such an agent exists.
  account(a) {
    const id = this.acctOf[a.address];
    return id ? this.acctNames?.claude?.[id] ?? this.acctNames?.codex?.[id] ?? id : null;
  }
  // Stamp agents whose state changed (done and idle count as one).
  track(list, now = Date.now()) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (dirty) try { localStorage.setItem("agent-changed", JSON.stringify(this.changed)); } catch {}
  }
  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const before = JSON.stringify([this.ctx, this.csubs, this.acctOf, this.acctNames]);
        const h = home(), now = Date.now(), next = {};
        const dirOf = {};
        try { for (const x of terminals() ?? []) { const d = accountDirOf(x); if (d) dirOf[x.address] = d; } } catch {}
        const live = new Set(agents().map((a) => a.address));
        this.acctOf = Object.fromEntries(Object.entries(dirOf).filter(([addr]) => live.has(addr)).map(([addr, d]) => [addr, d.split("/").pop()]));
        if (Object.keys(this.acctOf).length && now - this.acctAt > 60000) {
          this.acctAt = now;
          try { this.acctNames = shortNames(await accountsInfo(this.mod)); } catch {}
        }
        let snap = {};
        try { snap = JSON.parse((await readTextFile(h + SNAPSHOT)) ?? "{}"); } catch {}
        const contexts = snap.session_contexts ?? {};
        const claude = agents().filter((a) => isClaude(a) && !a.address.includes("/"));
        for (const a of claude) {
          let p = this.pidOf[a.address];
          if (!p || now - p.at > 15000) {
            try { p = { pid: JSON.parse((await exec("hc", ["get", a.address, "--json"], { timeout: 5000 })).stdout)?.foreground?.pid ?? null, at: now }; }
            catch { p = { pid: null, at: now }; }
            this.pidOf[a.address] = p;
          }
          if (!p.pid) continue;
          if (!this.sidOf[p.pid]) {
            // An agent on another account keeps its session record in that account's folder.
            try { this.sidOf[p.pid] = JSON.parse((await readTextFile(`${dirOf[a.address] ?? `${h}/.claude`}/sessions/${p.pid}.json`)) ?? "{}").sessionId ?? null; } catch {}
          }
          const pct = contexts[this.sidOf[p.pid]]?.used_percent;
          if (typeof pct === "number") next[a.address] = pct;
        }
        this.ctx = next;
        const addrs = claude.map((a) => a.address).filter((x) => /^[A-Za-z0-9_-]+$/.test(x));
        if (addrs.length) {
          const r = await exec("python3", [`${appHome()}/mods/${this.mod}/subs.py`, ...addrs], { timeout: 15000 }).catch(() => null);
          try { this.csubs = JSON.parse(r?.stdout || "{}"); } catch {}
        } else this.csubs = {};
      } finally { this.busy = false; if (JSON.stringify([this.ctx, this.csubs, this.acctOf, this.acctNames]) !== before) cx.notify(); } // redraw only on news
    });
  }
}

export function ctxBadge(t, pct) {
  const color = pct >= 80 ? C(t).status.blocked : pct >= 60 ? C(t).status.working : t.dim;
  const w = 22;
  return h_flex().flex_none().gap(4).items_center().tooltip(`Context used: ${Math.round(pct)}%`)
    .child(div().w(w).h(4).rounded(2).bg(t.border)
      .child(div().h(4).rounded(2).bg(color).w(Math.max(1, Math.round(w * Math.min(pct, 100) / 100)))))
    .child(div().w(26).text_right().text_size(TS.meta).text_color(color).child(`${Math.round(pct)}%`));
}

// A tiny tag for an agent that runs under another account than the system login.
export function accountTag(t, id, name) {
  return div().id(id).flex_none().max_w(64).truncate().px(4).rounded(4).border_1().border_color(t.border).text_size(TS.tiny).text_color(t.muted).tooltip(`Account: ${name}`).child(name);
}

// The status mark lives in ui.js (one for every mod); kept here as a re-export for older imports.
export { statusMark };

// One agent, indented by `pad`; `trailW` keeps the status in the list's right-hand column.
export function agentRow(t, a, data, { pad, trailW = 30, now = Date.now() }) {
  const pct = data.ctx?.[a.address];
  const when = data.since(a);
  return h_flex().id(`ar-${a.address}`).relative().h(26).pl(pad).pr(8).gap(6).items_center().rounded(6).cursor_pointer().flex_none()
    .when(a.focused, (el) => el.bg(t.selected).child(div().absolute().left(0).top(6).bottom(6).w(2).rounded(1).bg(t.accent)))
    .when(!a.focused, (el) => el.hover((s) => s.bg(t.hover)))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_mouse_up("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); run("pane.focus", { pane: a.pane }); })
    .child(div().w(14).flex_none().flex().justify_center().child(programIcon(a.program, 13, t.muted) ?? div()))
    .child(div().flex_1().min_w(0).truncate().text_size(TS.body).text_color(a.focused || a.status === "blocked" || a.status === "done" ? t.foreground : t.muted)
      .when(a.status === "done", (el) => el.font_semibold()).child(agentName(a) || a.program?.name || a.address))
    .when(Boolean(data.account?.(a)), (el) => el.child(accountTag(t, `ar-acct-${a.address}`, data.account(a))))
    .when(typeof pct === "number", (el) => el.child(ctxBadge(t, pct)))
    .when(Boolean(when), (el) => el.child(div().flex_none().w(26).text_right().text_size(TS.meta).text_color(t.dim).child(duration(now - when))))
    .child(h_flex().w(trailW).flex_none().justify_end().items_center().child(statusMark(t, a.status)));
}

// An hc sub-agent (a terminal the agent started) or a Claude background subagent, under its agent.
export function childRow(t, key, { pad, name, status, prog, last, onClick, tip, trailW = 30 }) {
  return h_flex().id(key).h(22).pl(pad).pr(8).gap(0).items_center().rounded(6).flex_none().cursor_pointer()
    .hover((s) => s.bg(t.hover)).when(Boolean(tip), (el) => el.tooltip(tip))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_mouse_up("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); onClick?.(); })
    .child(div().self_start().mt(-4).w(9).h(15).mr(6).flex_none().border_l(1.5).border_color(t.input).border_b(1.5).rounded_bl(5))
    .child(div().w(14).mr(6).flex_none().flex().justify_center().opacity(0.75).child(programIcon(prog, 12, t.dim) ?? div()))
    .child(div().flex_1().min_w(0).truncate().text_size(TS.meta).text_color(t.muted).child(name))
    .child(h_flex().w(trailW).flex_none().justify_end().items_center().child(statusMark(t, status)));
}

// Everything under one agent: its live hc sub-agents, then its running background subagents.
export function childrenOf(t, a, data, { pad, trailW = 30 }) {
  let all = [];
  try { all = terminals() ?? []; } catch {}
  const kids = all.filter((k) => k.parent === a.address && k.state === "live");
  const rows = kids.map((k) => childRow(t, `kid-${k.address}`, { pad, trailW, name: k.name || k.template || k.program?.name || k.address,
    status: k.status === "error" ? "blocked" : k.status === "done" ? "idle" : k.status, prog: k.program,
    onClick: () => run("pane.focus", { terminal: k.address }), tip: k.template ? `${k.template}` : null }));
  for (const b of data.csubs?.[a.address] ?? []) rows.push(b.kind === "shell"
    // A background command the agent is waiting on (a Codex job, a build, a server): it is still busy, even if idle.
    ? childRow(t, `bg-${a.address}-${b.id}`, { pad, trailW, name: b.desc, status: "working", prog: null,
        tip: "Background command still running in this agent — click to go to it", onClick: () => run("pane.focus", { pane: a.pane }) })
    : childRow(t, `bg-${a.address}-${b.id}`, { pad, trailW, name: b.desc, status: "working", prog: a.program,
        tip: `Background subagent${b.type ? ` (${b.type})` : ""} — open in the Team map`,
        onClick: () => openPage("team", { lead: a.address, sel: b.id }) }));
  return rows;
}

// Orca-style compact row for the "by space" view: status icon, program icon, name, time. No context bar.
// pin: { hovered, onHover(hovered, cx) } turns on Herdr's own pin (terminal.pin): a pin button in place of the time
// while the row is hovered; a pinned agent keeps a small pin.
export function simpleAgentRow(t, a, data, { pad, trailW = 30, now = Date.now(), key = "sr", sub = null, pin = null }) {
  const when = data.since(a);
  const st = a.status;
  const bg = (data.csubs?.[a.address] ?? []).length;
  // Idle or finished, but background work (a subagent, a command it waits on) is still running: not really idle.
  const waiting = bg > 0 && st !== "working" && st !== "blocked" && st !== "error";
  const mark = waiting ? svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.muted).spin(1600) : statusMark(t, st);
  return h_flex().id(`${key}-${a.address}`).relative().h(24).pl(pad).pr(8).gap(6).items_center().rounded(6).cursor_pointer().flex_none()
    .when(a.focused, (el) => el.bg(t.hover)).when(!a.focused, (el) => el.hover((s) => s.bg(t.hover)))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_mouse_up("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); run("pane.focus", { pane: a.pane }); })
    .child(div().w(14).flex_none().flex().justify_center().child(mark))
    .child(div().w(14).flex_none().flex().justify_center().child(programIcon(a.program, 13, t.muted) ?? div()))
    .child(div().flex_1().min_w(0).truncate().text_size(TS.body)
      .text_color(a.focused || st === "blocked" || st === "done" || st === "working" ? t.foreground : t.muted).child(agentName(a) || a.program?.name || a.address))
    .when(Boolean(data.account?.(a)), (el) => el.child(accountTag(t, `${key}-acct-${a.address}`, data.account(a))))
    // sub: a short note after the name (the top sections say which space the agent is in).
    .when(Boolean(sub), (el) => el.child(div().flex_none().max_w(90).truncate().text_size(TS.meta).text_color(t.dim).child(sub)))
    .when(Boolean(pin), (el) => el.on_hover((h, cx) => pin.onHover(h, cx)))
    .when(Boolean(pin?.hovered), (el) => el.child(div().id(`${key}-pin-${a.address}`).flex_none().w(26).h(20).flex().items_center().justify_center().rounded(5)
      .hover((s) => s.bg(t.raised)).tooltip(a.pinned ? "Unpin" : "Pin to the top")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); run("terminal.pin", { terminal: a.address, pinned: !a.pinned }); })
      .child(icon(a.pinned ? "pin-off" : "pin", 12, t.muted))))
    .when(!pin?.hovered && Boolean(a.pinned) && Boolean(pin), (el) => el.child(icon("pin", 11, t.dim)))
    .when(!pin?.hovered && Boolean(when), (el) => el.child(div().flex_none().w(26).text_right().text_size(TS.meta).text_color(t.dim).child(duration(now - when))))
    .child(div().w(trailW - 26 > 0 ? 4 : 0).flex_none());
}
