import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader.js";
import "@babylonjs/loaders/glTF/index.js";

function defaultChildRole(name) {
  if (name.includes("ColVis")) return "ColVis";
  if (name.includes("Visual") || name.includes("Vis")) return "Vis";
  if (name.includes("Collider") || name.includes("Col")) return "Col";
  return null;
}

function defaultDescendantsOf(transform) {
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

export function parseFragmentGlb(buffer, { childRole = defaultChildRole } = {}) {
  if (buffer.readUInt32LE(0) !== 0x46546C67) throw new Error("Not a GLB file");

  const jsonChunkLen = buffer.readUInt32LE(12);
  const gltf = JSON.parse(buffer.subarray(20, 20 + jsonChunkLen).toString("utf8"));

  const binStart = (20 + jsonChunkLen + 3) & ~3;
  const binData = buffer.subarray(binStart + 8);

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
      positions[i * 3] = binData.readFloatLE(off);
      positions[i * 3 + 1] = binData.readFloatLE(off + 4);
      positions[i * 3 + 2] = binData.readFloatLE(off + 8);
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

export async function appendServerLevelGlb({ levelFile, port, scene }) {
  return SceneLoader.AppendAsync(`http://localhost:${port}/assets/`, levelFile, scene);
}

export function extractConvexPositions(rootTransform, {
  childRole = defaultChildRole,
  descendantsOf = defaultDescendantsOf,
} = {}) {
  rootTransform.computeWorldMatrix(true);
  const invRootWorld = rootTransform.getWorldMatrix().clone().invert();

  const all = [];
  const colliders = descendantsOf(rootTransform).filter((d) => {
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
