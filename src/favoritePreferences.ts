const key = "treadcraft.favoriteThreads.v1";

export function loadFavorites(): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (Array.isArray(value)) {
      return new Set(
        value.filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        ),
      );
    }
  } catch {
    // Unavailable or invalid storage must not prevent opening the board.
  }
  return new Set();
}

export function saveFavorites(ids: Set<string>): boolean {
  try {
    localStorage.setItem(key, JSON.stringify([...ids]));
    return true;
  } catch {
    return false;
  }
}
