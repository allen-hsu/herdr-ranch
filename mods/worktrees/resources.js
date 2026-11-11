// The worktree scan, the status-bar pill and the Resource Manager window (Orca-like). Views (props.view):
//   "pill"   a status-bar button: worktree count, disk used, how many can be cleaned; click opens the window
//   "window" every repo's worktrees (repos = the main checkouts behind this computer's spaces) with state,
//            agent activity, last commit, size; cleanable ones pre-selected; plus folders under
//            ~/.herdr/worktrees that git no longer knows (never pre-selected).
// Cleanable: stale (folder gone), or merged + clean + pushed + no agent working there.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, spaces, panes, agents, run, openOverlay, notify, home, shared, setShared } from "herdr";
import { mainRoot, list, inspect, remove, prune, repoName } from "./wt.js";
import { TS, SPACE } from "./ui.js";

const CACHE = "worktrees.scan"; // shared: { at, repos: [...], orphans: [...] } so pill and window agree
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
    return h_flex().id("wt-pill").size_full().px(8).gap(6).items_center().justify_end().text_size(TS.meta).text_color(t.dim)
      .child(h_flex().id("wt-pill-btn").h(20).px(7).gap(6).items_center().rounded(5).cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground))
        .tooltip("Worktrees across your repos: state, size, what can be cleaned")
        .on_click(() => openOverlay({ mod: "worktrees", kind: "window", key: "worktree-resources", width: 560, height: 680, props: { view: "window" } }))
        .child(svg("mods/workspace-chrome/git-branch.svg").size(12))
        .child(div().child(`${s.count} worktree${s.count === 1 ? "" : "s"} · ${size(s.kb)}`))
        .when(s.cleanable > 0, (e) => e.child(div().text_color(t.working).child(`${s.cleanable} cleanable`))));
  }
}

// ---------- process sampling (only while the window is open) ----------
// Each terminal's whole process subtree (shell, agent, its children): CPU % and resident memory.
class Sampler {
  constructor() { this.pids = new Map(); this.history = new Map(); this.last = null; }
  async pidOf(addr) {
    const k = this.pids.get(addr);
    if (k && Date.now() - k.at < 60000) return k.pid;
    const r = await exec("hc", ["get", addr, "--json"], { timeout: 5000 }).catch(() => null);
    let pid = null;
    try { pid = JSON.parse(r?.stdout ?? "{}").pid ?? null; } catch {}
    this.pids.set(addr, { pid, at: Date.now() });
    return pid;
  }
  async sample(addrs) {
    const roots = new Map();
    for (const a of addrs) { const pid = await this.pidOf(a); if (pid) roots.set(a, pid); }
    const r = await exec("ps", ["-axo", "pid=,ppid=,pcpu=,rss="], { timeout: 8000 }).catch(() => null);
    if (r?.code !== 0) return null;
    const kids = new Map(), stat = new Map();
    for (const line of r.stdout.split("\n")) {
      const [pid, ppid, cpu, rss] = line.trim().split(/\s+/).map(Number);
      if (!pid) continue;
      stat.set(pid, { cpu: cpu || 0, rss: rss || 0 });
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(pid);
    }
    const per = new Map();
    for (const [addr, root] of roots) {
      let cpu = 0, rss = 0; const stack = [root], seen = new Set();
      while (stack.length) { const p = stack.pop(); if (seen.has(p)) continue; seen.add(p); const st = stat.get(p); if (st) { cpu += st.cpu; rss += st.rss; } stack.push(...(kids.get(p) ?? [])); }
      per.set(addr, { cpu, rss });
    }
    this.last = { at: Date.now(), per };
    return per;
  }
  push(key, v) { const h = this.history.get(key) ?? []; h.push(v); if (h.length > 36) h.shift(); this.history.set(key, h); }
}

// ---------- the window ----------
export class ResourcesWindow {
  constructor(p, cx) {
    this.overlay = p.overlay; this.view = "overview";
    this.picked = new Set(); this.auto = new Set(); this.busy = false; this.folded = new Set();
    this.sampler = new Sampler();
    this.refresh(cx);
    this.tick(cx);
    cx.timer.every(5000, (cx) => this.tick(cx));
  }
  refresh(cx) {
    if (this.scanning) return;
    this.scanning = true;
    cx.spawn(async (cx) => { try { await scan(() => cx.notify()); } finally { this.scanning = false; this.scannedAt = Date.now(); cx.notify(); } });
  }
  tick(cx) {
    if (this.sampling) return;
    this.sampling = true;
    cx.spawn(async (cx) => {
      try {
        const addrs = panes().map((p) => p.terminal).filter((a) => a && !a.includes("/"));
        await this.sampler.sample([...new Set(addrs)]);
        const tree = this.tree();
        for (const r of tree) for (const w of r.worktrees) this.sampler.push(`${r.name}/${w.label}`, w.cpu);
      } finally { this.sampling = false; cx.notify(); }
    });
  }

  // repo -> worktree (or checkout) -> terminals, from the open spaces, with sampled CPU / memory.
  tree() {
    const st = shared(CACHE), per = this.sampler.last?.per ?? new Map();
    const repos = new Map(), ps = panes();
    const placeOf = (s) => s.folder || ps.find((p) => s.tabs?.some((tb) => tb.id === p.tab) && p.cwd)?.cwd || "";
    for (const s of spaces().filter((s) => !s.machine)) {
      const path = placeOf(s);
      let repo = null, label = s.name;
      for (const r of st?.repos ?? []) {
        const wt = r.worktrees.find((w) => path === w.path || path.startsWith(w.path + "/"));
        if (wt) { repo = r.name; label = wt.branch ?? s.name; break; }
        if (path === r.root || path.startsWith(r.root + "/")) { repo = r.name; label = s.branch || "main"; break; }
      }
      repo ??= s.name === "~" ? "Home" : s.name;
      const terms = ps.filter((p) => p.terminal && s.tabs?.some((tb) => tb.id === p.tab)).map((p) => {
        const v = per.get(p.terminal) ?? { cpu: 0, rss: 0 };
        const name = p.program?.agent ? (p.title && p.title !== p.program?.name ? p.title : p.program.name) : (p.title || p.program?.name || "Terminal");
        return { addr: p.terminal, name, cpu: v.cpu, rss: v.rss, live: Boolean(per.get(p.terminal)) };
      });
      if (!repos.has(repo)) repos.set(repo, { name: repo, worktrees: [] });
      const r = repos.get(repo);
      let w = r.worktrees.find((x) => x.label === label);
      if (!w) { w = { label, space: s.id, terms: [] }; r.worktrees.push(w); }
      w.terms.push(...terms);
    }
    const out = [...repos.values()];
    for (const r of out) {
      for (const w of r.worktrees) { w.cpu = w.terms.reduce((n, x) => n + x.cpu, 0); w.rss = w.terms.reduce((n, x) => n + x.rss, 0); }
      r.cpu = r.worktrees.reduce((n, w) => n + w.cpu, 0); r.rss = r.worktrees.reduce((n, w) => n + w.rss, 0);
    }
    return out.sort((a, b) => b.rss - a.rss);
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
      // Only folders inside ~/.herdr/worktrees, and only ones git doesn't recognise (checked by scan).
      if (!o.path.startsWith(`${home()}/.herdr/worktrees/`) || o.path.split("/").includes("..")) continue;
      const r = await exec("rm", ["-rf", "--", o.path], { timeout: 60000 }).catch(() => null);
      (r?.code === 0 ? done : kept).push(o.branch);
    }
    this.picked.clear(); this.auto.clear(); this.busy = false;
    notify({ title: `Cleaned ${done.length}`, body: kept.length ? `Kept / failed: ${kept.join("; ")}` : "Done", level: kept.length ? "warning" : "success" });
    this.refresh(cx);
  }

  allCleanable() {
    const st = shared(CACHE);
    return [...(st?.repos ?? []).flatMap((r) => r.worktrees), ...(st?.orphans ?? [])].filter((w) => verdict(w).ok);
  }

  // ---------- pieces ----------
  iconBtn(t, id, glyph, tip, action) {
    return div().id(id).size(26).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim).tooltip(tip)
      .hover((x) => x.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(glyph);
  }
  spark(t, key) {
    const h = this.sampler.history.get(key) ?? [];
    const max = Math.max(5, ...h);
    return h_flex().w(80).h(16).gap(1).items_end().flex_none()
      .children(h.map((v, i) => div().w(1.5).h(Math.max(1, Math.round((v / max) * 16))).bg(t.dim).rounded(1)));
  }
  pctMem(t, cpu, rss, strong) {
    return [div().w(60).flex_none().text_right().text_color(strong ? t.foreground : t.muted).child(`${cpu.toFixed(1)}%`),
      div().w(76).flex_none().text_right().text_color(strong ? t.foreground : t.muted).child(size(Math.round(rss)))];
  }
  check(t, on, pickable) {
    return div().size(14).flex_none().rounded(3).border_1().border_color(on ? t.accent : t.input).flex().items_center().justify_center()
      .when(on, (e) => e.bg(t.accent).child(div().text_size(TS.tiny).text_color(t.accent_foreground ?? "#fff").child("✓"))).when(!pickable, (e) => e.opacity(0.25));
  }

  overviewView(t) {
    const tree = this.tree(), tot = tree.reduce((a, r) => ({ cpu: a.cpu + r.cpu, rss: a.rss + r.rss }), { cpu: 0, rss: 0 });
    const st = shared(CACHE), s = totals(st), cleanable = this.allCleanable().length;
    const rows = [];
    tree.forEach((r, i) => {
      const fr = this.folded.has(r.name);
      rows.push(h_flex().id(`rm-r-${i}`).h(30).px(10).gap(6).items_center().cursor_pointer().hover((x) => x.bg(t.hover)).text_size(TS.body).font_semibold()
        .on_click((_e, cx) => { fr ? this.folded.delete(r.name) : this.folded.add(r.name); cx.notify(); })
        .child(div().w(12).text_color(t.dim).child(fr ? "▸" : "▾")).child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(r.name.toUpperCase()))
        .children(this.pctMem(t, r.cpu, r.rss, false)));
      if (fr) return;
      r.worktrees.forEach((w, j) => {
        const key = `${r.name}/${w.label}`, fw = this.folded.has(key);
        rows.push(h_flex().id(`rm-w-${i}-${j}`).h(28).pl(26).pr(10).gap(6).items_center().cursor_pointer().hover((x) => x.bg(t.hover)).text_size(TS.body)
          .on_click((_e, cx) => { fw ? this.folded.delete(key) : this.folded.add(key); cx.notify(); })
          .child(div().w(12).text_color(t.dim).child(fw ? "▸" : "▾")).child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(w.label))
          .child(this.spark(t, key)).children(this.pctMem(t, w.cpu, w.rss, true)));
        if (fw) return;
        w.terms.forEach((x, k) => rows.push(h_flex().id(`rm-t-${i}-${j}-${k}`).h(24).pl(44).pr(10).gap(8).items_center().text_size(TS.body).hover((y) => y.bg(t.hover))
          .child(div().size(6).rounded(3).bg(x.live ? t.done : t.dim)).child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(x.name))
          .children(this.pctMem(t, x.cpu, x.rss, false))));
      });
    });
    if (!rows.length) rows.push(div().p(14).text_size(TS.body).text_color(t.dim).child("No terminals open."));
    return v_flex().size_full()
      .child(h_flex().px(SPACE.dialog).py(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(TS.title).font_semibold().text_color(t.foreground).child(`${tot.cpu.toFixed(1)}%`))
        .child(div().text_size(TS.meta).text_color(t.dim).child("CPU"))
        .child(div().text_color(t.dim).child("·"))
        .child(div().text_size(TS.title).font_semibold().text_color(t.foreground).child(size(Math.round(tot.rss))))
        .child(div().text_size(TS.meta).text_color(t.dim).child("memory, all terminals")))
      .child(h_flex().h(26).px(10).gap(6).items_center().text_size(TS.small).text_color(t.dim).border_b(1).border_color(t.border)
        .child(div().flex_1().pl(18).child("Name")).child(div().w(80)).child(div().w(60).text_right().child("CPU")).child(div().w(76).text_right().child("Memory")))
      .child(v_flex().id("rm-tree").flex_1().min_h(0).overflow_y_scrollbar().children(rows))
      .child(div().px(10).pt(8).child(h_flex().id("rm-clean").h(36).px(SPACE.dialog).items_center().rounded(8).border_1().border_color(t.border).cursor_pointer()
        .hover((x) => x.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { this.view = "cleanup"; cx.notify(); })
        .child(div().flex_1().text_size(TS.item).text_color(t.foreground).child("Clean up worktrees"))
        .when(cleanable > 0, (e) => e.child(div().mr(8).text_size(TS.meta).text_color(t.working).child(`${cleanable} cleanable`)))
        .child(div().text_color(t.dim).child("›"))))
      .child(h_flex().px(SPACE.dialog).py(10).gap(10).items_center().text_size(TS.body)
        .child(div().text_color(t.foreground).font_medium().child("Disk"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`${size(s.kb)} in ${s.count} linked worktree${s.count === 1 ? "" : "s"} · updated ${this.scannedAt ? ago(this.scannedAt / 1000) + " ago" : "now"}`))
        .child(this.iconBtn(t, "rm-disk-refresh", this.scanning ? "…" : "↻", "Rescan worktrees and sizes", (_e, cx) => this.refresh(cx)))
        .child(div().id("rm-review").px(8).py(2).rounded(6).cursor_pointer().text_color(t.foreground).hover((x) => x.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { this.view = "cleanup"; cx.notify(); }).child("Review")));
  }

  cleanupRow(t, w, k) {
    const v = verdict(w), on = this.picked.has(w.path);
    if (v.ok && w.info && !this.auto.has(w.path)) { this.auto.add(w.path); this.picked.add(w.path); }
    const color = { stale: t.dim, clean: t.done, keep: t.blocked, busy: t.working, orphan: t.working, pending: t.dim }[v.cls];
    const pickable = v.ok || v.opt;
    const sp = !w.orphan && spaceAt(w.path);
    return h_flex().id(`res-${k}`).h(30).px(10).gap(8).items_center().rounded(6).text_size(TS.body).hover((s) => s.bg(t.hover))
      .when(pickable, (e) => e.cursor_pointer().on_click((_e, cx) => { on ? this.picked.delete(w.path) : this.picked.add(w.path); cx.notify(); }))
      .child(this.check(t, on, pickable))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(w.branch ?? w.path.split("/").pop()))
      .child(div().flex_none().max_w(220).truncate().text_color(color).child(v.text))
      .child(div().w(40).flex_none().text_right().text_color(t.dim).child(ago(w.info?.last)))
      .child(div().w(64).flex_none().text_right().text_color(t.dim).child(size(w.info?.kb)))
      .child(div().w(46).flex_none().flex().justify_end().when(!w.orphan && w.info?.exists !== false, (e) => e.child(
        div().id(`res-open-${k}`).px(6).rounded(4).text_size(TS.small).text_color(t.muted).border_1().border_color(t.border).cursor_pointer()
          .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { cx.stop_propagation(); sp ? run("space.select", { id: sp.id }) : run("space.new", { name: w.branch ?? "worktree", folder: w.path }); })
          .child("Open"))));
  }

  cleanupView(t) {
    const st = shared(CACHE);
    const head = (text, sub) => h_flex().px(10).pt(10).pb(4).gap(6).items_center().text_size(TS.small).font_semibold().text_color(t.dim)
      .child(div().child(text)).when(Boolean(sub), (e) => e.child(div().font_normal().child(sub)));
    const body = [];
    let k = 0;
    for (const r of st?.repos ?? []) { body.push(head(r.name, r.root.replace(home(), "~"))); for (const w of r.worktrees) body.push(this.cleanupRow(t, w, k++)); }
    if (st?.orphans?.length) { body.push(head("Leftover folders", "~/.herdr/worktrees, not known to git — check before deleting")); for (const o of st.orphans) body.push(this.cleanupRow(t, o, k++)); }
    if (!st) body.push(div().p(14).text_size(TS.body).text_color(t.dim).child("Scanning your repos…"));
    else if (!body.length) body.push(div().p(14).text_size(TS.body).text_color(t.dim).child("No linked worktrees."));
    const n = this.picked.size, cleanable = this.allCleanable();
    const small = (id, label, action) => div().id(id).h(28).px(10).flex().items_center().rounded(7).text_size(TS.body).cursor_pointer().text_color(t.foreground)
      .border_1().border_color(t.border).hover((x) => x.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
    return v_flex().size_full()
      .child(v_flex().id("res-list").flex_1().min_h(0).overflow_y_scrollbar().pb(8).children(body))
      .child(div().px(SPACE.dialog).pt(6).text_size(TS.small).text_color(t.dim).child("Can be selected: stale, or merged with nothing uncommitted / unpushed and no agent working. Deleting removes the folder and the branch (kept if unmerged)."))
      .child(h_flex().h(50).px(SPACE.dialog).gap(8).items_center().flex_none()
        .child(small("res-all", `Select all cleanable (${cleanable.length})`, (_e, cx) => { for (const w of cleanable) this.picked.add(w.path); cx.notify(); }))
        .child(small("res-none", "Clear", (_e, cx) => { this.picked.clear(); cx.notify(); }))
        .child(div().flex_1())
        .child(div().id("res-clean").flex_none().h(30).px(SPACE.dialog).flex().items_center().rounded(7).text_size(TS.body)
          .bg(n && !this.busy ? t.blocked : t.raised).text_color(n && !this.busy ? (t.solid_foreground ?? "#fff") : t.dim)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .when(n > 0 && !this.busy, (e) => e.cursor_pointer().on_click((_e, cx) => cx.spawn(async (cx) => this.clean(cx))))
          .child(this.busy ? "Deleting…" : `Delete ${n} selected`)));
  }

  render(t) {
    const cleanup = this.view === "cleanup";
    return v_flex().size_full().bg(t.popover ?? t.surface).text_color(t.foreground)
      .child(h_flex().h(42).px(12).gap(6).items_center().border_b(1).border_color(t.border).flex_none()
        .when(cleanup, (e) => e.child(this.iconBtn(t, "rm-back", "‹", "Back to resources", (_e, cx) => { this.view = "overview"; cx.notify(); })))
        .child(div().text_size(TS.title).font_semibold().child(cleanup ? "Clean up worktrees" : "Resource Manager"))
        .child(div().flex_1())
        .child(this.iconBtn(t, "rm-refresh", this.scanning || this.sampling ? "…" : "↻", "Refresh", (_e, cx) => { this.refresh(cx); this.tick(cx); }))
        .when(!cleanup, (e) => e.child(this.iconBtn(t, "rm-trash", "🗑", "Clean up everything that's safe to remove…", (_e, cx) => {
          for (const w of this.allCleanable()) this.picked.add(w.path);
          this.view = "cleanup"; cx.notify();
        })))
        .child(this.iconBtn(t, "rm-close", "×", "Close", () => run("overlay.close", { id: this.overlay }))))
      .child(div().flex_1().min_h(0).child(cleanup ? this.cleanupView(t) : this.overviewView(t)));
  }
}
