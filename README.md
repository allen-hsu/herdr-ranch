# herdr-ranch

A workspace for running many coding agents (Claude Code, Codex) across projects in the
[Herdr](https://herdr.dev) desktop app: an agent board, a PR panel that hands work to agents,
an agent inspector (health / config / trace / cost), and an account usage bar.

Two layouts, switched from the top-right or with ⌃⌘1 / ⌃⌘2:

| Layout | Left | Center | Right panel (one panel, ⌃⌘G / ▣ toggles) |
|---|---|---|---|
| **Overview** | spaces in folders | **agent board**: Needs you → Idle → Working → Done | Files · Changes · Git graph · Pull requests · Agent inspector |
| **Focus** | spaces + agent list (context %) | the active tab | same panel, Agent inspector first |

Bottom bar: worktree resource manager pill, then Claude / Codex / Grok / Cursor plan usage with reset times.

## Install

```sh
git clone git@github.com:allen-hsu/herdr-ranch.git ~/Documents/personal/herdr-ranch
cd ~/Documents/personal/herdr-ranch
./install.sh --dry-run      # what it would change
./install.sh                # install / update (re-run after every pull)
./install.sh --statusline   # also wire the Claude Code status-line snapshot (context %, cost)
```

The installer builds every mod in `mods/` (adding the `lib/` files it lists), copies
`layouts/` into `~/.config/herdr-app`, fetches any pinned mods in `vendor.json`, puts integration scripts in `~/.config/herdr-app/ranch/`,
merges `config.example/keys.json` into your `keys.json` (your existing keys always win), and runs
`herdr-app check` on every mod. New mod folders are moved in atomically so Herdr never auto-docks
them. Edit here, then re-run `./install.sh`; don't edit the copies in `~/.config/herdr-app`.

Personal config stays in `~/.config/herdr-app` and is never committed — start from `config.example/`:
- `pr-panel.json` — review-request buttons on PR cards (pluggable `command` requesters)
- `slack-review.json` — channel / bot ids for `integrations/requesters/slack-post.py`

## What's in it

| Mod | What it does |
|---|---|
| `agent-board` | Kanban of all agents. Each card: project · branch, your last prompt, what it is doing *now* (tool call / question / reply, from transcript tails), context bar, cost. Space filter via `agent-board-picker` (All / Current / folders / spaces). Click → Focus. |
| `agent-inspector` | For the focused agent: **Skills** (which skills really loaded, by the model or by your /command, when, how many tokens; skills you named that never loaded; per-turn ⚡ chips in Trace), **MCP** (every server: connected / needs sign-in / failed, tools available · loaded · called, context cost), **Health** (hook errors and timeouts, tool errors, permission blocks incl. auto-mode classifier, MCP failures, compactions, cache drops), **Config** (memory/rules files, skills listed vs loaded, hooks that ran, MCP servers, mode, model), **Trace** (per turn: thinking, tool calls with duration / size / who approved), **Cost** (context added per tool and turn, subagents). Claude Code and Codex. |
| `pr-panel` + `pr-diff` | Mine / To review / Space / Issues. PRs grouped by whose move it is. Buttons start an agent in a worktree: Fix CI, Fix comments, AI review, Ask Claude (with the diff beside it), Diff, plus configurable requesters (e.g. Slack). Fork PRs are never checked out. |
| `usage-bar` | Plan usage: Claude (OAuth usage API), Codex (usage API, falls back to local logs), Cursor (usage summary), Grok slot. |
| `agents-ctx` | Herdr's agent list (cloned) + a context-used badge per Claude agent. |
| `changes-plus` | Herdr's shipped Changes panel (0.1.14) with GitHub-like colored diffs. A frozen clone: re-clone and re-apply `diffRow` when Herdr updates `changes`. |
| `agent-toast` | Replaces Herdr's notification look (layout root `"toast"`). Agent toasts say which agent: Finished / Needs you, its session name, space · branch · tab, what you last asked, and its last reply or the question / tool it is waiting on. Other notifications look as before. |
| `layout-switch`, `stack-tabs`, `title-strip` | Top-right layout switcher + panel toggle; tab strip for stack nodes (`sync_panels` registers its tabs in Herdr's per-space panel memory); plain title strip. |

The right panel *is* Herdr's own `panel` / `panel-body`, so the tab bar's Files and Changes buttons open
tabs in the same panel instead of a second column.

| `worktrees` | Git worktrees, Orca-style. Status-bar pill (count · disk · cleanable) → **Resource Manager**: CPU / memory per repo → worktree → terminal with sparklines, disk use, and a clean-up list (select all cleanable, guarded delete; 🗑 pre-selects everything safe). Dialogs for New worktree (base / existing branch / PR; copies `.worktreeinclude`, links orca.yaml `worktree.sharedDirectories`), Delete, Clean up — opened by any mod via `openOverlay({ mod: "worktrees", props: { wt, root, ... } })`. |

| `space-folders` | Sidebar: spaces grouped into folders; per space an agent status dot (bold when finished unseen), dirty count and PR badge; hover a repo row for New worktree / Clean up, a worktree row for Delete (opens the `worktrees` dialogs). |
| `git-graph` | Commit graph: branch picker (any local/remote branch), checkout with a stash prompt, compare two branches (head ^base, ahead/behind, swap), PR badges with CI state (click reveals the PR), GitHub-like diff colors; the Uncommitted row opens Changes. Tests: `npm test`. |

`space-folders` and `git-graph` started from open-source mods and are now our own code; origins and
licenses in `licenses/`.

## Data and credentials

Everything reads local files except where noted. Tokens are read from where each CLI keeps them and
sent only to that vendor; caches under `~/.cache/herdr-claude-status/` hold numbers and redacted
snippets, owner-only (0700/0600).

| Feature | Reads | Sends to |
|---|---|---|
| Agent board / inspector | `~/.claude/projects`, `~/.claude/sessions`, `~/.codex/sessions` | nothing |
| Context % / cost | status-line snapshot written by `herdr-status-snapshot.py` | nothing |
| Claude usage | keychain `Claude Code-credentials` | api.anthropic.com |
| Codex usage | `~/.codex/auth.json` | chatgpt.com |
| Cursor usage | keychain `cursor-access-token` | cursor.com |
| PR panel | your `gh` login | api.github.com |
| Slack requester | keychain `herdr-slack-review` / `user-token` | slack.com |

## Layout of this repo

```
mods/              our mods (one folder per mod, copied into ~/.config/herdr-app/mods)
lib/               code shared by several mods: prs.js (GitHub PR badges), folders.js (space-folders
                   state), codexlog.py (Codex sessions), live.py (what each agent is doing now). A mod lists what it needs in lib.json; the
                   installer copies those files into the installed mod (Herdr mods can't import across mods)
layouts/           overview.json, focus.json
vendor.json        third-party mods installed unchanged at a pinned commit (none right now)
integrations/      claude-statusline snapshot helper; review requesters (Slack) + Slack app manifest
config.example/    pr-panel.json, slack-review.json, keys.json (merged by install.sh)
scripts/dev.sh     install one mod now while developing: scripts/dev.sh <name>
tests/             node tests (npm test)
licenses/          origins and licenses of code that started elsewhere
docs/              security reviews, notes
```

Rules that keep it maintainable:
- One concern per mod; mods talk through overlay props and `shared` keys, never by importing each other.
  Contracts: `worktrees` dialogs (`{ wt, root, path?, on? }`), `pr-panel.reveal` / `pr-panel.listening`.
- Code needed by two mods goes in `lib/`, never copied by hand.
- A feature that can stand alone becomes its own mod rather than growing an existing one.
- UI labels in English; no personal ids or paths in code (they go in `~/.config/herdr-app/*.json`).

Known gaps: conversation full-text search, one prompt → several agents, Code layout, multiple
Claude accounts; Grok usage.
