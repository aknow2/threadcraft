import type { Thread } from "./api";

const key = "treadcraft.doingThreads.v1";
type Entry = { active: boolean; updatedAt: number };
export type DoingState = Map<string, Entry>;
const updatedAt = (thread: Thread) => thread.updatedAt || thread.createdAt;

export function loadDoing(): DoingState {
  try {
    const entries: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(entries)) return new Map();
    return new Map(
      entries.filter(
        (entry): entry is [string, Entry] =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === "string" &&
          entry[0].length > 0 &&
          entry[1] &&
          typeof entry[1].active === "boolean" &&
          typeof entry[1].updatedAt === "number" &&
          Number.isFinite(entry[1].updatedAt),
      ),
    );
  } catch {
    return new Map();
  }
}

// This is a history of unread arrivals, independent of the current read flag.
// A dismissal suppresses the same unread update; a newer update can enter again.
export function observeDoing(
  current: DoingState,
  threads: Thread[],
): DoingState {
  let next = current;
  for (const thread of threads) {
    if (!thread.unread || thread.archived) continue;
    const previous = current.get(thread.id);
    const update = updatedAt(thread);
    if (previous && update <= previous.updatedAt) continue;
    if (next === current) next = new Map(current);
    next.set(thread.id, { active: true, updatedAt: update });
  }
  return next;
}

export function dismissDoing(current: DoingState, thread: Thread): DoingState {
  const next = new Map(current);
  next.set(thread.id, {
    active: false,
    updatedAt: Math.max(
      current.get(thread.id)?.updatedAt ?? 0,
      updatedAt(thread),
    ),
  });
  return next;
}

export function saveDoing(state: DoingState): boolean {
  try {
    localStorage.setItem(key, JSON.stringify([...state]));
    return true;
  } catch {
    return false;
  }
}
