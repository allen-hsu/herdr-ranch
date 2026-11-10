// GitHub data via the user's own `gh` sign-in. Read-only queries; no PR/issue text is ever
// passed to an agent (prompts carry only repo, number and URL — the agent reads the rest itself).
import { exec } from "herdr";

const PR_FIELDS = `
  ... on PullRequest {
    number title url isDraft updatedAt headRefName isCrossRepository
    repository { nameWithOwner }
    author { login }
    reviewDecision mergeable
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    reviewThreads(first: 100) { nodes { isResolved } }
  }`;
const ISSUE_FIELDS = `
  ... on Issue {
    number title url updatedAt
    repository { nameWithOwner }
    labels(first: 3) { nodes { name color } }
  }`;

async function search(q, fields) {
  const query = `query($q: String!) { search(query: $q, type: ISSUE, first: 50) { nodes { ${fields} } } }`;
  const r = await exec("gh", ["api", "graphql", "-f", `query=${query}`, "-f", `q=${q}`], { timeout: 30000 });
  if (r.code !== 0) throw new Error((r.stderr || "gh failed").split("\n").filter((l) => !/GVM|FakeAssoc/.test(l)).join(" ").slice(0, 200));
  const d = JSON.parse(r.stdout);
  if (d.errors?.length) throw new Error(d.errors[0].message);
  return (d.data?.search?.nodes ?? []).filter((n) => n && n.number);
}

export function checksOf(pr) {
  return pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null; // SUCCESS FAILURE ERROR PENDING EXPECTED
}
export function unresolvedOf(pr) {
  return (pr.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved).length;
}

// Whose move it is. Order = display order.
export const GROUPS = [
  { id: "failing", label: "CI failing", status: "blocked" },
  { id: "comments", label: "Needs changes", status: "blocked" },
  { id: "conflict", label: "Merge conflict", status: "blocked" },
  { id: "ready", label: "Ready to merge", status: "done" },
  { id: "waiting", label: "Waiting for review", status: "working" },
  { id: "draft", label: "Drafts", status: "idle" },
  { id: "stale", label: "Stale (90+ days)", status: "idle" },
];
export const STALE_DAYS = 90;
export function groupOf(pr) {
  const checks = checksOf(pr);
  if (Date.now() - Date.parse(pr.updatedAt) > STALE_DAYS * 86400000) return "stale";
  if (pr.isDraft) return "draft";
  if (checks === "FAILURE" || checks === "ERROR") return "failing";
  if (pr.reviewDecision === "CHANGES_REQUESTED" || unresolvedOf(pr) > 0) return "comments";
  if (pr.mergeable === "CONFLICTING") return "conflict";
  if (pr.reviewDecision === "APPROVED" && (checks === "SUCCESS" || checks === null)) return "ready";
  return "waiting";
}

export const TABS = [
  { id: "mine", label: "Mine", kind: "pr", q: () => "is:pr is:open archived:false author:@me" },
  { id: "review", label: "To review", kind: "pr", q: () => "is:pr is:open archived:false review-requested:@me" },
  { id: "space", label: "Space", kind: "pr", q: (repos) => (repos?.length ? `is:pr is:open ${repos.map((r) => `repo:${r}`).join(" ")}` : null) },
  { id: "issues", label: "Issues", kind: "issue", q: () => "is:issue is:open archived:false assignee:@me" },
];

export async function load(tab, repos) {
  const q = tab.q(repos);
  if (!q) return [];
  return search(q, tab.kind === "pr" ? PR_FIELDS : ISSUE_FIELDS);
}

// owner/name of the git repo at `dir`, from its origin remote.
export async function repoAt(dir) {
  if (!dir) return null;
  const r = await exec("git", ["-C", dir, "remote", "get-url", "origin"], { timeout: 5000 }).catch(() => null);
  const m = r?.code === 0 && /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/.exec(r.stdout.trim());
  return m ? m[1] : null;
}

// The main checkout (not a worktree) that contains `dir`.
export async function mainCheckout(dir) {
  const r = await exec("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 5000 }).catch(() => null);
  if (r?.code !== 0) return null;
  const common = r.stdout.trim();
  return common.endsWith("/.git") ? common.slice(0, -5) : null;
}
