// More than one Claude Code / Codex login (Orca-style): which account new agents start with, and which account a
// running terminal is on. The registry, the account folders and every change to them belong to lib/accounts.py
// (see its header); this file only reads. Shared lib (herdr-ranch/lib).
import { readTextFile, appHome, exec, openOverlay } from "herdr";

const ENV = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const accountsRoot = () => `${appHome()}/ranch/accounts`;

// "claude" | "codex" | null for an agent kind (knownAgents) or a running agent / program.
export const providerOf = (x) => {
  const key = x?.key ?? x?.program?.key, app = x?.app;
  return key === "claude" || app === "claude-code" ? "claude" : key === "codex" || app === "codex" ? "codex" : null;
};

// The registry as written by accounts.py, checked again here: ids only, folders always under ranch/accounts.
export async function loadAccounts() {
  let raw = {};
  try { raw = JSON.parse((await readTextFile(`${appHome()}/ranch/accounts.json`)) ?? "{}") ?? {}; } catch {}
  const reg = { onSwitch: ["ask", "restart", "leave"].includes(raw.onSwitch) ? raw.onSwitch : "ask" };
  for (const p of Object.keys(ENV)) {
    const ids = (Array.isArray(raw[p]?.accounts) ? raw[p].accounts : []).map((a) => a?.id).filter((id) => typeof id === "string" && ID.test(id));
    reg[p] = { active: ids.includes(raw[p]?.active) ? raw[p].active : "default", ids };
  }
  return reg;
}

// The argv prefix that starts an agent on the active account: [] for the system login.
export const envFor = (reg, provider) => {
  const id = reg?.[provider]?.active;
  return ENV[provider] && id && id !== "default" ? ["env", `${ENV[provider]}=${accountsRoot()}/${id}`] : [];
};

// The account folder a terminal was started with (its argv carries env CLAUDE_CONFIG_DIR=<folder>), or null for
// the system login. Free to ask: terminals() already has every terminal's argv.
export const accountDirOf = (terminal) => {
  const root = accountsRoot() + "/";
  for (const a of terminal?.argv ?? []) {
    if (typeof a !== "string") continue;
    for (const v of Object.values(ENV)) {
      if (!a.startsWith(v + "=")) continue;
      const dir = a.slice(v.length + 1).replace(/\/+$/, "");
      if (dir.startsWith(root) && ID.test(dir.slice(root.length))) return dir;
    }
  }
  return null;
};
export const accountIdOf = (terminal) => accountDirOf(terminal)?.split("/").pop() ?? "default";

// Everything the Accounts dialog and the command bar show (emails and plans, read live from each folder).
// mod: the mod asking (it must list accounts.py in its lib.json).
export async function accountsInfo(mod) {
  const r = await exec("python3", [`${appHome()}/mods/${mod}/accounts.py`, "list"], { timeout: 10000 });
  return JSON.parse(r.stdout);
}
// "you@example.com", or how the system login reads when nothing is added.
export const activeName = (info, provider) => {
  const p = info?.[provider];
  if (!p) return null;
  if (p.active === "default") return p.default?.email ? `${p.default.email} (system default)` : "system default";
  const a = p.accounts.find((x) => x.id === p.active);
  return a?.email ?? a?.id ?? null;
};
// Short names by account id ("default" is never tagged): { claude: { "claude-1a2b3c": "you" }, codex: {...} }.
export const shortNames = (info) => Object.fromEntries(Object.keys(ENV).map((p) => [p, Object.fromEntries((info?.[p]?.accounts ?? []).map((a) => [a.id, a.short]))]));

// Before an agent starts on an added account: link what's shared and bring its .claude.json up to date with the
// person's own (trusted folders, MCP servers), so it never meets a "trust this folder?" it already answered.
export const syncAccounts = (provider) => exec("python3", [`${appHome()}/mods/accounts/accounts.py`, "sync", provider], { timeout: 20000 }).catch(() => null);

export const openAccounts = () => openOverlay({ mod: "accounts", kind: "dialog", width: 640, height: 560, props: {} });
