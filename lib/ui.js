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
