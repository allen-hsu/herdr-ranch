# Security reviews of third-party mods

Reviews of code that came from elsewhere (now maintained in `mods/`, see `../licenses/`) and of any mods pinned in `vendor.json`.

| Mod | Source | Commit | Audited |
|---|---|---|---|
| mods/space-folders | github.com/jankeesvw/herdr-space-folders (mods/space-folders) | 63a78b20d5ed30d57166a3c7165a6eb558c3ef84 | 2026-11-10: no network; writes only ~/.config/herdr-space-folders.json; git read-only, hc machine ls |
| mods/git-graph | github.com/rabeeh-ta/herdr-git-graph (mods/git-graph) | 099ddb96bfde853b2b6bf23b4e18aed23e4f2934 (v0.3.3) | 2026-11-10: network = daily release check to api.github.com (update.js CHECK) + user-triggered git fetch/pull/push; execs git/find/env (argv, no shell); reads repo files and .git; destructive git ops behind confirm |

Update only after reviewing the diff between the pinned commit and the new one.

## agent-team lead permissions (2026-11-11)
Automated review flagged `--allowedTools Bash(hc:*),Bash(git:*)` on the team lead: pre-approving all of git lets
`git -c core.sshCommand=…` / aliases run arbitrary programs without auto mode's classifier. Fixed: the lead
pre-approves only `hc run --bg|send|wait|read|get|ls|templates|kill|interrupt`; git and `hc keys` go through the
classifier. Members run in auto mode (Claude, Grok) or Codex's workspace-write sandbox.
Follow-up (same day): the detected base branch (origin/HEAD, chosen by the remote) now passes the same
`^[\w./-]+$` check as a typed one (else `main`), and the repo path / name are single-quoted where the playbooks
put them into commands.
