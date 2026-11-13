#!/usr/bin/env python3
"""accounts.py sync: in a throwaway HOME, the account's .claude.json gains the person's trusted folders, MCP
servers and missing settings, keeps its own login and its own records, and a second run changes nothing."""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.join(HERE, "..", "..", "lib", "accounts.py")

with tempfile.TemporaryDirectory() as home:
    ranch = os.path.join(home, ".config", "herdr-app", "ranch")
    acc = os.path.join(ranch, "accounts", "acc1")
    os.makedirs(acc)
    os.makedirs(os.path.join(home, ".claude", "skills"))
    json.dump({"oauthAccount": {"emailAddress": "main@example.com"}, "userID": "MAIN", "theme": "dark", "newKey": 1,
               "cachedThing": 9, "mcpServers": {"ctx": {"command": "a"}, "same": {"command": "main"}},
               "projects": {"/a": {"hasTrustDialogAccepted": True, "allowedTools": ["x"]},
                            "/b": {"hasTrustDialogAccepted": True, "lastCost": 1},
                            "/c": {"hasTrustDialogAccepted": False}}}, open(os.path.join(home, ".claude.json"), "w"))
    json.dump({"oauthAccount": {"emailAddress": "second@example.com"}, "userID": "SECOND", "theme": "light",
               "mcpServers": {"own": {"command": "o"}, "same": {"command": "acct"}},
               "projects": {"/b": {"hasTrustDialogAccepted": False, "lastCost": 7}, "/c": {"hasTrustDialogAccepted": True},
                            "/d": {"hasTrustDialogAccepted": True}}}, open(os.path.join(acc, ".claude.json"), "w"))
    json.dump({"onSwitch": "ask", "claude": {"active": "acc1", "accounts": [{"id": "acc1"}]},
               "codex": {"active": "default", "accounts": []}}, open(os.path.join(ranch, "accounts.json"), "w"))
    env = {**os.environ, "HOME": home}
    env.pop("HERDR_RANCH_ACCOUNTS", None)
    run = lambda: json.loads(subprocess.run([sys.executable, PY, "sync", "claude"], env=env, capture_output=True, text=True, check=True).stdout)
    first, second = run(), run()
    got = json.load(open(os.path.join(acc, ".claude.json")))
    checks = {
        "first run syncs": first["claude"]["acc1"]["state"] == "synced",
        "second run changes nothing": second["claude"]["acc1"] == {"linked": 0, "state": "unchanged"},
        "login stays the account's": got["oauthAccount"]["emailAddress"] == "second@example.com" and got["userID"] == "SECOND",
        "caches are not copied": "cachedThing" not in got,
        "own setting kept, missing one filled in": got["theme"] == "light" and got["newKey"] == 1,
        "MCP servers: the person's added, the account's own kept": got["mcpServers"] == {"own": {"command": "o"}, "same": {"command": "main"}, "ctx": {"command": "a"}},
        "new folder comes over trusted": got["projects"]["/a"] == {"hasTrustDialogAccepted": True, "allowedTools": ["x"]},
        "trust is added, own records kept": got["projects"]["/b"] == {"hasTrustDialogAccepted": True, "lastCost": 7},
        "trust is never removed": got["projects"]["/c"]["hasTrustDialogAccepted"] is True and "/d" in got["projects"],
        "file stays private": (os.stat(os.path.join(acc, ".claude.json")).st_mode & 0o777) == 0o600,
        "shared entries are linked": os.path.islink(os.path.join(acc, "skills")),
        "pointer names the account": open(os.path.join(ranch, "active-claude")).read().strip() == acc,
    }
    add = lambda *n: json.loads(subprocess.run([sys.executable, PY, "add", "claude", *n], env=env, capture_output=True, text=True).stdout)
    named, again, odd = add("My Work!"), add("my work"), add("...")
    checks.update({
        "a named account gets a readable folder": named.get("id") == "claude-my-work" and os.path.isdir(os.path.join(ranch, "accounts", "claude-my-work")),
        "a new account starts with the person's setup": json.load(open(os.path.join(ranch, "accounts", "claude-my-work", ".claude.json"))).get("mcpServers", {}).get("ctx") == {"command": "a"}
            and "oauthAccount" not in json.load(open(os.path.join(ranch, "accounts", "claude-my-work", ".claude.json"))),
        "a name can't be used twice": "error" in again,
        "a name needs letters or digits": "error" in odd,
    })
    bad = [k for k, ok in checks.items() if not ok]
    for k, ok in checks.items():
        print(("ok   " if ok else "FAIL ") + k)
    sys.exit(1 if bad else 0)
