// After "Use": move running agents onto the new account, Orca-style ("Restarting continues each running
// conversation on the new account"). An agent can be moved only while it is idle or finished: its conversation
// is resumed in a new tab of the same space (claude --resume <session> / codex resume <session>, same folder,
// same name) and the old terminal is closed. One that is working, waiting for the person, or waiting on its own
// background work is never touched.
import { agents, spaces, panes, focused, exec, run, appHome } from "herdr";
import { providerOf } from "./accounts.js";
import { agentName } from "./agentname.js";

const SESSION = /^[0-9a-fA-F-]{8,64}$/;
const BUSY = { working: "working", blocked: "waiting for you", error: "waiting for you" };
const NAME = { claude: "Claude Code", codex: "Codex" };

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
      tabName: tab?.named ? tab.name : NAME[provider], session, cwd: i.cwd, skip, on: !skip };
  });
}

// Restart the given plan items with the account's argv prefix (`env`: [] for the system login).
// Returns the addresses restarted. An agent that started working in the meantime is left alone.
export async function restartAgents(provider, env, items) {
  const done = [];
  // A new tab takes the view with it (into another space, too): afterwards go back to where the person was,
  // unless that was one of the restarted agents (then its new tab is the right place).
  const before = focused()?.pane ?? null;
  for (const it of items) {
    if (it.skip || !it.session || !SESSION.test(it.session) || !it.cwd) continue;
    const now = agents().find((a) => a.address === it.address);
    if (!now || BUSY[now.status]) continue;
    const argv = provider === "claude" ? [...env, "claude", "--resume", it.session] : [...env, "codex", "--no-daemon", "resume", it.session];
    run("tab.new", { space: it.space, folder: it.cwd, name: it.tabName, argv });
    await exec("hc", ["kill", it.address], { timeout: 15000 }).catch(() => null);
    done.push(it.address);
  }
  if (done.length && before && panes().some((p) => p.pane === before && !done.includes(p.terminal))) run("pane.focus", { pane: before });
  return done;
}
