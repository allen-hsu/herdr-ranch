// Agent inspector for the focused Claude Code / Codex agent. One tab per question:
//   Health  - what went wrong (hook errors/timeouts, tool errors, permission blocks, MCP failures, compactions)
//   Trace   - what it did (per turn: skills loaded, thinking, tool calls with duration/size/permission, hooks, subagents)
//   Skills  - which skills were really loaded, by whom (model / you / subagent), when, how big; named but never loaded
//   MCP     - every MCP server: status, tools, which were loaded / called, context they cost
//   Config  - what shapes it (memory/rules files, hooks, mode, style)
//   Cost    - where tokens went (context, cost, cache, per tool, per turn, subagents)
// Data: ./inspect.py (local transcripts only).
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, focused, agents, theme } from "herdr";

const k = (n) => (n == null ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const ms = (v) => (v == null ? "" : v < 1000 ? `${v}ms` : v < 60000 ? `${(v / 1000).toFixed(1)}s` : `${Math.floor(v / 60000)}m${String(Math.round((v % 60000) / 1000)).padStart(2, "0")}s`);
const dur = (s) => ms(s == null ? null : Math.round(s * 1000));
const clock = (t) => { if (!t) return ""; const d = new Date(t * 1000); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const TABS = ["health", "trace", "skills", "mcp", "config", "cost"];
const TAB_LABEL = { health: "Health", trace: "Trace", skills: "Skills", mcp: "MCP", config: "Config", cost: "Cost" };
const HOW = { model: "by the model", you: "by you (/command)", subagent: "in a subagent", restored: "restored after compaction" };

export default class AgentInspector extends View {
  init(_props, cx) {
    this.addr = null;
    this.data = null;
    this.tab = localStorage.getItem("tab") ?? "health";
    this.open = new Set(); // expanded turns in Trace
    this.openSrv = new Set(); // expanded servers in MCP
    this.onlySkills = false; // Trace: only turns that loaded or named a skill
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
    const used = (c.skills?.used ?? []).filter((u) => u.count > 0).length;
    if (c.skills?.available > 50) out.push({ level: "info", kind: "skills", text: `${c.skills.available} skills listed (~${k(c.skills.available_tok)} tokens every turn), ${used} loaded in this session.` });
    for (const m of c.skills?.missed ?? []) out.push({ level: "info", kind: "skills", text: `You named the skill ${m.name} in ${m.turns} prompt${m.turns > 1 ? "s" : ""}, but it was never loaded.` });
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
    out.push(this.note(t, "Skills and MCP servers have their own tabs."));
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
    if (c.agent_types) out.push(this.note(t, `${c.agent_types} subagent types available.`));
    return out;
  }

  chip(t, id, text, color, tip) {
    const el = div().id(id).px(5).rounded(4).flex_none().text_size(10).text_color(color).border_1().border_color(color).child(text);
    return tip ? el.tooltip(tip) : el;
  }

  trace(t, d) {
    const withSkills = (d.turns ?? []).filter((tu) => tu.skills?.length || tu.missed?.length).length;
    const pill = (id, label, on, action) => div().id(id).px(8).py(2).rounded(10).text_size(10.5).cursor_pointer()
      .text_color(on ? t.foreground : t.muted).when(on, (e) => e.bg(t.raised)).hover((x) => x.text_color(t.foreground)).on_click(action).child(label);
    const out = [this.h(t, "Turns", `${d.prompt_count} total · last ${(d.turns ?? []).length}`),
      h_flex().px(12).pb(4).gap(4)
        .child(pill("tr-all", "All turns", !this.onlySkills, (_e, cx) => { this.onlySkills = false; cx.notify(); }))
        .child(pill("tr-sk", `With skills (${withSkills})`, this.onlySkills, (_e, cx) => { this.onlySkills = true; cx.notify(); }))];
    for (const [i, tu] of (d.turns ?? []).entries()) {
      if (this.onlySkills && !(tu.skills?.length || tu.missed?.length)) continue;
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
          .when(errs > 0, (el) => el.child(div().text_color(t.blocked).child(`${errs} errors`))))
        .when(Boolean(tu.skills?.length || tu.missed?.length), (el) => el.child(h_flex().pl(14).pt(2).gap(4).flex_wrap()
          .children((tu.skills ?? []).map((s, j) => this.chip(t, `tsk-${i}-${j}`, `⚡ ${s.how === "you" ? "/" : ""}${s.name}${s.tok ? ` ~${k(s.tok)}` : ""}`,
            s.ok === false ? t.blocked : t.accent, `Skill ${s.name} loaded ${HOW[s.how] ?? s.how}${s.tok ? `, ~${k(s.tok)} tokens of instructions` : ""}${s.ok === false ? " — failed" : ""}`)))
          .children((tu.missed ?? []).map((n, j) => this.chip(t, `tms-${i}-${j}`, `? ${n}`, t.working, `This prompt names ${n}, but the agent didn't load it this turn.`))))));
      if (open) for (const [j, s] of tu.steps.entries()) {
        const skill = s.k === "skill";
        const color = s.error ? t.blocked : skill ? t.accent : s.k === "think" ? t.dim : s.k === "agent" ? t.accent : s.k === "hook" ? t.working : s.k === "compact" ? t.working : t.muted;
        const icon = { think: "◌", tool: "▸", agent: "◆", hook: "⚑", compact: "⇣", skill: "⚡" }[s.k] ?? "·";
        out.push(h_flex().id(`st-${i}-${j}`).pl(s.in ? 28 : 34).pr(14).py(1).gap(6).items_center().text_size(10.5)
          .when(Boolean(s.in), (el) => el.child(div().w(2).h(13).flex_none().rounded(1).bg(t.accent).opacity(0.45)).tooltip(`While following the ${s.in} skill`))
          .child(div().flex_none().text_color(color).when(skill, (e) => e.font_medium()).child(skill ? `${icon} Skill ${s.name}` : `${icon} ${s.name}`))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(skill ? `${HOW[s.how] ?? ""}${s.label ? ` · ${s.label}` : ""}` : (s.label ?? "")))
          .when(Boolean(s.perm) && !String(s.perm).startsWith("accept:config"), (el) => el.child(div().flex_none().text_color(String(s.perm).startsWith("reject") ? t.blocked : t.dim).child(s.perm)))
          .when(s.tok != null, (el) => el.child(div().flex_none().text_color(s.tok > 5000 ? t.working : t.dim).child(skill ? `~${k(s.tok)} loaded` : `~${k(s.tok)}`)))
          .child(div().flex_none().w(44).text_right().text_color(t.dim).child(ms(s.ms))));
      }
    }
    return out;
  }

  skills(t, d) {
    const sk = d.config?.skills ?? {};
    const used = (sk.used ?? []).filter((u) => u.count > 0 || u.restored > 0);
    const out = [];
    out.push(v_flex().px(14).pt(12).gap(2)
      .child(div().text_size(12).text_color(t.foreground).child(`${used.filter((u) => u.count > 0).length} skills loaded in this session`))
      .child(div().text_size(10.5).text_color(t.dim).child(`${sk.available ?? 0} listed — their descriptions cost ~${k(sk.available_tok)} tokens on every turn; a skill's full instructions enter context only when it loads.`)));
    out.push(this.h(t, "Loaded", used.length || "none"));
    if (!used.length) out.push(this.note(t, "No skill was loaded. The agent only saw the list of names and descriptions."));
    for (const [i, u] of used.entries()) out.push(h_flex().id(`sk-u-${i}`).px(14).py(4).gap(8).items_center().text_size(11)
      .child(div().flex_none().text_color(u.failed ? t.blocked : t.accent).child("⚡"))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_color(t.foreground).child(u.name))
        .child(div().truncate().text_size(10).text_color(t.dim).child([u.count ? `${u.count}× ${u.how.map((h) => HOW[h] ?? h).join(", ")}` : "", u.restored ? `restored ${u.restored}× after compaction` : "", u.failed ? `${u.failed} failed` : "", u.last ? `last ${clock(u.last)}` : ""].filter(Boolean).join(" · "))))
      .child(div().flex_none().text_color(u.tok > 20000 ? t.working : t.dim).tooltip("Size of the skill's instructions when loaded (characters ÷ 4)").child(u.tok ? `~${k(u.tok)}` : "–")));
    out.push(this.h(t, "Timeline", (sk.events ?? []).length ? "newest first" : null));
    if (!(sk.events ?? []).length) out.push(this.note(t, "Nothing yet."));
    for (const [i, e] of (sk.events ?? []).entries()) out.push(h_flex().id(`sk-e-${i}`).px(14).py(3).gap(8).items_center().text_size(10.5)
      .tooltip(`${e.name} — ${HOW[e.how] ?? e.how}${e.args ? `\nargs: ${e.args}` : ""}${e.allowed?.length ? `\nallowed tools: ${e.allowed.join(", ")}` : ""}${e.error ? `\nerror: ${e.error}` : ""}\nprompt: ${e.prompt ?? ""}`)
      .child(div().flex_none().w(36).text_color(t.dim).child(clock(e.at)))
      .child(div().flex_none().max_w(150).truncate().text_color(e.ok === false ? t.blocked : t.accent).child(`${e.how === "you" ? "/" : ""}${e.name}`))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(e.prompt ? `“${e.prompt}”` : ""))
      .child(div().flex_none().text_color(t.dim).child(e.ok === false ? "failed" : e.tok ? `~${k(e.tok)}` : "")));
    if ((sk.missed ?? []).length) {
      out.push(this.h(t, "Named but never loaded", sk.missed.length));
      out.push(this.note(t, "These skills appear in your prompts (as /name, or by name next to “skill”), but the agent didn't load them in that turn."));
      for (const [i, m] of sk.missed.entries()) out.push(this.row(t, `sk-m-${i}`, "?", m.name, `${m.turns} prompt${m.turns > 1 ? "s" : ""}`, t.working));
    }
    const subs = (d.subagents ?? []).filter((s) => s.skills?.length);
    if (subs.length) {
      out.push(this.h(t, "In subagents", subs.length));
      for (const [i, s] of subs.entries()) out.push(this.row(t, `sk-s-${i}`, "◆", s.desc || s.type || "agent", s.skills.join(", "), t.accent));
    }
    return out;
  }

  mcp(t, d) {
    const m = d.config?.mcp ?? {};
    if (d.agent === "codex") return [this.note(t, "Codex sessions don't record MCP servers in their log.")];
    const tot = m.totals ?? {};
    const out = [v_flex().px(14).pt(12).gap(2)
      .child(div().text_size(12).text_color(t.foreground).child(`${tot.servers ?? 0} MCP servers · ${tot.connected ?? 0} connected · ${tot.tools ?? 0} tools`))
      .child(div().text_size(10.5).text_color(t.dim).child(`${tot.loaded ?? 0} tools loaded with full schemas, ${tot.called ?? 0} used (${tot.calls ?? 0} calls). ~${k(tot.context_tok)} tokens of context: instructions + tool names + loaded schemas.`))];
    const color = (s) => s.status === "failed" ? t.blocked : s.status === "needs auth" || s.status === "pending" ? t.working : s.calls ? t.done : t.dim;
    out.push(this.h(t, "Servers", "tools · loaded · calls"));
    for (const [i, s] of (m.servers ?? []).entries()) {
      const open = this.openSrv.has(s.key);
      const ctx = s.instr_tok + s.list_tok + s.def_tok;
      out.push(h_flex().id(`mc-${i}`).px(14).py(4).gap(8).items_center().text_size(11).cursor_pointer().hover((x) => x.bg(t.hover))
        .on_click((_e, cx) => { open ? this.openSrv.delete(s.key) : this.openSrv.add(s.key); cx.notify(); })
        .child(div().w(7).h(7).rounded(4).flex_none().bg(color(s)))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().text_color(t.foreground).child(s.name))
          .child(div().truncate().text_size(10).text_color(s.status === "connected" ? t.dim : color(s)).child(s.status === "connected" ? (s.calls ? "used" : "connected, not used") : s.status)))
        .child(div().flex_none().text_color(t.muted).child(`${s.tools} · ${s.loaded} · ${s.calls}`))
        .child(div().flex_none().w(44).text_right().text_color(ctx > 2000 ? t.working : t.dim).tooltip("Context this server costs (approx.)").child(`~${k(ctx)}`)));
      if (open) {
        const sub = (txt) => div().pl(36).pr(14).py(1).text_size(10.5).text_color(t.muted).child(txt);
        out.push(sub(`Context: ~${k(s.instr_tok)} instructions · ~${k(s.list_tok)} tool names · ~${k(s.def_tok)} schemas`));
        out.push(sub(`Tools: ${s.tools} available, ${s.upfront} loaded up front, ${s.loaded - s.upfront} loaded on demand, ${s.called} called${s.errors ? `, ${s.errors} errors` : ""}`));
        for (const x of s.top ?? []) out.push(sub(`▸ ${x.tool}  ${x.n}×`));
        if (s.status === "needs auth") out.push(sub("Only its sign-in tools are present: sign in (/mcp) to get the real tools."));
      }
    }
    for (const [i, s] of (m.pending ?? []).entries()) out.push(this.row(t, `mc-p-${i}`, "pending", s, null, t.working));
    out.push(this.note(t, "Most MCP tools are deferred: only their names sit in context until the agent loads a schema (ToolSearch). Click a server for details."));
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
        return div().id(`tab-${id}`).px(7).py(5).text_size(11.5).cursor_pointer()
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
