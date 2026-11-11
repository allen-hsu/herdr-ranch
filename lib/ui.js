// The ranch's design scale, shared by every mod so panels, menus and dialogs read as one app.
// Use these instead of literal numbers.
// Shared lib (herdr-ranch/lib): install.sh copies it into each mod that lists it in lib.json.
import { settings } from "herdr";

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
  panel: 12,  // right-panel content (Inspector, PRs, Changes)
  dialog: 16, // dialogs and floating windows
  card: 10,   // inside a card
};
// Gaps and vertical padding come in even steps only: 2, 4, 6, 8, 12.
