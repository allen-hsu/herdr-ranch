// Accounts: more than one Claude Code / Codex login, to switch to another subscription when one runs out of
// quota (Orca-style). Opened from the command bar ("Accounts…") or the sidebar footer, as a dialog.
// Per provider: the system login (~/.claude, ~/.codex) and every added account, which one is Active (new agents
// start on it), and Use / Sign in again / Remove / Add account. "Use" can also move the agents that are running
// onto the new account (./switch.js), by the setting at the bottom: Ask / Restart them / Leave them.
// The data and every change go through ./accounts.py (lib/accounts.py): this mod never sees a credential.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import { exec, run, theme, props, closeOverlay, appHome, notify, setShared } from "herdr";
import { TS, SPACE, C, tint, icon, statusMark, dialogTitle, escChip, spaceName, field } from "./ui.js";
import { switchPlan, restartAgents, setPending } from "./accountswitch.js";

const PROVIDERS = [
  { id: "claude", name: "Claude Code", icon: "icons/claude.svg", signIn: ["claude"], how: "Sign in when Claude Code asks (or type /login)." },
  { id: "codex", name: "Codex", icon: "icons/codex.svg", signIn: ["codex", "login"], how: "Finish the sign-in Codex opens in your browser." },
];
const MODES = [["ask", "Ask"], ["restart", "Restart them"], ["leave", "Leave them"]];
const MODE_HELP = {
  ask: "Shows the agents that can move, and you pick.",
  restart: "Idle, finished and stopped agents continue their conversation on the new account, in a new tab. Busy ones follow once they are free.",
  leave: "Running agents stay on the account they started with. Only new agents use the new one.",
};

export default class Accounts extends View {
  init(_p, cx) {
    this.overlay = props()?.overlay;
    this.data = null;     // accounts.py list
    this.error = null;
    this.working = false; // a change is being made
    this.confirm = null;  // { provider, id }: "Remove?" shown on that row
    this.plan = null;     // { provider, name, env, items }: the Ask list after a switch
    this.adding = null;   // provider id whose "name the new account" row is open
    this.newName = null;  // its InputState
    this.renaming = null; // { provider, id, input }: the "what to call it" row open under an account
    this.strays = {};     // provider id -> running agents that are not on the account in use (switchPlan items)
    this.note = null;     // what the last action did, one line
    this.load(cx);
    this.findStrays(cx);
    // A sign-in finished in another tab shows up by itself (a small local read; redraws only when something changed).
    cx.timer.every(5000, (cx) => this.load(cx));
  }

  close() { closeOverlay(this.overlay); }
  async py(args) {
    const r = await exec("python3", [`${appHome()}/mods/accounts/accounts.py`, ...args], { timeout: 60000 });
    return JSON.parse(r.stdout || "{}");
  }
  async read() {
    try { const d = await this.py(["list"]); if (d?.claude) { this.data = d; this.error = null; } else this.error = d?.error ?? "no data"; }
    catch { this.error = "could not read the accounts (python3 missing?)"; }
  }
  load(cx) {
    if (this.reading || this.working) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      const before = JSON.stringify([this.data, this.error]);
      await this.read();
      this.reading = false;
      if (JSON.stringify([this.data, this.error]) !== before) cx.notify();
    });
  }
  // One change at a time; the list is read again after it.
  act(cx, fn) {
    if (this.working) return;
    this.working = true; this.note = null; this.confirm = null; this.renaming = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try { await fn(cx); } catch (e) { this.note = `That did not work: ${String(e?.message ?? e).slice(0, 120)}`; }
      await this.read();
      this.working = false;
      cx.notify();
      this.findStrays(cx);
    });
  }
  // Running agents that are not on the account in use: started before a switch and left behind, or a `claude`
  // typed in a shell that predates the shell hook. Looked for when the dialog opens and after each change
  // (it asks every agent, so not on the 5 s tick).
  findStrays(cx) {
    cx.spawn(async (cx) => {
      if (!this.data) await this.read();
      const next = {};
      for (const p of PROVIDERS) {
        const active = this.data?.[p.id]?.active;
        if (!active) continue;
        try { const items = await switchPlan(p.id, active); if (items.length) next[p.id] = items; } catch {}
      }
      this.strays = next;
      cx.notify();
    });
  }
  moveStrays(p, cx) {
    const sec = this.data?.[p.id], items = this.strays[p.id];
    if (!sec || !items?.length) return;
    setPending(p.id, sec.active, [], []);
    this.plan = { provider: p, id: sec.active, name: this.label(p, sec.active), env: sec.env ?? [], items };
    cx.notify();
  }

  label(p, id) {
    const sec = this.data?.[p.id];
    if (id === "default") return sec?.default?.email ?? "the system default";
    const a = sec?.accounts?.find((x) => x.id === id);
    return a?.label ?? a?.email ?? "the new account";
  }

  // ---------- actions ----------
  signIn(p, env, cx) {
    // A new tab in the space you're in, running the agent with that account's folder. The dialog would cover it.
    run("tab.new", { name: `Sign in: ${p.name}`, argv: [...env, ...p.signIn] });
    notify({ title: `Sign in to ${p.name} in the new tab`, body: `${p.how} Then open Accounts again: the email shows once you're in.` });
    this.close();
  }
  // "Add account" first asks what to call it: the name becomes the account's folder (accounts/claude-work), which
  // can't be renamed later, because the login is tied to that path.
  askName(p, cx) {
    if (this.adding === p.id) { this.adding = null; cx.notify(); return; }
    this.adding = p.id;
    this.newName = InputState.new({ value: "", placeholder: "Name it, e.g. Work or Personal  (Enter to add; you can rename it later)" });
    this.newName.on("submit", (_e, cx) => this.add(p, cx));
    this.newName.focus();
    cx.timer.after(200, () => { if (this.adding === p.id) this.newName?.focus(); });
    cx.notify();
  }
  add(p, cx) {
    const name = (this.newName?.value() ?? "").trim();
    this.act(cx, async (cx) => {
      const r = await this.py(name ? ["add", p.id, name] : ["add", p.id]);
      this.adding = null;
      if (r.error || !Array.isArray(r.env)) throw new Error(r.error ?? "no folder");
      this.signIn(p, r.env, cx);
    });
  }
  // What the account is called in Herdr (the row, the sidebar tag, the usage bar). Its folder keeps its name.
  askRename(p, a, cx) {
    if (this.renaming?.provider === p.id && this.renaming?.id === a.id) { this.renaming = null; cx.notify(); return; }
    const input = InputState.new({ value: a.label ?? "", placeholder: "What to call it, e.g. Work  (empty: its email)" });
    input.on("submit", (_e, cx) => this.rename(p, a, cx));
    this.renaming = { provider: p.id, id: a.id, input }; this.confirm = null;
    input.focus();
    cx.timer.after(200, () => this.renaming?.input === input && input.focus());
    cx.notify();
  }
  rename(p, a, cx) {
    const name = (this.renaming?.input.value() ?? "").trim();
    this.act(cx, async () => {
      const r = await this.py(["rename", p.id, a.id, name]);
      if (r.error) throw new Error(r.error);
      setShared("accounts.changed", Date.now());
    });
  }
  again(p, a, cx) {
    const env = [`env`, `${p.id === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"}=${a.dir}`];
    this.signIn(p, env, cx);
  }
  remove(p, a, cx) {
    this.act(cx, async () => {
      const r = await this.py(["remove", p.id, a.id]);
      if (r.error) throw new Error(r.error);
      setShared("accounts.changed", Date.now());
      this.note = `Removed ${a.email ?? "the account"} from Herdr.${p.id === "claude" ? " Its login stays in the macOS keychain until you sign out of it." : ""}`;
    });
  }
  setMode(mode, cx) {
    this.act(cx, async () => { await this.py(["on-switch", mode]); });
  }
  use(p, id, cx) {
    this.act(cx, async () => {
      const r = await this.py(["use", p.id, id]);
      if (r.error) throw new Error(r.error);
      setShared("accounts.changed", Date.now()); // the usage bar shows the new account's numbers
      await this.read();
      const name = this.label(p, id), mode = this.data?.onSwitch ?? "ask";
      const said = `New ${p.name} agents now start on ${name}.`;
      let items = [];
      try { items = await switchPlan(p.id, id); } catch {}
      const able = items.filter((x) => !x.skip);
      if (!items.length) { setPending(p.id, id, [], []); this.note = said; return; }
      if (mode === "leave") { setPending(p.id, id, [], []); this.note = `${said} ${items.length} running agent${items.length > 1 ? "s stay" : " stays"} on the old account.`; return; }
      if (mode === "restart") {
        const done = await restartAgents(p.id, r.env ?? [], able);
        setPending(p.id, id, r.env ?? [], items); // the busy ones follow when they are free
        const later = items.filter((x) => x.later).length;
        this.note = `${said} ${this.outcome(done.length, items.length - done.length - later)}${later ? ` ${later} busy agent${later > 1 ? "s" : ""} will move when free.` : ""}`;
        return;
      }
      this.note = said;
      setPending(p.id, id, [], []); // an older switch's waiting list no longer applies
      this.plan = { provider: p, id, name, env: r.env ?? [], items };
    });
  }
  outcome(moved, left) {
    return [moved ? `${moved} agent${moved > 1 ? "s" : ""} restarted on it.` : "No agent was restarted.", left ? `${left} left on the old account (nothing to resume).` : ""].filter(Boolean).join(" ");
  }
  restartPicked(cx) {
    const plan = this.plan;
    this.plan = null;
    this.act(cx, async () => {
      const picked = plan.items.filter((x) => x.on && !x.skip);
      const done = await restartAgents(plan.provider.id, plan.env, picked);
      setPending(plan.provider.id, plan.id, plan.env, plan.items); // the busy ones follow when they are free
      const later = plan.items.filter((x) => x.later).length;
      this.note = `${this.outcome(done.length, plan.items.length - done.length - later)}${later ? ` ${later} busy agent${later > 1 ? "s" : ""} will move when free.` : ""}`;
    });
  }

  // ---------- pieces ----------
  button(t, id, label, onClick, { primary = false, danger = false, ic = null } = {}) {
    return h_flex().id(id).h(26).flex_none().px(10).gap(6).items_center().rounded(7).border_1().cursor_pointer().text_size(TS.body)
      .border_color(primary ? t.solid : t.input).when(primary, (e) => e.bg(t.solid))
      .text_color(primary ? t.solid_foreground : danger ? C(t).status.blocked : t.foreground)
      .hover((s) => (primary ? s.opacity(0.88) : s.bg(t.hover)))
      .on_click((_e, cx) => { if (!this.working) onClick(cx); })
      .when(ic != null, (e) => e.child(icon(ic, 12)))
      .child(label);
  }

  row(t, p, a, isDefault, last) {
    const sec = this.data[p.id], id = isDefault ? "default" : a.id, active = sec.active === id;
    const who = isDefault ? sec.default : a;
    const key = `${p.id}-${id}`;
    // A name the person gave it leads; the email then moves to the second line.
    const title = isDefault ? "System default" : who.label ?? who.email ?? (who.signedIn ? "Signed in" : "Not signed in yet");
    const sub = isDefault
      ? [who.email ?? (who.signedIn ? "signed in" : "not signed in"), who.plan, p.id === "claude" ? "~/.claude" : "~/.codex"]
      : [who.label ? who.email : null, who.signedIn ? who.plan : `open "Sign in" to finish`, a.added ? `added ${a.added}` : null];
    const asking = this.confirm?.provider === p.id && this.confirm?.id === id;
    const naming = !isDefault && this.renaming?.provider === p.id && this.renaming?.id === id ? this.renaming : null;
    return v_flex().when(!last, (e) => e.border_b(1).border_color(t.border))
      .child(h_flex().min_h(48).px(SPACE.card).py(6).gap(8).items_center()
        .child(div().w(16).flex_none().flex().justify_center().child(active ? icon("circle-check", 14, t.accent) : icon("circle", 14, t.border)))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().text_size(TS.item).text_color(who.signedIn || isDefault ? t.foreground : t.muted).child(title))
          .child(div().truncate().text_size(TS.small).text_color(t.dim).child(sub.filter(Boolean).join(" · "))))
        .when(active, (e) => e.child(div().flex_none().h(20).px(8).flex().items_center().rounded(5).bg(tint(t.accent)).text_size(TS.small).font_semibold().text_color(t.accent).child("Active")))
        .when(!active && (isDefault || who.signedIn), (e) => e.child(this.button(t, `use-${key}`, "Use", (cx) => this.use(p, id, cx))))
        .when(!isDefault, (e) => e
          .child(div().id(`nm-${key}`).flex_none().size(26).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
            .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Rename").on_click((_e, cx) => { if (!this.working) this.askRename(p, a, cx); }).child(icon("pencil", 13)))
          .child(this.button(t, `in-${key}`, who.signedIn ? "Sign in again" : "Sign in", (cx) => this.again(p, a, cx)))
          .child(this.button(t, `rm-${key}`, "Remove", (cx) => { this.confirm = asking ? null : { provider: p.id, id }; this.renaming = null; cx.notify(); }, { danger: true }))))
      .when(Boolean(naming), (e) => e.child(h_flex().px(SPACE.card).pb(8).pl(SPACE.card + 24).gap(8).items_center()
        .child(div().flex_1().min_w(0).child(field(t, naming.input, { size: "panel", focused: true })))
        .child(this.button(t, `nmno-${key}`, "Cancel", (cx) => { this.renaming = null; cx.notify(); }))
        .child(this.button(t, `nmyes-${key}`, "Save", (cx) => this.rename(p, a, cx), { primary: true }))))
      .when(asking, (e) => e.child(h_flex().px(SPACE.card).pb(8).pl(SPACE.card + 24).gap(8).items_center()
        .child(div().flex_1().min_w(0).text_size(TS.small).text_color(t.muted).child(`Remove this account from Herdr? Its folder is deleted (your shared settings and conversations stay).${p.id === "claude" ? " The login itself stays in the macOS keychain until you sign out." : ""}`))
        .child(this.button(t, `rmno-${key}`, "Cancel", (cx) => { this.confirm = null; cx.notify(); }))
        .child(this.button(t, `rmyes-${key}`, "Remove", (cx) => this.remove(p, a, cx), { danger: true }))));
  }

  section(t, p) {
    const sec = this.data[p.id];
    return v_flex().gap(6)
      .child(h_flex().h(28).gap(8).items_center()
        .child(image(p.icon).size(14).flex_none())
        .child(div().flex_1().min_w(0).text_size(TS.small).font_semibold().text_color(t.muted).child(p.name))
        .child(this.button(t, `add-${p.id}`, "Add account", (cx) => this.askName(p, cx), { ic: "plus" })))
      .child(v_flex().rounded(8).bg(t.surface)
        .child(this.row(t, p, null, true, !sec.accounts.length))
        .children(sec.accounts.map((a, i) => this.row(t, p, a, false, i === sec.accounts.length - 1))))
      .when((this.strays[p.id]?.length ?? 0) > 0, (e) => { const n = this.strays[p.id].length, c = C(t).status.blocked;
        return e.child(h_flex().min_h(34).px(SPACE.card).py(4).gap(8).items_center().rounded(8).bg(tint(c, 0.08)).border_1().border_color(tint(c, 0.3))
          .child(icon("circle-alert", 13, c))
          .child(div().flex_1().min_w(0).text_size(TS.small).text_color(t.foreground).child(`${n} running agent${n > 1 ? "s are" : " is"} not on the account in use (${this.label(p, sec.active)}).`))
          .child(this.button(t, `strays-${p.id}`, n > 1 ? "Move them…" : "Move it…", (cx) => this.moveStrays(p, cx)))); })
      .when(this.adding === p.id && this.newName != null, (e) => e.child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).child(field(t, this.newName, { size: "panel", focused: true })))
        .child(this.button(t, `addno-${p.id}`, "Cancel", (cx) => { this.adding = null; cx.notify(); }))
        .child(this.button(t, `addyes-${p.id}`, "Add and sign in", (cx) => this.add(p, cx), { primary: true }))));
  }

  setting(t) {
    const mode = this.data.onSwitch;
    return v_flex().gap(6)
      .child(div().h(28).flex().items_center().text_size(TS.small).font_semibold().text_color(t.muted).child("When you switch while agents are running"))
      .child(h_flex().gap(12).items_center()
        .child(h_flex().h(28).p(2).gap(2).flex_none().rounded(7).bg(t.background).border_1().border_color(t.border)
          .children(MODES.map(([id, label]) => div().id(`mode-${id}`).h_full().px(10).flex().items_center().rounded(5).text_size(TS.body).cursor_pointer()
            .text_color(mode === id ? t.foreground : t.muted).when(mode === id, (e) => e.bg(t.selected).font_medium())
            .on_click((_e, cx) => { if (mode !== id) this.setMode(id, cx); }).child(label))))
        .child(div().flex_1().min_w(0).text_size(TS.small).text_color(t.dim).child(MODE_HELP[mode] ?? "")));
  }

  // The Ask list: what can move to the new account, ticked; what can't, and why.
  planView(t) {
    const pl = this.plan, able = pl.items.filter((x) => !x.skip), n = able.filter((x) => x.on).length;
    const box = (on, off) => div().size(16).flex_none().rounded(4).flex().items_center().justify_center()
      .when(on, (e) => e.bg(t.accent).child(icon("check", 12, C(t).on.accent)))
      .when(!on, (e) => e.border_1().border_color(off ? t.border : t.input));
    const line = (it, i) => h_flex().id(`pl-${i}`).h(32).px(SPACE.card).gap(8).items_center().when(i < pl.items.length - 1, (e) => e.border_b(1).border_color(t.border))
      .when(!it.skip, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { it.on = !it.on; cx.notify(); }))
      .child(box(it.on && !it.skip, Boolean(it.skip)))
      .child(div().w(16).flex_none().flex().justify_center().child(statusMark(t, it.status)))
      .child(div().flex_1().min_w(0).truncate().text_size(TS.item).text_color(it.skip ? t.muted : t.foreground).child(it.name))
      .child(div().flex_none().max_w(240).truncate().text_size(TS.small).text_color(t.dim).child(`${spaceName(it.where)} · ${it.later ? `${it.skip}: moves when free` : it.skip ? `skipped: ${it.skip}` : it.status === "error" ? "stopped on an error" : it.status === "done" ? "finished" : "idle"}`));
    return v_flex().flex_1().min_h(0).p(SPACE.dialog).gap(12)
      .child(v_flex().gap(4)
        .child(div().text_size(TS.item).font_medium().text_color(t.foreground).child(`Restart running ${pl.provider.name} agents on ${pl.name}?`))
        .child(div().text_size(TS.small).text_color(t.muted).child("Each ticked agent continues its conversation in a new tab on the new account, and its old tab closes. An agent that is working or waiting for you is not interrupted: it moves by itself once it is free.")))
      .child(v_flex().id("plan-list").flex_1().min_h(0).rounded(8).bg(t.surface).overflow_y_scrollbar().children(pl.items.map(line)))
      .child(h_flex().gap(8).items_center().justify_end()
        .child(div().flex_1().min_w(0).text_size(TS.small).text_color(t.dim).child(able.length ? "" : pl.items.some((x) => x.later) ? "All of them are busy." : "Nothing can be restarted right now."))
        .child(this.button(t, "plan-no", "Leave them", (cx) => { this.plan = null; cx.notify(); }))
        .when(n > 0 || pl.items.some((x) => x.later), (e) => e.child(this.button(t, "plan-yes", n > 0 ? `Restart ${n}` : "Move when free", (cx) => this.restartPicked(cx), { primary: true }))));
  }

  render() {
    const t = theme();
    const head = h_flex().h(48).px(SPACE.dialog).gap(12).items_center().flex_none().border_b(1).border_color(t.border)
      .child(dialogTitle(t, "Accounts"))
      .child(div().flex_1().min_w(0).truncate().text_size(TS.body).text_color(t.dim).child("Which login new Claude Code and Codex agents start on"))
      .child(div().id("ac-refresh").flex_none().size(26).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
        .hover((e) => e.bg(t.hover).text_color(t.foreground)).tooltip("Refresh").on_click((_e, cx) => this.load(cx)).child(icon("refresh-cw", 13)))
      .child(escChip(t, "ac-esc", () => this.close()));
    const root = v_flex().id("accounts").size_full().bg(t.popover).text_size(TS.item).text_color(t.foreground).child(head);
    if (!this.data) return root.child(div().p(SPACE.dialog).text_size(TS.body).text_color(t.dim).child(this.error ?? "Reading accounts…"));
    if (this.plan) return root.child(this.planView(t));
    return root
      .child(v_flex().id("ac-body").flex_1().min_h(0).p(SPACE.dialog).gap(12).overflow_y_scrollbar()
        .children(PROVIDERS.map((p) => this.section(t, p)))
        .child(this.setting(t))
        .child(div().text_size(TS.small).text_color(t.dim).child("The logins stay where Claude Code (the macOS keychain) and Codex (its account folder) keep them. Herdr only remembers which one is in use; added accounts share your settings, skills and conversations.")))
      .when(Boolean(this.note) || this.working, (e) => e.child(h_flex().h(34).flex_none().px(SPACE.dialog).gap(8).items_center().border_t(1).border_color(t.border).text_size(TS.small).text_color(t.muted)
        .child(div().flex_1().min_w(0).truncate().child(this.working ? "Working…" : this.note))));
  }
}
