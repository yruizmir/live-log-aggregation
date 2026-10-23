/**
 * A stable hue for a name, so a pod keeps its colour across refreshes. Pod names differ only in
 * their last characters, so the hash is spread by the golden angle to keep neighbours apart.
 */
export const hueOf = (name: string) => {
  let hash = 2166136261;

  for (const character of name) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }

  return Math.round(((hash >>> 0) * 137.508) % 360);
};
