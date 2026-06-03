const { Color3, MeshBuilder, StandardMaterial, Vector3 } = BABYLON;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function flightDurationToGround(startPoint, velocity, gravity, groundY) {
  const a = 0.5 * gravity;
  const b = velocity.y;
  const c = startPoint.y - groundY;
  const discriminant = b * b - 4 * a * c;

  if (Math.abs(a) < 0.0001 || discriminant < 0) return 2;

  const sqrt = Math.sqrt(discriminant);
  const t1 = (-b - sqrt) / (2 * a);
  const t2 = (-b + sqrt) / (2 * a);
  return Math.max(0.1, t1, t2);
}

export function dampedPosition(startPoint, velocity, gravity, damping, t) {
  if (damping <= 0.0001) {
    return {
      x: startPoint.x + velocity.x * t,
      y: startPoint.y + velocity.y * t + 0.5 * gravity * t * t,
      z: startPoint.z + velocity.z * t,
    };
  }

  const decay = Math.exp(-damping * t);
  const velocityScale = (1 - decay) / damping;
  const gravityScale = (t / damping) - ((1 - decay) / (damping * damping));

  return {
    x: startPoint.x + velocity.x * velocityScale,
    y: startPoint.y + velocity.y * velocityScale + gravity * gravityScale,
    z: startPoint.z + velocity.z * velocityScale,
  };
}

export function dampedFlightDurationToGround(startPoint, velocity, gravity, damping, groundY, maxDuration) {
  if (damping <= 0.0001) {
    return flightDurationToGround(startPoint, velocity, gravity, groundY);
  }

  const step = 1 / 60;
  let previousT = 0;
  let previousY = startPoint.y;

  for (let t = step; t <= maxDuration; t += step) {
    const y = dampedPosition(startPoint, velocity, gravity, damping, t).y;
    if (previousY >= groundY && y <= groundY) {
      const alpha = (groundY - previousY) / Math.max(0.0001, y - previousY);
      return previousT + (t - previousT) * clamp(alpha, 0, 1);
    }
    previousT = t;
    previousY = y;
  }

  return maxDuration;
}

export function createTrebuchetShotArcPrediction(scene, config = {}) {
  const dotCount = Math.max(2, config.shotArcDotCount ?? 32);
  const dots = [];
  const outlineDots = [];
  let fadeObserver = null;
  const outlineMaterial = new StandardMaterial("TrebuchetShotArcOutlineMaterial", scene);
  outlineMaterial.diffuseColor = Color3.White();
  outlineMaterial.emissiveColor = Color3.White();
  outlineMaterial.specularColor = Color3.White();
  outlineMaterial.disableLighting = true;
  outlineMaterial.alpha = 1;

  const material = new StandardMaterial("TrebuchetShotArcMaterial", scene);
  const arcColor = Color3.Black();
  material.diffuseColor = arcColor;
  material.emissiveColor = arcColor;
  material.specularColor = arcColor;
  material.disableLighting = true;
  material.alpha = 1;

  for (let i = 0; i < dotCount; i += 1) {
    const outlineDot = MeshBuilder.CreateSphere("TrebuchetShotArcOutlineDot", {
      diameter: config.shotArcOutlineDotSize ?? ((config.shotArcDotSize ?? 5) * 1.5),
      segments: 8,
    }, scene);
    outlineDot.material = outlineMaterial;
    outlineDot.isPickable = false;
    outlineDot.renderingGroupId = 1;
    outlineDot.setEnabled(false);
    outlineDots.push(outlineDot);

    const dot = MeshBuilder.CreateSphere("TrebuchetShotArcDot", {
      diameter: config.shotArcDotSize ?? 1.92,
      segments: 8,
    }, scene);
    dot.material = material;
    dot.isPickable = false;
    dot.renderingGroupId = 2;
    dot.setEnabled(false);
    dots.push(dot);
  }

  function hide() {
    if (fadeObserver) {
      scene.onBeforeRenderObservable.remove(fadeObserver);
      fadeObserver = null;
    }
    material.alpha = 1;
    outlineMaterial.alpha = 1;
    for (const dot of dots) {
      dot.setEnabled(false);
    }
    for (const outlineDot of outlineDots) {
      outlineDot.setEnabled(false);
    }
  }

  function fadeOut(durationMs = config.shotArcFadeMs ?? config.shotArcPersistMs ?? 2500) {
    if (fadeObserver) {
      scene.onBeforeRenderObservable.remove(fadeObserver);
    }

    const startTime = performance.now();
    const duration = Math.max(1, durationMs);
    material.alpha = 1;
    outlineMaterial.alpha = 1;
    fadeObserver = scene.onBeforeRenderObservable.add(() => {
      const t = clamp((performance.now() - startTime) / duration, 0, 1);
      material.alpha = 1 - t;
      outlineMaterial.alpha = 1 - t;
      if (t >= 1) {
        scene.onBeforeRenderObservable.remove(fadeObserver);
        fadeObserver = null;
        hide();
      }
    });
  }

  function update({ startPoint, velocity }) {
    if (fadeObserver) {
      scene.onBeforeRenderObservable.remove(fadeObserver);
      fadeObserver = null;
    }
    material.alpha = 1;
    outlineMaterial.alpha = 1;

    if (!startPoint || !velocity) {
      hide();
      return;
    }

    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    if (speed < (config.shotArcVelocityMin ?? 0.5)) {
      hide();
      return;
    }

    const gravity = config.gravity ?? -9.81;
    const damping = Math.max(0, config.shotArcLinearDamping ?? config.missileLinearDamping ?? 0);
    const groundY = config.shotArcGroundY ?? 0;
    const arcFraction = clamp(config.shotArcFraction ?? (2 / 3), 0.05, 1);
    const duration = Math.min(
      config.shotArcMaxDuration ?? 4,
      dampedFlightDurationToGround(
        startPoint,
        velocity,
        gravity,
        damping,
        groundY,
        config.shotArcMaxDuration ?? 4,
      ) * arcFraction,
    );
    const zOffset = config.shotArcZOffset ?? 0.08;

    for (let i = 0; i < dots.length; i += 1) {
      const t = dots.length === 1 ? 0 : (i / (dots.length - 1)) * duration;
      const dot = dots[i];
      const outlineDot = outlineDots[i];
      const position = dampedPosition(startPoint, velocity, gravity, damping, t);
      outlineDot.position.set(position.x, position.y, position.z + zOffset);
      outlineDot.setEnabled(true);
      dot.position.set(position.x, position.y, position.z + zOffset);
      dot.setEnabled(true);
    }
  }

  function dispose() {
    if (fadeObserver) {
      scene.onBeforeRenderObservable.remove(fadeObserver);
      fadeObserver = null;
    }
    for (const dot of dots) {
      dot.dispose();
    }
    for (const outlineDot of outlineDots) {
      outlineDot.dispose();
    }
    material.dispose();
    outlineMaterial.dispose();
  }

  return {
    dispose,
    fadeOut,
    hide,
    update,
  };
}
