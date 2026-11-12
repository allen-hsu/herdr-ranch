// Command bar: one box that reaches everything in the ranch (Arc's ⌘T / Raycast style).
//   Type to filter agents, folders, spaces, actions and views; ↑/↓ to move, Enter to run, Esc to close.
//   "New agent…" (or Enter on a folder) continues in the same box: pick the folder, pick the agent,
//   and whatever is typed becomes its first message. Backspace on an empty box goes back a step.
// The right side explains the highlighted row, so nothing here needs to be memorized.
// Opened with ⌘K (keys.json: "mod.open:command-bar").
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, spaces, panes, focused, run, exec, theme, props, closeOverlay, openOverlay, shared, setShared, notify, knownAgents } from "herdr";
import { TS, C, icon, statusMark, spaceName } from "./ui.js";
import { agentName } from "./agentname.js";
import { loadFolders, folderOf, place } from "./folders.js";

// What "New agent" can start: the agents Herdr knows are installed on this computer (the same list, icons and
// commands as Herdr's own "+" menu), then a plain terminal.
const KNOWN = "new-menu.agents";
const SHELL = { key: "shell", name: "Terminal", icon: "icons/shell.svg", tint: true, run: null, about: "A plain shell, no agent." };
const GROUPS = ["Needs you", "Agents", "Folders", "Spaces", "Actions", "Views"];
const ROWS = 11;

export default class CommandBar extends View {
  init(_p, cx) {
    this.overlay = props()?.overlay;
    this.step = props()?.step ?? null; // null: search everything · { folder?: folder|"here" } : New agent
    this.at = 0;
    this.q = "";
    this.folders = { list: [], of: {} };
    this.last = localStorage.getItem("kind") ?? "claude";
    this.input = InputState.new({ placeholder: this.hint() });
    this.input.on("change", (_e, cx) => { this.q = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.enter(cx));
    this.handle = cx.focus_handle();
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
    cx.spawn(async (cx) => { this.folders = await loadFolders(); cx.notify(); });
    // Installed agents: what Herdr last reported at once, then a fresh check.
    this.known = shared(KNOWN)?.[""] ?? [];
    cx.spawn(async (cx) => {
      try { this.known = await knownAgents({}); setShared(KNOWN, { ...shared(KNOWN), "": this.known }); } catch {}
      cx.notify();
    });
  }

  hint() {
    return !this.step ? "Search agents, folders, actions, views…" : this.step.folder == null ? "New agent — which folder?" : "What should it do? (optional) — pick the agent";
  }
  close() { closeOverlay(this.overlay); }
  setStep(step, cx) {
    this.step = step; this.at = 0; this.q = "";
    this.input.set_value(""); this.input.set_placeholder?.(this.hint()); this.input.focus();
    cx.notify();
  }

  // ---------- starting an agent ----------
  kinds() {
    const list = [...(this.known ?? []).filter((a) => a.installed && a.agent !== false), SHELL];
    return list.sort((a, b) => (b.key === this.last) - (a.key === this.last));
  }
  kindIcon(t, kd, size = 14) { return kd.tint ? svg(kd.icon).size(size).flex_none().text_color(t.foreground) : image(kd.icon).size(size).flex_none(); }

  start(folder, kind, task) {
    const argv = kind.run ?? undefined, t = task.trim() || undefined;
    const name = t ? t.slice(0, 28) : kind.run ? kind.name : undefined;
    localStorage.setItem("kind", kind.key);
    this.close();
    if (folder === "here") { run("tab.new", { ...(argv ? { argv, task: t } : {}), ...(name ? { name } : {}) }); return; }
    // A given space (the Board's "+" on a card).
    if (folder.space) { run("tab.new", { space: folder.space, ...(argv ? { argv, task: t } : {}), ...(name ? { name } : {}) }); return; }
    // The folder's main space (its first one): a new tab there. No space yet: a new space in the folder's path.
    const ps = panes();
    const mine = spaces().filter((s) => !s.machine && folderOf(s, this.folders, ps) === folder.id);
    if (mine.length) run("tab.new", { space: mine[0].id, ...(argv ? { argv, task: t } : {}), ...(name ? { name } : {}) });
    else if (folder.path) run("space.new", { folder: folder.path, ...(argv ? { argv, task: t } : {}) });
    else notify({ title: `${folder.name} has no space and no path`, body: "Give the folder a path (⋯ › Edit) or open a space in it first.", level: "warning" });
  }

  // ---------- rows ----------
  panel(child) { run("layout.show", { id: "panel" }); run("layout.select", { stack: "panel-body", child }); }
  inspector(tab) { setShared("inspector.goto", { tab, n: Date.now() }); this.panel("inspector"); }

  everything(t) {
    const st = C(t).status, out = [];
    const all = agents().filter((a) => !a.address.includes("/"));
    const sp = spaces();
    const where = (a) => spaceName(a.space_name ?? sp.find((s) => s.id === a.space)?.name);
    const rank = { blocked: 0, working: 1, done: 2, idle: 3 };
    for (const a of [...all].sort((x, y) => (rank[x.status] ?? 4) - (rank[y.status] ?? 4))) {
      const blocked = a.status === "blocked";
      out.push({ group: blocked ? "Needs you" : "Agents", name: agentName(a) || a.program?.name || a.address, hint: `${where(a)} · ${blocked ? "needs you" : a.status ?? ""}`,
        mark: statusMark(t, a.status), kw: `${a.program?.name ?? ""} ${where(a)} agent`, verb: "Go",
        desc: blocked ? "This agent is waiting for you: a permission prompt or a question in its terminal." : `Go to this agent's terminal (${a.program?.name ?? "agent"} in ${where(a)}).`,
        run: () => { this.close(); run("pane.focus", { pane: a.pane }); } });
    }
    const ps = panes();
    for (const f of this.folders.list ?? []) {
      const n = sp.filter((s) => !s.machine && folderOf(s, this.folders, ps) === f.id).length;
      out.push({ group: "Folders", name: f.name, hint: n ? `${n} space${n > 1 ? "s" : ""}` : "empty", mark: icon("folder", 14, t.muted), kw: "folder project", verb: "New agent here",
        desc: `Start an agent in ${f.name}: a new tab in its main space${n ? "" : " (it has none yet, so a new space in its path)"}.`, keep: true,
        run: (cx) => this.setStep({ folder: f }, cx) });
    }
    for (const s of sp) out.push({ group: "Spaces", name: spaceName(s.name), hint: [s.branch, s.machine].filter(Boolean).join(" · "), mark: statusMark(t, s.status ?? "none"), kw: "space", verb: "Go",
      desc: `Switch to this space${s.branch ? ` (branch ${s.branch})` : ""}.`, run: () => { this.close(); run("space.select", { id: s.id }); } });

    const act = (name, ic, desc, fn, extra = {}) => out.push({ group: "Actions", name, mark: icon(ic, 14, t.muted), desc, verb: "Run", kw: "", ...extra, run: fn });
    act("New agent…", "plus", "Pick a folder and an agent (any agent installed here, or a plain terminal). What you type becomes its first message.", (cx) => this.setStep({}, cx), { keep: true, verb: "Continue", kw: "start launch claude codex grok cursor", hint: "" });
    act("New team…", "users", "A lead plus helpers on one task: maker-checker, leader-workers, arena, research-build.", () => { this.close(); openOverlay({ mod: "team-launch", kind: "dialog", width: 560, height: 228, props: {} }); }, { hint: "⌃⌘N", kw: "lead maker checker arena" });
    act("New worktree…", "git-branch", "A separate copy of this repo on its own branch, as a new space.", (cx) => { this.close(); cx.spawn(async () => {
      const dir = focused()?.cwd; const r = dir ? await exec("git", ["-C", dir, "rev-parse", "--show-toplevel"]).catch(() => null) : null;
      if (r?.code === 0) openOverlay({ mod: "worktrees", kind: "dialog", width: 480, height: 400, props: { wt: "new", root: r.stdout.trim() } });
      else notify({ title: "Not in a git repository", body: "Focus a terminal inside a repo, then try again.", level: "warning" });
    }); }, { kw: "branch isolate" });
    act("Add machine…", "plus", "Connect another computer (over SSH) so its spaces and agents show up here.", () => { this.close(); run("mod.open", { name: "machine-add" }); }, { kw: "remote ssh server computer" });
    act("New space", "plus", "A new space on this computer.", () => { this.close(); run("space.new"); }, { hint: "⌘N" });
    act("New terminal tab", "plus", "A plain shell in a new tab of this space.", () => { this.close(); run("tab.new"); }, { hint: "⌘T", kw: "shell" });
    const fa = all.find((a) => a.focused) ?? all.find((a) => a.address === focused()?.agent);
    if (fa && /claude/i.test(fa.program?.name ?? "")) act("Compact this agent's context", "fold-vertical", `Sends /compact to ${agentName(fa) || "the focused agent"}.`, () => { this.close(); exec("hc", ["send", fa.address, "/compact"]).catch(() => null); }, { kw: "context shrink" });
    act("Split right", "plus", "A new terminal beside this one.", () => { this.close(); run("pane.split", { direction: "right" }); }, { hint: "⌘D" });
    act("Toggle sidebar", "chevrons-left-right", "Show or hide the left sidebar.", () => { this.close(); run("layout.toggle", { id: "sidebar" }); }, { hint: "⌘B" });
    act("Toggle details panel", "chevrons-left-right", "Show or hide the right panel (Inspector, Changes, PRs, Files).", () => { this.close(); run("layout.toggle", { id: "panel" }); }, { hint: "⌃⌘G", kw: "right inspector" });

    const view = (name, ic, desc, fn, extra = {}) => out.push({ group: "Views", name, mark: icon(ic, 14, t.muted), desc, verb: "Open", kw: "", ...extra, run: () => { this.close(); fn(); } });
    view("Board", "layers", "Every space as a card in Todo / In progress / In review / Done.", () => openOverlay({ mod: "space-board", kind: "dialog" }), { hint: "⌃⌘B", kw: "kanban todo review" });
    view("Team Map", "users", "Timeline of the focused agent's team: who did what, and the messages between them.", () => run("mod.open", { name: "agent-team" }), { hint: "⌃⌘T", kw: "timeline members" });
    view("Inspector: Overview", "gauge", "What the focused agent is doing, what needs you, context, cache and spend.", () => this.inspector("overview"), { kw: "context cost cache health" });
    view("Inspector: Trace", "clock", "The focused agent's turns: time split, waterfall of LLM calls and tools, cost per call.", () => this.inspector("trace"), { kw: "waterfall turns cost" });
    view("Inspector: Capabilities", "plug", "Skills, MCP servers and tools the focused agent has and used.", () => this.inspector("capabilities"), { kw: "skills mcp tools" });
    view("Inspector: Config", "settings", "Model and mode, memory files, hooks.", () => this.inspector("config"), { kw: "hooks memory claude.md" });
    view("Changes", "git-branch", "Uncommitted changes in this space, with diffs and commit.", () => this.panel("changes"), { kw: "diff commit git" });
    view("Git graph", "git-branch", "Branches and commits of this repo.", () => this.panel("git"), { kw: "branches commits log" });
    view("Pull requests", "git-pull-request", "Your PRs, review requests and CI status.", () => this.panel("prs"), { kw: "pr review ci github" });
    view("Files", "file", "Browse and preview files in this space's folder.", () => this.panel("files"), { kw: "browse tree" });
    view("Resource Manager", "database", "Worktrees, disk space, and cleaning up merged or stale ones.", () => openOverlay({ mod: "worktrees", kind: "window", key: "worktree-resources", width: 560, height: 680, props: { view: "window" } }), { kw: "worktrees clean disk" });
    view("Settings", "settings", "Theme, font size, keys.", () => run("app.settings"), { hint: "⌘,", kw: "theme font" });
    view("Keybinds", "info", "Every key and what it does.", () => run("app.help"), { hint: "⌘/", kw: "keys shortcuts help" });
    view("Herdr command palette", "search", "Herdr's own list of every app command.", () => run("app.palette"), { hint: "⌘⇧P", kw: "commands" });
    return out;
  }

  rows(t) {
    const q = this.q.trim().toLowerCase();
    if (this.step) {
      if (this.step.folder == null) {
        const list = [{ name: "This space", hint: spaceName(spaces().find((s) => s.active)?.name), mark: icon("corner-down-right", 14, t.muted), desc: "A new tab in the space you're in now.", verb: "Next", keep: true, run: (cx) => this.setStep({ folder: "here" }, cx) },
          ...(this.folders.list ?? []).map((f) => ({ name: f.name, hint: f.path ?? "", mark: icon("folder", 14, t.muted), desc: `A new tab in ${f.name}'s main space.`, verb: "Next", keep: true, run: (cx) => this.setStep({ folder: f }, cx) }))];
        return list.filter((r) => !q || r.name.toLowerCase().includes(q)).map((r) => ({ group: "Where", ...r }));
      }
      const f = this.step.folder, whereName = f === "here" ? "this space" : f.name;
      // Typing here is the task, not a filter. The agent used last time comes first.
      return this.kinds().map((kd) => ({ group: "Agent", name: kd.name, hint: kd.key === this.last ? "used last time" : "", mark: this.kindIcon(t, kd),
        desc: `${kd.about ?? `Runs ${kd.run.join(" ")}.`}\nStarts in ${whereName}, as a new tab.${kd.run && this.q.trim() ? `\n\nFirst message:\n${this.q.trim()}` : ""}`, verb: "Start", run: () => this.start(f, kd, kd.run ? this.q : "") }));
    }
    const all = this.everything(t);
    if (!q) {
      const pick = (n) => all.find((r) => r.name === n);
      return [...all.filter((r) => r.group === "Needs you"), ...all.filter((r) => r.group === "Agents").slice(0, 5),
        ...["New agent…", "Board", "Changes", "Pull requests"].map(pick).filter(Boolean).map((r) => ({ ...r, group: "Suggested" }))].slice(0, ROWS);
    }
    const words = q.split(/\s+/);
    // Every word must appear somewhere; a match in the name beats one in the keywords, a name that starts with
    // what was typed beats both. The best group comes first, each group keeps its matches together.
    const score = (r) => { const n = r.name.toLowerCase(), hay = `${n} ${r.kw ?? ""} ${r.group} ${r.hint ?? ""}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return -1;
      return n.startsWith(q) ? 4 : n.includes(q) ? 3 : words.every((w) => n.includes(w)) ? 2 : 1; };
    const hits = all.map((r) => ({ r, s: score(r) })).filter((x) => x.s >= 0);
    const best = {};
    for (const x of hits) best[x.r.group] = Math.max(best[x.r.group] ?? 0, x.s);
    return hits.sort((a, b) => best[b.r.group] - best[a.r.group] || GROUPS.indexOf(a.r.group) - GROUPS.indexOf(b.r.group) || b.s - a.s).map((x) => x.r).slice(0, ROWS);
  }

  enter(cx) {
    const r = this.rows(theme())[this.at];
    if (r) r.run(cx);
  }

  render() {
    const t = theme();
    const rows = this.rows(t);
    this.at = Math.max(0, Math.min(this.at, rows.length - 1));
    const sel = rows[this.at];
    const chip = (text, on) => div().flex_none().h(24).px(8).flex().items_center().rounded(6).text_size(TS.body).text_color(t.foreground)
      .when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.border_1().border_color(t.border)).child(text);
    const list = [];
    let last = null;
    rows.forEach((r, i) => {
      if (r.group !== last) { list.push(div().px(10).pt(i ? 8 : 4).pb(3).text_size(11).font_semibold().text_color(r.group === "Needs you" ? C(t).status.blocked : t.dim).child(r.group)); last = r.group; }
      list.push(h_flex().id(`cb-${i}`).h(32).flex_none().px(10).gap(8).items_center().rounded(7).cursor_pointer()
        .when(i === this.at, (e) => e.bg(t.selected)).hover((e) => e.bg(i === this.at ? t.selected : t.hover))
        .on_click((_e, cx) => { this.at = i; r.run(cx); })
        .child(div().w(16).flex_none().flex().justify_center().child(r.mark))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(r.name))
        .when(Boolean(r.hint), (e) => e.child(div().flex_none().max_w(170).truncate().text_size(11).text_color(t.dim).child(r.hint))));
    });
    return v_flex().id("command-bar").track_focus(this.handle).size_full().bg(t.popover).text_size(13).text_color(t.foreground)
      .on_key_down((e, cx) => {
        const key = e.key;
        if (key === "escape") { if (this.step) this.setStep(this.step.folder != null && !props()?.step ? {} : null, cx); else this.close(); }
        else if (key === "down") this.at = rows.length ? (this.at + 1) % rows.length : 0;
        else if (key === "up") this.at = rows.length ? (this.at + rows.length - 1) % rows.length : 0;
        else if (key === "tab") { if (sel?.keep) sel.run(cx); }
        else if (key === "backspace" && this.step && !this.input.value()) this.setStep(this.step.folder != null ? {} : null, cx);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().h(52).flex_none().px(16).gap(8).items_center().border_b(1).border_color(t.border)
        .when(!this.step, (e) => e.child(icon("search", 16, t.dim)))
        .when(Boolean(this.step), (e) => e.child(chip("New agent", true)))
        .when(this.step?.folder != null, (e) => e.child(chip(this.step.folder === "here" ? "This space" : this.step.folder.name, false)))
        .child(Input.new(this.input).flex_1().h(36).text_size(15).text_color(t.foreground))
        .child(div().id("cb-esc").flex_none().px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")))
      .child(h_flex().flex_1().min_h(0).items_start()
        .child(v_flex().id("cb-list").w(400).flex_none().h_full().p(6).gap(1).overflow_hidden().border_r(1).border_color(t.border)
          .children(list)
          .when(!rows.length, (e) => e.child(div().px(10).py(14).text_color(t.dim).child("Nothing matches."))))
        .child(v_flex().flex_1().min_w(0).h_full().p(18).gap(8)
          .when(Boolean(sel), (e) => e
            .child(div().text_size(11).font_semibold().text_color(t.dim).child(sel.group))
            .child(div().text_size(16).font_semibold().child(sel.name))
            .child(div().text_color(t.muted).child(sel.desc ?? "")))))
      .child(h_flex().h(34).flex_none().px(14).gap(14).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.muted)
        .child(div().flex_1().child(this.step ? (this.step.folder == null ? "Step 1 of 2 · ⌫ back" : "Step 2 of 2 · type the task · ⌫ back") : ""))
        .child("↑↓ move")
        .child(`↵ ${sel?.verb ?? "Run"}`)
        .when(Boolean(sel?.keep), (e) => e.child("⇥ continue")));
  }
}
