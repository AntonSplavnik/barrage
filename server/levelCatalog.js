import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, "../public/assets");

let levels = [];

export async function discoverLevels() {
  const files = await fs.readdir(assetsDir);
  levels = files
    .filter((f) => /^level\d+\.glb$/i.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)[0], 10);
      const numB = parseInt(b.match(/\d+/)[0], 10);
      return numA - numB;
    })
    .map((file) => ({
      id: file.replace(".glb", ""),
      file,
      url: `/assets/${file}`,
    }));

  if (levels.length === 0) {
    levels = [{ id: "level1", file: "level1.glb", url: "/assets/level1.glb" }];
  }

  return levels;
}

export function firstLevel() {
  return levels[0];
}

export function nextLevel(currentLevelId) {
  const index = levels.findIndex((l) => l.id === currentLevelId);
  if (index < 0) return firstLevel();
  return levels[(index + 1) % levels.length];
}
