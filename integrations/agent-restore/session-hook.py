#!/usr/bin/env python3
"""herdr-ranch: remember which conversation runs in which Herdr terminal, so it can be resumed after a restart.

A SessionStart (and SessionEnd) hook for Claude Code and Codex:
  python3 ~/.config/herdr-app/ranch/agent-session-hook.py claude     (or: codex)
It reads the hook's JSON on stdin and writes four labels on its own terminal (`hc label $HC_TERMINAL_ID ...`):
  ranch.agent    claude | codex
  ranch.session  the conversation's id (what `claude --resume` / `codex resume` take)
  ranch.cwd      the folder it was started in (Claude Code finds a conversation only from there)
  ranch.core     the herdr-core run it was last seen alive under ("<pid>.<start, unix seconds>")
Herdr keeps a terminal's labels across a reboot, while the terminal itself comes back as a shell: the
agent-restore mod offers to resume the ones whose labels are from an earlier core run.
A conversation the person leaves on purpose (/exit, ctrl-d, logout) takes its labels with it.
Outside a Herdr terminal, for a sub-agent, or when anything is missing, it does nothing. It never prints
(a SessionStart hook's output would go into the conversation), stores no text of the conversation, and
makes no network call.
"""
import json, os, re, shutil, subprocess, sys, time

UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
KEYS = ("ranch.agent", "ranch.session", "ranch.cwd", "ranch.core")
LEFT = ("prompt_input_exit", "logout")  # SessionEnd reasons that mean the person left


def hc(*args):
    exe = shutil.which("hc") or os.path.expanduser("~/.local/bin/hc")
    return subprocess.run([exe, *args], capture_output=True, text=True, timeout=4)


def core():
    """This run of herdr-core, as "<pid>.<start>": a reboot, a crash or a logout gives another one."""
    try:
        s = json.loads(hc("server", "status", "--json").stdout)
        return "%d.%d" % (int(s["pid"]), int(time.time() - int(s["uptime_ms"]) / 1000))
    except Exception:
        return ""


def main(argv):
    provider = argv[0] if argv else ""
    term = os.environ.get("HC_TERMINAL_ID") or ""
    if provider not in ("claude", "codex") or not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", term):
        return
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    if not isinstance(data, dict) or data.get("agent_id"):
        return  # a sub-agent's own events: the terminal belongs to its lead
    sid = data.get("session_id")
    if not isinstance(sid, str) or not UUID.fullmatch(sid):
        return
    thread = os.environ.get("CODEX_THREAD_ID")
    if provider == "codex" and thread and thread != sid:
        return  # a Codex helper thread started from another conversation
    event = data.get("hook_event_name") or "SessionStart"
    if event == "SessionEnd":
        if data.get("reason") in LEFT:
            hc("label", term, *[k + "=" for k in KEYS])
        return
    if event != "SessionStart":
        return
    labels = ["ranch.agent=" + provider, "ranch.session=" + sid, "ranch.core=" + core()]
    # The folder: where it was started or resumed. After /clear or a compaction the conversation is still filed
    # under that first folder, wherever the agent has cd'd to since, so the label is left as it is.
    cwd = data.get("cwd")
    if data.get("source") in (None, "startup", "resume") and isinstance(cwd, str) and cwd.startswith("/") \
            and len(cwd) < 1024 and cwd.isprintable():
        labels.append("ranch.cwd=" + cwd)
    hc("label", term, *labels)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception:
        pass
    sys.exit(0)
