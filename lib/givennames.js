// Names given with /rename, read from Claude Code's record of each running agent (~/.claude/sessions/<pid>.json,
// or the same in an account's folder: nameSource "user"; "derived" is one it made up). Kept in shared state for
// agentName() (lib/agentname.js). The tab bar (tabs-plus) and the sidebar (lib/agentrows.js) call
// refreshGivenNames() on a timer: whichever asks first reads, the other finds it fresh and skips. Mods that only
// show names read what those two keep, so with both closed the names stay as they last were.
// Also here: a Claude agent's pid and session record (pidOf, readRecord), which agentrows reads for the context
// badge, so both share one pid lookup per terminal.
// A tab renamed in Herdr renames its Claude agent too: the new name is queued (shared PENDING, shown at once by
// agentName()) and typed in as `/rename <name>` once the agent is free and its input box is empty, so nothing it
// is doing and nothing you are typing is touched. /rename runs in Claude Code itself: no turn, no tokens.
// Shared lib (herdr-ranch/lib): install.sh copies it into each mod that lists it in lib.json.
import { agents, spaces, terminals, exec, home, readTextFile, shared, setShared } from "herdr";
import { accountDirOf } from "./accounts.js";
import { setGivenNames, givenNames, PENDING, PROGRAM_NAMES, numberName } from "./agentname.js";

const AT = "ranch.given-names.at";
const TABS = "ranch.tab-names";       // { tab id: name } as last seen, to tell a rename from a tab named at birth
const SENDING = "ranch.rename-sending"; // { at, owner }: the sender at work (null: none)
const TRIES = 3, RESEND = 20000;
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

// True when what a name shows changed (the caller redraws).
export async function refreshGivenNames() {
  if (busy || Date.now() - (shared(AT) ?? 0) < FRESH) return false;
  busy = true;
  setShared(AT, Date.now());
  try {
    const list = claudeAgents();
    const live = new Set(list.map((a) => a.address));
    for (const addr of Object.keys(cache)) if (!live.has(addr)) delete cache[addr];
    // known: agents whose record was read this time. One that could not be read (no pid yet, the file being
    // rewritten) keeps the name it had, and nothing is decided about it.
    const dirOf = accountDirs(), before = givenNames(), names = {}, known = new Set();
    for (const a of list) {
      const pid = await pidOf(a.address);
      const rec = pid ? await readRecord(a, pid, dirOf) : null;
      if (!rec) { if (before[a.address]) names[a.address] = before[a.address]; continue; }
      known.add(a.address);
      const name = rec.nameSource === "user" ? clean(rec.name) : "";
      if (name) names[a.address] = name;
    }
    const changed = setGivenNames(names);
    const queued = queueTabRenames(list, names, known);
    const sent = await sendRenames(names, known);
    return changed || queued || sent;
  } finally { busy = false; setShared(AT, Date.now()); }
}

const clean = (s) => (typeof s === "string" ? s : "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);

// The queue is changed between awaits only: read fresh, changed, written back at once, so the sidebar's and the
// tab bar's copies of this file never write an old copy over each other's change. True when it changed.
function updateQueue(fn) {
  const q = { ...(shared(PENDING) ?? {}) }, was = JSON.stringify(q);
  fn(q);
  if (JSON.stringify(q) === was) return false;
  setShared(PENDING, q);
  return true;
}

// Tabs whose name changed since last seen, with a Claude agent in them: queue that name for the agent. A tab seen
// for the first time only sets the baseline (it was named when it was made, by you or by a mod). A rename whose
// agent can't be told yet (not reporting, its record unread) is looked at again next time.
function queueTabRenames(list, names, known) {
  const before = shared(TABS), now = {}, jobs = [];
  for (const tab of spaces().flatMap((s) => s.tabs ?? [])) {
    const was = before?.[tab.id];
    now[tab.id] = tab.named ? tab.name : null;
    if (!before || !(tab.id in before) || was === now[tab.id] || !tab.named) continue;
    const name = clean(tab.name);
    if (!name || PROGRAM_NAMES.has(name) || numberName(name)) continue;
    const lead = list.find((a) => a.tab === tab.id && a.focused) ?? list.find((a) => a.tab === tab.id);
    if (!lead || !known.has(lead.address)) { now[tab.id] = was; continue; }
    if (names[lead.address] !== name) jobs.push([lead.address, { name, was: names[lead.address] ?? null, tries: 0, sent: 0 }]);
  }
  if (JSON.stringify(before) !== JSON.stringify(now)) setShared(TABS, now);
  return jobs.length > 0 && updateQueue((q) => { for (const [addr, job] of jobs) if (q[addr]?.name !== job.name) q[addr] = job; });
}

// The prompt line right under the input box's top rule, empty: "❯" and nothing after it, or a new session's
// placeholder (`Try "fix lint errors"`, drawn dim; a screen read has no colors to tell it by).
export function inputEmpty(screen) {
  const lines = String(screen ?? "").split("\n");
  for (let i = lines.length - 1; i > 0; i--) {
    if (!/^\s*❯/.test(lines[i]) || !/^\s*─/.test(lines[i - 1])) continue;
    return /^\s*❯\s*(Try "[^"]*")?\s*$/.test(lines[i]);
  }
  return false; // no input box on screen (a dialog, a picker): not now
}

const free = (addr) => { const s = agents().find((x) => x.address === addr)?.status; return s === "idle" || s === "done"; };

// Type the queued names in, one agent at a time, only while it is free and its input box is empty. One sender at
// a time across the mods (SENDING); a stale claim (a sender that died) runs out after 30 s. True when it changed.
async function sendRenames(names, known) {
  const lock = shared(SENDING);
  if (!Object.keys(shared(PENDING) ?? {}).length || (lock?.at && Date.now() - lock.at < 30000)) return false;
  const me = `${Date.now()}.${Math.random()}`;
  setShared(SENDING, { at: Date.now(), owner: me });
  let changed = false;
  try {
    for (const addr of Object.keys(shared(PENDING) ?? {})) {
      const job = shared(PENDING)?.[addr], now = Date.now();
      if (!job) continue;
      const gone = !agents().some((x) => x.address === addr);
      // Judged only on a fresh read: done (Claude Code has the name), renamed some other way meanwhile (/rename
      // typed in), or given up on (the last try had its full RESEND to land).
      const done = known.has(addr) && (names[addr] === job.name || (names[addr] ?? null) !== job.was);
      const spent = job.tries >= TRIES && now - job.sent >= RESEND;
      if (gone || done || spent) { changed = updateQueue((q) => { if (q[addr]?.name === job.name) delete q[addr]; }) || changed; continue; }
      if (job.tries >= TRIES || (job.sent && now - job.sent < RESEND) || !free(addr)) continue;
      const screen = await exec("hc", ["read", addr], { timeout: 5000 }).then((r) => r.stdout).catch(() => null);
      // Looked at again after the await: still queued with this name, still free.
      if (!inputEmpty(screen) || shared(PENDING)?.[addr]?.name !== job.name || !free(addr)) continue;
      updateQueue((q) => { q[addr] = { ...q[addr], tries: q[addr].tries + 1, sent: Date.now() }; });
      // `hc send` itself waits while a person has an unfinished draft, which covers typing that starts between the
      // read above and the send. Without a terminal's identity: from a terminal, `hc send` wraps the text as a
      // message from it (<hc from=…>), which Claude Code takes as a prompt (a turn, tokens), not as /rename.
      await exec("env", ["-u", "HC_TERMINAL_ID", "-u", "HC_SCOPE", "-u", "HC_TERMINAL_SOCKET", "hc", "send", addr, `/rename ${job.name}`], { timeout: 5000 }).catch(() => null);
    }
  } finally { if (shared(SENDING)?.owner === me) setShared(SENDING, null); } // a claim taken over after 30 s is not ours to clear
  return changed;
}
