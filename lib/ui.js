// The ranch's design scale, shared by every mod so panels, menus and dialogs read as one app.
// Use these instead of literal numbers.
// Shared lib (herdr-ranch/lib): install.sh copies it into each mod that lists it in lib.json.
import { settings } from "herdr";
import { div, svg } from "gpui-kit";
import { h_flex, Input } from "gpui-base";

// Text sizes follow the UI font size the person picked in Herdr's settings (default 13), so the ranch's mods scale
// with Herdr's own text. Kept small on purpose: hierarchy comes from weight and color more than size. Read on each use (they are getters), so a settings change applies at the next render.
const base = () => { const v = Number(settings()?.ui_font_size); return v >= 9 && v <= 24 ? v : 13; };
export const TS = {
  get tiny() { return base() - 3; },    // badges inside chips
  get small() { return base() - 2.5; }, // section headings (uppercase), captions, timestamps
  get meta() { return base() - 2; },    // secondary lines, numbers on the right of a row, sub-tabs
  get body() { return base() - 1.5; },    // body text, controls, chips, panel tabs
  get item() { return base() - 0.5; },  // the name of a list item
  get title() { return base() + 1; },    // panel / dialog titles, big numbers
};
export const ROW = { tight: 24, list: 28, side: 30, menu: 32 };
export const RADIUS = { chip: 6, control: 7, card: 8, pill: 12 };
// Insets: every surface keeps one left edge for headings, rows and notes.
export const SPACE = {
  panel: 14,  // right-panel content (Inspector, PRs, Changes)
  dialog: 16, // dialogs and floating windows
  card: 10,   // inside a card
};
// Gaps and vertical padding come in even steps only: 2, 4, 6, 8, 12.

// Panel header height (right panel, sidebar sections), matching Herdr's own panels.
export const HEADER = 42;

// ---- Shared pieces, copied from Herdr's built-in dialogs (picker, help, prompt) so ours look native. ----

// Dialog title: 15 semibold, like "Go to…" / "Keybinds".
export const dialogTitle = (t, text) => div().text_size(15).font_semibold().text_color(t.foreground).child(text);

// The "Esc" chip at the top right of a dialog: the close control (Herdr doesn't use an ×).
export const escChip = (t, id, onClose) => div().id(id).flex_none().px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
  .hover((s) => s.bg(t.hover).text_color(t.foreground))
  .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(onClose).child("Esc");

// A text field. size "dialog": Herdr's h36 rounded9 (picker / prompt); "panel": h32 rounded7 for panels and inline forms.
// icon: an svg path (e.g. "mods/workspace-chrome/search.svg"). focused: draws the accent border.
export const field = (t, state, { size = "dialog", icon = null, focused = false, w = null } = {}) => {
  const big = size === "dialog";
  const box = h_flex().h(big ? 36 : 32).flex_none().px(10).gap(8).items_center().rounded(big ? 9 : 7).border_1()
    .border_color(focused ? t.accent : t.input).bg(t.background)
    .when(icon != null, (e) => e.child(svg(icon).size(big ? 15 : 13).flex_none().text_color(t.dim)))
    .child(Input.new(state).flex_1().h_full().text_size(big ? 12.8 : TS.body).text_color(t.foreground));
  return w == null ? box : box.w(w);
};

// Section heading inside a panel or dialog: 11 semibold dim, sentence case (Herdr doesn't shout in caps).
export const heading = (t, text, right = null) => h_flex().h(28).px(SPACE.panel).gap(6).items_center().text_size(11).font_semibold().text_color(t.dim)
  .child(div().flex_1().min_w(0).truncate().child(text))
  .when(right != null, (e) => e.child(div().flex_none().font_normal().child(String(right))));

// Empty state: one quiet line, like the built-in Files / Changes panels.
export const emptyNote = (t, text) => div().p(8).px(SPACE.panel).text_size(TS.body).text_color(t.dim).child(text);

// ---- Color: every mod takes its colors from here, all derived from the Herdr theme, so a theme change
// (dark or light) moves everything together. Never write a hex color in a mod. ----
// Usage: const c = C(t); c.status.working, c.kind.tool, c.on.status ...
export const C = (t) => ({
  // Agent / space status. One meaning per color, everywhere.
  status: { working: t.working, blocked: t.blocked, done: t.done ?? t.accent, idle: t.idle ?? t.dim, none: t.border },
  // Something healthy / online (a connected machine, passing checks).
  ok: t.ansi2 ?? t.done,
  // Text drawn on a filled status or accent color.
  on: { status: t.solid_foreground ?? t.background, accent: t.accent_foreground ?? t.background, solid: t.solid_foreground ?? t.background },
  // What an agent's time or tokens went to (Inspector trace, Team map).
  kind: { llm: t.ansi4 ?? t.accent, tool: t.ansi2 ?? t.done, agent: t.ansi5 ?? t.accent, skill: t.ansi5 ?? t.accent,
    hook: t.muted, wait: t.working, other: t.border, system: t.ansi6 ?? t.muted, memory: t.ansi3 ?? t.muted, history: t.muted, new: t.working },
  // Code changes, as Herdr's own Changes panel draws them.
  diff: { add: t.ansi2 ?? t.done, del: t.ansi1 ?? t.blocked, mod: t.ansi3 ?? t.working },
  // Folder / space identity tiles.
  tile: [t.ansi6, t.ansi3, t.ansi4, t.ansi5, t.ansi2, t.ansi1].map((x) => x ?? t.accent),
});

// A translucent tint of a theme color (for soft badges and row highlights). a: 0..1.
export const tint = (color, a = 0.15) => {
  const h = String(color ?? "");
  return /^#[0-9a-fA-F]{6}$/.test(h) ? h + Math.round(a * 255).toString(16).padStart(2, "0") : /^#[0-9a-fA-F]{8}$/.test(h) ? h.slice(0, 7) + Math.round(a * 255).toString(16).padStart(2, "0") : color;
};

// ---- Surfaces: four tiers, the same everywhere. ----
//   panel    t.chrome   sidebars, the right panel, bars          (no border inside)
//   card     t.surface  cards and grouped blocks on a panel/dialog (no border: the tier is the edge)
//   hover    t.hover    pointer over a row or card; selected rows use t.selected (+ a 2px accent edge in lists)
//   dialog   t.popover  dialogs, popups, menus (Herdr draws their frame)
// Fields: t.background with a t.input border (accent when focused). Chips/pills: border t.border, no fill.
export const SURF = (t) => ({ panel: t.chrome, card: t.surface, hover: t.hover, selected: t.selected, dialog: t.popover, field: t.background });

// ---- Icons: one set (Lucide, like Herdr's own), installed at ~/.config/herdr-app/ranch/icons. ----
// icon("pin", 12, t.dim). Sizes: 12 in rows and chips, 14 in buttons and headers, 16 for empty states.
export const icon = (name, size = 12, color = null) => {
  const el = svg(`ranch/icons/${name}.svg`).size(size).flex_none();
  return color ? el.text_color(color) : el;
};

// ---- Status: the one mark for an agent (or a group of agents), used by every list, tab, card and toast. ----
// working: spinner · blocked: "!" badge (or a "Needs you" pill with label) · done: filled dot · idle: ring · none: faint dot.
export const statusOf = (list) => {
  const s = (list ?? []).map((a) => (typeof a === "string" ? a : a?.status));
  return s.some((x) => x === "blocked" || x === "error") ? "blocked" : s.includes("working") ? "working" : s.includes("done") ? "done" : s.length ? "idle" : "none";
};
export function statusMark(t, status, { label = false, size = 12 } = {}) {
  const c = C(t).status;
  if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(size).mx(1).flex_none().text_color(c.working).spin(900);
  if (status === "blocked" || status === "error") return label
    ? div().flex_none().px(6).h(18).rounded(5).bg(tint(c.blocked)).text_size(TS.small).font_semibold().text_color(c.blocked).flex().items_center().child("Needs you")
    : div().size(size + 2).flex_none().rounded(4).bg(tint(c.blocked)).text_size(TS.small).font_bold().text_color(c.blocked).flex().items_center().justify_center().child("!");
  const d = Math.max(5, Math.round(size * 0.58));
  if (status === "done") return div().size(d).mx((size + 2 - d) / 2).flex_none().rounded(d).bg(c.done);
  if (status === "idle") return div().size(d).mx((size + 2 - d) / 2).flex_none().rounded(d).border(1.5).border_color(c.idle);
  return div().size(5).mx((size + 2 - 5) / 2).flex_none().rounded(3).bg(c.none);
}

// A space's display name: the home-folder space ("~") reads "Home" everywhere.
export const spaceName = (name) => (!name || name === "~" ? "Home" : name);
