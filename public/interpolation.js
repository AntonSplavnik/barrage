/**
 * Snapshot interpolation for networked game objects.
 *
 * On each state message the server sends, call pushSnapshot().
 * Register applyInterpolatedPositions with scene.onBeforeRenderObservable
 * so every render frame lerps between the two bracketing snapshots.
 */
export function createInterpolator({
  config,
  visualObjects,
  visualBaseRotations,
  trebuchetArmNodes,
  protocolToBabylonRotation,
  degreesToRadians,
  armAngleSign,
  getPointerMode,
  getSelectedEntityId,
  updateAimArrow,
  updateDragPivotMarker,
}) {
  const snapshots = []; // { time: number, objects: Map<id, {x,y,z,rot,armAngle}> }

  function pushSnapshot(message) {
    const objects = new Map();
    for (const o of message.objects || []) {
      objects.set(o.id, { x: o.x, y: o.y, z: o.z, rot: o.rot, armAngle: o.armAngle });
    }
    snapshots.push({ time: performance.now(), objects });
    const max = config.interpolationBufferSize ?? 8;
    if (snapshots.length > max) snapshots.shift();
  }

  function applyInterpolatedPositions() {
    if (!snapshots.length) return;

    const renderTime = performance.now() - (config.interpolationDelayMs ?? 50);

    let s0 = snapshots[0];
    let s1 = snapshots[0];
    for (let i = 0; i < snapshots.length; i++) {
      if (snapshots[i].time <= renderTime) {
        s0 = snapshots[i];
        s1 = snapshots[i + 1] ?? snapshots[i];
      } else {
        break;
      }
    }

    const dt = s1.time - s0.time;
    const t = dt > 0 ? Math.max(0, Math.min(1, (renderTime - s0.time) / dt)) : 0;

    for (const [id, visual] of visualObjects) {
      const a = s0.objects.get(id);
      if (!a) continue;
      const b = s1.objects.get(id);
      const lf = b ? t : 0;
      const bObj = b ?? a;

      visual.position.x = a.x + (bObj.x - a.x) * lf;
      if (a.y != null) {
        visual.position.y = b?.y != null ? a.y + (b.y - a.y) * lf : a.y;
      }
      visual.position.z = a.z + (bObj.z - a.z) * lf;

      visual.rotationQuaternion = null;
      let dRot = (bObj.rot ?? 0) - (a.rot ?? 0);
      if (dRot >  180) dRot -= 360;
      if (dRot < -180) dRot += 360;
      const interpRot = (a.rot ?? 0) + dRot * lf;

      const baseRot = visualBaseRotations.get(id);
      if (baseRot) {
        visual.rotation.x = baseRot.x;
        visual.rotation.y = baseRot.y;
        visual.rotation.z = baseRot.z + protocolToBabylonRotation(interpRot);
      } else {
        visual.rotation.z = protocolToBabylonRotation(interpRot);
      }

      const arm = trebuchetArmNodes.get(id);
      if (arm && a.armAngle != null) {
        arm.rotationQuaternion = null;
        const armB = bObj.armAngle ?? a.armAngle;
        arm.rotation.z = armAngleSign(id) * degreesToRadians(a.armAngle + (armB - a.armAngle) * lf);
        arm.computeWorldMatrix(true);
      }
    }

    if (getPointerMode() === "aim" && getSelectedEntityId()) updateAimArrow();
    updateDragPivotMarker();
  }

  return { pushSnapshot, applyInterpolatedPositions };
}
