// Agent inspector for the focused Claude Code agent. Four tabs, one per question:
//   Health  - what went wrong (hook errors/timeouts, tool errors, permission blocks, MCP failures, compactions)
//   Config  - what shapes it (memory/rules files, skills listed vs loaded, hooks, MCP servers, mode, style)
//   Trace   - what it did (per turn: thinking, tool calls with duration/size/permission, hooks, subagents)
//   Cost    - where tokens went (context, cost, cache, per tool, per turn, subagents)
// Data: ./inspect.py (local transcripts only).
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, focused, agents, theme } from "herdr";

const k = (n) => (n == null ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const ms = (v) => (v == null ? "" : v < 1000 ? `${v}ms` : v < 60000 ? `${(v / 1000).toFixed(1)}s` : `${Math.floor(v / 60000)}m${String(Math.round((v % 60000) / 1000)).padStart(2, "0")}s`);
const dur = (s) => ms(s == null ? null : Math.round(s * 1000));
const clock = (t) => { if (!t) return ""; const d = new Date(t * 1000); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const TABS = ["health", "config", "trace", "cost"];
const TAB_LABEL = { health: "Health", config: "Config", trace: "Trace", cost: "Cost" };

export default class AgentInspector extends View {
  init(_props, cx) {
    this.addr = null;
    this.data = null;
    this.tab = localStorage.getItem("tab") ?? "health";
    this.open = new Set(); // expanded turns in Trace
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
        const r = await exec("python3", [appHome() + "/mods/agent-inspector/inspect.py", addr], { timeout: 30000 });
        const d = JSON.parse(r.stdout || "{}");
        if (addr === this.addr) this.data = d;
      } catch (e) {
        if (addr === this.addr) this.data = { ok: false, error: String(e.message ?? e) };
      }
      this.busy = false;
      cx.notify();
    });
  }

  // ---------- small pieces ----------
  h(t, title, right) {
    return h_flex().px(14).pt(14).pb(6).gap(6).items_center().text_size(10.5).font_medium()
      .child(div().text_color(t.dim).child(title.toUpperCase())).child(div().flex_1())
      .when(right != null, (el) => el.child(div().text_color(t.dim).child(String(right))));
  }
  row(t, id, left, mid, right, color) {
    return h_flex().id(id).px(14).py(3).gap(8).items_center().text_size(11)
      .child(div().flex_none().text_color(color ?? t.muted).child(left))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(mid))
      .when(right != null, (el) => el.child(div().flex_none().text_color(t.dim).child(String(right))));
  }
  note(t, s) { return div().px(14).py(3).text_size(10.5).text_color(t.dim).child(s); }
  stat(t, label, value, color, tip) {
    const el = v_flex().id(`st-${label}`).flex_1().min_w(0).px(10).py(7).rounded(8).bg(t.surface).border(1).border_color(t.border).gap(1)
      .child(div().text_size(10).text_color(t.dim).child(label))
      .child(div().text_size(14).font_semibold().text_color(color ?? t.foreground).child(value));
    return tip ? el.tooltip(tip) : el;
  }
  lvlColor(t, l) { return l === "error" ? t.blocked : l === "warn" ? t.working : t.dim; }

  // ---------- derived alerts (live state) ----------
  liveIssues(t, d) {
    const out = [];
    const left = d.cache_until ? d.cache_until - d.now : null;
    if (d.pct >= 70) out.push({ level: "error", kind: "context", text: `Context ${Math.round(d.pct)}% full — /compact or start fresh before quality drops.` });
    else if (d.pct >= 50) out.push({ level: "warn", kind: "context", text: `Context ${Math.round(d.pct)}% — every turn re-reads ${k(d.ctx)} tokens.` });
    if (left != null && left <= 0 && d.ctx > 100000) out.push({ level: "warn", kind: "cache", text: `Prompt cache expired — next turn re-writes ~${k(d.ctx)} tokens at full price.` });
    const c = d.config ?? {};
    const unused = (c.skills?.available ?? 0) - (c.skills?.used?.length ?? 0);
    if (c.skills?.available > 50 && unused > 0) out.push({ level: "info", kind: "skills", text: `${c.skills.available} skills listed (~${k(c.skills.available_tok)} tokens every turn), ${c.skills.used.length} used in this session.` });
    const idleMcp = (c.mcp?.servers ?? []).filter((s) => !s.calls);
    if (idleMcp.length) out.push({ level: "info", kind: "mcp", text: `${idleMcp.length} MCP servers loaded but unused here (${idleMcp.map((s) => s.name).slice(0, 3).join(", ")}${idleMcp.length > 3 ? "…" : ""}).` });
    return out;
  }

  // ---------- tabs ----------
  health(t, d) {
    const all = [...this.liveIssues(t, d), ...(d.issues ?? [])];
    const order = { error: 0, warn: 1, info: 2 };
    all.sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3));
    const out = [this.h(t, "Problems", all.filter((i) => i.level !== "info").length || "none")];
    if (!all.length) out.push(this.note(t, "Nothing wrong detected in this session."));
    for (const [i, x] of all.entries()) out.push(h_flex().id(`is-${i}`).px(14).py(5).gap(8).items_start()
      .child(div().mt(4).w(7).h(7).rounded(4).flex_none().bg(this.lvlColor(t, x.level)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(11.5).text_color(t.foreground).child(x.text))
        .child(div().text_size(10).text_color(t.dim).child(`${x.kind}${x.count > 1 ? ` · ${x.count}×` : ""}${x.last ? ` · last ${clock(x.last)}` : ""}`))));
    return out;
  }

  config(t, d) {
    const c = d.config ?? {};
    const out = [];
    out.push(this.h(t, "Session"));
    out.push(this.row(t, "c-model", "Model", d.model_name || d.model || "–"));
    out.push(this.row(t, "c-mode", d.agent === "codex" ? "Approval · sandbox" : "Permission mode", c.permission_mode || "default"));
    if (c.effort) out.push(this.row(t, "c-effort", "Reasoning effort", c.effort));
    if (c.cli_version) out.push(this.row(t, "c-cli", "CLI", `${d.agent === "codex" ? "codex" : "claude"} ${c.cli_version}${c.originator ? ` · started by ${c.originator}` : ""}`));
    if (c.output_style) out.push(this.row(t, "c-style", "Output style", c.output_style));
    out.push(this.row(t, "c-sys", "System prompt", `~${k(c.system_prompt_tok)} tokens`));
    out.push(this.row(t, "c-base", "Baseline context", `${k(d.first_ctx)} tokens at the first reply`));
    out.push(this.h(t, "Memory & rules", c.memory?.length ? `~${k(c.memory_tok)} tok` : 0));
    if (!c.memory?.length) out.push(this.note(t, "No CLAUDE.md / AGENTS.md / rules loaded."));
    for (const [i, m] of (c.memory ?? []).entries()) out.push(this.row(t, `c-m-${i}`, m.type ?? "", m.path, `~${k(m.tokens)} · ${m.how}`));
    const sk = c.skills ?? {};
    out.push(this.h(t, "Skills", `${sk.used?.length ?? 0} loaded / ${sk.available ?? 0} listed`));
    out.push(this.note(t, `Listing all ${sk.available ?? 0} skill descriptions costs ~${k(sk.available_tok)} tokens of context on every turn.`));
    if (!sk.used?.length) out.push(this.note(t, "No skill was loaded in this session."));
    for (const [i, s] of (sk.used ?? []).entries()) out.push(this.row(t, `c-s-${i}`, `${s.count}×`, s.name, s.tokens ? `~${k(s.tokens)} tok` : null, t.accent));
    const hooks = c.hooks ?? [];
    if (d.agent === "codex") { out.push(this.note(t, "Codex sessions don't record hooks or MCP servers in their log.")); return out; }
    out.push(this.h(t, "Hooks that ran", hooks.length));
    for (const [i, x] of hooks.entries()) {
      const bad = x.errors || x.timeouts;
      out.push(h_flex().id(`c-h-${i}`).px(14).py(3).gap(8).items_center().text_size(11)
        .child(div().w(6).h(6).rounded(3).flex_none().bg(bad ? t.blocked : t.done))
        .child(div().flex_none().w(96).truncate().text_color(t.muted).child(x.event))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(x.cmd))
        .child(div().flex_none().text_color(bad ? t.blocked : t.dim).child(`${x.runs}× · avg ${ms(x.avg_ms)}${x.errors ? ` · ${x.errors} err` : ""}${x.timeouts ? ` · ${x.timeouts} timeout` : ""}${x.injected ? ` · injected ${x.injected}` : ""}`)));
    }
    const mcp = c.mcp ?? {};
    out.push(this.h(t, "MCP servers", `${(mcp.servers ?? []).length}${mcp.deferred_tools ? ` · ${mcp.deferred_tools} deferred tools` : ""}`));
    for (const [i, s] of (mcp.servers ?? []).entries()) out.push(this.row(t, `c-p-${i}`, s.calls ? `${s.calls} calls` : "unused", s.name, s.instr_tok ? `~${k(s.instr_tok)} tok instructions` : null, s.calls ? t.done : t.dim));
    for (const [i, s] of (mcp.failed ?? []).entries()) out.push(this.row(t, `c-pf-${i}`, "failed", s, null, t.blocked));
    if (c.agent_types) out.push(this.note(t, `${c.agent_types} subagent types available.`));
    return out;
  }

  trace(t, d) {
    const out = [this.h(t, "Turns", `${d.prompt_count} total`)];
    for (const [i, tu] of (d.turns ?? []).entries()) {
      const open = this.open.has(i);
      const tools = tu.steps.filter((s) => s.k === "tool" || s.k === "agent");
      const errs = tu.steps.filter((s) => s.error).length;
      out.push(v_flex().id(`tu-${i}`).mx(10).px(8).py(6).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).gap(2)
        .on_click((_e, cx) => { open ? this.open.delete(i) : this.open.add(i); cx.notify(); })
        .child(h_flex().gap(6).text_size(11.5)
          .child(div().flex_none().text_color(t.dim).child(`${open ? "▾" : "▸"} ${clock(tu.at)}`))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(tu.prompt || "(empty)")))
        .child(h_flex().gap(8).pl(14).text_size(10.5).text_color(t.dim)
          .child(div().child(ms(tu.ms)))
          .child(div().text_color(tu.ctx_delta > 20000 ? t.working : t.dim).child(`${tu.ctx_delta >= 0 ? "+" : ""}${k(tu.ctx_delta)} ctx`))
          .child(div().child(`${k(tu.out)} out`))
          .child(div().child(`${tools.length} tools`))
          .when(tu.hooks > 0, (el) => el.child(div().child(`${tu.hooks} hooks`)))
          .when(errs > 0, (el) => el.child(div().text_color(t.blocked).child(`${errs} errors`)))));
      if (open) for (const [j, s] of tu.steps.entries()) {
        const color = s.error ? t.blocked : s.k === "think" ? t.dim : s.k === "agent" ? t.accent : s.k === "hook" ? t.working : s.k === "compact" ? t.working : t.muted;
        const icon = { think: "◌", tool: "▸", agent: "◆", hook: "⚑", compact: "⇣" }[s.k] ?? "·";
        out.push(h_flex().id(`st-${i}-${j}`).pl(34).pr(14).py(1).gap(6).items_center().text_size(10.5)
          .child(div().flex_none().text_color(color).child(`${icon} ${s.name}`))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(s.label ?? ""))
          .when(Boolean(s.perm) && !String(s.perm).startsWith("accept:config"), (el) => el.child(div().flex_none().text_color(String(s.perm).startsWith("reject") ? t.blocked : t.dim).child(s.perm)))
          .when(s.tok != null, (el) => el.child(div().flex_none().text_color(s.tok > 5000 ? t.working : t.dim).child(`~${k(s.tok)}`)))
          .child(div().flex_none().w(44).text_right().text_color(t.dim).child(ms(s.ms))));
      }
    }
    return out;
  }

  cost(t, d) {
    const out = [];
    out.push(this.h(t, "Tokens by tool result", "context added"));
    for (const [i, x] of (d.tools ?? []).slice(0, 10).entries()) out.push(this.row(t, `co-t-${i}`, `~${k(x.result_tok)}`, x.name, `${x.calls}× · avg ${ms(x.avg_ms)}${x.errors ? ` · ${x.errors} err` : ""}`, x.result_tok > 20000 ? t.working : t.muted));
    out.push(this.h(t, "Biggest single outputs"));
    for (const [i, b] of (d.big ?? []).entries()) out.push(this.row(t, `co-b-${i}`, `~${k(b.tok)}`, `${b.tool} · ${b.label}`, null, b.tok > 10000 ? t.working : t.muted));
    out.push(this.h(t, "Per turn", "context added · output"));
    for (const [i, tu] of (d.turns ?? []).slice(0, 10).entries()) out.push(this.row(t, `co-u-${i}`, `${tu.ctx_delta >= 0 ? "+" : ""}${k(tu.ctx_delta)}`, tu.prompt, `${k(tu.out)} out`, tu.ctx_delta > 20000 ? t.working : t.muted));
    if ((d.subagents ?? []).length) {
      out.push(this.h(t, "Subagents", d.subagents.length));
      for (const [i, s] of d.subagents.entries()) out.push(this.row(t, `co-s-${i}`, `${k(s.out)} out`, s.desc || s.type || "agent", `${s.tools} tools · ctx ${k(s.ctx)}`, s.finished ? t.done : t.working));
    }
    if ((d.compactions ?? []).length) {
      out.push(this.h(t, "Compactions", d.compactions.length));
      for (const [i, c] of d.compactions.entries()) out.push(this.row(t, `co-c-${i}`, clock(c.at), `from ${k(c.pre)} tokens`, c.trigger));
    }
    out.push(this.h(t, "Session totals"));
    out.push(this.row(t, "co-o", "Output", `${k(d.out)} tokens written`));
    out.push(this.row(t, "co-r", "Cache read", `${k(d.cache_read)} tokens re-read across all turns`));
    out.push(this.row(t, "co-w", "Cache write", `${k(d.cache_write)} tokens written to cache`));
    out.push(this.note(t, "Token sizes of tool outputs are estimates (characters ÷ 4)."));
    return out;
  }

  body(t) {
    const d = this.data;
    const note = (s) => [div().p(16).text_size(12).text_color(t.dim).child(s)];
    if (!this.addr) return note("Select an agent to inspect it.");
    if (!d) return note("Reading the session…");
    if (!d.ok) return note(d.error === "unsupported agent" ? `Inspector reads Claude Code and Codex sessions. This agent runs ${d.program || "something else"}.` : `Unavailable: ${d.error}`);
    const pct = d.pct ?? (d.window ? (d.ctx / d.window) * 100 : null);
    const pctColor = pct >= 80 ? t.blocked : pct >= 60 ? t.working : t.foreground;
    const left = d.cache_until ? d.cache_until - d.now : null;
    const problems = [...this.liveIssues(t, d), ...(d.issues ?? [])].filter((i) => i.level === "error" || i.level === "warn").length;
    const head = [
      v_flex().px(14).pt(12).gap(2)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).truncate().child(d.name || d.session.slice(0, 8)))
        .child(div().text_size(10.5).text_color(t.dim).truncate().child(`${d.model_name || d.model || ""} · ${d.cwd} · ${d.prompt_count} prompts`)),
      h_flex().px(14).pt(8).gap(6)
        .child(this.stat(t, "Context", pct != null ? `${Math.round(pct)}%` : k(d.ctx), pctColor, `${k(d.ctx)} of ${k(d.window)} tokens`))
        .child(this.stat(t, "Cost", d.cost != null ? `$${d.cost.toFixed(2)}` : "–", null, "This session so far (Claude Code status line)"))
        .child(d.agent === "codex"
          ? this.stat(t, "Cached in", k(d.cache_read), null, "Input tokens served from cache across the session")
          : this.stat(t, "Cache", left == null ? "–" : left > 0 ? dur(left) : "expired", left != null && left <= 0 ? t.working : t.done, `Prompt cache TTL ${(d.cache_ttl ?? 300) / 60} min after the last reply`)),
      h_flex().px(10).pt(10).gap(2).border_b(1).border_color(t.border).children(TABS.map((id) => {
        const on = id === this.tab;
        return div().id(`tab-${id}`).px(10).py(5).text_size(11.5).cursor_pointer()
          .text_color(on ? t.foreground : t.muted).when(on, (el) => el.border_b(2).border_color(t.accent).font_medium())
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.tab = id; localStorage.setItem("tab", id); cx.notify(); })
          .child(id === "health" && problems ? `${TAB_LABEL[id]} · ${problems}` : TAB_LABEL[id]);
      })),
    ];
    const content = this[this.tab]?.(t, d) ?? [];
    return [...head, ...content, div().h(16)];
  }

  render() {
    const t = theme();
    return v_flex().id("agent-inspector").size_full().bg(t.chrome)
      .child(v_flex().id("ai-scroll").flex_1().min_h(0).overflow_y_scrollbar().children(this.body(t)));
  }
}
