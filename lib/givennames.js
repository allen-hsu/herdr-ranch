// Names given with /rename, read from Claude Code's record of each running agent (~/.claude/sessions/<pid>.json,
// or the same in an account's folder: nameSource "user"; "derived" is one it made up). Kept in shared state for
// agentName() (lib/agentname.js). Every mod that shows names calls refreshGivenNames() on a timer: whichever
// asks first reads, the others find it fresh and skip, so the names stay current while any of them is shown.
// Shared lib (herdr-ranch/lib): install.sh copies it into each mod that lists it in lib.json.
import { agents, terminals, exec, home, readTextFile, shared, setShared } from "herdr";
import { accountDirOf } from "./accounts.js";
import { setGivenNames } from "./agentname.js";

const AT = "ranch.given-names.at";
const FRESH = 3000;
const pidOf = {}; // address -> { pid, at }: a terminal's foreground process, asked again after 15 s
let busy = false;

const isClaude = (a) => a.app === "claude-code" || a.program?.key === "claude";

// True when the names changed (the caller redraws).
export async function refreshGivenNames(now = Date.now()) {
  if (busy || now - (shared(AT) ?? 0) < FRESH) return false;
  busy = true;
  setShared(AT, now);
  try {
    const dirOf = {};
    try { for (const t of terminals() ?? []) { const d = accountDirOf(t); if (d) dirOf[t.address] = d; } } catch {}
    const names = {};
    for (const a of agents().filter((a) => isClaude(a) && !a.address.includes("/"))) {
      let p = pidOf[a.address];
      if (!p || now - p.at > 15000) {
        try { p = { pid: JSON.parse((await exec("hc", ["get", a.address, "--json"], { timeout: 5000 })).stdout)?.foreground?.pid ?? null, at: now }; }
        catch { p = { pid: null, at: now }; }
        pidOf[a.address] = p;
      }
      if (!p.pid) continue;
      let rec = null;
      try { rec = JSON.parse((await readTextFile(`${dirOf[a.address] ?? `${home()}/.claude`}/sessions/${p.pid}.json`)) ?? "{}"); } catch {}
      const name = rec?.nameSource === "user" && typeof rec.name === "string" ? rec.name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) : "";
      if (name) names[a.address] = name;
    }
    return setGivenNames(names);
  } finally { busy = false; }
}
