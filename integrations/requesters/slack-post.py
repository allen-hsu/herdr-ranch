#!/usr/bin/env python3
"""Herdr PR-panel requester: post a "please review" message to Slack as the user (user token, chat:write).

Called by mods/pr-panel with the PR in env vars HERDR_PR_URL, HERDR_PR_REPO, HERDR_PR_NUMBER, HERDR_PR_TITLE.
Prints {"ok": bool, "message"?: str, "error"?: str, "hint"?: str}.
Note: bots that ignore app-posted messages (e.g. Hermes Agent without SLACK_API_HUMAN_USERS) won't react.


Token: macOS keychain item service "herdr-slack-review", account "user-token" (never written to disk).
Config: ~/.config/herdr-app/slack-review.json
  {"channel": "C0123ABCD", "bot": "U0456EFGH", "template": "<@{bot}> 請幫忙 review {url}"}
Usage:
  slack-post.py check   -> {"ok": true, "team": ..., "user_id": ..., "channel": ...}
  slack-post.py         -> posts for the PR in the HERDR_PR_* env vars
Only talks to slack.com. Prints one JSON object.
"""
import json, os, subprocess, sys, urllib.parse, urllib.request

CONFIG = os.path.expanduser("~/.config/herdr-app/slack-review.json")
DEFAULT_TEMPLATE = "<@{bot}> 請幫忙 review {url}"


def out(**kw):
    print(json.dumps(kw, ensure_ascii=False))
    sys.exit(0)


def token():
    r = subprocess.run(["security", "find-generic-password", "-s", "herdr-slack-review", "-a", "user-token", "-w"],
                       capture_output=True, text=True, timeout=15)
    t = r.stdout.strip()
    if r.returncode != 0 or not t:
        out(ok=False, error="no-token", hint="Store the Slack user token in the keychain (see README).")
    if not t.startswith("xoxp-"):
        out(ok=False, error="not-a-user-token", hint="Use the User OAuth Token (xoxp-…), so the review bot sees a message from you.")
    return t


def api(method, tok, params, post=False):
    url = "https://slack.com/api/" + method
    headers = {"Authorization": "Bearer " + tok, "User-Agent": "herdr-slack-review"}
    if post:
        req = urllib.request.Request(url, data=json.dumps(params).encode(), method="POST",
                                     headers={**headers, "Content-Type": "application/json; charset=utf-8"})
    else:
        req = urllib.request.Request(url + "?" + urllib.parse.urlencode(params), headers=headers)
    try:
        return json.load(urllib.request.urlopen(req, timeout=15))
    except Exception as e:
        return {"ok": False, "error": "network: %s" % type(e).__name__}


def config():
    try:
        c = json.load(open(CONFIG))
    except FileNotFoundError:
        out(ok=False, error="no-config", hint="Create %s with channel and bot IDs." % CONFIG)
    except ValueError:
        out(ok=False, error="bad-config")
    if not str(c.get("channel", "")).startswith(("C", "G")):
        out(ok=False, error="bad-config", hint="channel must be a channel ID (C…).")
    if sys.argv[1:2] != ["check"] and not str(c.get("bot", "")).startswith(("U", "B", "W")):
        out(ok=False, error="bad-config", hint="bot must be the review bot's member ID (U…/B…).")
    return c


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "post"
    c = config()
    tok = token()
    if cmd == "check":
        a = api("auth.test", tok, {})
        if not a.get("ok"):
            out(ok=False, error=a.get("error"))
        info = api("conversations.info", tok, {"channel": c["channel"]})
        out(ok=True, team=a.get("team"), team_id=a.get("team_id"), user=a.get("user"), user_id=a.get("user_id"),
            channel=(info.get("channel") or {}).get("name") if info.get("ok") else None,
            channel_error=None if info.get("ok") else info.get("error"))
    if cmd == "post":
        e = os.environ
        url, repo, number, title = (e.get("HERDR_PR_URL", ""), e.get("HERDR_PR_REPO", ""),
                                    e.get("HERDR_PR_NUMBER", ""), e.get("HERDR_PR_TITLE", ""))
        if not url.startswith("https://github.com/"):
            out(ok=False, error="bad-url")
        text = c.get("template", DEFAULT_TEMPLATE).format(bot=c["bot"], url=url, repo=esc(repo), number=esc(number), title=esc(title))
        r = api("chat.postMessage", tok, {"channel": c["channel"], "text": text, "unfurl_links": True}, post=True)
        if not r.get("ok"):
            out(ok=False, error=r.get("error"))
        link = api("chat.getPermalink", tok, {"channel": c["channel"], "message_ts": r.get("ts")})
        out(ok=True, message="Posted to Slack", permalink=link.get("permalink"))
    out(ok=False, error="usage")


if __name__ == "__main__":
    main()
