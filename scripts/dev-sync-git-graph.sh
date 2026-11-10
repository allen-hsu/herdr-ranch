#!/bin/sh
# While developing the git-graph fork: copy its working tree into Herdr (bypasses the vendor.json pin).
set -e
SRC="${GIT_GRAPH_SRC:-$HOME/Documents/personal/herdr-git-graph}/mods/git-graph/"
DST="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/git-graph/"
rsync -a --delete --exclude jsconfig.json --exclude '*.d.ts' "$SRC" "$DST"
herdr-app check "$DST"
echo "When done: commit + push the fork, then bump git-graph's commit in vendor.json and run ./install.sh"
