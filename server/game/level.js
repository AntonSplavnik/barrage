import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import xhr2 from "xhr2";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader.js";
import "@babylonjs/loaders/glTF/index.js";
import { scene, physicsAggregates } from "./physics.js";
import { gameObjects, loadTargets, gameState } from "./state.js";
import { PORT } from "../config.js";
import { BARRAGE_CONFIG } from "../../public/config.js";
import { isTrebuchetArmRoot, registerMeshRoots } from "./registration.js";

const { XMLHttpRequest } = xhr2;
globalThis.XMLHttpRequest = XMLHttpRequest;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = path.join(__dirname, "../../public");
const assetsDir = path.join(publicDir, "assets");

function applyTrebuchetArmRestPose() {
  for (const transform of scene.transformNodes) {
    if (!isTrebuchetArmRoot(transform)) continue;

    const degrees = BARRAGE_CONFIG.trebuchetArmRestRotationZDegrees ?? 15;
    const radians = (degrees * Math.PI) / 180;

    transform.rotationQuaternion = null;
    transform.rotation.z = radians;
    transform.computeWorldMatrix(true);
  }
}

function clearScene() {
  for (const [, aggregate] of physicsAggregates) {
    aggregate.dispose();
  }
  physicsAggregates.clear();
  gameObjects.clear();
  loadTargets.clear();

  const rootNodes = scene.rootNodes.filter((n) => n.name === "__root__");
  for (const root of rootNodes) {
    root.dispose(false, true);
  }
}

export async function loadLevelIfPresent(level) {
  const file = level?.file ?? "level1.glb";
  const levelPath = path.join(assetsDir, file);

  try {
    await fs.access(levelPath);
  } catch {
    console.log(`No GLB found at public/assets/${file}; starting with an empty scene.`);
    return;
  }

  await SceneLoader.AppendAsync(`http://localhost:${PORT}/assets/`, file, scene);
  applyTrebuchetArmRestPose();
  registerMeshRoots();
  console.log(`Loaded ${file} with ${gameObjects.size} gameplay objects.`);
  for (const object of gameObjects.values()) {
    console.log(
      `Object ${object.id}: dynamic=${object.dynamic} pos=(${object.x.toFixed(2)}, ${object.y.toFixed(2)}, ${object.z.toFixed(2)}) half=(${object.halfX.toFixed(2)}, ${object.halfY.toFixed(2)}, ${object.halfZ.toFixed(2)}) offset=(${object.offsetX.toFixed(2)}, ${object.offsetY.toFixed(2)}, ${object.offsetZ.toFixed(2)})`,
    );
  }
}

export async function reloadLevel(level) {
  clearScene();
  gameState.currentLevel = level;
  await loadLevelIfPresent(level);
}
