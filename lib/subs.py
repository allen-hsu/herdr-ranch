#!/usr/bin/env python3
"""Claude Code background work that is running right now, per terminal: background subagents (the Agent tool)
and background shell commands (Bash with run_in_background: waiting on a Codex job, a build, a server...).
Usage: subs.py t8 t13 ...  ->  {"t8": [{"id", "desc", "type", "kind": "sub" | "shell", "started", "last"}], ...}
Running = its meta.json says not finished and its transcript changed in the last 30 minutes (a crashed one that
never wrote "finished" drops off). Local files only. Shared lib (herdr-ranch/lib)."""
import glob, json, os, re, subprocess, sys, time
import accounts

HOME = os.path.expanduser("~")
FRESH = 30 * 60


def transcript(addr):
    try:
        g = json.loads(subprocess.run(["hc", "get", addr, "--json"], capture_output=True, text=True, timeout=4).stdout)
        pid = (g.get("foreground") or {}).get("pid")
        sid = accounts.session(pid).get("sessionId")  # also agents started under another account folder
    except Exception:
        return None
    if not sid:
        return None
    paths = glob.glob(os.path.join(HOME, ".claude", "projects", "*", "%s.jsonl" % sid))
    return paths[0] if paths else None


def running(path):
    sid = os.path.basename(path)[:-6]
    out, now = [], time.time()
    for meta in glob.glob(os.path.join(os.path.dirname(path), sid, "subagents", "*.meta.json")):
        try:
            mj = json.load(open(meta))
            jl = meta[: -len(".meta.json")] + ".jsonl"
            last = os.stat(jl).st_mtime
        except Exception:
            continue
        if mj.get("finished") or now - last > FRESH:
            continue
        aid = os.path.basename(jl)[:-6]
        aid = aid[6:] if aid.startswith("agent-") else aid
        desc = " ".join(str(mj.get("description") or mj.get("agentType") or aid).split())[:80]
        out.append({"id": aid, "desc": desc, "type": mj.get("agentType"), "started": os.stat(meta).st_mtime, "last": last})
    return sorted(out, key=lambda s: s["started"])


TAIL = 4 * 1024 * 1024
SHELL_MAX = 6 * 3600  # a background command older than this with no end recorded: assume it is gone


def shells(path):
    """Background shell commands the session started and has not been told are finished. Started: a tool result
    carrying backgroundTaskId. Finished: a later record that names that task id (its task notification)."""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            f.seek(max(0, size - TAIL))
            if size > TAIL:
                f.readline()
            lines = f.read().decode("utf-8", "replace").split("\n")
    except OSError:
        return []
    desc, live, now = {}, {}, time.time()
    for line in lines:
        if '"backgroundTaskId"' in line or '"run_in_background"' in line:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            msg = r.get("message") or {}
            content = msg.get("content") if isinstance(msg.get("content"), list) else []
            if r.get("type") == "assistant":
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") == "Bash" and (b.get("input") or {}).get("run_in_background"):
                        desc[b.get("id")] = " ".join(str((b.get("input") or {}).get("description") or "background command").split())[:80]
                continue
            tur = r.get("toolUseResult")
            tid = tur.get("backgroundTaskId") if isinstance(tur, dict) else None
            if isinstance(tid, str) and re.fullmatch(r"[A-Za-z0-9_-]{4,40}", tid):
                use = next((b.get("tool_use_id") for b in content if isinstance(b, dict) and b.get("type") == "tool_result"), None)
                try:
                    at = time.mktime(time.strptime((r.get("timestamp") or "")[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
                except ValueError:
                    at = now
                live[tid] = {"id": tid, "desc": desc.get(use, "background command"), "type": "shell", "kind": "shell", "started": at, "last": at}
            continue
        if live and "task-id" in line:
            for tid in [t for t in live if ("<task-id>%s</task-id>" % t) in line]:
                del live[tid]
    return sorted((v for v in live.values() if now - v["started"] < SHELL_MAX), key=lambda v: v["started"])


def main():
    res = {}
    for addr in sys.argv[1:33]:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", addr):
            continue
        p = transcript(addr)
        res[addr] = (running(p) + shells(p)) if p else []
        # Which account the agent runs under (also when a plain `claude` was started by the shell hook).
        try:
            g = json.loads(subprocess.run(["hc", "get", addr, "--json"], capture_output=True, text=True, timeout=4).stdout)
            acct = accounts.account_of_session((g.get("foreground") or {}).get("pid"))
            if acct != "default":
                res.setdefault("_accounts", {})[addr] = acct
        except Exception:
            pass
    print(json.dumps(res, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
