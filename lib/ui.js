// The ranch's design scale, shared by every mod so panels, menus and dialogs read as one app.
// Matches Herdr's own mods (11 / 12 / 12.8 / 15-ish). Use these instead of literal numbers.
// Shared lib (herdr-ranch/lib): install.sh copies it into each mod that lists it in lib.json.
export const TS = {
  tiny: 10,    // badges, counters inside chips
  small: 10.5, // section headings (uppercase), captions, timestamps
  meta: 11,    // secondary lines under an item
  body: 12,    // body text, controls, chips
  item: 12.8,  // the name of a list item (same as Herdr's sidebar)
  title: 14,   // panel / dialog titles, big numbers
};
export const ROW = { tight: 24, list: 28, side: 30, menu: 32 };
export const RADIUS = { chip: 6, control: 7, card: 8, pill: 12 };
