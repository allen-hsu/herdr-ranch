# A Git button in the top bar

Herdr's main layout has a **Files** and a **Changes** button at the right end of
the tab bar, each opening a side panel. These steps add **Git** beside them,
opening `git-graph` in the same panel. They are written for the person's agent
to follow; a person can follow them too.

Herdr's own layouts and mods are read-only (they're replaced on every start), so
the button goes into *clones* of the `main` layout and the `tabs` mod. This mod
doesn't ship those clones: they'd be frozen copies of Herdr's code. You make
them from the version you have now.

What clones cost: they're yours and never updated. When a Herdr release changes
the tab bar or the main layout, the clones keep the old ones until you clone
again and redo these steps.

## 1. Clone the tab bar and the layout

```sh
herdr-app do mod.clone '{"name":"tabs","as":"tabs-graph"}'
herdr-app do layout.clone '{"name":"main","as":"main-graph"}'
```

`layout.clone` switches the window to the clone.

## 2. Add the button: `mods/tabs-graph/main.js`

Two edits. In Herdr 0.1.9 and 0.1.10 the lines read as below; in another
version, find the same two places (the list of enabled panels, and the Changes
button).

The enabled panels decide which buttons show and which panel a space may
reopen. Add `"graph"` to them:

```js
// before
const enabled = shared("workspace.panels") ?? ["files", "changes"];
// after
const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "graph"];
```

Then add the button right after the Changes one:

```js
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .child(panelButton("graph", "Git", "mods/git-graph/icons/graph.svg"))
```

## 3. Add the panel: `layouts/main-graph.json`

- The node with `"id": "tabs"`: set its `content.mod` to `"tabs-graph"`.
- The stack with `"id": "panel-body"` (it holds `files` and `changes`): append
  a third child:

```json
{ "id": "graph", "type": "block", "content": { "mod": "git-graph" } }
```

## 4. A key for it (optional): ⌘G

A key runs one command, and opening a panel takes two (select it, then show
it). So give the tab bar a command per panel that does what its button does.
In `mods/tabs-graph/main.js`, add `nextCommand` to the import from `"herdr"`,
then make `init` listen for key commands and add `togglePanel` below it:

```js
  init(_props, cx) {
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    // Keys open a panel as its button does: "cmd-g": "tabs-graph.graph" in keys.json.
    cx.spawn(async (cx) => { for (;;) { this.togglePanel(await nextCommand()); cx.notify(); } });
  }

  togglePanel(id) {
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    if (!panel || !body?.children?.some((c) => c.id === id)) return;
    if (!panel.hidden && body.active === id) run("layout.hide", { id: "panel" });
    else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
  }
```

And the buttons use it too: in `panelButton`, the `on_click` that hides or
shows the panel becomes `.on_click(() => this.togglePanel(id))`.

Then bind the key in `keys.json`, in a section for this layout only (the
person's other layouts don't have this tab bar):

```json
"layout:main-graph": { "cmd-g": "tabs-graph.graph" }
```

`tabs-graph.files` and `tabs-graph.changes` open those panels the same way.
Each opens its panel, switches the open panel to it, or closes it when it's
already showing. Ask before taking a key the person already uses, and avoid
plain ctrl+letters: terminal programs use them (ctrl-g opens the editor in
Claude Code).

## 5. Check

```sh
herdr-app check ~/.config/herdr-app/mods/tabs-graph
herdr-app check ~/.config/herdr-app/mods/git-graph
herdr-app status          # "errors": [] and "layout": "main-graph"
```

On Herdr 0.1.9 for macOS, `herdr-app check` crashes for every mod, Herdr's own
included (a GPUI unwrap before the first frame). There, rely on
`herdr-app status` and look at the window instead. 0.1.10 fixes it.

Click **Git** in the top bar (or press ⌘G). If the window doesn't show your edits, switch
layouts away and back (`ctrl-shift-l` twice): a copy that was reloaded while
open can keep drawing its old frame.

## Going back

`ctrl-shift-l` switches back to Herdr's `main`. Deleting `layouts/main-graph.json`
and `mods/tabs-graph/` removes the clones; if you added the key, remove the
`layout:main-graph` section from `keys.json` too. `mods/git-graph/` can stay for
use as a pane.
