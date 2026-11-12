// Modified from Herdr's built-in `files` mod (Apache-2.0; see /NOTICE). Changes by herdr-ranch: flat panel look, header actions, search by file name or contents.
// Files panel (Herdr's own files mod, cloned): a lazy file browser for the focused pane's folder with read-only
// previews, restyled Orca-style and with search: by file name ("Names") or inside files ("Contents", ripgrep).
// Header: the folder's name, then collapse all / refresh / show in Finder. Clicking a result previews the file.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window } from "herdr";
import { TS, C, icon, field } from "./ui.js";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.mode = localStorage.getItem("mode") === "contents" ? "contents" : "names"; // what the search box searches
    this.results = null; // null: no search · [] : nothing found · [{ path, line?, text? }]
    this.seq = 0;
    this.query = InputState.new({ placeholder: "Find files" });
    this.query.on("change", (_e, cx) => this.later(cx));
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  // ---------- search ----------
  later(cx) {
    const seq = ++this.seq;
    if (!this.query.value().trim()) { this.results = null; this.searching = false; cx.notify(); return; }
    cx.timer.after(220, (cx) => { if (seq === this.seq) this.search(seq, cx); });
  }

  // File paths containing `word`, filtered where the files are listed (a big folder never has to come back whole).
  // ripgrep's list honours .gitignore; without rg, git's own list (tracked + untracked).
  async namesWith(word, context) {
    const { cwd, on } = context;
    // Outside a git repository (a home folder, say) the tree can be enormous: look 4 levels deep only.
    const script = 'if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then D=""; else D="--max-depth 4"; fi; (rg --files --hidden --glob "!.git" $D 2>/dev/null || git ls-files --cached --others --exclude-standard 2>/dev/null) | grep -i -F -- "$1" | head -600';
    const r = await exec("sh", ["-c", script, "names", word], { cwd, on, timeout: 15000 }).catch(() => null);
    return r?.stdout ? r.stdout.split("\n").filter(Boolean) : [];
  }

  search(seq, cx) {
    const q = this.query.value().trim(), context = this.context;
    if (!q || !context?.cwd) return;
    this.searching = true; cx.notify();
    cx.spawn(async (cx) => {
      let out = [];
      try {
        if (this.mode === "names") {
          const words = q.toLowerCase().split(/\s+/);
          const hits = [];
          // Folders already loaded in the tree match too (ripgrep lists files only).
          for (const [prefix, list] of this.entries) for (const e of list) {
            if (e.dir && words.every((w) => e.name.toLowerCase().includes(w))) hits.push({ path: prefix ? `${prefix}/${e.name}` : e.name, dir: true, score: -1 });
          }
          for (const path of await this.namesWith(words.reduce((a, b) => (b.length > a.length ? b : a)), context)) {
            const low = path.toLowerCase();
            if (!words.every((w) => low.includes(w))) continue;
            const base = low.slice(low.lastIndexOf("/") + 1);
            hits.push({ path, score: (base.startsWith(words[0]) ? 0 : base.includes(words[0]) ? 1 : 2) * 1000 + path.length });
            if (hits.length > 4000) break;
          }
          out = hits.sort((a, b) => a.score - b.score).slice(0, 120);
        } else if (q.length >= 2) {
          const repo = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: context.cwd, on: context.on }).catch(() => null);
          const r = await exec("rg", ["-n", "--no-heading", "--color", "never", "-S", "-F", "--max-count", "3", "--max-columns", "220", "--hidden", "--glob", "!.git",
            ...(repo?.code === 0 ? [] : ["--max-depth", "4"]), "-e", q], { cwd: context.cwd, on: context.on, timeout: 12000 }).catch(() => null);
          for (const line of (r?.stdout ?? "").split("\n").slice(0, 200)) {
            const m = /^(.+?):(\d+):(.*)$/.exec(line);
            if (m) out.push({ path: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 200) });
          }
        }
      } catch {}
      if (seq === this.seq && this.current(context)) { this.results = out; this.searching = false; cx.notify(); }
    });
  }

  setMode(mode, cx) {
    this.mode = mode; localStorage.setItem("mode", mode);
    this.results = this.query.value().trim() ? [] : null;
    if (this.query.value().trim()) this.search(++this.seq, cx);
    cx.notify();
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.results = null; this.seq++;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(26).flex_none().pl(6 + depth * 16).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .child(entry.dir ? icon(open ? "chevron-down" : "chevron-right", 12, t.dim) : div().w(12).flex_none())
        .child(icon(entry.dir ? (open ? "folder-open" : "folder") : "file", 14, t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? C(t).diff.add : mark === "D" || mark === "U" ? C(t).diff.del : C(t).diff.mod).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  resultRows(t) {
    const st = C(t);
    return (this.results ?? []).map((r, i) => {
      const cut = r.path.lastIndexOf("/"), base = r.path.slice(cut + 1), dir = cut > 0 ? r.path.slice(0, cut) : "";
      const mark = this.marks[`${this.root}/${r.path}`];
      const row = v_flex().id(`hit-${i}`).flex_none().px(8).py(r.text != null ? 4 : 0).gap(1).rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (!r.dir) return this.show(r.path, cx);
          // A folder: back to the tree, opened down to it.
          this.query.set_value(""); this.results = null; this.seq++;
          const parts = r.path.split("/");
          for (let n = 1; n <= parts.length; n++) { const sub = parts.slice(0, n).join("/"); if (!this.folders.has(sub)) this.toggle(sub, cx); }
          cx.notify();
        })
        .child(h_flex().h(r.text != null ? 18 : 28).gap(7).items_center()
          .child(icon(r.dir ? "folder" : "file", 14, t.muted))
          .child(div().flex_none().max_w(220).truncate().child(base))
          .when(r.line != null, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`:${r.line}`)))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir))
          .when(Boolean(mark), el => el.child(div().flex_none().text_size(11).text_color(mark === "A" ? st.diff.add : mark === "D" || mark === "U" ? st.diff.del : st.diff.mod).child(mark))));
      return r.text != null ? row.child(div().pl(21).truncate().text_size(TS.body).text_color(t.muted).font_family(settings().font_family ?? "monospace").child(r.text)) : row;
    });
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    const btn = (id, ic, tip, act) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(act).child(icon(ic, 14));
    const seg = (id, label) => div().id(`fm-${id}`).flex_1().h_full().flex().items_center().justify_center().rounded(5).text_size(TS.body).cursor_pointer()
      .text_color(this.mode === id ? t.foreground : t.muted).when(this.mode === id, el => el.bg(t.selected).font_medium()).when(this.mode !== id, el => el.hover(s => s.text_color(t.foreground)))
      .on_click((_e, cx) => this.setMode(id, cx)).child(label);
    const rootName = this.root?.split(/[\\/]/).filter(Boolean).pop() ?? "Files";
    const searching = this.results !== null;
    return v_flex().id("files").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      // Header: where you are, then this view's own actions.
      .child(h_flex().h(36).flex_none().pl(12).pr(6).gap(2).items_center()
        .when(Boolean(this.file), el => el.child(btn("files-back", "chevron-left", "Back to the list", (_e, cx) => { this.show(null); cx.notify(); })))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(this.file ? this.file.split("/").pop() : rootName))
        .when(!this.file, el => el
          .child(btn("files-collapse", "chevrons-down-up", "Collapse all folders", (_e, cx) => { this.folders = new Set(); this.entries = new Map([["", this.entries.get("") ?? []]]); cx.notify(); }))
          .child(btn("files-refresh", "refresh-cw", "Refresh", (_e, cx) => { this.refresh(cx); if (searching) this.search(++this.seq, cx); }))
          .child(btn("files-reveal", "folder-open", "Show this folder in Finder", () => { if (this.root && !this.on) exec("open", [this.root]).catch(() => null); })))
        .when(Boolean(this.file), el => el.child(btn("files-open", "external-link", "Open in your text editor", () => { // open -t: the text editor, never the file's own handler (.command, .app)
           if (!this.on) exec("open", ["-t", `${this.root}/${this.file}`]).catch(() => null); }))))
      .when(Boolean(this.file), el => el.child(div().px(12).pb(6).truncate().text_size(11).text_color(t.dim).child(this.file)))
      // Search: by name or inside files.
      .when(!this.file, el => el.child(v_flex().flex_none().px(10).pb(8).gap(6)
        .child(field(t, this.query, { size: "panel", icon: "ranch/icons/search.svg" }))
        .child(h_flex().h(28).p(2).gap(2).rounded(7).bg(t.background).border_1().border_color(t.border).child(seg("names", "Names")).child(seg("contents", "Contents")))))
      .when(!this.file && searching, el => el.child(v_flex().id("files-hits").flex_1().min_h(0).overflow_y_scrollbar().px(6).pb(6).gap(1)
        .children(this.resultRows(t))
        .when(!this.results.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.searching ? "Searching…" : this.mode === "contents" && this.query.value().trim().length < 2 ? "Type at least 2 characters." : "Nothing found.")))
        .when(this.results.length >= (this.mode === "names" ? 120 : 200), el => el.child(div().p(8).text_size(11).text_color(t.dim).child("More matches exist: type more to narrow it down.")))))
      .when(!this.file && !searching, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().px(6).pb(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
