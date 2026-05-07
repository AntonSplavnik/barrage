export const LEVELS = [
  {
    id: "level1",
    file: "level1.glb",
    url: "/assets/level1.glb",
  },
  {
    id: "level2",
    file: "level2.glb",
    url: "/assets/level2.glb",
  },
];

export function firstLevel() {
  return LEVELS[0];
}

export function nextLevel(currentLevelId) {
  const index = LEVELS.findIndex((level) => level.id === currentLevelId);
  if (index < 0) return firstLevel();

  return LEVELS[(index + 1) % LEVELS.length];
}
