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
import glob, json, mmap, os, re, sys
import codexlog
import live

HOME = os.path.expanduser("~")
CLAUDE = os.path.join(HOME, ".claude")
CODEX = os.path.join(HOME, ".codex", "sessions")
UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
# What Claude Code itself echoes into a user record (local command output, ! shell runs, hook text): no prompt.
ECHO = re.compile(r"<(local-command-|bash-|command-|user-prompt-submit-hook)")
HEAD, LIMIT, CODEX_SCAN = 256 * 1024, 40, 3000
LINE_MAX = 32 * 1024 * 1024  # a record longer than this (many large pasted images) is skipped, not parsed
SCAN_MAX = 64 * 1024 * 1024  # how far into a file the head may go when it keeps skipping such records
TAILS = (256 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024)  # widened until the last prompt shows up (as live.py does)
META = 16 * 1024  # of a Codex rollout's first line: enough for its id and cwd, not its full instructions
NAME_TAIL, NAME_HEAD, NAME_LINE = 16 * 1024 * 1024, 1024 * 1024, 64 * 1024  # where a name is looked for, and how long its record may be
NAMES = (b'"type":"custom-title"', b'"type":"agent-name"')  # as written, so text quoting them (escaped) never matches


def red(s, n=200):
    return codexlog.red(s, n)  # secrets masked, home shown as ~


def newest(paths):
    """[(mtime, path)] newest first. A file removed meanwhile (Claude Code's cleanup, a person tidying up) drops out."""
    out = []
    for p in paths:
        try:
            out.append((os.path.getmtime(p), p))
        except OSError:
            continue
    return sorted(out, reverse=True)


def head_lines(f):
    """Whole lines from the start until 256 KB are kept. A line is never cut: a first message with a pasted image
    (base64, often over 256 KB) is still read whole; only one over LINE_MAX is passed over, and reading goes on
    (up to SCAN_MAX in all)."""
    out, kept, scanned = [], 0, 0
    while kept < HEAD and scanned < SCAN_MAX:
        raw = f.readline(LINE_MAX)
        if not raw:
            break
        scanned += len(raw)
        if not raw.endswith(b"\n") and len(raw) == LINE_MAX:  # too long to keep: skip to its end, not counted as head
            more = b""
            while scanned < SCAN_MAX and (more := f.readline(LINE_MAX)) and not more.endswith(b"\n"):
                scanned += len(more)
            scanned += len(more or b"")
            continue
        kept += len(raw)
        out.append(raw)
    return out


def lines(path, tail=None):
    """The records at the start of a file (head_lines), or in its last `tail` bytes; a cut line at the edge is skipped."""
    try:
        with open(path, "rb") as f:
            if tail:
                size = os.fstat(f.fileno()).st_size
                f.seek(max(0, size - tail))
                if size > tail:
                    f.readline()
                data = f.read().splitlines()
            else:
                data = head_lines(f)
    except OSError:
        return []
    out = []
    for raw in data:
        try:
            rec = json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            continue
        if isinstance(rec, dict):  # a stray string, list or null on a line is not a record
            out.append(rec)
    return out


# ---------- Claude Code ----------

def claude_prompt(r):
    """What the person typed in a Claude Code record, or None (tool results, slash-command echoes, injected text)."""
    if r.get("type") != "user" or r.get("isMeta") or r.get("isSidechain"):
        return None
    c = (r.get("message") or {}).get("content")
    if isinstance(c, list):
        c = " ".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
    c = live.human_text(c) if isinstance(c, str) else ""
    # A slash command with arguments reads as typed ("/review the cart PR"); a bare one (/clear, /model) is no prompt.
    cmd = re.search(r"<command-name>(.*?)</command-name>", c, re.S)
    if cmd:
        args = re.search(r"<command-args>(.*?)</command-args>", c, re.S)
        args = args.group(1).strip() if args else ""
        return f"{cmd.group(1).strip()} {args}" if args else None
    return None if not c or ECHO.match(c) or c.startswith(("Caveat:", "[Request interrupted")) else c


def running_claude():
    """{session id: entrypoint} of Claude Code processes alive now (~/.claude/sessions/<pid>.json, also added accounts)."""
    dirs = [os.path.join(CLAUDE, "sessions")] + glob.glob(os.path.join(HOME, ".config", "herdr-app", "ranch", "accounts", "*", "sessions"))
    found = {}
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
                found[sid] = str(rec.get("entrypoint") or "cli")
    return found


def inside(cwd, dirs):
    """The folder of `dirs` that cwd is in or under (a worktree, a subfolder), else None."""
    return next((d for d in sorted(dirs, key=len, reverse=True) if cwd == d or cwd.startswith(d.rstrip("/") + "/")), None) if cwd else None


def last_prompt(path, head, prompt):
    """The last thing the person typed: the tail is widened until one shows up, then the head is the answer."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return None
    if size <= HEAD:
        return next((p for p in map(prompt, reversed(head)) if p), None)
    for tail in TAILS:
        last = next((p for p in map(prompt, reversed(lines(path, tail))) if p), None)
        if last or tail >= size:
            return last
    return next((p for p in map(prompt, reversed(head)) if p), None)


def given_name(path):
    """The latest /rename (custom-title) or agent name: a byte search over the end of the file (the latest one is
    there), then over its start. Never the whole of a long transcript: they run to hundreds of MB, and up to 40
    are listed each time the list opens."""
    try:
        with open(path, "rb") as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
            size = len(mm)
            tail_from = max(0, size - NAME_TAIL)
            for lo, hi in ((tail_from, size), (0, min(NAME_HEAD, tail_from))):
                end = hi
                while end > lo:
                    at = max(mm.rfind(k, lo, end) for k in NAMES)  # the one written last first
                    if at < 0:
                        break
                    end = at  # always moves back
                    floor = max(0, at - NAME_LINE)
                    nl, stop = mm.rfind(b"\n", floor, at), mm.find(b"\n", at, min(size, at + NAME_LINE))
                    if (nl < 0 and floor > 0) or (stop < 0 and size - at > NAME_LINE):
                        continue  # inside a long record (quoted text), not a short record of its own
                    start = nl + 1
                    try:
                        r = json.loads(mm[start:stop if stop >= 0 else size].decode("utf-8", "replace"))
                    except ValueError:
                        continue
                    v = (r.get("customTitle") or r.get("agentName")) if isinstance(r, dict) else None
                    if v and isinstance(v, str):
                        return v
    except (OSError, ValueError):  # gone, or empty (mmap refuses an empty file)
        pass
    return None


def row(provider, sid, cwd, dirs, at, first, last, name=None, open_in=None):
    top = inside(cwd, dirs)
    return {"provider": provider, "id": sid, "open": open_in, "cwd": cwd, "sub": os.path.relpath(cwd, top) if cwd != top else None,
            "at": int(at * 1000), "title": red(name or first, 80), "first": red(first),
            "last": red(last) if last and last != first else None}


def encode(d):
    """A folder as Claude Code names its projects/ entry: every non-alphanumeric becomes "-"."""
    return re.sub(r"[^A-Za-z0-9]", "-", d)


def launch_folder(path, head, dirs):
    """Where the conversation was started: `claude --resume` looks it up under projects/<that folder, encoded>, so
    a record's cwd counts only when it encodes to the folder the file is in (a `cd` mid-session moves later cwds)."""
    stored = os.path.basename(os.path.dirname(path))
    cwds = [r["cwd"] for r in head if isinstance(r.get("cwd"), str)]
    return next((c for c in cwds if encode(c) == stored), None) or next((d for d in dirs if encode(d) == stored), None) \
        or (cwds[0] if cwds else None)


def claude(dirs):
    running, out = running_claude(), []
    # A folder's own conversations, and those of folders under it (its worktrees too): their encoded names start
    # with its own. "-" stands for any non-alphanumeric, so each file's own cwd decides.
    enc = {encode(d) for d in dirs}
    root = os.path.join(CLAUDE, "projects")
    try:
        folders = [f for f in os.listdir(root) if any(f == e or f.startswith(e + "-") for e in enc)]
    except OSError:
        folders = []
    paths = [p for f in folders for p in glob.glob(os.path.join(root, f, "*.jsonl"))]
    for at, path in newest(paths):
        if len(out) >= LIMIT:
            break
        sid = os.path.basename(path)[:-6]
        if not UUID.fullmatch(sid):
            continue
        head = lines(path)
        cwd = launch_folder(path, head, dirs)
        if not inside(cwd, dirs) or not os.path.isdir(cwd):
            continue  # elsewhere, or its folder is gone (a removed worktree): Claude Code resumes only from there
        first = next((p for p in map(claude_prompt, head) if p), None)
        if not first:
            continue  # nothing was ever asked: nothing to resume
        last = last_prompt(path, head, claude_prompt)
        out.append(row("claude", sid, cwd, dirs, at, first, last, given_name(path), running.get(sid)))
    return out


# ---------- Codex ----------

def codex_prompt(r):
    return codexlog.user_prompt(r.get("payload") or {})


def codex_meta(path):
    """The id and cwd of a rollout's session_meta, read from the first 16 KB only: the line goes on with the full
    instructions (tens of KB), and thousands of files are looked at."""
    try:
        with open(path, "rb") as f:
            data = f.readline(META)
    except OSError:
        return {}
    try:
        rec = json.loads(data.decode("utf-8", "replace"))
        payload = rec.get("payload") if isinstance(rec, dict) else None
        return payload if isinstance(payload, dict) else {}
    except ValueError:  # cut short: id and cwd come before the instructions
        pass
    text, meta = data.decode("utf-8", "replace"), {}
    for key, pat in (("id", r'"id"\s*:\s*("[^"]*")'), ("cwd", r'"cwd"\s*:\s*("(?:[^"\\]|\\.)*")')):
        m = re.search(pat, text)
        if m:
            try:
                meta[key] = json.loads(m.group(1))
            except ValueError:
                pass
    return meta


def codex(dirs):
    out = []
    files = newest(glob.glob(os.path.join(CODEX, "*", "*", "*", "rollout-*.jsonl")))[:CODEX_SCAN]
    for at, path in files:
        meta = codex_meta(path)
        if not isinstance(meta.get("cwd"), str) or not inside(meta["cwd"], dirs) or not os.path.isdir(meta["cwd"]):
            continue  # elsewhere, or its folder is gone: the new tab would have nowhere to open
        m = UUID.search(os.path.basename(path))
        sid = meta.get("id") if isinstance(meta.get("id"), str) and UUID.fullmatch(meta["id"]) else (m.group(0) if m else None)
        if not sid:
            continue
        head = lines(path)
        first = next((p for p in map(codex_prompt, head) if p), None)
        if not first:
            continue
        last = last_prompt(path, head, codex_prompt)
        out.append(row("codex", sid, meta["cwd"], dirs, at, first, last))
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
