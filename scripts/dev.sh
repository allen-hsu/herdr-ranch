#!/usr/bin/env bash
# Install one mod from this repo into Herdr right now (with its lib/ files) and run herdr-app check.
#   scripts/dev.sh worktrees        (mods/worktrees)
#   scripts/dev.sh git-graph        (mods/git-graph)
# Everything lives in this repo, so there is nothing to pin or bump afterwards: commit when it works.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
NAME="${1:?mod name}"
SRC=""
SRC="$HERE/mods/$NAME"
[ -f "$SRC/mod.json" ] || { echo "no mod named $NAME in mods/" >&2; exit 1; }
DRY=0; say() { printf '  %s\n' "$*"; }
# Reuse the installer's build_mod / install_mod.
eval "$(sed -n '/^EXCL=/,/^echo "herdr-ranch/p' "$HERE/install.sh" | sed '$d')"
install_mod "$SRC" "$NAME"
herdr-app check "$APP/mods/$NAME/"
