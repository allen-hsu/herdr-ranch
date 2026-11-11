// Notifications that say which agent they are about. Chosen by a layout's root "toast": "agent-toast".
// Herdr's own agent toasts ("<program> finished", "... needs you") carry action agent.focus {terminal};
// for those it shows the agent's session name and Finished / Needs you · space · branch · tab.
// Every other notify() looks like Herdr's shipped toast. Click: go there. When Herdr isn't the front app
// (macOS) it posts a Notification Center notification instead: through Herdr Notify.app (integrations/notifier,
// Herdr's icon, click focuses the agent), else osascript.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme, agents, spaces, window, exec, home, readTextFile } from "herdr";

// "Glass" -> ~/Library/Sounds/Glass.aiff if you added one, else /System/Library/Sounds/Glass.aiff; a path stays a
// path. name: what a macOS notification can play (a file in a Sounds folder); path: what afplay plays.
async function soundFile(v) {
  if (typeof v !== "string" || !v.trim() || v.includes("..")) return null;
  if (v.startsWith("/") || v.startsWith("~")) return { path: v.replace(/^~/, home()), name: null };
  const file = /\.\w+$/.test(v) ? v : `${v}.aiff`;
  const mine = `${home()}/Library/Sounds/${file}`;
  const have = (await exec("test", ["-f", mine]).catch(() => null))?.code === 0;
  return { path: have ? mine : `/System/Library/Sounds/${file}`, name: file };
}

const DOT = { error: "blocked", warning: "working", success: "done", info: "accent" };

export default class AgentToast extends View {
  init(_props, cx) {
    const p = props() ?? {};
    const addr = p.action?.name === "agent.focus" ? p.action.args?.terminal : null;
    this.agent = addr ? agents().find((a) => a.address === addr) ?? null : null;
    const kind = this.agent ? (this.agent.status === "blocked" || /needs you|waiting/i.test(`${p.title} ${p.body ?? ""}`) ? "blocked" : "done") : null;
    const background = window()?.platform === "macos" && !window()?.active;
    // Optional sounds (~/.config/herdr-app/agent-toast.json: {"sounds": {"done": "Glass", "blocked": "Submarine"}}):
    // a macOS sound name (/System/Library/Sounds, ~/Library/Sounds) or a file path. Set them and turn Herdr's
    // own alert sound off, so each alert plays once: on the system notification in the background, afplay here.
    if (!kind && !background) return;
    cx.spawn(async () => {
      let conf = null;
      try { conf = JSON.parse((await readTextFile(`${home()}/.config/herdr-app/agent-toast.json`)) ?? "null"); } catch {}
      const sound = kind ? await soundFile(conf?.sounds?.[kind]) : null;
      if (!background) {
        if (sound && window()?.platform === "macos") exec("afplay", [sound.path], { timeout: 15000 }).catch(() => null);
        return;
      }
      // Herdr isn't in front: tell macOS instead. Herdr Notify.app (built by herdr-ranch's install.sh) shows
      // Herdr's icon and focuses the agent on click; osascript is the fallback.
      const { title, subtitle } = this.lines(p);
      const helper = `${home()}/Applications/Herdr Notify.app/Contents/MacOS/herdr-notify`;
      const args = ["--title", title, "--subtitle", subtitle, "--body", p.body || ""];
      if (addr && /^[A-Za-z0-9_-]+$/.test(addr)) args.push("--terminal", addr);
      if (sound?.name) args.push("--sound", sound.name);
      const r = await exec(helper, args, { timeout: 15000 }).catch(() => null);
      if (r?.code !== 0) {
        await exec("osascript", ["-e", "on run a\ndisplay notification (item 3 of a) with title (item 1 of a) subtitle (item 2 of a)\nend run", title, subtitle, p.body || ""], { timeout: 5000 }).catch(() => null);
        if (sound) exec("afplay", [sound.path], { timeout: 15000 }).catch(() => null);
      }
      closeOverlay(p.overlay);
    });
  }

  // Plain-text version for the system notification.
  lines(p) {
    const a = this.agent;
    if (!a) return { title: p.title ?? "Herdr", subtitle: "" };
    const blocked = a.status === "blocked" || /needs you|waiting/i.test(`${p.title} ${p.body ?? ""}`);
    const sp = spaces().find((s) => s.id === a.space);
    const name = a.title && a.title !== a.program?.name ? a.title : a.program?.name ?? "Agent";
    const tab = a.tab_name && a.tab_name !== String(a.tab_index) ? a.tab_name : null;
    return { title: name, subtitle: [blocked ? "Needs you" : "Finished", a.space_name, sp?.branch, tab].filter(Boolean).join(" · ") };
  }

  icon(t, prog, level) {
    if (prog?.icon) return prog.tint ? svg(prog.icon).size(20).text_color(prog.color ?? t.foreground) : image(prog.icon).w(20).h(20);
    return div().size(8).rounded(4).bg(t[DOT[level] ?? "accent"]);
  }

  // Two lines, sized for Herdr's corner toast: who (session name), then status · space · tab.
  agentView(t, p, a) {
    const blocked = a.status === "blocked" || /needs you|waiting/i.test(`${p.title} ${p.body ?? ""}`);
    const color = blocked ? t.blocked : t.done;
    const sp = spaces().find((s) => s.id === a.space);
    const name = a.title && a.title !== a.program?.name ? a.title : a.program?.name ?? "Agent";
    const tab = a.tab_name && a.tab_name !== String(a.tab_index) ? a.tab_name : null;
    const where = [a.space_name, sp?.branch, tab].filter(Boolean).join(" · ");
    return [
      div().relative().size(28).flex_none().flex().items_center().justify_center().rounded(7).bg(t.raised)
        .child(this.icon(t, a.program, p.level))
        .child(div().absolute().right(-2).bottom(-2).size(10).rounded(5).border_2().border_color(t.popover).bg(color)),
      v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().font_semibold().text_size(13).text_color(t.foreground).child(name))
        .child(h_flex().gap(6).min_w(0).text_size(11.5)
          .child(div().flex_none().font_medium().text_color(color).child(blocked ? "Needs you" : "Finished"))
          .when(Boolean(where), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(where)))),
    ];
  }

  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const a = this.agent;
    const login = /^([a-z0-9][a-z0-9_.-]{0,31}) needs login; run hc machine login \1$/.exec(p.body ?? "");
    const command = login ? `hc machine login ${login[1]}` : null;
    return h_flex().id("toast").size_full().px(14).gap(12).items_center().bg(t.popover).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => { if (p.action?.name) run(p.action.name, p.action.args ?? {}); closeOverlay(p.overlay); })
      .when(Boolean(a), (el) => el.children(a ? this.agentView(t, p, a) : []))
      .when(!a, (el) => el.child(p.icon ? image(p.icon).w(18).h(18).flex_none() : div().size(8).rounded(4).flex_none().bg(t[DOT[p.level] ?? "accent"])))
      .when(!a, (el) => el.child(v_flex().flex_1().overflow_hidden()
        .child(div().truncate().font_semibold().text_size(13).text_color(t.foreground).child(login ? `${login[1]} needs a login: run` : p.title ?? ""))
        .when(!login && Boolean(p.body), (el) => el.child(div().truncate().text_size(12).text_color(t.muted).child(p.body ?? "")))
        .when(Boolean(login), (el) => el.child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(command).text_size(12).text_color(t.muted).child(command))
          .child(div().id("toast-login-copy").flex_none().px(6).py(3).rounded(4).bg(t.raised).text_size(12).text_color(t.foreground).cursor_pointer()
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(command); this.copied = true; cx.notify(); })
            .child(this.copied ? "Copied" : "Copy"))))));
  }
}
