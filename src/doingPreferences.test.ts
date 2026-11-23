import { beforeEach, expect, it } from "vitest";
import {
  dismissDoing,
  loadDoing,
  observeDoing,
  saveDoing,
} from "./doingPreferences";
import type { Thread } from "./api";
const thread: Thread = {
  id: "t",
  title: "会話",
  cwd: "/project",
  createdAt: 1,
  updatedAt: 10,
  unread: true,
  archived: false,
  groupId: null,
  position: 0,
};
beforeEach(() => localStorage.clear());
it("keeps Doing entries after read acknowledgement, regrouping, and archiving", () => {
  const state = observeDoing(new Map(), [thread]);
  expect(state.get("t")?.active).toBe(true);
  expect(
    observeDoing(state, [
      { ...thread, unread: false, groupId: "group", archived: true },
    ]),
  ).toBe(state);
  expect(saveDoing(state)).toBe(true);
  expect(loadDoing().get("t")?.active).toBe(true);
});
it("does not re-add the same dismissed unread update, including after restart", () => {
  const state = dismissDoing(observeDoing(new Map(), [thread]), thread);
  saveDoing(state);
  const restored = loadDoing();
  expect(observeDoing(restored, [thread])).toBe(restored);
  expect(restored.get("t")?.active).toBe(false);
  const next = observeDoing(restored, [{ ...thread, updatedAt: 11 }]);
  expect(next.get("t")?.active).toBe(true);
  expect(next.get("t")?.updatedAt).toBe(11);
});
it("ignores read and already archived threads when collecting new Doing work", () => {
  const empty = new Map();
  expect(
    observeDoing(empty, [
      { ...thread, unread: false },
      { ...thread, id: "a", archived: true },
    ]),
  ).toBe(empty);
});
it("tolerates invalid stored state and preserves update watermarks when dismissed", () => {
  localStorage.setItem("treadcraft.doingThreads.v1", "invalid");
  expect(loadDoing().size).toBe(0);
  const state = observeDoing(new Map(), [thread]);
  const dismissed = dismissDoing(state, { ...thread, updatedAt: 5 });
  expect(dismissed.get("t")).toEqual({ active: false, updatedAt: 10 });
  expect(state.get("t")?.active).toBe(true);
});
