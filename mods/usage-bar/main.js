// Orca-style account usage line: "Used  [Claude] ▓▓░ 1% 6d 9h · 0% Fable   [Codex] ...".
// Numbers come from ./usage.py (Claude: usage API, cached 5 min; Codex: local rollout files).
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, appHome, theme } from "herdr";
import { TS, C, icon } from "./ui.js";

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
    const w = 44;
    return div().w(w).h(5).rounded(3).bg(t.border).flex_none()
      .child(div().h(5).rounded(3).bg(color).w(Math.max(1, Math.round((w * Math.min(pct, 100)) / 100))));
  }

  color(t, pct) {
    return pct >= 90 ? C(t).status.blocked : pct >= 70 ? C(t).status.working : t.accent;
  }

  // One provider: icon, bar, percent. Everything else (each window, when it resets, why it's stale) is in the tooltip.
  provider(t, id, ic, tint, info, now, staleHint, name) {
    const ws = info?.windows ?? [];
    const dim = !ws.length || info.stale;
    const head = h_flex().id(id).gap(6).items_center().flex_none().when(dim, (e) => e.opacity(0.55))
      .child(tint ? svg(ic).size(13).text_color(tint) : image(ic).size(13));
    if (!ws.length) return head.child(div().text_color(t.dim).child("–")).tooltip(`${name}: no usage numbers (${staleHint}).`);
    const main = ws[0];
    const c = info.stale ? t.dim : this.color(t, main.percent);
    const lines = ws.map((w) => `${w.name}: ${Math.round(w.percent)}% used${w.resets_at ? `, resets in ${left(w.resets_at, now)}` : ""}`);
    const tip = [name, ...lines, info.stale ? `Old numbers: ${staleHint}.` : null, info.error ? `Last refresh failed (${info.error}); showing the last good numbers.` : null].filter(Boolean).join("\n");
    return head
      .child(this.bar(t, main.percent, c))
      .child(div().w(28).text_right().text_color(info.stale ? t.dim : t.foreground).child(`${Math.round(main.percent)}%`))
      .when(Boolean(info.error), (e) => e.child(icon("triangle-alert", 12, C(t).status.blocked)))
      .tooltip(tip);
  }

  render() {
    const t = theme();
    const now = this.data?.now ?? Date.now() / 1000;
    return h_flex().id("usage-bar").size_full().px(10).gap(16).items_center().justify_end()
      .text_size(TS.meta).bg(t.chrome).text_color(t.muted)
      .child(this.provider(t, "u-claude", "icons/claude.svg", null, this.data?.claude, now, "unavailable", "Claude"))
      .child(this.provider(t, "u-codex", "icons/codex.svg", null, this.data?.codex, now, "run Codex to refresh", "Codex"))
      .child(this.provider(t, "u-grok", "icons/grok.svg", t.foreground, this.data?.grok, now, "run Grok to refresh", "Grok"))
      .child(this.provider(t, "u-cursor", "icons/cursor.svg", t.foreground, this.data?.cursor, now, "unavailable", "Cursor"))
      .child(div().id("u-refresh").px(4).py(2).flex().items_center().rounded(4).cursor_pointer().text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Refresh now")
        .on_click((_e, cx) => this.load(cx, true))
        .child(this.busy ? "…" : icon("refresh-cw", 12)));
  }
}
