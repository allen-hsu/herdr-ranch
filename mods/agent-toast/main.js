// Notifications that say which agent they are about. Chosen by a layout's root "toast": "agent-toast".
// Herdr's own agent toasts ("<program> finished", "... needs you") carry action agent.focus {terminal};
// for those it shows the agent's session name, space · branch · tab, and what you last asked it
// (./live.py, transcript tail). Every other notify() looks like Herdr's shipped toast. Click: go there.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme, agents, spaces, exec, appHome } from "herdr";

const DOT = { error: "blocked", warning: "working", success: "done", info: "accent" };

export default class AgentToast extends View {
  init(_props, cx) {
    const p = props() ?? {};
    const addr = p.action?.name === "agent.focus" ? p.action.args?.terminal : null;
    this.agent = addr ? agents().find((a) => a.address === addr) ?? null : null;
    if (this.agent && /^[A-Za-z0-9_-]+$/.test(addr)) {
      cx.spawn(async (cx) => {
        const r = await exec("python3", [appHome() + "/mods/agent-toast/live.py", addr], { timeout: 8000 }).catch(() => null);
        try { this.live = JSON.parse(r?.stdout || "{}")[addr] ?? null; } catch { this.live = null; }
        cx.notify();
      });
    }
  }

  icon(t, prog, level) {
    if (prog?.icon) return prog.tint ? svg(prog.icon).size(18).flex_none().text_color(prog.color ?? t.foreground) : image(prog.icon).w(18).h(18).flex_none();
    return div().size(8).rounded(4).flex_none().bg(t[DOT[level] ?? "accent"]);
  }

  agentView(t, p, a) {
    const blocked = a.status === "blocked" || /needs you|waiting/i.test(`${p.title} ${p.body ?? ""}`);
    const sp = spaces().find((s) => s.id === a.space);
    const name = a.title && a.title !== a.program?.name ? a.title : a.program?.name ?? "Agent";
    const where = [a.space_name, sp?.branch, a.tab_name && a.tab_name !== String(a.tab_index) ? a.tab_name : `tab ${a.tab_index}`].filter(Boolean).join(" · ");
    const l = this.live;
    // Waiting on you: the question it asks or the tool call it wants approved; finished: its last reply line.
    const said = blocked && l?.tool ? (l.tool.name === "AskUserQuestion" ? `asks: ${l.tool.target}` : `wants to run ${l.tool.name}: ${l.tool.target}`) : l?.text || null;
    return v_flex().flex_1().min_w(0).gap(1)
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(div().flex_none().text_size(11).font_semibold().text_color(blocked ? t.blocked : t.done).child(blocked ? "Needs you" : "Finished"))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(13).text_color(t.foreground).child(name)))
      .child(div().truncate().text_size(11.5).text_color(t.muted).child(where))
      .when(Boolean(l?.task), (el) => el.child(div().truncate().text_size(11.5).text_color(t.dim).child(`You: ${l.task}`)))
      .when(Boolean(said), (el) => el.child(div().truncate().text_size(11.5).text_color(t.dim).child(`${a.program?.name ?? "Agent"}: ${said}`)));
  }

  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const a = this.agent;
    const login = /^([a-z0-9][a-z0-9_.-]{0,31}) needs login; run hc machine login \1$/.exec(p.body ?? "");
    const command = login ? `hc machine login ${login[1]}` : null;
    return h_flex().id("toast").size_full().px(16).gap(12).items_center().bg(t.popover).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => { if (p.action?.name) run(p.action.name, p.action.args ?? {}); closeOverlay(p.overlay); })
      .child(a ? this.icon(t, a.program, p.level) : p.icon ? image(p.icon).w(18).h(18).flex_none() : this.icon(t, null, p.level))
      .child(a ? this.agentView(t, p, a) : v_flex().flex_1().overflow_hidden()
        .child(div().truncate().font_semibold().text_size(13).text_color(t.foreground).child(login ? `${login[1]} needs a login: run` : p.title ?? ""))
        .when(!login && Boolean(p.body), (el) => el.child(div().truncate().text_size(12).text_color(t.muted).child(p.body ?? "")))
        .when(Boolean(login), (el) => el.child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(command).text_size(12).text_color(t.muted).child(command))
          .child(div().id("toast-login-copy").flex_none().px(6).py(3).rounded(4).bg(t.raised).text_size(12).text_color(t.foreground).cursor_pointer()
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(command); this.copied = true; cx.notify(); })
            .child(this.copied ? "Copied" : "Copy")))));
  }
}
