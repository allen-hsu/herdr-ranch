#!/usr/bin/env python3
"""More than one Claude Code / Codex login, Orca-style. Shared lib (herdr-ranch/lib): imported by the python
helpers and run by the Accounts dialog.

An account is a folder: Claude Code started with CLAUDE_CONFIG_DIR=<folder> (Codex: CODEX_HOME=<folder>) keeps
its own login there, while everything else in the folder is a symlink back to ~/.claude (~/.codex), so settings,
skills and transcripts are shared and a conversation can be resumed under another account.
Registry: ~/.config/herdr-app/ranch/accounts.json
  {"onSwitch": "ask" | "restart" | "leave",
   "claude": {"active": "default" | <id>, "accounts": [{"id", "dir", "addedAt"}]}, "codex": {...}}
"default" is the system login (~/.claude, ~/.codex). Folders: ~/.config/herdr-app/ranch/accounts/<id>/ (mode 700).
No credentials are stored, copied or read here: the logins stay where Claude Code (the macOS keychain) and Codex
(<folder>/auth.json) keep them. Only the email and plan are read, for display.

  accounts.py list                         everything the dialog shows
  accounts.py add <provider>               make a new account folder -> {"id", "dir"}
  accounts.py remove <provider> <id>       forget it and delete its folder (symlinks and its own files)
  accounts.py use <provider> <id|default>  which account new agents start with
  accounts.py on-switch <ask|restart|leave>
  accounts.py agents <provider> t8 t9 ...  running agents: account, session id, folder, background work
"""
import base64, glob, importlib, json, os, re, secrets, shutil, subprocess, sys, time

HOME = os.path.expanduser("~")
ROOT = os.path.join(HOME, ".config", "herdr-app", "ranch")
ACC = os.path.join(ROOT, "accounts")
REG = os.environ.get("HERDR_RANCH_ACCOUNTS") or os.path.join(ROOT, "accounts.json")
PROVIDERS = {
    "claude": {"name": "Claude Code", "home": os.path.join(HOME, ".claude"), "env": "CLAUDE_CONFIG_DIR",
               # Shared with ~/.claude. Not .claude.json (the login's own state), sessions, backups, cache.
               "share": ["projects", "agents", "commands", "hooks", "plugins", "skills", "output-styles", "settings.json",
                         "history.jsonl", "file-history"]},
    "codex": {"name": "Codex", "home": os.path.join(HOME, ".codex"), "env": "CODEX_HOME",
              # Shared with ~/.codex. Not auth.json (the login), not the sqlite / log files.
              "share": ["config.toml", "hooks.json", "AGENTS.md", "sessions", "skills", "prompts"]},
}
ID = re.compile(r"[a-z0-9][a-z0-9-]{0,40}")
ON_SWITCH = ("ask", "restart", "leave")


def account_dir(aid):
    """The folder of an added account, or None. Always ACC/<id>: a path in the registry is never followed."""
    if not isinstance(aid, str) or not ID.fullmatch(aid):
        return None
    d = os.path.join(ACC, aid)
    return d if os.path.isdir(d) and not os.path.islink(d) else None


def _adopt():
    """No registry yet: take in the account folders that are already there and signed in."""
    reg = {p: [] for p in PROVIDERS}
    for d in sorted(glob.glob(os.path.join(ACC, "*"))):
        aid = os.path.basename(d)
        if not account_dir(aid):
            continue
        p = "claude" if claude_info(d).get("email") else "codex" if os.path.isfile(os.path.join(d, "auth.json")) else None
        if p:
            reg[p].append({"id": aid, "dir": d, "addedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(os.stat(d).st_birthtime if hasattr(os.stat(d), "st_birthtime") else os.stat(d).st_mtime))})
    return reg


def load():
    try:
        raw = json.load(open(REG))
    except FileNotFoundError:
        raw = None
    except Exception:
        raw = {}
    adopted = _adopt() if raw is None else None
    raw = raw if isinstance(raw, dict) else {}
    reg = {"onSwitch": raw.get("onSwitch") if raw.get("onSwitch") in ON_SWITCH else "ask"}
    for p in PROVIDERS:
        sec = raw.get(p) if isinstance(raw.get(p), dict) else {}
        accs = []
        for a in (adopted[p] if adopted else sec.get("accounts") or []):
            d = account_dir(a.get("id")) if isinstance(a, dict) else None
            if d and not any(x["id"] == a["id"] for x in accs):
                accs.append({"id": a["id"], "dir": d, "addedAt": a.get("addedAt") if isinstance(a.get("addedAt"), str) else None})
        active = sec.get("active")
        reg[p] = {"active": active if any(x["id"] == active for x in accs) else "default", "accounts": accs}
    if adopted and any(adopted.values()):
        save(reg)
    return reg


def save(reg):
    os.makedirs(os.path.dirname(REG), exist_ok=True)
    tmp = "%s.tmp-%d" % (REG, os.getpid())
    with open(tmp, "w") as f:
        json.dump(reg, f, indent=2)
        f.write("\n")
    os.replace(tmp, REG)


# ---------- who is signed in (display only) ----------

def claude_info(d):
    """Email and plan from a config folder's .claude.json (the default login keeps it at ~/.claude.json)."""
    path = os.path.join(HOME, ".claude.json") if d is None else os.path.join(d, ".claude.json")
    try:
        o = json.load(open(path)).get("oauthAccount") or {}
    except Exception:
        return {}
    plan = o.get("planDisplayName") or {"stripe_subscription": "Subscription"}.get(o.get("billingType"), o.get("billingType"))
    return {"email": o.get("emailAddress"), "plan": plan, "signedIn": bool(o.get("emailAddress"))}


def codex_info(d):
    """Email and plan from the id token's public claims in <home>/auth.json. Nothing else in the file is used."""
    try:
        a = json.load(open(os.path.join(d or PROVIDERS["codex"]["home"], "auth.json")))
    except Exception:
        return {}
    info = {"signedIn": bool((a.get("tokens") or {}).get("access_token") or a.get("OPENAI_API_KEY")), "email": None, "plan": None}
    try:
        part = a["tokens"]["id_token"].split(".")[1]
        c = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
        info["email"] = c.get("email")
        info["plan"] = (c.get("https://api.openai.com/auth") or {}).get("chatgpt_plan_type")
    except Exception:
        pass
    if not info["plan"] and a.get("OPENAI_API_KEY") and not info["email"]:
        info["plan"] = "API key"
    return info


def info(provider, d):
    return claude_info(d) if provider == "claude" else codex_info(d)


def short(email):
    return (email or "").split("@")[0] or None


def active(provider, reg=None):
    """The account new agents of this provider start with: {"id", "dir" (None: the system login), "short"}."""
    reg = reg or load()
    aid = reg[provider]["active"]
    d = account_dir(aid) if aid != "default" else None
    if not d:
        return {"id": "default", "dir": None, "short": None}
    return {"id": aid, "dir": d, "short": short(info(provider, d).get("email")) or aid}


def env_for(provider, reg=None):
    """The argv prefix that starts an agent on the active account: [] for the system login."""
    a = active(provider, reg)
    return ["env", "%s=%s" % (PROVIDERS[provider]["env"], a["dir"])] if a["dir"] else []


def account_of_argv(argv):
    """(provider, account id) a terminal was started with, read from its argv (env CLAUDE_CONFIG_DIR=<folder> ...)."""
    for a in argv or []:
        for p, spec in PROVIDERS.items():
            if isinstance(a, str) and a.startswith(spec["env"] + "="):
                d = a.split("=", 1)[1].rstrip("/")
                if os.path.dirname(d) == ACC and account_dir(os.path.basename(d)):
                    return p, os.path.basename(d)
    return None, "default"


# ---------- Claude sessions: ~/.claude/sessions/<pid>.json, or the same file in an account folder ----------

def session_dirs():
    return [os.path.join(HOME, ".claude", "sessions")] + sorted(glob.glob(os.path.join(ACC, "*", "sessions")))


def session(pid):
    """The Claude Code session record of a process ({"sessionId", "cwd", ...}), whichever account it runs under."""
    try:
        name = "%d.json" % int(pid)
    except (TypeError, ValueError):
        return None
    best = None
    for d in session_dirs():
        try:
            path = os.path.join(d, name)
            s = json.load(open(path))
            m = os.path.getmtime(path)
        except Exception:
            continue
        if isinstance(s, dict) and (best is None or m > best[0]):  # a reused pid: the newest record is the live one
            best = (m, s)
    return best[1] if best else None


def session_files():
    return [f for d in session_dirs() for f in glob.glob(os.path.join(d, "*.json"))]


# ---------- commands ----------

def cmd_list():
    reg = load()
    out = {"onSwitch": reg["onSwitch"]}
    for p, spec in PROVIDERS.items():
        accs = []
        for a in reg[p]["accounts"]:
            i = info(p, a["dir"])
            added = None
            try:
                added = time.strftime("%b %-d, %Y", time.strptime((a.get("addedAt") or "")[:10], "%Y-%m-%d"))
            except ValueError:
                pass
            accs.append({"id": a["id"], "dir": a["dir"], "added": added, "email": i.get("email"), "plan": i.get("plan"),
                         "signedIn": bool(i.get("signedIn")), "short": short(i.get("email")) or a["id"]})
        d = info(p, None)
        out[p] = {"name": spec["name"], "active": reg[p]["active"], "accounts": accs, "env": env_for(p, reg),
                  "default": {"email": d.get("email"), "plan": d.get("plan"), "signedIn": bool(d.get("signedIn"))}}
    return out


def cmd_add(provider):
    spec = PROVIDERS[provider]
    reg = load()
    os.makedirs(ACC, mode=0o700, exist_ok=True)
    for _ in range(20):
        aid = "%s-%s" % (provider, secrets.token_hex(3))
        d = os.path.join(ACC, aid)
        try:
            os.mkdir(d, 0o700)
            break
        except FileExistsError:
            continue
    else:
        return {"error": "could not make a folder"}
    for name in spec["share"]:
        src = os.path.join(spec["home"], name)
        if os.path.lexists(src):
            os.symlink(src, os.path.join(d, name))
    reg[provider]["accounts"].append({"id": aid, "dir": d, "addedAt": time.strftime("%Y-%m-%dT%H:%M:%S")})
    save(reg)
    return {"id": aid, "dir": d, "env": ["env", "%s=%s" % (spec["env"], d)]}


def cmd_remove(provider, aid):
    reg = load()
    if not any(a["id"] == aid for a in reg[provider]["accounts"]):
        return {"error": "no such account"}
    d = account_dir(aid)
    reg[provider]["accounts"] = [a for a in reg[provider]["accounts"] if a["id"] != aid]
    if reg[provider]["active"] == aid:
        reg[provider]["active"] = "default"
    save(reg)
    # The folder's symlinks are unlinked (never followed) and its own files deleted. The shared folders in
    # ~/.claude / ~/.codex are untouched, and so is the login in the keychain.
    if d and os.path.dirname(d) == ACC:
        shutil.rmtree(d, ignore_errors=True)
    return {"ok": True}


def cmd_use(provider, aid):
    reg = load()
    if aid != "default" and not any(a["id"] == aid for a in reg[provider]["accounts"]):
        return {"error": "no such account"}
    reg[provider]["active"] = aid
    save(reg)
    return {"ok": True, "active": aid, "env": env_for(provider, reg)}


def cmd_on_switch(value):
    if value not in ON_SWITCH:
        return {"error": "ask, restart or leave"}
    reg = load()
    reg["onSwitch"] = value
    save(reg)
    return {"ok": True}


def _lib(name):
    try:
        return importlib.import_module(name)  # optional helpers: only mods that list them in lib.json have them
    except Exception:
        return None


def cmd_agents(provider, addrs):
    """For the restart after a switch: which account each running agent is on, and how to resume it."""
    res = {}
    subs, codexlog = _lib("subs"), _lib("codexlog")
    for addr in addrs[:40]:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", addr):
            continue
        try:
            g = json.loads(subprocess.run(["hc", "get", addr, "--json"], capture_output=True, text=True, timeout=5).stdout)
        except Exception:
            continue
        fg = g.get("foreground") or {}
        _, acct = account_of_argv(g.get("argv"))
        row = {"account": acct, "state": (g.get("status") or {}).get("state"), "session": None, "cwd": fg.get("cwd") or g.get("cwd"), "background": 0}
        if provider == "claude":
            s = session(fg.get("pid"))
            if s and isinstance(s.get("sessionId"), str) and re.fullmatch(r"[0-9a-fA-F-]{8,64}", s["sessionId"]):
                row["session"] = s["sessionId"]
                row["cwd"] = s.get("cwd") or row["cwd"]
                if subs:
                    try:
                        t = subs.transcript(addr)
                        row["background"] = len(subs.running(t) + subs.shells(t)) if t else 0
                    except Exception:
                        pass
        elif codexlog:
            try:
                path = codexlog.find_rollout(fg.get("pid"), row["cwd"], g.get("created_ms"))
            except Exception:
                path = None
            m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$", path or "")
            if m:
                row["session"] = m.group(1)
        res[addr] = row
    return res


def main(argv):
    cmd, args = (argv[0] if argv else ""), argv[1:]
    need_p = cmd in ("add", "remove", "use", "agents")
    if need_p and (not args or args[0] not in PROVIDERS):
        out = {"error": "provider: claude or codex"}
    elif cmd == "list":
        out = cmd_list()
    elif cmd == "add":
        out = cmd_add(args[0])
    elif cmd == "remove" and len(args) == 2:
        out = cmd_remove(args[0], args[1])
    elif cmd == "use" and len(args) == 2:
        out = cmd_use(args[0], args[1])
    elif cmd == "on-switch" and len(args) == 1:
        out = cmd_on_switch(args[0])
    elif cmd == "agents":
        out = cmd_agents(args[0], args[1:])
    else:
        out = {"error": "usage: list | add <provider> | remove <provider> <id> | use <provider> <id> | on-switch <mode> | agents <provider> <terminal>..."}
    print(json.dumps(out, ensure_ascii=False))
    return 1 if isinstance(out, dict) and out.get("error") else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
