// PR & issue panel: tabs Mine / Review / This repo / Issues, PRs grouped by whose move it is,
// one click to an agent in a worktree (Review, Address comments, Fix CI). Data: the user's `gh`.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, focused, panes, spaces, notify, pickFolder, props, run, shared, setShared } from "herdr";
import { loadRequesters, runRequester } from "./requesters.js";
import { TABS, GROUPS, load, loadOne, groupOf, checksOf, unresolvedOf, repoAt, mainCheckout } from "./github.js";
import { startPR, startIssue, openDiffBeside } from "./launch.js";
import { TS, SPACE, C, tint, icon } from "./ui.js";

const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};

export default class PRPanel extends View {
  init(_props, cx) {
    this.tab = localStorage.getItem("tab") ?? "mine";
    if (this.tab === "repo") this.tab = "space";
    this.data = {};      // tab id -> { items, error, at }
    this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? '["draft","stale"]'));
    if (!localStorage.getItem("staleInit")) { this.folded.add("stale"); localStorage.setItem("staleInit", "1"); }
    this.repos = JSON.parse(localStorage.getItem("repos") ?? "{}"); // owner/name -> local main checkout
    this.busy = {};      // key -> true while launching
    this.groupBy = localStorage.getItem("groupBy") ?? "status"; // "status" | "repo"
    this.spaceId = null; this.spaceRepos = [];
    this.requesters = [];  // from ~/.config/herdr-app/pr-panel.json (see requesters.js)
    this.armed = null;     // "<requester id>|<PR url>" waiting for its confirming click
    this.sent = JSON.parse(localStorage.getItem("requested") ?? "{}"); // "<id>|<url>" -> ms
    this.refresh(cx);
    cx.timer.every(120000, (cx) => this.refresh(cx));
    // Reveal requests from other mods (e.g. git-graph's PR badges): shared "pr-panel.reveal" = {repo, number, at}.
    // A heartbeat says someone listens, so senders fall back to opening GitHub when no panel is installed.
    this.started = Date.now();
    setShared("pr-panel.listening", Date.now());
    cx.timer.every(60000, () => setShared("pr-panel.listening", Date.now()));
  }

  save() {
    localStorage.setItem("tab", this.tab);
    localStorage.setItem("groupBy", this.groupBy);
    localStorage.setItem("folded", JSON.stringify([...this.folded]));
    localStorage.setItem("repos", JSON.stringify(this.repos));
  }

  refresh(cx, only) {
    cx.spawn(async (cx) => {
      await this.computeSpaceRepos();
      const rq = await loadRequesters();
      this.requesters = rq.list;
      if (rq.error && rq.error !== this.rqError) notify({ title: "PR panel", body: rq.error, level: "error" });
      this.rqError = rq.error;
      for (const tab of TABS.filter((t) => !only || t.id === only)) {
        this.data[tab.id] = { ...(this.data[tab.id] ?? {}), loading: true };
        cx.notify();
        try {
          const items = await load(tab, this.spaceRepos);
          this.data[tab.id] = { items, at: Date.now() };
        } catch (e) {
          this.data[tab.id] = { ...(this.data[tab.id] ?? {}), error: String(e.message ?? e), loading: false };
        }
        cx.notify();
      }
    });
  }

  // GitHub repos of every terminal (and the start folder) in the focused space.
  async computeSpaceRepos() {
    const f = focused();
    const sp = spaces().find((s) => s.id === f?.space);
    this.spaceId = sp?.id ?? null;
    this.spaceName = sp?.name ?? null;
    if (!sp) { this.spaceRepos = []; return; }
    const tabIds = new Set((sp.tabs ?? []).map((t) => t.id));
    const dirs = new Set([sp.folder, ...panes().filter((p) => tabIds.has(p.tab)).map((p) => p.cwd)].filter(Boolean));
    const repos = new Set();
    for (const d of dirs) { const r = await repoAt(d).catch(() => null); if (r) repos.add(r); }
    this.spaceRepos = [...repos].sort();
  }

  // Local main checkout for owner/name: remembered, else found among open terminals, else ask.
  async localRepo(name) {
    if (this.repos[name] && (await repoAt(this.repos[name])) === name) return this.repos[name];
    const dirs = new Set([...panes().map((p) => p.cwd), ...spaces().map((s) => s.folder)].filter(Boolean));
    for (const d of dirs) {
      if ((await repoAt(d)) !== name) continue;
      const main = await mainCheckout(d);
      if (main) { this.repos[name] = main; this.save(); return main; }
    }
    const picked = await pickFolder({ prompt: `Where is ${name} cloned on this Mac?` });
    if (!picked) return null;
    if ((await repoAt(picked)) !== name) {
      notify({ title: "Not that repo", body: `${picked} is not a clone of ${name}.`, level: "error" });
      return null;
    }
    this.repos[name] = (await mainCheckout(picked)) ?? picked;
    this.save();
    return this.repos[name];
  }

  launch(cx, key, item, action) {
    if (this.busy[key]) return;
    this.busy[key] = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const repo = await this.localRepo(item.repository.nameWithOwner);
        if (repo) action === "issue" ? await startIssue(repo, item) : await startPR(repo, item, action);
      } catch (e) {
        notify({ title: "Could not start the agent", body: String(e.message ?? e), level: "error" });
      }
      delete this.busy[key];
      cx.notify();
    });
  }

  request(cx, req, pr) {
    const key = `${req.id}|${pr.url}`;
    if (req.confirm && this.armed !== key) {
      this.armed = key; // first click arms, second click runs; disarms after 5 s
      cx.timer.after(5000, (cx) => { if (this.armed === key) { this.armed = null; cx.notify(); } });
      cx.notify();
      return;
    }
    this.armed = null;
    this.busy[key] = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = await runRequester(req, pr);
        if (res.ok) {
          this.sent[key] = Date.now();
          localStorage.setItem("requested", JSON.stringify(this.sent));
          notify({ title: `${req.label}: #${pr.number}`, body: res.message || "Done", level: "success" });
        } else {
          notify({ title: `${req.label} failed`, body: `${res.error ?? "error"}${res.hint ? ` · ${res.hint}` : ""}`, level: "error" });
        }
      } catch (e) {
        notify({ title: `${req.label} failed`, body: String(e.message ?? e), level: "error" });
      }
      delete this.busy[key];
      cx.notify();
    });
  }

  requestPills(t, pr) {
    return this.requesters.map((req) => {
      const key = `${req.id}|${pr.url}`;
      if (this.busy[key]) return div().text_size(TS.small).text_color(t.working).child(`${req.label}…`);
      if (this.armed === key) return this.pill(t, `rq-${key}`, `${req.label}?`, (_e, cx) => this.request(cx, req, pr), { tone: "accent", tip: "Click again to confirm" });
      const done = this.sent[key];
      return this.pill(t, `rq-${key}`, done ? h_flex().gap(4).items_center().child(req.label).child(icon("check", 12, C(t).status.done)).child(ago(new Date(done).toISOString())) : req.label, (_e, cx) => this.request(cx, req, pr),
        { tip: (done ? "Already done. " : "") + (req.tip ?? (req.confirm ? "Click, then confirm" : "")) });
    });
  }

  // ---------- UI ----------
  pill(t, id, label, onClick, { tone = "muted", disabled = false, tip } = {}) {
    const fg = tone === "danger" ? t.blocked : tone === "accent" ? t.accent : t.muted;
    let el = div().id(id).px(7).py(2).rounded(5).border(1).border_color(t.border).text_size(TS.small)
      .text_color(disabled ? t.dim : fg);
    if (tip) el = el.tooltip(tip);
    if (disabled) return el.child(label);
    return el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((e, cx) => { cx.stop_propagation(); onClick(e, cx); }).child(label);
  }

  checkBadge(t, pr) {
    const c = checksOf(pr);
    if (!c) return null;
    const st = C(t).status;
    const [name, color, tip] = c === "SUCCESS" ? ["check", st.done, "Checks passed"] : c === "FAILURE" || c === "ERROR" ? ["x", st.blocked, "Checks failing"] : ["circle-dot", st.working, "Checks running"];
    return div().id(`ck-${pr.url}`).flex_none().tooltip(tip).child(icon(name, 12, color));
  }

  prCard(t, pr, cx) {
    const key = pr.url;
    const g = groupOf(pr);
    const unresolved = unresolvedOf(pr);
    const review = pr.reviewDecision === "APPROVED" ? ["approved", C(t).status.done] : pr.reviewDecision === "CHANGES_REQUESTED" ? ["changes requested", C(t).status.blocked] : null;
    const repoShort = pr.repository.nameWithOwner.split("/")[1];
    const busy = this.busy[key];
    return v_flex().id(`pr-${key}`).mx(8).px(10).py(8).gap(6).rounded(8).bg(t.surface)
      .hover((s) => s.bg(t.hover))
      .child(div().text_size(TS.item).text_color(t.foreground).child(pr.title))
      .child(h_flex().gap(6).items_center().text_size(TS.small).text_color(t.dim)
        .child(div().flex_none().child(`${repoShort} #${pr.number}`))
        .child(div().min_w(0).truncate().child(`· ${pr.headRefName}`))
        .child(div().flex_1())
        .when(Boolean(this.checkBadge(t, pr)), (el) => el.child(this.checkBadge(t, pr)))
        .when(Boolean(review), (el) => el.child(div().text_color(review[1]).child(review[0])))
        .when(unresolved > 0, (el) => el.child(h_flex().id(`un-${key}`).gap(2).items_center().text_color(t.working).tooltip(`${unresolved} unresolved review thread(s)`).child(icon("message-square", 12, t.working)).child(String(unresolved))))
        .child(div().flex_none().child(ago(pr.updatedAt))))
      .child(h_flex().flex_wrap().gap(6).items_center()
        .when(busy, (el) => el.child(div().text_size(TS.small).text_color(t.working).child("starting agent…")))
        .when(!busy, (el) => {
          const fork = pr.isCrossRepository;
          const noFork = { disabled: true, tip: "Fork PR: not checked out, can't push" };
          return el
            .when(g === "failing", (el) => el.child(this.pill(t, `fx-${key}`, "Fix CI", (_e, cx) => this.launch(cx, key, pr, "checks"), fork ? noFork : { tone: "danger", tip: "Claude in a worktree: read failing CI logs, fix, commit (asks before push)" })))
            .when(g === "comments", (el) => el.child(this.pill(t, `ad-${key}`, "Fix comments", (_e, cx) => this.launch(cx, key, pr, "comments"), fork ? noFork : { tone: "danger", tip: "Claude in a worktree: fix review feedback, commit, ask before push; then offers to reply + resolve threads" })))
            .child(this.pill(t, `rv-${key}`, "AI review", (_e, cx) => this.launch(cx, key, pr, "review"), { tip: "Claude reviews the PR from your main checkout (diff read as data, branch never checked out). Nothing is posted." }))
            .child(this.pill(t, `ak-${key}`, "Ask Claude", (_e, cx) => this.launch(cx, key, pr, "ask"), { tone: "accent", tip: "Claude reads the PR, summarizes it and waits for your questions; the diff opens beside it" }))
            .child(this.pill(t, `df-${key}`, "Diff", () => openDiffBeside(pr), { tip: "Open the diff next to the focused pane" }))
            .children(this.requestPills(t, pr))
            .child(div().flex_1())
            .child(this.pill(t, `op-${key}`, icon("external-link", 12, t.muted), () => { if (/^https:\/\//.test(String(pr.url))) exec("open", [pr.url]); }, { tip: "Open on GitHub" }));
        }));
  }

  issueCard(t, is) {
    const key = is.url;
    const busy = this.busy[key];
    return v_flex().id(`is-${key}`).mx(8).px(10).py(8).gap(6).rounded(8).bg(t.surface)
      .hover((s) => s.bg(t.hover))
      .child(div().text_size(TS.item).text_color(t.foreground).child(is.title))
      .child(h_flex().gap(6).items_center().text_size(TS.small).text_color(t.dim)
        .child(div().flex_none().child(`${is.repository.nameWithOwner.split("/")[1]} #${is.number}`))
        .children((is.labels?.nodes ?? []).map((l) => div().px(5).rounded(4).bg(tint(`#${l.color}`, 0.2)).text_color(t.muted).child(l.name)))
        .child(div().flex_1())
        .child(div().child(ago(is.updatedAt))))
      .child(h_flex().gap(6)
        .when(busy, (el) => el.child(div().text_size(TS.small).text_color(t.working).child("starting agent…")))
        .when(!busy, (el) => el
          .child(this.pill(t, `st-${key}`, "Start", (_e, cx) => this.launch(cx, key, is, "issue"), { tone: "accent", tip: "New worktree + agent: plan first, then implement" }))
          .child(div().flex_1())
          .child(this.pill(t, `op-${key}`, icon("external-link", 12, t.muted), () => { if (/^https:\/\//.test(String(is.url))) exec("open", [is.url]); }, { tip: "Open on GitHub" }))));
  }

  groupHeader(t, g, count, cx) {
    const open = !this.folded.has(g.id);
    return h_flex().id(`grp-${g.id}`).px(12).pt(10).pb(4).gap(6).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .text_size(TS.meta).font_medium()
      .on_click((_e, cx) => { open ? this.folded.add(g.id) : this.folded.delete(g.id); this.save(); cx.notify(); })
      .child(icon(open ? "chevron-down" : "chevron-right", 12, t.dim))
      .child(div().w(6).h(6).rounded(3).bg(C(t).status[g.status] ?? t.dim))
      .child(div().text_color(t.muted).child(g.label))
      .child(div().text_color(t.dim).child(String(count)));
  }

  body(t, cx) {
    const tab = TABS.find((x) => x.id === this.tab) ?? TABS[0];
    const d = this.data[tab.id] ?? {};
    const note = (text, color = t.dim) => div().px(SPACE.panel).py(12).text_size(TS.body).text_color(color).child(text);
    if (tab.id === "space" && !this.spaceRepos.length) return [note(`No GitHub repo found in the space "${this.spaceName ?? "?"}". Open a terminal inside a repo there.`)];
    if (d.error && !d.items) return [note(`GitHub: ${d.error}`, t.blocked)];
    if (!d.items) return [note("Loading…")];
    if (!d.items.length) return [note(tab.kind === "pr" ? "No open pull requests here." : "No open issues assigned to you.")];
    if (tab.kind === "issue") return [...d.items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).flatMap((is) => [this.issueCard(t, is), div().h(6)]);
    const out = [];
    const byTime = (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (this.groupBy === "repo") {
      const repos = new Map();
      for (const p of d.items) { const r = p.repository.nameWithOwner; if (!repos.has(r)) repos.set(r, []); repos.get(r).push(p); }
      // Repos with something urgent first, then by most recent activity.
      const urgency = (ps) => Math.min(...ps.map((p) => GROUPS.findIndex((g) => g.id === groupOf(p))));
      const sorted = [...repos.entries()].sort((a, b) => urgency(a[1]) - urgency(b[1]) || byTime(a[1].sort(byTime)[0], b[1].sort(byTime)[0]));
      for (const [repo, ps] of sorted) {
        const g = { id: `repo:${repo}`, label: repo.split("/")[1], status: GROUPS[urgency(ps)]?.status ?? "idle" };
        out.push(this.groupHeader(t, g, ps.length, cx));
        if (!this.folded.has(g.id)) for (const p of ps.sort(byTime)) out.push(this.prCard(t, p, cx), div().h(6));
      }
      return out;
    }
    for (const g of GROUPS) {
      const items = d.items.filter((p) => groupOf(p) === g.id).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      if (!items.length) continue;
      out.push(this.groupHeader(t, g, items.length, cx));
      if (!this.folded.has(g.id)) for (const p of items) out.push(this.prCard(t, p, cx), div().h(6));
    }
    return out;
  }

  // Show a requested PR at the top of the panel and bring the panel forward (props.reveal = {stack, child, panel}).
  handleReveal(cx) {
    const rv = shared("pr-panel.reveal");
    if (!rv?.at || rv.at === this.seenReveal || rv.at < this.started - 5000) return;
    this.seenReveal = rv.at;
    const where = props()?.reveal;
    if (where?.panel) run("layout.show", { id: where.panel });
    if (where?.stack && where?.child) run("layout.select", { stack: where.stack, child: where.child });
    const known = Object.values(this.data).flatMap((d) => d.items ?? []).find((p) => p.url === rv.url);
    this.revealed = { repo: rv.repo, number: rv.number, url: rv.url, pr: known ?? null };
    if (!known) cx.spawn(async (cx) => {
      const pr = await loadOne(rv.repo, Number(rv.number)).catch(() => null);
      if (this.revealed?.url === rv.url) { this.revealed.pr = pr; this.revealed.missing = !pr; cx.notify(); }
    });
  }

  render(cx) {
    const t = theme();
    this.handleReveal(cx);
    const d = this.data[this.tab] ?? {};
    // Space tab follows the selected space.
    const sid = focused()?.space ?? null;
    if (sid !== this.spaceId && !this.spaceSwitching) {
      this.spaceSwitching = true;
      this.spaceId = sid;
      cx.spawn(async (cx) => { this.refresh(cx, "space"); this.spaceSwitching = false; });
    }
    const isPR = (TABS.find((x) => x.id === this.tab) ?? TABS[0]).kind === "pr";
    const seg = (id, label) => div().id(`gb-${id}`).px(6).py(1).rounded(4).cursor_pointer().text_size(TS.small)
      .text_color(this.groupBy === id ? t.foreground : t.dim).when(this.groupBy === id, (el) => el.bg(t.selected))
      .hover((s) => s.bg(this.groupBy === id ? t.selected : t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { this.groupBy = id; this.save(); cx.notify(); }).child(label);
    return v_flex().id("pr-panel").size_full().bg(t.chrome).text_color(t.foreground)
      .child(h_flex().px(12).h(36).flex_none().gap(4).items_center()
        .children(TABS.map((tab) => {
          const on = tab.id === this.tab;
          const n = this.data[tab.id]?.items?.length;
          return div().id(`tab-${tab.id}`).px(8).py(4).rounded(6).text_size(TS.body).cursor_pointer()
            .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .tooltip(tab.id === "space" ? (this.spaceRepos.length ? `${this.spaceName}: ${this.spaceRepos.join(", ")}` : "No repo in this space") : tab.label)
            .on_click((_e, cx) => { this.tab = tab.id; this.save(); if (tab.id === "space") this.refresh(cx, "space"); cx.notify(); })
            .child(n != null ? `${tab.label} ${n}` : tab.label);
        }))
        .child(div().flex_1())
        .child(div().id("pr-refresh").px(6).py(4).rounded(5).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Refresh")
          .on_click((_e, cx) => this.refresh(cx))
          .child(d.loading ? "…" : icon("refresh-cw", 14, t.dim))))
      .when(isPR, (el) => el.child(h_flex().px(12).h(28).flex_none().gap(4).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(TS.small).text_color(t.dim).child("Group by"))
        .child(seg("status", "Status")).child(seg("repo", "Repo"))
        .when(this.tab === "space" && this.spaceRepos.length > 0, (el) => el.child(div().flex_1()).child(div().min_w(0).truncate().text_size(TS.small).text_color(t.dim).child(this.spaceRepos.map((r) => r.split("/")[1]).join(" · "))))))
      .when(Boolean(this.revealed), (el) => el.child(v_flex().flex_none().pt(8).pb(4).bg(tint(t.accent, 0.07)).border_b(1).border_color(t.border)
        .child(h_flex().px(12).pb(6).gap(6).items_center().text_size(TS.meta)
          .child(div().text_color(t.accent).child(`From Git graph · #${this.revealed.number}`))
          .child(div().flex_1())
          .child(div().id("rv-close").p(3).rounded(4).cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.revealed = null; cx.notify(); }).child(icon("x", 12, t.dim))))
        .child(this.revealed.pr ? this.prCard(t, this.revealed.pr, cx)
          : div().px(SPACE.panel).pb(6).text_size(TS.body).text_color(t.dim).child(this.revealed.missing ? "Couldn't load this PR." : "Loading…"))))
      .child(v_flex().id("pr-list").flex_1().min_h(0).pb(10).overflow_y_scrollbar().children(this.body(t, cx)));
  }
}
