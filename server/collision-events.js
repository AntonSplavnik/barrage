import { PhysicsEventType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";

export function collisionPointFor(object, other) {
  return {
    x: ((object.x ?? 0) + (other.x ?? 0)) / 2,
    y: ((object.y ?? 0) + (other.y ?? 0)) / 2,
    z: ((object.z ?? 0) + (other.z ?? 0)) / 2,
  };
}

function bodyObjectId(body) {
  return body?.transformNode?.metadata?.gameObjectId ?? null;
}

function vectorToPlain(vector) {
  if (!vector) return null;
  return {
    x: Number(vector.x ?? 0),
    y: Number(vector.y ?? 0),
    z: Number(vector.z ?? 0),
  };
}

export function createPhysicsContactRecorder({ getPhysicsContactEvents, getTick }) {
  return function recordPhysicsContactEvent(event) {
    const physicsContactEvents = getPhysicsContactEvents?.();
    if (!physicsContactEvents) return;
    if (event.type !== PhysicsEventType.COLLISION_STARTED) return;

    const objectId = bodyObjectId(event.collider);
    const otherId = bodyObjectId(event.collidedAgainst);
    if (!objectId || !otherId || objectId === otherId) return;

    physicsContactEvents.push({
      tick: getTick?.() ?? 0,
      type: event.type,
      objectId,
      otherId,
      point: vectorToPlain(event.point),
      normal: vectorToPlain(event.normal),
      impulse: Number(event.impulse ?? 0),
      distance: Number(event.distance ?? 0),
    });
  };
}

function contactPositionFor(contact, object, other) {
  return contact.point ?? collisionPointFor(object, other);
}

function objectPairFromContact(gameObjects, contact) {
  const object = gameObjects.get(contact.objectId);
  const other = gameObjects.get(contact.otherId);
  return object && other ? [object, other] : null;
}

function handlePhysicsContact(contact, deps) {
  const pair = objectPairFromContact(deps.gameObjects, contact);
  if (!pair) return;

  const [object, other] = pair;
  const missile = deps.isMissileName(object.id) ? object : deps.isMissileName(other.id) ? other : null;
  const block = deps.isBlockName(object.id) ? object : deps.isBlockName(other.id) ? other : null;
  const king = deps.isKingName(object.id) ? object : deps.isKingName(other.id) ? other : null;
  const fragment = object.isFragment ? object : other.isFragment ? other : null;
  const trebuchet = deps.isTrebuchetName(object.id) ? object : deps.isTrebuchetName(other.id) ? other : null;
  const ground = deps.isGroundName(object.id) ? object : deps.isGroundName(other.id) ? other : null;

  if (ground && block) {
    deps.maybeBroadcastGroundImpactSound("block_hit_ground", block, ground, contactPositionFor(contact, block, ground));
    return;
  }

  if (ground && missile) {
    deps.maybeBroadcastGroundImpactSound("missile_hit_ground", missile, ground, contactPositionFor(contact, missile, ground));
    return;
  }

  if (missile && king) {
    deps.maybeRecordKingHit(missile, king, contactPositionFor(contact, missile, king));
    return;
  }

  if (missile && block) {
    const position = contactPositionFor(contact, missile, block);
    const speed = Math.hypot(missile.vx ?? 0, missile.vy ?? 0, missile.vz ?? 0);
    if (speed >= deps.blockHitVelocityMin) {
      deps.maybeRecordBlockHit(missile, block, position);
    } else {
      deps.maybeBroadcastObjectImpactSound("missile_hit_block", missile, block, deps.impactSpeedFor(missile, block), position);
    }
    return;
  }

  if (missile && fragment) {
    deps.maybeRecordFragmentHit(missile, fragment, contactPositionFor(contact, missile, fragment));
    return;
  }

  if (missile && trebuchet) {
    deps.maybeBroadcastObjectImpactSound(
      "missile_hit_trebuchet",
      missile,
      trebuchet,
      deps.impactSpeedFor(missile, trebuchet),
      contactPositionFor(contact, missile, trebuchet),
    );
    return;
  }

  if (deps.isMissileName(object.id) && deps.isMissileName(other.id)) {
    deps.maybeBroadcastObjectImpactSound(
      "missile_hit_missile",
      object,
      other,
      deps.impactSpeedFor(object, other),
      contactPositionFor(contact, object, other),
    );
    return;
  }

  if (block && deps.isBlockName(object.id) && deps.isBlockName(other.id)) {
    deps.maybeBroadcastObjectImpactSound(
      "block_hit_block",
      object,
      other,
      deps.impactSpeedFor(object, other),
      contactPositionFor(contact, object, other),
    );
  }
}

export function handlePhysicsContacts(contacts, deps) {
  const handledPairs = new Set();

  for (const contact of contacts ?? []) {
    const key = [contact.type, contact.objectId, contact.otherId].sort().join(":");
    if (handledPairs.has(key)) continue;
    handledPairs.add(key);
    handlePhysicsContact(contact, deps);
  }
}
