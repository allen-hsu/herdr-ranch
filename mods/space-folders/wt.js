// herdr-extensions: worktree engine shared by the sidebar's New / Delete / Clean up dialogs.
// Worktrees go where Herdr's own worktree mod puts them: ~/.herdr/worktrees/<repo>/<branch, slugged>.
// After creating one it copies the main checkout's .worktreeinclude files (Orca's format: literal gitignored
// paths, one per line, # comments; globs and negations skipped) and links orca.yaml's
// worktree.sharedDirectories. Every git call is an argument list (no shell); branch names are checked first.
import { exec, home, readTextFile } from "herdr";

const git = (dir, args, on, timeout = 60000) => exec("git", ["-C", dir, ...args], { on, timeout });
export const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
export const repoName = (root) => root.replace(/\/+$/, "").split("/").pop();

export async function validBranch(root, name, on) {
  if (typeof name !== "string" || !name.trim() || name.startsWith("-") || name.length > 200) return false;
  return (await git(root, ["check-ref-format", "--branch", name], on, 5000)).code === 0;
}

// The main checkout (not a linked worktree) of the repository that holds `dir`.
export async function mainRoot(dir, on) {
  const r = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on, 5000);
  const common = r.code === 0 ? r.stdout.trim() : "";
  return common.endsWith("/.git") ? common.slice(0, -5) : null;
}

export async function defaultBase(root, on) {
  const s = await git(root, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], on, 5000);
  if (s.code === 0 && s.stdout.trim()) return s.stdout.trim();
  for (const b of ["main", "master"]) if ((await git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${b}`], on, 5000)).code === 0) return b;
  return "HEAD";
}

export async function branches(root, on) {
  const r = await git(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads", "refs/remotes"], on, 10000);
  return r.code === 0 ? r.stdout.split("\n").filter((b) => b && !/\/HEAD$/.test(b)) : [];
}

// .worktreeinclude: literal relative paths only.
function includeList(text) {
  return String(text ?? "").split("\n").map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!") && !/[*?[\]]/.test(l) && !l.startsWith("/") && !l.split("/").includes(".."));
}

// orca.yaml → worktree.sharedDirectories (a tiny reader for that one list).
function sharedDirs(text) {
  const out = []; let inWt = false, inList = false;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(/#.*$/, "");
    if (/^worktree:\s*$/.test(line)) { inWt = true; inList = false; continue; }
    if (/^\S/.test(line)) { inWt = false; inList = false; continue; }
    if (inWt && /^\s+sharedDirectories:\s*$/.test(line)) { inList = true; continue; }
    const m = inList && /^\s+-\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (m && !m[1].startsWith("/") && !m[1].split("/").includes("..")) out.push(m[1].replace(/\/+$/, ""));
  }
  return out;
}

// Copy .worktreeinclude files (APFS clone on macOS) and link sharedDirectories. Returns what it did.
export async function prepare(root, path, on) {
  const done = { copied: [], linked: [], missing: [] };
  const inc = includeList(await readTextFile(`${root}/.worktreeinclude`, { on }).catch(() => null));
  for (const rel of inc) {
    const src = `${root}/${rel}`, dst = `${path}/${rel}`;
    if ((await exec("test", ["-e", src], { on })).code !== 0) { done.missing.push(rel); continue; }
    if ((await exec("test", ["-e", dst], { on })).code === 0) continue;
    await exec("mkdir", ["-p", dst.replace(/\/[^/]+$/, "")], { on });
    let r = await exec("cp", ["-Rpc", src, dst], { on });
    if (r.code !== 0) r = await exec("cp", ["-Rp", src, dst], { on });
    if (r.code === 0) done.copied.push(rel);
  }
  for (const rel of sharedDirs(await readTextFile(`${root}/orca.yaml`, { on }).catch(() => null))) {
    const src = `${root}/${rel}`, dst = `${path}/${rel}`;
    if ((await exec("test", ["-d", src], { on })).code !== 0 || (await exec("test", ["-e", dst], { on })).code === 0) continue;
    await exec("mkdir", ["-p", dst.replace(/\/[^/]+$/, "")], { on });
    if ((await exec("ln", ["-s", src, dst], { on })).code === 0) done.linked.push(rel);
  }
  return done;
}

// Create a worktree for `branch`. from: { base } for a new branch off base, { pr, head } for a same-repo PR
// (head = its branch), or { existing: true } for a branch that already exists (local or origin/<branch>).
export async function create(root, branch, from, on) {
  if (!(await validBranch(root, branch, on))) throw new Error(`Not a valid branch name: ${branch}`);
  const path = `${home()}/.herdr/worktrees/${slug(repoName(root))}/${slug(branch)}`;
  if ((await exec("test", ["-e", path], { on })).code === 0) throw new Error(`${path.replace(home(), "~")} already exists`);
  await git(root, ["fetch", "--quiet", "origin"], on).catch(() => null);
  const hasLocal = (await git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], on, 5000)).code === 0;
  let args;
  if (from.pr) {
    if (!(await validBranch(root, from.head, on))) throw new Error("Invalid PR branch");
    args = hasLocal ? ["worktree", "add", "--", path, branch] : ["worktree", "add", "--track", "-b", branch, "--", path, `origin/${from.head}`];
  } else if (from.existing || hasLocal) {
    const remote = (await git(root, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], on, 5000)).code === 0;
    args = hasLocal ? ["worktree", "add", "--", path, branch] : remote ? ["worktree", "add", "--track", "-b", branch, "--", path, `origin/${branch}`] : null;
    if (!args) throw new Error(`No branch ${branch} here or on origin`);
  } else {
    const base = from.base || "HEAD";
    if (base.startsWith("-")) throw new Error("Invalid base");
    args = ["worktree", "add", "--no-track", "-b", branch, "--", path, base];
  }
  const r = await git(root, args, on);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || "git worktree add failed");
  const prep = await prepare(root, path, on);
  return { path, prep };
}

// What deleting a worktree would lose: uncommitted changes, commits not on origin or on the base branch.
export async function inspect(path, on) {
  const st = await git(path, ["--no-optional-locks", "status", "--porcelain=v2", "--branch"], on, 15000);
  const exists = st.code === 0;
  const lines = exists ? st.stdout.split("\n") : [];
  const branch = lines.find((l) => l.startsWith("# branch.head "))?.slice(14) ?? null;
  const dirty = lines.filter((l) => /^(1|2|u|\?) /.test(l)).length;
  let unpushed = 0, unmerged = 0;
  if (exists && branch && branch !== "(detached)") {
    const up = await git(path, ["rev-list", "--count", "@{upstream}..HEAD"], on, 10000);
    unpushed = up.code === 0 ? Number(up.stdout.trim()) || 0 : -1; // -1: no upstream
    const root = await mainRoot(path, on);
    const base = root ? await defaultBase(root, on) : null;
    if (base) { const m = await git(path, ["rev-list", "--count", `${base}..HEAD`], on, 10000); unmerged = m.code === 0 ? Number(m.stdout.trim()) || 0 : 0; }
  }
  const last = exists ? (await git(path, ["log", "-1", "--format=%ct"], on, 5000)).stdout.trim() : "";
  const du = await exec("du", ["-sk", path], { on, timeout: 20000 }).catch(() => null);
  return { exists, branch, dirty, unpushed, unmerged, last: Number(last) || null, kb: du?.code === 0 ? Number(du.stdout.split(/\s/)[0]) || null : null };
}

// Remove the worktree (force only when asked) and then its branch (-d, or -D when asked).
export async function remove(root, path, branch, { force = false, deleteBranch = true, forceBranch = false } = {}, on) {
  const r = await git(root, ["worktree", "remove", ...(force ? ["--force"] : []), "--", path], on);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || "git worktree remove failed");
  if (deleteBranch && branch && (await validBranch(root, branch, on))) {
    const b = await git(root, ["branch", forceBranch ? "-D" : "-d", "--", branch], on, 10000);
    if (b.code !== 0) return { branchKept: b.stderr.trim().split("\n").pop() };
  }
  return {};
}

// Every linked worktree of the repo: { path, branch, prunable }.
export async function list(root, on) {
  const r = await git(root, ["worktree", "list", "--porcelain"], on, 15000);
  const out = []; let cur = null;
  for (const line of (r.code === 0 ? r.stdout : "").split("\n")) {
    if (line.startsWith("worktree ")) { cur = { path: line.slice(9), branch: null, prunable: false }; out.push(cur); }
    else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (cur && line.startsWith("prunable")) cur.prunable = true;
  }
  return out.slice(1); // the first entry is the main checkout
}

export const prune = (root, on) => git(root, ["worktree", "prune"], on, 15000);
