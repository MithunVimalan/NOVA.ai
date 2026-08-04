/**
 * Generates a short, collision-resistant identifier, optionally prefixed
 * (e.g. `generateId('doc')` -> "doc-1717171717171-x8f2a").
 */
export function generateId(prefix?: string, randomLength: number = 5): string {
  const random = Math.random().toString(36).substring(2, 2 + randomLength);
  const id = `${Date.now()}-${random}`;
  return prefix ? `${prefix}-${id}` : id;
}
