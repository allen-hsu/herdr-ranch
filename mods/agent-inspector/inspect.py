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
VERSION = 11
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
            "top": [{"tool": t, "n": n} for t, n in x["calls"].most_common(4)],
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
    skill_by_id = {}  # Skill tool_use id -> skill event
    slash = None  # the /command that started the current turn, until its skill text arrives
    restored = set()  # skills re-injected since the last compaction
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
                cur = {"at": at, "prompt": red(text, 140), "ms": None, "ctx0": last_ctx, "ctx1": last_ctx, "out": 0, "hooks": 0, "steps": [],
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
                    if step and ev is None:
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
            continue
        if t == "assistant":
            slash = None
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
            "skills": skill_summary(g, turns),
            "hooks": hooks,
            "mcp": mcp_summary(g),
            "agent_types": g.agent_types,
        },
        "issues": issues,
        "tools": sorted(g.tools.values(), key=lambda x: -x["result_tok"]),
        "compactions": g.compactions,
        "big": [{"tok": n, "tool": nm, "label": lb} for n, nm, lb in big[:8]],
        "turns": [{"at": x["at"], "ms": x["ms"] or (int((x.get("end", x["at"]) - x["at"]) * 1000) if x["at"] else None),
                   "prompt": x["prompt"], "ctx_delta": (x["ctx1"] or 0) - (x["ctx0"] or x["ctx1"] or 0), "out": x["out"],
                   "hooks": x["hooks"], "steps": x["steps"][-60:],
                   "skills": [{"name": e["name"], "how": e["how"], "tok": e.get("tok"), "ok": e.get("ok", True)} for e in x["skills"]],
                   "missed": [n for n in x["mentions"] if n not in {e["name"] for e in x["skills"]}]} for x in turns[-15:]][::-1],
    }


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
