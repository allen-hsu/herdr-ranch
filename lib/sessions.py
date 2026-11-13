#!/usr/bin/env python3
"""Past Claude Code and Codex conversations started in a folder, for "Resume a conversation…" (command bar).
Local files only, no network. Shared lib (herdr-ranch/lib): install.sh copies it into each mod that lists it.

  sessions.py list <dir> [<dir> ...]   -> [{"provider", "id", "open", "cwd", "sub", "at", "title", "first", "last"}], newest first
  Conversations in the folder and in folders under it (worktrees such as .claude/worktrees/<name>, subfolders).
  cwd: the folder it ran in (`claude --resume` finds a conversation only from there); sub: cwd relative to the
  folder asked about, when it is under it.

Claude Code: ~/.claude/projects/<dir with every non-alphanumeric as "-">/<session>.jsonl (shared by every added
account: lib/accounts.py links "projects" back to ~/.claude). Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl,
whose first record (session_meta) names its folder ("sessions" is shared the same way).
Only the head and tail of each file are read: the first and last thing the person typed, and the name the
conversation was given (/rename). One still open in a Claude Code process is listed with "open": where it runs
("claude-desktop", "cli", ...), since resuming it a second time makes two writers.
"""
import glob, json, os, re, sys

HOME = os.path.expanduser("~")
CLAUDE = os.path.join(HOME, ".claude")
CODEX = os.path.join(HOME, ".codex", "sessions")
UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
SECRET = re.compile(r"(xox[abpr]-[\w-]+|gh[pousr]_\w{20,}|github_pat_\w+|sk-[\w-]{16,}|AKIA[0-9A-Z]{16}|(?i:bearer)\s+[\w.~+/=-]{12,}|(?i:(?:token|secret|password|api[_-]?key)=)\S+)")
CODEX_INJECTED = ("# AGENTS.md instructions", "<environment_context>", "<user_instructions>", "<permissions", "<skills_instructions>", "<turn_aborted>")
HEAD, TAIL, LIMIT, CODEX_SCAN = 256 * 1024, 256 * 1024, 40, 3000


def red(s, n=200):
    return SECRET.sub("[redacted]", " ".join(str(s or "").split()))[:n]


def lines(path, tail=False):
    """The records in the first (or last) 256 KB of a file; a cut line at the edge is skipped."""
    try:
        with open(path, "rb") as f:
            size = os.path.getsize(path)
            if tail:
                f.seek(max(0, size - TAIL))
                if size > TAIL:
                    f.readline()
                data = f.read()
            else:
                data = f.read(HEAD)
    except OSError:
        return []
    out = []
    for raw in data.splitlines():
        try:
            out.append(json.loads(raw.decode("utf-8", "replace")))
        except ValueError:
            continue
    return out


# ---------- Claude Code ----------

def claude_prompt(r):
    """What the person typed in a Claude Code record, or None (tool results, slash-command echoes, injected text)."""
    if r.get("type") != "user" or r.get("isMeta") or r.get("isSidechain"):
        return None
    c = (r.get("message") or {}).get("content")
    if isinstance(c, list):
        c = " ".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
    c = (c or "").strip() if isinstance(c, str) else ""
    # A slash command with arguments reads as typed ("/review the cart PR"); a bare one (/clear, /model) is no prompt.
    cmd = re.search(r"<command-name>(.*?)</command-name>", c, re.S)
    if cmd:
        args = re.search(r"<command-args>(.*?)</command-args>", c, re.S)
        args = args.group(1).strip() if args else ""
        return f"{cmd.group(1).strip()} {args}" if args else None
    return None if not c or c.startswith(("<", "Caveat:", "[Request interrupted")) else c


def running_claude():
    """{session id: entrypoint} of Claude Code processes alive now (~/.claude/sessions/<pid>.json, also added accounts)."""
    dirs = [os.path.join(CLAUDE, "sessions")] + glob.glob(os.path.join(HOME, ".config", "herdr-app", "ranch", "accounts", "*", "sessions"))
    live = {}
    for d in dirs:
        for p in glob.glob(os.path.join(d, "*.json")):
            try:
                pid = int(os.path.basename(p)[:-5])
                os.kill(pid, 0)
                with open(p) as f:
                    rec = json.load(f)
                sid = rec.get("sessionId")
            except Exception:  # not a pid file, the process is gone, or the file is half written
                continue
            if isinstance(sid, str):
                live[sid] = str(rec.get("entrypoint") or "cli")
    return live


def inside(cwd, dirs):
    """The folder of `dirs` that cwd is in or under (a worktree, a subfolder), else None."""
    return next((d for d in sorted(dirs, key=len, reverse=True) if cwd == d or cwd.startswith(d.rstrip("/") + "/")), None) if cwd else None


def row(provider, sid, cwd, dirs, path, first, last, name=None, open_in=None):
    top = inside(cwd, dirs)
    return {"provider": provider, "id": sid, "open": open_in, "cwd": cwd, "sub": os.path.relpath(cwd, top) if cwd != top else None,
            "at": int(os.path.getmtime(path) * 1000), "title": red(name or first, 80), "first": red(first),
            "last": red(last) if last and last != first else None}


def claude(dirs):
    live, out = running_claude(), []
    # A folder's own conversations, and those of folders under it (its worktrees too): their encoded names start
    # with its own. "-" stands for any non-alphanumeric, so each file's own cwd decides.
    enc = {re.sub(r"[^A-Za-z0-9]", "-", d) for d in dirs}
    root = os.path.join(CLAUDE, "projects")
    try:
        folders = [f for f in os.listdir(root) if any(f == e or f.startswith(e + "-") for e in enc)]
    except OSError:
        folders = []
    paths = [p for f in folders for p in glob.glob(os.path.join(root, f, "*.jsonl"))]
    for path in sorted(paths, key=os.path.getmtime, reverse=True):
        if len(out) >= LIMIT:
            break
        sid = os.path.basename(path)[:-6]
        if not UUID.fullmatch(sid):
            continue
        head = lines(path)
        cwd = next((r["cwd"] for r in head if isinstance(r.get("cwd"), str)), None)
        if cwd is None and os.path.basename(os.path.dirname(path)) in enc:
            cwd = next(d for d in dirs if re.sub(r"[^A-Za-z0-9]", "-", d) == os.path.basename(os.path.dirname(path)))
        if not inside(cwd, dirs):
            continue
        first = next((p for p in map(claude_prompt, head) if p), None)
        if not first:
            continue  # nothing was ever asked: nothing to resume
        tail = lines(path, tail=True) if os.path.getsize(path) > HEAD else head
        last = next((p for p in map(claude_prompt, reversed(tail)) if p), None)
        name = next((r.get("agentName") or r.get("customTitle") for r in reversed(head + tail)
                     if r.get("type") in ("agent-name", "custom-title") and (r.get("agentName") or r.get("customTitle"))), None)
        out.append(row("claude", sid, cwd, dirs, path, first, last, name, live.get(sid)))
    return out


# ---------- Codex ----------

def codex_prompt(r):
    p = r.get("payload") or {}
    if r.get("type") != "response_item" or p.get("type") != "message" or p.get("role") != "user":
        return None
    t = " ".join(c.get("text", "") for c in (p.get("content") or []) if isinstance(c, dict) and c.get("type") in ("input_text", "text")).strip()
    return None if not t or t.startswith(CODEX_INJECTED) else t


def codex(dirs):
    out = []
    files = sorted(glob.glob(os.path.join(CODEX, "*", "*", "*", "rollout-*.jsonl")), key=os.path.getmtime, reverse=True)[:CODEX_SCAN]
    for path in files:
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                meta = json.loads(f.readline()).get("payload") or {}
        except Exception:
            continue
        if not isinstance(meta.get("cwd"), str) or not inside(meta["cwd"], dirs):
            continue
        m = UUID.search(os.path.basename(path))
        sid = meta.get("id") if isinstance(meta.get("id"), str) and UUID.fullmatch(meta["id"]) else (m.group(0) if m else None)
        if not sid:
            continue
        head = lines(path)
        first = next((p for p in map(codex_prompt, head) if p), None)
        if not first:
            continue
        tail = lines(path, tail=True) if os.path.getsize(path) > HEAD else head
        last = next((p for p in map(codex_prompt, reversed(tail)) if p), None)
        out.append(row("codex", sid, meta["cwd"], dirs, path, first, last))
        if len(out) >= LIMIT:
            break
    return out


def cmd_list(dirs):
    want = set()
    for d in dirs:
        d = os.path.abspath(os.path.expanduser(d)).rstrip("/") or "/"
        want.update({d, os.path.realpath(d)})
    rows = claude(want) + codex(want)
    return sorted(rows, key=lambda r: -r["at"])[:LIMIT]


def main(argv):
    if len(argv) >= 2 and argv[0] == "list":
        print(json.dumps(cmd_list([a for a in argv[1:] if a]), ensure_ascii=False))
        return 0
    print(json.dumps({"error": "usage: list <dir> [<dir> ...]"}))
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
