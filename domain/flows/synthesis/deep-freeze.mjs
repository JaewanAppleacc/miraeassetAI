// Recursively freezes a plain JSON-shaped value. Used so synthesis
// modules never hand back a mutable object that a later step (or a
// concurrent request) could accidentally share/mutate state through.
export function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}
