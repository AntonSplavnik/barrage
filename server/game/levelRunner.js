// server/game/levelRunner.js
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import xhr2 from "xhr2";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader.js";
import "@babylonjs/loaders/glTF/index.js";
import { scene, physicsAggregates, createPhysicsBodies, createArenaColliders } from "./physics.js";
import { gameObjects, loadTargets, dragState } from "./state.js";
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

function createSpawnFunction() {
  const counters = new Map();

  return function spawn(templatePath, opts = {}) {
    const count = counters.get(templatePath) ?? 0;
    counters.set(templatePath, count + 1);
    const id = `${templatePath}_${count}`;

    const templateData = getTemplate(templatePath);
    if (!templateData) {
      console.warn(`Template "${templatePath}" not found in registry, skipping ${id}`);
      return;
    }

    const bounds = templateData.bounds;

    const object = {
      id,
      x: opts.x ?? 0,
      y: opts.y ?? 0,
      z: opts.z ?? 0,
      originX: opts.x ?? 0,
      originY: opts.y ?? 0,
      originZ: opts.z ?? 0,
      rot: opts.rotation ?? 0,
      originRot: opts.rotation ?? 0,
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
      player: opts.player ?? null,
      ...(isTrebuchetName(id) ? {
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
      ...(isMissileName(id) ? { loadedInto: null } : {}),
      ...(isKingName(id) ? { hits: 0, maxHits: 3 } : {}),
    };

    gameObjects.set(id, object);

    if (isTrebuchetName(id) && templateData.targetNode) {
      loadTargets.set(id, {
        targetNode: templateData.targetNode,
        rootNode: templateData.rootNode,
        armNode: templateData.armNode,
        offsetX: templateData.loadTargetOffsetX,
        offsetY: templateData.loadTargetOffsetY,
        offsetZ: templateData.loadTargetOffsetZ,
      });
    }
  };
}

export async function loadLevel(levelId) {
  let levelModule;
  try {
    levelModule = await import(`./levels/${levelId}.js`);
  } catch (error) {
    throw new Error(`Failed to load level "${levelId}": ${error.message}`);
  }
  const levelDef = levelModule.default;

  clearScene();

  if (levelDef.arena) {
    const fullPath = path.join(assetsDir, levelDef.arena);
    try {
      await fs.access(fullPath);
      await SceneLoader.AppendAsync(`http://localhost:${PORT}/assets/`, levelDef.arena, scene);
      console.log(`Loaded arena: ${levelDef.arena}`);
    } catch {
      console.log(`No arena GLB at public/assets/${levelDef.arena}; starting with empty scene.`);
    }
  }

  createArenaColliders();

  const spawn = createSpawnFunction();
  levelDef.setup(spawn);
  createPhysicsBodies();

  const levelUrl = levelDef.arena ? `/assets/${levelDef.arena}` : null;

  for (const object of gameObjects.values()) {
    console.log(
      `  ${object.id}: pos=(${object.x.toFixed(2)}, ${object.y.toFixed(2)}, ${object.z.toFixed(2)}) half=(${object.halfX.toFixed(2)}, ${object.halfY.toFixed(2)}, ${object.halfZ.toFixed(2)}) player=${object.player}`,
    );
  }

  return { def: levelDef, url: levelUrl, spawn };
}
