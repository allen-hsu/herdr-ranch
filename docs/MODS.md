# Mods

Every folder in `mods/`. "Shows" is where the focus layout (`layouts/focus.json`) or another mod puts it.
"Lib" is what its `lib.json` pulls in from `lib/` at install time.

| Mod | What it does | Shows | Lib |
|---|---|---|---|
| `accounts` | Add, switch, re-sign-in and remove Claude Code / Codex logins; optionally restart idle agents on the new account. | dialog (command bar, sidebar footer) | ui.js, accounts.js, accounts.py, agentname.js, subs.py, codexlog.py |
| `agent-inspector` | Overview / Trace / Capabilities / Config for the focused Claude Code or Codex agent, from local transcripts. | right panel tab | codexlog.py, ui.js, agentname.js, accounts.py |
| `agent-team` | Team Map: sequence diagram of an agent's team (hc agents, subagents, messaged sessions) and their messages. | full page (⌃⌘T); also a window | agentname.js, newteam.js, folders.js, ui.js, live.py, codexlog.py, accounts.py, accounts.js |
| `agent-toast` | Agent notifications that name the agent, state, space, branch and tab; macOS notification when Herdr is in the background; sounds. | toast (layout root `toast`) | agentname.js, live.py, codexlog.py, ui.js, accounts.py |
| `changes-plus` | Uncommitted changes with coloured diff rows. Clone of Herdr's `changes`. | right panel tab | ui.js |
| `command-bar` | ⌘K: go to agents and spaces, run actions, open views, New agent flow. | popup / dialog | ui.js, agentname.js, folders.js, accounts.py, accounts.js |
| `files-plus` | File browser with previews and search by name or content. Clone of Herdr's `files`. | right panel tab | ui.js |
| `git-graph` | Commit graph, branch picker, compare, PR badges, git actions behind confirmations, multi-repository view. | right panel tab; popups and dialogs | prs.js, ui.js |
| `layout-switch` | Layout switcher and right-panel toggle at the end of the tab bar. | top bar | ui.js |
| `pr-diff` | Read-only diff of one PR (`gh pr diff`). | pane (opened by `pr-panel`) | ui.js |
| `pr-panel` | Mine / To review / Space / Issues; starts agents in worktrees for a PR; configurable review-request buttons. | right panel tab | ui.js |
| `sidebar-foot` | Brand row, search row, and the footer: New agent, Board, Team Map, Accounts, Add machine, Settings. | sidebar (top and bottom) | ui.js |
| `space-board` | Board by space (Todo / In progress / In review / Done) or by agent. | full page (⌃⌘B); also a dialog | ui.js, agentname.js, prs.js, folders.js, agentrows.js, subs.py, accounts.py, accounts.js |
| `space-folders` | Folders → spaces → agents, status filter, Needs you / Finished / Pinned, Recent, 12 h fold, worktree and team buttons. Started from herdr-space-folders (a clone of Herdr's `spaces`). | sidebar (main view); menus and the folder editor as popups / dialog | prs.js, team.svg, ui.js, more.svg, folder-open.svg, agentrows.js, agentname.js, subs.py, accounts.py, accounts.js |
| `stack-tabs` | Tab strip (text or icons) for a layout `stack` node. | right panel header | ui.js |
| `tabs-plus` | Tab bar where a tab shows its agent's name and pulses when it finishes or needs you; answers the Board / Team Map keys. Clone of Herdr's `tabs`. | top bar | agentname.js, ui.js |
| `team-launch` | One-line "New team" launcher; "More options…" for pattern, repo and roles. | dialog (⌃⌘N) | newteam.js, folders.js, ui.js, accounts.js |
| `usage-bar` | Plan usage and reset times for Claude, Codex, Cursor (Grok slot empty). | status bar | ui.js, accounts.py |
| `worktrees` | Worktree count pill, Resource Manager window, New / Delete / Clean up dialogs. | status bar; window; dialogs | ui.js |

## Shared code (`lib/`)

| File | What it is |
|---|---|
| `ui.js` | design scale, colours, `icon()`, status marks, page and command-bar helpers |
| `agentrows.js` | agent rows as the sidebar draws them, with context %, sub-agents and background work |
| `agentname.js` | the name an agent goes by (terminal title, else tab name) |
| `folders.js` | which space-folders folder a space is in |
| `prs.js` | open PRs of a repository by head branch, through `gh` |
| `newteam.js` | the New team dialog and launch logic |
| `accounts.js` / `accounts.py` | account registry: read side (JS) and every change (Python) |
| `subs.py` | Claude Code background subagents and shell commands running now |
| `live.py` | what each agent is doing now, from transcript tails |
| `codexlog.py` | Codex session (rollout) parsing |
| `icons/`, `team.svg`, `more.svg`, `folder-open.svg` | Lucide icons |
