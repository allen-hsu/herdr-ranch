#!/bin/bash
# docs/img/src/render.sh [names...]: writes the HTML mockups (gen.py) and renders them to docs/img/*.png at 2x.
R="$(cd "$(dirname "$0")/../../.." && pwd)"
python3 "$(dirname "$0")/gen.py" "$R/docs/img/src" || exit 1
size() { case $1 in overview) echo 1440,900;; sidebar) echo 300,860;; panel-inspector) echo 460,700;; inspector-trace) echo 460,860;; command-bar) echo 760,520;; new-agent) echo 760,420;; board) echo 1200,720;; team-map) echo 1200,700;; files-search) echo 460,700;; accounts) echo 680,560;; esac; }
for n in ${@:-overview sidebar panel-inspector command-bar new-agent board team-map inspector-trace files-search accounts}; do
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --virtual-time-budget=4000 --window-size=$(size $n) --screenshot="$R/docs/img/$n.png" "file://$R/docs/img/src/$n.html" >/dev/null 2>&1
  echo "$n $(sips -g pixelWidth -g pixelHeight "$R/docs/img/$n.png" | tail -2 | awk '{print $2}' | tr '\n' ' ')"
done
