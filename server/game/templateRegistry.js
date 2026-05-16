import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import xhr2 from "xhr2";
import { Vector3, Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader.js";
import "@babylonjs/loaders/glTF/index.js";
import { scene } from "./physics.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { PORT, getConfig } from "../config.js";

const { XMLHttpRequest } = xhr2;
globalThis.XMLHttpRequest = XMLHttpRequest;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.join(__dirname, "../../public/assets/templates");

const templateCache = new Map();
let allPaths = [];

function childRole(name) {
  if (name.includes("Frag")) return "Frag";
  if (name.includes("ColVis")) return "ColVis";
  if (name.includes("Visual") || name.includes("Vis")) return "Vis";
  if (name.includes("Collider") || name.includes("Col")) return "Col";
  return null;
}

function descendantsOf(transform) {
  const result = [];
  const stack = [...transform.getChildren()];
  while (stack.length > 0) {
    const child = stack.pop();
    result.push(child);
    if (typeof child.getChildren === "function") {
      stack.push(...child.getChildren());
    }
  }
  return result;
}

function isTrebuchetArmNode(transform) {
  const lower = transform.name.toLowerCase();
  if (!lower.includes("arm")) return false;
  if (lower.includes("visual") || lower.includes("collider") || lower.includes("col")) return false;
  if (!transform.parent) return false;
  return descendantsOf(transform).some((c) => c.name.toLowerCase().includes("missile-load-target"));
}

function isArmDescendant(root, node) {
  let current = node.parent;
  while (current && current !== root) {
    if (isTrebuchetArmNode(current)) return true;
    current = current.parent;
  }
  return false;
}

function boundsForNodes(nodes) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const node of nodes) {
    const bounds = typeof node.getHierarchyBoundingVectors === "function"
      ? node.getHierarchyBoundingVectors(true)
      : node.getBoundingInfo?.().boundingBox;
    if (!bounds) continue;
    const min = bounds.min ?? bounds.minimumWorld;
    const max = bounds.max ?? bounds.maximumWorld;
    minX = Math.min(minX, min.x);
    minY = Math.min(minY, min.y);
    minZ = Math.min(minZ, min.z);
    maxX = Math.max(maxX, max.x);
    maxY = Math.max(maxY, max.y);
    maxZ = Math.max(maxZ, max.z);
  }
  if (!Number.isFinite(minX)) throw new Error("No bounds");
  return { min: new Vector3(minX, minY, minZ), max: new Vector3(maxX, maxY, maxZ) };
}

function colliderBoundsFor(root) {
  try {
    const descendants = descendantsOf(root);
    const colliderNodes = descendants.filter((child) => {
      const role = childRole(child.name);
      return (role === "Col" || role === "ColVis") && !isArmDescendant(root, child);
    });
    const bounds = boundsForNodes(colliderNodes.length > 0 ? colliderNodes : [root]);
    const position = root.getAbsolutePosition();
    const centerX = (bounds.min.x + bounds.max.x) / 2;
    const centerY = (bounds.min.y + bounds.max.y) / 2;
    const centerZ = (bounds.min.z + bounds.max.z) / 2;
    return {
      offsetX: centerX - position.x,
      offsetY: centerY - position.y,
      offsetZ: centerZ - position.z,
      halfX: Math.max(0.05, (bounds.max.x - bounds.min.x) / 2),
      halfY: Math.max(0.05, (bounds.max.y - bounds.min.y) / 2),
      halfZ: Math.max(0.05, (bounds.max.z - bounds.min.z) / 2),
    };
  } catch {
    return { offsetX: 0, offsetY: 0, offsetZ: 0, halfX: 0.5, halfY: 0.5, halfZ: 0.5 };
  }
}

function extractConvexPositions(root) {
  const descendants = descendantsOf(root);
  const colliderMeshes = descendants.filter((child) => {
    const role = childRole(child.name);
    return (role === "Col" || role === "ColVis")
      && typeof child.getVerticesData === "function"
      && child.getTotalVertices?.() > 0;
  });

  const fallbackNodes = [root, ...descendants].filter(
    (node) => typeof node.getVerticesData === "function" && node.getTotalVertices?.() > 0,
  );
  const meshes = colliderMeshes.length > 0 ? colliderMeshes : fallbackNodes;
  if (meshes.length === 0) return null;

  root.computeWorldMatrix(true);
  const rootWorldInverse = root.getWorldMatrix().clone().invert();
  const allPositions = [];

  for (const mesh of meshes) {
    mesh.computeWorldMatrix(true);
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!positions) continue;

    const localMatrix = mesh.getWorldMatrix().multiply(rootWorldInverse);

    for (let i = 0; i < positions.length; i += 3) {
      const v = Vector3.TransformCoordinates(
        new Vector3(positions[i], positions[i + 1], positions[i + 2]),
        localMatrix,
      );
      allPositions.push(v.x, v.y, v.z);
    }
  }

  return allPositions.length > 0 ? new Float32Array(allPositions) : null;
}

function detectHitStages(root) {
  const descendants = descendantsOf(root);
  const hitPattern = /hit(\d+)-Visual/;
  const stages = [];

  for (const child of descendants) {
    const match = child.name.match(hitPattern);
    if (match) {
      stages.push({ index: parseInt(match[1], 10), name: child.name });
    }
  }

  stages.sort((a, b) => a.index - b.index);
  return stages.map((s) => s.name);
}

function detectFragments(root) {
  const descendants = descendantsOf(root);
  const fragPattern = /Frag\.(\d+)/;
  const pieces = [];

  for (const child of descendants) {
    const match = child.name.match(fragPattern);
    if (!match) continue;

    const pieceNum = parseInt(match[1], 10);
    child.computeWorldMatrix(true);

    const localPos = child.getAbsolutePosition().subtract(root.getAbsolutePosition());
    const bounds = colliderBoundsFor(child);
    const convexPositions = extractConvexPositions(child);

    pieces.push({
      pieceNum,
      pieceIndex: 0,
      localX: localPos.x,
      localY: localPos.y,
      localZ: localPos.z,
      halfX: bounds.halfX,
      halfY: bounds.halfY,
      halfZ: bounds.halfZ,
      offsetX: bounds.offsetX,
      offsetY: bounds.offsetY,
      offsetZ: bounds.offsetZ,
      convexPositions,
    });
  }

  pieces.sort((a, b) => a.pieceNum - b.pieceNum);
  pieces.forEach((p, i) => { p.pieceIndex = i; });
  return pieces;
}

function extractTrebuchetNodes(root) {
  const descendants = descendantsOf(root);
  let armNode = null;
  let targetNode = null;

  for (const node of descendants) {
    if (!armNode && isTrebuchetArmNode(node)) armNode = node;
    if (!targetNode && node.name.toLowerCase().includes("missile-load-target")) targetNode = node;
  }

  if (!targetNode) return null;

  const restDegrees = getConfig("trebuchetArmRestRotationZDegrees");
  if (armNode) {
    armNode.rotationQuaternion = null;
    armNode.rotation.z = (restDegrees * Math.PI) / 180;
  }
  root.computeWorldMatrix(true);
  armNode?.computeWorldMatrix(true);
  targetNode.computeWorldMatrix(true);

  const targetPos = targetNode.getAbsolutePosition();
  const rootPos = root.getAbsolutePosition();

  return {
    rootNode: root,
    armNode,
    targetNode,
    loadTargetOffsetX: -(targetPos.x - rootPos.x),
    loadTargetOffsetY: targetPos.y - rootPos.y,
    loadTargetOffsetZ: targetPos.z - rootPos.z,
  };
}

async function discoverPaths() {
  const result = [];
  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), childPrefix);
      } else if (entry.name.endsWith(".glb")) {
        result.push(childPrefix.replace(".glb", ""));
      }
    }
  }
  await walk(templatesDir, "");
  return result;
}

export async function initTemplateRegistry() {
  allPaths = await discoverPaths();
  if (allPaths.length === 0) {
    console.log("No template GLBs found in public/assets/templates/");
    return;
  }

  const baseUrl = `http://localhost:${PORT}/assets/templates/`;

  for (const templatePath of allPaths) {
    const before = new Set(scene.rootNodes);
    await SceneLoader.AppendAsync(baseUrl, `${templatePath}.glb`, scene);
    const newRoot = scene.rootNodes.find((n) => !before.has(n));
    newRoot.name = `__template_${templatePath}__`;

    const bounds = colliderBoundsFor(newRoot);
    const convexPositions = extractConvexPositions(newRoot);
    const isTrebuchet = templatePath.startsWith("trebuchets/");
    const trebuchetNodes = isTrebuchet ? extractTrebuchetNodes(newRoot) : null;

    const hitStages = detectHitStages(newRoot);
    const fragments = detectFragments(newRoot);
    const isDestructible = hitStages.length > 0 || fragments.length > 0;

    templateCache.set(templatePath, {
      bounds,
      convexPositions,
      ...(isDestructible ? { hitStages, fragments } : {}),
      ...(trebuchetNodes ?? {}),
    });

    console.log(
      `Template "${templatePath}": half=(${bounds.halfX.toFixed(2)}, ${bounds.halfY.toFixed(2)}, ${bounds.halfZ.toFixed(2)})`
      + (convexPositions ? ` vertices=${convexPositions.length / 3}` : "")
      + (hitStages.length > 0 ? ` hitStages=${hitStages.length}` : "")
      + (fragments.length > 0 ? ` fragments=${fragments.length}` : ""),
    );
  }

  console.log(`Loaded ${templateCache.size} template(s).`);
}

export function getTemplate(templatePath) {
  return templateCache.get(templatePath);
}

export function getAllPaths() {
  return allPaths;
}
