#!/usr/bin/env python3
"""Summarize one Claude Code agent's session for the Herdr agent inspector. Local files only, no network.

Usage: inspect.py <terminal address, e.g. t8>
  terminal -> foreground pid (hc get) -> ~/.claude/sessions/<pid>.json -> sessionId
  -> ~/.claude/projects/*/<sessionId>.jsonl (+ <sessionId>/subagents/*)
Answers four questions from the transcript:
  config : what shapes the agent (memory/rules files, skills listed vs loaded, hooks, MCP, output style, mode)
  health : what went wrong (hook errors/timeouts, tool errors, permission rejects, compactions, cache drops)
  turns  : what it did (per turn: steps = tool calls with duration/size/permission, hooks, subagents)
  cost   : where tokens went (per tool result size, per turn, subagents, cache)
Plus cost / context % / window / model from the status-line snapshot. Prints one JSON object.
Token figures marked approximate are chars/4. Secret-looking strings are redacted.
"""
import collections, glob, json, os, re, subprocess, sys, tempfile, time
from datetime import datetime

HOME = os.path.expanduser("~")
CACHE_DIR = os.path.join(HOME, ".cache", "herdr-claude-status")
SNAPSHOT = os.path.join(CACHE_DIR, "claude-statusline.json")
VERSION = 9
SECRET = re.compile(r"(xox[abpr]-[\w-]+|gh[pousr]_\w{20,}|github_pat_\w+|sk-[\w-]{16,}|AKIA[0-9A-Z]{16}|(?i:bearer)\s+[\w.~+/=-]{12,}|(?i:(?:token|secret|password|api[_-]?key)=)\S+)")


INJECTED = re.compile(r"<(system-reminder|task-notification|agent-message|cross-session-message)\b[^>]*>.*?</\1>", re.S)


def human_text(c):
    """The user's own words: drop blocks the harness injects (reminders, notifications, peer messages)."""
    return INJECTED.sub("", c).strip()


def red(s, n=120):
    return SECRET.sub("[redacted]", " ".join(str(s or "").split())).replace(HOME, "~")[:n]


def tok(s):
    return len(s) // 4 if isinstance(s, str) else len(json.dumps(s, ensure_ascii=False)) // 4


def out(**kw):
    print(json.dumps(kw, ensure_ascii=False, separators=(",", ":")))
    sys.exit(0)


def ts(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def ctx_of(u):
    return (u.get("input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0)


def label(name, inp):
    inp = inp or {}
    if name == "Bash":
        return red(inp.get("description") or inp.get("command"), 90)
    if name == "Skill":
        return red(inp.get("skill"), 90)
    for k in ("file_path", "path", "url", "pattern", "description", "query", "prompt", "subject"):
        if isinstance(inp.get(k), str):
            return red(inp[k], 90)
    return ""


def short_cmd(c):
    c = red(c, 400)
    m = re.search(r"([\w./${}-]*hooks?/[\w./-]+)", c)
    return (m.group(1) if m else c)[:80]


class Agg:
    def __init__(self):
        self.memory = {}          # path -> {path, type, tokens, how}
        self.skills_avail = 0
        self.skills_avail_tok = 0
        self.skills_used = {}     # name -> {name, tokens, count}
        self.hooks = {}           # key -> stats
        self.mcp = {}             # server -> {name, instr_tok, calls}
        self.mcp_failed, self.mcp_pending = set(), set()
        self.deferred = 0
        self.agent_types = 0
        self.output_style = None
        self.perm_mode = None
        self.sys_chars = None
        self.model = None
        self.issues = {}          # key -> {level, kind, text, count, last}
        self.tools = {}           # name -> {name, calls, result_tok, errors, ms}
        self.compactions = []
        self.cache_drops = 0

    def issue(self, level, kind, key, text, at):
        i = self.issues.setdefault(key, {"level": level, "kind": kind, "text": text, "count": 0, "last": None})
        i["count"] += 1
        i["last"] = at or i["last"]
        i["text"] = text

    def hook(self, a, at):
        key = (a.get("hookEvent"), a.get("hookName"), a.get("command"))
        h = self.hooks.setdefault(key, {"event": a.get("hookEvent"), "name": a.get("hookName"), "cmd": short_cmd(a.get("command")),
                                        "runs": 0, "errors": 0, "timeouts": 0, "ms": 0, "max_ms": 0, "injected": 0})
        h["runs"] += 1
        try:
            d = int(a.get("durationMs") or 0)
        except (TypeError, ValueError):
            d = 0
        h["ms"] += d
        h["max_ms"] = max(h["max_ms"], d)
        t = a.get("type")
        if t == "hook_non_blocking_error" or t == "hook_blocking_error":
            h["errors"] += 1
            self.issue("error", "hook", ("hook", key), f"Hook {a.get('hookName')} failed (exit {a.get('exitCode')}): {red(a.get('stderr'), 140)}", at)
        if t == "hook_cancelled":
            h["timeouts"] += 1
            self.issue("warn", "hook", ("hookto", key), f"Hook {a.get('hookName')} timed out after {int(a.get('timeoutMs') or 0) // 1000}s: {short_cmd(a.get('command'))}", at)
        if t == "hook_additional_context":
            h["injected"] += 1


def parse(path):
    g = Agg()
    turns = []
    cur = None
    first_ctx = last_ctx = None
    out_tok = cache_read = cache_write = 0
    last_asst_ts, cache_ttl = None, 300
    pending = {}  # tool_use id -> step
    big = []
    for line in open(path, encoding="utf-8", errors="replace"):
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get("isSidechain"):
            continue
        t = r.get("type")
        at = ts(r.get("timestamp") or "")
        m = r.get("message") or {}
        a = r.get("attachment")
        if t == "permission-mode" and r.get("permissionMode"):
            g.perm_mode = r["permissionMode"]
        if isinstance(a, dict):
            at_ = a.get("type")
            if at_ == "instructions":
                for f in a.get("files") or []:
                    p = (f.get("path") or "").replace(HOME, "~")
                    g.memory[p] = {"path": p, "type": f.get("type"), "tokens": tok(f.get("content") or ""), "how": "startup"}
            elif at_ == "nested_memory":
                p = (a.get("path") or "").replace(HOME, "~")
                g.memory.setdefault(p, {"path": p, "type": "Rule", "tokens": tok(a.get("content") or ""), "how": "on demand"})
            elif at_ == "skill_listing":
                g.skills_avail = int(a.get("skillCount") or len(a.get("names") or []))
                g.skills_avail_tok = tok(a.get("content") or "")
            elif at_ == "invoked_skills":
                for s in a.get("skills") or []:
                    u = g.skills_used.setdefault(s.get("name"), {"name": s.get("name"), "tokens": tok(s.get("content") or ""), "count": 0})
                    u["count"] += 1
            elif at_ == "mcp_instructions_delta":
                for name, block in zip(a.get("addedNames") or [], a.get("addedBlocks") or []):
                    g.mcp.setdefault(name, {"name": name, "instr_tok": 0, "calls": 0})["instr_tok"] = tok(block)
            elif at_ == "deferred_tools_delta":
                g.mcp_failed |= set(a.get("failedMcpServers") or [])
                g.mcp_pending |= set(a.get("pendingMcpServers") or [])
                g.deferred += len(a.get("addedNames") or []) - len(a.get("removedNames") or [])
            elif at_ == "agent_listing_delta":
                g.agent_types = max(g.agent_types, len(a.get("addedTypes") or []))
            elif at_ in ("output_style",):
                g.output_style = a.get("style")
            elif at_ == "prompt_snapshot":
                sp = a.get("systemPrompt")
                g.sys_chars = sum(len(x) for x in sp) if isinstance(sp, list) else len(str(sp or ""))
            elif at_ == "thinking_drop":
                g.cache_drops += 1
            elif at_ and at_.startswith("hook_"):
                g.hook(a, at)
                if cur is not None and at_ in ("hook_non_blocking_error", "hook_cancelled", "hook_blocking_error"):
                    cur["steps"].append({"k": "hook", "name": a.get("hookName"), "error": True, "ms": int(a.get("durationMs") or 0)})
                if cur is not None:
                    cur["hooks"] += 1
            continue
        if t == "system":
            st = r.get("subtype")
            if st == "turn_duration" and cur is not None:
                cur["ms"] = r.get("durationMs")
            elif st == "compact_boundary":
                meta = r.get("compactMetadata") or {}
                g.compactions.append({"at": at, "pre": meta.get("preTokens"), "trigger": meta.get("trigger")})
                g.issue("info", "compact", ("compact",), f"Context compacted {len(g.compactions)}× (last from {meta.get('preTokens') or '?'} tokens, {meta.get('trigger')})", at)
                if cur is not None:
                    cur["steps"].append({"k": "compact", "name": "compacted", "label": str(meta.get("preTokens") or "")})
            continue
        if t == "user":
            c = m.get("content")
            if isinstance(c, list) and not any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
                c = " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
            if isinstance(c, str) and not r.get("isMeta"):
                text = human_text(c)
                if not text or text.startswith("<local-command"):
                    continue
                if text.startswith("<command-name>"):
                    text = text.split("<command-name>")[1].split("</command-name>")[0]
                cur = {"at": at, "prompt": red(text, 140), "ms": None, "ctx0": last_ctx, "ctx1": last_ctx, "out": 0, "hooks": 0, "steps": []}
                turns.append(cur)
            elif isinstance(c, list):
                pd = r.get("permissionDecision") if isinstance(r.get("permissionDecision"), dict) else None
                for b in c:
                    if not (isinstance(b, dict) and b.get("type") == "tool_result"):
                        continue
                    cc = b.get("content")
                    text = cc if isinstance(cc, str) else " ".join(x.get("text", "") for x in (cc or []) if isinstance(x, dict))
                    n = len(text) // 4
                    step = pending.pop(b.get("tool_use_id"), None)
                    name = step["name"] if step else "?"
                    tool = g.tools.setdefault(name, {"name": name, "calls": 0, "result_tok": 0, "errors": 0, "ms": 0})
                    tool["result_tok"] += n
                    if step:
                        step["tok"] = n
                        if step.get("at") and at:
                            step["ms"] = int((at - step["at"]) * 1000)
                            tool["ms"] += step["ms"]
                        step.pop("at", None)
                        big.append((n, name, step.get("label", "")))
                    if b.get("is_error") and text.startswith("The user doesn't want to proceed"):
                        if step:
                            step["perm"] = "reject:you"
                        g.issue("info", "permission", ("perm", name, "you"), f"You rejected a {name} call", at)
                    elif b.get("is_error") and text.startswith("Permission for this action was denied"):
                        if step:
                            step["perm"] = "reject:auto-mode"
                        g.issue("warn", "permission", ("perm", name, "auto"), f"{name} blocked by the auto-mode safety classifier: {red(text.split('Reason:')[-1], 90)}", at)
                    elif b.get("is_error"):
                        tool["errors"] += 1
                        if step:
                            step["error"] = True
                        g.issue("warn", "tool", ("tool", name), f"{name} returned an error: {red(text, 140)}", at)
                    if pd:
                        if step:
                            step["perm"] = f"{pd.get('decision')}:{pd.get('source')}" + (f"/{pd.get('reasonType')}" if pd.get("reasonType") else "")
                        if pd.get("decision") == "reject" and pd.get("reasonType") != "classifier":
                            g.issue("warn", "permission", ("perm", name, pd.get("source")), f"{name} was rejected by {pd.get('source')}" + (f" ({pd.get('reasonType')})" if pd.get("reasonType") else ""), at)
                if cur is not None and at:
                    cur["end"] = at
            continue
        if t == "assistant":
            u = m.get("usage") or {}
            g.model = m.get("model") or g.model
            if u:
                cx = ctx_of(u)
                first_ctx = first_ctx or cx
                last_ctx = cx
                out_tok += u.get("output_tokens") or 0
                cache_read += u.get("cache_read_input_tokens") or 0
                cache_write += u.get("cache_creation_input_tokens") or 0
                if ((u.get("cache_creation") or {}).get("ephemeral_1h_input_tokens") or 0) > 0:
                    cache_ttl = 3600
                last_asst_ts = at or last_asst_ts
                if cur is not None:
                    cur["ctx1"] = cx
                    cur["out"] += u.get("output_tokens") or 0
            if cur is not None and r.get("thinkingDurationMs"):
                cur["steps"].append({"k": "think", "name": "thinking", "ms": r["thinkingDurationMs"]})
            for b in m.get("content") or []:
                if not isinstance(b, dict) or b.get("type") != "tool_use":
                    continue
                name = b.get("name", "?")
                g.tools.setdefault(name, {"name": name, "calls": 0, "result_tok": 0, "errors": 0, "ms": 0})["calls"] += 1
                if name.startswith("mcp__"):
                    srv = name.split("__")[1]
                    g.mcp.setdefault(srv, {"name": srv, "instr_tok": 0, "calls": 0})["calls"] += 1
                if name == "Skill":
                    sk = (b.get("input") or {}).get("skill")
                    g.skills_used.setdefault(sk, {"name": sk, "tokens": 0, "count": 0})
                step = {"k": "agent" if name in ("Agent", "Task") else "tool", "name": name, "label": label(name, b.get("input")), "at": at}
                pending[b.get("id")] = step
                if cur is not None:
                    cur["steps"].append(step)
    for s in pending.values():
        s.pop("at", None)
    if g.mcp_failed:
        g.issue("error", "mcp", ("mcpfail",), "MCP servers failed to connect: " + ", ".join(sorted(g.mcp_failed)), None)
    if g.cache_drops:
        g.issue("info", "cache", ("cachedrop",), f"Prompt cache prefix changed {g.cache_drops}× (thinking dropped / cache rebuilt)", None)
    big.sort(reverse=True)
    lvl = {"error": 0, "warn": 1, "info": 2}
    issues = sorted(g.issues.values(), key=lambda i: (lvl.get(i["level"], 3), -(i["last"] or 0)))
    memory = sorted(g.memory.values(), key=lambda x: -x["tokens"])
    hooks = sorted(g.hooks.values(), key=lambda h: (-(h["errors"] + h["timeouts"]), -h["runs"]))
    for h in hooks:
        h["avg_ms"] = h["ms"] // max(1, h["runs"])
        del h["ms"]
    for tl in g.tools.values():
        tl["avg_ms"] = tl["ms"] // max(1, tl["calls"])
        del tl["ms"]
    return {
        "first_ctx": first_ctx, "ctx": last_ctx, "out": out_tok, "cache_read": cache_read, "cache_write": cache_write,
        "model": g.model, "cache_until": (last_asst_ts + cache_ttl) if last_asst_ts else None, "cache_ttl": cache_ttl,
        "prompt_count": len(turns),
        "config": {
            "system_prompt_tok": (g.sys_chars or 0) // 4, "output_style": g.output_style, "permission_mode": g.perm_mode,
            "memory": memory, "memory_tok": sum(x["tokens"] for x in memory),
            "skills": {"available": g.skills_avail, "available_tok": g.skills_avail_tok,
                       "used": sorted(g.skills_used.values(), key=lambda s: -s["count"])},
            "hooks": hooks,
            "mcp": {"servers": sorted(g.mcp.values(), key=lambda s: -s["instr_tok"]), "failed": sorted(g.mcp_failed),
                    "pending": sorted(g.mcp_pending), "deferred_tools": max(0, g.deferred)},
            "agent_types": g.agent_types,
        },
        "issues": issues,
        "tools": sorted(g.tools.values(), key=lambda x: -x["result_tok"]),
        "compactions": g.compactions,
        "big": [{"tok": n, "tool": nm, "label": lb} for n, nm, lb in big[:8]],
        "turns": [{"at": x["at"], "ms": x["ms"] or (int((x.get("end", x["at"]) - x["at"]) * 1000) if x["at"] else None),
                   "prompt": x["prompt"], "ctx_delta": (x["ctx1"] or 0) - (x["ctx0"] or x["ctx1"] or 0), "out": x["out"],
                   "hooks": x["hooks"], "steps": x["steps"][-60:]} for x in turns[-15:]][::-1],
    }


def subagents(path, sid):
    res = []
    for meta in sorted(glob.glob(os.path.join(os.path.dirname(path), sid, "subagents", "*.meta.json"))):
        try:
            mj = json.load(open(meta))
        except Exception:
            continue
        jl = meta[: -len(".meta.json")] + ".jsonl"
        out_tok, cx, tool_n = 0, 0, 0
        try:
            for line in open(jl, encoding="utf-8", errors="replace"):
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get("type") == "assistant":
                    u = (r.get("message") or {}).get("usage") or {}
                    out_tok += u.get("output_tokens") or 0
                    cx = ctx_of(u) or cx
                    tool_n += sum(1 for b in (r["message"].get("content") or []) if isinstance(b, dict) and b.get("type") == "tool_use")
        except OSError:
            pass
        res.append({"desc": red(mj.get("description"), 60), "type": mj.get("agentType"), "finished": mj.get("finished"),
                    "out": out_tok, "ctx": cx, "tools": tool_n})
    return res


def main():
    if len(sys.argv) < 2 or not re.fullmatch(r"[A-Za-z0-9_-]+", sys.argv[1]):
        out(ok=False, error="usage")
    addr = sys.argv[1]
    try:
        r = subprocess.run(["hc", "get", addr, "--json"], capture_output=True, text=True, timeout=5)
        fg = (json.loads(r.stdout).get("foreground") or {})
    except Exception:
        out(ok=False, error="terminal unavailable")
    pid = fg.get("pid")
    try:
        sess = json.load(open(os.path.join(HOME, ".claude", "sessions", "%d.json" % pid)))
    except Exception:
        sess = None
    if sess is None:
        import codexlog
        if not codexlog.is_codex(fg):
            out(ok=False, error="unsupported agent", program=" ".join(fg.get("argv") or [])[:60])
        raw = json.loads(r.stdout)
        path = codexlog.find_rollout(pid, fg.get("cwd") or raw.get("cwd"), raw.get("created_ms"))
        if not path:
            out(ok=False, error="Codex session file not found yet (send it a prompt first)")
        st = os.stat(path)
        os.makedirs(CACHE_DIR, mode=0o700, exist_ok=True)
        cache = os.path.join(CACHE_DIR, "inspect-codex-%s.json" % os.path.basename(path)[:-6])
        data = None
        try:
            c = json.load(open(cache))
            if c.get("v") == VERSION and c.get("size") == st.st_size and c.get("mtime") == st.st_mtime:
                data = c["data"]
        except Exception:
            pass
        if data is None:
            data = codexlog.parse(path)
            fd, tmp = tempfile.mkstemp(dir=CACHE_DIR, prefix=".inspect-")
            with os.fdopen(fd, "w") as f:
                json.dump({"v": VERSION, "size": st.st_size, "mtime": st.st_mtime, "data": data}, f)
            os.replace(tmp, cache)
        pct = round(data["ctx"] / data["window"] * 100, 1) if data.get("ctx") and data.get("window") else None
        out(ok=True, name=os.path.basename(data.get("cwd") or "") or "Codex", pct=pct, cost=None, model_name=data.get("model"), now=time.time(), **data)
    sid = sess.get("sessionId")
    paths = glob.glob(os.path.join(HOME, ".claude", "projects", "*", "%s.jsonl" % sid))
    if not paths:
        out(ok=False, error="transcript not found", session=sid)
    path = paths[0]
    st = os.stat(path)
    os.makedirs(CACHE_DIR, mode=0o700, exist_ok=True)
    os.chmod(CACHE_DIR, 0o700)  # holds prompt snippets: owner only
    cache = os.path.join(CACHE_DIR, "inspect-%s.json" % sid)
    data = None
    try:
        c = json.load(open(cache))
        if c.get("v") == VERSION and c.get("size") == st.st_size and c.get("mtime") == st.st_mtime:
            data = c["data"]
    except Exception:
        pass
    if data is None:
        data = parse(path)
        data["subagents"] = subagents(path, sid)
        fd, tmp = tempfile.mkstemp(dir=CACHE_DIR, prefix=".inspect-")  # created 0600
        with os.fdopen(fd, "w") as f:
            json.dump({"v": VERSION, "size": st.st_size, "mtime": st.st_mtime, "data": data}, f)
        os.replace(tmp, cache)
    snap = {}
    try:
        snap = (json.load(open(SNAPSHOT)).get("session_contexts") or {}).get(sid) or {}
    except Exception:
        pass
    out(ok=True, session=sid, cwd=(sess.get("cwd") or "").replace(HOME, "~"), name=sess.get("name"),
        pct=snap.get("used_percent"), window=snap.get("window"), cost=snap.get("cost_usd"), model_name=snap.get("model"),
        now=time.time(), **data)


if __name__ == "__main__":
    main()
