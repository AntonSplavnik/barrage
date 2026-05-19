const { TrailMesh, StandardMaterial, Color3 } = BABYLON;

export function createMissileTrailEffect(scene, sharedTextures, config) {
  const activeTrails = new Map();

  const trailMat = new StandardMaterial("vfx_trailMat", scene);
  trailMat.diffuseColor = Color3.Black();
  trailMat.emissiveColor = new Color3(0.75, 0.75, 0.75);
  trailMat.specularColor = Color3.Black();
  trailMat.alpha = 0.35;
  trailMat.backFaceCulling = false;

  function attachTrail(mesh) {
    if (activeTrails.has(mesh.uniqueId)) return;
    const cfg = config.trail;
    if (!cfg.enabled) return;

    const trail = new TrailMesh("vfx_trail", mesh, scene, cfg.width, cfg.length, true);
    trail.material = trailMat;
    trail.renderingGroupId = 2;
    activeTrails.set(mesh.uniqueId, trail);
  }

  function detachTrail(mesh) {
    const trail = activeTrails.get(mesh.uniqueId);
    if (!trail) return;
    activeTrails.delete(mesh.uniqueId);
    trail.dispose();
  }

  function syncTrails(missileIds, visualObjects) {
    if (!config.trail.enabled) {
      if (activeTrails.size > 0) clear();
      return;
    }

    const currentMissileSet = new Set(missileIds);

    for (const [meshId, trail] of activeTrails) {
      let found = false;
      for (const id of currentMissileSet) {
        const mesh = visualObjects.get(id);
        if (mesh && mesh.uniqueId === meshId) {
          found = true;
          break;
        }
      }
      if (!found) {
        activeTrails.delete(meshId);
        trail.dispose();
      }
    }

    for (const id of missileIds) {
      const mesh = visualObjects.get(id);
      if (mesh && !activeTrails.has(mesh.uniqueId)) {
        attachTrail(mesh);
      }
    }
  }

  function clear() {
    for (const trail of activeTrails.values()) {
      trail.dispose();
    }
    activeTrails.clear();
  }

  function dispose() {
    clear();
    trailMat.dispose();
  }

  return { attachTrail, detachTrail, syncTrails, clear, dispose };
}
