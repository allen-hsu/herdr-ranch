// herdr-extensions: open pull requests of the repository on GitHub, keyed by head branch, so branch labels
// and the branch picker can show "#123 ✓". Uses the person's own `gh` sign-in (one GraphQL query per
// repository, refreshed every 2 minutes); nothing when the origin isn't GitHub or gh is missing.
// Clicking a badge asks a PR panel to reveal it (shared "pr-panel.reveal"), else opens it on GitHub.
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
export const TTL = 120000;

// owner/name from the origin remote, or null when it isn't GitHub.
export async function repoSlug(root, on) {
  const r = await exec("git", ["-C", root, "remote", "get-url", "origin"], { on, timeout: 5000 }).catch(() => null);
  const m = r?.code === 0 && /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\s*$/.exec(r.stdout.trim());
  return m ? { owner: m[1], name: m[2] } : null;
}

// Map head branch name -> { number, title, url, draft, checks, review }. Same-repository PRs only
// (a fork's branch name can collide with a local one); the most recently updated PR wins a name.
export async function loadPRs(root, on) {
  const slug = await repoSlug(root, on);
  if (!slug) return { slug: null, byBranch: new Map() };
  const r = await exec("gh", ["api", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${slug.owner}`, "-f", `name=${slug.name}`], { on, timeout: 20000 })
    .catch(() => null);
  if (!r || r.code !== 0) return { slug, byBranch: new Map(), error: "gh" };
  let nodes = [];
  try { nodes = JSON.parse(r.stdout)?.data?.repository?.pullRequests?.nodes ?? []; } catch { nodes = []; }
  const byBranch = new Map();
  for (const n of nodes) {
    if (!n || n.isCrossRepository || byBranch.has(n.headRefName)) continue;
    byBranch.set(n.headRefName, {
      number: n.number, title: n.title, url: n.url, draft: n.isDraft, review: n.reviewDecision,
      checks: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
      repo: `${slug.owner}/${slug.name}`,
    });
  }
  return { slug, byBranch };
}

// The PR for a label part: a local branch by its name, a remote branch by the name after "<remote>/".
export function prForPart(part, byBranch) {
  if (!byBranch?.size) return null;
  if (part.kind === "branch") return byBranch.get(part.name) ?? null;
  if (part.kind === "remote") return byBranch.get(part.name.slice(part.name.indexOf("/") + 1)) ?? null;
  return null;
}

export function badgeOf(pr, t) {
  const c = pr.checks;
  const [glyph, color] = c === "SUCCESS" ? ["✓", t.done] : c === "FAILURE" || c === "ERROR" ? ["✗", t.blocked] : c ? ["●", t.working] : ["", t.dim];
  const review = pr.review === "APPROVED" ? "approved" : pr.review === "CHANGES_REQUESTED" ? "changes" : "";
  return { text: `#${pr.number}`, glyph, color: pr.draft ? t.dim : color, review, tip: `#${pr.number} ${pr.title}${pr.draft ? " (draft)" : ""}` };
}

// A PR panel that wants reveal requests refreshes "pr-panel.listening" (ms) at least every minute.
export function revealPR(pr, cx) {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(pr?.url ?? "")) return;
  const listening = Number(shared("pr-panel.listening")) || 0;
  if (Date.now() - listening < 3 * 60000) {
    setShared("pr-panel.reveal", { repo: pr.repo, number: pr.number, url: pr.url, at: Date.now() });
    return;
  }
  if (cx?.open_url) cx.open_url(pr.url);
  else exec("open", [pr.url]);
}
