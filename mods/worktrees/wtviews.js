// The worktree dialogs, opened as overlays of this mod:
//   { wt: "new", root, on, space }      New worktree: from a base branch, an existing branch, or a PR
//   { wt: "remove", root, path, on, space }  Delete a worktree (and its branch) after showing what would be lost
//   { wt: "clean", root, on }           Clean up: every worktree of the repo with its state, pick and delete
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, closeOverlay, spaces, panes, agents, notify, exec, knownAgents } from "herdr";
import { create, remove, inspect, list, prune, defaultBase, branches, repoName, validBranch } from "./wt.js";
import { TS, C, field as inputField } from "./ui.js";

const ago = (s) => { if (!s) return "–"; const d = Date.now() / 1000 - s; return d < 3600 ? `${Math.round(d / 60)}m` : d < 86400 ? `${Math.round(d / 3600)}h` : `${Math.round(d / 86400)}d`; };
const size = (kb) => (kb == null ? "–" : kb > 1048576 ? `${(kb / 1048576).toFixed(1)} GB` : kb > 1024 ? `${Math.round(kb / 1024)} MB` : `${kb} KB`);
// The space whose terminals work in `path` (a worktree's own space), if any.
const spaceAt = (path) => spaces().find((s) => s.folder === path || panes().some((p) => s.tabs?.some((tb) => tb.id === p.tab) && (p.cwd === path || p.cwd?.startsWith(path + "/"))));

export class WorktreeDialog {
  constructor(p, cx) {
    Object.assign(this, { kind: p.wt, root: p.root, on: p.on ?? null, path: p.path, overlay: p.overlay, busy: false, error: null });
    if (this.kind === "new") {
      this.mode = "new"; // new | existing | pr
      this.name = InputState.new({ placeholder: "feature/my-change" });
      this.base = InputState.new({ placeholder: "origin/main" });
      this.prNum = InputState.new({ placeholder: "PR number, e.g. 312" });
      for (const i of [this.name, this.base, this.prNum]) i.on("change", (_e, cx) => cx.notify());
      this.agent = null; this.agents = [];
      cx.spawn(async (cx) => {
        this.base.set_value(await defaultBase(this.root, this.on));
        this.branchList = await branches(this.root, this.on);
        this.agents = (await knownAgents({ on: this.on }).catch(() => [])).filter((a) => a.installed).slice(0, 4);
        cx.notify();
      });
    } else if (this.kind === "remove") {
      cx.spawn(async (cx) => { this.info = await inspect(this.path, this.on); cx.notify(); });
    } else if (this.kind === "clean") {
      this.rows = null; this.picked = new Set();
      cx.spawn(async (cx) => {
        const wts = await list(this.root, this.on);
        this.rows = wts.map((w) => ({ ...w, info: null }));
        cx.notify();
        for (const r of this.rows) { r.info = r.prunable ? { exists: false } : await inspect(r.path, this.on); cx.notify(); }
      });
    }
  }

  close() { closeOverlay(this.overlay); }

  btn(t, id, label, action, { primary = false, danger = false, disabled = false } = {}) {
    return div().id(id).h(30).px(12).flex().items_center().rounded(7).text_size(TS.body)
      .bg(disabled ? t.raised : danger ? t.blocked : primary ? t.solid : t.raised).text_color(disabled ? t.dim : danger ? C(t).on.status : primary ? C(t).on.solid : t.foreground)
      .when(!disabled, (e) => e.cursor_pointer().on_click(action)).child(label);
  }

  // ---------- New ----------
  async submitNew(cx) {
    this.busy = true; this.error = null; cx.notify();
    try {
      let branch = this.name.value().trim(), from;
      if (this.mode === "pr") {
        const n = Number(this.prNum.value().trim());
        if (!Number.isInteger(n) || n <= 0) throw new Error("Enter a PR number");
        const r = await exec("gh", ["pr", "view", String(n), "--json", "headRefName,isCrossRepository,title"], { cwd: this.root, on: this.on, timeout: 20000 });
        if (r.code !== 0) throw new Error("gh couldn't read that PR");
        const pr = JSON.parse(r.stdout);
        if (pr.isCrossRepository) throw new Error("That PR comes from a fork; check it out with the PR panel's AI review instead");
        branch = branch || pr.headRefName;
        from = { pr: n, head: pr.headRefName };
      } else if (this.mode === "existing") from = { existing: true };
      else from = { base: this.base.value().trim() || "HEAD" };
      if (!branch) throw new Error("Enter a branch name");
      const { path, prep } = await create(this.root, branch, from, this.on);
      run("space.new", { name: branch, folder: path, ...(this.on ? { machine: this.on } : {}), ...(this.agent ? { argv: this.agent.run } : {}) });
      const extra = [prep.copied.length ? `copied ${prep.copied.join(", ")}` : "", prep.linked.length ? `linked ${prep.linked.join(", ")}` : "",
        prep.missing.length ? `missing ${prep.missing.join(", ")}` : "", prep.refused.length ? `refused ${prep.refused.join(", ")}` : ""].filter(Boolean).join(" · ");
      notify({ title: `Worktree ${branch} ready`, body: extra || "No .worktreeinclude files", level: "success" });
      this.close();
    } catch (e) { this.error = String(e.message ?? e); }
    this.busy = false; cx.notify();
  }

  viewNew(t) {
    const tab = (id, label) => div().id(`wtm-${id}`).px(10).py(4).rounded(6).cursor_pointer().text_size(TS.body)
      .bg(this.mode === id ? t.selected : t.background).text_color(this.mode === id ? t.foreground : t.muted)
      .hover((s) => s.bg(this.mode === id ? t.selected : t.hover)).on_click((_e, cx) => { this.mode = id; cx.notify(); }).child(label);
    const field = (label, input, hint) => v_flex().gap(4).child(div().text_size(TS.meta).text_color(t.dim).child(label)).child(inputField(t, input, { size: "panel" }))
      .when(Boolean(hint), (e) => e.child(div().text_size(TS.small).text_color(t.dim).child(hint)));
    const suggestions = this.mode === "existing" && this.branchList?.length
      ? h_flex().flex_wrap().gap(4).children(this.branchList.filter((b) => !b.startsWith("origin/") || !this.branchList.includes(b.slice(7))).slice(0, 8)
          .map((b) => div().id(`wtb-${b}`).px(6).py(1).rounded(5).border_1().border_color(t.border).text_size(TS.small).text_color(t.muted).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { this.name.set_value(b.replace(/^origin\//, "")); cx.notify(); }).child(b)))
      : null;
    return v_flex().size_full().p(16).gap(12).text_color(t.foreground)
      .child(div().text_size(TS.title).font_semibold().child(`New worktree · ${repoName(this.root)}`))
      .child(h_flex().gap(4).child(tab("new", "New branch")).child(tab("existing", "Existing branch")).child(tab("pr", "From PR")))
      .when(this.mode === "new", (e) => e.child(field("Branch name", this.name)).child(field("Branch from", this.base, "A branch, tag or commit. Defaults to the remote's default branch.")))
      .when(this.mode === "existing", (e) => e.child(field("Branch", this.name, "Local, or on origin (a tracking branch is created).")).when(Boolean(suggestions), (x) => x.child(suggestions)))
      .when(this.mode === "pr", (e) => e.child(field("Pull request", this.prNum)).child(field("Local branch name (optional)", this.name, "Defaults to the PR's branch.")))
      .child(h_flex().gap(6).items_center().child(div().text_size(TS.meta).text_color(t.dim).child("Start"))
        .children([null, ...this.agents].map((a) => div().id(`wta-${a?.key ?? "none"}`).px(8).py(2).rounded(6).cursor_pointer().text_size(TS.body)
          .bg(this.agent?.key === a?.key ? t.selected : t.background).text_color(t.muted)
          .on_click((_e, cx) => { this.agent = a; cx.notify(); }).child(a?.name ?? "Shell only"))))
      .child(div().text_size(TS.small).text_color(t.dim).child("Copies the files listed in .worktreeinclude from the main checkout and links orca.yaml sharedDirectories."))
      .when(Boolean(this.error), (e) => e.child(div().text_size(TS.body).text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(h_flex().gap(8).justify_end()
        .child(this.btn(t, "wt-cancel", "Cancel", () => this.close()))
        .child(this.btn(t, "wt-create", this.busy ? "Creating…" : "Create", (_e, cx) => cx.spawn(async (cx) => this.submitNew(cx)), { primary: true, disabled: this.busy })));
  }

  // ---------- Remove ----------
  async submitRemove(cx, { force }) {
    this.busy = true; this.error = null; cx.notify();
    try {
      const sp = spaceAt(this.path);
      if (sp) run("space.close", { id: sp.id, confirmed: true });
      const unmerged = (this.info?.unmerged ?? 0) > 0;
      const r = await remove(this.root, this.path, this.info?.branch, { force, deleteBranch: true, forceBranch: force && unmerged }, this.on);
      notify({ title: `Removed ${this.info?.branch ?? "worktree"}`, body: r.branchKept ? `Branch kept: ${r.branchKept}` : "Worktree and branch deleted", level: "success" });
      this.close();
    } catch (e) { this.error = String(e.message ?? e); }
    this.busy = false; cx.notify();
  }

  viewRemove(t) {
    const i = this.info, sp = spaceAt(this.path);
    const running = sp ? agents().filter((a) => a.space === sp.id && a.status === "working").length : 0;
    const risks = !i ? [] : [
      i.dirty ? [t.blocked, `${i.dirty} uncommitted change${i.dirty === 1 ? "" : "s"} will be lost`] : null,
      i.unpushed > 0 ? [t.blocked, `${i.unpushed} commit${i.unpushed === 1 ? "" : "s"} not pushed`] : i.unpushed < 0 && i.unmerged > 0 ? [t.working, "Branch was never pushed"] : null,
      i.unmerged > 0 ? [t.working, `${i.unmerged} commit${i.unmerged === 1 ? "" : "s"} not in the default branch (branch kept unless you force)`] : null,
      running ? [t.blocked, `${running} agent${running === 1 ? " is" : "s are"} still working here`] : null,
    ].filter(Boolean);
    const safe = i && !risks.some(([c]) => c === t.blocked);
    return v_flex().size_full().p(16).gap(10).text_color(t.foreground)
      .child(div().text_size(TS.title).font_semibold().child(`Delete worktree ${i?.branch ?? ""}`))
      .child(div().text_size(TS.meta).text_color(t.dim).child(this.path))
      .when(!i, (e) => e.child(div().text_size(TS.body).text_color(t.dim).child("Checking what would be lost…")))
      .when(Boolean(i) && !risks.length, (e) => e.child(div().text_size(TS.body).text_color(t.done).child("Clean: nothing uncommitted, everything pushed and merged.")))
      .children(risks.map(([c, s], k) => h_flex().id(`risk-${k}`).gap(8).items_center().text_size(TS.body)
        .child(div().size(7).rounded(4).bg(c)).child(div().text_color(t.foreground).child(s))))
      .child(div().text_size(TS.small).text_color(t.dim).child("Closes its space, removes the folder, then deletes the branch (kept when it has unmerged commits)."))
      .when(Boolean(this.error), (e) => e.child(div().text_size(TS.body).text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(h_flex().gap(8).justify_end()
        .child(this.btn(t, "wr-cancel", "Cancel", () => this.close()))
        .when(Boolean(i) && !safe, (e) => e.child(this.btn(t, "wr-force", "Delete anyway", (_e, cx) => cx.spawn(async (cx) => this.submitRemove(cx, { force: true })), { danger: true, disabled: this.busy })))
        .when(Boolean(i) && safe, (e) => e.child(this.btn(t, "wr-ok", this.busy ? "Deleting…" : "Delete", (_e, cx) => cx.spawn(async (cx) => this.submitRemove(cx, { force: false })), { danger: true, disabled: this.busy }))));
  }

  // ---------- Clean up ----------
  async submitClean(cx) {
    this.busy = true; cx.notify();
    const done = [], kept = [];
    for (const r of this.rows.filter((r) => this.picked.has(r.path))) {
      try {
        if (r.prunable || !r.info?.exists) { await prune(this.root, this.on); done.push(r.branch ?? r.path); continue; }
        const sp = spaceAt(r.path);
        if (sp) run("space.close", { id: sp.id, confirmed: true });
        const res = await remove(this.root, r.path, r.branch, { force: false, deleteBranch: true }, this.on);
        done.push(r.branch); if (res.branchKept) kept.push(r.branch);
      } catch (e) { kept.push(`${r.branch}: ${String(e.message ?? e).slice(0, 80)}`); }
    }
    notify({ title: `Cleaned up ${done.length} worktree${done.length === 1 ? "" : "s"}`, body: kept.length ? `Kept / failed: ${kept.join("; ")}` : "Done", level: kept.length ? "warning" : "success" });
    this.close();
  }

  viewClean(t) {
    const rows = this.rows ?? [];
    const state = (r) => {
      const i = r.info;
      if (r.prunable || (i && !i.exists)) return [t.dim, "stale (folder gone)", true];
      if (!i) return [t.dim, "checking…", false];
      if (i.dirty) return [t.blocked, `${i.dirty} uncommitted`, false];
      if (i.unpushed > 0) return [t.blocked, `${i.unpushed} unpushed`, false];
      if (i.unmerged === 0) return [t.done, "merged", true];
      return [t.working, `${i.unmerged} not merged`, false];
    };
    return v_flex().size_full().p(16).gap(8).text_color(t.foreground)
      .child(div().text_size(TS.title).font_semibold().child(`Clean up worktrees · ${repoName(this.root)}`))
      .child(div().text_size(TS.small).text_color(t.dim).child("Merged and stale worktrees are pre-selected. Ones with uncommitted or unpushed work can't be picked here; use Delete on the row."))
      .when(!this.rows, (e) => e.child(div().text_size(TS.body).text_color(t.dim).child("Reading worktrees…")))
      .when(Boolean(this.rows) && !rows.length, (e) => e.child(div().text_size(TS.body).text_color(t.dim).child("No linked worktrees.")))
      .child(v_flex().id("wc-list").flex_1().min_h(0).overflow_y_scrollbar().gap(2).children(rows.map((r, k) => {
        const [c, label, ok] = state(r);
        if (ok && r.info && !this.autoPicked?.has(r.path)) { (this.autoPicked ??= new Set()).add(r.path); this.picked.add(r.path); }
        const on = this.picked.has(r.path);
        return h_flex().id(`wc-${k}`).h(30).px(6).gap(8).items_center().rounded(6).text_size(TS.body)
          .when(ok, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { on ? this.picked.delete(r.path) : this.picked.add(r.path); cx.notify(); }))
          .child(div().size(13).flex_none().rounded(3).border_1().border_color(on ? t.accent : t.input).when(on, (e) => e.bg(t.accent)).when(!ok, (e) => e.opacity(0.3)))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(r.branch ?? r.path.split("/").pop()))
          .child(div().flex_none().text_color(c).child(label))
          .child(div().w(44).flex_none().text_right().text_color(t.dim).child(ago(r.info?.last)))
          .child(div().w(56).flex_none().text_right().text_color(t.dim).child(size(r.info?.kb)));
      })))
      .child(h_flex().gap(8).justify_end()
        .child(this.btn(t, "wc-cancel", "Cancel", () => this.close()))
        .child(this.btn(t, "wc-ok", this.busy ? "Deleting…" : `Delete ${this.picked?.size ?? 0}`, (_e, cx) => cx.spawn(async (cx) => this.submitClean(cx)),
          { danger: true, disabled: this.busy || !this.picked?.size })));
  }

  render(t) {
    return this.kind === "new" ? this.viewNew(t) : this.kind === "remove" ? this.viewRemove(t) : this.viewClean(t);
  }
}
