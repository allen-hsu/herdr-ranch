// Read-only PR diff viewer, opened as a pane by mods/pr-panel (props: { url, repo, number, title }).
// Text comes from `gh pr diff` and is only displayed, never executed or sent anywhere.
import { View, div, uniform_list } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, props, theme } from "herdr";

const MAX_LINES = 20000;

export default class PRDiff extends View {
  init(_props, cx) {
    this.p = props() ?? {};
    this.lines = null;
    this.error = null;
    this.files = [];
    this.load(cx);
  }

  load(cx) {
    const url = String(this.p.url ?? "");
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url)) { this.error = "Not a GitHub PR URL"; return; }
    cx.spawn(async (cx) => {
      const r = await exec("gh", ["pr", "diff", url, "--color", "never"], { timeout: 60000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) {
        this.error = (r.stderr || "gh pr diff failed").split("\n").filter((l) => l && !/GVM|FakeAssoc/.test(l)).join(" ").slice(0, 300);
      } else {
        let lines = r.stdout.split("\n");
        if (lines.length > MAX_LINES) { this.truncated = lines.length; lines = lines.slice(0, MAX_LINES); }
        this.lines = lines;
        this.add = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
        this.del = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
        this.files = lines.flatMap((l, i) => (l.startsWith("diff --git ") ? [{ i, name: l.replace(/^diff --git a\/(.*) b\/.*$/, "$1") }] : []));
      }
      cx.notify();
    });
  }

  row(t, i) {
    const l = this.lines[i] ?? "";
    let fg = t.foreground, bg = null, weight = false;
    if (l.startsWith("diff --git ")) { fg = t.foreground; bg = t.raised; weight = true; }
    else if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("index ") || l.startsWith("new file") || l.startsWith("deleted file")) fg = t.dim;
    else if (l.startsWith("@@")) fg = t.accent;
    else if (l.startsWith("+")) { fg = t.ansi2 ?? t.done; bg = `${(t.ansi2 ?? "#3fb950").slice(0, 7)}1f`; }
    else if (l.startsWith("-")) { fg = t.ansi1 ?? t.blocked; bg = `${(t.ansi1 ?? "#f85149").slice(0, 7)}1f`; }
    const text = l.startsWith("diff --git ") ? `▸ ${l.replace(/^diff --git a\/(.*) b\/.*$/, "$1")}` : l || " ";
    return div().id(`dl-${i}`).h(18).px(10).whitespace_nowrap().text_color(fg)
      .when(Boolean(bg), (el) => el.bg(bg)).when(weight, (el) => el.font_semibold())
      .child(text.replace(/\t/g, "    "));
  }

  render() {
    const t = theme();
    const head = h_flex().px(12).h(36).flex_none().gap(8).items_center().border_b(1).border_color(t.border).text_size(11.5)
      .child(div().flex_none().text_color(t.dim).child(`${String(this.p.repo ?? "").split("/")[1] ?? ""} #${this.p.number ?? ""}`))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(String(this.p.title ?? "")))
      .when(this.lines != null, (el) => el
        .child(div().flex_none().text_color(t.dim).child(`${this.files.length} files`))
        .child(div().flex_none().text_color(t.ansi2 ?? t.done).child(`+${this.add}`))
        .child(div().flex_none().text_color(t.ansi1 ?? t.blocked).child(`-${this.del}`)))
      .child(div().id("diff-open").flex_none().px(6).rounded(5).cursor_pointer().text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Open on GitHub")
        .on_click(() => exec("open", [String(this.p.url)]))
        .child("↗"));
    let body;
    if (this.error) body = div().p(14).text_size(12).text_color(t.blocked).child(`${this.error}`);
    else if (!this.lines) body = div().p(14).text_size(12).text_color(t.dim).child("Loading diff…");
    else body = uniform_list("diff-lines", this.lines.length, (i) => String(i), (range) => {
      const out = [];
      for (let i = range.start; i < range.end; i++) out.push(this.row(t, i));
      return out;
    }).flex_1().font_family("JetBrains Mono").text_size(12);
    return v_flex().id("pr-diff").size_full().bg(t.background)
      .child(head)
      .when(Boolean(this.truncated), (el) => el.child(div().px(12).py(4).text_size(11).text_color(t.working).child(`Showing the first ${MAX_LINES} of ${this.truncated} lines — open on GitHub for the rest.`)))
      .child(body);
  }
}
