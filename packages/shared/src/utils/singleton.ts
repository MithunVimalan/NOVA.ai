/**
 * Builds a lazily-initialized singleton accessor around a factory function.
 * The instance is created on first access and reused afterwards.
 */
export function createSingleton<T>(factory: () => T): () => T {
  let instance: T | null = null;
  return () => {
    if (instance === null) {
      instance = factory();
    }
    return instance;
  };
}
