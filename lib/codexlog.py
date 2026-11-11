"""Codex CLI session support for the Herdr agent inspector / board. Local files only, no network.

Codex writes one rollout file per session: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl with
records {timestamp, type, payload}: session_meta, turn_context, response_item (message / reasoning /
custom_tool_call / function_call / *_output), event_msg (task_started / task_complete / token_count /
item_completed / ...), token_usage_record.
find_rollout(): the file the codex process has open (lsof), else the newest rollout started in the same
folder after the terminal was created. parse() returns the same shape as inspect.py's Claude parser.
(Identical copies in mods/agent-inspector and mods/agent-board.)
"""
import glob, json, os, re, subprocess, time
from datetime import datetime

HOME = os.path.expanduser("~")
ROOT = os.path.join(HOME, ".codex", "sessions")
SECRET = re.compile(r"(xox[abpr]-[\w-]+|gh[pousr]_\w{20,}|github_pat_\w+|sk-[\w-]{16,}|AKIA[0-9A-Z]{16}|(?i:bearer)\s+[\w.~+/=-]{12,}|(?i:(?:token|secret|password|api[_-]?key)=)\S+)")
INJECTED = ("# AGENTS.md instructions", "<environment_context>", "<user_instructions>", "<permissions", "<skills_instructions>", "<turn_aborted>")


def red(s, n=120):
    return SECRET.sub("[redacted]", " ".join(str(s or "").split())).replace(HOME, "~")[:n]


def ts(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def is_codex(fg):
    argv = fg.get("argv") or []
    return any(re.search(r"(^|/)codex$|@openai/codex|/codex(\.js)?$", str(a)) for a in argv[:3]) or (fg.get("name") or "") == "codex"


def find_rollout(pid, cwd, created_ms):
    try:
        r = subprocess.run(["lsof", "-p", str(int(pid)), "-Fn"], capture_output=True, text=True, timeout=4)
        for line in r.stdout.splitlines():
            if line.startswith("n") and "/.codex/sessions/" in line and line.endswith(".jsonl"):
                return line[1:]
    except Exception:
        pass
    # Fallback: newest rollout in this folder that started after the terminal was created.
    since = (created_ms or 0) / 1000 - 5
    best = None
    for p in sorted(glob.glob(os.path.join(ROOT, "*", "*", "*", "rollout-*.jsonl")), key=os.path.getmtime, reverse=True)[:40]:
        if os.path.getmtime(p) < since:
            break
        try:
            with open(p, encoding="utf-8", errors="replace") as f:
                meta = json.loads(f.readline()).get("payload") or {}
        except Exception:
            continue
        if meta.get("cwd") == cwd and (ts(meta.get("timestamp") or "") or 0) >= since:
            best = p
            break
    return best


def text_of(content):
    return " ".join(c.get("text", "") for c in (content or []) if isinstance(c, dict) and c.get("type") in ("input_text", "output_text", "text"))


def user_prompt(p):
    """The person's words from a response_item user message or an item_completed UserMessage, else None."""
    if p.get("type") == "message" and p.get("role") == "user":
        t = text_of(p.get("content")).strip()
    elif p.get("type") == "item_completed" and (p.get("item") or {}).get("type") == "UserMessage":
        t = text_of(p["item"].get("content")).strip()
    else:
        return None
    return None if not t or t.startswith(INJECTED) else t


def tool_label(name, inp):
    s = inp if isinstance(inp, str) else json.dumps(inp or {}, ensure_ascii=False)
    m = re.search(r'cmd"?\s*:\s*"((?:[^"\\]|\\.)*)"', s) or re.search(r'"command"\s*:\s*\[?"((?:[^"\\]|\\.)*)"', s)
    if m:
        return red(m.group(1).encode().decode("unicode_escape", "ignore") if "\\" in m.group(1) else m.group(1), 90)
    return red(s, 90)


def records(path, tail=None):
    with open(path, "rb") as f:
        if tail:
            size = os.path.getsize(path)
            f.seek(max(0, size - tail))
            if size > tail:
                f.readline()
        for line in f:
            try:
                yield json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                continue


def usage_ctx(info):
    last = (info or {}).get("last_token_usage") or {}
    return (last.get("input_tokens") or 0) + (last.get("output_tokens") or 0), (info or {}).get("model_context_window")


def live(path):
    """{task, tool, text, ctx%, model} for the board. Widens the tail until a prompt is found."""
    for tail in (512 * 1024, 4 * 1024 * 1024, None):
        task = tool = text = None
        ctx = window = model = None
        for r in records(path, tail):
            p = r.get("payload") or {}
            u = user_prompt(p)
            if u:
                task, tool, text = red(u, 140), None, None
                continue
            pt = p.get("type")
            if r.get("type") == "turn_context":
                model = p.get("model") or model
            elif pt in ("custom_tool_call", "function_call", "local_shell_call"):
                tool = {"name": p.get("name") or pt, "target": tool_label(p.get("name"), p.get("input") or p.get("arguments") or p.get("action"))}
                text = None
            elif pt == "message" and p.get("role") == "assistant":
                first = next((l for l in text_of(p.get("content")).splitlines() if l.strip()), "")
                if first:
                    text, tool = red(first, 140), None
            elif pt == "token_count" and p.get("info"):
                ctx, window = usage_ctx(p["info"])
        if task or tail is None or os.path.getsize(path) <= (tail or 0):
            break
    pct = round(ctx / window * 100, 1) if ctx and window else None
    return {"task": task, "tool": tool, "text": text, "ctx": pct, "model": model, "agent": "codex"}


def parse(path):
    meta, turn_ctx = {}, {}
    turns, cur = [], None
    tools, issues, big = {}, {}, []
    pending = {}
    first_ctx = last_ctx = window = None
    out_tok = cached = 0
    agents_md, skills_n, skills_tok, base_tok = [], 0, 0, 0
    last_at = None

    def issue(level, kind, key, text, at):
        i = issues.setdefault(key, {"level": level, "kind": kind, "text": text, "count": 0, "last": None})
        i["count"] += 1
        i["last"] = at or i["last"]

    for r in records(path):
        t, p = r.get("type"), (r.get("payload") or {})
        at = ts(r.get("timestamp") or "")
        last_at = at or last_at
        pt = p.get("type")
        if t == "session_meta":
            meta = p
            base_tok = len(((p.get("base_instructions") or {}).get("text") or "")) // 4
            continue
        if t == "turn_context":
            turn_ctx = p
            continue
        if pt == "message" and p.get("role") in ("user", "developer"):
            raw = text_of(p.get("content"))
            if raw.startswith("# AGENTS.md instructions for "):
                where = raw.split("\n", 1)[0].replace("# AGENTS.md instructions for ", "").strip()
                if not any(m["path"] == where for m in agents_md):
                    agents_md.append({"path": where.replace(HOME, "~"), "type": "AGENTS.md", "tokens": len(raw) // 4, "how": "startup"})
                continue
            if raw.startswith("<skills_instructions>"):
                skills_n = len(re.findall(r"^- \*?\*?[\w:.-]+", raw, re.M))
                skills_tok = len(raw) // 4
                continue
        u = user_prompt(p)
        if u and (cur is None or cur.get("prompt") != red(u, 140) or (at and cur.get("at") and at - cur["at"] > 2)):
            cur = {"at": at, "prompt": red(u, 140), "ms": None, "ctx0": last_ctx, "ctx1": last_ctx, "out": 0, "hooks": 0, "steps": []}
            turns.append(cur)
            continue
        if pt == "task_complete" and cur is not None and cur.get("at") and at:
            cur["ms"] = int((at - cur["at"]) * 1000)
        if pt == "turn_aborted":
            issue("warn", "turn", ("aborted",), "A turn was interrupted / aborted", at)
        if pt == "reasoning" and cur is not None:
            cur["steps"].append({"k": "think", "name": "reasoning"})
        if pt in ("custom_tool_call", "function_call", "local_shell_call"):
            name = p.get("name") or pt
            tl = tools.setdefault(name, {"name": name, "calls": 0, "result_tok": 0, "errors": 0, "ms": 0})
            tl["calls"] += 1
            step = {"k": "tool", "name": name, "label": tool_label(name, p.get("input") or p.get("arguments") or p.get("action")), "at": at}
            pending[p.get("call_id")] = step
            if cur is not None:
                cur["steps"].append(step)
        if pt in ("custom_tool_call_output", "function_call_output", "local_shell_call_output"):
            o = p.get("output")
            txt = o if isinstance(o, str) else text_of(o) if isinstance(o, list) else json.dumps(o or "", ensure_ascii=False)
            n = len(txt) // 4
            step = pending.pop(p.get("call_id"), None)
            name = step["name"] if step else "?"
            tl = tools.setdefault(name, {"name": name, "calls": 0, "result_tok": 0, "errors": 0, "ms": 0})
            tl["result_tok"] += n
            if step:
                step["tok"] = n
                if step.get("at") and at:
                    step["ms"] = int((at - step["at"]) * 1000)
                    tl["ms"] += step["ms"]
                step.pop("at", None)
                big.append((n, name, step.get("label", "")))
            m = re.search(r"(?:exit code|Process exited with code)[:\s]+(\d+)", txt, re.I)
            if m and m.group(1) != "0":
                tl["errors"] += 1
                if step:
                    step["error"] = True
                issue("warn", "tool", ("tool", name), f"{name} exited with code {m.group(1)}: {red(step.get('label') if step else '', 90)}", at)
        if pt == "token_count" and p.get("info"):
            c, window = usage_ctx(p["info"])
            first_ctx = first_ctx or c
            last_ctx = c
            tot = p["info"].get("total_token_usage") or {}
            out_tok = tot.get("output_tokens") or out_tok
            cached = tot.get("cached_input_tokens") or cached
            if cur is not None:
                cur["ctx1"] = c
                cur["out"] = (p["info"].get("last_token_usage") or {}).get("output_tokens", 0) + cur["out"]
    for s in pending.values():
        s.pop("at", None)
    for tl in tools.values():
        tl["avg_ms"] = tl["ms"] // max(1, tl["calls"])
        del tl["ms"]
    big.sort(reverse=True)
    lvl = {"error": 0, "warn": 1, "info": 2}
    sandbox = (turn_ctx.get("sandbox_policy") or {}).get("type")
    mode = f"{turn_ctx.get('approval_policy') or '?'} · sandbox {sandbox or '?'}"
    return {
        "agent": "codex",
        "first_ctx": first_ctx, "ctx": last_ctx, "window": window, "out": out_tok, "cache_read": cached, "cache_write": 0,
        "model": turn_ctx.get("model") or meta.get("model"), "cache_until": None, "cache_ttl": None,
        "prompt_count": len(turns),
        "config": {
            "system_prompt_tok": base_tok, "output_style": turn_ctx.get("personality"), "permission_mode": mode,
            "effort": turn_ctx.get("effort"), "cli_version": meta.get("cli_version"), "originator": meta.get("originator"),
            "memory": agents_md, "memory_tok": sum(m["tokens"] for m in agents_md),
            "skills": {"available": skills_n, "available_tok": skills_tok, "used": []},
            "hooks": [], "mcp": {"servers": [], "failed": [], "pending": [], "deferred_tools": 0}, "agent_types": 0,
        },
        "issues": sorted(issues.values(), key=lambda i: (lvl.get(i["level"], 3), -(i["last"] or 0))),
        "tools": sorted(tools.values(), key=lambda x: -x["result_tok"]),
        "compactions": [],
        "big": [{"tok": n, "tool": nm, "label": lb} for n, nm, lb in big[:8]],
        "turns": [{"at": x["at"], "ms": x["ms"], "prompt": x["prompt"], "ctx_delta": (x["ctx1"] or 0) - (x["ctx0"] or x["ctx1"] or 0),
                   "out": x["out"], "hooks": 0, "steps": x["steps"][-60:]} for x in turns[-15:]][::-1],
        "subagents": [],
        "session": meta.get("id"), "cwd": (meta.get("cwd") or "").replace(HOME, "~"),
    }
