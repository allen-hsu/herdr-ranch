#!/usr/bin/env python3
"""Usage numbers for the Herdr usage bar. Prints one JSON object to stdout.

Claude: GET https://api.anthropic.com/api/oauth/usage with Claude Code's own OAuth token, read
from the macOS keychain item "Claude Code-credentials".
The token is only sent to api.anthropic.com and never written anywhere. Results (percentages and
reset times only) are cached in ~/.cache/herdr-claude-status/usage.json for MIN_INTERVAL seconds.

Codex: GET https://chatgpt.com/backend-api/wham/usage with the token in ~/.codex/auth.json (sent only to
chatgpt.com); when that gives nothing, the newest rate_limits record in ~/.codex/sessions rollout files (local).

Cursor: GET https://cursor.com/api/usage-summary with cursor-agent's token from the keychain item
"cursor-access-token" (sent only to cursor.com). Grok: no source yet (always empty).

Accounts (lib/accounts.py): the numbers are the ACTIVE account's. Claude Code keeps an added account's login in
the keychain item "Claude Code-credentials-" + the first 8 hex of sha256(its config folder);
Codex keeps it in <account folder>/auth.json. Each account has its own cache file, and "account" in the output
is its short name (the part of the email before @) when it is not the system login.
"""
import glob, hashlib, json, os, subprocess, sys, time, urllib.request
import accounts
from datetime import datetime

CACHE_DIR = os.path.expanduser("~/.cache/herdr-claude-status")
CACHE = os.path.join(CACHE_DIR, "usage.json")
MIN_INTERVAL = 300
FORCE = "--force" in sys.argv


def iso(ts):
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def claude_fetch(acct):
    service = "Claude Code-credentials"
    if acct["dir"]:
        service += "-" + hashlib.sha256(acct["dir"].encode()).hexdigest()[:8]
    raw = subprocess.run(["security", "find-generic-password", "-s", service, "-w"],
                         capture_output=True, text=True, timeout=15)
    if raw.returncode != 0:
        return {"error": "keychain"}
    token = (json.loads(raw.stdout).get("claudeAiOauth") or {}).get("accessToken")
    if not token:
        return {"error": "no-token"}
    req = urllib.request.Request("https://api.anthropic.com/api/oauth/usage", headers={
        "Authorization": "Bearer " + token, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "herdr-usage-bar"})
    try:
        data = json.load(urllib.request.urlopen(req, timeout=15))
    except urllib.error.HTTPError as e:
        return {"error": "http-%d" % e.code}
    except Exception:
        return {"error": "network"}
    out = {"windows": []}
    fh = data.get("five_hour")
    if isinstance(fh, dict) and isinstance(fh.get("utilization"), (int, float)):
        out["windows"].append({"name": "5h", "percent": fh["utilization"], "resets_at": iso(fh.get("resets_at") or "")})
    for lim in data.get("limits") or []:
        if not isinstance(lim, dict) or not isinstance(lim.get("percent"), (int, float)):
            continue
        scope = ((lim.get("scope") or {}).get("model") or {}).get("display_name")
        if lim.get("kind") == "weekly_all":
            name = "7d"
        elif scope:
            name = scope
        else:
            continue
        out["windows"].append({"name": name, "percent": lim["percent"], "resets_at": iso(lim.get("resets_at") or "")})
    return out


def claude(acct):
    cache = CACHE if not acct["dir"] else os.path.join(CACHE_DIR, "usage-claude-%s.json" % acct["id"])
    try:
        cached = json.load(open(cache))
    except Exception:
        cached = None
    if cached and not FORCE and time.time() - cached.get("fetched_at", 0) < MIN_INTERVAL:
        return cached
    fresh = claude_fetch(acct)
    fresh["fetched_at"] = time.time()
    if "error" in fresh and cached and "windows" in cached:
        cached["error"] = fresh["error"]  # keep the last good numbers, note the failure
        return cached
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = cache + ".tmp"
    with open(tmp, "w") as f:
        json.dump(fresh, f)
    os.replace(tmp, cache)
    return fresh


def codex():
    files = glob.glob(os.path.expanduser("~/.codex/sessions/**/rollout-*.jsonl"), recursive=True)
    files.sort(key=lambda f: os.path.getmtime(f), reverse=True)
    for f in files[:5]:
        last = None
        try:
            with open(f, errors="replace") as fh:
                for line in fh:
                    if '"rate_limits"' in line:
                        last = line
        except OSError:
            continue
        if not last:
            continue
        try:
            rec = json.loads(last)
        except ValueError:
            continue
        stack = [rec]
        rl = None
        while stack:
            o = stack.pop()
            if isinstance(o, dict):
                if isinstance(o.get("rate_limits"), dict):
                    rl = o["rate_limits"]
                    break
                stack.extend(o.values())
        if not rl:
            continue
        windows = []
        for key in ("primary", "secondary"):
            w = rl.get(key)
            if isinstance(w, dict) and isinstance(w.get("used_percent"), (int, float)):
                mins = w.get("window_minutes") or 0
                name = "5h" if mins and mins <= 300 else "7d" if mins >= 10080 else "%dh" % (mins // 60)
                windows.append({"name": name, "percent": w["used_percent"], "resets_at": w.get("resets_at")})
        observed = iso(rec.get("timestamp") or "") or os.path.getmtime(f)
        stale = any((w.get("resets_at") or 0) < time.time() for w in windows) or not windows
        return {"windows": windows, "observed_at": observed, "stale": stale}
    return {"windows": [], "stale": True}


def cached(name, fetch):
    """Per-provider cache: ~/.cache/herdr-claude-status/usage-<name>.json, refreshed every MIN_INTERVAL."""
    path = os.path.join(CACHE_DIR, "usage-%s.json" % name)
    try:
        old = json.load(open(path))
    except Exception:
        old = None
    if old and not FORCE and time.time() - old.get("fetched_at", 0) < MIN_INTERVAL:
        return old
    try:
        fresh = fetch()
    except Exception:
        fresh = {"error": "failed"}
    fresh["fetched_at"] = time.time()
    if "error" in fresh and old and old.get("windows"):
        old["error"] = fresh["error"]
        return old
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path + ".tmp", "w") as f:
        json.dump(fresh, f)
    os.replace(path + ".tmp", path)
    return fresh


def get_json(url, headers):
    req = urllib.request.Request(url, headers={"User-Agent": "herdr-usage-bar", "Accept": "application/json", **headers})
    try:
        return json.load(urllib.request.urlopen(req, timeout=15)), None
    except urllib.error.HTTPError as e:
        return None, "http-%d" % e.code
    except Exception:
        return None, "network"


def codex_live(home=None):
    # Token from ~/.codex/auth.json, or the active account folder's auth.json;
    # sent only to chatgpt.com.
    tokens = json.load(open(os.path.join(home or os.path.expanduser("~/.codex"), "auth.json"))).get("tokens") or {}
    if not tokens.get("access_token"):
        return {"error": "no-token"}
    headers = {"Authorization": "Bearer " + tokens["access_token"]}
    if tokens.get("account_id"):
        headers["ChatGPT-Account-Id"] = tokens["account_id"]
    data, err = get_json("https://chatgpt.com/backend-api/wham/usage", headers)
    if err:
        return {"error": err}
    windows = []
    for key in ("primary_window", "secondary_window"):
        w = (data.get("rate_limit") or {}).get(key)
        if not isinstance(w, dict) or not isinstance(w.get("used_percent"), (int, float)):
            continue
        secs = w.get("limit_window_seconds") or 0
        name = "5h" if secs and secs <= 18000 else "7d" if secs >= 604800 else "%dh" % (secs // 3600)
        windows.append({"name": name, "percent": w["used_percent"], "resets_at": w.get("reset_at")})
    # Weekly first (it's the one that runs out), like Orca.
    windows.sort(key=lambda w: w["name"] != "7d")
    return {"windows": windows, "plan": data.get("plan_type")}


def cursor_live():
    # Token from the keychain item cursor-access-token (cursor-agent's sign-in).
    # Sent only to cursor.com, as the dashboard session cookie (same as Orca does).
    import base64, urllib.parse
    raw = subprocess.run(["security", "find-generic-password", "-s", "cursor-access-token", "-w"],
                         capture_output=True, text=True, timeout=15)
    token = raw.stdout.strip()
    if raw.returncode != 0 or not token:
        return {"error": "no-token"}
    try:
        part = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
        sub = claims["sub"].strip()
        if claims.get("exp") and claims["exp"] < time.time():
            return {"error": "expired · run cursor-agent login"}
    except Exception:
        return {"error": "bad-token"}
    cookie = "WorkosCursorSessionToken=%s%%3A%%3A%s" % (urllib.parse.quote(sub, safe=""), token)
    data, err = get_json("https://cursor.com/api/usage-summary",
                         {"Cookie": cookie, "Origin": "https://cursor.com", "Referer": "https://cursor.com/dashboard"})
    if err:
        return {"error": err}
    usage = data.get("individualUsage") or {}
    plan, od = usage.get("plan") or {}, usage.get("onDemand") or {}
    reset = iso(data.get("billingCycleEnd") or "") if isinstance(data.get("billingCycleEnd"), str) else None

    def pct(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None
    windows = []
    for name, v in (("Cursor Models", plan.get("autoPercentUsed")), ("Other Models", plan.get("apiPercentUsed"))):
        if pct(v) is not None:
            windows.append({"name": name, "percent": pct(v), "resets_at": reset})
    if pct(plan.get("totalPercentUsed")) is not None and not windows:
        windows.append({"name": "plan", "percent": pct(plan["totalPercentUsed"]), "resets_at": reset})
    u, l = pct(od.get("used")), pct(od.get("limit"))
    if od.get("enabled") and u is not None and l:
        windows.append({"name": "On-demand", "percent": u / l * 100, "resets_at": reset})
    elif pct(od.get("totalPercentUsed")) is not None:
        windows.append({"name": "On-demand", "percent": pct(od["totalPercentUsed"]), "resets_at": reset})
    return {"windows": windows, "plan": data.get("membershipType")}


def codex_best(acct):
    if acct["dir"]:
        # Another account: its own numbers only (the local rollout files are shared by every account).
        return cached("codex-%s" % acct["id"], lambda: codex_live(acct["dir"]))
    live = cached("codex", codex_live)
    return live if live.get("windows") else codex()


def tagged(info, acct):
    return dict(info, account=acct["short"]) if acct["dir"] else info


try:
    REG = accounts.load()
    A_CLAUDE, A_CODEX = accounts.active("claude", REG), accounts.active("codex", REG)
except Exception:
    A_CLAUDE = A_CODEX = {"id": "default", "dir": None, "short": None}
print(json.dumps({"claude": tagged(claude(A_CLAUDE), A_CLAUDE), "codex": tagged(codex_best(A_CODEX), A_CODEX),
                  "cursor": cached("cursor", cursor_live), "grok": {"windows": [], "stale": True}, "now": time.time()}))
