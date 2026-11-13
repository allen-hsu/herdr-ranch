#!/usr/bin/env bash
# herdr-ranch installer: copies mods, layouts and integration scripts into the Herdr app home,
# fetches pinned third-party mods (vendor.json), merges keybindings without overwriting yours.
#
#   ./install.sh               install / update
#   ./install.sh --dry-run     show what would change
#   ./install.sh --statusline  also add the context/quota snapshot hook to your Claude Code status line
#   ./install.sh --shell       also add one line to your shell rc, so a plain `claude` / `codex` typed in a
#                              Herdr terminal uses the account picked in the Accounts dialog
#
# Never touches your personal config (pr-panel.json, slack-review.json) except to tell you about the examples.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/herdr-ranch"
DRY=0; STATUSLINE=0; SHELLRC=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --statusline) STATUSLINE=1 ;;
    --shell) SHELLRC=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '  %s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then say "[dry-run] $*"; else "$@"; fi; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }
need git; need python3; need rsync
[ -d "$APP" ] || { echo "Herdr app home not found: $APP (start the Herdr app once first)" >&2; exit 1; }
HAVE_HERDR=1; command -v herdr-app >/dev/null 2>&1 || HAVE_HERDR=0

# Build a mod (its folder + the shared lib/ files its lib.json lists) and copy it into $APP/mods/<name>.
# A folder Herdr has never seen appears in one rename, with its mod.json already inside, so Herdr never
# auto-docks it into the shown layout.
EXCL=(--exclude jsconfig.json --exclude '*.d.ts' --exclude __pycache__ --exclude lib.json)
build_mod() {
  local src="$1" out="$2"
  rm -rf "$out"; mkdir -p "$out"
  rsync -a "${EXCL[@]}" "$src/" "$out/"
  if [ -f "$src/lib.json" ]; then
    python3 - "$src/lib.json" <<'PY' | while IFS= read -r f; do
import json, sys
for f in json.load(open(sys.argv[1])): print(f)
PY
      case "$f" in */*|..*|"") echo "bad lib entry '$f' in $src/lib.json" >&2; exit 1 ;; esac
      [ -f "$HERE/lib/$f" ] || { echo "missing lib/$f (listed by $src/lib.json)" >&2; exit 1; }
      [ ! -e "$src/$f" ] || { echo "$src/$f shadows lib/$f; delete one" >&2; exit 1; }
      cp "$HERE/lib/$f" "$out/$f"
    done
  fi
  # A mod's Python that imports a lib/ module must list it in lib.json (else it fails only at run time).
  for py in "$out"/*.py; do
    [ -f "$py" ] || continue
    for m in $(grep -hoE '^[[:space:]]*import [a-z_]+' "$py" | awk '{print $2}' | sort -u); do
      if [ -f "$HERE/lib/$m.py" ] && [ ! -f "$out/$m.py" ]; then echo "$(basename "$src")/$(basename "$py") imports $m: add \"$m.py\" to $src/lib.json" >&2; exit 1; fi
    done
  done
}
install_mod() {
  local src="$1" name="$2" dst="$APP/mods/$2" stage="$APP/.ranch-staging-$2"
  [ -f "$src/mod.json" ] || { echo "no mod.json in $src" >&2; exit 1; }
  if [ "$DRY" = 1 ]; then say "[dry-run] mod $name <- ${src#$HERE/}"; return; fi
  build_mod "$src" "$stage"
  if [ -d "$dst" ]; then rsync -a --delete "${EXCL[@]}" "$stage/" "$dst/"; rm -rf "$stage"; else mv "$stage" "$dst"; fi
  say "mod  $name  (${src#$HERE/})"
}

echo "herdr-ranch -> $APP"

echo "Mods"
for d in "$HERE"/mods/*/; do [ -d "$d" ] && install_mod "${d%/}" "$(basename "$d")"; done

echo "Pinned third-party mods (vendor.json)"
python3 - "$HERE/vendor.json" <<'PY' > "$CACHE.vendor.tsv.tmp" 2>/dev/null || true
import json, sys
for m in json.load(open(sys.argv[1]))["mods"]:
    print("\t".join([m["name"], m["repo"], m["path"], m["commit"], m.get("ref", "")]))
PY
mkdir -p "$CACHE"
[ -s "$CACHE.vendor.tsv.tmp" ] || say "none"
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

echo "Agent team: role templates -> ~/.config/herdr-core/templates, playbooks -> $APP/ranch/teams"
run mkdir -p "$HOME/.config/herdr-core/templates" "$APP/ranch/teams"
for f in "$HERE"/templates/*.md; do run cp "$f" "$HOME/.config/herdr-core/templates/"; done
run rsync -a --delete "$HERE/teams/" "$APP/ranch/teams/"
say "$(/bin/ls "$HERE"/templates/*.md | wc -l | tr -d ' ') templates, $(/bin/ls "$HERE"/teams/*.md | wc -l | tr -d ' ') playbooks"

echo "Integration scripts -> $APP/ranch"
run mkdir -p "$APP/ranch"
# Shared icon set (Lucide, ISC: licenses/lucide-ISC.txt). Mods draw them with icon() from lib/ui.js.
run rsync -a --delete "$HERE/lib/icons/" "$APP/ranch/icons/"
say "$(/bin/ls "$HERE"/lib/icons/*.svg | wc -l | tr -d ' ') icons -> $APP/ranch/icons"
run rsync -a "$HERE/integrations/requesters/" "$APP/ranch/requesters/"
run mkdir -p "$HOME/.claude"
run cp "$HERE/integrations/claude-statusline/herdr-status-snapshot.py" "$HOME/.claude/herdr-status-snapshot.py"
say "claude status-line snapshot helper -> ~/.claude/herdr-status-snapshot.py"

echo "Herdr Notify.app (macOS notifications with Herdr's icon; click goes to the agent)"
NOTIFY_APP="$HOME/Applications/Herdr Notify.app"
NOTIFY_SRC="$HERE/integrations/notifier"
if [ "$(uname)" != Darwin ]; then say "skipped (not macOS)"
elif ! command -v swiftc >/dev/null 2>&1; then say "skipped: needs swiftc (xcode-select --install); toasts fall back to osascript"
elif [ -x "$NOTIFY_APP/Contents/MacOS/herdr-notify" ] && [ "$NOTIFY_APP/Contents/MacOS/herdr-notify" -nt "$NOTIFY_SRC/main.swift" ] && [ "$NOTIFY_APP/Contents/Info.plist" -nt "$NOTIFY_SRC/Info.plist" ]; then say "up to date"
else run "$NOTIFY_SRC/build.sh" >/dev/null && say "built -> ~/Applications/Herdr Notify.app (allow its notifications the first time)"; fi

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

echo "Accounts in the shell (a plain claude / codex in a Herdr terminal uses the picked account)"
run cp "$HERE/integrations/shell/accounts.sh" "$APP/ranch/shell-accounts.sh"
case "$(basename "${SHELL:-zsh}")" in bash) RC="$HOME/.bashrc" ;; *) RC="${ZDOTDIR:-$HOME}/.zshrc" ;; esac
RC_LINE='[ -r "${HERDR_APP_HOME:-$HOME/.config/herdr-app}/ranch/shell-accounts.sh" ] && . "${HERDR_APP_HOME:-$HOME/.config/herdr-app}/ranch/shell-accounts.sh" # herdr-ranch accounts'
if [ -f "$RC" ] && grep -q "ranch/shell-accounts.sh" "$RC"; then
  say "already in $RC"
elif [ "$SHELLRC" = 1 ]; then
  if [ "$DRY" = 1 ]; then say "[dry-run] would add one line to $RC"; else printf '\n%s\n' "$RC_LINE" >> "$RC"; say "added one line to $RC (new terminals pick it up)"; fi
else
  say "not wired: agents started from Herdr use the picked account, a claude you type yourself uses the system login."
  say "To wire it, re-run with --shell, or add this line to $RC:"
  say "  $RC_LINE"
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
  echo "Done. Board: ⌃⌘B (or the Board button at the bottom of the sidebar). Command bar: ⌘K."
fi
