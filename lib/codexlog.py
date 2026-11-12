"""Codex CLI session support for the Herdr agent inspector / board. Local files only, no network.

Codex writes one rollout file per session: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl with
records {timestamp, type, payload}: session_meta, turn_context, response_item (message / reasoning /
custom_tool_call / function_call / *_output), event_msg (task_started / task_complete / token_count /
item_completed / ...), token_usage_record.
find_rollout(): the file the codex process has open (lsof), else the newest rollout started in the same
folder after the terminal was created. parse() returns the same shape as inspect.py's Claude parser.
(Identical copies in mods/agent-inspector and mods/agent-board.)
"""
import collections, glob, json, os, re, subprocess, time
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


CODEX_HOME = os.path.join(HOME, ".codex")


def mcp_norm(name):
    """config name -> the form in tool names: chrome-devtools -> mcp__chrome_devtools."""
    return "mcp__" + re.sub(r"[^A-Za-z0-9_]", "_", name)


def codex_config():
    try:
        import tomllib
        with open(os.path.join(CODEX_HOME, "config.toml"), "rb") as f:
            return tomllib.load(f)
    except Exception:
        return {}


def hook_name(cmd):
    cmd = cmd if isinstance(cmd, str) else ""
    m = re.search(r"([\w.-]+\.(?:sh|py|js|mjs|cjs|ts|cmd|bat))\b", cmd)
    if m:
        return m.group(1)
    parts = cmd.split()
    first = os.path.basename(parts[0].strip("'\"")) if parts else ""
    return first[:40] or "hook"


def hooks_in(data, src):
    """Hook rows from one hooks.json. The file can be anything (a project's own): every level is type-checked."""
    rows = []
    hooks = data.get("hooks") if isinstance(data, dict) else None
    if not isinstance(hooks, dict):
        return rows
    for event, groups in hooks.items():
        if not isinstance(groups, list):
            continue
        for grp in groups:
            if not isinstance(grp, dict) or not isinstance(grp.get("hooks"), list):
                continue
            matcher = grp.get("matcher") if isinstance(grp.get("matcher"), str) else ""
            for h in grp["hooks"]:
                if not isinstance(h, dict):
                    continue
                cmd = h.get("command") if isinstance(h.get("command"), str) else ""
                rows.append({"event": red(str(event) + (f" · {matcher}" if matcher else ""), 80), "label": hook_name(cmd), "src": src,
                             "full": red(cmd, 2000), "cmd": red(cmd, 80), "runs": None, "errors": 0, "timeouts": 0, "avg_ms": None, "configured": True})
                if len(rows) >= 200:
                    return rows
    return rows


def configured_hooks(cwd, cfg):
    """Hooks Codex is set up to run for this session: ~/.codex/hooks.json, the project's .codex/hooks.json and
    config.toml's notify. Codex's session log doesn't record hook runs, so there are no counts.
    A broken or odd file is skipped: it must never stop the rest of the summary."""
    out, seen = [], set()
    for src, path in (("user", os.path.join(CODEX_HOME, "hooks.json")), ("project", os.path.join(cwd if isinstance(cwd, str) else "", ".codex", "hooks.json"))):
        try:
            real = os.path.realpath(path)
            if real in seen or not os.path.isfile(real) or os.path.getsize(real) > 1024 * 1024:
                continue
            seen.add(real)
            with open(real, encoding="utf-8", errors="replace") as f:
                out += hooks_in(json.load(f), src)
        except Exception:
            continue
    try:
        n = cfg.get("notify") if isinstance(cfg, dict) else None
        if isinstance(n, list) and n:
            out.append({"event": "notify · " + " ".join(str(x) for x in n[1:])[:40], "label": os.path.basename(str(n[0]))[:40], "src": "config.toml",
                        "full": red(" ".join(str(x) for x in n), 2000), "cmd": "", "runs": None, "errors": 0, "timeouts": 0, "avg_ms": None, "configured": True})
    except Exception:
        pass
    return out


def mcp_servers(cfg, connected, calls, tools):
    """Configured servers (config.toml) + the ones this session actually had (world_state) + calls seen in its tool inputs."""
    rows = {}
    servers = cfg.get("mcp_servers") if isinstance(cfg, dict) else None
    for name in (servers if isinstance(servers, dict) else {}):
        rows[mcp_norm(str(name))] = {"name": str(name), "configured": True}
    for key, desc in connected.items():
        rows.setdefault(key, {"name": key[5:].replace("__", " · "), "configured": False})["instr_tok"] = len(desc or "") // 4
        rows[key]["connected"] = True
    out = []
    for key, r in rows.items():
        mine = calls.get(key) or collections.Counter()
        out.append({"name": r["name"], "key": key, "status": "connected" if r.get("connected") else "not connected",
                    "tools": 0, "upfront": 0, "loaded": 0, "called": len(mine), "calls": sum(mine.values()), "errors": 0,
                    "top": [{"tool": t, "n": n, "avg_ms": None, "errors": 0} for t, n in mine.most_common(8)],
                    "instr_tok": r.get("instr_tok", 0), "def_tok": 0, "list_tok": 0, "builtin": not r["configured"]})
    out.sort(key=lambda x: (-(x["calls"] > 0), x["status"] != "connected", x["builtin"], x["name"]))
    return {"servers": out, "failed": [], "pending": [], "deferred_tools": 0,
            "totals": {"servers": len(out), "connected": sum(x["status"] == "connected" for x in out), "tools": 0, "loaded": 0,
                       "called": sum(x["called"] for x in out), "calls": sum(x["calls"] for x in out), "context_tok": sum(x["instr_tok"] for x in out)}}


def union_len(iv):
    tot, cur = 0.0, None
    for a, b in sorted(iv):
        if cur is None or a > cur[1]:
            if cur:
                tot += cur[1] - cur[0]
            cur = [a, b]
        else:
            cur[1] = max(cur[1], b)
    return tot + (cur[1] - cur[0] if cur else 0)


def turn_row(x):
    """Same shape as Claude's turns in inspect.py: summary, time split and waterfall spans (offsets in seconds)."""
    t0 = x["at"]
    steps = x["steps"][-60:]
    spans = []
    calls = x.get("calls", [])
    if t0:
        llms = [sp for sp in x.get("spans", []) if sp["k"] == "llm"]
        for j, sp in enumerate(llms):
            tools = [g["name"] for g in sp["got"] if g["k"] == "tool"]
            what = " → ".join(filter(None, ["thinking" if any(g["k"] == "thinking" for g in sp["got"]) else "",
                                            "reply" if any(g["k"] == "text" for g in sp["got"]) else "", ", ".join(tools[:3])]))
            spans.append({"k": "llm", "name": f"LLM #{j + 1}", "label": what, "s": sp["t0"] - t0, "e": sp["t1"] - t0, "call": j if j < len(calls) else None})
        for j, st in enumerate(steps):
            if st.get("t0") and st["k"] == "tool":
                spans.append({"k": "tool", "name": st["name"], "label": st.get("label") or "", "s": st["t0"] - t0,
                              "e": (st["t1"] - t0) if st.get("t1") else None, "step": j, "err": bool(st.get("error")), "tok": st.get("tok")})
    steps = [{k: v for k, v in st.items() if k not in ("t0", "t1")} for st in steps]
    total = (x["ms"] or 0) / 1000
    total = max([total] + [sp["e"] for sp in spans if sp["e"] is not None])
    for sp in spans:
        if sp["e"] is None:
            sp["e"], sp["open"] = total, True
        sp["s"] = max(0.0, round(sp["s"], 3)); sp["e"] = round(max(sp["e"], sp["s"]), 3)
    spans.sort(key=lambda sp: (sp["s"], sp["k"] != "llm"))
    llm = [(sp["s"], sp["e"]) for sp in spans if sp["k"] == "llm"]
    busy = union_len(llm + [(sp["s"], sp["e"]) for sp in spans if sp["k"] != "llm"])
    model_s = union_len(llm)
    inn = sum(c["new"] for c in calls); cached = sum(c["cache_read"] for c in calls)
    return {"at": t0, "ms": int(total * 1000) if t0 else x["ms"], "prompt": x["prompt"], "ctx_delta": (x["ctx1"] or 0) - (x["ctx0"] or x["ctx1"] or 0),
            "out": x["out"], "hooks": 0, "steps": steps, "calls": calls[-30:], "spans": spans[:120],
            "split": {"model": round(model_s, 2), "tools": round(busy - model_s, 2), "you": 0, "other": round(max(0.0, total - busy), 2)} if spans else None,
            "sum": {"calls": len(calls), "tools": sum(1 for s in steps if s["k"] == "tool"), "in_new": inn, "in_cached": cached,
                    "hit": round(cached / (inn + cached) * 100, 1) if inn + cached else None, "out": sum(c["out"] for c in calls),
                    "think": sum(c["think"] for c in calls), "cost": None, "errors": sum(1 for s in steps if s.get("error")), "misses": 0},
            "skills": [], "missed": []}


def parse(path):
    meta, turn_ctx = {}, {}
    turns, cur = [], None
    tools, issues, big = {}, {}, []
    pending = {}
    first_ctx = last_ctx = window = None
    out_tok = cached = 0
    agents_md, skills_n, skills_tok, base_tok = [], 0, 0, 0
    last_at = None

    mcp_connected, mcp_calls = {}, {}  # mcp__server -> instructions; mcp__server -> Counter(tool)
    last_in = last_out = None  # last input to the model (prompt, tool output); last model output

    def close_llm(c):
        """The model's stretch since its last input: one LLM span (from the input to its last output)."""
        if c is None or not c.get("llm") or c["llm"][1] is None:
            return
        c["spans"].append({"k": "llm", "t0": c["llm"][0], "t1": c["llm"][1], "got": c["got"][:6]})
        c["llm"], c["got"] = None, []

    def model_out(c, at, what):
        nonlocal last_out
        last_out = at or last_out
        if c is None or not at:
            return
        if c.get("llm") is None:
            c["llm"] = [last_in or at, None]
        c["llm"][1] = at
        c["got"].append(what)

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
        if t == "world_state":
            for key, desc in (((p.get("state") or {}).get("tools")) or {}).items():
                if isinstance(key, str) and key.startswith("mcp__"):
                    mcp_connected[key] = desc if isinstance(desc, str) else ""
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
            close_llm(cur)
            cur = {"at": at, "prompt": red(u, 140), "ms": None, "ctx0": last_ctx, "ctx1": last_ctx, "out": 0, "hooks": 0, "steps": [],
                   "spans": [], "calls": [], "llm": [at, None], "got": []}
            turns.append(cur)
            last_in = at
            continue
        if pt == "task_complete" and cur is not None and cur.get("at") and at:
            cur["ms"] = int((at - cur["at"]) * 1000)
            close_llm(cur)
        if pt == "message" and p.get("role") == "assistant":
            model_out(cur, at, {"k": "text", "chars": len(text_of(p.get("content")))})
        if pt == "turn_aborted":
            issue("warn", "turn", ("aborted",), "A turn was interrupted / aborted", at)
        if pt == "reasoning" and cur is not None:
            cur["steps"].append({"k": "think", "name": "reasoning"})
            model_out(cur, at, {"k": "thinking", "chars": 0})
        if pt in ("custom_tool_call", "function_call", "local_shell_call"):
            name = p.get("name") or pt
            tl = tools.setdefault(name, {"name": name, "calls": 0, "result_tok": 0, "errors": 0, "ms": 0})
            tl["calls"] += 1
            step = {"k": "tool", "name": name, "label": tool_label(name, p.get("input") or p.get("arguments") or p.get("action")), "at": at}
            pending[p.get("call_id")] = step
            model_out(cur, at, {"k": "tool", "name": name, "label": step["label"]})
            # MCP tools are called from inside the tool's input (e.g. the exec script): count mcp__<server>__<tool> names.
            raw_in = p.get("input") or p.get("arguments") or ""
            raw_in = raw_in if isinstance(raw_in, str) else json.dumps(raw_in, ensure_ascii=False)
            for full in set(re.findall(r"mcp__[A-Za-z0-9_]+", raw_in + " " + str(name))):
                srv = max((k for k in mcp_connected if full.startswith(k + "__")), key=len, default=None)
                if srv:
                    mcp_calls.setdefault(srv, collections.Counter())[full[len(srv) + 2:]] += 1
            if cur is not None:
                cur["steps"].append(step)
                close_llm(cur)
        if pt in ("custom_tool_call_output", "function_call_output", "local_shell_call_output"):
            o = p.get("output")
            txt = o if isinstance(o, str) else text_of(o) if isinstance(o, list) else json.dumps(o or "", ensure_ascii=False)
            n = len(txt) // 4
            step = pending.pop(p.get("call_id"), None)
            name = step["name"] if step else "?"
            tl = tools.setdefault(name, {"name": name, "calls": 0, "result_tok": 0, "errors": 0, "ms": 0})
            tl["result_tok"] += n
            last_in = at or last_in
            if step:
                step["tok"] = n
                if step.get("at") and at:
                    step["ms"] = int((at - step["at"]) * 1000)
                    tl["ms"] += step["ms"]
                    step["t0"], step["t1"] = step["at"], at
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
                lu = p["info"].get("last_token_usage") or {}
                cur["out"] = lu.get("output_tokens", 0) + cur["out"]
                inp, hit = lu.get("input_tokens") or 0, lu.get("cached_input_tokens") or 0
                cur["calls"].append({"at": at, "ms": None, "model": turn_ctx.get("model"), "effort": turn_ctx.get("effort"), "ttl": None,
                                     "new": max(0, inp - hit), "cache_write": 0, "cache_read": hit, "hit": round(hit / inp * 100, 1) if inp else None,
                                     "miss": False, "out": lu.get("output_tokens") or 0, "think": lu.get("reasoning_output_tokens") or 0,
                                     "sent": [], "unrecorded": 0, "got": [], "cost": None, "total": inp, "comp": None})
    close_llm(cur)
    # Right now: a tool still running, the model working (input newer than its last output), or idle.
    live_steps = [s for s in pending.values() if s.get("at")]
    if live_steps:
        st = max(live_steps, key=lambda x: x["at"])
        doing = {"state": "tool", "name": st["name"], "label": st.get("label") or "", "since": st["at"]}
    elif last_in and (not last_out or last_in > last_out) and not (turns and turns[-1].get("ms")):
        doing = {"state": "model", "since": last_in}
    else:
        doing = {"state": "idle", "since": last_at}
    for s in pending.values():
        if s.get("at"):
            s["t0"] = s.pop("at")
    for tl in tools.values():
        tl["avg_ms"] = tl["ms"] // max(1, tl["calls"])
        del tl["ms"]
    big.sort(reverse=True)
    lvl = {"error": 0, "warn": 1, "info": 2}
    cfg = codex_config()
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
            "hooks": configured_hooks(meta.get("cwd"), cfg), "mcp": mcp_servers(cfg, mcp_connected, mcp_calls, tools), "agent_types": 0,
        },
        "issues": sorted(issues.values(), key=lambda i: (lvl.get(i["level"], 3), -(i["last"] or 0))),
        "tools": sorted(tools.values(), key=lambda x: -x["result_tok"]),
        "compactions": [],
        "big": [{"tok": n, "tool": nm, "label": lb} for n, nm, lb in big[:8]],
        "turns": [turn_row(x) for x in turns[-15:]][::-1],
        "doing": doing, "price": None, "in_ctx": [{"tok": n, "tool": nm, "label": lb} for n, nm, lb in big[:5]],
        "subagents": [],
        "session": meta.get("id"), "cwd": (meta.get("cwd") or "").replace(HOME, "~"),
    }
