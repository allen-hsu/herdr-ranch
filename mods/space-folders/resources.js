// herdr-extensions: a worktree resource manager, like Orca's. Two views of this mod (props.resources):
//   "pill"   a status-bar button: worktree count, disk used, how many can be cleaned; click opens the window
//   "window" every repo's worktrees (repos = the main checkouts behind this computer's spaces) with state,
//            agent activity, last commit, size; cleanable ones pre-selected; plus folders under
//            ~/.herdr/worktrees that git no longer knows (never pre-selected).
// Cleanable: stale (folder gone), or merged + clean + pushed + no agent working there.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, spaces, panes, agents, run, openOverlay, notify, home, shared, setShared } from "herdr";
import { mainRoot, list, inspect, remove, prune, repoName } from "./wt.js";

const CACHE = "space-folders.resources"; // shared: { at, repos: [...], orphans: [...] } so pill and window agree
const ago = (s) => { if (!s) return "–"; const d = Date.now() / 1000 - s; return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : `${Math.round(d / 86400)}d`; };
const size = (kb) => (kb == null ? "–" : kb > 1048576 ? `${(kb / 1048576).toFixed(1)} GB` : kb > 1024 ? `${Math.round(kb / 1024)} MB` : `${kb} KB`);
const spaceAt = (path) => spaces().find((s) => !s.machine && (s.folder === path || panes().some((p) => s.tabs?.some((tb) => tb.id === p.tab) && (p.cwd === path || p.cwd?.startsWith(path + "/")))));
const working = (path) => { const sp = spaceAt(path); return sp ? agents().filter((a) => a.space === sp.id && (a.status === "working" || a.status === "blocked")).length : 0; };

export function verdict(w) {
  const i = w.info;
  if (w.orphan) return { cls: "orphan", text: "not a worktree any more", ok: false, opt: true };
  if (w.prunable || (i && !i.exists)) return { cls: "stale", text: "stale (folder gone)", ok: true };
  if (!i) return { cls: "pending", text: "checking…", ok: false };
  const busy = working(w.path);
  if (busy) return { cls: "busy", text: `agent ${busy > 1 ? `×${busy} ` : ""}working`, ok: false };
  if (i.dirty) return { cls: "keep", text: `${i.dirty} uncommitted`, ok: false };
  if (i.unpushed > 0) return { cls: "keep", text: `${i.unpushed} unpushed`, ok: false };
  if (i.unmerged > 0) return { cls: "keep", text: `${i.unmerged} not merged`, ok: false };
  return { cls: "clean", text: "merged · clean", ok: true };
}

// Read every repo behind this computer's spaces, then sizes; store in shared state.
export async function scan(onProgress) {
  const roots = new Set();
  for (const s of spaces().filter((s) => !s.machine)) {
    const dirs = [s.folder, ...panes().filter((p) => s.tabs?.some((tb) => tb.id === p.tab)).map((p) => p.cwd)].filter(Boolean);
    for (const d of dirs) { const r = await mainRoot(d, null).catch(() => null); if (r) { roots.add(r); break; } }
  }
  const repos = [];
  for (const root of [...roots].sort()) {
    const wts = await list(root, null).catch(() => []);
    if (wts.length) repos.push({ root, name: repoName(root), worktrees: wts.map((w) => ({ ...w, info: null })) });
  }
  // Folders under Herdr's worktree layout that no listed repo knows. One that is still a git worktree belongs
  // to a repo without an open space: list that repo too (normal checks apply). Only folders git doesn't
  // recognise at all are leftovers.
  const base = `${home()}/.herdr/worktrees`;
  const found = await exec("find", [base, "-mindepth", "2", "-maxdepth", "2", "-type", "d"], { timeout: 15000 }).catch(() => null);
  const candidates = found?.code === 0 ? found.stdout.split("\n").filter(Boolean) : [];
  let known = new Set(repos.flatMap((r) => r.worktrees.map((w) => w.path)));
  for (const p of candidates.filter((p) => !known.has(p))) {
    const root = await mainRoot(p, null).catch(() => null);
    if (!root || roots.has(root)) continue;
    roots.add(root);
    const wts = await list(root, null).catch(() => []);
    if (wts.length) repos.push({ root, name: repoName(root), worktrees: wts.map((w) => ({ ...w, info: null })) });
    known = new Set(repos.flatMap((r) => r.worktrees.map((w) => w.path)));
  }
  const orphans = [];
  for (const p of candidates.filter((p) => !known.has(p))) {
    if (await mainRoot(p, null).catch(() => null)) continue; // a git checkout we couldn't place: never offer to delete
    orphans.push({ path: p, orphan: true, branch: p.split("/").slice(-2).join("/"), info: null });
  }
  const state = { at: Date.now(), repos, orphans };
  setShared(CACHE, state); onProgress?.();
  for (const r of repos) for (const w of r.worktrees) {
    w.info = w.prunable ? { exists: false } : await inspect(w.path, null).catch(() => null);
    setShared(CACHE, { ...state }); onProgress?.();
  }
  for (const o of orphans) {
    const du = await exec("du", ["-sk", o.path], { timeout: 30000 }).catch(() => null);
    o.info = { exists: true, kb: du?.code === 0 ? Number(du.stdout.split(/\s/)[0]) || null : null };
    setShared(CACHE, { ...state }); onProgress?.();
  }
  return state;
}

export function totals(state) {
  const all = [...(state?.repos ?? []).flatMap((r) => r.worktrees), ...(state?.orphans ?? [])];
  return { count: all.length, kb: all.reduce((n, w) => n + (w.info?.kb ?? 0), 0), cleanable: all.filter((w) => verdict(w).ok).length };
}

// ---------- the status-bar pill ----------
export class ResourcesPill {
  constructor(cx) {
    this.go(cx);
    cx.timer.every(300000, (cx) => this.go(cx));
  }
  go(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => { try { await scan(() => cx.notify()); } finally { this.busy = false; cx.notify(); } });
  }
  render(t) {
    const s = totals(shared(CACHE));
    return h_flex().id("wt-pill").size_full().px(8).gap(6).items_center().justify_end().text_size(11).text_color(t.dim)
      .child(h_flex().id("wt-pill-btn").h(20).px(7).gap(5).items_center().rounded(5).cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground))
        .tooltip("Worktrees across your repos: state, size, what can be cleaned")
        .on_click(() => openOverlay({ mod: "space-folders", kind: "window", key: "worktree-resources", width: 760, height: 520, props: { resources: "window" } }))
        .child(svg("mods/workspace-chrome/git-branch.svg").size(12))
        .child(div().child(`${s.count} worktree${s.count === 1 ? "" : "s"} · ${size(s.kb)}`))
        .when(s.cleanable > 0, (e) => e.child(div().text_color(t.working).child(`${s.cleanable} cleanable`))));
  }
}

// ---------- the window ----------
export class ResourcesWindow {
  constructor(p, cx) {
    this.overlay = p.overlay; this.picked = new Set(); this.auto = new Set(); this.busy = false;
    this.refresh(cx);
  }
  refresh(cx) {
    if (this.scanning) return;
    this.scanning = true;
    cx.spawn(async (cx) => { try { await scan(() => cx.notify()); } finally { this.scanning = false; cx.notify(); } });
  }
  async clean(cx) {
    this.busy = true; cx.notify();
    const st = shared(CACHE), done = [], kept = [];
    for (const r of st?.repos ?? []) for (const w of r.worktrees.filter((w) => this.picked.has(w.path))) {
      try {
        if (w.prunable || !w.info?.exists) { await prune(r.root, null); done.push(w.branch); continue; }
        const sp = spaceAt(w.path); if (sp) run("space.close", { id: sp.id, confirmed: true });
        const res = await remove(r.root, w.path, w.branch, { force: false, deleteBranch: true }, null);
        done.push(w.branch); if (res.branchKept) kept.push(`${w.branch} (branch kept)`);
      } catch (e) { kept.push(`${w.branch}: ${String(e.message ?? e).slice(0, 80)}`); }
    }
    for (const o of (st?.orphans ?? []).filter((o) => this.picked.has(o.path))) {
      // Only folders inside ~/.herdr/worktrees, and only ones git doesn't list (checked by scan).
      if (!o.path.startsWith(`${home()}/.herdr/worktrees/`) || o.path.split("/").includes("..")) continue;
      const r = await exec("rm", ["-rf", "--", o.path], { timeout: 60000 }).catch(() => null);
      (r?.code === 0 ? done : kept).push(o.branch);
    }
    this.picked.clear(); this.auto.clear(); this.busy = false;
    notify({ title: `Cleaned ${done.length}`, body: kept.length ? `Kept / failed: ${kept.join("; ")}` : "Done", level: kept.length ? "warning" : "success" });
    this.refresh(cx);
  }
  row(t, w, k) {
    const v = verdict(w), on = this.picked.has(w.path);
    if (v.ok && w.info && !this.auto.has(w.path)) { this.auto.add(w.path); this.picked.add(w.path); }
    const color = { stale: t.dim, clean: t.done, keep: t.blocked, busy: t.working, orphan: t.working, pending: t.dim }[v.cls];
    const pickable = v.ok || v.opt;
    const sp = !w.orphan && spaceAt(w.path);
    return h_flex().id(`res-${k}`).h(30).px(10).gap(8).items_center().rounded(6).text_size(11.5).hover((s) => s.bg(t.hover))
      .when(pickable, (e) => e.cursor_pointer().on_click((_e, cx) => { on ? this.picked.delete(w.path) : this.picked.add(w.path); cx.notify(); }))
      .child(div().size(13).flex_none().rounded(3).border_1().border_color(on ? t.accent : t.input).when(on, (e) => e.bg(t.accent)).when(!pickable, (e) => e.opacity(0.25)))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(w.branch ?? w.path.split("/").pop()))
      .child(div().flex_none().max_w(220).truncate().text_color(color).child(v.text))
      .child(div().w(40).flex_none().text_right().text_color(t.dim).child(ago(w.info?.last)))
      .child(div().w(64).flex_none().text_right().text_color(t.dim).child(size(w.info?.kb)))
      .child(div().w(46).flex_none().flex().justify_end().when(!w.orphan && w.info?.exists !== false, (e) => e.child(
        div().id(`res-open-${k}`).px(6).rounded(4).text_size(10.5).text_color(t.muted).border_1().border_color(t.border).cursor_pointer()
          .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { cx.stop_propagation(); sp ? run("space.select", { id: sp.id }) : run("space.new", { name: w.branch ?? "worktree", folder: w.path }); })
          .child("Open"))));
  }
  render(t) {
    const st = shared(CACHE), s = totals(st);
    const head = (text, sub) => h_flex().px(10).pt(10).pb(4).gap(6).items_center().text_size(10.5).font_semibold().text_color(t.dim)
      .child(div().child(text.toUpperCase())).when(Boolean(sub), (e) => e.child(div().font_normal().child(sub)));
    const body = [];
    let k = 0;
    for (const r of st?.repos ?? []) {
      body.push(head(r.name, r.root.replace(home(), "~")));
      for (const w of r.worktrees) body.push(this.row(t, w, k++));
    }
    if (st?.orphans?.length) {
      body.push(head("Leftover folders", "~/.herdr/worktrees, not known to git — check before deleting"));
      for (const o of st.orphans) body.push(this.row(t, o, k++));
    }
    if (!st) body.push(div().p(14).text_size(12).text_color(t.dim).child("Scanning your repos…"));
    else if (!body.length) body.push(div().p(14).text_size(12).text_color(t.dim).child("No linked worktrees."));
    return v_flex().size_full().bg(t.popover ?? t.surface).text_color(t.foreground)
      .child(h_flex().h(40).px(14).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(13).font_semibold().child("Worktrees"))
        .child(div().text_size(11).text_color(t.dim).child(`${s.count} · ${size(s.kb)} · ${s.cleanable} cleanable`))
        .child(div().flex_1())
        .child(div().id("res-refresh").px(6).rounded(5).cursor_pointer().text_color(t.dim).hover((x) => x.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.refresh(cx)).child(this.scanning ? "…" : "↻"))
        .child(div().id("res-close").px(6).rounded(5).cursor_pointer().text_color(t.dim).hover((x) => x.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => run("overlay.close", { id: this.overlay })).child("×")))
      .child(v_flex().id("res-list").flex_1().min_h(0).overflow_y_scrollbar().pb(8).children(body))
      .child(h_flex().h(48).px(14).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().text_size(10.5).text_color(t.dim).child("Pre-selected: stale, or merged with nothing uncommitted / unpushed and no agent working. Deleting removes the folder and the branch (kept if unmerged)."))
        .child(div().id("res-clean").h(30).px(12).flex().items_center().rounded(7).text_size(12)
          .bg(this.picked.size && !this.busy ? t.blocked : t.raised).text_color(this.picked.size && !this.busy ? (t.solid_foreground ?? "#fff") : t.dim)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .when(this.picked.size > 0 && !this.busy, (e) => e.cursor_pointer().on_click((_e, cx) => cx.spawn(async (cx) => this.clean(cx))))
          .child(this.busy ? "Deleting…" : `Delete ${this.picked.size} selected`)));
  }
}
