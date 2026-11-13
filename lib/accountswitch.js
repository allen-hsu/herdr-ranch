// After "Use": move running agents onto the new account, Orca-style ("Restarting continues each running
// conversation on the new account"). An agent is moved while it is idle, finished, or stopped on an error (out of
// usage is the usual one, and the reason to switch): its conversation is resumed in a new tab of the same space
// (claude --resume <session> / codex resume <session>, same folder, same name) and the old tab is closed.
// One that is working, waiting for the person, or waiting on its own background work is not touched now: it goes
// on the pending list (shared "accounts.pending") and movePending() moves it once it is free.
// Shared lib (herdr-ranch/lib): the Accounts dialog switches, the tab bar (always on screen) runs movePending().
import { agents, spaces, panes, focused, exec, run, appHome, shared, setShared } from "herdr";
import { providerOf, syncAccounts } from "./accounts.js";
import { agentName } from "./agentname.js";

const SESSION = /^[0-9a-fA-F-]{8,64}$/;
const BUSY = { working: "working", blocked: "waiting for you" };
const NAME = { claude: "Claude Code", codex: "Codex" };
const PENDING = "accounts.pending"; // { claude: { id, env, addrs: [...], at }, codex: {...} }
const MOVING = "accounts.moving";   // when a mover started (0: none)

// The running agents of this provider that are not on account `id`, each with what a restart needs and, when it
// can't be restarted now, why (`skip`).
export async function switchPlan(provider, id) {
  const mine = agents().filter((a) => !a.address.includes("/") && providerOf(a) === provider && /^[A-Za-z0-9_-]+$/.test(a.address));
  if (!mine.length) return [];
  const r = await exec("python3", [`${appHome()}/mods/accounts/accounts.py`, "agents", provider, ...mine.map((a) => a.address)], { timeout: 60000 });
  const info = JSON.parse(r.stdout || "{}");
  const tabs = spaces().flatMap((s) => s.tabs ?? []);
  return mine.filter((a) => info[a.address] && info[a.address].account !== id).map((a) => {
    const i = info[a.address], tab = tabs.find((x) => x.id === a.tab);
    const session = typeof i.session === "string" && SESSION.test(i.session) ? i.session : null;
    const skip = BUSY[a.status] ?? (i.background > 0 ? "background work running" : !session ? "no conversation to resume yet" : !i.cwd ? "folder unknown" : null);
    return { address: a.address, name: agentName(a) || a.program?.name || a.address, status: a.status, where: a.space_name, space: a.space,
      tabName: tab?.named ? tab.name : NAME[provider], tab: a.tab, pane: a.pane, session, cwd: i.cwd, skip, on: !skip,
      later: Boolean(BUSY[a.status]) || i.background > 0 };
  });
}

// Restart the given plan items with the account's argv prefix (`env`: [] for the system login).
// Returns the addresses restarted. An agent that started working in the meantime is left alone.
export async function restartAgents(provider, env, items) {
  const done = [];
  if (items.some((it) => !it.skip)) await syncAccounts(provider);
  // A new tab takes the view with it (into another space, too): afterwards go back to where the person was,
  // unless that was one of the restarted agents (then its new tab is the right place).
  const before = focused()?.pane ?? null;
  for (const it of items) {
    if (it.skip || !it.session || !SESSION.test(it.session) || !it.cwd) continue;
    const now = agents().find((a) => a.address === it.address);
    if (!now || BUSY[now.status]) continue;
    const argv = provider === "claude" ? [...env, "claude", "--resume", it.session] : [...env, "codex", "--no-daemon", "resume", it.session];
    run("tab.new", { space: it.space, folder: it.cwd, name: it.tabName, argv });
    // Close the old one for good: its tab when the agent is alone in it (killing the agent would leave its
    // shell behind, looking alive), else just its pane.
    const alone = panes().filter((p) => p.tab === it.tab).length <= 1;
    if (alone && it.tab) run("tab.close", { id: it.tab, confirmed: true });
    else if (it.pane) run("pane.close", { pane: it.pane });
    else await exec("hc", ["kill", it.address], { timeout: 15000 }).catch(() => null);
    done.push(it.address);
  }
  if (done.length && before && panes().some((p) => p.pane === before && !done.includes(p.terminal))) run("pane.focus", { pane: before });
  return done;
}

// Remember the agents that were busy at the switch, to move them when they are free.
export function setPending(provider, id, env, items) {
  const addrs = items.filter((x) => x.later).map((x) => x.address);
  const all = { ...(shared(PENDING) ?? {}) };
  if (addrs.length) all[provider] = { id, env, addrs, at: Date.now() }; else delete all[provider];
  setShared(PENDING, all);
}

// Called on a slow timer by a mod that is always shown. Does nothing (and asks nothing) while the list is empty.
export async function movePending() {
  const all = shared(PENDING) ?? {};
  if (!Object.keys(all).length) return;
  // One mover at a time, across windows (each has its own tab bar).
  if (Date.now() - (shared(MOVING) ?? 0) < 90000) return;
  setShared(MOVING, Date.now());
  try { await moveAll(all); } finally { setShared(MOVING, 0); }
}
async function moveAll(all) {
  for (const provider of Object.keys(all)) {
    const p = all[provider];
    if (!p || !Array.isArray(p.addrs) || Date.now() - (p.at ?? 0) > 12 * 3600 * 1000) { const next = { ...(shared(PENDING) ?? {}) }; delete next[provider]; setShared(PENDING, next); continue; }
    const live = agents().filter((a) => p.addrs.includes(a.address)).map((a) => a.address);
    let left = live, moved = [];
    if (agents().some((a) => live.includes(a.address) && !BUSY[a.status])) {
      const plan = await switchPlan(provider, p.id).catch(() => null);
      if (plan) {
        const mine = plan.filter((x) => live.includes(x.address));
        const ready = mine.filter((x) => !x.skip);
        if (ready.length) moved = await restartAgents(provider, Array.isArray(p.env) ? p.env : [], ready);
        // Keep waiting only for the ones still busy; one already on the account, or with nothing to resume, is dropped.
        left = mine.filter((x) => x.later && !moved.includes(x.address)).map((x) => x.address);
      }
    }
    if (left.length !== p.addrs.length || moved.length) {
      const next = { ...(shared(PENDING) ?? {}) };
      if (left.length) next[provider] = { ...p, addrs: left }; else delete next[provider];
      setShared(PENDING, next);
    }
  }
}
