# herdr-ranch: inside a Herdr terminal, a plain `claude` / `codex` starts on the account picked in Herdr's
# Accounts dialog, the same one new agents get. Outside Herdr, with the system login picked, or when you set
# CLAUDE_CONFIG_DIR / CODEX_HOME yourself, nothing changes.
# Sourced from ~/.zshrc or ~/.bashrc (./install.sh --shell adds the line). Works in zsh and bash.

# $1: claude | codex. Prints the picked account's folder, or nothing for the system login.
_herdr_ranch_account() {
  [ -n "${HC_TERMINAL_ID:-}" ] || return 0
  local app="${HERDR_APP_HOME:-$HOME/.config/herdr-app}" d=""
  [ -r "$app/ranch/active-$1" ] || return 0
  IFS= read -r d < "$app/ranch/active-$1" || true
  case "$d" in
    "$app/ranch/accounts/"*/*|*..*) ;;
    "$app/ranch/accounts/"?*) [ -d "$d" ] && printf '%s' "$d" ;;
  esac
  return 0
}

# Bring the account's setup (trusted folders, MCP servers) up to date with your own before it starts.
_herdr_ranch_sync() {
  local py="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/accounts/accounts.py"
  [ -r "$py" ] && command -v python3 >/dev/null 2>&1 && python3 "$py" sync "$1" >/dev/null 2>&1
  return 0
}

claude() {
  local d=""
  [ -n "${CLAUDE_CONFIG_DIR:-}" ] || d="$(_herdr_ranch_account claude)"
  if [ -n "$d" ]; then _herdr_ranch_sync claude; CLAUDE_CONFIG_DIR="$d" command claude "$@"; else command claude "$@"; fi
}

codex() {
  local d=""
  [ -n "${CODEX_HOME:-}" ] || d="$(_herdr_ranch_account codex)"
  if [ -n "$d" ]; then _herdr_ranch_sync codex; CODEX_HOME="$d" command codex "$@"; else command codex "$@"; fi
}
