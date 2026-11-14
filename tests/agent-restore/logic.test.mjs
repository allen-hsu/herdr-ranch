// node tests/agent-restore/logic.test.mjs
import { parseCore, sameCore, record, classify, resumeLine, shq } from "../../mods/agent-restore/logic.js";

const S = "11111111-2222-4333-8444-555555555555";
const now = { pid: 900, start: 1794620000 }, before = "501.1794500000", same = "900.1794620030";
const t = (address, core, extra = {}, labels = {}) => ({ address, state: "live", program: { shell: true, agent: false },
  labels: { "ranch.agent": "claude", "ranch.session": S, "ranch.cwd": "/work/shop", "ranch.core": core, ...labels }, ...extra });
const agent = { program: { shell: false, agent: true }, status: "idle" };
const c = classify([
  t("t1", before),                                   // lost to a restart
  t("t2", same),                                     // ended under this run
  t("t3", before, agent),                            // alive, record from an earlier run
  t("t4", same, agent),                              // alive and current
  t("t5", before, { program: { shell: false, agent: false } }), // something else runs there (vim): wait
  t("box/t6", before),                               // another machine
  t("t7", before, {}, { "ranch.session": "nope" }),  // not a session id
  t("t8", before, {}, { "ranch.agent": "bash" }),    // not an agent we resume
  { address: "t9", state: "live", program: { shell: true } }, // no labels
], now);
const ids = (xs) => xs.map((x) => x.address).join(",");
const checks = {
  "core: parsed, and compared with slack": parseCore(same)?.pid === 900 && sameCore(parseCore(same), now) && !sameCore(parseCore(before), now) && parseCore("x") === null,
  "restore: only the shell left behind by an earlier run": ids(c.restore) === "t1",
  "stale: the agent that ended under this run": ids(c.stale) === "t2",
  "restamp: the live agent with an old record": ids(c.restamp) === "t3",
  "alive: both live agents": ids(c.alive) === "t3,t4",
  "nothing is done while the core is unknown": classify([t("t1", before)], null).restore.length === 0,
  "a record keeps a checked folder and title": record(t("t1", before, {}, { "ranch.title": "Fix cart" })).title === "Fix cart" && record(t("t1", before, {}, { "ranch.cwd": "relative/x" })).cwd === null,
  "claude line": resumeLine(record(t("t1", before))) === `cd -- '/work/shop' && claude --resume ${S}`,
  "claude line on an added account": resumeLine(record(t("t1", before)), ["env", "CLAUDE_CONFIG_DIR=/a b/acct"]) === `cd -- '/work/shop' && env 'CLAUDE_CONFIG_DIR=/a b/acct' claude --resume ${S}`,
  "codex line with Herdr's own command": resumeLine(record(t("t1", before, {}, { "ranch.agent": "codex" })), [], ["codex", "--no-daemon"]) === `cd -- '/work/shop' && codex --no-daemon resume ${S}`,
  "a folder with a quote is quoted whole": resumeLine(record(t("t1", before, {}, { "ranch.cwd": "/work/it's; rm -rf ~" }))) === `cd -- '/work/it'\\''s; rm -rf ~' && claude --resume ${S}`,
  "no folder: no cd": resumeLine(record(t("t1", before, {}, { "ranch.cwd": "" }))) === `claude --resume ${S}`,
  "shq": shq("a'b") === `'a'\\''b'`,
};
let bad = 0;
for (const [k, ok] of Object.entries(checks)) { console.log((ok ? "ok   " : "FAIL ") + k); if (!ok) bad++; }
process.exit(bad ? 1 : 0);
