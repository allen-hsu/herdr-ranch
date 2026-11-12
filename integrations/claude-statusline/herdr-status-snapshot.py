#!/usr/bin/env python3
"""Write a sanitized Claude Code status-line snapshot for the herdr-ranch agent views (context % and cost).

Called from your Claude Code status-line script with the status-line JSON on stdin.
Keeps only numbers (context %, 5h/7d usage %) keyed by session id. No prompts, paths or tokens.
Output: ~/.cache/herdr-claude-status/claude-statusline.json (read by lib/agentrows.js, lib/live.py and
mods/agent-inspector/inspect.py).
"""
import json, os, sys, time, tempfile

OUT_DIR = os.path.expanduser("~/.cache/herdr-claude-status")
OUT = os.path.join(OUT_DIR, "claude-statusline.json")
MAX_SESSIONS = 200
STALE_SECONDS = 7 * 24 * 3600


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    sid = data.get("session_id")
    if not isinstance(sid, str) or not sid:
        return
    now = time.time()
    try:
        snap = json.load(open(OUT))
        if not isinstance(snap, dict):
            snap = {}
    except Exception:
        snap = {}

    contexts = snap.get("session_contexts") if isinstance(snap.get("session_contexts"), dict) else {}
    pct = num((data.get("context_window") or {}).get("used_percentage"))
    if pct is not None:
        contexts[sid] = {"used_percent": max(0, min(100, pct)),
                         "cache": {"session_id": sid, "last_activity_unix": now}}
        cost = num((data.get("cost") or {}).get("total_cost_usd"))
        if cost is not None:
            contexts[sid]["cost_usd"] = cost
        size = num((data.get("context_window") or {}).get("context_window_size"))
        if size is not None:
            contexts[sid]["window"] = size
        model = (data.get("model") or {}).get("display_name")
        if isinstance(model, str):
            contexts[sid]["model"] = model[:40]
    # drop stale sessions, keep the newest MAX_SESSIONS
    def last(c):
        return ((c or {}).get("cache") or {}).get("last_activity_unix") or 0
    contexts = {k: v for k, v in contexts.items() if now - last(v) < STALE_SECONDS}
    contexts = dict(sorted(contexts.items(), key=lambda kv: last(kv[1]), reverse=True)[:MAX_SESSIONS])

    windows = []
    rl = data.get("rate_limits") or {}
    for key, kind in (("five_hour", "five_hour"), ("seven_day", "weekly")):
        w = rl.get(key) or {}
        used = num(w.get("used_percentage"))
        if used is None:
            continue
        row = {"kind": kind, "used_percent": max(0, min(100, used))}
        reset = num(w.get("resets_at"))
        if reset is not None:
            row["resets_at"] = reset
        windows.append(row)
    if not windows and isinstance(snap.get("windows"), list):
        windows = snap["windows"]

    out = {"provider": "claude", "source": "claude-statusline", "fetched_at_unix": now,
           "windows": windows, "session_contexts": contexts}
    os.makedirs(OUT_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=OUT_DIR, prefix=".snap-")
    with os.fdopen(fd, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    os.replace(tmp, OUT)


if __name__ == "__main__":
    main()
