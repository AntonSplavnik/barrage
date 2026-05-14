import { BARRAGE_CONFIG } from "./config.js";

const CONFIG = BARRAGE_CONFIG;
const { Color3, Color4, DynamicTexture, Mesh, ParticleSystem, StandardMaterial, Vector3, VertexData } = BABYLON;
const MISSILE_BLOCK_VFX_EVENTS = new Set(["missile_hit_block", "missile_fragments_block"]);
const MISSILE_BOMB_HIT_EVENTS = new Set(["missile_bomb_hit"]);

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function vfxPositionFromEvent(ev) {
  return {
    x: (CONFIG.vfxInvertX ? -1 : 1) * Number(ev.x ?? 0),
    y: Number(ev.y ?? 0),
    z: Number(ev.z ?? 0),
  };
}

function impactFactorForEvent(ev) {
  const minSpeed = CONFIG.impactSoundVelocityMin ?? 1.5;
  const maxSpeed = Math.max(minSpeed, CONFIG.impactSoundVelocityMax ?? 24);
  if (maxSpeed === minSpeed) return 1;

  return Math.max(0, Math.min(1, (Number(ev.impactSpeed ?? 0) - minSpeed) / (maxSpeed - minSpeed)));
}

function createTetrahedron(name, size, scene) {
  const radius = size / 2;
  const positions = [
    radius, radius, radius,
    -radius, -radius, radius,
    -radius, radius, -radius,
    radius, -radius, -radius,
  ];
  const indices = [
    0, 1, 2,
    0, 3, 1,
    0, 2, 3,
    1, 3, 2,
  ];
  const mesh = new Mesh(name, scene);
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = indices;
  VertexData.ComputeNormals(positions, indices, vertexData.normals = []);
  vertexData.applyToMesh(mesh);
  return mesh;
}

function createExplosionTexture(scene) {
  const size = 64;
  const tex = new DynamicTexture("vfxExplosionTex", { width: size, height: size }, scene, false);
  tex.hasAlpha = true;
  const ctx = tex.getContext();
  const c = size / 2;
  const gradient = ctx.createRadialGradient(c, c, 0, c, c, c);
  gradient.addColorStop(0.0, "rgba(255,255,255,1.0)");
  gradient.addColorStop(0.2, "rgba(255,220,80,0.95)");
  gradient.addColorStop(0.5, "rgba(255,100,20,0.6)");
  gradient.addColorStop(1.0, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  tex.update();
  return tex;
}

export function createVfxManager(scene) {
  const activeBursts = new Map();
  const activeExplosions = new Set();
  const explosionTexture = createExplosionTexture(scene);
  const fragmentMaterial = new StandardMaterial("VfxGreyFragmentMaterial", scene);
  fragmentMaterial.diffuseColor = new Color3(0.35, 0.35, 0.34);
  fragmentMaterial.emissiveColor = new Color3(0.18, 0.18, 0.17);
  fragmentMaterial.specularColor = Color3.Black();

  function spawnMissileHitBlock(position, impactFactor = 1) {
    const scale = Math.max(CONFIG.vfxMissileHitBlockMinScale ?? 0.25, impactFactor);
    const maxCount = CONFIG.vfxMissileHitBlockCount ?? 10;
    const count = Math.max(1, Math.round(maxCount * scale));
    const durationMs = CONFIG.vfxMissileHitBlockDurationMs ?? 450;
    const speed = (CONFIG.vfxMissileHitBlockParticleSpeed ?? CONFIG.vfxMissileHitBlockSpeed ?? 3.2) * scale;
    const gravity = CONFIG.vfxMissileHitBlockGravity ?? -7.5;
    const size = (CONFIG.vfxMissileHitBlockSize ?? 0.08) * scale;
    const startTime = performance.now();
    const origin = new Vector3(position.x ?? 0, position.y ?? 0, 0);
    const fragments = [];

    for (let i = 0; i < count; i += 1) {
      const mesh = createTetrahedron("vfx-missile-hit-block-fragment", randomBetween(size * 0.6, size * 1.3), scene);
      const angle = randomBetween(0, Math.PI * 2);
      const burstSpeed = randomBetween(speed * 0.35, speed);
      mesh.position.copyFrom(origin);
      mesh.rotation.set(randomBetween(0, Math.PI), randomBetween(0, Math.PI), randomBetween(0, Math.PI));
      mesh.material = fragmentMaterial;
      mesh.isPickable = false;
      mesh.renderingGroupId = 2;
      mesh.alwaysSelectAsActiveMesh = true;
      fragments.push({
        mesh,
        velocity: new Vector3(
          Math.cos(angle) * burstSpeed,
          randomBetween(speed * 0.25, speed * 0.9),
          0,
        ),
        spin: new Vector3(randomBetween(-8, 8), randomBetween(-8, 8), randomBetween(-8, 8)),
      });
    }

    const observer = scene.onBeforeRenderObservable.add(() => {
      const elapsed = performance.now() - startTime;
      const t = Math.min(1, elapsed / durationMs);
      const dt = scene.getEngine().getDeltaTime() / 1000;

      for (const fragment of fragments) {
        fragment.velocity.y += gravity * dt;
        fragment.mesh.position.addInPlace(fragment.velocity.scale(dt));
        fragment.mesh.rotation.x += fragment.spin.x * dt;
        fragment.mesh.rotation.y += fragment.spin.y * dt;
        fragment.mesh.rotation.z += fragment.spin.z * dt;
        fragment.mesh.scaling.setAll(1 - t);
      }

      if (t >= 1) {
        scene.onBeforeRenderObservable.remove(observer);
        activeBursts.delete(observer);
        for (const fragment of fragments) {
          fragment.mesh.dispose();
        }
      }
    });

    activeBursts.set(observer, fragments);
  }

  function spawnMissileExplode(position) {
    const origin = new Vector3(position.x ?? 0, position.y ?? 0, 0);
    const blastRadius = CONFIG.missileBombBlastRadius ?? 5;
    const count = CONFIG.vfxMissileBombExplodeCount ?? 60;
    const lifetimeSec = (CONFIG.vfxMissileBombExplodeDurationMs ?? 500) / 1000;
    const speed = CONFIG.vfxMissileBombExplodeSpeed ?? 14;
    const size = CONFIG.vfxMissileBombExplodeSize ?? 1.8;

    const ps = new ParticleSystem("vfxMissileExplode", count, scene);
    ps.particleTexture = explosionTexture;
    ps.emitter = origin.clone();
    ps.createSphereEmitter(blastRadius * 0.06, 1);

    ps.color1 = new Color4(1, 0.95, 0.4, 1);
    ps.color2 = new Color4(1, 0.5, 0.1, 1);
    ps.colorDead = new Color4(0.3, 0.1, 0.0, 0);

    ps.minSize = size * 0.3;
    ps.maxSize = size;
    ps.minLifeTime = lifetimeSec * 0.4;
    ps.maxLifeTime = lifetimeSec;
    ps.minEmitPower = speed * 0.3;
    ps.maxEmitPower = speed;

    ps.gravity = new Vector3(0, CONFIG.vfxMissileBombExplodeGravity ?? -4, 0);
    ps.minAngularSpeed = 0;
    ps.maxAngularSpeed = Math.PI;
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.renderingGroupId = 2;

    ps.emitRate = count / 0.05;
    ps.targetStopDuration = 0.05;

    activeExplosions.add(ps);
    ps.onStoppedObservable.addOnce(() => {
      setTimeout(() => {
        if (!ps.isDisposed()) ps.dispose(false);
        activeExplosions.delete(ps);
      }, lifetimeSec * 1000 + 100);
    });

    ps.start();
    spawnMissileHitBlock(position, 1);
  }

  function handleEvent(ev) {
    if (ev.kind !== "soundEffect") return;
    if (MISSILE_BLOCK_VFX_EVENTS.has(ev.effect)) {
      spawnMissileHitBlock(vfxPositionFromEvent(ev), impactFactorForEvent(ev));
    }
    if (MISSILE_BOMB_HIT_EVENTS.has(ev.effect)) {
      spawnMissileExplode(vfxPositionFromEvent(ev));
    }
  }

  function clearEffects() {
    for (const [observer, fragments] of activeBursts) {
      scene.onBeforeRenderObservable.remove(observer);
      for (const fragment of fragments) {
        if (!fragment.mesh.isDisposed()) fragment.mesh.dispose();
      }
    }
    activeBursts.clear();
    for (const ps of activeExplosions) {
      if (!ps.isDisposed()) ps.dispose(false);
    }
    activeExplosions.clear();
  }

  function dispose() {
    clearEffects();
    explosionTexture.dispose();
  }

  return {
    clearEffects,
    dispose,
    handleEvent,
  };
}
