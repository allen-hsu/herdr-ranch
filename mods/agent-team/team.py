#!/usr/bin/env python3
"""Who works with an agent, and what they said to each other. For the Herdr agent-team panel. Local only.

Usage: team.py <terminal address of the lead, e.g. t8>
Two kinds of teammates:
  herdr  : terminals the lead started with `hc run` (any agent: Claude Code, Codex, Grok, Cursor, Gemini...),
           found through hc's parent links, two levels deep. Status from hc, activity from live.py.
  sub    : Claude Code subagents (the Agent tool) inside the lead's own session (<session>/subagents/).
Timeline (from the lead's Claude Code transcript): spawns, the lead's messages (SendMessage, hc send / hc run),
replies (<agent-message>, <hc from>, <cross-session-message>) and completion notices.
Prints one JSON object. Secret-looking strings are redacted.
"""
import glob, json, os, re, subprocess, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import live  # noqa: E402  (shared lib, copied in by install.sh)

HOME = os.path.expanduser("~")
CACHE_DIR = os.path.join(HOME, ".cache", "herdr-claude-status")
VERSION = 8
red = live.clean
TAG = re.compile(r"<(agent-message|hc|cross-session-message)\b([^>]*)>(.*?)</\1>", re.S)
NOTE = re.compile(r"<task-notification>(.*?)</task-notification>", re.S)
ATTR = re.compile(r'([\w-]+)="([^"]*)"')
VERDICT = re.compile(r"VERDICT:\s*(APPROVE|CHANGES)", re.I)
HC_CMD = re.compile(r"(?:^|[;&|]\s*)hc\s+(run|send)\s+(?!-h\b|--help)([^\n;&|]*)", re.M)


def out(**kw):
    print(json.dumps(kw, ensure_ascii=False, separators=(",", ":")))
    sys.exit(0)


def ts(s):
    from datetime import datetime
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def hc_json(*args):
    try:
        return json.loads(subprocess.run(["hc", *args, "--json"], capture_output=True, text=True, timeout=5).stdout)
    except Exception:
        return None


def text_of(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    return ""


VALUE_OPTS = {"--name", "--cwd", "--on", "--label", "--parent", "--timeout"}


def first_program(rest):
    """The program or template an `hc run` starts: the first word that isn't an option."""
    words = rest.split()
    i = 0
    while i < len(words):
        w = words[i]
        if w in VALUE_OPTS:
            i += 2
            continue
        if w.startswith("-"):
            i += 1
            continue
        return w.strip("'\"")[:24]
    return None


def herdr_members(lead):
    terms = (hc_json("ls", "--all") or {}).get("terminals") or []
    by_parent = {}
    for t in terms:
        if t.get("parent"):
            by_parent.setdefault(t["parent"], []).append(t)
    res = []

    def add(parent, depth):
        for t in sorted(by_parent.get(parent, []), key=lambda x: x["address"]):
            g = hc_json("get", t["address"]) or {}
            tpl = g.get("template") or ""
            vendor = {"claude": "claude-code", "codex": "codex", "grok": "grok", "cursor": "cursor-agent", "gemini": "gemini"}.get(tpl.rsplit("-", 1)[-1]) if tpl else None
            m = {"kind": "herdr", "id": t["address"], "name": t.get("name") or t["address"], "parent": parent, "depth": depth,
                 "agent": vendor or t.get("agent"), "role": tpl.rsplit("-", 1)[0] if tpl else None, "state": t.get("state"), "status": t.get("status"), "turn": t.get("turn"),
                 "template": g.get("template"), "title": red(g.get("title") or "", 80), "started": (g.get("created_ms") or 0) / 1000 or None,
                 "ended": (g.get("finished_ms") or 0) / 1000 or None, "exit": g.get("exit_code"), "where": red(t.get("where") or "", 60)}
            if t.get("state") == "live":
                info = live.info_for(t["address"])
                m.update({k: info.get(k) for k in ("task", "tool", "text", "ctx", "cost", "model", "program")})
                if not info.get("session"):
                    m["screen"] = screen_tail(t["address"])
            res.append(m)
            if depth < 2:
                add(t["address"], depth + 1)
    add(lead, 1)
    return res


def lead_session(lead):
    g = hc_json("get", lead) or {}
    pid = (g.get("foreground") or {}).get("pid")
    try:
        sess = json.load(open(os.path.join(HOME, ".claude", "sessions", "%d.json" % pid)))
    except Exception:
        return g, None, None
    paths = glob.glob(os.path.join(HOME, ".claude", "projects", "*", "%s.jsonl" % sess.get("sessionId")))
    return g, sess, (paths[0] if paths else None)


def recent_steps(records, n=8):
    """The last n tool calls (name + target) in a Claude transcript tail."""
    steps = []
    for r in records:
        if r.get("type") != "assistant":
            continue
        for b in (r.get("message") or {}).get("content") or []:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                nm = b.get("name", "?")
                steps.append({"tool": nm.split("__")[-1] if nm.startswith("mcp__") else nm, "target": red(live.target(nm, b.get("input")), 90)})
    return steps[-n:]


def screen_tail(addr, n=12):
    """Last lines of a terminal's screen, for agents whose transcripts we can't read (Codex, Grok, ...)."""
    try:
        r = subprocess.run(["hc", "read", "--lines", "0", addr], capture_output=True, text=True, timeout=4)
    except Exception:
        return []
    lines = [red(l.strip(" │╭╮╰╯─"), 140) for l in r.stdout.splitlines()]
    return [l for l in lines if l][-n:]


def subagents(path):
    sid = os.path.basename(path)[:-6]
    res = []
    cache_file = os.path.join(CACHE_DIR, "team-subs-%s.json" % sid)
    try:
        old = json.load(open(cache_file))
        old = old if old.get("v") == VERSION else {}
    except Exception:
        old = {}
    new = {"v": VERSION}
    for meta in glob.glob(os.path.join(os.path.dirname(path), sid, "subagents", "*.meta.json")):
        try:
            mj = json.load(open(meta))
        except Exception:
            continue
        jl = meta[: -len(".meta.json")] + ".jsonl"
        try:
            st = os.stat(jl)
            key = [st.st_size, st.st_mtime, bool(mj.get("finished"))]
        except OSError:
            key = None
        hit = old.get(jl)
        if key and hit and hit.get("key") == key:
            new[jl] = hit
            res.append(hit["m"])
            continue
        aid = os.path.basename(jl)[:-6]
        aid = aid[6:] if aid.startswith("agent-") else aid
        m = {"kind": "sub", "id": aid, "name": red(mj.get("description") or mj.get("agentType") or aid, 60), "agent": "claude-code",
             "type": mj.get("agentType"), "background": mj.get("requestShape") == "background", "depth": mj.get("spawnDepth") or 1,
             "state": "finished" if mj.get("finished") else "live", "status": "done" if mj.get("finished") else "working",
             "tool_use": mj.get("toolUseId")}
        try:
            m["ended"] = st.st_mtime if mj.get("finished") else None
            m["last"] = st.st_mtime
            with open(jl, encoding="utf-8", errors="replace") as f:
                first = f.readline()
            m["started"] = ts(json.loads(first).get("timestamp") or "") if first else None
            m.update({k: v for k, v in live.claude_live(jl).items() if k in ("tool", "text")})
            outs = 0
            recs = live.tail_records(jl, 1 << 22)
            m["steps"] = recent_steps(recs)
            for line in recs:
                u = ((line.get("message") or {}).get("usage") or {}) if line.get("type") == "assistant" else {}
                outs += u.get("output_tokens") or 0
            m["out"] = outs
        except Exception:
            pass
        res.append(m)
        if key:
            new[jl] = {"key": key, "m": m}
    try:
        fd, tmp = tempfile.mkstemp(dir=CACHE_DIR, prefix=".team-")
        with os.fdopen(fd, "w") as f:
            json.dump(new, f)
        os.replace(tmp, cache_file)
    except OSError:
        pass
    res.sort(key=lambda m: m.get("started") or 0)
    return res


def timeline(path, names):
    """names: id -> display name. Returns newest-first events and per-member message counts."""
    ev, counts = [], {}
    agent_of_tool = {}  # Agent tool_use id -> agent id (from its result)

    def bump(who, k):
        c = counts.setdefault(who, {"to": 0, "from": 0})
        c[k] += 1

    for line in open(path, encoding="utf-8", errors="replace"):
        if '"tool_use"' not in line and "<agent-message" not in line and "<hc " not in line and "<hc>" not in line and "task-notification" not in line \
                and "cross-session-message" not in line and '"tool_result"' not in line:
            continue
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get("isSidechain"):
            continue
        at = ts(r.get("timestamp") or "")
        m = r.get("message") or {}
        if r.get("type") == "assistant":
            for b in m.get("content") or []:
                if not isinstance(b, dict) or b.get("type") != "tool_use":
                    continue
                n, i = b.get("name"), b.get("input") or {}
                if n in ("Agent", "Task"):
                    ev.append({"at": at, "k": "spawn", "who": None, "tool": b.get("id"), "agent": i.get("subagent_type") or "general-purpose",
                               "text": red(i.get("description") or "", 80), "bg": bool(i.get("run_in_background")),
                               "prompt": red(i.get("prompt") or "", 900)})
                elif n == "SendMessage":
                    to = str(i.get("to") or i.get("recipient") or "")
                    who = to.split("/")[-1].replace(".sock", "") if to.startswith("uds:") else to
                    kind = "session" if to.startswith("uds:") else "sub"
                    ev.append({"at": at, "k": "to", "who": who, "via": kind, "text": red(i.get("summary") or i.get("message") or "", 140),
                               "full": red(i.get("message") or i.get("summary") or "", 1200)})
                    bump(who, "to")
                elif n == "Bash":
                    cmd = str(i.get("command") or "")
                    mm = HC_CMD.search(cmd)
                    if mm:
                        rest = mm.group(2).strip()
                        name = re.search(r"--name[ =](\S+)", rest)
                        tgt = name.group(1) if name else first_program(rest) if mm.group(1) == "run" else next((w for w in rest.split() if not w.startswith("-")), None)
                        ev.append({"at": at, "k": "hc-" + mm.group(1), "who": tgt, "via": "herdr",
                                   "text": red(i.get("description") or rest, 140), "prompt": red(rest, 900)})
                        if tgt:
                            bump(tgt, "to")
        elif r.get("type") in ("user", "attachment"):
            att = r.get("attachment") if isinstance(r.get("attachment"), dict) else {}
            if r.get("type") == "attachment" and att.get("type") != "queued_command":
                continue  # reports that arrive while the lead is busy are queued_command attachments
            tur = r.get("toolUseResult") if isinstance(r.get("toolUseResult"), dict) else {}
            if tur.get("agentId"):
                for b in m.get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        agent_of_tool[b.get("tool_use_id")] = tur["agentId"]
            s = att.get("prompt") or "" if att else text_of(m.get("content"))
            for tag, attrs, body in TAG.findall(s):
                a = dict(ATTR.findall(attrs))
                body = re.sub(r"^\s*\[Subagent hand-back\][^\n]*\n+", "", body)
                body = re.sub(r"(^|\n)\s*#{1,6}\s*|\*\*|`", " ", body)  # markdown marks read badly in one line
                if tag == "agent-message":
                    who, via = a.get("from", "?"), "sub"
                elif tag == "hc" and not a.get("from"):
                    # hc's own notice about a member: "<t> <name> exited (exit 0). Last lines: ..."
                    w = body.strip().split()
                    who = w[1] if len(w) > 1 and re.fullmatch(r"(\w+/)?t\w+", w[0]) else (w[0] if w else "?")
                    stt = re.search(r"\b(exited|blocked|errored|error|finished)\b", body)
                    ev.append({"at": at, "k": "note", "who": who, "via": "herdr", "status": stt.group(1) if stt else "",
                               "text": red(" ".join(w[2:]) if len(w) > 2 else body, 140)})
                    continue
                elif tag == "hc":
                    frm = a.get("from", "?").split()
                    who, via = (frm[1] if len(frm) > 1 else frm[0]) if frm else "?", "herdr"
                    names.setdefault(who, a.get("from", who))
                else:
                    who, via = a.get("from", "?").split("/")[-1].replace(".sock", ""), "session"
                    names.setdefault(who, a.get("from-name") or who)
                ev.append({"at": at, "k": "from", "who": who, "via": via, "text": red(body, 160), "full": red(body, 1200)})
                bump(who, "from")
            for body in NOTE.findall(s):
                tid = re.search(r"<task-id>(.*?)</task-id>", body)
                stt = re.search(r"<status>(.*?)</status>", body)
                summ = re.search(r"<summary>(.*?)</summary>", body, re.S)
                if not tid or tid.group(1) not in names:
                    continue  # a background shell or other task, not a teammate
                ev.append({"at": at, "k": "note", "who": tid.group(1), "via": "sub",
                           "status": stt.group(1) if stt else "", "text": red(summ.group(1) if summ else "", 140)})
    for e in ev:
        if e["k"] == "spawn":
            e["who"] = agent_of_tool.get(e.pop("tool"))
        else:
            e.pop("tool", None)
        e["name"] = names.get(e.get("who"), e.get("who"))
    for e in ev:
        v = VERDICT.search(e.get("full") or e.get("text") or "")
        if v:
            e["verdict"] = v.group(1).upper()
    merged = []
    for e in ev:
        p = merged[-1] if merged else None
        if p and p["k"] == e["k"] and p.get("who") == e.get("who") and p["text"] == e["text"]:
            p["times"] = p.get("times", 1) + 1
            p["at"] = e["at"]
        else:
            merged.append(e)
    return merged[-150:][::-1], counts


def terminal_of_pid():
    """pid -> live terminal address (Claude sessions are keyed by their pid)."""
    res = {}
    for t in (hc_json("ls") or {}).get("terminals") or []:
        g = hc_json("get", t["address"]) or {}
        pid = (g.get("foreground") or {}).get("pid")
        if pid:
            res[str(pid)] = t["address"]
    return res


def sessions_by_pid():
    res = {}
    for f in glob.glob(os.path.join(HOME, ".claude", "sessions", "*.json")):
        try:
            d = json.load(open(f))
            res[os.path.basename(f)[:-5]] = d.get("name") or os.path.basename(d.get("cwd") or "") or d.get("sessionId", "")[:8]
        except Exception:
            pass
    return res


def main():
    if len(sys.argv) < 2 or not re.fullmatch(r"[A-Za-z0-9_-]+", sys.argv[1]):
        out(ok=False, error="usage")
    lead = sys.argv[1]
    g, sess, path = lead_session(lead)
    members = herdr_members(lead)
    subs, events, counts = [], [], {}
    if path:
        st = os.stat(path)
        os.makedirs(CACHE_DIR, mode=0o700, exist_ok=True)
        cache = os.path.join(CACHE_DIR, "team-%s.json" % os.path.basename(path)[:-6])
        sub_dir = os.path.join(os.path.dirname(path), os.path.basename(path)[:-6], "subagents")
        sub_m = max([os.stat(p).st_mtime for p in glob.glob(sub_dir + "/*")] or [0])
        key = [VERSION, st.st_size, st.st_mtime, sub_m]
        data = None
        try:
            c = json.load(open(cache))
            data = c["data"] if c.get("key") == key else None
        except Exception:
            pass
        if data is None:
            subs = subagents(path)
            names = {s["id"]: s["name"] for s in subs}
            names.update({m["id"]: m["name"] for m in members})
            names.update({m["name"]: m["name"] for m in members})
            names.update(sessions_by_pid())
            events, counts = timeline(path, names)
            data = {"subs": subs, "events": events, "counts": counts}
            fd, tmp = tempfile.mkstemp(dir=CACHE_DIR, prefix=".team-")
            with os.fdopen(fd, "w") as f:
                json.dump({"key": key, "data": data}, f)
            os.replace(tmp, cache)
        subs, events, counts = data["subs"], data["events"], data["counts"]
    for m in members + subs:
        c = counts.get(m["id"]) or counts.get(m["name"]) or {}
        m["msgs_to"], m["msgs_from"] = c.get("to", 0), c.get("from", 0)
    sessions = sorted({e["who"] for e in events if e.get("via") == "session" and e.get("who")})
    tp = terminal_of_pid() if sessions else {}
    out(ok=True, lead={"id": lead, "name": (sess or {}).get("name") or g.get("title") or lead, "agent": (g.get("foreground") or {}).get("argv", [""])[0],
                       "status": g.get("status"), "claude": bool(path)},
        herdr=members, subs=subs, events=events,
        sessions=[{"id": s, "name": sessions_by_pid().get(s, s), "addr": tp.get(s)} for s in sessions])


if __name__ == "__main__":
    main()
