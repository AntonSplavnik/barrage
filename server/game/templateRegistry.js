import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import xhr2 from "xhr2";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader.js";
import "@babylonjs/loaders/glTF/index.js";
import { scene } from "./physics.js";
import { PORT } from "../config.js";
import { BARRAGE_CONFIG } from "../../public/config.js";

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

function extractTrebuchetNodes(root) {
  const descendants = descendantsOf(root);
  let armNode = null;
  let targetNode = null;

  for (const node of descendants) {
    if (!armNode && isTrebuchetArmNode(node)) armNode = node;
    if (!targetNode && node.name.toLowerCase().includes("missile-load-target")) targetNode = node;
  }

  if (!targetNode) return null;

  const restDegrees = BARRAGE_CONFIG.trebuchetArmRestRotationZDegrees ?? 15;
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
    const isTrebuchet = templatePath.startsWith("trebuchets/");
    const trebuchetNodes = isTrebuchet ? extractTrebuchetNodes(newRoot) : null;

    templateCache.set(templatePath, {
      bounds,
      ...(trebuchetNodes ?? {}),
    });

    console.log(`Template "${templatePath}": half=(${bounds.halfX.toFixed(2)}, ${bounds.halfY.toFixed(2)}, ${bounds.halfZ.toFixed(2)})`);
  }

  console.log(`Loaded ${templateCache.size} template(s).`);
}

export function getTemplate(templatePath) {
  return templateCache.get(templatePath);
}

export function getAllPaths() {
  return allPaths;
}
