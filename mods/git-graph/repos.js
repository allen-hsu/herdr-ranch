// Manygit: the repositories under a folder that isn't one itself, after
// github.com/rabeeh-ta/manygit. Pure functions, so the tests run them against
// real folders; graph.js does the exec.
import { READ } from "./git.js";

export const DEPTH = { min: 1, max: 5, default: 3 };
// Never descended into: manygit's list, plus every hidden folder and macOS's
// Library (huge, and nobody keeps repositories there).
const PRUNE = ["node_modules", "vendor", "venv", "__pycache__", "dist", "build", "target", "site-packages", "Library"];

export const depthOf = (value) => (Number.isInteger(value) && value >= DEPTH.min && value <= DEPTH.max ? value : DEPTH.default);

// One `find` walks the whole tree, on this machine or another. A repository
// `depth` folders down has its .git one further. Symlinks aren't followed (-P).
export function findArgs(root, depth) {
  return [root, "-mindepth", "1", "-maxdepth", String(depthOf(depth) + 1),
    "(", "-name", ".git", "-print", "-prune", ")", "-o",
    "(", "-type", "d", "(", "-name", ".*", ...PRUNE.flatMap((n) => ["-o", "-name", n]), ")", "-prune", ")"];
}

// find's output (one .git per line) as repositories, grouped by the folder
// they sit in under root, as manygit does. An unreadable subfolder makes find
// exit 1, so its output counts whatever the exit code.
export function parseFound(root, stdout, max = 500) {
  const base = root.replace(/[/\\]+$/, "");
  const paths = [...new Set(stdout.split("\n").filter((l) => /[/\\]\.git$/.test(l)).map((l) => l.replace(/[/\\]\.git$/, "")))];
  return paths.filter((p) => p.startsWith(base + "/") || p.startsWith(base + "\\")).slice(0, max).map((path) => {
    const rel = path.slice(base.length + 1).replace(/\\/g, "/"), cut = rel.lastIndexOf("/");
    return { path, name: cut < 0 ? rel : rel.slice(cut + 1), group: cut < 0 ? "" : rel.slice(0, cut) };
  }).sort((a, b) => (a.group === b.group ? a.name.localeCompare(b.name) : a.group.localeCompare(b.group)));
}

// Everything a row shows, in one git call: manygit needs six to eight.
export const REPO_STATUS = [...READ, "status", "--porcelain=v2", "--branch", "-z", "--no-renames", "--untracked-files=normal"];

export function parseRepoStatus(stdout) {
  // head: HEAD's hash (null before the first commit); staged: changes already in the index.
  const s = { branch: null, detached: false, head: null, upstream: null, ahead: 0, behind: 0, dirty: 0, staged: 0 };
  for (const rec of stdout.split("\0")) {
    if (!rec) continue;
    if (!rec.startsWith("# ")) { s.dirty++; if (/^[12] [^.]/.test(rec)) s.staged++; continue; }
    const [key, ...rest] = rec.slice(2).split(" "), value = rest.join(" ");
    if (key === "branch.oid") s.head = /^[0-9a-f]{40,64}$/.test(value) ? value : null;
    else if (key === "branch.head") { s.detached = value === "(detached)"; s.branch = s.detached ? null : value; }
    else if (key === "branch.upstream") s.upstream = value;
    else if (key === "branch.ab") {
      const m = /^\+(\d+) -(\d+)$/.exec(value);
      if (m) { s.ahead = +m[1]; s.behind = +m[2]; }
    }
  }
  return s;
}

// A background fetch, as manygit runs it: saved credentials and SSH's own
// configuration still work, but nothing may stop to ask for a login. Git tries
// askpass before GIT_TERMINAL_PROMPT, so an empty GIT_ASKPASS goes with it.
export const FETCH = ["GCM_INTERACTIVE=0", "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=", "git", "fetch", "--quiet"];
// Worth fetching: a repository that has a remote, or isn't read yet.
export const fetchable = (st) => !st || st.error || Boolean(st.upstream || st.hasRemote);

// A repository's remotes and their URLs, for the row's menu (Push, the web page).
export const REMOTES = [...READ, "config", "--get-regexp", "^remote\\..*\\.url$"];
export function parseRemotes(stdout) {
  return stdout.split("\n").map((l) => /^remote\.(.+)\.url (.+)$/.exec(l.trim())).filter(Boolean).map((m) => ({ name: m[1], url: m[2] }));
}

// A remote's page in the browser: https as it is, and scp-style or ssh:// URLs
// (git@github.com:owner/repo.git) on their host. Anything else (a path) has none.
export function webUrl(url) {
  const ssh = /^(?:ssh:\/\/)?(?:[^@/]+@)?([^:/]+)[:/](?!\/)(.+?)(?:\.git)?\/?$/.exec(url);
  if (/^https?:\/\//.test(url)) return url.replace(/^(https?:\/\/)[^@/]+@/, "$1").replace(/\.git\/?$/, "");
  if (ssh && !url.startsWith("/") && !url.startsWith("file:")) return `https://${ssh[1]}/${ssh[2]}`;
  return null;
}

// The newest tag (by creation date), as manygit's `t` shows: only read while Show tags is on.
export const LATEST_TAG = [...READ, "for-each-ref", "--count=1", "--sort=-creatordate", "--format=%(refname:short)", "refs/tags"];

// What a row says of its upstream (manygit's states; drawn in Herdr's colors).
export function syncOf(st, fetchError) {
  if (!st) return { kind: "loading", text: "…" };
  if (fetchError) return { kind: "error", text: "fetch failed" };
  if (st.error) return { kind: "error", text: "!" };
  if (!st.upstream) return st.hasRemote ? { kind: "unpushed", text: "!" } : { kind: "local", text: "no remote" };
  if (st.ahead && st.behind) return { kind: "diverged", text: `↑${st.ahead} ↓${st.behind}` };
  if (st.ahead) return { kind: "ahead", text: `↑${st.ahead}` };
  if (st.behind) return { kind: "behind", text: `↓${st.behind}` };
  return { kind: "ok", text: "✓" };
}
