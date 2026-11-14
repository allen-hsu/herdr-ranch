// Pure logic of agent-restore (no Herdr imports, so tests/agent-restore/logic.test.mjs can run it in node).
// A terminal carries what integrations/agent-restore/session-hook.py wrote on it (see that file):
//   ranch.agent, ranch.session, ranch.cwd, ranch.core, and ranch.title (kept by the mod: the agent's name).
export const KEYS = ["ranch.agent", "ranch.session", "ranch.cwd", "ranch.core", "ranch.title"];
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ADDRESS = /^[A-Za-z0-9_-]{1,32}$/; // this computer's terminals only (a remote one is "machine/t7")
const printable = (s) => typeof s === "string" && !/[\u0000-\u001f\u007f]/.test(s);

// "<pid>.<start, unix seconds>" -> { pid, start }, or null.
export function parseCore(s) {
  const m = /^(\d{1,10})\.(\d{6,12})$/.exec(String(s ?? ""));
  return m ? { pid: Number(m[1]), start: Number(m[2]) } : null;
}
// The same run of herdr-core: same pid, started at the same time (the start is worked out from an uptime, so
// two readings of one run can differ by a few seconds).
export const sameCore = (a, b) => Boolean(a && b) && a.pid === b.pid && Math.abs(a.start - b.start) <= 120;

// What a labelled terminal says, checked: null when it carries no usable record.
// alive: an agent is running in it now. atShell: its shell is in front, waiting.
export function record(t) {
  const l = t?.labels;
  if (!l || typeof l !== "object" || typeof t.address !== "string" || !ADDRESS.test(t.address)) return null;
  const provider = l["ranch.agent"], session = l["ranch.session"], cwd = l["ranch.cwd"];
  if (provider !== "claude" && provider !== "codex") return null;
  if (typeof session !== "string" || !UUID.test(session)) return null;
  if (t.state && t.state !== "live") return null;
  const p = t.program ?? {};
  const alive = Boolean(p.agent) || Boolean(t.status); // terminals(): program { shell, agent }, status a word or null
  return { address: t.address, provider, session,
    cwd: printable(cwd) && cwd.startsWith("/") && cwd.length < 1024 ? cwd : null,
    title: printable(l["ranch.title"]) ? l["ranch.title"].slice(0, 80) : null,
    core: parseCore(l["ranch.core"]), alive, atShell: !alive && p.shell === true };
}

// Sort the labelled terminals by what to do about them under the core run `core`:
//   restore  the agent is gone, its shell waits, and the record is from an earlier run: lost to a restart
//   stale    the agent is gone under this same run: it ended by itself or was closed, nothing to offer
//   restamp  the agent is alive but its record names an earlier run (the core was restarted under it)
export function classify(list, core) {
  const out = { restore: [], stale: [], restamp: [], alive: [] };
  if (!core) return out;
  for (const t of list ?? []) {
    const r = record(t);
    if (!r) continue;
    if (r.alive) { out.alive.push(r); if (!sameCore(r.core, core)) out.restamp.push(r); }
    else if (r.atShell) (sameCore(r.core, core) ? out.stale : out.restore).push(r);
  }
  return out;
}

// A word for a POSIX shell, single-quoted.
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The line typed into the waiting shell. env: ["env", "CLAUDE_CONFIG_DIR=<dir>"] for an added account, [] for
// the system login. cmd: how Herdr starts that agent (["claude"], ["codex", "--no-daemon"]).
export function resumeLine(r, env = [], cmd = null) {
  if (!r || !UUID.test(r.session)) return null;
  const base = Array.isArray(cmd) && cmd.length && cmd.every((x) => typeof x === "string" && printable(x)) ? cmd : [r.provider];
  const words = [...(env.length ? ["env", ...env.filter((x) => x !== "env")] : []), ...base, ...(r.provider === "claude" ? ["--resume", r.session] : ["resume", r.session])];
  const line = words.map((w) => (/^[A-Za-z0-9_./=:@%+-]+$/.test(w) ? w : shq(w))).join(" ");
  return r.cwd ? `cd -- ${shq(r.cwd)} && ${line}` : line;
}
