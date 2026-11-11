#!/usr/bin/env python3
"""What each agent is doing right now, for the agent board and agent toasts (shared lib). Local files only, no network.

Usage: live.py t8 t11 ...   -> {"t8": {...}, "t11": {...}}
Per Claude Code agent (terminal -> pid -> ~/.claude/sessions/<pid>.json -> transcript tail):
  task  : the last prompt you typed
  doing : the last tool call (name + target) / question it is asking / last reply line
  ctx, cost : from the status-line snapshot
Other programs: {"program": argv}. Secret-looking strings are redacted.
"""
import glob, json, os, re, subprocess, sys

HOME = os.path.expanduser("~")
SNAPSHOT = os.path.join(HOME, ".cache", "herdr-claude-status", "claude-statusline.json")
TAIL = 256 * 1024
SECRET = re.compile(r"(xox[abpr]-[\w-]+|gh[pousr]_\w{20,}|github_pat_\w+|sk-[\w-]{16,}|AKIA[0-9A-Z]{16}|(?i:bearer)\s+[\w.~+/=-]{12,}|(?i:(?:token|secret|password|api[_-]?key)=)\S+)")


INJECTED = re.compile(r"<(system-reminder|task-notification|agent-message|cross-session-message)\b[^>]*>.*?</\1>", re.S)


def human_text(c):
    """The user's own words: drop blocks the harness injects (reminders, notifications, peer messages)."""
    return INJECTED.sub("", c).strip()


def clean(s, n=120):
    s = SECRET.sub("[redacted]", " ".join(str(s).split())).replace(HOME, "~")
    return s[:n]


def target(name, inp):
    inp = inp or {}
    if name == "Bash":
        return inp.get("description") or inp.get("command") or ""
    if name == "AskUserQuestion":
        qs = inp.get("questions") or []
        return (qs[0].get("question") if qs and isinstance(qs[0], dict) else "") or ""
    for k in ("file_path", "path", "pattern", "url", "description", "skill", "query", "prompt"):
        if isinstance(inp.get(k), str):
            v = inp[k]
            return os.path.basename(v) if k in ("file_path", "path") else v
    return ""


def tail_records(path, tail=TAIL):
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        f.seek(max(0, size - tail))
        chunk = f.read().decode("utf-8", "replace")
    lines = chunk.split("\n")
    if size > tail:
        lines = lines[1:]  # first line is probably cut
    for line in lines:
        try:
            yield json.loads(line)
        except ValueError:
            continue


def claude_live(path):
    # Screenshots and big tool outputs can push the last prompt far back: widen the window until found.
    for tail in (TAIL, 2 * 1024 * 1024, 8 * 1024 * 1024):
        res = claude_live_tail(path, tail)
        if res["task"] or os.path.getsize(path) <= tail:
            return res
    return res


def claude_live_tail(path, tail):
    task = tool = text = None
    for r in tail_records(path, tail):
        if r.get("isSidechain"):
            continue
        m = r.get("message") or {}
        if r.get("type") == "user":
            c = m.get("content")
            if isinstance(c, list) and not any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
                c = " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
            c = human_text(c) if isinstance(c, str) else c
            if isinstance(c, str) and c and not r.get("isMeta") and not c.startswith("<local-command"):
                if c.startswith("<command-name>"):
                    c = c.split("<command-name>")[1].split("</command-name>")[0]
                task, tool, text = clean(c, 140), None, None
        elif r.get("type") == "assistant":
            for b in m.get("content") or []:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "tool_use":
                    name = b.get("name", "?")
                    short = name.split("__")[-1] if name.startswith("mcp__") else name
                    tool = {"name": short, "target": clean(target(name, b.get("input")), 90)}
                    text = None
                elif b.get("type") == "text" and b.get("text", "").strip():
                    first = next((l for l in b["text"].splitlines() if l.strip()), "")
                    text = clean(first, 140)
                    tool = None
    return {"task": task, "tool": tool, "text": text}


def main():
    try:
        snap = json.load(open(SNAPSHOT)).get("session_contexts") or {}
    except Exception:
        snap = {}
    result = {}
    for addr in sys.argv[1:17]:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", addr):
            continue
        info = {}
        try:
            r = subprocess.run(["hc", "get", addr, "--json"], capture_output=True, text=True, timeout=4)
            d = json.loads(r.stdout)
            fg = d.get("foreground") or {}
        except Exception:
            result[addr] = {"error": "unavailable"}
            continue
        info["cwd"] = (fg.get("cwd") or d.get("cwd") or "").replace(HOME, "~")
        pid = fg.get("pid")
        try:
            sess = json.load(open(os.path.join(HOME, ".claude", "sessions", "%d.json" % pid)))
        except Exception:
            import codexlog
            if codexlog.is_codex(fg):
                path = codexlog.find_rollout(pid, fg.get("cwd") or d.get("cwd"), d.get("created_ms"))
                if path:
                    try:
                        info.update(codexlog.live(path))
                    except OSError:
                        pass
                    result[addr] = info
                    continue
            info["program"] = " ".join(fg.get("argv") or [])[:40]
            result[addr] = info
            continue
        sid = sess.get("sessionId")
        s = snap.get(sid) or {}
        info.update({"session": sid, "ctx": s.get("used_percent"), "cost": s.get("cost_usd"), "model": s.get("model")})
        paths = glob.glob(os.path.join(HOME, ".claude", "projects", "*", "%s.jsonl" % sid))
        if paths:
            try:
                info.update(claude_live(paths[0]))
            except OSError:
                pass
        result[addr] = info
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
