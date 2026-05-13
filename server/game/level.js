import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import xhr2 from "xhr2";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader.js";
import "@babylonjs/loaders/glTF/index.js";
import { scene, physicsAggregates, createPhysicsBodies, createArenaColliders } from "./physics.js";
import { gameObjects, loadTargets, dragState, gameState } from "./state.js";
import { PORT } from "../config.js";
import { SERVER_CONFIG } from "../config.js";
import {
  isTrebuchetName,
  isMissileName,
  isKingName,
  restArmAngleForTrebuchet,
  ARM_STATE_IDLE,
} from "./entities.js";
import { getTemplate } from "./templateRegistry.js";

const { XMLHttpRequest } = xhr2;
globalThis.XMLHttpRequest = XMLHttpRequest;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, "../../public/assets");

function clearScene() {
  for (const [, aggregate] of physicsAggregates) {
    aggregate.dispose();
  }
  physicsAggregates.clear();
  gameObjects.clear();
  loadTargets.clear();
  dragState.clear();

  const arenaRoots = scene.rootNodes.filter((n) => n.name === "__root__");
  for (const root of arenaRoots) {
    root.dispose(false, true);
  }
}

function spawnObjectsFromConfig(config) {
  const counters = new Map();

  for (const entry of config.objects) {
    const templatePath = entry.template;
    const count = counters.get(templatePath) ?? 0;
    counters.set(templatePath, count + 1);
    const generatedId = `${templatePath}_${count}`;

    const templateData = getTemplate(templatePath);
    if (!templateData) {
      console.warn(`Template "${templatePath}" not found in registry, skipping ${generatedId}`);
      continue;
    }

    const bounds = templateData.bounds;

    const object = {
      id: generatedId,
      x: entry.x,
      y: entry.y,
      z: entry.z,
      originX: entry.x,
      originY: entry.y,
      originZ: entry.z,
      rot: entry.rotation ?? 0,
      originRot: entry.rotation ?? 0,
      angularVelocity: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      dragVx: 0,
      dragVy: 0,
      dragVz: 0,
      dynamic: true,
      draggedBy: null,
      offsetX: bounds.offsetX,
      offsetY: bounds.offsetY,
      offsetZ: bounds.offsetZ,
      halfX: bounds.halfX,
      halfY: bounds.halfY,
      halfZ: bounds.halfZ,
      halfHeight: bounds.halfY,
      mass: SERVER_CONFIG.dynamicMass,
      friction: SERVER_CONFIG.dynamicFriction,
      restitution: SERVER_CONFIG.dynamicRestitution,
      player: entry.player ?? null,
      ...(isTrebuchetName(generatedId) ? {
        loaded: false,
        loadedMissileId: null,
        fireState: ARM_STATE_IDLE,
        armAngle: restArmAngleForTrebuchet(),
        aimedBy: null,
        aimStart: null,
        aimCurrent: null,
        pendingShot: null,
        returnStartArmAngle: null,
        releaseElapsedMs: 0,
      } : {}),
      ...(isMissileName(generatedId) ? { loadedInto: null } : {}),
      ...(isKingName(generatedId) ? { hits: 0, maxHits: 3 } : {}),
    };

    gameObjects.set(generatedId, object);

    if (isTrebuchetName(generatedId) && templateData.targetNode) {
      loadTargets.set(generatedId, {
        targetNode: templateData.targetNode,
        rootNode: templateData.rootNode,
        armNode: templateData.armNode,
        offsetX: templateData.loadTargetOffsetX,
        offsetY: templateData.loadTargetOffsetY,
        offsetZ: templateData.loadTargetOffsetZ,
      });
    }
  }

  createPhysicsBodies();
}

export async function loadLevelIfPresent(level) {
  if (!level) {
    console.log("No level to load.");
    return;
  }

  const arenaFile = level.file;
  const arenaPath = path.join(assetsDir, arenaFile);

  try {
    await fs.access(arenaPath);
    await SceneLoader.AppendAsync(`http://localhost:${PORT}/assets/`, arenaFile, scene);
    console.log(`Loaded arena: ${arenaFile}`);
    createArenaColliders();
  } catch {
    console.log(`No arena GLB at public/assets/${arenaFile}; starting with empty scene.`);
  }

  if (level.config) {
    const configPath = path.join(assetsDir, level.config);
    try {
      const raw = await fs.readFile(configPath, "utf8");
      const config = JSON.parse(raw);
      spawnObjectsFromConfig(config);
      console.log(`Spawned ${gameObjects.size} objects from ${level.config}`);
    } catch (error) {
      console.error(`Failed to read level config ${level.config}:`, error.message);
    }
  }

  for (const object of gameObjects.values()) {
    console.log(
      `  ${object.id}: pos=(${object.x.toFixed(2)}, ${object.y.toFixed(2)}, ${object.z.toFixed(2)}) half=(${object.halfX.toFixed(2)}, ${object.halfY.toFixed(2)}, ${object.halfZ.toFixed(2)}) player=${object.player}`,
    );
  }
}

export async function reloadLevel(level) {
  clearScene();
  gameState.currentLevel = level;
  await loadLevelIfPresent(level);
}
