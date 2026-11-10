#!/usr/bin/env bash
# herdr-ranch installer: copies mods, layouts and integration scripts into the Herdr app home,
# fetches pinned third-party mods (vendor.json), merges keybindings without overwriting yours.
#
#   ./install.sh               install / update
#   ./install.sh --dry-run     show what would change
#   ./install.sh --statusline  also add the context/quota snapshot hook to your Claude Code status line
#
# Never touches your personal config (pr-panel.json, slack-review.json) except to tell you about the examples.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/herdr-ranch"
DRY=0; STATUSLINE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --statusline) STATUSLINE=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '  %s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then say "[dry-run] $*"; else "$@"; fi; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }
need git; need python3; need rsync
[ -d "$APP" ] || { echo "Herdr app home not found: $APP (start the Herdr app once first)" >&2; exit 1; }
HAVE_HERDR=1; command -v herdr-app >/dev/null 2>&1 || HAVE_HERDR=0

# Copy a mod folder into $APP/mods/<name>. A folder Herdr has never seen appears in one rename,
# with its mod.json already inside, so Herdr never auto-docks it into the shown layout.
install_mod() {
  local src="$1" name="$2" dst="$APP/mods/$2"
  [ -f "$src/mod.json" ] || { echo "no mod.json in $src" >&2; exit 1; }
  if [ -d "$dst" ]; then
    run rsync -a --delete --exclude jsconfig.json --exclude '*.d.ts' --exclude __pycache__ "$src/" "$dst/"
  else
    local stage="$APP/.ranch-staging-$name"
    run rm -rf "$stage"
    run rsync -a --exclude jsconfig.json --exclude '*.d.ts' --exclude __pycache__ "$src/" "$stage/"
    run mv "$stage" "$dst"
  fi
  say "mod  $name"
}

echo "herdr-ranch -> $APP"

echo "Mods"
for d in "$HERE"/mods/*/; do install_mod "${d%/}" "$(basename "$d")"; done

echo "Third-party mods (vendor.json, pinned)"
python3 - "$HERE/vendor.json" <<'PY' > "$CACHE.vendor.tsv.tmp" 2>/dev/null || true
import json, sys
for m in json.load(open(sys.argv[1]))["mods"]:
    print("\t".join([m["name"], m["repo"], m["path"], m["commit"], m.get("ref", "")]))
PY
mkdir -p "$CACHE"
while IFS=$'\t' read -r name repo path commit ref; do
  [ -n "$name" ] || continue
  dir="$CACHE/vendor/$name"
  if [ ! -d "$dir/.git" ]; then run git clone --quiet "$repo" "$dir"; fi
  if [ "$DRY" = 0 ]; then
    git -C "$dir" fetch --quiet origin ${ref:+"$ref"} 2>/dev/null || git -C "$dir" fetch --quiet origin
    git -C "$dir" -c advice.detachedHead=false checkout --quiet "$commit"
  fi
  if [ "$DRY" = 1 ] && [ ! -d "$dir/.git" ]; then say "[dry-run] would fetch $repo @ ${commit:0:7} and install $name"; continue; fi
  install_mod "$dir/$path" "$name"
  say "     $name @ ${commit:0:7}${ref:+ ($ref)}"
done < "$CACHE.vendor.tsv.tmp"
rm -f "$CACHE.vendor.tsv.tmp"

echo "Layouts"
for f in "$HERE"/layouts/*.json; do run cp "$f" "$APP/layouts/"; say "layout $(basename "$f" .json)"; done

echo "Integration scripts -> $APP/ranch"
run mkdir -p "$APP/ranch"
run rsync -a "$HERE/integrations/requesters/" "$APP/ranch/requesters/"
run mkdir -p "$HOME/.claude"
run cp "$HERE/integrations/claude-statusline/herdr-status-snapshot.py" "$HOME/.claude/herdr-status-snapshot.py"
say "claude status-line snapshot helper -> ~/.claude/herdr-status-snapshot.py"

echo "Keybindings (merge; your existing keys win)"
python3 - "$HERE/config.example/keys.json" "$APP/keys.json" "$DRY" <<'PY'
import json, os, sys
src, dst, dry = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
add = json.load(open(src))
cur = json.load(open(dst)) if os.path.exists(dst) else {}
added, kept = [], []
for section, binds in add.items():
    have = cur.setdefault(section, {})
    for k, v in binds.items():
        if k not in have:
            have[k] = v; added.append(f"{section} {k} -> {v}")
        elif have[k] != v:
            kept.append(f"{section} {k}: kept yours ({have[k]}), ranch wants {v}")
for a in added: print("  + " + a)
for k in kept: print("  ! " + k)
if not added: print("  nothing to add")
if added and not dry:
    tmp = dst + ".ranch-tmp"
    open(tmp, "w").write(json.dumps(cur, indent=2, ensure_ascii=False) + "\n"); os.replace(tmp, dst)
PY

echo "Claude Code status line"
SL="$(python3 -c 'import json,os; s=json.load(open(os.path.expanduser("~/.claude/settings.json"))); print((s.get("statusLine") or {}).get("command",""))' 2>/dev/null || true)"
SCRIPT="$(printf '%s' "$SL" | grep -oE '[^ ]+\.sh' | head -1 | sed "s#^~#$HOME#" || true)"
MARK="herdr-status-snapshot.py"
if [ -n "$SCRIPT" ] && [ -f "$SCRIPT" ] && grep -q "$MARK" "$SCRIPT"; then
  say "already wired in $SCRIPT"
elif [ "$STATUSLINE" = 1 ] && [ -n "$SCRIPT" ] && [ -f "$SCRIPT" ] && grep -q 'input=$(cat)' "$SCRIPT"; then
  run python3 - "$SCRIPT" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
hook = '\n# Herdr ranch: sanitized context/quota snapshot (background, never blocks the status line)\n( printf \'%s\' "$input" | python3 "$HOME/.claude/herdr-status-snapshot.py" >/dev/null 2>&1 & )\n'
s = s.replace("input=$(cat)\n", "input=$(cat)\n" + hook, 1)
open(p + ".bak-ranch", "w").write(open(p).read()); open(p, "w").write(s)
PY
  say "added the snapshot hook to $SCRIPT (backup: $SCRIPT.bak-ranch)"
else
  say "not wired. Context % and cost on agent cards need it. Add after your status line reads stdin:"
  say '  ( printf '"'"'%s'"'"' "$input" | python3 "$HOME/.claude/herdr-status-snapshot.py" >/dev/null 2>&1 & )'
  say "or re-run with --statusline if your status line is a script with input=\$(cat)."
fi

echo "Personal config"
[ -f "$APP/pr-panel.json" ] && say "pr-panel.json present" || say "no pr-panel.json: PR cards show no review-request buttons (see config.example/pr-panel.json)"
[ -f "$APP/slack-review.json" ] && say "slack-review.json present" || say "no slack-review.json: needed only for the Slack requester (see config.example/slack-review.json)"

if [ "$DRY" = 0 ] && [ "$HAVE_HERDR" = 1 ]; then
  echo "Checking mods"
  fail=0
  for d in "$APP"/mods/*/; do
    n="$(basename "$d")"
    [ -d "$HERE/mods/$n" ] || grep -q "\"name\": \"$n\"" "$HERE/vendor.json" || continue
    if herdr-app check "$d" >/dev/null 2>&1; then say "ok   $n"; else say "FAIL $n"; fail=1; fi
  done
  [ "$fail" = 0 ] || { echo "Some mods failed herdr-app check; see: herdr-app check <mod folder>" >&2; exit 1; }
  echo "Done. Switch with ⌃⌘1 (Overview) / ⌃⌘2 (Focus), or: herdr-app do layout.switch --name overview"
fi
