const clearers = new Set<() => void>();

export function registerSessionCache(clear: () => void): () => void {
  clearers.add(clear);
  return () => clearers.delete(clear);
}

export function clearSessionCaches(): void {
  for (const clear of clearers) {
    try {
      clear();
    } catch {}
  }
}
