import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, "../../public/assets");
const levelsDir = path.join(assetsDir, "levels");

let levels = [];

export async function discoverLevels() {
  let files;
  try {
    files = await fs.readdir(levelsDir);
  } catch {
    console.log("No levels/ directory found; using empty level list.");
    levels = [];
    return levels;
  }

  levels = files
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)?.[0] ?? "0", 10);
      const numB = parseInt(b.match(/\d+/)?.[0] ?? "0", 10);
      return numA - numB;
    })
    .map((jsonFile) => {
      const id = jsonFile.replace(".json", "");
      return {
        id,
        file: `levels/${id}.glb`,
        url: `/assets/levels/${id}.glb`,
        config: `levels/${jsonFile}`,
      };
    });

  if (levels.length === 0) {
    console.log("No level JSON configs found in levels/.");
  } else {
    console.log(`Discovered ${levels.length} level(s): ${levels.map((l) => l.id).join(", ")}`);
  }

  return levels;
}

export function firstLevel() {
  return levels[0] ?? null;
}

export function nextLevel(currentLevelId) {
  const index = levels.findIndex((l) => l.id === currentLevelId);
  if (index < 0) return firstLevel();
  return levels[(index + 1) % levels.length];
}
