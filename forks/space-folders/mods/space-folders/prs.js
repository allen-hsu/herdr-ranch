// herdr-extensions: open pull requests per GitHub repository, keyed by head branch, for the PR badge on
// space rows. Uses the person's own `gh` sign-in: one GraphQL query per repository, at most every 2 minutes.
// Clicking a badge asks a PR panel to reveal it (shared "pr-panel.reveal") when one is listening, else opens
// it on GitHub. Same contract as the git-graph fork's prs.js.
import { exec, shared, setShared } from "herdr";

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
const TTL = 120000;

export class PRCache {
  constructor() { this.slugs = new Map(); this.repos = new Map(); this.busy = new Set(); }

  // owner/name of the repository whose git dir is `gitDir` (null: not GitHub), asked once per repo.
  async slug(gitDir, on) {
    const key = JSON.stringify([on ?? null, gitDir]);
    if (this.slugs.has(key)) return this.slugs.get(key);
    const r = await exec("git", ["--git-dir", gitDir, "remote", "get-url", "origin"], { on, timeout: 5000 }).catch(() => null);
    const m = r?.code === 0 && /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\s*$/.exec(r.stdout.trim());
    const slug = m ? `${m[1]}/${m[2]}` : null;
    this.slugs.set(key, slug);
    return slug;
  }

  // The PR for branch in repo, or null; starts a (throttled) load and calls done() when new data lands.
  get(slug, branch, on, done) {
    if (!slug || !branch) return null;
    const entry = this.repos.get(slug);
    if ((!entry || Date.now() - entry.at > TTL) && !this.busy.has(slug)) this.load(slug, on, done);
    return entry?.byBranch.get(branch) ?? null;
  }

  async load(slug, on, done) {
    this.busy.add(slug);
    try {
      const [owner, name] = slug.split("/");
      const r = await exec("gh", ["api", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`], { on, timeout: 20000 }).catch(() => null);
      const byBranch = new Map();
      if (r?.code === 0) {
        let nodes = [];
        try { nodes = JSON.parse(r.stdout)?.data?.repository?.pullRequests?.nodes ?? []; } catch {}
        for (const n of nodes) {
          if (!n || n.isCrossRepository || byBranch.has(n.headRefName)) continue;
          byBranch.set(n.headRefName, { number: n.number, title: n.title, url: n.url, draft: n.isDraft, review: n.reviewDecision,
            checks: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null, repo: slug });
        }
      }
      this.repos.set(slug, { at: Date.now(), byBranch });
      done?.();
    } finally { this.busy.delete(slug); }
  }
}

export function prColor(pr, t) {
  if (pr.draft) return t.dim;
  const c = pr.checks;
  return c === "SUCCESS" ? t.done : c === "FAILURE" || c === "ERROR" ? t.blocked : c ? t.working : t.muted;
}

export function prTip(pr) {
  const c = pr.checks;
  const checks = c === "SUCCESS" ? "checks passed" : c === "FAILURE" || c === "ERROR" ? "checks failing" : c ? "checks running" : "no checks";
  const review = pr.review === "APPROVED" ? " · approved" : pr.review === "CHANGES_REQUESTED" ? " · changes requested" : "";
  return `#${pr.number} ${pr.title}${pr.draft ? " (draft)" : ""} — ${checks}${review}`;
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
