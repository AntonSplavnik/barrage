const { SceneLoader } = BABYLON;

export async function appendLevelGlb(scene, levelUrl) {
  return SceneLoader.AppendAsync("", levelUrl, scene);
}

export async function loadFragmentTemplatesFromGlb({
  childRole,
  fragmentTemplateNodes,
  hitVisualTemplates,
  scene,
}) {
  for (const side of ["L", "R"]) {
    for (const node of fragmentTemplateNodes[side]) {
      if (!node.isDisposed()) node.dispose();
    }
    fragmentTemplateNodes[side] = [];
  }

  for (const [side, file] of [["L", "/assets/fragmented_blockL.glb"], ["R", "/assets/fragmented_blockR.glb"]]) {
    try {
      const existingIds = new Set(scene.meshes.map((m) => m.uniqueId));
      await SceneLoader.AppendAsync("", file, scene);
      const newMeshes = scene.meshes.filter((m) => !existingIds.has(m.uniqueId) && m.name !== "__root__");

      fragmentTemplateNodes[side] = [];
      hitVisualTemplates[side] = {};

      for (const mesh of newMeshes) {
        mesh.setEnabled(false);
        if (mesh.material) mesh.material.backFaceCulling = false;
        const role = childRole(mesh.name);
        if (role === "Vis") {
          const hitMatch = mesh.name.match(/hit(\d+)/i);
          if (hitMatch) {
            const n = parseInt(hitMatch[1], 10);
            hitVisualTemplates[side][n] = mesh;
          }
        } else {
          fragmentTemplateNodes[side].push(mesh);
        }
      }
    } catch (err) {
      console.warn(`Could not load fragment templates for ${side}:`, err);
    }
  }
}

export function registerVisualRootsFromGlb({
  childRole,
  descendantsOf,
  scene,
  visualBaseRotations,
  visualObjects,
}) {
  visualObjects.clear();
  visualBaseRotations.clear();

  const candidateRoots = [
    ...scene.transformNodes.filter((transform) => !transform.parent || transform.parent.name === "__root__"),
    ...scene.meshes.filter((mesh) => !mesh.parent || mesh.parent.name === "__root__"),
  ];
  const seenRootNames = new Set();

  for (const transform of candidateRoots) {
    if (transform.name === "__root__") continue;
    if (seenRootNames.has(transform.name)) continue;
    seenRootNames.add(transform.name);

    const descendants = descendantsOf(transform);
    const selfRole = childRole(transform.name);
    const visualChild = descendants.find((child) => {
      const role = childRole(child.name);
      return role === "Vis" || role === "ColVis";
    });
    const hasVisualRole = selfRole === "Vis" || selfRole === "ColVis" || Boolean(visualChild);

    if (!hasVisualRole) continue;

    for (const child of descendants) {
      if (childRole(child.name) === "Col" && child.setEnabled) {
        child.setEnabled(false);
      }
    }

    visualObjects.set(transform.name, transform);
    const baseRotation = transform.rotationQuaternion?.toEulerAngles() ?? transform.rotation;
    visualBaseRotations.set(transform.name, {
      x: baseRotation.x,
      y: baseRotation.y,
      z: baseRotation.z,
    });
  }
}

export function registerTrebuchetArmNodesFromGlb({
  findGameplayRoot,
  isTrebuchetArmRoot,
  scene,
  trebuchetArmNodes,
}) {
  trebuchetArmNodes.clear();

  for (const transform of scene.transformNodes) {
    if (!isTrebuchetArmRoot(transform)) continue;

    const root = findGameplayRoot(transform);
    if (!root) continue;

    trebuchetArmNodes.set(root.name, transform);
  }
}

export function registerTrebuchetLoadTargetsFromGlb({
  findGameplayRoot,
  findTrebuchetArmAncestor,
  scene,
  trebuchetLoadTargets,
}) {
  trebuchetLoadTargets.clear();

  for (const transform of scene.transformNodes) {
    if (!transform.name.toLowerCase().includes("missile-load-target")) continue;

    const root = findGameplayRoot(transform);
    if (!root) continue;

    trebuchetLoadTargets.set(root.name, {
      targetNode: transform,
      rootNode: root,
      armNode: findTrebuchetArmAncestor(transform),
    });
  }
}
