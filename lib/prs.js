// Open pull requests of a GitHub repository, keyed by head branch, for PR badges (git-graph branch labels,
// space-folders rows). Uses the person's own `gh` sign-in: one GraphQL query per repository, at most every
// TTL; nothing when the origin isn't GitHub or gh is missing. Same-repository PRs only (a fork's branch name
// can collide with a local one); the most recently updated PR wins a name.
// Clicking a badge asks a PR panel to reveal it (shared "pr-panel.reveal") when one is listening
// ("pr-panel.listening", refreshed at least every minute), else opens it on GitHub.
// Shared lib (herdr-ranch/lib): install.sh copies it into each mod that lists it in lib.json.
import { exec, shared, setShared } from "herdr";
import { C } from "./ui.js";

const QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title url isDraft headRefName isCrossRepository reviewDecision
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;
export const TTL = 120000;
const SLUG = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\s*$/;

// owner/name from the origin remote ({ dir } = a work tree, { gitDir } = a git dir), or null.
export async function repoSlug(where, on) {
  const args = typeof where === "string" ? ["-C", where] : where.gitDir ? ["--git-dir", where.gitDir] : ["-C", where.dir];
  const r = await exec("git", [...args, "remote", "get-url", "origin"], { on, timeout: 5000 }).catch(() => null);
  const m = r?.code === 0 && SLUG.exec(r.stdout.trim());
  return m ? { owner: m[1], name: m[2] } : null;
}

// Map head branch -> { number, title, url, draft, checks, review, repo } for "owner/name".
export async function fetchPRs(slug, on) {
  const [owner, name] = slug.split("/");
  const r = await exec("gh", ["api", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`], { on, timeout: 20000 }).catch(() => null);
  const byBranch = new Map();
  if (!r || r.code !== 0) return { byBranch, error: "gh" };
  let nodes = [];
  try { nodes = JSON.parse(r.stdout)?.data?.repository?.pullRequests?.nodes ?? []; } catch {}
  for (const n of nodes) {
    if (!n || n.isCrossRepository || byBranch.has(n.headRefName)) continue;
    byBranch.set(n.headRefName, { number: n.number, title: n.title, url: n.url, draft: n.isDraft, review: n.reviewDecision,
      checks: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null, repo: slug });
  }
  return { byBranch };
}

// One repository by work tree: { slug: {owner,name} | null, byBranch, error? }.
export async function loadPRs(root, on) {
  const slug = await repoSlug(root, on);
  if (!slug) return { slug: null, byBranch: new Map() };
  return { slug, ...(await fetchPRs(`${slug.owner}/${slug.name}`, on)) };
}

// Many repositories, cached: slug(gitDir) once per repo, get(slug, branch) throttled to TTL, done() on new data.
export class PRCache {
  constructor() { this.slugs = new Map(); this.repos = new Map(); this.busy = new Set(); }
  async slug(gitDir, on) {
    const key = JSON.stringify([on ?? null, gitDir]);
    if (!this.slugs.has(key)) { const s = await repoSlug({ gitDir }, on); this.slugs.set(key, s ? `${s.owner}/${s.name}` : null); }
    return this.slugs.get(key);
  }
  get(slug, branch, on, done) {
    if (!slug || !branch) return null;
    const entry = this.repos.get(slug);
    if ((!entry || Date.now() - entry.at > TTL) && !this.busy.has(slug)) this.load(slug, on, done);
    return entry?.byBranch.get(branch) ?? null;
  }
  async load(slug, on, done) {
    this.busy.add(slug);
    try { this.repos.set(slug, { at: Date.now(), byBranch: (await fetchPRs(slug, on)).byBranch }); done?.(); }
    finally { this.busy.delete(slug); }
  }
}

// The PR for a git-graph label part: a local branch by name, a remote branch by the name after "<remote>/".
export function prForPart(part, byBranch) {
  if (!byBranch?.size) return null;
  if (part.kind === "branch") return byBranch.get(part.name) ?? null;
  if (part.kind === "remote") return byBranch.get(part.name.slice(part.name.indexOf("/") + 1)) ?? null;
  return null;
}

export function prColor(pr, t) {
  if (pr.draft) return t.dim;
  const c = pr.checks, st = C(t).status;
  return c === "SUCCESS" ? st.done : c === "FAILURE" || c === "ERROR" ? st.blocked : c ? st.working : t.muted;
}

export function prTip(pr) {
  const c = pr.checks;
  const checks = c === "SUCCESS" ? "checks passed" : c === "FAILURE" || c === "ERROR" ? "checks failing" : c ? "checks running" : "no checks";
  const review = pr.review === "APPROVED" ? " · approved" : pr.review === "CHANGES_REQUESTED" ? " · changes requested" : "";
  return `#${pr.number} ${pr.title}${pr.draft ? " (draft)" : ""} — ${checks}${review}`;
}

export function badgeOf(pr, t) {
  const c = pr.checks, st = C(t).status;
  const [glyph, color] = c === "SUCCESS" ? ["✓", st.done] : c === "FAILURE" || c === "ERROR" ? ["✗", st.blocked] : c ? ["●", st.working] : ["", t.dim];
  const review = pr.review === "APPROVED" ? "approved" : pr.review === "CHANGES_REQUESTED" ? "changes" : "";
  return { text: `#${pr.number}`, glyph, color: pr.draft ? t.dim : color, review, tip: `#${pr.number} ${pr.title}${pr.draft ? " (draft)" : ""}` };
}

export function revealPR(pr, cx) {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(pr?.url ?? "")) return;
  if (Date.now() - (Number(shared("pr-panel.listening")) || 0) < 3 * 60000) {
    setShared("pr-panel.reveal", { repo: pr.repo, number: pr.number, url: pr.url, at: Date.now() });
    return;
  }
  if (cx?.open_url) cx.open_url(pr.url);
  else exec("open", [pr.url]);
}
