// The name an agent goes by, the same way Herdr's own agent list names it: the terminal's live
// title (Claude Code sets it to the session's topic) when it says something, else the tab's name.
// Shared lib (herdr-ranch/lib): install.sh copies it into each mod that lists it in lib.json.
import { panes, spaces } from "herdr";

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

export function agentName(a) {
  if (!a) return "";
  const pane = panes().find((p) => p.terminal === a.address);
  const prog = a.program?.name;
  const live = clean(pane?.title ?? a.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== a.program?.key;
  const tab = spaces().flatMap((s) => s.tabs ?? []).find((t) => t.id === a.tab);
  const tabName = tab?.name ?? a.tab_name;
  if (telling && (!tab || tabName === prog || !tab.named)) return live;
  return tabName && !/^\d+$/.test(tabName) ? tabName : live || prog || a.address;
}
