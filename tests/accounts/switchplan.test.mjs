// node tests/accounts/switchplan.test.mjs: lib/accountswitch.js against a stand-in Herdr API (no terminal is touched).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const lib = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "lib");
const dir = mkdtempSync(join(tmpdir(), "switchplan-"));
for (const f of ["accountswitch.js", "accounts.js", "agentname.js"]) writeFileSync(join(dir, f), readFileSync(join(lib, f), "utf8").replaceAll('from "herdr"', 'from "./herdr.mjs"'));
writeFileSync(join(dir, "herdr.mjs"), `
const S = "11111111-2222-4333-8444-5555555555";
export const calls = [];
const prog = { key: "claude", name: "Claude Code", shell: false, agent: true };
export const agents = () => [
  { address: "t1", status: "idle", program: prog, space: "s1", space_name: "app", tab: "b1", pane: "p1", title: "Fix cart" },
  { address: "t2", status: "working", program: prog, space: "s1", space_name: "app", tab: "b2", pane: "p2", title: "Busy one" },
];
export const panes = () => [
  { pane: "p1", terminal: "t1", tab: "b1", program: prog, title: "Fix cart" },
  { pane: "p2", terminal: "t2", tab: "b2", program: prog, title: "Busy one" },
  { pane: "p3", terminal: "t3", tab: "b3", program: { ...prog, agent: false }, title: "Silent one" },
];
export const spaces = () => [{ id: "s1", name: "app", tabs: [{ id: "b1", name: "Claude Code", named: true }, { id: "b2", name: "Mine", named: true }, { id: "b3", name: "3", named: false }] }];
export const focused = () => null;
export const appHome = () => "/app";
export const exec = async (cmd, args) => {
  if (args?.includes("agents")) return { stdout: JSON.stringify(Object.fromEntries(["t1", "t2", "t3"].map((a, i) => [a, { account: "default", session: S + "0" + i, cwd: "/work/" + a, background: 0 }]))) };
  return { stdout: "{}" };
};
export const run = (c, a) => { calls.push([c, a]); };
const sh = {}; export const shared = (k) => sh[k]; export const setShared = (k, v) => { sh[k] = v; };
export const readTextFile = async () => null; export const openOverlay = () => null;
`);
const { switchPlan, restartAgents } = await import(join(dir, "accountswitch.js"));
const { calls } = await import(join(dir, "herdr.mjs"));
const plan = await switchPlan("claude", "acct");
const by = Object.fromEntries(plan.map((x) => [x.address, x]));
const moved = await restartAgents("claude", ["env", "CLAUDE_CONFIG_DIR=/a"], plan.filter((x) => x.on && !x.skip));
const newTabs = calls.filter(([c]) => c === "tab.new").map(([, a]) => a);
const checks = {
  "every agent is in the plan, the silent one included": plan.length === 3 && by.t3?.silent === true,
  "an idle agent carries what a restart needs": by.t1?.session?.endsWith("00") && by.t1?.cwd === "/work/t1" && by.t1?.on === true && !by.t1?.skip,
  "a working agent waits": by.t2?.skip === "working" && by.t2?.later === true,
  "a silent agent is offered unticked": by.t3?.on === false && !by.t3?.skip,
  "a tab you named keeps its name, a program name is dropped": by.t2?.tabName === "Mine" && by.t1?.tabName === undefined,
  "restart moves the idle one only": moved.join() === "t1" && newTabs.length === 1,
  "it resumes on the new account": JSON.stringify(newTabs[0]?.argv) === JSON.stringify(["env", "CLAUDE_CONFIG_DIR=/a", "claude", "--resume", by.t1?.session]) && newTabs[0]?.folder === "/work/t1",
  "the old tab is closed": calls.some(([c, a]) => c === "tab.close" && a.id === "b1"),
  "a ticked silent one is restarted too": (await restartAgents("claude", [], [{ ...by.t3, on: true }])).join() === "t3",
};
let bad = 0;
for (const [k, ok] of Object.entries(checks)) { console.log((ok ? "ok   " : "FAIL ") + k); if (!ok) bad++; }
process.exit(bad ? 1 : 0);
