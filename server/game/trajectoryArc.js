const DAMPING_EPSILON = 1e-6;
const SIM_STEP = 1 / 60;

function dampedPosition(startPoint, velocity, gravity, damping, t) {
  if (!startPoint || !velocity || Number.isNaN(t)) {
    return { x: 0, y: 0, z: 0 };
  }

  if (Math.abs(damping) < DAMPING_EPSILON) {
    return {
      x: startPoint.x + velocity.x * t,
      y: startPoint.y + velocity.y * t + 0.5 * gravity * t * t,
      z: startPoint.z + velocity.z * t,
    };
  }

  const decay = Math.exp(-damping * t);
  const velScale = (1 - decay) / damping;
  const gravScale = (t - velScale) / damping;

  return {
    x: startPoint.x + velocity.x * velScale,
    y: startPoint.y + velocity.y * velScale + gravity * gravScale,
    z: startPoint.z + velocity.z * velScale,
  };
}

function dampedFlightDurationToGround(startPoint, velocity, gravity, damping, groundY, maxDuration) {
  if (!startPoint || !velocity) return 0;
  if (Number.isNaN(groundY) || Number.isNaN(maxDuration)) return 0;

  if (Math.abs(damping) < DAMPING_EPSILON) {
    const a = 0.5 * gravity;
    const b = velocity.y;
    const c = startPoint.y - groundY;

    if (Math.abs(a) < DAMPING_EPSILON) {
      return b < 0 ? Math.min(-c / b, maxDuration) : maxDuration;
    }

    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return maxDuration;

    const sqrtD = Math.sqrt(discriminant);
    const t1 = (-b + sqrtD) / (2 * a);
    const t2 = (-b - sqrtD) / (2 * a);

    let tHit = maxDuration;
    if (t1 > 0 && t1 < tHit) tHit = t1;
    if (t2 > 0 && t2 < tHit) tHit = t2;
    return Math.min(tHit, maxDuration);
  }

  let prevY = startPoint.y;
  for (let t = SIM_STEP; t <= maxDuration; t += SIM_STEP) {
    const pos = dampedPosition(startPoint, velocity, gravity, damping, t);
    if (pos.y <= groundY) {
      const prevT = t - SIM_STEP;
      const fraction = (prevY - groundY) / Math.max(0.0001, prevY - pos.y);
      return prevT + SIM_STEP * fraction;
    }
    prevY = pos.y;
  }

  return maxDuration;
}

export function computeArcPoints({ startPoint, velocity, gravity, damping, dotCount, arcFraction, maxDuration, groundY }) {
  if (!startPoint || !velocity) return [];
  if (Number.isNaN(gravity) || Number.isNaN(damping)) return [];

  const flightDuration = dampedFlightDurationToGround(startPoint, velocity, gravity, damping, groundY, maxDuration);
  const arcDuration = Math.min(flightDuration * arcFraction, maxDuration);
  if (arcDuration <= 0 || dotCount <= 0) return [];

  if (dotCount === 1) return [{ ...dampedPosition(startPoint, velocity, gravity, damping, 0) }];

  const points = [];
  for (let i = 0; i < dotCount; i++) {
    const t = (i / (dotCount - 1)) * arcDuration;
    points.push(dampedPosition(startPoint, velocity, gravity, damping, t));
  }

  return points;
}
