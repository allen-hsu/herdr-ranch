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
import collections, glob, hashlib, json, os, pickle, re, subprocess, sys, tempfile, time
from datetime import datetime

HOME = os.path.expanduser("~")
CACHE_DIR = os.path.join(HOME, ".cache", "herdr-claude-status")
SNAPSHOT = os.path.join(CACHE_DIR, "claude-statusline.json")
VERSION = 20
# $ per million tokens: (input, output, cache read). Cache writes: 1.25x input (5 min), 2x (1 h).
# From the Claude API reference, 2026-11. Unknown models: no cost shown.
PRICES = {
    "claude-fable-5-2": (8, 40, 0.20), "claude-mythos-5-2": (8, 40, 0.20),
    "claude-fable-5-1": (10, 50, 0.25), "claude-mythos-5-1": (10, 50, 0.25), "claude-fable-5": (10, 50, 1.0),
    "claude-opus-5-5": (4, 20, 0.20), "claude-opus-5": (5, 25, 0.50), "claude-opus-4-8": (5, 25, 0.50),
    "claude-opus-4-7": (5, 25, 0.50), "claude-opus-4-6": (5, 25, 0.50),
    "claude-sonnet-5-5": (2, 10, 0.10), "claude-sonnet-5": (2, 10, 0.20), "claude-sonnet-4-6": (3, 15, 0.30),
    "claude-haiku-5-5": (0.10, 0.50, 0.01), "claude-haiku-4-5": (1, 5, 0.10),
}


def price_of(model):
    m = re.sub(r"\[.*?\]|-\d{8}$", "", str(model or ""))
    return PRICES.get(m)


def call_cost(model, u):
    p = price_of(model)
    if not p:
        return None
    cc = u.get("cache_creation") or {}
    w1h = cc.get("ephemeral_1h_input_tokens") or 0
    w5m = (u.get("cache_creation_input_tokens") or 0) - w1h
    return ((u.get("input_tokens") or 0) * p[0] + w5m * p[0] * 1.25 + w1h * p[0] * 2
            + (u.get("cache_read_input_tokens") or 0) * p[2] + (u.get("output_tokens") or 0) * p[1]) / 1e6


def union_len(iv):
    """Total length covered by a list of (start, end) intervals."""
    tot, cur = 0.0, None
    for a, b in sorted(iv):
        if cur is None or a > cur[1]:
            if cur:
                tot += cur[1] - cur[0]
            cur = [a, b]
        else:
            cur[1] = max(cur[1], b)
    return tot + (cur[1] - cur[0] if cur else 0)
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


def hook_label(c):
    """What a hook is, in words: (label, source). The command itself is often a long inline script."""
    c = c or ""
    if not c.strip():
        return "built-in (no command)", "settings"
    if "ORCA_AGENT_HOOK" in c:
        return "Orca agent hook", "settings"
    if "herdr" in c.lower():
        return "Herdr hook", "settings"
    plug = re.search(r"/plugins/(?:cache/|marketplaces/)?[^/]+/([^/]+)/", c)
    src = (plug.group(1) if plug else "plugin") if ("CLAUDE_PLUGIN_ROOT" in c or "/plugins/" in c) else "settings"
    m = re.search(r"([\w.-]+\.(?:sh|py|js|mjs|cjs|ts|cmd|bat))\b", c)
    if m:
        return m.group(1), src
    first = c.strip().split()[0] if c.strip() else "hook"
    return ("inline script" if first in ("if", "case", "[", "test") or len(c) > 60 else red(c, 40)), src


def short_cmd(c):
    c = red(c, 400)
    m = re.search(r"([\w./${}-]*hooks?/[\w./-]+)", c)
    return (m.group(1) if m else c)[:80]


def mentions(text, names):
    """Skills a prompt asks to use: "/name", or the name right after a verb like 用 / 使用 / 跑 / use / run.
    Just talking about a skill ("where is web-design-guidelines from?", "delete ui-ux-pro-max") doesn't count."""
    if len(text) > 1500 or text.startswith("This session is being continued"):
        return []  # pasted documents and compaction summaries name skills without asking for them
    low = text.lower()
    found = []
    for n in names:
        nl = n.lower()
        if len(nl) < 3 or nl not in low:
            continue
        name = re.escape(nl) + r"(?![\w-])"
        if re.search(r"(?<![\w/-])/" + name, low) or re.search(INTENT + r"\s*(?:the\s+|a\s+|這個\s*|那個\s*)?[`'\"「]?" + name, low):
            found.append(n)
    return sorted(found)[:5]


INTENT = r"(?:用|使用|跑|執行|呼叫|調用|啟用|透過|\buse|\busing|\brun|\binvoke|\bapply|\bload|\bwith)"


def mcp_key(display):
    """'claude.ai Vercel' -> 'claude_ai_Vercel', the form used in mcp__<server>__<tool> names."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", display)


# Claude Code's own slash commands: not skills.
BUILTIN_COMMANDS = set("""add-dir agents bug clear compact config context cost doctor exit export feedback fast help hooks ide init
install-github-app login logout mcp memory model output-style permissions plan plugin plugins pr-comments privacy-settings release-notes
resume review rewind security-review status statusline terminal-setup todos upgrade usage vim artifacts effort theme keybindings""".split())

AUTH_TOOLS = {"authenticate", "complete_authentication"}


def pretty_server(key):
    """claude_ai_Google_Drive -> claude.ai Google Drive; plugin_vercel_vercel -> vercel (plugin)."""
    if key.startswith("claude_ai_"):
        return "claude.ai " + key[10:].replace("_", " ")
    if key.startswith("plugin_"):
        return key.split("_")[-1] + " (plugin)"
    return key


def mcp_summary(g):
    servers = []
    failed = {mcp_key(x) for x in g.mcp_failed}
    pending = {mcp_key(x) for x in g.mcp_pending}
    for x in g.mcp.values():
        tools = x["tools"] | x["surfaced"] | x["loaded"] | set(x["calls"])
        status = "failed" if x["key"] in failed else "pending" if x["key"] in pending else \
            "needs auth" if tools and tools <= AUTH_TOOLS else "connected"
        servers.append({
            "name": x["name"], "key": x["key"], "status": status, "tools": len(tools),
            "upfront": len(x["surfaced"]), "loaded": len(x["loaded"] | x["surfaced"]), "called": len(x["calls"]),
            "calls": sum(x["calls"].values()), "errors": x["errors"],
            "top": [{"tool": t, "n": n, "avg_ms": (g.tools.get(f"mcp__{x['key']}__{t}") or {}).get("avg_ms"),
                     "errors": (g.tools.get(f"mcp__{x['key']}__{t}") or {}).get("errors", 0)} for t, n in x["calls"].most_common(8)],
            "instr_tok": x["instr_tok"], "def_tok": x["def_tok"],
            # Every deferred tool's name sits in the prompt: roughly its name in tokens.
            "list_tok": sum(len(f"mcp__{x['key']}__{t}") // 4 + 1 for t in tools),
        })
    order = {"failed": 0, "needs auth": 1, "pending": 2, "connected": 3}
    servers.sort(key=lambda s: (-(s["calls"] > 0), order[s["status"]], -s["tools"]))
    tot = lambda k: sum(s[k] for s in servers)
    return {"servers": servers, "failed": sorted(g.mcp_failed), "pending": sorted(g.mcp_pending),
            "deferred_tools": max(0, g.deferred),
            "totals": {"servers": len(servers), "connected": sum(s["status"] == "connected" for s in servers),
                       "tools": tot("tools"), "loaded": tot("loaded"), "called": tot("called"), "calls": tot("calls"),
                       "context_tok": tot("instr_tok") + tot("def_tok") + tot("list_tok")}}


def skill_summary(g, turns):
    events = [{k: v for k, v in e.items() if k != "step"} for e in g.skill_events]
    used = {}
    for e in events:
        u = used.setdefault(e["name"], {"name": e["name"], "count": 0, "restored": 0, "tok": 0, "how": [], "last": None, "failed": 0})
        if e["how"] == "restored":
            u["restored"] += 1
        else:
            u["count"] += 1
            if e["how"] not in u["how"]:
                u["how"].append(e["how"])
        u["tok"] = max(u["tok"], e.get("tok") or 0)
        u["last"] = e.get("at") or u["last"]
        u["failed"] += 0 if e.get("ok", True) else 1
    missed = collections.Counter(n for x in turns for n in x["mentions"] if n not in {e["name"] for e in x["skills"]})
    return {"available": g.skills_avail, "available_tok": g.skills_avail_tok,
            "used": sorted(used.values(), key=lambda u: -(u["last"] or 0)),
            "events": [e for e in events if e["how"] != "restored"][-40:][::-1], "missed": [{"name": n, "turns": c} for n, c in missed.most_common(8)]}


class Agg:
    def __init__(self):
        self.memory = {}          # path -> {path, type, tokens, how}
        self.skills_avail = 0
        self.skills_avail_tok = 0
        self.skill_names = set()  # every skill the listing offered
        self.skill_events = []    # one per load: {at, name, how: model|you|subagent|restored, tok, ok, error, args, allowed, turn}
        self.hooks = {}           # key -> stats
        self.mcp = {}             # server key (as in mcp__<key>__tool) -> see srv()
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

    def srv(self, key, display=None):
        x = self.mcp.setdefault(key, {"key": key, "name": display or pretty_server(key), "tools": set(), "surfaced": set(), "loaded": set(),
                                      "calls": collections.Counter(), "errors": 0, "instr_tok": 0, "def_tok": 0})
        if display:
            x["name"] = display
        return x

    def issue(self, level, kind, key, text, at):
        i = self.issues.setdefault(key, {"level": level, "kind": kind, "text": text, "count": 0, "last": None})
        i["count"] += 1
        i["last"] = at or i["last"]
        i["text"] = text

    def hook(self, a, at):
        key = (a.get("hookEvent"), a.get("hookName"), a.get("command"))
        h = self.hooks.setdefault(key, {"event": a.get("hookEvent"), "name": a.get("hookName"), "cmd": short_cmd(a.get("command")), "label": hook_label(a.get("command"))[0], "src": hook_label(a.get("command"))[1], "full": red(a.get("command"), 2000),
                                        "runs": 0, "errors": 0, "timeouts": 0, "ms": 0, "max_ms": 0, "injected": 0})
        h["runs"] += 1
        try:
            d = int(a.get("durationMs") or 0)
        except (TypeError, ValueError):
            d = 0
        h["ms"] += d
        h["max_ms"] = max(h["max_ms"], d)
        t = a.get("type")
        if t in ("hook_non_blocking_error", "hook_blocking_error", "hook_cancelled"):
            h.setdefault("errs", []).append({"at": at, "exit": a.get("exitCode"), "timeout": t == "hook_cancelled",
                                             "msg": red(a.get("stderr") or a.get("stdout") or "", 400)})
            h["errs"] = h["errs"][-3:]
        if t == "hook_non_blocking_error" or t == "hook_blocking_error":
            h["errors"] += 1
            self.issue("error", "hook", ("hook", key), f"Hook {a.get('hookName')} failed (exit {a.get('exitCode')}): {red(a.get('stderr'), 140)}", at)
        if t == "hook_cancelled":
            h["timeouts"] += 1
            self.issue("warn", "hook", ("hookto", key), f"Hook {a.get('hookName')} timed out after {int(a.get('timeoutMs') or 0) // 1000}s: {short_cmd(a.get('command'))}", at)
        if t == "hook_additional_context":
            h["injected"] += 1


STATE_VARS = ['g', 'turns', 'cur', 'first_ctx', 'last_ctx', 'out_tok', 'cache_read', 'cache_write', 'last_asst_ts', 'cache_ttl', 'pending', 'skill_by_id', 'slash', 'restored', 'big', 'last_in', 'last_any', 'reqs', 'blobs', 'calls', 'id2tool', 'shapes']


def parse(path, st=None, offset=0):
    """Read the transcript from `offset` on, continuing from a saved state `st` (both from the last run), so a
    growing session costs only its new lines. Returns (data, state, offset). The state is saved before the
    summary is built, so building it may change things freely."""
    if st is not None:
        g, turns, cur, first_ctx, last_ctx, out_tok, cache_read, cache_write, last_asst_ts, cache_ttl, pending, skill_by_id, slash, \
            restored, big, last_in, last_any, reqs, blobs, calls, id2tool, shapes = (st[k] for k in STATE_VARS)
        return _parse(path, offset, g, turns, cur, first_ctx, last_ctx, out_tok, cache_read, cache_write, last_asst_ts, cache_ttl, pending,
                      skill_by_id, slash, restored, big, last_in, last_any, reqs, blobs, calls, id2tool, shapes)
    return _parse(path, 0, *_fresh())


def _fresh():
    g = Agg()
    turns = []
    cur = None
    first_ctx = last_ctx = None
    out_tok = cache_read = cache_write = 0
    last_asst_ts, cache_ttl = None, 300
    pending = {}  # tool_use id -> step
    skill_by_id = {}  # Skill tool_use id -> skill event
    slash = None  # the /command that started the current turn, until its skill text arrives
    restored = set()  # skills re-injected since the last compaction
    big = []
    last_in = last_any = None  # last prompt or tool result; last record of any kind
    # Per API call (Claude Code records each request: api-request + api-request-blob; responses carry requestRef).
    reqs, blobs, calls, id2tool, shapes = {}, {}, {}, {}, {}
    return (g, turns, cur, first_ctx, last_ctx, out_tok, cache_read, cache_write, last_asst_ts, cache_ttl, pending, skill_by_id, slash,
            restored, big, last_in, last_any, reqs, blobs, calls, id2tool, shapes)


def _parse(path, offset, g, turns, cur, first_ctx, last_ctx, out_tok, cache_read, cache_write, last_asst_ts, cache_ttl, pending,
           skill_by_id, slash, restored, big, last_in, last_any, reqs, blobs, calls, id2tool, shapes):
    fh = open(path, "rb")
    fh.seek(offset)
    while True:
        raw = fh.readline()
        if not raw or not raw.endswith(b"\n"):  # end, or a line still being written: stop before it
            break
        offset += len(raw)
        line = raw.decode("utf-8", "replace")
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get("isSidechain"):
            continue
        t = r.get("type")
        at = ts(r.get("timestamp") or "")
        if t == "api-request-shape":
            sh = r.get("shape") or {}
            sysl = sh.get("system") or []
            shapes[r.get("shapeHash")] = {"system": sum(len(x.get("text") or "") for x in sysl if isinstance(x, dict)) // 4,
                                          "tools": len(json.dumps(sh.get("tools") or [], ensure_ascii=False)) // 4, "n_tools": len(sh.get("tools") or [])}
            continue
        if t == "api-request":
            pr = r.get("params") or {}
            ttl = next(((c.get("value") or {}).get("ttl") for c in r.get("cacheControl") or [] if (c.get("path") or [None])[0] == "messages"), None)
            reqs[r.get("id")] = {"at": at, "model": pr.get("model"), "effort": (pr.get("output_config") or {}).get("effort"),
                                 "thinking": (pr.get("thinking") or {}).get("type"), "tail": r.get("tail") or [], "ttl": ttl, "src": r.get("querySource"), "shape": r.get("shapeHash")}
            continue
        if t == "api-request-blob":
            msg = r.get("message") or {}
            parts = []
            for b in msg.get("content") or [] if isinstance(msg.get("content"), list) else [{"type": "text", "text": str(msg.get("content") or "")}]:
                if not isinstance(b, dict):
                    continue
                bt = b.get("type")
                if bt == "tool_result":
                    cc = b.get("content")
                    n = len(cc) if isinstance(cc, str) else len(json.dumps(cc, ensure_ascii=False))
                    parts.append({"k": "tool_result", "id": b.get("tool_use_id"), "chars": n, "err": bool(b.get("is_error"))})
                elif bt == "text":
                    tx = b.get("text") or ""
                    kind = "reminder" if tx.lstrip().startswith("<system-reminder>") else "text"
                    parts.append({"k": kind, "chars": len(tx), "snip": red(human_text(tx), 80) if kind == "text" else ""})
                elif bt:
                    parts.append({"k": bt, "chars": len(json.dumps(b, ensure_ascii=False))})
            blobs[r.get("hash")] = {"role": msg.get("role"), "parts": parts}
            continue
        m = r.get("message") or {}
        a = r.get("attachment")
        if at and t in ("user", "assistant"):
            last_any = at
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
                g.skill_names |= {n for n in (a.get("names") or []) if isinstance(n, str)}
            elif at_ == "invoked_skills":
                # Skills already loaded, put back into context after a compaction: not a new call (once per compaction).
                for sk in a.get("skills") or []:
                    if sk.get("name") in restored:
                        continue
                    restored.add(sk.get("name"))
                    g.skill_events.append({"at": at, "name": sk.get("name"), "how": "restored", "tok": tok(sk.get("content") or ""), "ok": True,
                                           "turn": len(turns) - 1, "prompt": cur["prompt"] if cur else ""})
            elif at_ == "mcp_instructions_delta":
                for name, block in zip(a.get("addedNames") or [], a.get("addedBlocks") or []):
                    g.srv(mcp_key(name), name)["instr_tok"] = tok(block)
            elif at_ == "deferred_tools_delta":
                g.mcp_failed |= set(a.get("failedMcpServers") or [])
                g.mcp_pending |= set(a.get("pendingMcpServers") or [])
                g.deferred += len(a.get("addedNames") or []) - len(a.get("removedNames") or [])
                for n in a.get("addedNames") or []:
                    if isinstance(n, str) and n.startswith("mcp__"):
                        g.srv(n.split("__")[1])["tools"].add(n.split("__", 2)[-1])
                for n in a.get("removedNames") or []:
                    if isinstance(n, str) and n.startswith("mcp__"):
                        g.srv(n.split("__")[1])["tools"].discard(n.split("__", 2)[-1])
                for d in a.get("surfacedDefinitions") or []:
                    n = (d or {}).get("name") or ""
                    if n.startswith("mcp__"):
                        x = g.srv(n.split("__")[1]); x["surfaced"].add(n.split("__", 2)[-1]); x["def_tok"] += tok(d.get("definition") or {})
            elif at_ == "deferred_tools_record":
                # Schemas fetched on demand (ToolSearch): the tool is now usable.
                for e in a.get("entries") or []:
                    n = (e or {}).get("name") or ""
                    if n.startswith("mcp__"):
                        x = g.srv(n.split("__")[1]); x["loaded"].add(n.split("__", 2)[-1]); x["def_tok"] += tok(e)
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
                try:
                    hms = int(a.get("durationMs") or 0)
                except (TypeError, ValueError):
                    hms = 0
                if cur is not None and at and hms >= 50:
                    cur["spans"].append({"k": "hook", "name": f"{a.get('hookEvent') or 'hook'} · {a.get('hookName') or ''}".strip(" ·"),
                                         "t0": at - hms / 1000, "t1": at, "err": at_ in ("hook_non_blocking_error", "hook_cancelled", "hook_blocking_error")})
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
                restored = set()
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
            if isinstance(c, str) and r.get("isMeta"):
                # The skill's own instructions, injected right after it is invoked (by the Skill tool or a /command).
                ev = skill_by_id.get(r.get("sourceToolUseID")) or (slash if slash and not r.get("sourceToolUseID") else None)
                if ev is slash:
                    slash = None  # only the first injected text right after the /command is its skill
                if ev is not None and not ev.get("tok"):
                    ev["tok"] = tok(c)
                    if ev.get("step") is not None:
                        ev["step"]["tok"] = ev["tok"]
                continue
            if isinstance(c, str):
                text = human_text(c)
                if not text or text.startswith("<local-command"):
                    continue
                cmd = None
                if text.startswith("<command-name>") or text.startswith("<command-message>"):
                    cmd = text.split("<command-name>")[1].split("</command-name>")[0].lstrip("/") if "<command-name>" in text else None
                    args = text.split("<command-args>")[1].split("</command-args>")[0] if "<command-args>" in text else ""
                    text = "/" + cmd + (" " + args if args else "") if cmd else text
                last_in = at or last_in
                cur = {"at": at, "prompt": red(text, 140), "ms": None, "ctx0": last_ctx, "ctx1": last_ctx, "out": 0, "hooks": 0, "steps": [], "spans": [],
                       "skills": [], "in_skill": None, "mentions": mentions(text, g.skill_names) if not cmd else []}
                turns.append(cur)
                slash = None
                if cmd and (cmd in g.skill_names or cmd not in BUILTIN_COMMANDS):  # skills and custom/plugin commands
                    slash = {"at": at, "name": cmd, "how": "you", "tok": 0, "ok": True, "args": red(args, 80) if args else "",
                             "turn": len(turns) - 1, "prompt": cur["prompt"]}
                    slash["step"] = {"k": "skill", "name": cmd, "how": "you", "tok": None, "label": slash["args"]}
                    cur["steps"].append(slash["step"]); cur["skills"].append(slash); cur["in_skill"] = cmd
                    g.skill_events.append(slash)
            elif isinstance(c, list):
                pd = r.get("permissionDecision") if isinstance(r.get("permissionDecision"), dict) else None
                for b in c:
                    if not (isinstance(b, dict) and b.get("type") == "tool_result"):
                        continue
                    cc = b.get("content")
                    text = cc if isinstance(cc, str) else " ".join(x.get("text", "") for x in (cc or []) if isinstance(x, dict))
                    n = len(text) // 4
                    step = pending.pop(b.get("tool_use_id"), None)
                    name = (step.get("tool") or step["name"]) if step else "?"
                    ev = skill_by_id.get(b.get("tool_use_id"))
                    if ev is not None:
                        tur = r.get("toolUseResult") if isinstance(r.get("toolUseResult"), dict) else {}
                        ev["allowed"] = [red(x, 40) for x in (tur.get("allowedTools") or [])][:6]
                        if tur.get("status") or tur.get("agentId"):
                            ev["forked"] = True
                        if b.get("is_error") or tur.get("success") is False:
                            ev["ok"] = False
                            ev["error"] = red(text, 120)
                            g.issue("warn", "skill", ("skill", ev["name"]), f"Skill {ev['name']} failed to load: {red(text, 100)}", at)
                    tool = g.tools.setdefault(name, {"name": name, "calls": 0, "result_tok": 0, "errors": 0, "ms": 0})
                    tool["result_tok"] += n
                    if step is not None and at:
                        step["t0"] = step.pop("at", None) or step.get("t0")
                        step["t1"] = at
                    if step and ev is None:
                        step["tok"] = n
                        if step.get("t0") and at:
                            step["ms"] = int((at - step["t0"]) * 1000)
                            tool["ms"] += step["ms"]
                        big.append((n, name, step.get("label", ""), at))
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
                        if name.startswith("mcp__"):
                            g.srv(name.split("__")[1])["errors"] += 1
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
                last_in = at or last_in
            continue
        if t == "assistant":
            slash = None
            u = m.get("usage") or {}
            ref = r.get("requestRef")
            if ref:
                c = calls.get(ref)
                if c is None:
                    c = calls[ref] = {"first": at, "last": at, "usage": {}, "blocks": [], "turn": len(turns) - 1}
                    if cur is not None:
                        cur.setdefault("calls", []).append(ref)
                c["last"] = at or c["last"]
                if u:
                    c["usage"] = u
                for b in m.get("content") or []:
                    if isinstance(b, dict):
                        if b.get("type") == "tool_use":
                            id2tool[b.get("id")] = b.get("name")
                            c["blocks"].append({"k": "tool", "name": b.get("name"), "label": label(b.get("name"), b.get("input"))})
                        elif b.get("type") in ("text", "thinking", "redacted_thinking"):
                            c["blocks"].append({"k": b.get("type"), "chars": len(b.get("text") or b.get("thinking") or "")})
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
                    g.srv(name.split("__")[1])["calls"][name.split("__", 2)[-1]] += 1
                if name == "Skill":
                    inp = b.get("input") or {}
                    sk = str(inp.get("skill") or "?")
                    step = {"k": "skill", "tool": "Skill", "name": sk, "how": "model", "label": red(inp.get("args"), 90) if inp.get("args") else "", "at": at}
                    ev = {"at": at, "name": sk, "how": "model", "tok": 0, "ok": True, "args": step["label"], "step": step,
                          "turn": len(turns) - 1, "prompt": cur["prompt"] if cur else ""}
                    skill_by_id[b.get("id")] = ev
                    g.skill_events.append(ev)
                    pending[b.get("id")] = step
                    if cur is not None:
                        cur["steps"].append(step); cur["skills"].append(ev); cur["in_skill"] = sk
                    continue
                step = {"k": "agent" if name in ("Agent", "Task") else "tool", "name": name, "label": label(name, b.get("input")), "at": at}
                if cur is not None and cur.get("in_skill"):
                    step["in"] = cur["in_skill"]
                pending[b.get("id")] = step
                if cur is not None:
                    cur["steps"].append(step)
    fh.close()
    state = pickle.dumps(dict(zip(STATE_VARS, (g, turns, cur, first_ctx, last_ctx, out_tok, cache_read, cache_write, last_asst_ts, cache_ttl,
                                               pending, skill_by_id, slash, restored, big, last_in, last_any, reqs, blobs, calls, id2tool, shapes))),
                         protocol=pickle.HIGHEST_PROTOCOL)
    for s in pending.values():
        if s.get("at"):
            s["t0"] = s.pop("at")
    if g.mcp_failed:
        g.issue("error", "mcp", ("mcpfail",), "MCP servers failed to connect: " + ", ".join(sorted(g.mcp_failed)), None)
    if g.cache_drops:
        g.issue("info", "cache", ("cachedrop",), f"Prompt cache prefix changed {g.cache_drops}× (thinking dropped / cache rebuilt)", None)
    big.sort(key=lambda b: -b[0])
    # What it's doing right now: a tool still running (or a question waiting for you), the model working, or idle.
    now_state = {"state": "idle", "since": last_any}
    live = [st for st in pending.values() if st.get("t0")]
    if live:
        st = max(live, key=lambda x: x["t0"])
        now_state = {"state": "ask" if st.get("name") in ASKS_USER else "tool", "name": st.get("tool") or st.get("name"), "label": st.get("label") or "", "since": st["t0"]}
    elif last_in and (not last_asst_ts or last_in > last_asst_ts):
        now_state = {"state": "model", "since": last_in}
    lvl = {"error": 0, "warn": 1, "info": 2}
    issues = sorted(g.issues.values(), key=lambda i: (lvl.get(i["level"], 3), -(i["last"] or 0)))
    memory = sorted(g.memory.values(), key=lambda x: -x["tokens"])
    mem_tok = sum(x["tokens"] for x in memory if x.get("how") == "startup")
    hooks = sorted(g.hooks.values(), key=lambda h: (-(h["errors"] + h["timeouts"]), -h["runs"]))
    for h in hooks:
        h["avg_ms"] = h["ms"] // max(1, h["runs"])
        del h["ms"]
    for tl in g.tools.values():
        tl["avg_ms"] = tl["ms"] // max(1, tl["calls"])
        del tl["ms"]
    data = {
        "first_ctx": first_ctx, "ctx": last_ctx, "out": out_tok, "cache_read": cache_read, "cache_write": cache_write,
        "model": g.model, "cache_until": (last_asst_ts + cache_ttl) if last_asst_ts else None, "cache_ttl": cache_ttl,
        "prompt_count": len(turns),
        "config": {
            "system_prompt_tok": (g.sys_chars or 0) // 4, "output_style": g.output_style, "permission_mode": g.perm_mode,
            "memory": memory, "memory_tok": sum(x["tokens"] for x in memory),
            "skills": skill_summary(g, turns),
            "hooks": hooks,
            "mcp": mcp_summary(g),
            "agent_types": g.agent_types,
        },
        "issues": issues,
        "tools": sorted(g.tools.values(), key=lambda x: -x["result_tok"]),
        "compactions": g.compactions,
        "big": [{"tok": n, "tool": nm, "label": lb} for n, nm, lb, _ in big[:8]],
        # Big tool results read since the last compaction: still in context now.
        "in_ctx": [{"tok": n, "tool": nm, "label": lb} for n, nm, lb, w in big
                   if not g.compactions or (w or 0) > (g.compactions[-1]["at"] or 0)][:5],
        "price": dict(zip(("in", "out", "read"), price_of(g.model))) if price_of(g.model) else None,
        "doing": now_state,
        "turns": [turn_row(x, reqs, calls, blobs, id2tool, shapes, mem_tok) for x in turns[-15:]][::-1],
    }
    return data, state, offset


ASKS_USER = {"AskUserQuestion", "ExitPlanMode"}  # time spent here is the agent waiting for you


def turn_row(x, reqs, calls, blobs, id2tool, shapes, mem_tok):
    """One turn: summary numbers, the time split (model / tools / other), and a waterfall of spans
    (LLM calls, tools, hooks) as offsets in seconds from the prompt."""
    t0 = x["at"]
    rows = call_rows(x.get("calls", [])[-30:], reqs, calls, blobs, id2tool, shapes, mem_tok)
    steps = x["steps"][-60:]
    spans = []
    if t0:
        for j, c in enumerate(rows):
            if c.get("at") and c.get("ms") is not None:
                tools = [g["name"] for g in c["got"] if g["k"] == "tool"]
                think = any(g["k"] in ("thinking", "redacted_thinking") for g in c["got"])
                what = " → ".join(filter(None, ["thinking" if think else "", "reply" if any(g["k"] == "text" for g in c["got"]) else "", ", ".join(tools[:3]) + ("…" if len(tools) > 3 else "")]))
                spans.append({"k": "llm", "name": f"LLM #{j + 1}", "label": what, "s": c["at"] - t0, "e": c["at"] - t0 + c["ms"] / 1000, "call": j})
        for j, st in enumerate(steps):
            if st.get("t0") and st["k"] in ("tool", "agent", "skill"):
                end = st.get("t1")
                asks = st["name"] in ASKS_USER or ":user" in str(st.get("perm") or "")
                spans.append({"k": "wait" if asks else "agent" if st["k"] == "agent" else "skill" if st["k"] == "skill" else "tool", "name": st["name"], "label": st.get("label") or "",
                              "s": st["t0"] - t0, "e": (end - t0) if end else None, "step": j, "err": bool(st.get("error")),
                              "perm": st.get("perm"), "tok": st.get("tok")})
        for h in x.get("spans", []):
            spans.append({"k": "hook", "name": h["name"], "label": "", "s": h["t0"] - t0, "e": h["t1"] - t0, "err": h["err"]})
    for st in steps:
        st.pop("t0", None); st.pop("t1", None)
    total = (x["ms"] or (int((x.get("end", t0) - t0) * 1000) if t0 else 0)) / 1000
    total = max([total] + [sp["e"] for sp in spans if sp["e"] is not None])
    for sp in spans:
        if sp["e"] is None:  # still running
            sp["e"] = total
            sp["open"] = True
        sp["s"] = max(0.0, round(sp["s"], 3)); sp["e"] = round(max(sp["e"], sp["s"]), 3)
    spans.sort(key=lambda sp: (sp["s"], sp["k"] != "llm"))
    llm = [(sp["s"], sp["e"]) for sp in spans if sp["k"] == "llm"]
    wait = [(sp["s"], sp["e"]) for sp in spans if sp["k"] == "wait"]
    work = [(sp["s"], sp["e"]) for sp in spans if sp["k"] not in ("llm", "wait")]
    model_s = union_len(llm)
    busy0 = union_len(llm + work)
    busy = union_len(llm + work + wait)
    costs = [c["cost"] for c in rows if c.get("cost") is not None]
    inn = sum(c["new"] + c["cache_write"] for c in rows)
    cached = sum(c["cache_read"] for c in rows)
    return {"at": t0, "ms": int(total * 1000) if t0 else x["ms"],
            "prompt": x["prompt"], "ctx_delta": (x["ctx1"] or 0) - (x["ctx0"] or x["ctx1"] or 0), "out": x["out"],
            "hooks": x["hooks"], "steps": steps, "calls": rows, "spans": spans[:120],
            "split": {"model": round(model_s, 2), "tools": round(busy0 - model_s, 2), "you": round(busy - busy0, 2), "other": round(max(0.0, total - busy), 2)} if spans else None,
            "sum": {"calls": len(rows), "tools": sum(1 for s in steps if s["k"] in ("tool", "agent")), "in_new": inn, "in_cached": cached,
                    "hit": round(cached / (inn + cached) * 100, 1) if inn + cached else None, "out": sum(c["out"] for c in rows),
                    "think": sum(c["think"] for c in rows), "cost": round(sum(costs), 4) if costs else None,
                    "errors": sum(1 for s in steps if s.get("error")), "misses": sum(1 for c in rows if c["miss"])},
            "skills": [{"name": e["name"], "how": e["how"], "tok": e.get("tok"), "ok": e.get("ok", True)} for e in x["skills"]],
            "missed": [n for n in x["mentions"] if n not in {e["name"] for e in x["skills"]}]}


def call_rows(refs, reqs, calls, blobs, id2tool, shapes=None, mem_tok=0):
    """Each API call of a turn: when, how long, what it sent that was new, the input split
    (new / cache write / cache read), the output (and thinking), and what came back."""
    out, prev_read = [], None
    for ref in refs:
        c = calls.get(ref) or {}
        q = reqs.get(ref) or {}
        u = c.get("usage") or {}
        new, cw, cr = u.get("input_tokens") or 0, u.get("cache_creation_input_tokens") or 0, u.get("cache_read_input_tokens") or 0
        start = q.get("at") or c.get("first")
        sent, missing = [], 0
        for h in q.get("tail") or []:
            b = blobs.get(h)
            if not b:
                missing += 1
                continue
            for p in b["parts"]:
                if p["k"] == "tool_result":
                    sent.append({"k": "tool_result", "name": id2tool.get(p.get("id"), "tool"), "tok": p["chars"] // 4, "err": p.get("err")})
                elif p["k"] == "text":
                    sent.append({"k": "you" if b.get("role") == "user" else "text", "tok": p["chars"] // 4, "snip": p.get("snip", "")})
                else:
                    sent.append({"k": p["k"], "tok": p["chars"] // 4})
        total = new + cw + cr
        sh = (shapes or {}).get(q.get("shape")) or {}
        new_tok = sum(x["tok"] for x in sent)
        comp = None
        if total and sh:
            fixed = [("system", sh["system"]), ("tools", sh["tools"]), ("memory", mem_tok), ("new", new_tok)]
            used = sum(v for _, v in fixed)
            f = min(1.0, total / used) if used else 1.0  # estimates (chars/4) can overshoot: scale down to fit
            comp = {k: int(v * f) for k, v in fixed}
            comp["history"] = max(0, total - sum(comp.values()))
            comp["n_tools"] = sh["n_tools"]
        out.append({"cost": call_cost(q.get("model"), u), "total": total, "comp": comp,"at": start, "ms": int((c["last"] - start) * 1000) if c.get("last") and start else None,
                    "model": q.get("model"), "effort": q.get("effort"), "ttl": q.get("ttl"),
                    "new": new, "cache_write": cw, "cache_read": cr, "hit": round(cr / total * 100, 1) if total else None,
                    "miss": bool(prev_read and cr < prev_read * 0.5),
                    "out": u.get("output_tokens") or 0, "think": (u.get("output_tokens_details") or {}).get("thinking_tokens") or 0,
                    "sent": sent[:12], "unrecorded": missing, "got": c.get("blocks", [])[:12]})
        prev_read = cr or prev_read
    return out


def subagents(path, sid):
    res = []
    for meta in sorted(glob.glob(os.path.join(os.path.dirname(path), sid, "subagents", "*.meta.json"))):
        try:
            mj = json.load(open(meta))
        except Exception:
            continue
        jl = meta[: -len(".meta.json")] + ".jsonl"
        out_tok, cx, tool_n, skills = 0, 0, 0, []
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
                    for b in r["message"].get("content") or []:
                        if isinstance(b, dict) and b.get("type") == "tool_use":
                            tool_n += 1
                            if b.get("name") == "Skill":
                                skills.append(str((b.get("input") or {}).get("skill") or "?"))
        except OSError:
            pass
        res.append({"desc": red(mj.get("description"), 60), "type": mj.get("agentType"), "finished": mj.get("finished"),
                    "out": out_tok, "ctx": cx, "tools": tool_n, "skills": sorted(set(skills))})
    return res


def head_sig(path):
    with open(path, "rb") as f:
        return hashlib.sha1(f.read(4096)).hexdigest()


def parse_incremental(path, sid, st):
    """Continue from the saved parser state when the file only grew (same file, same first 4 KB);
    otherwise parse from the start. The state lives next to the JSON cache, owner-only."""
    sfile = os.path.join(CACHE_DIR, "inspect-%s.state" % sid)
    sig = head_sig(path)
    saved = None
    try:
        with open(sfile, "rb") as f:
            saved = pickle.load(f)
        if not (saved.get("v") == VERSION and saved.get("ino") == st.st_ino and saved.get("sig") == sig and saved.get("offset", 0) <= st.st_size):
            saved = None
    except Exception:
        saved = None
    if saved:
        data, state, offset = parse(path, pickle.loads(saved["state"]), saved["offset"])
    else:
        data, state, offset = parse(path)
    fd, tmp = tempfile.mkstemp(dir=CACHE_DIR, prefix=".inspect-")
    with os.fdopen(fd, "wb") as f:
        pickle.dump({"v": VERSION, "ino": st.st_ino, "sig": sig, "offset": offset, "state": state}, f, protocol=pickle.HIGHEST_PROTOCOL)
    os.replace(tmp, sfile)
    return data


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
        data = parse_incremental(path, sid, st)
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
