#!/usr/bin/env python3
"""The session hook, with a stand-in `hc` on PATH that records what it was asked to do."""
import json, os, stat, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "..", "integrations", "agent-restore", "session-hook.py")
SID = "11111111-2222-4333-8444-555555555555"

with tempfile.TemporaryDirectory() as tmp:
    log = os.path.join(tmp, "calls.jsonl")
    fake = os.path.join(tmp, "hc")
    with open(fake, "w") as f:
        f.write("#!/usr/bin/env python3\nimport json, sys\n"
                "if sys.argv[1:3] == ['server', 'status']:\n    print(json.dumps({'pid': 4242, 'uptime_ms': 60000}))\n"
                "else:\n    open(%r, 'a').write(json.dumps(sys.argv[1:]) + '\\n')\n" % log)
    os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)

    def run(provider, payload, term="t7", extra=None, raw=None):
        if os.path.exists(log):
            os.remove(log)
        env = {**os.environ, "PATH": tmp + os.pathsep + os.environ["PATH"], **(extra or {})}
        env.pop("CODEX_THREAD_ID", None) if not (extra or {}).get("CODEX_THREAD_ID") else None
        if term is None:
            env.pop("HC_TERMINAL_ID", None)
        else:
            env["HC_TERMINAL_ID"] = term
        r = subprocess.run([sys.executable, HOOK, provider], input=raw if raw is not None else json.dumps(payload), env=env, capture_output=True, text=True)
        calls = [json.loads(l) for l in open(log)] if os.path.exists(log) else []
        return r, calls

    start = {"hook_event_name": "SessionStart", "session_id": SID, "cwd": "/work/shop api", "source": "startup"}
    r, c = run("claude", start)
    labels = dict(x.split("=", 1) for x in c[0][2:]) if c else {}
    checks = {
        "a start labels its own terminal": bool(c) and c[0][:2] == ["label", "t7"],
        "agent, session and folder are written": labels.get("ranch.agent") == "claude" and labels.get("ranch.session") == SID and labels.get("ranch.cwd") == "/work/shop api",
        "the core run is written as pid.start": labels.get("ranch.core", "").startswith("4242.") and labels["ranch.core"].split(".")[1].isdigit(),
        "it prints nothing and exits 0": r.stdout == "" and r.returncode == 0,
    }
    r, c = run("claude", {**start, "source": "clear", "cwd": "/somewhere/else"})
    checks["after /clear the session changes and the folder stays"] = bool(c) and "ranch.session=" + SID in c[0] and not any(x.startswith("ranch.cwd=") for x in c[0])
    r, c = run("claude", {"hook_event_name": "SessionEnd", "session_id": SID, "reason": "prompt_input_exit"})
    checks["leaving on purpose removes the labels"] = bool(c) and sorted(c[0][2:]) == sorted(["ranch.agent=", "ranch.session=", "ranch.cwd=", "ranch.core="])
    r, c = run("claude", {"hook_event_name": "SessionEnd", "session_id": SID, "reason": "other"})
    checks["an end that was not the person's choice keeps them"] = c == []
    r, c = run("claude", {**start, "agent_id": "sub-1"})
    checks["a sub-agent is ignored"] = c == []
    r, c = run("claude", start, term=None)
    checks["outside a Herdr terminal nothing happens"] = c == []
    r, c = run("claude", {**start, "session_id": "not-an-id; rm -rf /"})
    checks["a session id that is not an id is ignored"] = c == []
    r, c = run("claude", None, raw="this is not json")
    checks["bad input is ignored quietly"] = c == [] and r.returncode == 0 and r.stdout == ""
    r, c = run("codex", start, extra={"CODEX_THREAD_ID": "99999999-2222-4333-8444-555555555555"})
    checks["a Codex helper thread is ignored"] = c == []
    r, c = run("codex", start)
    checks["Codex is labelled as codex"] = bool(c) and "ranch.agent=codex" in c[0]
    for k, ok in checks.items():
        print(("ok   " if ok else "FAIL ") + k)
    sys.exit(0 if all(checks.values()) else 1)
