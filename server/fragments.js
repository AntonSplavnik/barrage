import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate.js";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import { collisionPointFor } from "./collision-events.js";
import { impactPositionFor, impactSpeedFor } from "./server-events.js";
import { isBlockName, isMissileName, rotationQuaternionForObject } from "./utils.js";

export function createFragmentSystem({
  assetsDir,
  broadcast,
  broadcastImpactSoundEffect,
  config,
  disposePhysicsAggregate,
  fs,
  gameObjects,
  getActiveRoom,
  getScene,
  getTick,
  path,
  physicsAggregates,
  parseFragmentGlb,
  registerPhysicsAggregate,
  serverConfig,
  teleportPhysicsBody,
  tickMs,
}) {
  let fragmentTemplateData = null;

  async function loadFragmentTemplates() {
    if (fragmentTemplateData !== null) return;

    fragmentTemplateData = {};
    for (const [side, file] of [["L", "fragmented_blockL.glb"], ["R", "fragmented_blockR.glb"]]) {
      const fragPath = path.join(assetsDir, file);
      try {
        const glbBuffer = await fs.readFile(fragPath);
        fragmentTemplateData[side] = parseFragmentGlb(glbBuffer);
        console.log(`Loaded ${fragmentTemplateData[side].length} fragment templates from ${file}.`);
      } catch (err) {
        console.warn(`Could not load ${file}: ${err.message}`);
        fragmentTemplateData[side] = [];
      }
    }
  }

  function fragmentBlock(block, missile) {
    if (!fragmentTemplateData) return;
    const scene = getScene();
    const tick = getTick();
    const activeRoom = getActiveRoom();
    const side = block.id.toLowerCase().includes("blockl") ? "L" : "R";
    const fragmentTemplates = fragmentTemplateData[side];
    if (!scene || !activeRoom || !fragmentTemplates?.length) return;

    const rotRad = -(block.rot ?? 0) * Math.PI / 180;
    const cosR = Math.cos(rotRad);
    const sinR = Math.sin(rotRad);
    const fragIds = [];

    for (let i = 0; i < fragmentTemplates.length; i++) {
      const tmpl = fragmentTemplates[i];
      const fragId = `${block.id}_frag_${i}`;

      const worldX = block.x + tmpl.localX * cosR - tmpl.localY * sinR;
      const worldY = block.y + tmpl.localX * sinR + tmpl.localY * cosR;
      const worldZ = block.originZ;

      const spreadX = (Math.random() - 0.5) * (config.fragmentSpreadX ?? 4);
      const spreadY = Math.random() * (config.fragmentSpreadY ?? 2) + 0.5;
      const vx = (missile.vx ?? 0) * 0.5 + spreadX;
      const vy = (missile.vy ?? 0) * 0.3 + spreadY;

      const fragObj = {
        id: fragId,
        x: worldX,
        y: worldY,
        z: worldZ,
        originX: worldX,
        originY: worldY,
        originZ: worldZ,
        rot: block.rot ?? 0,
        vx,
        vy,
        vz: 0,
        angularVelocity: 0,
        dragVx: 0,
        dragVy: 0,
        dragVz: 0,
        dynamic: true,
        isFragment: true,
        parentBlockId: block.id,
        createdTick: tick,
        draggedBy: null,
        offsetX: tmpl.offsetX,
        offsetY: tmpl.offsetY,
        offsetZ: tmpl.offsetZ,
        halfX: tmpl.halfX,
        halfY: tmpl.halfY,
        halfZ: tmpl.halfZ,
        halfHeight: tmpl.halfY,
        mass: (config.blockMass ?? serverConfig.dynamicMass) / 8,
        friction: config.fragmentFriction ?? serverConfig.dynamicFriction,
        restitution: serverConfig.dynamicRestitution,
      };

      gameObjects().set(fragId, fragObj);

      const shapeOptions = {
        mass: serverConfig.dynamicMass,
        friction: serverConfig.dynamicFriction,
        restitution: serverConfig.dynamicRestitution,
      };

      let physNode;
      let shapeType;

      let usedConvex = false;
      if (tmpl.positions?.length > 0) {
        try {
          const hullMesh = new Mesh(`hull-${fragId}`, scene);
          const vd = new VertexData();
          vd.positions = tmpl.positions;
          const numVerts = tmpl.positions.length / 3;
          const indices = [];
          for (let j = 1; j < numVerts - 1; j++) indices.push(0, j, j + 1);
          vd.indices = indices;
          vd.applyToMesh(hullMesh, false);
          hullMesh.position.set(worldX, worldY, worldZ);
          hullMesh.rotationQuaternion = rotationQuaternionForObject(fragObj);
          hullMesh.computeWorldMatrix(true);
          physNode = hullMesh;
          shapeType = PhysicsShapeType.CONVEX_HULL;
          usedConvex = true;
        } catch (err) {
          console.warn(`Convex hull mesh creation failed for frag ${i}:`, err.message);
        }
      }
      if (!usedConvex) {
        physNode = new TransformNode(`physics-${fragId}`, scene);
        physNode.position.set(worldX, worldY, worldZ);
        physNode.rotationQuaternion = rotationQuaternionForObject(fragObj);
        shapeType = PhysicsShapeType.BOX;
        shapeOptions.center = new Vector3(tmpl.offsetX, tmpl.offsetY, tmpl.offsetZ);
        shapeOptions.extents = new Vector3(tmpl.halfX * 2, tmpl.halfY * 2, tmpl.halfZ * 2);
      }

      const aggregate = new PhysicsAggregate(physNode, shapeType, shapeOptions, scene);

      aggregate.body.disablePreStep = true;
      aggregate.body.setLinearDamping(0.15);
      aggregate.body.setAngularDamping(0.55);
      registerPhysicsAggregate(fragObj, aggregate);
      teleportPhysicsBody(aggregate);
      aggregate.body.setLinearVelocity(new Vector3(vx, vy, 0));
      aggregate.body.setAngularVelocity(new Vector3(0, 0, (Math.random() - 0.5) * 12));

      fragIds.push(fragId);
    }

    disposePhysicsAggregate(block.id);
    gameObjects().delete(block.id);

    broadcastImpactSoundEffect(
      "missile_fragments_block",
      block.pendingFragmentHitPosition ?? collisionPointFor(missile, block),
      impactSpeedFor(missile, block),
    );

    broadcast({
      type: "event",
      roomId: activeRoom.id,
      tick,
      events: [{ kind: "blockBroken", blockId: block.id, fragIds }],
    });
  }

  function maybeRecordBlockHit(object, other, hitPosition = null) {
    const activeRoom = getActiveRoom();
    const tick = getTick();
    const missile = isMissileName(object.id) ? object : isMissileName(other.id) ? other : null;
    const block = isBlockName(object.id) ? object : isBlockName(other.id) ? other : null;
    if (!missile || !block || missile.loadedInto || block.pendingFragment || activeRoom?.roundWinner) return;

    const speed = Math.hypot(missile.vx ?? 0, missile.vy ?? 0, missile.vz ?? 0);
    if (speed < (config.blockHitVelocityMin ?? 3)) return;

    missile.hitBlockIds ??= new Set();
    if (missile.hitBlockIds.has(block.id)) return;

    const cooldown = Math.ceil((config.blockHitCooldownMs ?? 0) / tickMs);
    if (cooldown > 0 && tick - (missile.lastBlockHitTick ?? -Infinity) < cooldown) return;

    missile.hitBlockIds.add(block.id);
    missile.lastBlockHitTick = tick;

    block.hits = (block.hits ?? 0) + 1;
    const fragSpeed = Math.hypot(missile.vx ?? 0, missile.vy ?? 0, missile.vz ?? 0);
    const willFragment = block.hits >= block.maxHits
      && !missile.usedToFragment
      && fragSpeed >= (config.blockFragmentVelocityMin ?? config.blockHitVelocityMin ?? 3);

    if (!willFragment) {
      broadcastImpactSoundEffect("missile_hit_block", hitPosition ?? collisionPointFor(missile, block), impactSpeedFor(missile, block));
    }

    broadcast({
      type: "event",
      roomId: activeRoom.id,
      tick,
      events: [{ kind: "blockHit", blockId: block.id, hits: block.hits, maxHits: block.maxHits }],
    });

    if (willFragment) {
      block.pendingFragment = missile;
      block.pendingFragmentHitPosition = hitPosition ?? collisionPointFor(missile, block);
      missile.usedToFragment = true;
    }
  }

  function maybeRecordFragmentHit(missile, fragment, hitPosition = null) {
    const tick = getTick();
    if (!isMissileName(missile.id) || missile.loadedInto || missile.draggedBy) return;
    if (!fragment.isFragment || fragment.pendingRemove) return;

    const speed = Math.hypot(missile.vx ?? 0, missile.vy ?? 0, missile.vz ?? 0);
    if (speed < (config.fragmentHitVelocityMin ?? config.blockHitVelocityMin ?? 3)) return;

    const immunityTicks = Math.ceil((config.fragmentImmunityMs ?? 0) / tickMs);
    if (immunityTicks > 0 && tick - (fragment.createdTick ?? 0) < immunityTicks) return;

    missile.hitFragIds ??= new Set();
    if (missile.hitFragIds.has(fragment.id)) return;
    missile.hitFragIds.add(fragment.id);

    const position = hitPosition ?? impactPositionFor(missile, fragment);
    fragment.hitImpactSpeed = impactSpeedFor(missile, fragment);
    fragment.hitImpactX = position.x;
    fragment.hitImpactY = position.y;
    fragment.hitImpactZ = position.z;
    fragment.pendingRemove = true;

    const penalty = config.fragmentHitSpeedPenalty ?? 0;
    if (penalty <= 0) return;

    const missileSpeed = Math.hypot(missile.vx ?? 0, missile.vy ?? 0);
    if (missileSpeed <= 0) return;

    const newSpeed = Math.max(0, missileSpeed - penalty);
    const scale = newSpeed / missileSpeed;
    missile.vx = (missile.vx ?? 0) * scale;
    missile.vy = (missile.vy ?? 0) * scale;
    const agg = physicsAggregates().get(missile.id);
    if (agg) agg.body.setLinearVelocity(new Vector3(missile.vx, missile.vy, 0));
  }

  return {
    fragmentBlock,
    loadFragmentTemplates,
    maybeRecordBlockHit,
    maybeRecordFragmentHit,
  };
}
