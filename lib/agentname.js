// The name an agent goes by: the name given with /rename when there is one (what Claude Code's own agent list
// shows), else as Herdr's own agent list names it: the terminal's live title (Claude Code sets it to a topic it
// writes itself) when it says something, else the tab's name.
// Shared lib (herdr-ranch/lib): install.sh copies it into each mod that lists it in lib.json.
import { panes, spaces, shared, setShared } from "herdr";

// { address: name given with /rename }, kept by lib/givennames.js, shared so every mod's copy of this file names
// agents the same way. True when it changed.
const GIVEN = "ranch.given-names";
// { address: { name, ... } }: a tab rename on its way to the agent as /rename (lib/givennames.js); shown already.
export const PENDING = "ranch.rename-pending";
export const givenNames = () => shared(GIVEN) ?? {};
// Tab names Herdr gives, not you: an agent program's name, or a number ("3", "tb12").
export const PROGRAM_NAMES = new Set(["Claude Code", "Codex", "Cursor", "Gemini", "Grok"]);
export const numberName = (n) => /^(tb)?\d+$/.test(String(n ?? ""));
const sorted = (o) => JSON.stringify(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
export function setGivenNames(names) {
  if (sorted(shared(GIVEN)) === sorted(names)) return false;
  setShared(GIVEN, names);
  return true;
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// A tab rename not yet in Claude Code (it waits for the agent to be free): the name shows, with a clock beside it.
export const renamePending = (a) => Boolean(a && shared(PENDING)?.[a.address]);
export const RENAME_TIP = "Renamed here; Claude Code gets the name when this agent is free and its input box is empty";

// The name given with /rename (or on its way there from a tab rename), or null. It comes before any other name, a
// tab's you named included.
export function givenName(a) {
  const v = a ? shared(PENDING)?.[a.address]?.name ?? shared(GIVEN)?.[a.address] : null;
  return typeof v === "string" && v ? v : null;
}

export function agentName(a) {
  if (!a) return "";
  const given = givenName(a);
  if (given) return given;
  const pane = panes().find((p) => p.terminal === a.address);
  const prog = a.program?.name;
  const live = clean(pane?.title ?? a.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== a.program?.key;
  const tab = spaces().flatMap((s) => s.tabs ?? []).find((t) => t.id === a.tab);
  const tabName = tab?.name ?? a.tab_name;
  if (telling && (!tab || tabName === prog || !tab.named)) return live;
  return tabName && !/^\d+$/.test(tabName) ? tabName : live || prog || a.address;
}
