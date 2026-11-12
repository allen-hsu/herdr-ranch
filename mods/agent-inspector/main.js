// Agent inspector for the focused Claude Code / Codex agent. Four tabs:
//   Overview     - what it's doing now, what needs you, how long the context lasts, what the cache and the session cost
//   Trace        - what it did, per turn: summary, time split, waterfall of LLM calls / tools / hooks, per-call detail
//   Capabilities - skills, MCP servers and tools: what it could use, what it used, what each costs in context
//   Config       - what shapes it: model and mode, memory files, hooks (by name, with their health)
// Data: ./inspect.py (local transcripts only).
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, focused, agents, theme, run } from "herdr";
import { TS, SPACE, C, tint, icon, statusMark } from "./ui.js";
import { agentName } from "./agentname.js";

const k = (n) => (n == null ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const ms = (v) => (v == null ? "" : v < 1000 ? `${v}ms` : v < 60000 ? `${(v / 1000).toFixed(1)}s` : `${Math.floor(v / 60000)}m${String(Math.round((v % 60000) / 1000)).padStart(2, "0")}s`);
const dur = (s) => ms(s == null ? null : Math.round(s * 1000));
const clock = (t) => { if (!t) return ""; const d = new Date(t * 1000); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const TABS = ["overview", "trace", "capabilities", "config"];
const TAB_LABEL = { overview: "Overview", trace: "Trace", capabilities: "Capabilities", config: "Config" };
const OLD_TAB = { health: "overview", cost: "overview", skills: "capabilities", mcp: "capabilities" };
const money = (v) => (v == null ? "–" : v < 0.01 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`);
const HOW = { model: "by the model", you: "by you (/command)", subagent: "in a subagent", restored: "restored after compaction" };

export default class AgentInspector extends View {
  init(_props, cx) {
    this.addr = null;
    this.data = null;
    const saved = localStorage.getItem("tab") ?? "overview";
    this.tab = TABS.includes(saved) ? saved : OLD_TAB[saved] ?? "overview";
    this.cap = localStorage.getItem("cap") ?? "skills"; // Capabilities: skills | mcp | tools
    this.filter = "all"; // Trace: all | errors | skills
    this.cache = new Map(); // address -> last data, so switching agents shows something at once
    this.keys = new Map(); // address -> last output (minus the clock), to skip redraws when nothing changed
    this.fade = 1;
    this.open = new Set([0]); // expanded turns in Trace (the latest starts open)
    this.openSpan = new Set(); // expanded waterfall rows in Trace
    this.openSrv = new Set(); // expanded servers in MCP
    this.load(cx);
    cx.timer.every(5000, (cx) => this.load(cx));
    // Follow focus quickly: a string compare every 250 ms, a redraw only when the focused agent changes.
    cx.timer.every(250, (cx) => { const a = this.target(); if (a && a !== this.addr) this.switchTo(a, cx); });
  }

  target() {
    const f = focused();
    return f?.agent ?? (agents().some((a) => a.address === f?.terminal) ? f.terminal : null);
  }

  // Show another agent: its last data at once (dimmed until fresh data lands), or a skeleton.
  switchTo(addr, cx) {
    this.addr = addr;
    this.data = this.cache.get(addr) ?? null;
    this.fade = this.data ? 0.6 : 0;
    this.open = new Set([0]); this.openSpan = new Set();
    cx.notify();
    this.load(cx);
  }

  load(cx) {
    const addr = this.target() ?? this.addr;
    if (!addr) return;
    if (addr !== this.addr) return this.switchTo(addr, cx);
    if (this.inflight?.has(addr)) return;
    (this.inflight ??= new Set()).add(addr);
    cx.spawn(async (cx) => {
      let d;
      try {
        const r = await exec("python3", [appHome() + "/mods/agent-inspector/inspect.py", addr], { timeout: 30000 });
        // Nothing new (ignoring the clock): skip the redraw — unless it's busy (the elapsed time moves) or 30 s passed.
        const key = (r.stdout || "").replace(/"now":[\d.]+/, "");
        const same = key === this.keys.get(addr);
        this.keys.set(addr, key);
        d = same && this.cache.has(addr) ? this.cache.get(addr) : JSON.parse(r.stdout || "{}");
        if (same && addr === this.addr && this.fade === 1 && d.doing?.state === "idle" && Date.now() - (this.drawnAt ?? 0) < 30000) { this.inflight.delete(addr); return; }
        if (same) d = { ...d, now: Date.now() / 1000 };
      } catch (e) {
        d = { ok: false, error: String(e.message ?? e) };
      }
      this.inflight.delete(addr);
      if (d.ok) this.cache.set(addr, d);
      if (addr === this.addr) { this.data = d; this.fade = 1; this.drawnAt = Date.now(); cx.notify(); }
    });
  }

  // ---------- small pieces ----------
  h(t, title, right) {
    return h_flex().px(SPACE.panel).pt(14).pb(6).gap(6).items_center().text_size(11).font_semibold()
      .child(div().text_color(t.dim).child(title)).child(div().flex_1())
      .when(right != null, (el) => el.child(div().text_color(t.dim).child(String(right))));
  }
  row(t, id, left, mid, right, color) {
    return h_flex().id(id).px(SPACE.panel).py(4).gap(8).items_center().text_size(TS.meta)
      .child(div().flex_none().text_color(color ?? t.muted).child(left))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(mid))
      .when(right != null, (el) => el.child(div().flex_none().text_color(t.dim).child(String(right))));
  }
  note(t, s) { return div().px(SPACE.panel).py(4).text_size(TS.small).text_color(t.dim).child(s); }
  stat(t, label, value, color, tip) {
    const el = v_flex().id(`st-${label}`).flex_1().min_w(0).px(10).py(8).rounded(8).bg(t.surface).gap(1)
      .child(div().text_size(TS.tiny).text_color(t.dim).child(label))
      .child(div().text_size(TS.title).font_semibold().text_color(color ?? t.foreground).child(value));
    return tip ? el.tooltip(tip) : el;
  }
  // Wider panel for the waterfall: toggles the layout's "panel" column between its default and a wide size.
  widthToggle(t) {
    const wide = (this.width ?? 440) >= 600;
    return h_flex().id("ai-wide").flex_none().gap(4).items_center().px(6).py(1).rounded(5).text_size(TS.small).text_color(t.dim).cursor_pointer()
      .hover((e) => e.bg(t.hover).text_color(t.foreground)).tooltip(wide ? "Narrow the panel" : "Widen the panel (easier to read the trace)")
      .on_click((_e, _cx) => run("layout.resize", { id: "panel", px: wide ? 440 : 760 }))
      .child(icon("chevrons-left-right", 14, t.dim)).child(wide ? "Narrow" : "Wide");
  }
  // What actually needs you: live context/cache warnings and real failures (hooks, MCP). A tool returning an error or a
  // rejected call is part of normal work: those stay in Trace (Errors filter); skill/MCP notes go to Capabilities.
  needs(t, d) {
    return [...this.liveIssues(t, d).filter((i) => i.level !== "info" && (i.kind === "context" || i.kind === "cache")),
      ...(d.issues ?? []).filter((i) => i.level === "error" || (i.level === "warn" && i.kind === "hook"))];
  }
  lvlColor(t, l) { const c = C(t).status; return l === "error" ? c.blocked : l === "warn" ? c.working : t.dim; }

  // ---------- derived alerts (live state) ----------
  liveIssues(t, d) {
    const out = [];
    const left = d.cache_until ? d.cache_until - d.now : null;
    if (d.pct >= 70) out.push({ level: "error", kind: "context", text: `Context ${Math.round(d.pct)}% full — /compact or start fresh before quality drops.` });
    else if (d.pct >= 50) out.push({ level: "warn", kind: "context", text: `Context ${Math.round(d.pct)}% — every turn re-reads ${k(d.ctx)} tokens.` });
    if (left != null && left <= 0 && d.ctx > 100000) out.push({ level: "warn", kind: "cache", text: `Prompt cache expired — next turn re-writes ~${k(d.ctx)} tokens at full price.` });
    const c = d.config ?? {};
    const used = (c.skills?.used ?? []).filter((u) => u.count > 0).length;
    if (c.skills?.available > 50) out.push({ level: "info", kind: "skills", text: `${c.skills.available} skills listed (~${k(c.skills.available_tok)} tokens every turn), ${used} loaded in this session.` });
    for (const m of c.skills?.missed ?? []) out.push({ level: "info", kind: "skills", text: `You asked for the skill ${m.name} in ${m.turns} prompt${m.turns > 1 ? "s" : ""}, but it wasn't loaded.` });
    const big = (c.skills?.used ?? []).filter((u) => u.tok > 20000);
    for (const u of big) out.push({ level: "warn", kind: "skills", text: `Skill ${u.name} put ~${k(u.tok)} tokens into context when it loaded.` });
    const mt = c.mcp?.totals;
    if (mt?.servers) {
      const idle = (c.mcp.servers ?? []).filter((s) => s.status === "connected" && !s.calls);
      if (idle.length) out.push({ level: "info", kind: "mcp", text: `${idle.length} of ${mt.connected} connected MCP servers unused here (~${k(idle.reduce((n, s) => n + s.instr_tok + s.list_tok + s.def_tok, 0))} tokens of context).` });
      const auth = (c.mcp.servers ?? []).filter((s) => s.status === "needs auth");
      if (auth.length) out.push({ level: "info", kind: "mcp", text: `${auth.length} MCP servers need sign-in: ${auth.map((s) => s.name).slice(0, 4).join(", ")}${auth.length > 4 ? "…" : ""}.` });
    }
    return out;
  }

  // ---------- Overview ----------
  // The live line: what the agent is doing this second.
  nowCard(t, d) {
    const a = agents().find((x) => x.address === this.addr);
    const st = C(t).status, x = d.doing ?? { state: "idle" };
    const since = x.since ? Math.max(0, d.now - x.since) : null;
    let mark, title, sub = "", color = t.foreground;
    if (a?.status === "blocked" || x.state === "ask") {
      mark = statusMark(t, "blocked"); color = st.blocked;
      title = x.state === "ask" ? `Asking you (${x.name})` : "Waiting for you";
      sub = x.state === "ask" ? (x.label || "a question is open in its terminal") : "a permission prompt or question in its terminal";
    } else if (x.state === "tool") {
      mark = statusMark(t, "working"); title = `Running ${x.name}`; sub = x.label;
    } else if (x.state === "model" || a?.status === "working") {
      mark = statusMark(t, "working"); title = "Thinking"; sub = "the model is working on its next step";
    } else {
      mark = statusMark(t, a?.status === "done" ? "done" : "idle"); title = "Idle"; color = t.muted;
      sub = x.since ? `last activity ${clock(x.since)}` : "";
    }
    return h_flex().id("ov-now").mx(SPACE.panel).mt(12).px(12).py(10).gap(10).items_center().rounded(8).bg(t.surface)
      .child(div().w(16).flex_none().flex().justify_center().child(mark))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(TS.item).font_semibold().text_color(color).child(title))
        .when(Boolean(sub), (e) => e.child(div().truncate().text_size(TS.small).text_color(t.dim).child(sub))))
      .when(since != null && x.state !== "idle", (e) => e.child(div().flex_none().text_size(TS.meta).text_color(since > 120 ? st.working : t.dim).child(dur(since))));
  }

  overview(t, d) {
    const out = [this.nowCard(t, d)];
    const st = C(t).status;
    // Needs you: errors and warnings only; informational notes live with their topic.
    const issues = this.needs(t, d);
    out.push(this.h(t, "Needs attention", issues.length || null));
    if (!issues.length) out.push(this.note(t, "Nothing needs you."));
    for (const [i, x] of issues.slice(0, 8).entries()) out.push(h_flex().id(`is-${i}`).px(SPACE.panel).py(5).gap(8).items_start()
      .child(div().mt(5).size(7).rounded(4).flex_none().bg(this.lvlColor(t, x.level)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(TS.body).text_color(t.foreground).child(x.text))
        .child(div().text_size(TS.tiny).text_color(t.dim).child(`${x.kind}${x.count > 1 ? ` · ${x.count}×` : ""}${x.last ? ` · last ${clock(x.last)}` : ""}`))));

    // Context: how full, how fast it grows, what fills it.
    const pct = d.pct ?? (d.window ? (d.ctx / d.window) * 100 : null);
    if (pct != null) {
      const grow = (d.turns ?? []).slice(0, 5).map((x) => x.ctx_delta).filter((v) => v > 0);
      const per = grow.length ? grow.reduce((n, v) => n + v, 0) / grow.length : 0;
      const room = d.window ? d.window * 0.9 - d.ctx : 0; // auto-compaction kicks in near the top
      const turnsLeft = per > 0 && room > 0 ? Math.floor(room / per) : null;
      const pc = pct >= 80 ? st.blocked : pct >= 60 ? st.working : C(t).kind.llm;
      out.push(this.h(t, "Context", `${Math.round(pct)}% · ${k(d.ctx)} of ${k(d.window)}`));
      out.push(div().px(SPACE.panel).child(h_flex().h(6).rounded(3).overflow_hidden().bg(t.surface)
        .child(div().h_full().w(`${Math.min(100, pct).toFixed(1)}%`).rounded(3).bg(pc).transition("width", { duration: 300, easing: "ease-out" }))));
      out.push(this.note(t, turnsLeft != null ? `Grows ~${k(per)} per turn lately — about ${turnsLeft} more turn${turnsLeft === 1 ? "" : "s"} like that before it compacts.` : "Not growing lately."));
      for (const [i, b] of (d.in_ctx ?? []).slice(0, 4).entries()) out.push(this.row(t, `ov-c-${i}`, icon("wrench", 12, t.dim), `${b.tool} · ${b.label}`, `~${k(b.tok)}`, t.dim));
    }

    // Cache: what replying now vs later costs.
    const left = d.cache_until ? d.cache_until - d.now : null;
    if (d.agent !== "codex" && left != null && d.price && d.ctx) {
      const w = (d.cache_ttl ?? 300) >= 3600 ? 2 : 1.25;
      const now = (d.ctx * d.price.read) / 1e6, later = (d.ctx * d.price.in * w) / 1e6;
      out.push(this.h(t, "Prompt cache", left > 0 ? `warm · ${dur(left)} left` : "expired"));
      out.push(this.note(t, left > 0
        ? `Reply before it expires: re-reading the context costs ~${money(now)}. After: rewriting it costs ~${money(later)}.`
        : `The next reply rewrites ~${k(d.ctx)} tokens: ~${money(later)} instead of ~${money(now)} while warm.`));
    }

    // Spend: the session total, the recent turns, and turns that cost far more than usual.
    const turns = (d.turns ?? []).filter((x) => x.sum?.cost != null);
    if (d.cost != null || turns.length) {
      const costs = turns.map((x) => x.sum.cost).sort((a, b) => a - b);
      const med = costs.length ? costs[Math.floor(costs.length / 2)] : 0;
      const recent = costs.reduce((n, v) => n + v, 0);
      out.push(this.h(t, "Spend", d.cost != null ? `session ${money(d.cost)}` : null));
      if (turns.length) out.push(this.note(t, `Last ${turns.length} turns ~${money(recent)} · typical turn ~${money(med)} (estimated from token prices).`));
      const odd = turns.map((x, i) => ({ x, i: (d.turns ?? []).indexOf(x) })).filter(({ x }) => med > 0 && x.sum.cost > med * 3).slice(0, 3);
      for (const { x, i } of odd) out.push(h_flex().id(`ov-odd-${i}`).px(SPACE.panel).py(4).gap(8).items_center().text_size(TS.meta).cursor_pointer().rounded(6)
        .hover((e) => e.bg(t.hover)).tooltip("Open this turn in Trace")
        .on_click((_e, cx) => { this.tab = "trace"; this.open = new Set([i]); localStorage.setItem("tab", "trace"); cx.notify(); })
        .child(div().flex_none().text_color(st.working).child(`${(x.sum.cost / med).toFixed(1)}×`))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(x.prompt))
        .child(div().flex_none().text_color(t.dim).child(money(x.sum.cost))));
    }

    // Subagents still around.
    const subs = d.subagents ?? [];
    if (subs.length) {
      out.push(this.h(t, "Subagents", subs.length));
      for (const [i, s] of subs.slice(-6).reverse().entries()) out.push(this.row(t, `ov-s-${i}`, statusMark(t, s.finished ? "done" : "working", { size: 10 }), s.desc || s.type || "agent", `${s.tools} tools · ${k(s.out)} out`));
    }
    // Quiet notes that aren't problems.
    const notes = [...(d.issues ?? [])].filter((i) => i.level === "info" && !["skills", "mcp"].includes(i.kind));
    if (notes.length) {
      out.push(this.h(t, "Notes", notes.length));
      for (const n of notes) out.push(this.note(t, n.text));
    }
    return out;
  }

  // ---------- Capabilities: skills, MCP, tools ----------
  capabilities(t, d) {
    const seg = (id, label) => div().id(`cap-${id}`).px(8).py(2).rounded(6).text_size(TS.small).cursor_pointer()
      .text_color(this.cap === id ? t.foreground : t.muted).when(this.cap === id, (e) => e.bg(t.selected))
      .hover((e) => e.bg(this.cap === id ? t.selected : t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { this.cap = id; localStorage.setItem("cap", id); cx.notify(); }).child(label);
    const sk = d.config?.skills ?? {}, mt = d.config?.mcp?.totals ?? {};
    const out = [h_flex().px(SPACE.panel - 2).pt(10).gap(4)
      .child(seg("skills", `Skills ${(sk.used ?? []).filter((u) => u.count > 0).length}/${sk.available ?? 0}`))
      .child(seg("mcp", `MCP ${mt.connected ?? 0}`))
      .child(seg("tools", `Tools ${(d.tools ?? []).length}`))];
    return [...out, ...(this.cap === "mcp" ? this.mcp(t, d) : this.cap === "tools" ? this.tools(t, d) : this.skills(t, d))];
  }

  tools(t, d) {
    const out = [this.h(t, "Tools used", "calls · avg · context added")];
    if (!(d.tools ?? []).length) out.push(this.note(t, "No tool calls yet."));
    for (const [i, x] of (d.tools ?? []).entries()) out.push(h_flex().id(`tl-${i}`).px(SPACE.panel).py(4).gap(8).items_center().text_size(TS.meta)
      .child(icon(x.name.startsWith("mcp__") ? "plug" : x.name === "Agent" || x.name === "Task" ? "bot" : "wrench", 12, x.errors ? C(t).status.blocked : t.dim))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(x.name.startsWith("mcp__") ? x.name.split("__").slice(1).join(" · ") : x.name))
      .child(div().flex_none().text_color(t.dim).child(`${x.calls}×`))
      .child(div().flex_none().w(48).text_right().text_color(x.avg_ms > 10000 ? C(t).status.working : t.dim).child(ms(x.avg_ms)))
      .when(x.errors > 0, (e) => e.child(div().flex_none().text_color(C(t).status.blocked).child(`${x.errors} err`)))
      .child(div().flex_none().w(44).text_right().text_color(x.result_tok > 20000 ? C(t).status.working : t.dim).child(`~${k(x.result_tok)}`)));
    if ((d.big ?? []).length) {
      out.push(this.h(t, "Biggest results", "tokens"));
      for (const [i, b] of d.big.slice(0, 6).entries()) out.push(this.row(t, `tl-b-${i}`, icon("wrench", 12, t.dim), `${b.tool} · ${b.label}`, `~${k(b.tok)}`));
    }
    out.push(this.note(t, "Result sizes are estimates (characters ÷ 4)."));
    return out;
  }

  config(t, d) {
    const c = d.config ?? {};
    const st = C(t).status;
    const out = [];
    // Things that rarely change: one line each, no tables.
    out.push(this.h(t, "Session"));
    out.push(this.note(t, [d.model_name || d.model, c.effort ? `effort ${c.effort}` : null, `${c.permission_mode || "default"} mode`, c.output_style ? `${c.output_style} style` : null,
      c.cli_version ? `${d.agent === "codex" ? "codex" : "claude"} ${c.cli_version}` : null].filter(Boolean).join(" · ")));
    out.push(this.note(t, `System prompt ~${k(c.system_prompt_tok)} · context at the first reply ${k(d.first_ctx)}${c.agent_types ? ` · ${c.agent_types} subagent types` : ""}`));
    out.push(this.h(t, "Memory & rules", c.memory?.length ? `~${k(c.memory_tok)} tokens` : null));
    if (!c.memory?.length) out.push(this.note(t, "No CLAUDE.md / AGENTS.md / rules loaded."));
    for (const [i, m] of (c.memory ?? []).entries()) out.push(this.row(t, `c-m-${i}`, icon("file", 12, t.dim), m.path, `~${k(m.tokens)} · ${m.how}`));
    if (d.agent === "codex") { out.push(this.note(t, "Codex sessions don't record hooks or MCP servers in their log.")); return out; }
    // Hooks by what they are, not their command line (the full command is in the tooltip).
    const groups = new Map();
    for (const x of c.hooks ?? []) {
      const key = `${x.label}|${x.src}`;
      const g = groups.get(key) ?? { label: x.label, src: x.src, events: new Set(), runs: 0, errors: 0, timeouts: 0, total: 0, full: x.full };
      g.events.add(x.event); g.runs += x.runs; g.errors += x.errors; g.timeouts += x.timeouts; g.total += (x.avg_ms ?? 0) * x.runs;
      groups.set(key, g);
    }
    const hooks = [...groups.values()].sort((a, b) => (b.errors + b.timeouts) - (a.errors + a.timeouts) || b.runs - a.runs);
    out.push(this.h(t, "Hooks", hooks.length || null));
    if (!hooks.length) out.push(this.note(t, "No hooks ran in this session."));
    for (const [i, g] of hooks.entries()) {
      const bad = g.errors + g.timeouts;
      out.push(h_flex().id(`c-h-${i}`).px(SPACE.panel).py(5).gap(8).items_center().text_size(TS.meta).rounded(6).hover((e) => e.bg(t.hover))
        .tooltip(`${[...g.events].join(", ")}\n${g.full ?? ""}`)
        .child(div().size(7).rounded(4).flex_none().bg(bad ? st.blocked : C(t).ok))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(h_flex().gap(6).items_center().min_w(0)
            .child(div().min_w(0).truncate().text_color(t.foreground).child(g.label))
            .child(div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(TS.tiny).text_color(t.dim).child(g.src)))
          .child(div().truncate().text_size(TS.tiny).text_color(t.dim).child([...g.events].join(" · "))))
        .child(div().flex_none().text_color(bad ? st.blocked : t.dim).child(`${g.runs}× · ${ms(Math.round(g.total / Math.max(1, g.runs)))}${g.errors ? ` · ${g.errors} err` : ""}${g.timeouts ? ` · ${g.timeouts} timeout` : ""}`)));
    }
    return out;
  }

  chip(t, id, text, color, tip, ic = null) {
    const el = h_flex().id(id).gap(2).items_center().px(5).rounded(4).flex_none().text_size(TS.tiny).text_color(color).border_1().border_color(t.border)
      .when(ic != null, (e) => e.child(icon(ic, 12, color))).child(text);
    return tip ? el.tooltip(tip) : el;
  }

  // Colors per span kind, shared by the waterfall, the split bar and the legend.
  kindColor(t, kd) { return C(t).kind[kd] ?? t.muted; }

  // One stacked bar from [{key, v, color}] plus a legend underneath.
  stack(t, id, parts, fmt) {
    const total = parts.reduce((n, p) => n + p.v, 0) || 1;
    const shown = parts.filter((p) => p.v > 0);
    return v_flex().gap(4)
      .child(h_flex().id(id).h(6).rounded(3).overflow_hidden().bg(t.surface).children(shown.map((p, i) =>
        div().h_full().flex_grow(p.v / total).flex_shrink(0).flex_basis(0).bg(p.color).when(i > 0, (e) => e.ml(1)))))
      .child(h_flex().gap(10).flex_wrap().text_size(TS.tiny).text_color(t.dim).children(shown.map((p) =>
        h_flex().gap(4).items_center().child(div().size(6).rounded(3).bg(p.color)).child(`${p.key} ${fmt(p)}`))));
  }

  turnSummary(t, tu) {
    const s = tu.sum ?? {};
    const bits = [ms(tu.ms)];
    if (s.calls != null) bits.push(`${s.calls} LLM call${s.calls === 1 ? "" : "s"}`);
    bits.push(`${s.tools ?? tu.steps.filter((x) => x.k === "tool" || x.k === "agent").length} tool${s.tools === 1 ? "" : "s"}`);
    if (s.calls) bits.push(`in ${k(s.in_new)} new + ${k(s.in_cached)} cached${s.hit != null ? ` (${Math.round(s.hit)}%)` : ""}`);
    bits.push(`out ${k(s.out ?? tu.out)}`);
    if (s.cost != null) bits.push(`~$${s.cost < 0.01 ? s.cost.toFixed(3) : s.cost.toFixed(2)}`);
    return h_flex().flex_wrap().text_size(TS.small).text_color(t.dim)
      .children(bits.map((b, j) => div().flex_none().child(j ? ` · ${b}` : b)))
      .when(s.errors > 0, (el) => el.child(div().text_color(t.blocked).child(` · ${s.errors} error${s.errors > 1 ? "s" : ""}`)))
      .when(s.misses > 0, (el) => el.child(div().text_color(t.working).tooltip("A call re-read much less from the prompt cache than the one before").child(` · ${s.misses} cache miss`)));
  }

  callDetail(t, c, pad) {
    const out = [];
    const line = (txt, color) => div().pl(pad).pr(SPACE.panel).text_size(TS.small).text_color(color ?? t.muted).truncate().child(txt);
    out.push(line(`${c.model ?? ""}${c.effort ? ` · effort ${c.effort}` : ""}${c.ttl ? ` · cache ${c.ttl}` : ""}${c.cost != null ? ` · ~$${c.cost.toFixed(3)}` : ""}`, t.dim));
    out.push(line(`in ${k(c.new)} new · ${k(c.cache_write)} cache write · ${k(c.cache_read)} cache read${c.hit != null ? ` (${Math.round(c.hit)}%)` : ""} · out ${k(c.out)}${c.think ? ` (${k(c.think)} thinking)` : ""}`, c.miss ? t.working : t.dim));
    if (c.comp) {
      const cp = c.comp;
      out.push(div().pl(pad).pr(SPACE.panel).pt(4).pb(2).child(this.stack(t, `comp-${c.at}`, [
        { key: "system", v: cp.system, color: C(t).kind.system },
        { key: `tools (${cp.n_tools})`, v: cp.tools, color: C(t).kind.tool },
        { key: "memory", v: cp.memory, color: C(t).kind.memory },
        { key: "history", v: cp.history, color: C(t).kind.history },
        { key: "new", v: cp.new, color: C(t).kind.new },
      ], (p) => `~${k(p.v)}`)));
    }
    // An indented sub-line with a leading icon (or a blank slot of the same width).
    const sub = (ic, txt, color) => h_flex().pl(pad + 8).pr(SPACE.panel).gap(4).items_center().text_size(TS.small).text_color(color ?? t.muted)
      .child(ic ? icon(ic, 12, t.dim) : div().w(12).flex_none()).child(div().flex_1().min_w(0).truncate().child(txt));
    out.push(line("Sent (new since the last call):", t.dim));
    for (const x of c.sent) out.push(sub("corner-down-right", x.k === "tool_result" ? `${x.name} result · ~${k(x.tok)}${x.err ? " · error" : ""}` : x.k === "you" ? `message · ~${k(x.tok)} · ${x.snip}` : x.k === "reminder" ? `system reminder · ~${k(x.tok)}` : `${x.k} · ~${k(x.tok)}${x.snip ? ` · ${x.snip}` : ""}`, x.err ? t.blocked : t.muted));
    if (!c.sent.length) out.push(sub(null, "(nothing new — same prefix, continued)", t.dim));
    if (c.unrecorded) out.push(sub("corner-down-right", `${c.unrecorded} more not recorded in the transcript`, t.dim));
    out.push(line("Got:", t.dim));
    for (const g of c.got) out.push(g.k === "tool" ? sub("wrench", `${g.name}${g.label ? ` · ${g.label}` : ""}`, t.foreground) : sub(null, `${g.k === "text" ? "reply" : g.k}${g.chars ? ` · ${k(g.chars / 4)} tok` : ""}`, t.muted));
    return out;
  }

  waterfall(t, tu, i) {
    const out = [];
    const total = Math.max(0.001, tu.ms / 1000);
    const width = this.width ?? 440;
    const labelW = width >= 640 ? 190 : width >= 480 ? 130 : 104;
    const durW = 44;
    const trackW = Math.max(60, width - SPACE.panel * 2 - labelW - durW - 16);
    const x = (sec) => Math.round((Math.min(sec, total) / total) * trackW);
    const sp = tu.split;
    if (sp) out.push(div().px(SPACE.panel).pt(6).pb(4).child(this.stack(t, `split-${i}`, [
      { key: "model", v: sp.model, color: this.kindColor(t, "llm") },
      { key: "tools", v: sp.tools, color: this.kindColor(t, "tool") },
      { key: "waiting for you", v: sp.you ?? 0, color: this.kindColor(t, "wait") },
      { key: "other", v: sp.other, color: this.kindColor(t, "other") },
    ], (p) => `${dur(p.v)} · ${Math.round((p.v / total) * 100)}%`)));
    // Axis: 0 … total, with a mid tick.
    out.push(h_flex().px(SPACE.panel).gap(8).text_size(TS.tiny).text_color(t.dim)
      .child(div().w(labelW).flex_none())
      .child(h_flex().w(trackW).flex_none().justify_between().child("0").child(dur(total / 2)).child(dur(total)))
      .child(div().w(durW).flex_none()));
    const ICON = { llm: "sparkles", tool: "wrench", agent: "bot", skill: "zap", hook: "flag", wait: "hourglass" };
    for (const [j, s] of (tu.spans ?? []).entries()) {
      const key = `${i}:${s.k}:${j}`, open = this.openSpan.has(key);
      const color = s.err ? t.blocked : this.kindColor(t, s.k);
      const a = x(s.s), w = Math.max(2, x(s.e) - a);
      const got = (s.label ?? "").replace(/^thinking( → )?/, "");
      const name = s.k === "llm" ? `${s.name}${got ? ` → ${got.replace(/^reply → /, "")}` : ""}` : s.k === "tool" || s.k === "wait" ? `${s.name}${s.label ? ` · ${s.label}` : ""}` : s.name;
      const tip = `${s.name}${s.label ? ` — ${s.label}` : ""}\n${dur(s.s)} → ${dur(s.e)} (${dur(s.e - s.s)})${s.tok != null ? `\n~${k(s.tok)} tokens back` : ""}${s.perm ? `\npermission: ${s.perm}` : ""}${s.open ? "\nstill running" : ""}`;
      out.push(h_flex().id(`wf-${key}`).px(SPACE.panel).h(20).gap(8).items_center().cursor_pointer().rounded(4).hover((e) => e.bg(t.hover)).tooltip(tip)
        .on_click((_e, cx) => { open ? this.openSpan.delete(key) : this.openSpan.add(key); cx.notify(); })
        .child(h_flex().w(labelW).flex_none().gap(4).items_center().text_size(TS.small)
          .child(ICON[s.k] ? icon(ICON[s.k], 12, color) : div().flex_none().w(12).text_color(color).child("·"))
          .child(div().flex_1().min_w(0).truncate().text_color(s.k === "llm" ? t.foreground : t.muted).child(name)))
        .child(div().relative().w(trackW).h(20).flex_none()
          .child(div().absolute().left(0).right(0).top(10).h(1).bg(t.border).opacity(0.5))
          .child(div().absolute().left(a).top(5).w(w).h(10).rounded(3).bg(color).opacity(s.open ? 0.5 : 0.85)
            .when(Boolean(s.open), (e) => e.loop("opacity", { from: 0.3, to: 0.8, period: 1400 }))))
        .child(div().w(durW).flex_none().text_right().text_size(TS.small).text_color((s.e - s.s) > 20 ? t.working : t.dim).child(dur(s.e - s.s))));
      if (open) {
        const pad = SPACE.panel + 14;
        if (s.k === "llm" && tu.calls?.[s.call]) out.push(...this.callDetail(t, tu.calls[s.call], pad));
        else {
          const line = (txt, c2) => div().pl(pad).pr(SPACE.panel).text_size(TS.small).text_color(c2 ?? t.muted).child(txt);
          if (s.label) out.push(line(s.label));
          out.push(line([`${dur(s.s)} → ${dur(s.e)}`, s.tok != null ? `~${k(s.tok)} tokens back into context` : "", s.perm ? `permission ${s.perm}` : "", s.err ? "error" : ""].filter(Boolean).join(" · "), s.err ? t.blocked : t.dim));
        }
      }
    }
    // Events with no duration: compactions, failed hooks without timing.
    const misc = tu.steps.filter((s) => s.k === "compact");
    for (const [j, s] of misc.entries()) out.push(h_flex().id(`ev-${i}-${j}`).px(SPACE.panel).pl(SPACE.panel + labelW + 8).gap(4).items_center().text_size(TS.small).text_color(t.working)
      .child(icon("fold-vertical", 12, t.working)).child(`context compacted${s.label ? ` from ${k(Number(s.label))}` : ""}`));
    return out;
  }

  trace(t, d) {
    const turns = d.turns ?? [];
    const costs = turns.map((x) => x.sum?.cost).filter((v) => v != null).sort((a, b) => a - b);
    const med = costs.length ? costs[Math.floor(costs.length / 2)] : 0;
    const hit = { all: () => true, errors: (x) => (x.sum?.errors ?? 0) > 0 || x.steps.some((s) => s.error), skills: (x) => x.skills?.length || x.missed?.length,
      pricey: (x) => med > 0 && (x.sum?.cost ?? 0) > med * 3 };
    const count = (f) => turns.filter(hit[f]).length;
    const pill = (id, label) => { const on = this.filter === id; return div().id(`tr-${id}`).px(8).py(2).rounded(10).border_1().border_color(t.border).text_size(TS.small).cursor_pointer()
      .text_color(on ? t.foreground : t.muted).when(on, (e) => e.bg(t.selected)).hover((x) => x.bg(on ? t.selected : t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { this.filter = id; cx.notify(); }).child(label); };
    const cost = costs.reduce((n, v) => n + v, 0);
    const out = [this.h(t, "Turns", `last ${turns.length} of ${d.prompt_count}${cost ? ` · ~${money(cost)}` : ""}`),
      h_flex().px(SPACE.panel - 8).pb(4).gap(4).flex_wrap()
        .child(pill("all", "All"))
        .child(pill("errors", `Errors ${count("errors")}`))
        .child(pill("pricey", `Costly ${count("pricey")}`))
        .child(pill("skills", `Skills ${count("skills")}`))];
    for (const [i, tu] of turns.entries()) {
      if (!hit[this.filter](tu)) continue;
      const ratio = med > 0 && tu.sum?.cost != null ? tu.sum.cost / med : 0;
      const open = this.open.has(i);
      out.push(v_flex().id(`tu-${i}`).mx(SPACE.panel - 8).px(8).py(6).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).gap(2)
        .when(open, (e) => e.bg(t.surface))
        .on_click((_e, cx) => { open ? this.open.delete(i) : this.open.add(i); cx.notify(); })
        .child(h_flex().gap(6).items_center().text_size(TS.body)
          .child(h_flex().flex_none().gap(2).items_center().text_color(t.dim).child(icon(open ? "chevron-down" : "chevron-right", 12, t.dim)).child(clock(tu.at)))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(tu.prompt || "(empty)"))
          .when(ratio > 3, (e) => e.child(div().flex_none().px(5).rounded(4).bg(tint(C(t).status.working)).text_size(TS.tiny).text_color(C(t).status.working)
            .tooltip(`This turn cost ${ratio.toFixed(1)}× a typical turn`).child(`${ratio.toFixed(1)}×`))))
        .child(div().pl(SPACE.panel + 2).child(this.turnSummary(t, tu)))
        .when(Boolean(tu.skills?.length || tu.missed?.length), (el) => el.child(h_flex().pl(SPACE.panel + 2).pt(2).gap(4).flex_wrap()
          .children((tu.skills ?? []).map((s, j) => this.chip(t, `tsk-${i}-${j}`, `${s.how === "you" ? "/" : ""}${s.name}${s.tok ? ` ~${k(s.tok)}` : ""}`,
            s.ok === false ? t.blocked : t.accent, `Skill ${s.name} loaded ${HOW[s.how] ?? s.how}${s.tok ? `, ~${k(s.tok)} tokens of instructions` : ""}${s.ok === false ? " — failed" : ""}`, "zap")))
          .children((tu.missed ?? []).map((n, j) => this.chip(t, `tms-${i}-${j}`, `? ${n}`, t.working, `This prompt asks to use ${n}, but the agent didn't load it this turn.`))))));
      if (!open) continue;
      if ((tu.spans ?? []).length) out.push(...this.waterfall(t, tu, i), div().h(8));
      else {
        // Codex (or no request records): the plain step list.
        for (const [j, s] of tu.steps.entries()) out.push(h_flex().id(`st-${i}-${j}`).px(SPACE.panel).pl(SPACE.panel + 14).py(1).gap(6).items_center().text_size(TS.small)
          .child(icon(s.k === "think" ? "brain" : "wrench", 12, s.error ? t.blocked : t.dim))
          .child(div().flex_none().text_color(s.error ? t.blocked : t.muted).child(s.name))
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(s.label ?? ""))
          .child(div().flex_none().text_color(t.dim).child(ms(s.ms))));
        out.push(div().h(8));
      }
    }
    return out;
  }

  skills(t, d) {
    const sk = d.config?.skills ?? {};
    const used = (sk.used ?? []).filter((u) => u.count > 0 || u.restored > 0);
    const out = [];
    out.push(v_flex().px(SPACE.panel).pt(12).gap(2)
      .child(div().text_size(TS.body).text_color(t.foreground).child(`${used.filter((u) => u.count > 0).length} skills loaded in this session`))
      .child(div().text_size(TS.small).text_color(t.dim).child(`${sk.available ?? 0} listed — their descriptions cost ~${k(sk.available_tok)} tokens on every turn; a skill's full instructions enter context only when it loads.`)));
    out.push(this.h(t, "Loaded", used.length || "none"));
    if (!used.length) out.push(this.note(t, "No skill was loaded. The agent only saw the list of names and descriptions."));
    for (const [i, u] of used.entries()) out.push(h_flex().id(`sk-u-${i}`).px(SPACE.panel).py(4).gap(8).items_center().text_size(TS.meta)
      .child(icon("zap", 12, u.failed ? t.blocked : t.accent))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_color(t.foreground).child(u.name))
        .child(div().truncate().text_size(TS.tiny).text_color(t.dim).child([u.count ? `${u.count}× ${u.how.map((h) => HOW[h] ?? h).join(", ")}` : "", u.restored ? `restored ${u.restored}× after compaction` : "", u.failed ? `${u.failed} failed` : "", u.last ? `last ${clock(u.last)}` : ""].filter(Boolean).join(" · "))))
      .child(div().flex_none().text_color(u.tok > 20000 ? t.working : t.dim).tooltip("Size of the skill's instructions when loaded (characters ÷ 4)").child(u.tok ? `~${k(u.tok)}` : "–")));
    out.push(this.h(t, "Timeline", (sk.events ?? []).length ? "newest first" : null));
    if (!(sk.events ?? []).length) out.push(this.note(t, "Nothing yet."));
    for (const [i, e] of (sk.events ?? []).entries()) out.push(h_flex().id(`sk-e-${i}`).px(SPACE.panel).py(4).gap(8).items_center().text_size(TS.small)
      .tooltip(`${e.name} — ${HOW[e.how] ?? e.how}${e.args ? `\nargs: ${e.args}` : ""}${e.allowed?.length ? `\nallowed tools: ${e.allowed.join(", ")}` : ""}${e.error ? `\nerror: ${e.error}` : ""}\nprompt: ${e.prompt ?? ""}`)
      .child(div().flex_none().w(36).text_color(t.dim).child(clock(e.at)))
      .child(div().flex_none().max_w(150).truncate().text_color(e.ok === false ? t.blocked : t.accent).child(`${e.how === "you" ? "/" : ""}${e.name}`))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(e.prompt ? `“${e.prompt}”` : ""))
      .child(div().flex_none().text_color(t.dim).child(e.ok === false ? "failed" : e.tok ? `~${k(e.tok)}` : "")));
    if ((sk.missed ?? []).length) {
      out.push(this.h(t, "Asked for but not loaded", sk.missed.length));
      out.push(this.note(t, "You asked to use these (as /name, or “use / 用 / run <name>”), but the agent didn't load them in that turn. Just mentioning a skill doesn't count."));
      for (const [i, m] of sk.missed.entries()) out.push(this.row(t, `sk-m-${i}`, "?", m.name, `${m.turns} prompt${m.turns > 1 ? "s" : ""}`, t.working));
    }
    const subs = (d.subagents ?? []).filter((s) => s.skills?.length);
    if (subs.length) {
      out.push(this.h(t, "In subagents", subs.length));
      for (const [i, s] of subs.entries()) out.push(this.row(t, `sk-s-${i}`, icon("bot", 12, t.accent), s.desc || s.type || "agent", s.skills.join(", "), t.accent));
    }
    return out;
  }

  mcp(t, d) {
    const m = d.config?.mcp ?? {};
    if (d.agent === "codex") return [this.note(t, "Codex sessions don't record MCP servers in their log.")];
    const tot = m.totals ?? {};
    const out = [v_flex().px(SPACE.panel).pt(12).gap(2)
      .child(div().text_size(TS.body).text_color(t.foreground).child(`${tot.servers ?? 0} MCP servers · ${tot.connected ?? 0} connected · ${tot.tools ?? 0} tools`))
      .child(div().text_size(TS.small).text_color(t.dim).child(`${tot.loaded ?? 0} tools loaded with full schemas, ${tot.called ?? 0} used (${tot.calls ?? 0} calls). ~${k(tot.context_tok)} tokens of context: instructions + tool names + loaded schemas.`))];
    const st = C(t).status;
    const color = (s) => s.status === "failed" ? st.blocked : s.status === "needs auth" || s.status === "pending" ? st.working : s.calls ? st.done : t.dim;
    out.push(this.h(t, "Servers", "tools · loaded · calls"));
    for (const [i, s] of (m.servers ?? []).entries()) {
      const open = this.openSrv.has(s.key);
      const ctx = s.instr_tok + s.list_tok + s.def_tok;
      out.push(h_flex().id(`mc-${i}`).px(SPACE.panel).py(4).gap(8).items_center().text_size(TS.meta).cursor_pointer().hover((x) => x.bg(t.hover))
        .on_click((_e, cx) => { open ? this.openSrv.delete(s.key) : this.openSrv.add(s.key); cx.notify(); })
        .child(div().w(7).h(7).rounded(4).flex_none().bg(color(s)))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().text_color(t.foreground).child(s.name))
          .child(div().truncate().text_size(TS.tiny).text_color(s.status === "connected" ? t.dim : color(s)).child(s.status === "connected" ? (s.calls ? "used" : "connected, not used") : s.status)))
        .child(div().flex_none().text_color(t.muted).child(`${s.tools} · ${s.loaded} · ${s.calls}`))
        .child(div().flex_none().w(44).text_right().text_color(ctx > 2000 ? t.working : t.dim).tooltip("Context this server costs (approx.)").child(`~${k(ctx)}`)));
      if (open) {
        const sub = (txt) => div().pl(SPACE.panel + 27).pr(SPACE.panel).py(1).text_size(TS.small).text_color(t.muted).child(txt);
        out.push(sub(`Context: ~${k(s.instr_tok)} instructions · ~${k(s.list_tok)} tool names · ~${k(s.def_tok)} schemas`));
        out.push(sub(`Tools: ${s.tools} available, ${s.upfront} loaded up front, ${s.loaded - s.upfront} loaded on demand, ${s.called} called${s.errors ? `, ${s.errors} errors` : ""}`));
        for (const x of s.top ?? []) out.push(h_flex().px(SPACE.panel).pl(SPACE.panel + 27).py(1).gap(8).items_center().text_size(TS.small)
          .child(h_flex().flex_1().min_w(0).gap(4).items_center().child(icon("wrench", 12, t.dim)).child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(x.tool)))
          .child(div().flex_none().text_color(t.dim).child(`${x.n}×`))
          .child(div().flex_none().w(52).text_right().text_color(x.avg_ms > 5000 ? t.working : t.dim).tooltip("Average time from call to result").child(x.avg_ms != null ? ms(x.avg_ms) : "–"))
          .child(div().flex_none().w(52).text_right().text_color(x.errors ? t.blocked : t.dim).tooltip("Calls that returned an error").child(x.errors ? `${Math.round((x.errors / x.n) * 100)}% err` : "0 err")));
        if (s.status === "needs auth") out.push(sub("Only its sign-in tools are present: sign in (/mcp) to get the real tools."));
      }
    }
    for (const [i, s] of (m.pending ?? []).entries()) out.push(this.row(t, `mc-p-${i}`, "pending", s, null, t.working));
    out.push(this.note(t, "Most MCP tools are deferred: only their names sit in context until the agent loads a schema (ToolSearch). Click a server for details."));
    return out;
  }

  // Header: name, model line, three numbers. Drawn from agents() alone when there is no data yet, so a switch never shows a blank panel.
  head(t, d) {
    const a = agents().find((x) => x.address === this.addr);
    const name = agentName(a) || d?.name || d?.session?.slice(0, 8) || this.addr;
    const pct = d ? d.pct ?? (d.window ? (d.ctx / d.window) * 100 : null) : null;
    const st = C(t).status;
    const left = d?.cache_until ? d.cache_until - d.now : null;
    const tile = (label, value, color, tip) => this.stat(t, label, value ?? "–", color, tip);
    return [
      v_flex().px(SPACE.panel).pt(12).gap(2)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).text_size(TS.item).font_semibold().text_color(t.foreground).truncate().child(name))
          .child(this.widthToggle(t)))
        .child(div().text_size(TS.small).text_color(t.dim).truncate().child(d?.ok ? `${d.model_name || d.model || ""} · ${d.cwd} · ${d.prompt_count} prompts` : a?.cwd ?? " ")),
      h_flex().px(SPACE.panel).pt(8).gap(6)
        .child(tile("Context", pct != null ? `${Math.round(pct)}%` : d?.ok ? k(d.ctx) : null, pct >= 80 ? st.blocked : pct >= 60 ? st.working : null, d?.ok ? `${k(d.ctx)} of ${k(d.window)} tokens` : null))
        .child(tile("Session cost", d?.cost != null ? money(d.cost) : null, null, "This whole session so far (Claude Code status line)"))
        .child(d?.agent === "codex"
          ? tile("Cached in", k(d.cache_read), null, "Input tokens served from cache across the session")
          : tile("Cache", left == null ? null : left > 0 ? dur(left) : "expired", left != null && left <= 0 ? st.working : left != null ? st.done : null, `Prompt cache TTL ${(d?.cache_ttl ?? 300) / 60} min after the last reply`)),
    ];
  }

  tabs(t, d) {
    const problems = d?.ok ? this.needs(t, d).length : 0;
    return h_flex().px(SPACE.panel - 6).pt(8).border_b(1).border_color(t.border).children(TABS.map((id) => {
      const on = id === this.tab;
      return div().id(`tab-${id}`).px(6).py(5).text_size(TS.meta).cursor_pointer()
        .text_color(on ? t.foreground : t.dim).when(on, (el) => el.border_b(2).border_color(t.accent))
        .rounded_t(5).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { this.tab = id; localStorage.setItem("tab", id); cx.notify(); })
        .child(id === "overview" && problems ? `${TAB_LABEL[id]} · ${problems}` : TAB_LABEL[id]);
    }));
  }

  // Placeholder rows while the first read of an agent runs.
  skeleton(t) {
    const bar = (w) => div().h(10).w(`${w}%`).rounded(4).bg(t.surface).loop("opacity", { from: 0.45, to: 1, period: 1400 });
    return [v_flex().px(SPACE.panel).pt(16).gap(12).child(bar(70)).child(bar(90)).child(bar(55)).child(bar(80)).child(bar(40))];
  }

  content(t, d) {
    const note = (s) => [div().p(16).text_size(TS.body).text_color(t.dim).child(s)];
    if (!d) return this.skeleton(t);
    if (!d.ok) return note(d.error === "unsupported agent" ? `Inspector reads Claude Code and Codex sessions. This agent runs ${d.program || "something else"}.`
      : /transcript not found|session file not found/i.test(d.error ?? "") ? "Waiting for this agent's first prompt…" : `Unavailable: ${d.error}`);
    return this[this.tab]?.(t, d) ?? [];
  }

  render() {
    const t = theme();
    const d = this.data;
    const root = v_flex().id("agent-inspector").size_full().bg(t.chrome)
      .on_size_change((size, cx) => { if (Math.round(size.width) !== Math.round(this.width ?? 0)) { this.width = size.width; cx.notify(); } });
    if (!this.addr) return root.child(div().p(16).text_size(TS.body).text_color(t.dim).child("Select an agent to inspect it."));
    // Same element ids across agents, so the opacity change animates: a switch dims the old content, fresh data fades in.
    return root.child(v_flex().id("ai-scroll").flex_1().min_h(0).overflow_y_scrollbar()
      .children(this.head(t, d?.ok ? d : null))
      .child(this.tabs(t, d))
      .child(v_flex().id("ai-body").opacity(this.fade).transition("opacity", { duration: this.fade === 1 ? 180 : 90, easing: "ease-out" })
        .children(this.content(t, d)).child(div().h(16))));
  }
}
