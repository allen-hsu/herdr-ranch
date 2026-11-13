// Shared lib (herdr-ranch/lib): install.sh copies it into each mod that lists it in lib.json.
// Which space-folders folder each space is in, computed the same way mods/space-folders does
// (logic ported from jankeesvw/herdr-space-folders @63a78b2, MIT): a space dragged into a folder
// stays there ("" = dragged out of every folder); otherwise the folder whose comma-separated
// rules reach deepest into the folder the space was made in, else the one it works in now. This computer's spaces only.
import { shared, readTextFile, home } from "herdr";

export function rule(pattern) {
  const p = pattern.trim().replace(/\/+$/, "");
  if (!p) return null;
  const body = p.replace(/^~/, "\u0000").split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")
    .replace("\u0000", "(?:/home/[^/]+|/Users/[^/]+|/root)");
  return new RegExp(`${/^[/~]/.test(p) ? "^" : "(?:^|/)"}${body}(?:/|$)`);
}

const reach = (f, path) => !path ? 0 : Math.max(0, ...(f.match ?? "").split(",").map((p) => {
  const m = rule(p)?.exec(path);
  return m ? 1 + m.index + m[0].replace(/\/$/, "").length : 0;
}));

export function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

export function folderOf(s, data, ps) {
  if (s.machine) return null;
  const { list = [], of = {} } = data ?? {};
  const id = of[s.id];
  if (id !== undefined) return list.some((f) => f.id === id) ? id : null;
  // The folder it was made in first, then the folder it works in now (as mods/space-folders does): an agent that
  // `cd`s elsewhere stays in the folder it was started in.
  const deepest = (path) => { let best = null, most = 0; for (const f of list) { const n = reach(f, path); if (n > most) { best = f; most = n; } } return best?.id ?? null; };
  return deepest(s.folder) ?? deepest(place(s, ps));
}

// Live data from the space-folders mod (shared state), else its file.
export async function loadFolders() {
  const live = shared("space-folders")?.[""];
  if (live?.list) return live;
  try { return JSON.parse((await readTextFile(home() + "/.config/herdr-space-folders.json")) ?? "null") ?? { list: [], of: {} }; }
  catch { return { list: [], of: {} }; }
}
