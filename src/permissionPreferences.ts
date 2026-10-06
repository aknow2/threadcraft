import type { SendOptions } from "./api";

const key = "treadcraft.defaultPermission.v1";
type Permission = NonNullable<SendOptions["permission"]>;

export function loadPermission(): Permission {
  try {
    const value = localStorage.getItem(key);
    if (
      value === "read-only" ||
      value === "workspace-write" ||
      value === "danger-full-access"
    )
      return value;
  } catch {
    /* Storage can be unavailable; retain the safe initial setting. */
  }
  return "read-only";
}

export function savePermission(value: Permission): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
