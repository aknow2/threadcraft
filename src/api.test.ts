import { describe, expect, it } from "vitest";
import { newerBoard, visibleThreads, errorMessage, type Board } from "./api";
const board: Board = {
  revision: 2,
  lastSync: 10,
  groups: [{ id: "g", name: "Group" }],
  threads: [
    {
      id: "a",
      title: "API 調査",
      createdAt: 1,
      cwd: "",
      archived: false,
      groupId: null,
      position: 0,
    },
    {
      id: "b",
      title: "UI 改善",
      createdAt: 3,
      cwd: "",
      archived: false,
      groupId: null,
      position: 0,
    },
    {
      id: "c",
      title: "Archived",
      createdAt: 5,
      cwd: "",
      archived: true,
      groupId: null,
      position: 0,
    },
  ],
};
describe("board projection", () => {
  it("puts unread threads first and sorts each set by latest activity instead of manual order", () => {
    const grouped = {
      ...board,
      threads: [
        {
          ...board.threads[0],
          id: "read",
          groupId: "g",
          position: 0,
          updatedAt: 50,
        },
        {
          ...board.threads[0],
          id: "read-new",
          groupId: "g",
          position: 9,
          updatedAt: 100,
        },
        {
          ...board.threads[0],
          id: "unread2",
          groupId: "g",
          position: 2,
          updatedAt: 20,
          unread: true,
        },
        {
          ...board.threads[0],
          id: "unread1",
          groupId: "g",
          position: 1,
          updatedAt: 10,
          unread: true,
        },
      ],
    };
    expect(visibleThreads(grouped, "g", "").map((t) => t.id)).toEqual([
      "unread2",
      "unread1",
      "read-new",
      "read",
    ]);
    expect(grouped.threads.map((t) => t.id)).toEqual([
      "read",
      "read-new",
      "unread2",
      "unread1",
    ]);
  });
  it("falls back to creation time and uses id for stable equal-time ordering", () => {
    const grouped = {
      ...board,
      threads: [
        {
          ...board.threads[0],
          id: "z",
          groupId: "g",
          updatedAt: 0,
          createdAt: 20,
        },
        { ...board.threads[0], id: "a", groupId: "g", updatedAt: 20 },
        { ...board.threads[0], id: "b", groupId: "g", createdAt: 30 },
      ],
    };
    expect(visibleThreads(grouped, "g", "").map((t) => t.id)).toEqual([
      "b",
      "a",
      "z",
    ]);
  });
  it("sorts inbox newest first and hides archived threads", () =>
    expect(visibleThreads(board, null, "").map((t) => t.id)).toEqual([
      "b",
      "a",
    ]));
  it("filters titles case insensitively", () =>
    expect(visibleThreads(board, null, " api ").map((t) => t.id)).toEqual([
      "a",
    ]));
  it("does not let an older refresh overwrite a move", () =>
    expect(newerBoard(board, { ...board, revision: 1 })).toBe(board));
  it("does not let a delayed read overwrite a newer sync", () =>
    expect(newerBoard(board, { ...board, lastSync: 5 })).toBe(board));
  it("maps a structured conflict to a readable message", () =>
    expect(errorMessage({ code: "Conflict" })).toContain("やり直し"));
});
