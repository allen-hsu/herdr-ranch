// agent-restore: after a restart, bring the agents back.
// Herdr keeps every terminal across a reboot, a logout or a core crash, but as a shell: "its original command is
// never run again". A SessionStart hook (integrations/agent-restore/session-hook.py) labels each terminal with
// the conversation running in it; labels survive the restart. This mod finds the terminals whose agent is gone,
// whose shell waits, and whose record is from an earlier run of the core, and offers to resume them where they
// were: it types `cd <folder> && claude --resume <id>` (or `codex resume <id>`) into that same terminal, on the
// account in use. Nothing is resumed without a click, unless "Automatically" is chosen in its dialog.
//   In the layout (a block that is always shown, e.g. in the status row; props { block: "<its id>" }): a pill
//   "Restore N agents" while there is something to restore, and nothing (1px wide) otherwise.
//   As a dialog (props { dialog: true }): the list, Resume, Forget, and the Ask / Automatically / Off choice.
// It also keeps the records tidy: the agent's name goes into ranch.title, a record whose agent ended under the
// current core run is removed, and a live agent's record is re-stamped after a planned core restart.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { terminals, agents, spaces, panes, hc, exec, run, theme, props, openOverlay, closeOverlay, shared, setShared } from "herdr";
import { TS, SPACE, C, tint, icon, dialogTitle, escChip, spaceName } from "./ui.js";
import { loadAccounts, envFor, syncAccounts } from "./accounts.js";
import { agentName } from "./agentname.js";
import { KEYS, parseCore, classify, resumeLine } from "./logic.js";

const TRIED = "agent-restore.tried"; // { address: when a resume was typed into it } (shared by the pill and the dialog)
const MODES = [["ask", "Ask"], ["auto", "Automatically"], ["off", "Off"]];
const MODE_HELP = {
  ask: "Shows this list, and you pick.",
  auto: "Resumes them as soon as Herdr is back, one after another.",
  off: "Never offers. The records are still kept, so you can turn it back on.",
};
const ICON = { claude: "icons/claude.svg", codex: "icons/codex.svg" };
const NAME = { claude: "Claude Code", codex: "Codex" };
const mode = () => { const m = localStorage.getItem("mode"); return MODES.some(([id]) => id === m) ? m : "ask"; };

export default class AgentRestore extends View {
  init(_p, cx) {
    this.overlay = props()?.overlay;
    this.dialog = Boolean(props()?.dialog);
    this.block = typeof props()?.block === "string" ? props().block : null;
    this.core = null; this.coreAt = 0;  // this run of herdr-core, asked once a minute
    this.items = [];                    // records to restore (logic.js record), not yet tried
    this.off = {};                      // dialog: address -> unticked
    this.staleSeen = {};                // address -> when it was first seen ended under this core run
    this.queue = []; this.busy = false; // resumes waiting their turn
    this.width = null;                  // the pill's block width as last set
    this.auto = null;                   // the core run "Automatically" already acted on
    this.note = null;
    this.look(cx);
    cx.timer.every(this.dialog ? 3000 : 12000, (cx) => this.look(cx));
  }
  close() { closeOverlay(this.overlay); }

  // ---------- what is there ----------
  look(cx) {
    if (this.looking) return;
    this.looking = true;
    cx.spawn(async (cx) => {
      try {
        const now = Date.now();
        if (!this.core || now - this.coreAt > 60000) {
          try { const s = JSON.parse((await hc(["server", "status", "--json"])).stdout); this.core = parseCore(`${s.pid}.${Math.round(now / 1000 - s.uptime_ms / 1000)}`); this.coreAt = now; } catch {}
        }
        let all = [];
        try { all = terminals() ?? []; } catch {}
        const c = classify(all, this.core);
        if (!this.dialog) await this.tidy(c, now);
        const tried = shared(TRIED) ?? {};
        const before = JSON.stringify(this.items);
        this.items = mode() === "off" && !this.dialog ? [] : c.restore.filter((r) => !tried[r.address]).map((r) => ({ ...r, ...this.whereOf(r.address) }));
        if (!this.dialog) {
          this.fit();
          if (mode() === "auto" && this.items.length && this.auto !== this.core?.start) { this.auto = this.core?.start; this.resume(this.items, cx); }
        }
        if (JSON.stringify(this.items) !== before) cx.notify();
      } finally { this.looking = false; }
    });
  }
  // The space and tab a terminal sits in, for the list.
  whereOf(address) {
    const pane = panes().find((p) => p.terminal === address);
    for (const s of spaces()) { const tab = (s.tabs ?? []).find((x) => x.id === pane?.tab); if (tab) return { space: spaceName(s.name), tab: tab.named ? tab.name : null }; }
    return { space: null, tab: null };
  }
  // Housekeeping, from the layout copy only (one writer): names, re-stamps, records that no longer apply.
  async tidy(c, now) {
    const label = (address, pairs) => hc(["label", address, ...pairs]).catch(() => null);
    const names = Object.fromEntries(agents().map((a) => [a.address, agentName(a)]));
    for (const r of c.alive) {
      const name = String(names[r.address] ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
      if (name && name !== r.title) await label(r.address, [`ranch.title=${name}`]);
    }
    const stamp = this.core ? `${this.core.pid}.${this.core.start}` : null;
    if (stamp) for (const r of c.restamp) await label(r.address, [`ranch.core=${stamp}`]);
    // Ended under this run: gone for good once seen twice, 20 s apart (an agent that is only just starting has
    // its labels a moment before Herdr sees it).
    const stale = new Set(c.stale.map((r) => r.address));
    for (const a of Object.keys(this.staleSeen)) if (!stale.has(a)) delete this.staleSeen[a];
    for (const r of c.stale) {
      this.staleSeen[r.address] ??= now;
      if (now - this.staleSeen[r.address] >= 20000) { await label(r.address, KEYS.map((k) => `${k}=`)); delete this.staleSeen[r.address]; }
    }
    // A terminal that was tried and now runs its agent again (or is gone) needs no "tried" mark any more.
    const tried = shared(TRIED) ?? {}, waiting = new Set(c.restore.map((r) => r.address));
    const keep = Object.fromEntries(Object.entries(tried).filter(([a, at]) => waiting.has(a) && now - at < 6 * 3600 * 1000));
    if (Object.keys(keep).length !== Object.keys(tried).length) setShared(TRIED, keep);
  }
  // The pill's block is as wide as what it shows: 1px when there is nothing.
  fit() {
    if (!this.block) return;
    const w = this.items.length ? 178 : 1;
    if (w !== this.width) { this.width = w; run("layout.resize", { id: this.block, px: w }); }
  }

  // ---------- acting ----------
  // One after another, a moment apart: a dozen agents starting at once is a lot for a machine that just booted.
  resume(list, cx) {
    this.queue.push(...list.filter((r) => !this.queue.some((q) => q.address === r.address)));
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      let reg = null, known = [];
      try { reg = await loadAccounts(); } catch {}
      try { known = shared("new-menu.agents")?.[""] ?? []; } catch {}
      const synced = {};
      const step = async (cx) => {
        const r = this.queue.shift();
        if (!r) { this.busy = false; cx.notify(); return; }
        const env = envFor(reg, r.provider);
        if (env.length && !synced[r.provider]) { synced[r.provider] = true; await syncAccounts(r.provider); }
        const cmd = known.find((k) => k.key === r.provider && Array.isArray(k.run))?.run ?? null;
        const line = resumeLine(r, env, cmd);
        // Only into a shell that is still waiting (the person may have started something there meanwhile).
        const still = classify((terminals() ?? []).filter((x) => x.address === r.address), this.core).restore.length === 1;
        if (line && still) {
          // Typed as a person would: from inside a terminal, hc wraps what it sends in <hc from="…"> for agents to
          // read, which a shell can't parse. `env -u` makes sure this send never looks like it came from one.
          await exec("env", ["-u", "HC_TERMINAL_ID", "-u", "HC_SCOPE", "hc", "send", r.address, line], { timeout: 90000 }).catch(() => null);
          setShared(TRIED, { ...(shared(TRIED) ?? {}), [r.address]: Date.now() });
        }
        this.items = this.items.filter((x) => x.address !== r.address);
        cx.notify();
        cx.timer.after(1500, (cx) => cx.spawn(step));
      };
      await step(cx);
    });
  }
  forget(list, cx) {
    cx.spawn(async (cx) => {
      for (const r of list) await hc(["label", r.address, ...KEYS.map((k) => `${k}=`)]).catch(() => null);
      this.items = this.items.filter((x) => !list.some((r) => r.address === x.address));
      cx.notify();
      if (this.dialog && !this.items.length) this.close();
    });
  }

  // ---------- drawing ----------
  render() {
    const t = theme();
    if (!this.dialog) return this.pill(t);
    const picked = this.items.filter((r) => !this.off[r.address]), n = picked.length, m = mode();
    const button = (id, label, onClick, { primary = false } = {}) => h_flex().id(id).h(28).flex_none().px(12).items_center().rounded(7).border_1().cursor_pointer().text_size(TS.body)
      .border_color(primary ? t.solid : t.input).when(primary, (e) => e.bg(t.solid)).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((s) => (primary ? s.opacity(0.88) : s.bg(t.hover))).on_click((_e, cx) => onClick(cx)).child(label);
    const box = (on) => div().size(16).flex_none().rounded(4).flex().items_center().justify_center()
      .when(on, (e) => e.bg(t.accent).child(icon("check", 12, C(t).on.accent))).when(!on, (e) => e.border_1().border_color(t.input));
    const row = (r, i) => h_flex().id(`ar-${r.address}`).h(40).flex_none().px(SPACE.card).gap(8).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .when(i < this.items.length - 1, (e) => e.border_b(1).border_color(t.border))
      .on_click((_e, cx) => { this.off[r.address] = !this.off[r.address]; cx.notify(); })
      .child(box(!this.off[r.address]))
      .child(image(ICON[r.provider]).size(14).flex_none())
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(TS.item).text_color(t.foreground).child(r.title ?? `${NAME[r.provider]} conversation`))
        .child(div().truncate().text_size(TS.small).text_color(t.dim).child([r.space, r.tab, r.cwd ? r.cwd.split("/").pop() : null].filter(Boolean).join(" · "))));
    return v_flex().id("agent-restore").size_full().bg(t.popover).text_size(TS.item).text_color(t.foreground)
      .child(h_flex().h(48).px(SPACE.dialog).gap(12).items_center().flex_none().border_b(1).border_color(t.border)
        .child(dialogTitle(t, "Restore agents"))
        .child(div().flex_1().min_w(0).truncate().text_size(TS.body).text_color(t.dim).child("Conversations that were running before Herdr restarted"))
        .child(escChip(t, "ar-esc", () => this.close())))
      .child(v_flex().flex_1().min_h(0).p(SPACE.dialog).gap(12)
        .child(v_flex().id("ar-list").flex_1().min_h(0).rounded(8).bg(t.surface).overflow_y_scrollbar()
          .when(!this.items.length, (e) => e.child(div().px(SPACE.card).py(12).text_size(TS.body).text_color(t.dim).child(this.busy ? "Resuming…" : "Nothing to restore.")))
          .children(this.items.map(row)))
        .child(div().text_size(TS.small).text_color(t.muted).child("Each one continues in its own tab, where it was, on the account in use. What it was doing when Herdr stopped was cut short: tell it to carry on. Programs it had left running in the background are not started again."))
        .child(h_flex().gap(12).items_center()
          .child(div().flex_none().text_size(TS.small).font_semibold().text_color(t.muted).child("After a restart"))
          .child(h_flex().h(28).p(2).gap(2).flex_none().rounded(7).bg(t.background).border_1().border_color(t.border)
            .children(MODES.map(([id, label]) => div().id(`ar-mode-${id}`).h_full().px(10).flex().items_center().rounded(5).cursor_pointer().text_size(TS.body)
              .text_color(m === id ? t.foreground : t.muted).when(m === id, (e) => e.bg(t.selected).font_medium())
              .on_click((_e, cx) => { localStorage.setItem("mode", id); cx.notify(); }).child(label))))
          .child(div().flex_1().min_w(0).text_size(TS.small).text_color(t.dim).child(MODE_HELP[m])))
        .child(h_flex().gap(8).items_center().justify_end()
          .when(this.items.length > 0, (e) => e.child(button("ar-forget", n === this.items.length ? "Forget them" : `Forget ${n}`, (cx) => this.forget(picked, cx))))
          .child(button("ar-close", "Close", () => this.close()))
          .when(n > 0, (e) => e.child(button("ar-go", `Resume ${n}`, (cx) => this.resume(picked, cx), { primary: true })))));
  }
  pill(t) {
    const n = this.items.length;
    if (!n) return div().size_full();
    const c = C(t).status.done ?? t.accent;
    return h_flex().id("agent-restore-pill").size_full().px(6).items_center().justify_center()
      .child(h_flex().id("ar-open").h(20).px(8).gap(6).items_center().rounded(6).cursor_pointer().bg(tint(c, 0.14)).border_1().border_color(tint(c, 0.4))
        .text_size(TS.small).text_color(t.foreground).hover((s) => s.bg(tint(c, 0.24)))
        .tooltip(`${n} agent${n > 1 ? "s were" : " was"} running before Herdr restarted. Click to bring ${n > 1 ? "them" : "it"} back.`)
        .on_click(() => openOverlay({ mod: "agent-restore", kind: "dialog", width: 560, height: 440, props: { dialog: true } }))
        .child(icon("history", 12, c)).child(div().truncate().child(`Restore ${n} agent${n > 1 ? "s" : ""}`)));
  }
}
