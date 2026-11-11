# Security reviews of third-party mods

Forked mods live in `forks/` (git subtree), pinned mods in `vendor.json`; this file records what was reviewed.

| Mod | Source | Commit | Audited |
|---|---|---|---|
| mods/space-folders | github.com/jankeesvw/herdr-space-folders (mods/space-folders) | 63a78b20d5ed30d57166a3c7165a6eb558c3ef84 | 2026-11-10: no network; writes only ~/.config/herdr-space-folders.json; git read-only, hc machine ls |
| mods/git-graph | github.com/rabeeh-ta/herdr-git-graph (mods/git-graph) | 099ddb96bfde853b2b6bf23b4e18aed23e4f2934 (v0.3.3) | 2026-11-10: network = daily release check to api.github.com (update.js CHECK) + user-triggered git fetch/pull/push; execs git/find/env (argv, no shell); reads repo files and .git; destructive git ops behind confirm |

Update only after reviewing the diff between the pinned commit and the new one.
