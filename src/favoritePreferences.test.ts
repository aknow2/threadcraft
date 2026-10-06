import { afterEach, expect, it } from "vitest";
import { loadFavorites, saveFavorites } from "./favoritePreferences";

afterEach(() => localStorage.clear());

it("loads valid unique IDs while ignoring invalid entries", () => {
  localStorage.setItem(
    "treadcraft.favoriteThreads.v1",
    '["a",null,42,"","a","b"]',
  );
  expect([...loadFavorites()]).toEqual(["a", "b"]);
});

it("recovers from malformed storage", () => {
  localStorage.setItem("treadcraft.favoriteThreads.v1", "{");
  expect([...loadFavorites()]).toEqual([]);
});

it("persists IDs and their registration order", () => {
  expect(saveFavorites(new Set(["b", "a"]))).toBe(true);
  expect([...loadFavorites()]).toEqual(["b", "a"]);
});
