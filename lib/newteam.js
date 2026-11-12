// New team dialog: pick a pattern, write the task, choose the repo and which agent plays each role, then start
// a lead Claude Code in a new tab with that pattern's playbook (ranch/teams/<pattern>.md). Members are started
// by the lead with `hc run <role>-<agent>` templates (installed by herdr-ranch into ~/.config/herdr-core/templates).
// Role preferences: ~/.config/herdr-app/agent-team.json (see config.example/agent-team.json).
// Two faces: compact (team-launch mod, ⌃⌘N: one line + Enter, repo taken from where you are) and full
// ("More options…": every field). Shared lib (herdr-ranch/lib), used by team-launch and agent-team.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { exec, run, home, appHome, readTextFile, spaces, panes, focused, closeOverlay, openOverlay, pickFolder } from "herdr";
import { folderOf, loadFolders, place } from "./folders.js";
import { loadAccounts, envFor } from "./accounts.js";
import { TS, SPACE, C, field, escChip, dialogTitle, openPage } from "./ui.js";

export const PATTERNS = [
  { key: "maker-checker", name: "Maker / Checker", line: "One agent builds, another vendor reviews; loop until approved.", roles: ["implementer", "reviewer"] },
  { key: "leader-workers", name: "Leader / Workers", line: "Split into parallel subtasks, one worktree each; the lead merges.", roles: ["implementers", "reviewer?"] },
  { key: "arena", name: "Arena", line: "Same task to several agents; the lead compares and picks.", roles: ["contestants", "reviewer?"] },
  { key: "research-build", name: "Research → Build", line: "Research first, then build from the notes.", roles: ["researcher", "implementer", "reviewer?"] },
];
const CLI = { claude: "claude", codex: "codex", grok: "grok", cursor: "cursor-agent", gemini: "gemini" };
const NAME = { claude: "Claude", codex: "Codex", grok: "Grok", cursor: "Cursor", gemini: "Gemini" };
const TEMPLATES = { implementer: ["claude", "codex", "grok", "cursor"], reviewer: ["codex", "claude", "grok"], researcher: ["gemini", "grok", "claude"] };
const DEFAULTS = { implementer: ["claude", "codex", "grok", "cursor"], reviewer: ["codex", "claude", "grok"], researcher: ["gemini", "grok", "claude"] };
const ROLE_LABEL = { implementer: "Implementer", implementers: "Workers", contestants: "Contestants", reviewer: "Reviewer", researcher: "Researcher" };
const SAFE_REF = /^[\w./-]+$/;
// Single-quote for a POSIX shell when the text isn't plainly safe (paths with spaces, $, quotes...).
const sq = (v) => (/^[\w./~-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);
const HISTORY = "team-history";
const loadHistory = () => { try { const h = JSON.parse(localStorage.getItem(HISTORY) ?? "[]"); return Array.isArray(h) ? h : []; } catch { return []; } };
const ago = (ms) => { const s = (Date.now() - ms) / 1000; return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
const slugify = (s) => (s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "task");

export class NewTeam {
  constructor(p, cx) {
    this.overlay = p.overlay;
    this.compact = Boolean(p.compact);
    const pre = p.prefill ?? {};
    this.pattern = pre.pattern ?? "maker-checker";
    this.task = this.compact
      ? InputState.new({ value: pre.task ?? "", placeholder: "What should the team do?  (Enter to start)" })
      : TextareaState.new({ value: pre.task ?? "", placeholder: "What should the team do? e.g. Add rate limiting to the /api/login endpoint with tests", rows: 5 });
    if (this.compact) this.task.on("submit", (_e, cx) => { if (!this.busy) cx.spawn(async (cx) => this.start(cx)); });
    const sp = spaces().find((s) => s.active);
    const cwd = panes().find((x) => x.pane === focused()?.pane)?.cwd;
    this.repo = InputState.new({ value: pre.repo || p.repo || cwd || sp?.folder || home(), placeholder: "Repository folder" });
    this.repoRoot = null; // the git top level of the repo field, for the compact chip
    this.folder = p.folder ?? null; // opened from a sidebar folder row: offer only its repos
    this.repos = []; // [{ root, name, folder }] from the sidebar's spaces
    this.base = InputState.new({ value: pre.base ?? "", placeholder: "default branch" });
    this.installed = {};
    this.prefs = DEFAULTS;
    this.pick = {}; // role -> agent key, or Set for multi roles
    this.useReviewer = true;
    this.error = null; this.busy = false;
    this.history = loadHistory();
    cx.spawn(async (cx) => {
      for (const [k, bin] of Object.entries(CLI)) this.installed[k] = (await exec("/bin/sh", ["-lc", `command -v ${bin}`], { timeout: 4000 }).catch(() => null))?.code === 0;
      try { const c = JSON.parse((await readTextFile(`${home()}/.config/herdr-app/agent-team.json`)) ?? "null"); if (c?.roles) this.prefs = { ...DEFAULTS, ...c.roles }; } catch {}
      this.defaults();
      if (pre.pick) this.applyPick(pre.pick, pre.useReviewer);
      await this.loadRepos();
      await this.resolveRepo();
      // From a folder row: if the current repo isn't in that folder, take the folder's first one.
      const mine = this.shownRepos();
      if (this.folder && mine.length && !mine.some((r) => r.root === this.repoRoot)) { this.repo.set_value(mine[0].root); this.repoRoot = mine[0].root; }
      cx.notify();
    });
  }

  // Every repository behind the sidebar's spaces, with its folder: a space's own repo (a worktree counts as its
  // main checkout), or — when a space or a folder points at a plain directory (e.g. one holding several
  // repos) — the repos one level inside it. Plus repos used for teams before.
  async loadRepos() {
    const data = await loadFolders().catch(() => ({ list: [], of: {} }));
    const ps = panes(), seen = new Map();
    const folderName = (fid) => (data.list ?? []).find((f) => f.id === fid)?.name ?? null;
    const add = (root, fid) => { if (!seen.has(root)) seen.set(root, { root, name: root.split("/").pop(), folder: fid, folderName: folderName(fid) }); };
    const repoOf = async (dir) => {
      const r = await exec("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], { timeout: 4000 }).catch(() => null);
      if (r?.code !== 0) return null;
      const [common, top] = r.stdout.trim().split("\n");
      return common.endsWith("/.git") ? common.slice(0, -5) : top; // worktree -> its main checkout; submodule -> itself
    };
    const inside = async (dir) => {
      const r = await exec("find", [dir, "-mindepth", "2", "-maxdepth", "2", "-name", ".git"], { timeout: 5000 }).catch(() => null);
      return r?.code === 0 ? r.stdout.split("\n").filter(Boolean).slice(0, 30).map((g) => g.replace(/\/\.git$/, "")) : [];
    };
    for (const s of spaces().filter((x) => !x.machine)) {
      const dir = place(s, ps);
      if (!dir || dir === home()) continue;
      const fid = folderOf(s, data, ps);
      const root = await repoOf(dir);
      if (root) add(root, fid); else for (const sub of await inside(dir)) add((await repoOf(sub)) ?? sub, fid);
    }
    for (const f of data.list ?? []) {
      if (!f.path) continue;
      const dir = f.path.replace(/^~/, home());
      const root = await repoOf(dir);
      if (root) add(root, f.id); else for (const sub of await inside(dir)) add((await repoOf(sub)) ?? sub, f.id);
    }
    for (const h of this.history ?? []) if (h.repo) add(h.repo, null);
    this.repos = [...seen.values()];
  }
  shownRepos() { return this.folder ? this.repos.filter((r) => r.folder === this.folder) : this.repos; }

  async resolveRepo() {
    const r = await exec("git", ["-C", this.repo.value().trim().replace(/^~/, home()), "rev-parse", "--show-toplevel"], { timeout: 5000 }).catch(() => null);
    this.repoRoot = r?.code === 0 ? r.stdout.trim() : null;
  }
  applyPick(p, useReviewer) {
    for (const k of ["implementer", "reviewer", "researcher"]) if (p[k] && this.installed[p[k]]) this.pick[k] = p[k];
    for (const k of ["implementers", "contestants"]) if (p[k]) this.pick[k] = new Set([...p[k]].filter((a) => this.installed[a]));
    if (useReviewer != null) this.useReviewer = useReviewer !== false;
  }
  // One line saying who does what, for the compact face.
  summary() {
    const N = (a) => NAME[a] ?? a;
    const rev = this.useReviewer && this.pick.reviewer ? N(this.pick.reviewer) : null;
    switch (this.pattern) {
      case "maker-checker": return `${N(this.pick.implementer)} builds → ${rev ?? "no one"} reviews`;
      case "leader-workers": return `workers: ${[...(this.pick.implementers ?? [])].map(N).join(", ")}${rev ? ` · ${rev} reviews` : ""}`;
      case "arena": return [...(this.pick.contestants ?? [])].map(N).join(" vs ");
      case "research-build": return `${N(this.pick.researcher)} researches → ${N(this.pick.implementer)} builds${rev ? ` → ${rev} reviews` : ""}`;
    }
    return "";
  }
  state() {
    return { pattern: this.pattern, task: this.task.value(), repo: this.repo.value(), base: this.base.value(), useReviewer: this.useReviewer,
      pick: { implementer: this.pick.implementer, reviewer: this.pick.reviewer, researcher: this.pick.researcher,
        implementers: [...(this.pick.implementers ?? [])], contestants: [...(this.pick.contestants ?? [])] } };
  }

  avail(role) { return (this.prefs[role] ?? []).filter((a) => this.installed[a] && TEMPLATES[role]?.includes(a)); }
  defaults() {
    const impl = this.avail("implementer"), rev = this.avail("reviewer"), res = this.avail("researcher");
    this.pick.implementer = impl[0];
    this.pick.reviewer = rev.find((a) => a !== impl[0]) ?? rev[0];
    this.pick.researcher = res[0];
    this.pick.implementers = new Set(impl.slice(0, 2));
    this.pick.contestants = new Set(impl.slice(0, 3));
  }

  chip(t, id, label, on, enabled, action) {
    return div().id(id).h(26).px(10).flex().items_center().rounded(13).text_size(TS.body).border_1()
      .border_color(t.border).when(on, (e) => e.bg(t.selected)).text_color(on || enabled ? t.foreground : t.dim)
      .when(enabled, (e) => e.cursor_pointer().when(!on, (x) => x.hover((h) => h.bg(t.hover))).on_click(action)).child(label);
  }

  roleRow(t, roleSpec) {
    const optional = roleSpec.endsWith("?");
    const role = roleSpec.replace("?", "");
    const base = role === "implementers" || role === "contestants" ? "implementer" : role;
    const multi = base !== role;
    const list = this.avail(base);
    const label = h_flex().w(96).flex_none().gap(6).items_center().child(div().text_size(TS.body).text_color(t.muted).child(ROLE_LABEL[role]));
    const row = h_flex().gap(6).flex_wrap().flex_1().min_w(0);
    if (optional) row.child(this.chip(t, `r-${role}-none`, "None", !this.useReviewer, true, (_e, cx) => { this.useReviewer = !this.useReviewer; cx.notify(); }));
    for (const a of list) {
      const on = multi ? this.pick[role].has(a) : this.pick[role] === a && (!optional || this.useReviewer);
      row.child(this.chip(t, `r-${role}-${a}`, NAME[a], on, true, (_e, cx) => {
        if (multi) { on ? this.pick[role].delete(a) : this.pick[role].add(a); }
        else { this.pick[role] = a; if (optional) this.useReviewer = true; }
        cx.notify();
      }));
    }
    if (!list.length) row.child(div().text_size(TS.meta).text_color(t.dim).child("No installed agent has this role."));
    return h_flex().py(4).gap(10).items_center().child(label).child(row);
  }

  async start(cx) {
    const task = this.task.value().trim(), repo = this.repo.value().trim().replace(/^~/, home()), base = this.base.value().trim();
    const P = PATTERNS.find((p) => p.key === this.pattern);
    if (!task) { this.error = "Write the task first."; cx.notify(); return; }
    if (base && (!SAFE_REF.test(base) || base.startsWith("-"))) { this.error = "That base branch name looks wrong."; cx.notify(); return; }
    this.busy = true; this.error = null; cx.notify();
    const isRepo = (await exec("git", ["-C", repo, "rev-parse", "--show-toplevel"], { timeout: 5000 }).catch(() => null));
    if (isRepo?.code !== 0) { this.busy = false; this.error = "That folder isn't a git repository."; cx.notify(); return; }
    const root = isRepo.stdout.trim();
    let baseRef = base;
    if (!baseRef) {
      const s = await exec("git", ["-C", root, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], { timeout: 5000 }).catch(() => null);
      baseRef = s?.code === 0 && s.stdout.trim() ? s.stdout.trim().replace(/^origin\//, "") : "main";
    }
    // The remote chooses origin/HEAD's name, and branch names may hold $ ; ` | &: these go into shell commands.
    if (!SAFE_REF.test(baseRef) || baseRef.startsWith("-")) baseRef = "main";
    const tpl = (role, a) => `${role}-${a}`;
    const multi = (role) => [...this.pick[role]].map((a) => tpl("implementer", a));
    const reviewer = this.useReviewer && this.pick.reviewer ? tpl("reviewer", this.pick.reviewer) : null;
    const rounds = 3;
    const reviewStep = !reviewer ? "" : this.pattern === "research-build"
      ? `5. Start the reviewer in the builder's worktree: \`hc run --bg --name checker --cwd <worktree> ${reviewer} "Review git diff ${baseRef}...HEAD; write to /tmp/review-{{slug}}.md"\`. Send CHANGES findings back to the builder; repeat up to ${rounds} rounds.`
      : `   Review: for each branch, \`hc run --bg --name review-<n> --cwd <worktree> ${reviewer} "Review git diff ${baseRef}...HEAD; write to /tmp/review-{{slug}}-<n>.md"\`; send CHANGES findings back to that member and repeat up to ${rounds} rounds.`;
    const slug = slugify(task);
    let play = (await readTextFile(`${appHome()}/ranch/teams/${this.pattern}.md`).catch(() => null)) ?? "";
    if (!play) { this.busy = false; this.error = "Playbook missing: run herdr-ranch's install.sh."; cx.notify(); return; }
    const vars = { task, repo: sq(root), repo_name: sq(root.split("/").pop()), base: baseRef, slug, rounds: String(rounds), workers: String(Math.max(2, this.pick.implementers.size)),
      implementer: tpl("implementer", this.pick.implementer), implementers: multi("implementers").join(", "), contestants: multi("contestants").join(", "),
      reviewer: reviewer ?? "(none)", researcher: tpl("researcher", this.pick.researcher), review_step: reviewStep };
    play = play.replace(/\{\{review_step\}\}/g, vars.review_step).replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);
    // The task goes first: --allowedTools takes several values and would swallow it.
    // Pre-approve only the hc subcommands a lead uses to run its team. Everything else (git included: `git -c`
    // or aliases can run programs) goes through auto mode's safety classifier as usual. `hc keys` is left out on
    // purpose: answering members' dialogs should be seen by the classifier (or the person).
    const HC_OK = ["hc run --bg", "hc send", "hc wait", "hc read", "hc get", "hc ls", "hc templates", "hc kill", "hc interrupt"];
    // The lead starts on the active Claude account (Accounts dialog); [] for the system login.
    const argv = [...envFor(await loadAccounts(), "claude"), "claude", play, "--permission-mode", "auto", "--allowedTools", HC_OK.map((c) => `Bash(${c}:*)`).join(",")];
    // run() returns nothing: give the lead a unique terminal name, then look its address up through hc.
    const name = `team-${slug}`.slice(0, 26) + "-" + Math.random().toString(36).slice(2, 6);
    run("terminal.open", { argv, folder: root, place: "tab", name });
    let addr = null;
    for (let i = 0; i < 20 && !addr; i++) {
      const g = await exec("hc", ["get", name, "--json"], { timeout: 3000 }).catch(() => null);
      try { addr = g?.code === 0 ? JSON.parse(g.stdout).address : null; } catch {}
      if (!addr) await exec("/bin/sleep", ["0.25"]).catch(() => null);
    }
    const entry = { at: Date.now(), pattern: this.pattern, task, repo: root, base, lead: addr,
      pick: { implementer: this.pick.implementer, reviewer: this.pick.reviewer, researcher: this.pick.researcher,
        implementers: [...this.pick.implementers], contestants: [...this.pick.contestants] }, useReviewer: this.useReviewer };
    try { localStorage.setItem(HISTORY, JSON.stringify([entry, ...this.history.filter((h) => h.task !== task || h.repo !== root)].slice(0, 12))); } catch {}
    closeOverlay(this.overlay);
    if (addr) openPage("team", { lead: addr });
  }

  reuse(h, cx) {
    this.pattern = h.pattern;
    if (typeof this.task.set_value === "function") this.task.set_value(h.task ?? "");
    this.repo.set_value(h.repo ?? "");
    this.base.set_value(h.base ?? "");
    this.applyPick(h.pick ?? {}, h.useReviewer);
    cx.spawn(async (cx) => { await this.resolveRepo(); cx.notify(); });
    cx.notify();
  }

  recent(t) {
    if (!this.history.length) return null;
    return v_flex().gap(4)
      .child(div().text_size(TS.meta).text_color(t.muted).child("Recent teams"))
      .children(this.history.slice(0, 6).map((h, i) => h_flex().id(`nt-h-${i}`).h(28).px(8).gap(8).items_center().rounded(6).bg(t.surface)
        .cursor_pointer().hover((x) => x.bg(t.hover)).tooltip("Fill the form with this team (edit it, then Start)")
        .on_click((_e, cx) => this.reuse(h, cx))
        .child(div().flex_none().text_size(TS.small).text_color(t.accent).child(PATTERNS.find((p) => p.key === h.pattern)?.name ?? h.pattern))
        .child(div().flex_1().min_w(0).truncate().text_size(TS.meta).text_color(t.foreground).child(h.task))
        .child(div().flex_none().text_size(TS.small).text_color(t.dim).child(`${(h.repo ?? "").split("/").pop()} · ${ago(h.at)}`))));
  }

  // Repos as one-click chips (the folder's, when opened from a folder row), plus "Other…" for anything else.
  repoRow(t) {
    const list = this.shownRepos();
    const cur = this.repoRoot;
    const shown = list.slice(0, 8);
    if (cur && !shown.some((r) => r.root === cur)) shown.unshift({ root: cur, name: cur.split("/").pop() });
    const chip = (r, i) => {
      const on = r.root === cur;
      return div().id(`q-r-${i}`).h(24).px(8).flex().items_center().rounded(6).border_1().text_size(TS.meta)
        .border_color(t.border).when(on, (e) => e.bg(t.selected)).text_color(on ? t.foreground : t.muted)
        .cursor_pointer().when(!on, (e) => e.hover((x) => x.bg(t.hover))).tooltip(`${r.root.replace(home(), "~")}${r.folderName ? ` · ${r.folderName}` : ""}`)
        .on_click((_e, cx) => { this.repo.set_value(r.root); this.repoRoot = r.root; this.error = null; cx.notify(); }).child(r.name);
    };
    const folderName = this.folder ? this.repos.find((r) => r.folder === this.folder)?.folderName : null;
    return h_flex().gap(6).flex_wrap().items_center()
      .child(div().text_size(TS.small).text_color(cur ? t.dim : t.blocked).child(folderName ? `${folderName}:` : "Repo:"))
      .children(shown.map(chip))
      .child(div().id("q-other").h(24).px(8).flex().items_center().rounded(6).text_size(TS.meta).text_color(t.accent).cursor_pointer().hover((x) => x.bg(t.hover))
        .on_click((_e, cx) => cx.spawn(async (cx) => { const f = await pickFolder({ prompt: "Use this repository" }); if (f) { this.repo.set_value(f); await this.resolveRepo(); cx.notify(); } }))
        .child(list.length || cur ? "Other…" : "Choose a repo…"));
  }

  compactView(t) {
    const pill = (p) => {
      const on = p.key === this.pattern;
      return div().id(`q-${p.key}`).h(24).px(9).flex().items_center().rounded(12).text_size(TS.meta).border_1()
        .border_color(t.border).when(on, (e) => e.bg(t.selected)).text_color(on ? t.foreground : t.muted)
        .cursor_pointer().when(!on, (e) => e.hover((x) => x.bg(t.hover))).tooltip(p.line).on_click((_e, cx) => { this.pattern = p.key; cx.notify(); }).child(p.name);
    };
    const recent = this.history[0];
    return v_flex().size_full().bg(t.popover ?? t.chrome).text_color(t.foreground).px(SPACE.dialog).py(12).gap(10)
      .child(field(t, this.task, { focused: true }))
      .child(h_flex().gap(6).flex_wrap().children(PATTERNS.map(pill)))
      .child(this.repoRow(t))
      .child(h_flex().gap(8).items_center().text_size(TS.meta)
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(this.summary()))
        .child(div().id("q-more").px(4).mx(-4).rounded(4).text_color(t.accent).cursor_pointer().hover((x) => x.bg(t.hover).text_color(t.foreground))
          .on_click(() => { const st = this.state(); closeOverlay(this.overlay); openOverlay({ mod: "team-launch", kind: "dialog", width: 620, height: 660, props: { full: true, prefill: { ...st, repo: this.repoRoot ?? st.repo } } }); })
          .child("More options…")))
      .child(h_flex().gap(8).items_center().text_size(TS.small)
        .child(div().flex_1().min_w(0).truncate().text_color(this.error ? t.blocked : t.dim).child(this.error ?? (this.busy ? "Starting the lead…" : recent ? `Last: ${recent.task}` : "A lead Claude Code starts in a new tab; the Team map opens.")))
        .when(Boolean(recent) && !this.error && !this.busy, (e) => e.child(div().id("q-again").px(4).mx(-4).rounded(4).text_color(t.accent).cursor_pointer().hover((x) => x.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.reuse(recent, cx)).child("Use last"))));
  }

  render(t) {
    if (this.compact) return this.compactView(t);
    const P = PATTERNS.find((p) => p.key === this.pattern);
    const card = (p) => {
      const on = p.key === this.pattern;
      return v_flex().id(`pt-${p.key}`).flex_1().min_w(0).p(10).gap(4).rounded(8).bg(on ? t.selected : t.surface)
        .cursor_pointer().when(!on, (e) => e.hover((x) => x.bg(t.hover))).on_click((_e, cx) => { this.pattern = p.key; cx.notify(); })
        .child(div().text_size(TS.item).font_semibold().text_color(t.foreground).child(p.name))
        .child(div().text_size(TS.small).text_color(t.muted).child(p.line));
    };
    const labeled = (label, el) => v_flex().gap(4).child(div().text_size(TS.meta).text_color(t.muted).child(label)).child(el);
    const box = (el) => h_flex().min_h(32).px(10).py(6).items_center().rounded(7).border_1().border_color(t.input ?? t.border).bg(t.background).child(el);
    return v_flex().size_full().bg(t.popover ?? t.chrome).text_color(t.foreground)
      .child(h_flex().h(44).px(SPACE.dialog).items_center().border_b(1).border_color(t.border).flex_none()
        .child(dialogTitle(t, "New team")).child(div().flex_1())
        .child(escChip(t, "nt-x", () => closeOverlay(this.overlay))))
      .child(v_flex().id("nt-body").flex_1().min_h(0).px(SPACE.dialog).py(12).gap(14).overflow_y_scrollbar()
        .when(Boolean(this.history.length), (e) => e.child(this.recent(t)))
        .child(labeled("Pattern", v_flex().gap(8).child(h_flex().gap(8).child(card(PATTERNS[0])).child(card(PATTERNS[1]))).child(h_flex().gap(8).child(card(PATTERNS[2])).child(card(PATTERNS[3])))))
        .child(labeled("Task", box(Textarea.new(this.task)).min_h(96)))
        .child(h_flex().gap(10)
          .child(v_flex().flex_1().min_w(0).child(labeled("Repository", h_flex().gap(6).child(box(Input.new(this.repo)).flex_1().min_w(0))
            .child(div().id("nt-pick").h(30).px(10).flex().items_center().rounded(6).border_1().border_color(t.border).text_size(TS.body).cursor_pointer().hover((x) => x.bg(t.hover))
              .on_click((_e, cx) => cx.spawn(async (cx) => { const f = await pickFolder({ prompt: "Use this repository" }); if (f) { this.repo.set_value(f); cx.notify(); } })).child("Choose…")))))
          .child(v_flex().w(200).flex_none().child(labeled("Base branch", box(Input.new(this.base))))))
        .child(labeled("Roles", v_flex().gap(2).children(P.roles.map((r) => this.roleRow(t, r)))))
        .child(div().text_size(TS.small).text_color(t.dim).child("Starts a lead Claude Code in a new tab with this pattern's playbook. It creates worktrees (team/… branches), starts the members through Herdr, and never pushes without asking. The Team map opens so you can watch.")))
      .child(h_flex().h(54).px(SPACE.dialog).gap(10).items_center().border_t(1).border_color(t.border).flex_none()
        .child(div().flex_1().min_w(0).truncate().text_size(TS.meta).text_color(t.blocked).child(this.error ?? ""))
        .child(div().id("nt-cancel").h(30).px(12).flex().items_center().rounded(7).text_size(TS.body).cursor_pointer().hover((x) => x.bg(t.hover)).on_click(() => closeOverlay(this.overlay)).child("Cancel"))
        .child(div().id("nt-start").h(30).px(SPACE.dialog).flex().items_center().rounded(7).text_size(TS.body).bg(this.busy ? t.raised : t.accent).text_color(this.busy ? t.dim : C(t).on.accent)
          .when(!this.busy, (e) => e.cursor_pointer().on_click((_e, cx) => cx.spawn(async (cx) => this.start(cx)))).child(this.busy ? "Starting…" : "Start team")));
  }
}
