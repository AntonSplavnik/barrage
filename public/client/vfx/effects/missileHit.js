const { Vector3, VertexData, Mesh } = BABYLON;

export function createMissileHitEffect(scene, sharedTextures, config, _deps) {
  const activeBursts = new Map();
  let nextBurstId = 0;

  function spawn(position, evt) {
    const impactFactor = computeImpactFactor(evt.speed, config);
    const scale = Math.max(config.missileHit.minScale, impactFactor);
    const count = Math.max(1, Math.round(config.missileHit.count * scale));
    const burstSpeed = config.missileHit.speed * scale;
    const fragSize = config.missileHit.size * scale;

    const meshes = [];
    const fragments = [];

    for (let i = 0; i < count; i++) {
      const mesh = createTetrahedron(scene, fragSize, sharedTextures.fragmentMaterial);
      mesh.position.copyFrom(position);

      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.6;
      const sp = burstSpeed * (0.5 + Math.random() * 0.5);
      const vx = Math.sin(phi) * Math.cos(theta) * sp;
      const vy = Math.abs(Math.sin(phi) * Math.sin(theta) * sp);
      const vz = Math.cos(phi) * sp * 0.3;

      fragments.push({
        mesh,
        vx, vy, vz,
        spinX: (Math.random() - 0.5) * 10,
        spinY: (Math.random() - 0.5) * 10,
        spinZ: (Math.random() - 0.5) * 10,
      });
      meshes.push(mesh);
    }

    const startTime = performance.now();
    const durationMs = config.missileHit.durationMs;
    const gravity = config.missileHit.gravity;
    const burstId = nextBurstId++;

    const observer = scene.onBeforeRenderObservable.add(() => {
      const dt = (scene.deltaTime ?? 16) / 1000;
      const elapsed = performance.now() - startTime;
      const t = Math.min(elapsed / durationMs, 1);

      for (const frag of fragments) {
        frag.vy += gravity * dt;
        frag.mesh.position.x += frag.vx * dt;
        frag.mesh.position.y += frag.vy * dt;
        frag.mesh.position.z += frag.vz * dt;
        frag.mesh.rotation.x += frag.spinX * dt;
        frag.mesh.rotation.y += frag.spinY * dt;
        frag.mesh.rotation.z += frag.spinZ * dt;
        const s = 1 - t;
        frag.mesh.scaling.setAll(s);
      }

      if (t >= 1) {
        disposeBurst(burstId);
      }
    });

    activeBursts.set(burstId, { observer, meshes });
  }

  function disposeBurst(burstId) {
    const burst = activeBursts.get(burstId);
    if (!burst) return;
    scene.onBeforeRenderObservable.remove(burst.observer);
    for (const mesh of burst.meshes) {
      mesh.dispose(false, false);
    }
    activeBursts.delete(burstId);
  }

  function clear() {
    for (const burstId of [...activeBursts.keys()]) {
      disposeBurst(burstId);
    }
  }

  function dispose() {
    clear();
  }

  return { spawn, clear, dispose };
}

function computeImpactFactor(speed, config) {
  if (speed == null) return 1;
  const clamped = Math.max(config.impactSpeedMin, Math.min(speed, config.impactSpeedMax));
  return (clamped - config.impactSpeedMin) / (config.impactSpeedMax - config.impactSpeedMin);
}

function createTetrahedron(scene, size, material) {
  const h = size;
  const r = size * 0.6;
  const positions = [
    0, h, 0,
    r, -h * 0.3, 0,
    -r * 0.5, -h * 0.3, r * 0.87,
    -r * 0.5, -h * 0.3, -r * 0.87,
  ];
  const indices = [
    0, 1, 2,
    0, 2, 3,
    0, 3, 1,
    1, 3, 2,
  ];
  const normals = [];
  VertexData.ComputeNormals(positions, indices, normals);

  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = indices;
  vertexData.normals = normals;

  const mesh = new Mesh("vfx_tetra", scene);
  vertexData.applyToMesh(mesh);
  mesh.material = material;
  mesh.isPickable = false;
  return mesh;
}
