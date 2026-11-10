#!/bin/sh
# While developing a forked third-party mod: copy its working tree into Herdr (bypasses the vendor.json pin).
#   scripts/dev-sync.sh git-graph      (~/Documents/personal/herdr-git-graph)
#   scripts/dev-sync.sh space-folders  (~/Documents/personal/herdr-space-folders)
set -e
NAME="${1:?mod name}"
SRC="${2:-$HOME/Documents/personal/herdr-$NAME}/mods/$NAME/"
DST="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/$NAME/"
rsync -a --delete --exclude jsconfig.json --exclude '*.d.ts' "$SRC" "$DST"
herdr-app check "$DST"
echo "When done: commit + push the fork, then bump $NAME's commit in vendor.json and run ./install.sh"
