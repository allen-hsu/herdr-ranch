// Names given with /rename, read from Claude Code's record of each running agent (~/.claude/sessions/<pid>.json,
// or the same in an account's folder: nameSource "user"; "derived" is one it made up). Kept in shared state for
// agentName() (lib/agentname.js). The tab bar (tabs-plus) and the sidebar (lib/agentrows.js) call
// refreshGivenNames() on a timer: whichever asks first reads, the other finds it fresh and skips. Mods that only
// show names read what those two keep, so with both closed the names stay as they last were.
// Also here: a Claude agent's pid and session record (pidOf, readRecord), which agentrows reads for the context
// badge, so both share one pid lookup per terminal.
// Shared lib (herdr-ranch/lib): install.sh copies it into each mod that lists it in lib.json.
import { agents, terminals, exec, home, readTextFile, shared, setShared } from "herdr";
import { accountDirOf } from "./accounts.js";
import { setGivenNames } from "./agentname.js";

const AT = "ranch.given-names.at";
const FRESH = 3000;
const PID_TTL = 15000;
const cache = {}; // address -> { pid, at }: a terminal's foreground process, asked again after PID_TTL
let busy = false;

export const isClaude = (a) => a.app === "claude-code" || a.program?.key === "claude";
// The Claude agents whose records can be read (not a remote "host/…" address).
export const claudeAgents = () => agents().filter((a) => isClaude(a) && typeof a.address === "string" && !a.address.includes("/"));

// Each terminal's account folder (an agent on another account keeps its records there).
export function accountDirs() {
  const dirOf = {};
  try { for (const t of terminals() ?? []) { const d = accountDirOf(t); if (d) dirOf[t.address] = d; } } catch {}
  return dirOf;
}

// The pid in the agent's terminal. A failed `hc get` keeps the pid known before and asks again after RETRY, so
// one slow call does not drop the agent's name and a hanging `hc` is not asked on every refresh; "no foreground
// process" is an answer and is kept.
const RETRY = 5000;
export async function pidOf(address) {
  const p = cache[address];
  if (p && Date.now() - p.at <= PID_TTL) return p.pid;
  let pid;
  // Stamped when the answer came, not when it was asked: a 5 s timeout must not count as an old answer.
  try { pid = JSON.parse((await exec("hc", ["get", address, "--json"], { timeout: 5000 })).stdout)?.foreground?.pid ?? null; }
  catch { pid = p?.pid ?? null; cache[address] = { pid, at: Date.now() - PID_TTL + RETRY }; return pid; }
  cache[address] = { pid, at: Date.now() };
  return pid;
}

// The agent's sessions/<pid>.json, or null when there is none to read.
export async function readRecord(a, pid, dirOf) {
  try { return JSON.parse((await readTextFile(`${dirOf[a.address] ?? `${home()}/.claude`}/sessions/${pid}.json`)) ?? "null"); } catch { return null; }
}

// True when the names changed (the caller redraws).
export async function refreshGivenNames() {
  if (busy || Date.now() - (shared(AT) ?? 0) < FRESH) return false;
  busy = true;
  setShared(AT, Date.now());
  try {
    const list = claudeAgents();
    const live = new Set(list.map((a) => a.address));
    for (const addr of Object.keys(cache)) if (!live.has(addr)) delete cache[addr];
    const dirOf = accountDirs(), names = {};
    for (const a of list) {
      const pid = await pidOf(a.address);
      const rec = pid ? await readRecord(a, pid, dirOf) : null;
      const name = rec?.nameSource === "user" && typeof rec.name === "string" ? rec.name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) : "";
      if (name) names[a.address] = name;
    }
    return setGivenNames(names);
  } finally { busy = false; setShared(AT, Date.now()); }
}
