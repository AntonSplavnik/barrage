import { BARRAGE_CONFIG } from "./config.js";

const CONFIG = BARRAGE_CONFIG;
const { Color3, MeshBuilder, StandardMaterial, Vector3 } = BABYLON;

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

export function createVfxManager(scene) {
  const activeBursts = new Set();
  const fragmentMaterial = new StandardMaterial("VfxGreyFragmentMaterial", scene);
  fragmentMaterial.diffuseColor = new Color3(0.35, 0.35, 0.34);
  fragmentMaterial.emissiveColor = new Color3(0.18, 0.18, 0.17);
  fragmentMaterial.specularColor = Color3.Black();

  function spawnMissileCrackBlock(position) {
    const count = CONFIG.vfxMissileCrackBlockCount ?? 10;
    const durationMs = CONFIG.vfxMissileCrackBlockDurationMs ?? 450;
    const speed = CONFIG.vfxMissileCrackBlockSpeed ?? 3.2;
    const gravity = CONFIG.vfxMissileCrackBlockGravity ?? -7.5;
    const size = CONFIG.vfxMissileCrackBlockSize ?? 0.08;
    const startTime = performance.now();
    const origin = new Vector3(position.x ?? 0, position.y ?? 0, position.z ?? 0);
    const fragments = [];

    for (let i = 0; i < count; i += 1) {
      const mesh = MeshBuilder.CreateBox("vfx-missile-crack-block-fragment", { size: randomBetween(size * 0.6, size * 1.3) }, scene);
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
          randomBetween(0.4, 1.2),
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

    activeBursts.add(observer);
  }

  function handleEvent(ev) {
    if (ev.kind !== "soundEffect" || ev.effect !== "missile_crack_block") return;
    spawnMissileCrackBlock({ x: ev.x, y: ev.y, z: ev.z });
  }

  function dispose() {
    for (const observer of activeBursts) {
      scene.onBeforeRenderObservable.remove(observer);
    }
    activeBursts.clear();
  }

  return {
    dispose,
    handleEvent,
  };
}
