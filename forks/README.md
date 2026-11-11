# forks/

Third-party Herdr mods we changed. Each folder is the whole upstream repository, imported with
`git subtree` (history kept); only `mods/<name>/` inside is installed. Our changes are marked
`herdr-extensions:` in the code. Keep them small: anything that can stand alone belongs in `../mods/`
(e.g. worktree management moved out of space-folders into `mods/worktrees`).

| Folder | Upstream | Our GitHub fork (old home, for upstream PRs) |
|---|---|---|
| `space-folders` | https://github.com/jankeesvw/herdr-space-folders (`main`) | allen-hsu/herdr-space-folders, branch `herdr-extensions` |
| `git-graph` | https://github.com/rabeeh-ta/herdr-git-graph (`main`) | allen-hsu/herdr-git-graph, branch `herdr-extensions` |

Shared code they use comes from `../lib/` via `lib.json` (e.g. `prs.js`), so it is not in the folder.

## Take upstream updates

```sh
git subtree pull --prefix=forks/git-graph https://github.com/rabeeh-ta/herdr-git-graph.git main
git subtree pull --prefix=forks/space-folders https://github.com/jankeesvw/herdr-space-folders.git main
./install.sh
```

Review the upstream diff first (see `../docs/security-reviews.md`); mods run as trusted code.

## Send a fix upstream

```sh
git subtree split --prefix=forks/git-graph -b git-graph-split   # upstream-shaped history
git push git@github.com:allen-hsu/herdr-git-graph.git git-graph-split:some-fix
# then open a PR from allen-hsu/herdr-git-graph to the upstream repo
```
