import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import xhr2 from "xhr2";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader.js";
import "@babylonjs/loaders/glTF/index.js";
import { scene, gameObjects, loadTargets } from "./state.js";
import { PORT, LEVEL_FILE, SERVER_CONFIG } from "./config.js";
import { BARRAGE_CONFIG } from "../public/config.js";
import {
  isDynamicName,
  isTrebuchetName,
  isTrebuchetArmRoot,
  isMissileName,
  isKingName,
  childRole,
  descendantsOf,
  colliderBoundsFor,
  restArmAngleForTrebuchet,
  ARM_STATE_IDLE,
} from "./utils.js";
import { createPhysicsBodies } from "./physics.js";

const { XMLHttpRequest } = xhr2;
globalThis.XMLHttpRequest = XMLHttpRequest;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = path.join(__dirname, "../public");
const assetsDir = path.join(publicDir, "assets");
const levelPath = path.join(assetsDir, LEVEL_FILE);

function findGameplayRootAncestor(node) {
  let current = node.parent;
  let candidate = null;

  while (current) {
    if (isTrebuchetName(current.name)) {
      candidate = current;
    }

    if (current.parent?.name === "__root__") {
      return isTrebuchetName(current.name) ? current : candidate;
    }

    current = current.parent;
  }

  return candidate;
}

function findTrebuchetArmAncestor(node) {
  let current = node.parent;

  while (current) {
    if (isTrebuchetArmRoot(current)) {
      return current;
    }

    current = current.parent;
  }

  return null;
}

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

function registerMeshRoots() {
  loadTargets.clear();

  for (const transform of scene.transformNodes) {
    if (transform.name.toLowerCase().includes("missile-load-target")) {
      const parentTrebuchet = findGameplayRootAncestor(transform);
      const position = transform.getAbsolutePosition();
      const parentAbsolute = parentTrebuchet?.getAbsolutePosition();
      const offset = parentTrebuchet && parentAbsolute
        ? {
          x: -(position.x - parentAbsolute.x),
          y: position.y - parentAbsolute.y,
          z: position.z - parentAbsolute.z,
        }
        : null;
      const target = {
        ...(offset
          ? { offsetX: offset.x, offsetY: offset.y, offsetZ: offset.z }
          : { offsetX: transform.position.x, offsetY: transform.position.y, offsetZ: transform.position.z }),
        targetNode: transform,
        rootNode: parentTrebuchet ?? null,
        armNode: findTrebuchetArmAncestor(transform),
      };
      loadTargets.set(parentTrebuchet?.name ?? "default", target);
      loadTargets.set("default", target);
    }
  }

  for (const transform of scene.transformNodes) {
    if (transform.parent && transform.parent.name !== "__root__") continue;

    const hasGameplayChild = descendantsOf(transform).some((child) => childRole(child.name));

    if (!hasGameplayChild) continue;

    const position = transform.position;
    const dynamic = isDynamicName(transform.name);
    const bounds = colliderBoundsFor(transform);
    gameObjects.set(transform.name, {
      id: transform.name,
      x: position.x,
      y: position.y,
      z: position.z,
      originX: position.x,
      originY: position.y,
      originZ: position.z,
      rot: 0,
      angularVelocity: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      dragVx: 0,
      dragVy: 0,
      dragVz: 0,
      dynamic,
      draggedBy: null,
      offsetX: bounds.offsetX,
      offsetY: bounds.offsetY,
      offsetZ: bounds.offsetZ,
      halfX: bounds.halfX,
      halfY: bounds.halfY,
      halfZ: bounds.halfZ,
      halfHeight: bounds.halfY,
      mass: dynamic ? SERVER_CONFIG.dynamicMass : 0,
      friction: dynamic ? SERVER_CONFIG.dynamicFriction : 1,
      restitution: dynamic ? SERVER_CONFIG.dynamicRestitution : 0,
      ...(isTrebuchetName(transform.name) ? {
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
      ...(isMissileName(transform.name) ? { loadedInto: null } : {}),
      ...(isKingName(transform.name) ? { hits: 0, maxHits: 3 } : {}),
    });
  }

  createPhysicsBodies();
}

export async function loadLevelIfPresent() {
  try {
    await fs.access(levelPath);
  } catch {
    console.log(`No GLB found at public/assets/${LEVEL_FILE}; starting with an empty scene.`);
    return;
  }

  await SceneLoader.AppendAsync(`http://localhost:${PORT}/assets/`, LEVEL_FILE, scene);
  applyTrebuchetArmRestPose();
  registerMeshRoots();
  console.log(`Loaded ${LEVEL_FILE} with ${gameObjects.size} gameplay objects.`);
  for (const object of gameObjects.values()) {
    console.log(
      `Object ${object.id}: dynamic=${object.dynamic} pos=(${object.x.toFixed(2)}, ${object.y.toFixed(2)}, ${object.z.toFixed(2)}) half=(${object.halfX.toFixed(2)}, ${object.halfY.toFixed(2)}, ${object.halfZ.toFixed(2)}) offset=(${object.offsetX.toFixed(2)}, ${object.offsetY.toFixed(2)}, ${object.offsetZ.toFixed(2)})`,
    );
  }
}
