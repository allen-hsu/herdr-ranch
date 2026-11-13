#!/usr/bin/env python3
"""sessions.py list, in a throwaway HOME: what is listed, what is left out, and that odd files don't empty the list."""
import json, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.join(HERE, "..", "..", "lib", "sessions.py")
enc = lambda d: re.sub(r"[^A-Za-z0-9]", "-", d)
U = lambda n: "00000000-0000-4000-8000-%012d" % n
user = lambda cwd, text: {"type": "user", "cwd": cwd, "message": {"role": "user", "content": text}}

def write(path, records):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        for r in records:
            f.write((r if isinstance(r, str) else json.dumps(r, separators=(",", ":"))) + "\n")  # compact, as Claude Code writes

with tempfile.TemporaryDirectory() as home:
    home = os.path.realpath(home)
    proj = os.path.join(home, "work", "shop")
    os.makedirs(os.path.join(proj, "sub"))
    root = os.path.join(home, ".claude", "projects")
    # 1: stray non-object lines, a /rename, two prompts
    write(os.path.join(root, enc(proj), U(1) + ".jsonl"),
          ['"oops"', "null", "[1, 2]", user(proj, "Fix the cart total"), {"type": "custom-title", "customTitle": "Cart fix"},
           {"type": "assistant", "message": {"content": [{"type": "text", "text": "done"}]}}, user(proj, "and the tests")])
    # 2: started in a worktree that has since been removed
    gone = os.path.join(proj, ".claude", "worktrees", "old")
    write(os.path.join(root, enc(gone), U(2) + ".jsonl"), [user(gone, "Work in the old worktree")])
    # 3: started in a folder under the project
    write(os.path.join(root, enc(os.path.join(proj, "sub")), U(3) + ".jsonl"), [user(os.path.join(proj, "sub"), "Look at sub")])
    # 4: a long one: named at the start, 17 MB after it, and the name quoted inside a long record near the end
    filler = json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "x" * 1000000}]}}, separators=(",", ":"))
    quoted = json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "y" * 200000 + ' "type":"custom-title" ' + "y" * 200000}]}}).replace('\\"type\\":\\"custom-title\\"', '"type":"custom-title"')
    write(os.path.join(root, enc(proj), U(4) + ".jsonl"),
          [user(proj, "A long session"), {"type": "custom-title", "customTitle": "Long one"}] + [filler] * 17 + [quoted, user(proj, "last words")])
    # 5: another project entirely
    other = os.path.join(home, "work", "elsewhere")
    os.makedirs(other)
    write(os.path.join(root, enc(other), U(5) + ".jsonl"), [user(other, "Not here")])
    # Codex: one whose first line is not an object, one good, one whose folder is gone
    cx = os.path.join(home, ".codex", "sessions", "2026", "11", "13")
    msg = lambda t: {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": t}]}}
    write(os.path.join(cx, "rollout-2026-11-13T01-00-00-%s.jsonl" % U(6)), ["[]", msg("never listed")])
    write(os.path.join(cx, "rollout-2026-11-13T02-00-00-%s.jsonl" % U(7)), [{"type": "session_meta", "payload": {"id": U(7), "cwd": proj}}, msg("Hello from Codex")])
    write(os.path.join(cx, "rollout-2026-11-13T03-00-00-%s.jsonl" % U(8)), [{"type": "session_meta", "payload": {"id": U(8), "cwd": gone}}, msg("Codex in the old worktree")])

    r = subprocess.run([sys.executable, PY, "list", proj], env={**os.environ, "HOME": home}, capture_output=True, text=True)
    try:
        rows = {x["id"]: x for x in json.loads(r.stdout)}
    except ValueError:
        print("FAIL the list did not come back:\n" + r.stderr[-800:]); sys.exit(1)
    one, long_ = rows.get(U(1), {}), rows.get(U(4), {})
    checks = {
        "stray non-object lines don't empty the list": U(1) in rows,
        "the /rename name is the title": one.get("title") == "Cart fix",
        "first and last prompt": one.get("first") == "Fix the cart total" and one.get("last") == "and the tests",
        "a conversation whose folder is gone is left out (Claude Code)": U(2) not in rows,
        "a folder under the project is listed with its sub-folder": rows.get(U(3), {}).get("sub") == "sub",
        "a long conversation keeps the name given at its start": long_.get("title") == "Long one" and long_.get("last") == "last words",
        "another project is not listed": U(5) not in rows,
        "a Codex file with a non-object first line is skipped": U(6) not in rows,
        "a Codex conversation is listed": rows.get(U(7), {}).get("provider") == "codex" and rows.get(U(7), {}).get("first") == "Hello from Codex",
        "a conversation whose folder is gone is left out (Codex)": U(8) not in rows,
    }
    for k, ok in checks.items():
        print(("ok   " if ok else "FAIL ") + k)
    if not all(checks.values()):
        print(r.stderr[-600:]); sys.exit(1)
