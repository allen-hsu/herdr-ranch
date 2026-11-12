#!/usr/bin/env python3
"""Writes the README mockups (docs/img/src/*.html). Sample data only."""
import os, sys
OUT = sys.argv[1]

CSS = """
*{box-sizing:border-box}
html,body{margin:0;background:#0f1012}
body{color:#e4e5e9;font:13px/1.35 Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow:hidden}
.r{display:flex;align-items:center}.c{display:flex;flex-direction:column}
.g{flex:1 1 0;min-width:0}.n{flex:none}.tr{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.mono{font-family:'JetBrains Mono',ui-monospace,monospace}
.dim{color:#7d818b}.mut{color:#a5a8b0}.fg{color:#e4e5e9}
.s11{font-size:11px}.s12{font-size:12px}.b5{font-weight:500}.b6{font-weight:600}
.spin{width:12px;height:12px;border-radius:50%;border:2px solid #e5c07b;border-right-color:transparent;flex:none}
.spin.sm{width:10px;height:10px}
.done{width:7px;height:7px;border-radius:50%;background:#8ab4f8;flex:none}
.idle{width:7px;height:7px;border-radius:50%;border:1.5px solid #7d818b;flex:none}
.need{width:14px;height:14px;border-radius:4px;background:#4a2725;color:#f0857d;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex:none}
.need.sm{width:12px;height:12px;font-size:9px}
.mk{width:14px;display:flex;justify-content:center;flex:none}
.tile{width:18px;height:18px;border-radius:5px;color:#fff;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;flex:none}
.tile.sm{width:14px;height:14px;border-radius:4px;font-size:9px}
.ag{width:18px;height:18px;border-radius:5px;background:#3a3d45;display:flex;align-items:center;justify-content:center;flex:none}
.ag.sm{width:14px;height:14px;border-radius:4px}.ag.sm>*{transform:scale(.78)}
.ag.lg{width:24px;height:24px;border-radius:6px}.ag.lg>*{transform:scale(1.25)}
.kbd{font-size:11px;border:1px solid #383b43;border-radius:4px;padding:1px 5px;color:#a5a8b0;flex:none}
.panel{background:#17181b;border-radius:10px;border:1px solid #2b2d33}
.card{background:#212328;border-radius:8px}
.h{height:22px;padding:0 8px;font-size:11px;font-weight:600;color:#7d818b}
.ib{width:28px;height:28px;border-radius:7px;display:flex;align-items:center;justify-content:center;flex:none}
.seg{padding:2px;border-radius:7px;background:#24262b;display:flex;gap:1px}
.seg>div{padding:0 9px;height:22px;display:flex;align-items:center;gap:5px;border-radius:5px;color:#a5a8b0;font-size:12px;white-space:nowrap}
.seg>.on{background:#383b43;color:#e4e5e9;font-weight:500}
.seg.sb{justify-content:space-between}.seg.sb>div{padding:0 6px}
.btn{height:26px;padding:0 10px;border-radius:7px;background:#2c2e35;display:flex;align-items:center;gap:6px;flex:none;white-space:nowrap}
.chip{font-size:11px;border-radius:4px;padding:1px 6px;flex:none;white-space:nowrap}
.bar{flex:none;height:6px;border-radius:3px;background:#26282d;overflow:hidden}
.elbow{width:9px;height:11px;margin-top:-9px;border-left:1.5px solid #383b43;border-bottom:1.5px solid #383b43;border-bottom-left-radius:5px;flex:none}
hl{background:#4a3d1f;color:#f1d59b;border-radius:2px}
"""

P = {
 "search": '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
 "plus": '<path d="M12 5v14M5 12h14"/>',
 "x": '<path d="M18 6 6 18M6 6l12 12"/>',
 "right": '<path d="m9 6 6 6-6 6"/>',
 "down": '<path d="m6 9 6 6 6-6"/>',
 "files": '<path d="M20 7h-3a2 2 0 0 1-2-2V2"/><path d="M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l4 4v10a2 2 0 0 1-2 2Z"/><path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8"/>',
 "gauge": '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
 "branch": '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
 "pr": '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>',
 "graph": '<circle cx="5" cy="6" r="3"/><path d="M5 9v6"/><circle cx="5" cy="18" r="3"/><path d="M12 3v18"/><circle cx="19" cy="6" r="3"/><path d="M16 15.7A9 9 0 0 0 19 9"/>',
 "panelr": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
 "panell": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
 "layers": '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
 "users": '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17 14.5a5 5 0 0 1 4.5 5"/>',
 "user": '<circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="10" r="3"/><path d="M6.5 19a6 6 0 0 1 11 0"/>',
 "server": '<rect x="3" y="3.5" width="18" height="7" rx="2"/><rect x="3" y="13.5" width="18" height="7" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
 "gear": '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
 "monitor": '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
 "folder": '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />',
 "file": '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
 "term": '<path d="m5 8 4 4-4 4M12 17h7"/>',
 "pin": '<path d="M12 17v5M8 3h8l-1 6 3 4H6l3-4Z"/>',
 "refresh": '<path d="M3 12a9 9 0 0 1 15.7-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.7 6.3L3 16"/><path d="M8 16H3v5"/>',
 "wrench": '<path d="M14.5 6.5a4 4 0 0 0 5 5L11 20a2.1 2.1 0 0 1-3-3Z"/><path d="m14.5 6.5 3-3"/>',
 "check": '<path d="m5 12 5 5 9-10"/>',
 "collapse": '<path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/>',
}
def ic(n, s=14, col="#a5a8b0", w=2):
    return f'<svg class="n" width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="{col}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round">{P[n]}</svg>'
DOTS = '<svg class="n" width="14" height="14" viewBox="0 0 24 24" fill="#a5a8b0"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>'

# Program icons: Herdr's own icon set (LobeHub / Lucide), inlined. cc and cx carry their own colors, the rest are tinted.
PROG = {
 'cc': ('viewBox="0 0 24 24"', '<path clip-rule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" fill="#D97757" fill-rule="evenodd"></path>'),
 'cx': ('viewBox="0 0 24 24"', '<path d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z" fill="#fff"></path><path d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z" fill="url(#lobe-icons-codex-_R_0_)"></path><defs><linearGradient gradientUnits="userSpaceOnUse" id="lobe-icons-codex-_R_0_" x1="12" x2="12" y1="3" y2="21"><stop stop-color="#B1A7FF"></stop><stop offset=".5" stop-color="#7A9DFF"></stop><stop offset="1" stop-color="#3941FF"></stop></linearGradient></defs>'),
 'cu': ('fill="currentColor" fill-rule="evenodd" viewBox="0 0 24 24"', '<path d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z"></path>'),
 'ge': ('viewBox="0 0 24 24" fill="currentColor"', '<path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"/>'),
 'gk': ('fill="currentColor" fill-rule="evenodd" viewBox="0 0 24 24"', '<path d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"></path>'),
 'tm': ('viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"', '<path d="M12 19h8" /><path d="m4 17 6-6-6-6" />'),
}
def pi(k, s=13, col="#a5a8b0"):
    a, b = PROG[k]
    return f'<svg class="n" width="{s}" height="{s}" style="color:{col}" {a}>{b}</svg>'
def ag(k, cls="", col="#e4e5e9"): return pi(k, 12 if cls == "sm" else 14, col)
# Sidebar folders: a thin Lucide folder outline, open when the folder is expanded.
FOLDER = '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />'
FOLDER_OPEN = '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />'
def fico(open_=False, s=15, col="#a5a8b0"):
    return f'<svg class="n" width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="{col}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{FOLDER_OPEN if open_ else FOLDER}</svg>'
FOLD = {"acme-web": "#3b6ea8", "billing-api": "#2f8f83", "docs-site": "#b06a3b", "Playground": "#6f63c9"}
def tile(name, cls=""): return f'<div class="tile {cls}" style="background:{FOLD[name]}">{name[0].upper()}</div>'
ST = {"work": '<div class="spin"></div>', "done": '<div class="done"></div>', "idle": '<div class="idle"></div>', "need": '<div class="need">!</div>'}
def mk(s): return f'<div class="mk">{ST[s]}</div>'

def page(name, w, h, body, title):
    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title}</title>
<!-- Illustrative mockup with sample data, rendered to docs/img/{name}.png at {w}x{h} (2x). -->
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>{CSS}body{{width:{w}px;height:{h}px}}</style>
</head>
<body>
{body}
</body>
</html>
"""
    open(os.path.join(OUT, name + ".html"), "w").write(html)

# ---------------------------------------------------------------- sidebar
def agent(st, name, time, indent=40, sel=False, extra="", k="cc"):
    bg = "background:#2c2e35;" if sel else ""
    col = "" if st in ("work", "need", "done") or sel else "color:#a5a8b0;"
    return f'<div class="r" style="height:26px;margin-left:{indent}px;padding:0 8px;gap:6px;border-radius:6px;{bg}{col}">{mk(st)}<div class="mk">{pi(k)}</div><div class="g tr">{name}</div>{extra}<div class="s11 dim n">{time}</div></div>'
def child(mark, name, time, indent=62):
    return f'<div class="r s12 mut" style="height:24px;margin-left:{indent}px;padding-right:8px;gap:7px"><div class="elbow"></div><div class="n r" style="width:12px;justify-content:center">{mark}</div><div class="g tr">{name}</div><div class="s11 dim n">{time}</div></div>'
def folder(name, open_=True, status=""):
    return f'<div class="r" style="height:30px;padding:0 8px;gap:6px"><div class="n r" style="width:18px;height:18px;justify-content:center">{fico(open_)}</div><div class="g b6 tr">{name}</div>{mk(status) if status else ""}</div>'
def space(name, extra="", wt=False):
    return f'<div class="r mut" style="height:28px;margin-left:20px;padding:0 8px;gap:7px">{ic("branch" if wt else "folder",13,"#7d818b")}<div class="g tr{" mono s12" if wt else ""}">{name}</div>{extra}</div>'
PRB = lambda n, col="#98c379": f'<div class="chip r" style="gap:4px;background:#24262b;color:#a5a8b0">{ic("pr",10,col)}#{n}</div>'
CHG = lambda n: f'<div class="chip" style="background:#3a321f;color:#e5c07b">{n}</div>'

def sidebar(width=268, lights=True):
    L = '<div class="r n" style="gap:8px;margin-right:6px">' + ''.join('<div style="width:12px;height:12px;border-radius:50%;background:#3a3d45"></div>' for _ in range(3)) + '</div>' if lights else ''
    return f"""
<div class="c n" style="width:{width}px;background:#17181b;border-radius:10px;min-height:0">
  <div class="c n" style="padding:10px 8px 6px;gap:8px">
    <div class="r" style="gap:8px;padding:0 6px;height:24px">{L}<div style="width:18px;height:18px;border-radius:5px;background:#e4e5e9" class="n"></div><div class="g b6">Herdr</div>{ic("panell",15)}</div>
    <div class="r mut" style="height:30px;padding:0 10px;gap:8px;border-radius:8px;background:#24262b">{ic("search",13)}<div class="g tr s12">Search or run a command</div><div class="kbd">⌘K</div></div>
  </div>
  <div class="c g" style="padding:0 8px;gap:10px;min-height:0;overflow:hidden">
    <div class="c" style="gap:6px">
      <div class="r h" style="padding:0 8px"><div class="g">Folders</div>{ic("plus",13,"#7d818b")}</div>
      <div class="seg sb" style="margin:0 2px"><div class="on">All</div><div>Working <span class="dim s11">2</span></div><div>Needs you <span style="color:#f0857d" class="s11">1</span></div><div>Done <span class="dim s11">3</span></div></div>
    </div>
    <div class="c" style="gap:1px">
      <div class="r h">{ic("pin",10,"#7d818b")}<div class="g" style="margin-left:5px">Pinned</div><div style="font-weight:400">1</div></div>
      {agent("done","Review PR #214","41m",0)}
    </div>
    <div class="c" style="gap:2px">
      <div class="r h" style="color:#f0857d"><div class="g">Needs you</div><div style="font-weight:400">1</div></div>
      <div class="r" style="height:44px;padding:0 8px;gap:6px;border-radius:7px;background:#2a1e1f">{mk("need")}<div class="mk">{pi("cc")}</div><div class="c g" style="gap:1px"><div class="tr">Add CSV export</div><div class="s11 mut tr">billing-api · permission to run Bash</div></div></div>
    </div>
    <div class="c" style="gap:1px">
      {folder("acme-web")}
      {space("acme-web", CHG("3 changes"))}
      {agent("work","Fix flaky checkout test","now",sel=True)}
      {child(pi("tm",12,"#7d818b"),"npm run test:watch","4m")}
      {agent("done","Review PR #214","41m")}
      <div class="r s12 dim" style="height:24px;margin-left:40px;padding:0 8px;gap:8px"><div class="mk">{ic("right",10,"#7d818b",2.4)}</div><div class="g">4 finished · older than 12h</div></div>
      {space("feat/csv-button", PRB(221), wt=True)}
      {agent("idle","Draft export button","3h")}
      {folder("billing-api")}
      {space("billing-api", PRB(87,"#e5c07b"))}
      {agent("need","Add CSV export","6m")}
      {agent("work","Migrate invoices table","2m",k="cx")}
      {folder("docs-site",False,"work")}
    </div>
    <div class="c" style="gap:1px">
      <div class="r h">Recent</div>
      {space("Playground")}
      {agent("done","Try the new CLI flags","2h")}
    </div>
  </div>
  <div class="c n" style="padding:8px;gap:4px;border-top:1px solid #26282d">
    <div class="r" style="height:32px;padding:0 10px;gap:8px;border-radius:8px;background:#24262b">{ic("plus",14,"#e4e5e9",2.2)}<div class="g b5">New agent</div></div>
    <div class="r" style="height:28px;gap:2px"><div class="ib">{ic("layers",15)}</div><div class="ib">{ic("users",15)}</div><div class="g"></div><div class="ib">{ic("user",15)}</div><div class="ib">{ic("server",15)}</div><div class="ib">{ic("gear",15)}</div></div>
  </div>
</div>"""

# ---------------------------------------------------------------- right panel
def tabs(active, changes=3):
    def b(name, icon, badge=""):
        on = name == active
        ul = '<div style="position:absolute;left:6px;right:6px;bottom:-4px;height:2px;border-radius:1px;background:#e4e5e9"></div>' if on else ''
        return f'<div class="ib" style="width:32px;height:32px;position:relative">{ic(icon,16,"#e4e5e9" if on else "#a5a8b0")}{badge}{ul}</div>'
    bd = f'<div style="position:absolute;top:3px;right:2px;min-width:13px;height:13px;padding:0 3px;border-radius:7px;background:#e5c07b;color:#17181b;font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center">{changes}</div>'
    return f'<div class="r n" style="height:40px;padding:0 8px;gap:2px;border-bottom:1px solid #26282d">{b("Files","files")}{b("Inspector","gauge")}{b("Changes","branch",bd)}{b("PRs","pr")}{b("Graph","graph")}<div class="g"></div><div class="ib">{ic("panelr",16)}</div></div>'
def subtabs(active):
    out = ''.join(f'<div style="padding:4px 9px;border-radius:6px;{"background:#2c2e35;font-weight:500" if n==active else "color:#a5a8b0"}">{n}</div>' for n in ["Overview","Trace","Capabilities","Config"])
    return f'<div class="r n" style="height:38px;padding:0 8px;gap:2px">{out}</div>'
def sect(title, right, body):
    return f'<div class="c" style="gap:5px"><div class="r s11 b6 dim"><div class="g">{title}</div><div style="font-weight:400">{right}</div></div>{body}</div>'
def overview_body(long=False):
    more = ""
    if long:
        steps = [("Edit","tests/checkout.spec.ts","+18 −4","12s"),("Bash","npm test -- checkout","exit 0","1m09s"),("Read","src/cart/session.ts","214 lines","0.1s"),("Grep","waitForTimeout","6 matches","0.2s")]
        rows = ''.join(f'<div class="r s12" style="height:24px;gap:8px">{ic("wrench",12,"#7d818b")}<div class="n b5" style="width:38px">{a}</div><div class="g tr mono mut" style="font-size:11.5px">{b}</div><div class="s11 dim n">{c}</div><div class="s11 dim n" style="width:40px;text-align:right">{d}</div></div>' for a,b,c,d in steps)
        bg = (f'<div class="r s12" style="height:24px;gap:8px">{ic("term",12,"#e5c07b",2.4)}<div class="g tr mono mut" style="font-size:11.5px">npm run test:watch</div><div class="s11 dim n">background command</div><div class="s11 dim n" style="width:40px;text-align:right">4m</div></div>'
              f'<div class="r s12" style="height:24px;gap:8px"><div class="n r" style="width:12px;justify-content:center"><div class="done"></div></div><div class="g tr mut">Explore: where the cart total is fetched</div><div class="s11 dim n">subagent · finished</div><div class="s11 dim n" style="width:40px;text-align:right">37s</div></div>')
        fl = ''.join(f'<div class="r s12" style="height:24px;gap:8px">{ic("file",12,"#7d818b")}<div class="g tr mono mut" style="font-size:11.5px">{a}</div><div class="s11 n" style="color:#98c379">+{b}</div><div class="s11 n" style="color:#f0857d;width:24px;text-align:right">−{c}</div></div>' for a,b,c in [("tests/checkout.spec.ts",18,4),("tests/helpers/cart.ts",9,0),("src/cart/session.ts",3,1)])
        more = sect("Recent steps","newest first",f'<div class="c">{rows}</div>') + sect("Background work","1 running",f'<div class="c">{bg}</div>') + sect("Files it changed","3",f'<div class="c">{fl}</div>') + sect("Last reply","5m ago",'<div class="card mut" style="padding:9px 11px;line-height:1.5;font-size:12px">The test clicked "Pay" after a fixed 300 ms wait. I replaced it with a wait for the cart total, so a slow pricing request no longer fails the run.</div>')
    return f"""
<div class="c g" style="padding:8px 14px 14px;gap:14px;min-height:0">
  <div class="card r" style="padding:10px 12px;gap:10px"><div class="spin"></div><div class="g"><div class="b6">Running Bash</div><div class="s11 dim tr">npm test -- checkout</div></div><div class="s11 mut">38s</div></div>
  {sect("Needs you","nothing waiting",'<div class="mut" style="font-size:11.5px">No permission request or question is open.</div>') if long else ""}
  {sect("Context","38% · 76k of 200k",'<div class="bar"><div style="width:38%;height:100%;background:#8ab4f8"></div></div><div class="mut" style="font-size:11.5px">Grows about 5k per turn: roughly 22 more turns before it compacts.</div>')}
  {sect("Prompt cache","warm · 4m left",'<div class="mut" style="font-size:11.5px">Reply now about $0.04. After it expires about $0.41.</div>')}
  {sect("Spend","session $6.82",'<div class="mut" style="font-size:11.5px">Last 14 turns about $5.10 · typical turn about $0.36</div>')}
  {sect("Last turn","5m11s · $0.92",'<div class="r" style="height:6px;border-radius:3px;overflow:hidden;gap:1px"><div style="width:68%;height:100%;background:#7aa2f7"></div><div style="width:29%;height:100%;background:#98c379"></div><div style="width:3%;height:100%;background:#c678dd"></div></div><div class="s11 dim">model 3m32s · tools 1m29s · hooks 9.7s</div>')}
  {more}
</div>"""

# ---------------------------------------------------------------- overview
def overview():
    term = """
<div class="dim">❯ The checkout test fails about one run in five on CI. Find out why and fix it.</div>
<div>● I'll look at the test and the code it drives first.</div>
<div class="dim" style="padding-left:18px">Read tests/checkout.spec.ts</div>
<div class="dim" style="padding-left:18px">Read src/cart/session.ts</div>
<div>● The test clicks "Pay" right after a fixed 300 ms wait, but the cart total comes</div>
<div>&nbsp; from an async request. When that request is slow the button is still disabled.</div>
<div>● Replacing the fixed wait with a wait for the total to render.</div>
<div class="dim" style="padding-left:18px">Edit tests/checkout.spec.ts <span style="color:#98c379">+18</span> <span style="color:#f0857d">−4</span></div>
<div>● Running the test 20 times to check it is stable now.</div>
<div class="dim" style="padding-left:18px">Bash npm test -- checkout --repeat-each=20</div>
<div style="padding-left:18px;color:#98c379">&nbsp; 14 passed</div>
<div style="margin-top:14px;color:#e5c07b">✻ Running tests… 38s · 1 background command</div>"""
    def tab(k, name, st="", on=False):
        m = ST[st] if st else ""
        if on: return f'<div class="r" style="height:28px;max-width:250px;padding:0 10px;gap:7px;border-radius:7px;background:#24262b;border:1px solid #2b2d33">{pi(k,14)}<div class="b5 tr">{name}</div>{m}{ic("x",11,"#7d818b")}</div>'
        return f'<div class="r mut" style="height:28px;max-width:220px;padding:0 10px;gap:7px">{pi(k,14)}<div class="tr">{name}</div>{m}</div>'
    # Usage line, as mods/usage-bar draws it: icon, 44x5 bar, percent, time left, then the other limits.
    def meter(k, pct, left, others=(), col="#e4e5e9"):
        o = ''.join(f'<div>· {p}% {n}</div>' for p, n in others)
        return f'<div class="r n" style="gap:6px">{pi(k,13,col)}<div class="n" style="width:44px;height:5px;border-radius:3px;background:#2b2d33"><div style="width:{max(1, round(44*pct/100))}px;height:5px;border-radius:3px;background:#8ab4f8"></div></div><div class="fg">{pct}%</div><div class="fg">{left}</div>{o}</div>'
    body = f"""
<div class="c" style="width:1440px;height:900px;padding:8px 8px 0;gap:6px">
<div class="r g" style="gap:8px;align-items:stretch;min-height:0">
  {sidebar()}
  <div class="c g" style="gap:6px;min-height:0">
    <div class="r n" style="height:30px;gap:4px">{tab("cc","Fix flaky checkout test","work",True)}{tab("cc","Review PR #214","done")}{tab("tm","zsh")}<div class="ib" style="width:26px;height:26px">{ic("plus",13,"#a5a8b0",2.2)}</div></div>
    <div class="c g panel" style="min-height:0">
      <div class="r n" style="height:38px;padding:0 14px;gap:10px;border-bottom:1px solid #26282d"><div class="spin"></div><div class="b6">Fix flaky checkout test</div><div class="dim">acme-web · main · Claude Code</div></div>
      <div class="g mono" style="padding:18px 20px;font-size:12.5px;line-height:1.75;color:#c9ccd3;white-space:nowrap;overflow:hidden">{term}</div>
      <div class="r n mono dim" style="margin:0 14px 14px;height:40px;border-radius:8px;border:1px solid #383b43;padding:0 12px;font-size:12.5px">❯</div>
    </div>
  </div>
  <div class="c n panel" style="width:400px;min-height:0">{tabs("Inspector")}{subtabs("Overview")}{overview_body()}</div>
</div>
<div class="r n s11 mut" style="height:28px;padding:0 10px 2px;gap:12px;white-space:nowrap">
  <div class="n">Used</div>
  {meter("cc",21,"4d 17h",[(20,"Fable")])}{meter("cx",9,"6d 2h")}
  <div class="r n" style="gap:6px;opacity:.8">{pi("gk",13,"#e4e5e9")}<div>Grok: run Grok to refresh</div></div>
  {meter("cu",0,"18d 20h",[(0,"Other Models"),(0,"On-demand")])}
  {ic("refresh",12,"#7d818b")}
  <div class="g"></div>
  <div class="r dim n" style="height:20px;padding:0 7px;gap:6px;border-radius:5px">{ic("branch",12,"#7d818b")}<div>5 worktrees · 11.3 GB</div><div style="color:#e5c07b">2 cleanable</div></div>
  <div class="r n" style="gap:6px">{ic("monitor",12)}<div>This computer</div></div>
  <div class="n">8 agents</div>
  <div class="dim n">⌘⇧P commands</div>
</div>
</div>"""
    page("overview", 1440, 900, body, "Herdr with herdr-ranch: whole window")

def sidebar_page():
    page("sidebar", 300, 860, f'<div class="r" style="width:300px;height:860px;padding:8px;align-items:stretch">{sidebar(284, False)}</div>', "Sidebar")

def panel_inspector():
    page("panel-inspector", 460, 860, f'<div class="c" style="width:460px;height:860px;padding:8px"><div class="c g panel" style="min-height:0">{tabs("Inspector")}{subtabs("Overview")}{overview_body(True)}</div></div>', "Inspector: Overview")

# ---------------------------------------------------------------- command bar
def bar(w, h, head, left, right, foot):
    return f"""
<div style="width:{w}px;height:{h}px;padding:14px">
<div class="c" style="height:100%;background:#1b1c20;border:1px solid #383b43;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.5);overflow:hidden">
  <div class="r n" style="height:50px;padding:0 14px;gap:8px;border-bottom:1px solid #26282d;font-size:14px">{head}<div class="kbd">Esc</div></div>
  <div class="r g" style="align-items:stretch;min-height:0">
    <div class="c n" style="width:56%;padding:6px;overflow:hidden">{left}</div>
    <div class="c g" style="padding:16px;gap:8px;border-left:1px solid #26282d;background:#17181b">{right}</div>
  </div>
  <div class="r n s11 dim" style="height:32px;padding:0 14px;gap:14px;border-top:1px solid #26282d">{foot}</div>
</div></div>"""
def crow(icon, name, hint="", sel=False):
    return f'<div class="r" style="height:32px;padding:0 8px;gap:9px;border-radius:7px;{"background:#2c2e35" if sel else ""}"><div class="n r" style="width:18px;justify-content:center">{icon}</div><div class="tr{" b5" if sel else ""}">{name}</div><div class="g"></div><div class="s11 dim tr">{hint}</div></div>'
def cgroup(n): return f'<div class="r h" style="height:24px;margin-top:2px">{n}</div>'
def command_bar():
    left = (cgroup("Agents") + crow(ST["work"], "Fix flaky checkout <hl>te</hl>st", "acme-web · working", True)
        + cgroup("Folders") + crow(ic("folder",14), "docs-si<hl>te</hl>", "1 space")
        + cgroup("Actions") + crow(ic("users",14), "New <hl>te</hl>am…", "⌃⌘N") + crow(ic("term",14), "New <hl>te</hl>rminal tab", "")
        + cgroup("Views") + crow(ic("users",14), "<hl>Te</hl>am Map", "⌃⌘T") + crow(ic("search",14), "Herdr command palet<hl>te</hl>", ""))
    right = f"""<div class="s11 b6 dim">Agents</div>
<div class="r" style="gap:8px">{ag("cc")}<div class="b6" style="font-size:14px">Fix flaky checkout test</div></div>
<div class="mut" style="line-height:1.55">Go to this agent's terminal (Claude Code in acme-web).</div>
<div class="card c" style="padding:10px 12px;gap:6px;margin-top:6px">
  <div class="r" style="gap:8px"><div class="spin"></div><div class="g b5">Running Bash</div><div class="s11 dim">38s</div></div>
  <div class="s11 dim mono tr">npm test -- checkout</div>
  <div class="bar" style="height:4px"><div style="width:38%;height:100%;background:#8ab4f8"></div></div>
  <div class="s11 dim">Context 38% · branch main</div>
</div>"""
    head = f'{ic("search",15)}<div class="g">te<span style="display:inline-block;width:1.5px;height:17px;background:#8ab4f8;vertical-align:-3px;margin-left:1px"></span></div>'
    page("command-bar", 760, 520, bar(760, 520, head, left, right, '<div>↑↓ move</div><div>↵ Open</div><div class="g"></div><div>6 results</div>'), "Command bar")

def new_agent():
    chip = lambda t, x="": f'<div class="r n" style="height:24px;padding:0 8px;gap:6px;border-radius:6px;background:#2c2e35;font-size:12px;font-weight:500">{x}{t}</div>'
    head = f'{chip("New agent")}{chip("acme-web")}<div class="g tr">Fix the flaky checkout test<span style="display:inline-block;width:1.5px;height:17px;background:#8ab4f8;vertical-align:-3px;margin-left:1px"></span></div>'
    left = (cgroup("Agent") + crow(ag("cc"), "Claude Code", "used last time", True) + crow(ag("cx"), "Codex") + crow(ag("cu"), "Cursor") + crow(ag("ge"), "Gemini")
        + cgroup("Terminal") + crow(ag("tm"), "Terminal", "A plain shell, no agent."))
    right = f"""<div class="s11 b6 dim">Agent</div>
<div class="r" style="gap:8px">{ag("cc")}<div class="b6" style="font-size:14px">Claude Code</div></div>
<div class="mut" style="line-height:1.55">Runs claude.<br>Starts in acme-web, as a new tab.</div>
<div class="s11 b6 dim" style="margin-top:6px">First message</div>
<div class="card" style="padding:8px 10px;line-height:1.5">Fix the flaky checkout test</div>"""
    page("new-agent", 760, 420, bar(760, 420, head, left, right, '<div>Step 2 of 2 · type the task · ⌫ back</div><div class="g"></div><div>↑↓ move</div><div>↵ Start</div>'), "Command bar: New agent")

# ---------------------------------------------------------------- board
def bcard(title, fold, branch, agents, time, need=False, pr="", pinned=False):
    rows = ''.join(f'<div class="r s12" style="height:22px;gap:7px"><div class="mk">{ag(k,"sm","#a5a8b0")}</div><div class="g tr {"" if s in ("work","need") else "mut"}">{n}</div><div class="n r" style="width:14px;justify-content:center">{ST[s].replace("need","need sm").replace("spin","spin sm")}</div></div>' for k, n, s in agents)
    right = '<div class="chip" style="color:#f0857d;background:#4a2725">needs you</div>' if need else f'<div class="s11 dim">{time}</div>'
    return f"""<div class="c" style="padding:10px;border-radius:8px;background:{"#2a1e1f" if need else "#212328"};gap:7px">
  <div class="r" style="gap:7px"><div class="g b5 tr">{title}</div>{ic("pin",12,"#a5a8b0") if pinned else ""}</div>
  <div class="r s11 mut" style="gap:6px">{tile(fold,"sm")}<div class="n">{fold}</div><div class="dim mono tr">{branch}</div></div>
  {f'<div class="c" style="border-top:1px solid #2c2e35;padding-top:5px">{rows}</div>' if rows else ""}
  <div class="r" style="height:20px;gap:6px">{pr}<div class="g"></div>{right}</div>
</div>"""
def bcol(mark, name, n, cards, first=False):
    return f'<div class="c g" style="padding:0 12px;gap:8px;{"" if first else "border-left:1px solid #26282d"}"><div class="r s11 b6 mut" style="height:28px;gap:7px">{mark}<div class="g">{name}</div><div class="dim" style="font-weight:400">{n}</div></div>{"".join(cards)}</div>'
def board():
    pr = lambda n, s, col: f'<div class="chip r" style="gap:4px;background:#2c2e35;color:#a5a8b0">{ic("pr",10,col)}#{n} · {s}</div>'
    cols = [
      bcol('<div class="idle"></div>', "Todo", 2, [
        bcard("docs-site", "docs-site", "main", [], "2d"),
        bcard("Playground", "Playground", "no repo", [("cc","Try the new CLI flags","idle")], "5d")], True),
      bcol('<div class="spin sm"></div>', "In progress", 3, [
        bcard("billing-api", "billing-api", "feat/csv-export", [("cc","Add CSV export","need"),("cx","Migrate invoices table","work")], "", need=True, pinned=True),
        bcard("acme-web", "acme-web", "main", [("cc","Fix flaky checkout test","work"),("cc","Review PR #214","done")], "now"),
        bcard("search-index", "docs-site", "feat/search-index", [("cu","Index headings for search","work")], "3m")]),
      bcol('<div class="done" style="background:#c678dd"></div>', "In review", 2, [
        bcard("csv-button", "acme-web", "feat/csv-button", [("cc","Draft export button","idle")], "3h", pr=pr(221,"checks pass","#98c379")),
        bcard("rate-limits", "billing-api", "fix/rate-limits", [("cx","Tighten rate limits","done")], "41m", pr=pr(87,"1 failing","#f0857d"))]),
      bcol('<div class="done" style="background:#98c379"></div>', "Done", 2, [
        bcard("dark-mode", "acme-web", "merged", [], "1d", pr=pr(209,"merged","#c678dd")),
        bcard("api-reference", "docs-site", "merged", [], "3d", pr=pr(52,"merged","#c678dd"))]),
    ]
    body = f"""<div class="r" style="width:1200px;height:720px;align-items:stretch"><div class="c g panel" style="margin:8px">
  <div class="r n" style="height:48px;padding:0 16px;gap:12px;border-bottom:1px solid #26282d">
    <div class="b6" style="font-size:15px">Board</div>
    <div class="seg"><div class="on">By space</div><div>By agent</div></div>
    <div class="btn" style="background:#24262b">All spaces {ic("down",11,"#a5a8b0",2.4)}</div>
    <div class="dim">9 spaces · drag a card to move it</div><div class="g"></div><div class="kbd">⌃⌘B</div><div class="ib">{ic("x",14)}</div>
  </div>
  <div class="r g" style="padding:12px 4px;align-items:stretch;min-height:0">{"".join(cols)}</div>
</div></div>"""
    page("board", 1200, 720, body, "Board")

# ---------------------------------------------------------------- team map
def lane(st, name, k, role, bars, marks, sel=False):
    b = ''.join(f'<div style="position:absolute;left:{l}%;width:{w}%;top:15px;height:14px;border-radius:4px;background:{c};opacity:{o}"></div>' for l, w, c, o in bars)
    m = ''.join(f'<div style="position:absolute;left:calc({x}% - 6px);top:16px;width:12px;height:12px;border-radius:50%;background:{"#e4e5e9" if on else "#17181b"};border:2px solid {"#8ab4f8" if on else "#e4e5e9"};{"box-shadow:0 0 0 4px rgba(138,180,248,.25)" if on else ""}"></div>' for x, on in marks)
    return f"""<div class="r" style="height:56px;border-bottom:1px solid #212328;{"background:#1d1e22" if sel else ""}">
  <div class="r n" style="width:230px;padding:0 10px 0 14px;gap:8px">{mk(st)}<div class="g"><div class="b5 tr">{name}</div><div class="r s11 dim" style="gap:5px;margin-top:2px">{ag(k,"sm","#a5a8b0")}{role}</div></div></div>
  <div class="g" style="height:44px;position:relative;margin-right:14px"><div style="position:absolute;left:0;right:0;top:21px;height:2px;background:#212328"></div>{b}{m}</div>
</div>"""
def team_map():
    W, D, N, F = "#e5c07b", "#8ab4f8", "#f0857d", 0.5
    lanes = (lane("need", "Add CSV export", "cc", "Lead · Claude Code", [(0,12,W,.9),(30,7,W,.9),(66,10,W,.9),(86,14,N,.9)], [(12,False),(37,False),(76,False)])
      + lane("work", "Implement export endpoint", "cx", "Implementer · Codex", [(13,42,W,.9),(77,23,W,.9)], [(55,False)])
      + lane("done", "Review export endpoint", "cc", "Reviewer · Claude Code", [(56,11,D,F)], [(67,True)], True)
      + lane("done", "Explore: existing report code", "cc", "Subagent · Explore", [(3,9,D,F)], [(12,False)])
      + lane("idle", "Write export docs", "ge", "Researcher · Gemini", [(40,14,D,F)], [(54,False)]))
    key = lambda sw, t: f'<div class="r" style="gap:6px">{sw}{t}</div>'
    sec = lambda t, r="": f'<div class="r s11 b6 dim" style="margin-top:4px"><div class="g">{t}</div><div style="font-weight:400">{r}</div></div>'
    bub = lambda who, txt, me: f'<div class="c" style="gap:3px;align-items:{"flex-end" if me else "flex-start"}"><div class="s11 dim">{who}</div><div style="max-width:270px;padding:7px 10px;border-radius:10px;line-height:1.45;background:{"#2b3a55" if me else "#24262b"}">{txt}</div></div>'
    drawer = f"""<div class="c n" style="width:350px;border-left:1px solid #26282d;background:#1b1c20">
  <div class="r n" style="height:44px;padding:0 12px;gap:8px;border-bottom:1px solid #26282d">{ag("cc")}<div class="g"><div class="b6 tr">Review export endpoint</div></div><div class="s11 dim">Reviewer</div>{ic("x",13)}</div>
  <div class="c g" style="padding:12px;gap:8px;min-height:0;overflow:hidden">
    {sec("Now")}
    <div class="card r" style="padding:9px 11px;gap:9px"><div class="done"></div><div class="g"><div class="b5">Finished</div><div class="s11 dim">at 14:21 · 5m of work</div></div></div>
    {sec("Context 42%", "84k of 200k")}
    <div class="bar"><div style="width:42%;height:100%;background:#8ab4f8"></div></div>
    {sec("Task it was given")}
    <div class="mut" style="line-height:1.45">Review the new /exports endpoint: streaming, CSV escaping, and who may call it.</div>
    {sec("Last reply")}
    <div class="card" style="padding:9px 11px;line-height:1.45;border:1px solid #4a3d1f;background:#2a2418"><span class="b6" style="color:#e5c07b">CHANGES</span> · 2 blocking, 1 nit. Values starting with "=" are not escaped, and the route is missing the billing:read check. Tests pass (14 of 14).</div>
    {sec("Latest messages", "2 of 3")}
    {bub("Lead · 14:16", "Review the export endpoint: streaming, escaping, permissions.", True)}
    {bub("Reviewer · 14:21", "Two blocking findings, details in my reply.", False)}
  </div>
  <div class="r n" style="padding:10px 12px;border-top:1px solid #26282d;gap:8px"><div class="btn">Go to agent</div><div class="g"></div><div class="s11 dim">Click the marker again to close</div></div>
</div>"""
    ticks = ''.join(f'<div class="g">{t}</div>' for t in ["14:02", "14:08", "14:14", "14:20", "14:26"])
    body = f"""<div class="r" style="width:1200px;height:700px;align-items:stretch"><div class="c g panel" style="margin:8px;overflow:hidden">
  <div class="r n" style="height:48px;padding:0 16px;gap:12px;border-bottom:1px solid #26282d">
    <div class="b6" style="font-size:15px">Team Map</div>
    <div class="btn" style="background:#24262b">Add CSV export {ic("down",11,"#a5a8b0",2.4)}</div>
    <div class="dim">billing-api · 5 members · 24m</div><div class="g"></div>
    <div class="btn">{ic("plus",12,"#e4e5e9",2.2)}New team…</div><div class="kbd">⌃⌘T</div><div class="ib">{ic("x",14)}</div>
  </div>
  <div class="r g" style="align-items:stretch;min-height:0">
    <div class="c g">
      <div class="r n" style="height:44px;padding:0 14px;gap:12px"><div class="s11 b6 dim">Timeline</div><div class="seg"><div>10m</div><div>1h</div><div>6h</div><div class="on">All</div></div><div class="g"></div>
        <div class="r s11 mut" style="gap:14px">{key(f'<div style="width:14px;height:6px;border-radius:2px;background:{W}"></div>',"working")}{key(f'<div style="width:14px;height:6px;border-radius:2px;background:{D};opacity:.5"></div>',"finished")}{key(f'<div style="width:14px;height:6px;border-radius:2px;background:{N}"></div>',"needs you")}{key('<div style="width:10px;height:10px;border-radius:50%;border:2px solid #e4e5e9"></div>',"message")}</div></div>
      <div class="r n s11 dim" style="height:26px;border-top:1px solid #26282d;border-bottom:1px solid #26282d"><div class="n b6" style="width:230px;padding-left:14px">Members</div><div class="r g" style="margin-right:14px">{ticks}</div></div>
      {lanes}
      <div class="g"></div>
      <div class="r n s11 dim" style="padding:10px 14px;border-top:1px solid #26282d;gap:8px">{ic("gauge",12,"#7d818b")}Follows the focused agent · click a bar or a marker for details</div>
    </div>
    {drawer}
  </div>
</div></div>"""
    page("team-map", 1200, 700, body, "Team Map")

# ---------------------------------------------------------------- inspector trace
def trace():
    K = {"LLM": "#7aa2f7", "tool": "#98c379", "hook": "#c678dd"}
    spans = [("hook","UserPromptSubmit","0.2s","",0,1,0),("LLM","Opus · plan","44s","$0.11",1,14,0),("tool","Read checkout.spec.ts","0.1s","",15,1,0),("tool","Read session.ts","0.1s","",16,1,0),
             ("LLM","Opus","1m08s","$0.24",17,22,0),("tool","Edit checkout.spec.ts","0.1s","",39,1,0),("hook","PostToolUse lint","9.2s","",40,3,1),
             ("LLM","Opus","59s","$0.21",43,19,0),("tool","Bash npm test","1m09s","",62,22,0),("tool","Agent Explore","37s","$0.08",62,12,0),("LLM","Opus · reply","41s","$0.28",84,14,0),("hook","Stop","0.3s","",98,1,0)]
    rows = ''.join(f'<div class="r s12" style="height:24px;gap:8px;{"background:#2a1e1f;border-radius:5px;" if e else ""}"><div class="n s11" style="width:30px;color:{K[k]};padding-left:4px">{k}</div><div class="n tr" style="width:150px;{"color:#f0857d" if e else ""}">{n}</div><div class="g" style="height:8px;position:relative;background:#1d1e22;border-radius:2px"><div style="position:absolute;left:{l}%;width:{max(w,1.5)}%;height:100%;border-radius:2px;background:{"#f0857d" if e else K[k]}"></div></div><div class="n s11 mut" style="width:38px;text-align:right">{d}</div><div class="n s11 dim" style="width:34px;text-align:right;padding-right:4px">{c}</div></div>' for k, n, d, c, l, w, e in spans)
    def turn(i, text, meta, open_=False):
        return f'<div class="r" style="height:32px;padding:0 10px;gap:8px;{"border-radius:8px 8px 0 0;background:#212328" if open_ else ""}">{ic("down" if open_ else "right",10,"#7d818b",2.4)}<div class="n s11 dim" style="width:16px">{i}</div><div class="g tr {"b5" if open_ else "mut"}">{text}</div><div class="s11 dim n">{meta}</div></div>'
    chip = lambda t, n="", on=False: f'<div class="r" style="height:22px;padding:0 8px;gap:5px;border-radius:11px;font-size:12px;{"background:#383b43" if on else "border:1px solid #383b43;color:#a5a8b0"}">{t}<span class="s11 dim">{n}</span></div>'
    body = f"""<div class="c" style="width:460px;height:860px;padding:8px"><div class="c g panel" style="min-height:0;overflow:hidden">
{tabs("Inspector")}{subtabs("Trace")}
<div class="r n" style="padding:0 12px 8px;gap:6px">{chip("All","",True)}{chip("Errors","1")}{chip("Costly")}{chip("Skills")}</div>
<div class="c g" style="padding:0 8px;gap:2px;min-height:0">
  <div class="r" style="height:32px;padding:0 10px;gap:8px"><div class="spin sm"></div><div class="n s11 dim" style="width:16px">15</div><div class="g tr">Run it 20 times to check it is stable</div><div class="s11" style="color:#e5c07b">running · 38s</div></div>
  {turn(14,"The checkout test fails about one run in five…","5m11s · $0.92",True)}
  <div class="c" style="background:#212328;border-radius:0 0 8px 8px;padding:2px 10px 10px;gap:8px">
    <div class="mut" style="font-size:12px;line-height:1.5">Read the test and the cart session code, replaced a fixed wait with a wait for the total, one lint hook failed and was retried, then ran the tests. 12 calls · 4 LLM · 5 tools · 3 hooks.</div>
    <div class="c" style="gap:4px"><div class="r" style="height:6px;border-radius:3px;overflow:hidden;gap:1px"><div style="width:68%;height:100%;background:#7aa2f7"></div><div style="width:29%;height:100%;background:#98c379"></div><div style="width:3%;height:100%;background:#c678dd"></div></div>
    <div class="r s11 dim" style="gap:12px"><div><span style="color:#7aa2f7">■</span> model 3m32s</div><div><span style="color:#98c379">■</span> tools 1m29s</div><div><span style="color:#c678dd">■</span> hooks 9.7s</div></div></div>
    <div class="c" style="gap:1px;margin:0 -4px">{rows}</div>
    <div class="c" style="padding:8px 10px;border-radius:6px;background:#17181b;border:1px solid #4a2725;gap:3px"><div class="r s11"><div class="g b6" style="color:#f0857d">PostToolUse lint · exit 2</div><div class="dim">9.2s</div></div><div class="mono mut" style="font-size:11px">checkout.spec.ts:41 'total' is assigned but never used</div></div>
  </div>
  {turn(13,"Why does the cart total load twice?","8m02s · $1.44")}
  {turn(12,"Add a test for an empty cart","2m47s · $0.52")}
  {turn(11,"/compact","58s · $0.31")}
  {turn(10,"Rename CartSession to CheckoutSession","1m36s · $0.28")}
  {turn(9,"Show the last order on the receipt page","6m20s · $0.87")}
</div>
<div class="r n s11 dim" style="height:32px;padding:0 14px;border-top:1px solid #26282d">15 turns · 1h52m · $6.82 · click a span for its input and output</div>
</div></div>"""
    page("inspector-trace", 460, 860, body, "Inspector: Trace")

# ---------------------------------------------------------------- files search
def files_search():
    def grp(path, n, lines):
        d, f = path.rsplit("/", 1)
        ls = ''.join(f'<div class="r mono" style="height:22px;gap:10px;font-size:11.5px;padding-left:26px;{"background:#2c2e35;border-radius:5px;" if s else ""}"><div class="n dim" style="width:26px;text-align:right">{no}</div><div class="g tr" style="color:#c9ccd3">{t}</div></div>' for no, t, s in lines)
        return f'<div class="c" style="gap:1px"><div class="r" style="height:26px;gap:7px;padding:0 6px">{ic("down",10,"#7d818b",2.4)}{ic("file",13,"#7d818b")}<div class="b5 n">{f}</div><div class="g tr s11 dim">{d}</div><div class="chip" style="background:#24262b;color:#a5a8b0">{n}</div></div>{ls}</div>'
    H = lambda s: s.replace("checkoutTotal", "<hl>checkoutTotal</hl>")
    res = (grp("src/cart/session.ts", 3, [(42, H("export async function checkoutTotal(cart: Cart) {"), True), (88, H("  const total = await checkoutTotal(cart);"), False), (131, H("// checkoutTotal is cached per session"), False)])
      + grp("src/pages/Checkout.tsx", 2, [(17, H('import { checkoutTotal } from "../cart/session";'), False), (63, H("  const { data } = useQuery(() => checkoutTotal(cart));"), False)])
      + grp("tests/checkout.spec.ts", 2, [(12, H('  await page.route("**/checkoutTotal", slow);'), False), (41, H('  // wait for checkoutTotal before paying'), False)])
      + grp("docs/payments.md", 1, [(9, H("The `checkoutTotal` call includes tax and shipping."), False)]))
    body = f"""<div class="c" style="width:460px;height:700px;padding:8px"><div class="c g panel" style="min-height:0;overflow:hidden">
{tabs("Files")}
<div class="r n" style="height:34px;padding:0 8px 0 12px;gap:4px"><div class="g b6">acme-web</div><div class="ib" style="width:26px;height:26px">{ic("collapse",14)}</div><div class="ib" style="width:26px;height:26px">{ic("refresh",14)}</div><div class="ib" style="width:26px;height:26px">{DOTS}</div></div>
<div class="c n" style="padding:0 10px 8px;gap:8px">
  <div class="r" style="height:32px;padding:0 10px;gap:8px;border-radius:7px;border:1px solid #8ab4f8;background:#0f1012">{ic("search",13,"#7d818b")}<div class="g">checkoutTotal</div>{ic("x",12,"#7d818b")}</div>
  <div class="r" style="gap:10px"><div class="seg"><div>Names</div><div class="on">Contents</div></div><div class="g"></div><div class="s11 dim">8 matches in 4 files</div></div>
</div>
<div class="c g" style="padding:0 8px;gap:8px;min-height:0;border-top:1px solid #26282d;padding-top:8px">{res}</div>
<div class="c n" style="border-top:1px solid #26282d">
  <div class="r" style="height:32px;padding:0 12px;gap:8px"><div class="g tr mono s12">src/cart/session.ts</div><div class="s11 dim n">line 42 · read-only preview</div></div>
  <div class="c mono" style="padding:0 12px 12px;font-size:11.5px;line-height:1.7;color:#c9ccd3;white-space:pre">{''.join(f'<div class="r" style="gap:12px;{"background:#2a2418;" if n==42 else ""}"><span class="dim" style="width:22px;text-align:right">{n}</span><span>{t}</span></div>' for n,t in [(40,"// Total with tax and shipping, from the pricing service."),(41,""),(42,H("export async function checkoutTotal(cart: Cart) {")),(43,'  const res = await api.post("/pricing/total", cart);'),(44,"  return res.total;"),(45,"}")])}</div>
</div>
</div></div>"""
    page("files-search", 460, 700, body, "Files: search inside files")

# ---------------------------------------------------------------- accounts
def accounts():
    act = '<div class="chip b5" style="background:#253626;color:#98c379">Active</div>'
    b = lambda t, dim=False: f'<div class="btn s12" style="height:24px;padding:0 9px;{"background:none;color:#a5a8b0" if dim else ""}">{t}</div>'
    def row(name, mail, plan, right, on=False, warn=""):
        sub = f'<span style="color:#e5c07b">{warn}</span>' if warn else f'{mail} · {plan}'
        return f'<div class="r" style="height:50px;padding:0 12px;gap:10px;border-radius:8px;background:{"#212328" if on else "transparent"};border:1px solid {"#383b43" if on else "#26282d"}"><div class="n" style="width:14px;height:14px;border-radius:50%;border:{"4px solid #8ab4f8" if on else "1.5px solid #7d818b"}"></div><div class="g"><div class="b5 tr">{name}</div><div class="s11 dim tr">{sub}</div></div>{right}</div>'
    def prov(k, name, env, rows):
        return f'<div class="c" style="gap:6px"><div class="r" style="gap:8px;height:24px">{ag(k)}<div class="b6">{name}</div><div class="s11 dim mono">{env}</div><div class="g"></div><div class="r s12 mut" style="gap:5px">{ic("plus",12)}Add account</div></div>{rows}</div>'
    body = f"""<div style="width:680px;height:560px;padding:14px"><div class="c" style="height:100%;background:#1b1c20;border:1px solid #383b43;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.5);overflow:hidden">
  <div class="r n" style="height:56px;padding:0 18px;gap:10px;border-bottom:1px solid #26282d"><div class="g"><div class="b6" style="font-size:15px">Accounts</div><div class="s11 dim">Which login new Claude Code and Codex agents start on</div></div><div class="ib">{ic("refresh",14)}</div><div class="kbd">Esc</div></div>
  <div class="c g" style="padding:14px 18px;gap:16px;min-height:0">
    {prov("cc","Claude Code","CLAUDE_CONFIG_DIR", row("System default","dev@example.com","Max",act,True) + row("Work","second@example.org","Team", b("Use")+b("Sign in again",True)+b("Remove",True)))}
    {prov("cx","Codex","CODEX_HOME", row("System default","dev@example.com","Plus",b("Use")) + row("Work","second@example.org","Pro", act+b("Sign in again",True)+b("Remove",True),True) + row("Side project","","", b("Sign in")+b("Remove",True), warn="Not signed in yet"))}
    <div class="c" style="gap:7px;padding-top:12px;border-top:1px solid #26282d">
      <div class="r" style="gap:12px"><div class="g b5">When you switch while agents are running</div><div class="seg"><div class="on">Ask</div><div>Restart them</div><div>Leave them</div></div></div>
      <div class="s11 dim">Shows the agents that can move, and you pick. Working agents are never restarted.</div>
    </div>
  </div>
</div></div>"""
    page("accounts", 680, 560, body, "Accounts")

for f in (overview, sidebar_page, panel_inspector, command_bar, new_agent, board, team_map, trace, files_search, accounts): f()
print("ok")
