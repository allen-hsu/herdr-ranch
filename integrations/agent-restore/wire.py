#!/usr/bin/env python3
"""Add (or remove) the agent-restore session hook in Claude Code's and Codex's own settings.

  wire.py            add it where it is missing
  wire.py --remove   take it out again
  wire.py --check    say where it is wired, change nothing

Claude Code: ~/.claude/settings.json, hooks.SessionStart and hooks.SessionEnd.
Codex:       ~/.codex/hooks.json, hooks.SessionStart (only when ~/.codex exists).
Only its own entry is touched (found by the script's name); a file that is not what it expects is left alone.
Each changed file is first copied to <file>.bak-ranch, and written in one move.
"""
import json, os, sys

HOME = os.path.expanduser("~")
MARK = "agent-session-hook.py"
COMMAND = 'python3 "${HERDR_APP_HOME:-$HOME/.config/herdr-app}/ranch/agent-session-hook.py" %s'
TARGETS = [
    ("claude", os.path.join(HOME, ".claude", "settings.json"), ("SessionStart", "SessionEnd"), os.path.join(HOME, ".claude")),
    ("codex", os.path.join(HOME, ".codex", "hooks.json"), ("SessionStart",), os.path.join(HOME, ".codex")),
]


def ours(group):
    return isinstance(group, dict) and any(isinstance(h, dict) and MARK in str(h.get("command", "")) for h in group.get("hooks") or [])


def wired(data, events):
    hooks = data.get("hooks") if isinstance(data, dict) else None
    return isinstance(hooks, dict) and all(any(ours(g) for g in hooks.get(e) or []) for e in events)


def apply(provider, path, events, home, remove):
    """-> a line for the person."""
    if not os.path.isdir(home):
        return "%s: not installed here, skipped" % provider
    try:
        with open(path) as f:
            text = f.read()
        data = json.loads(text) if text.strip() else {}
    except FileNotFoundError:
        text, data = None, {}
    except Exception:
        return "%s: %s is not readable JSON, left alone" % (provider, path)
    if not isinstance(data, dict) or not isinstance(data.get("hooks", {}), dict):
        return "%s: %s has an unexpected shape, left alone" % (provider, path)
    hooks = data.setdefault("hooks", {})
    changed = False
    for e in events:
        groups = hooks.get(e)
        if groups is None:
            groups = []
        if not isinstance(groups, list):
            return "%s: hooks.%s in %s is not a list, left alone" % (provider, e, path)
        if remove:
            kept = [g for g in groups if not ours(g)]
            if len(kept) != len(groups):
                changed = True
                if kept:
                    hooks[e] = kept
                else:
                    hooks.pop(e, None)
        elif not any(ours(g) for g in groups):
            groups.append({"hooks": [{"type": "command", "command": COMMAND % provider, "timeout": 10}]})
            hooks[e] = groups
            changed = True
    if not hooks:
        data.pop("hooks", None)
    if not changed:
        return "%s: %s" % (provider, "nothing to remove" if remove else "already wired")
    if text is not None:
        with open(path + ".bak-ranch", "w") as f:
            f.write(text)
    tmp = "%s.ranch-tmp-%d" % (path, os.getpid())
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)
    return "%s: %s %s%s" % (provider, "removed from" if remove else "added to", path, "" if text is None else " (backup: %s.bak-ranch)" % path)


def main(argv):
    if "--check" in argv:
        for provider, path, events, home in TARGETS:
            try:
                ok = wired(json.load(open(path)), events)
            except Exception:
                ok = False
            print("%s: %s" % (provider, "wired" if ok else "not wired"))
        return 0
    for provider, path, events, home in TARGETS:
        print(apply(provider, path, events, home, "--remove" in argv))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
