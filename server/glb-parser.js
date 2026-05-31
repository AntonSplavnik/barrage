import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader.js";
import "@babylonjs/loaders/glTF/index.js";
import {
  childRole as defaultChildRole,
  isTrebuchetArmName,
  isTrebuchetName,
} from "./utils.js";

export function descendantsOf(transform) {
  const descendants = [];
  const stack = [...transform.getChildren()];

  while (stack.length > 0) {
    const child = stack.pop();
    descendants.push(child);

    if (typeof child.getChildren === "function") {
      stack.push(...child.getChildren());
    }
  }

  return descendants;
}

export function isTrebuchetArmRoot(transform) {
  const lowerName = transform.name.toLowerCase();
  return isTrebuchetArmName(transform.name)
    && transform.parent
    && isTrebuchetName(transform.parent.name)
    && !lowerName.includes("visual")
    && !lowerName.includes("collider")
    && !lowerName.includes("col")
    && descendantsOf(transform).some((child) => child.name.toLowerCase().includes("missile-load-target"));
}

function isNestedTrebuchetArmDescendant(root, node) {
  let current = node.parent;

  while (current && current !== root) {
    if (isTrebuchetArmRoot(current)) return true;
    current = current.parent;
  }

  return false;
}

export function boundsForNodes(nodes) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

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

  if (!Number.isFinite(minX)) {
    throw new Error("No bounds");
  }

  return {
    min: new Vector3(minX, minY, minZ),
    max: new Vector3(maxX, maxY, maxZ),
  };
}

export function colliderBoundsFor(transform, { childRole = defaultChildRole } = {}) {
  try {
    const colliderNodes = descendantsOf(transform).filter((child) => {
      const role = childRole(child.name);
      return (role === "Col" || role === "ColVis")
        && !isNestedTrebuchetArmDescendant(transform, child);
    });
    const bounds = boundsForNodes(colliderNodes.length > 0 ? colliderNodes : [transform]);
    const absolutePosition = transform.getAbsolutePosition();
    const centerX = (bounds.min.x + bounds.max.x) / 2;
    const centerY = (bounds.min.y + bounds.max.y) / 2;
    const centerZ = (bounds.min.z + bounds.max.z) / 2;
    return {
      offsetX: centerX - absolutePosition.x,
      offsetY: centerY - absolutePosition.y,
      offsetZ: centerZ - absolutePosition.z,
      halfX: Math.max(0.05, (bounds.max.x - bounds.min.x) / 2),
      halfY: Math.max(0.05, (bounds.max.y - bounds.min.y) / 2),
      halfZ: Math.max(0.05, (bounds.max.z - bounds.min.z) / 2),
    };
  } catch {
    return {
      offsetX: 0,
      offsetY: 0,
      offsetZ: 0,
      halfX: 0.5,
      halfY: 0.5,
      halfZ: 0.5,
    };
  }
}

export function estimateHalfHeight(transform) {
  return colliderBoundsFor(transform).halfY;
}

export function findGameplayRootAncestor(node) {
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

export function findTrebuchetArmAncestor(node) {
  let current = node.parent;

  while (current) {
    if (isTrebuchetArmRoot(current)) {
      return current;
    }

    current = current.parent;
  }

  return null;
}

export function parseFragmentGlb(input, { childRole = defaultChildRole } = {}) {
  // Normalise to Uint8Array so this works in both Node.js (Buffer) and browser Workers (ArrayBuffer).
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (view.getUint32(0, true) !== 0x46546C67) throw new Error("Not a GLB file");

  const jsonChunkLen = view.getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonChunkLen)));

  const binStart = (20 + jsonChunkLen + 3) & ~3;
  const binData = bytes.subarray(binStart + 8);
  const binView = new DataView(binData.buffer, binData.byteOffset, binData.byteLength);

  const templates = [];

  for (const node of gltf.nodes ?? []) {
    if (node.mesh === undefined) continue;
    const mesh = gltf.meshes?.[node.mesh];
    const posAccIdx = mesh?.primitives?.[0]?.attributes?.POSITION;
    if (posAccIdx === undefined) continue;

    const nodeName = node.name ?? mesh.name ?? "";
    const role = childRole(nodeName);
    if (role !== "ColVis" && role !== "Col") continue;

    const accessor = gltf.accessors[posAccIdx];
    const bufView = gltf.bufferViews[accessor.bufferView];
    const byteOffset = (bufView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const count = accessor.count;
    const stride = bufView.byteStride ?? 12;

    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const off = byteOffset + i * stride;
      positions[i * 3] = binView.getFloat32(off, true);
      positions[i * 3 + 1] = binView.getFloat32(off + 4, true);
      positions[i * 3 + 2] = binView.getFloat32(off + 8, true);
    }

    const [lx = 0, ly = 0, lz = 0] = node.translation ?? [0, 0, 0];

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < count; i += 1) {
      minX = Math.min(minX, positions[i * 3]);
      maxX = Math.max(maxX, positions[i * 3]);
      minY = Math.min(minY, positions[i * 3 + 1]);
      maxY = Math.max(maxY, positions[i * 3 + 1]);
      minZ = Math.min(minZ, positions[i * 3 + 2]);
      maxZ = Math.max(maxZ, positions[i * 3 + 2]);
    }

    templates.push({
      localX: lx,
      localY: ly,
      localZ: lz,
      positions,
      offsetX: (minX + maxX) / 2,
      offsetY: (minY + maxY) / 2,
      offsetZ: (minZ + maxZ) / 2,
      halfX: Math.max(0.05, (maxX - minX) / 2),
      halfY: Math.max(0.05, (maxY - minY) / 2),
      halfZ: Math.max(0.05, (maxZ - minZ) / 2),
    });
  }

  return templates;
}

export async function appendServerLevelGlb({ levelFile, port, baseUrl, scene }) {
  const base = baseUrl ?? `http://localhost:${port}/assets/`;
  return SceneLoader.AppendAsync(base, levelFile, scene);
}

export function extractConvexPositions(rootTransform, {
  childRole = defaultChildRole,
  descendantsOf: getDescendants = descendantsOf,
} = {}) {
  rootTransform.computeWorldMatrix(true);
  const invRootWorld = rootTransform.getWorldMatrix().clone().invert();

  const all = [];
  const colliders = getDescendants(rootTransform).filter((d) => {
    const role = childRole(d.name);
    return (role === "Col" || role === "ColVis") && typeof d.getVerticesData === "function";
  });

  for (const mesh of colliders) {
    mesh.computeWorldMatrix(true);
    const raw = mesh.getVerticesData("position");
    if (!raw) continue;
    const meshWorld = mesh.getWorldMatrix();
    for (let i = 0; i < raw.length; i += 3) {
      const world = Vector3.TransformCoordinates(new Vector3(raw[i], raw[i + 1], raw[i + 2]), meshWorld);
      const local = Vector3.TransformCoordinates(world, invRootWorld);
      all.push(local.x, local.y, local.z);
    }
  }

  return all.length > 0 ? new Float32Array(all) : null;
}
