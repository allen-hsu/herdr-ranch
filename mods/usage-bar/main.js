// Orca-style account usage line: "Used  [Claude] ▓▓░ 1% 6d 9h · 0% Fable   [Codex] ...".
// Numbers come from ./usage.py (Claude: usage API, cached 5 min; Codex: local rollout files).
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, appHome, theme } from "herdr";
import { TS } from "./ui.js";

const left = (resetsAt, now) => {
  if (!resetsAt) return "";
  const s = Math.max(0, resetsAt - now);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

export default class UsageBar extends View {
  init(_props, cx) {
    this.data = null;
    this.load(cx, false);
    cx.timer.every(60000, (cx) => this.load(cx, false));
  }

  load(cx, force) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [appHome() + "/mods/usage-bar/usage.py", ...(force ? ["--force"] : [])], { timeout: 30000 });
        if (r.code === 0) this.data = JSON.parse(r.stdout);
      } catch {}
      this.busy = false;
      cx.notify();
    });
  }

  bar(t, pct, color) {
    const w = 64;
    return div().w(w).h(5).rounded(3).bg(t.border).flex_none()
      .child(div().h(5).rounded(3).bg(color).w(Math.max(1, Math.round((w * Math.min(pct, 100)) / 100))));
  }

  color(t, pct) {
    return pct >= 90 ? t.blocked : pct >= 70 ? t.working : t.accent;
  }

  provider(t, id, icon, tint, info, now, staleHint, named = false) {
    const ws = info?.windows ?? [];
    const head = h_flex().id(id).gap(6).items_center().flex_none().child(tint ? svg(icon).size(13).text_color(tint) : image(icon).size(13));
    if (!ws.length) return head.child(div().text_color(t.dim).child(staleHint));
    const [main, ...rest] = ws;
    const stale = info.stale;
    const c = stale ? t.dim : this.color(t, main.percent);
    let el = head
      .child(this.bar(t, main.percent, c))

      .child(div().text_color(stale ? t.dim : t.foreground).child(`${Math.round(main.percent)}%`))
      .when(!named || stale, (e) => e.child(div().text_color(t.dim).child(stale ? staleHint : left(main.resets_at, now))));
    if (!named) for (const w of rest) el = el.child(div().text_color(t.dim).child(`· ${Math.round(w.percent)}% ${w.name}`));
    if (info.error) el = el.child(div().text_color(t.blocked).child("!")).tooltip(`Last refresh failed (${info.error}); showing the last good numbers.`);
    else if (!stale) el = el.tooltip(ws.map((w) => `${w.name}: ${Math.round(w.percent)}% used${w.resets_at ? `, resets in ${left(w.resets_at, now)}` : ""}`).join("\n"));
    return el;
  }

  render() {
    const t = theme();
    const now = this.data?.now ?? Date.now() / 1000;
    return h_flex().id("usage-bar").size_full().px(12).gap(14).items_center().justify_end()
      .text_size(TS.meta).bg(t.chrome).text_color(t.muted)
      .child(div().text_color(t.dim).child("Used"))
      .child(this.provider(t, "u-claude", "icons/claude.svg", null, this.data?.claude, now, "unavailable"))
      .child(this.provider(t, "u-codex", "icons/codex.svg", null, this.data?.codex, now, "stale · run Codex to refresh"))
      .child(this.provider(t, "u-grok", "icons/grok.svg", t.foreground, this.data?.grok, now, "run Grok to refresh"))
      .child(this.provider(t, "u-cursor", "icons/cursor.svg", t.foreground, this.data?.cursor, now, "unavailable", true))
      .child(div().id("u-refresh").px(4).rounded(4).cursor_pointer().text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Refresh now")
        .on_click((_e, cx) => this.load(cx, true))
        .child(this.busy ? "…" : "↻"));
  }
}
