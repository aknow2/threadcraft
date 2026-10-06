import { afterEach, expect, it, vi } from "vitest";
import { loadPermission, savePermission } from "./permissionPreferences";
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
it("uses read-only for absent or invalid saved values", () => {
  expect(loadPermission()).toBe("read-only");
  localStorage.setItem("treadcraft.defaultPermission.v1", "invalid");
  expect(loadPermission()).toBe("read-only");
});
it("persists and restores every supported permission", () => {
  for (const value of [
    "workspace-write",
    "danger-full-access",
    "read-only",
  ] as const) {
    expect(savePermission(value)).toBe(true);
    expect(loadPermission()).toBe(value);
  }
});
it("handles unavailable storage without crashing", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  expect(loadPermission()).toBe("read-only");
  expect(savePermission("workspace-write")).toBe(false);
});
