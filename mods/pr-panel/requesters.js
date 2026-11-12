// Pluggable "request review" buttons. The panel knows nothing about Slack or any other service:
// buttons come from ~/.config/herdr-app/pr-panel.json, e.g.
//   { "requesters": [ { "id": "slack-bot", "label": "Ask reviewer bot", "type": "command", "confirm": true,
//                       "argv": ["python3", "~/.config/herdr-app/ranch/requesters/slack-post.py"] } ] }
// type "command": runs argv (no shell) with the PR in env vars HERDR_PR_URL, HERDR_PR_REPO,
// HERDR_PR_NUMBER, HERDR_PR_TITLE, HERDR_PR_BRANCH. Optional JSON on stdout:
// {"ok": bool, "message"?, "error"?, "hint"?}. Non-JSON output: exit code decides.
// No config file (or no requesters) = no buttons.
import { exec, home, appHome, readTextFile } from "herdr";

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export async function loadRequesters() {
  let raw;
  try { raw = await readTextFile(appHome() + "/pr-panel.json"); } catch { raw = null; }
  if (!raw) return { list: [], error: null };
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) { return { list: [], error: "pr-panel.json is not valid JSON" }; }
  const list = [];
  for (const r of Array.isArray(cfg.requesters) ? cfg.requesters : []) {
    if (!r || !ID.test(r.id ?? "") || typeof r.label !== "string" || r.type !== "command") continue;
    if (!Array.isArray(r.argv) || !r.argv.length || !r.argv.every((a) => typeof a === "string")) continue;
    list.push({ id: r.id, label: r.label.slice(0, 40), confirm: r.confirm !== false, tip: typeof r.tip === "string" ? r.tip : null,
                argv: r.argv.map((a) => (a.startsWith("~/") ? home() + a.slice(1) : a)),
                timeout: Number.isFinite(r.timeout) ? Math.min(r.timeout, 120000) : 30000 });
  }
  return { list, error: null };
}

export async function runRequester(req, pr) {
  const env = {
    HERDR_PR_URL: pr.url, HERDR_PR_REPO: pr.repository.nameWithOwner, HERDR_PR_NUMBER: String(pr.number),
    HERDR_PR_TITLE: pr.title, HERDR_PR_BRANCH: pr.headRefName ?? "",
  };
  // `env NAME=value … argv` sets the variables and execs argv directly (no shell, no interpolation).
  const r = await exec("env", [...Object.entries(env).map(([k, v]) => `${k}=${v.replace(/[\r\n]+/g, " ")}`), ...req.argv], { timeout: req.timeout });
  let res = null;
  try { res = JSON.parse(r.stdout.trim().split("\n").pop() || "null"); } catch {}
  if (res && typeof res.ok === "boolean") return res;
  return r.code === 0 ? { ok: true, message: r.stdout.trim().slice(0, 200) || null }
                      : { ok: false, error: (r.stderr || r.stdout || `exit ${r.code}`).trim().split("\n").filter((l) => !/GVM|FakeAssoc/.test(l)).pop()?.slice(0, 200) };
}
