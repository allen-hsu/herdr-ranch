#!/usr/bin/env python3
"""Claude Code background subagents (the Agent tool) that are running right now, per terminal.
Usage: subs.py t8 t13 ...  ->  {"t8": [{"id", "desc", "type", "started", "last"}], ...}
Running = its meta.json says not finished and its transcript changed in the last 30 minutes (a crashed one that
never wrote "finished" drops off). Local files only. Shared lib (herdr-ranch/lib)."""
import glob, json, os, re, subprocess, sys, time

HOME = os.path.expanduser("~")
FRESH = 30 * 60


def transcript(addr):
    try:
        g = json.loads(subprocess.run(["hc", "get", addr, "--json"], capture_output=True, text=True, timeout=4).stdout)
        pid = (g.get("foreground") or {}).get("pid")
        sid = json.load(open(os.path.join(HOME, ".claude", "sessions", "%d.json" % pid))).get("sessionId")
    except Exception:
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


def main():
    res = {}
    for addr in sys.argv[1:33]:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", addr):
            continue
        p = transcript(addr)
        res[addr] = running(p) if p else []
    print(json.dumps(res, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
