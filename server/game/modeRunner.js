// server/game/modeRunner.js
import {
  isKingName,
  restArmAngleForTrebuchet,
  ARM_STATE_IDLE,
} from "./entities.js";
import { gameObjects, gameState, dragState, destroyedBlocks } from "./state.js";
import { broadcast } from "../net/broadcast.js";
import { syncPhysicsBodyFromObject, setPhysicsBodyTrigger, physicsAggregates, createPhysicsBodyForObject } from "./physics.js";
import { shatterBlock } from "./fragmentation.js";
import { clearCollisionState } from "./collisions.js";
import { loadLevel } from "./levelRunner.js";

let activeMode = null;
let activeLevel = null;
let levelIndex = 0;
let roundEndInProgress = false;
let shuffledQueue = [];

export function getActiveLevel() {
  return activeLevel;
}

export function getHookContext() {
  return {
    spawn: activeLevel?.spawn ?? (() => {}),
    gameObjects,
    broadcast,
    gameState,
    activeMode,
    activeLevel,
    shatterBlock,
  };
}

export async function callHook(fn, ...args) {
  if (!fn) return;
  try {
    await fn(...args);
  } catch (error) {
    console.error("Hook error:", error);
  }
}

export function resetRoundState() {
  dragState.clear();

  clearCollisionState();

  for (const [id, obj] of gameObjects) {
    if (obj.isFragment) {
      physicsAggregates.get(id)?.dispose();
      physicsAggregates.delete(id);
      gameObjects.delete(id);
    }
  }

  for (const [id, saved] of destroyedBlocks) {
    gameObjects.set(id, saved);
    createPhysicsBodyForObject(saved);
  }
  destroyedBlocks.clear();

  for (const object of gameObjects.values()) {
    object.x = object.originX;
    object.y = object.originY;
    object.z = object.originZ;
    object.rot = object.originRot ?? 0;
    object.angularVelocity = 0;
    object.vx = 0;
    object.vy = 0;
    object.vz = 0;
    object.dragVx = 0;
    object.dragVy = 0;
    object.dragVz = 0;
    object.draggedBy = null;

    if (object.loaded !== undefined) object.loaded = false;
    if (object.loadedInto !== undefined) {
      object.loadedInto = null;
      setPhysicsBodyTrigger(object, false);
    }
    if (object.armAngle !== undefined) object.armAngle = restArmAngleForTrebuchet();
    if (object.fireState !== undefined) object.fireState = ARM_STATE_IDLE;
    if (object.loadedMissileId !== undefined) object.loadedMissileId = null;
    if (object.aimedBy !== undefined) object.aimedBy = null;
    if (object.aimStart !== undefined) object.aimStart = null;
    if (object.aimCurrent !== undefined) object.aimCurrent = null;
    if (object.pendingShot !== undefined) object.pendingShot = null;
    if (object.returnStartArmAngle !== undefined) object.returnStartArmAngle = null;
    if (object.releaseElapsedMs !== undefined) object.releaseElapsedMs = 0;

    if (object.hits !== undefined) {
      object.hits = 0;
    }

    if (object.hitStage !== undefined) {
      object.hitStage = 0;
    }

    syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
  }
}

function checkKingKnockout() {
  const threshold = activeMode?.kingKnockoutAngle ?? 45;
  for (const object of gameObjects.values()) {
    if (!isKingName(object.id)) continue;
    if (Math.abs(object.rot) < threshold) continue;
    const loserId = object.player === 1 ? "P1" : "P2";
    return { winner: loserId === "P1" ? "P2" : "P1", loser: loserId };
  }
  return null;
}

function evaluateWinCondition() {
  const wc = activeMode?.winCondition ?? "kingKnockout";
  if (typeof wc === "function") return wc(getHookContext());
  if (wc === "kingKnockout") return checkKingKnockout();
  return null;
}

function pickNextLevel() {
  if (activeMode.levelOrder === "random") {
    if (shuffledQueue.length === 0) {
      shuffledQueue = [...activeMode.levels];
      for (let i = shuffledQueue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledQueue[i], shuffledQueue[j]] = [shuffledQueue[j], shuffledQueue[i]];
      }
    }
    return shuffledQueue.shift();
  }

  levelIndex = (levelIndex + 1) % activeMode.levels.length;
  return activeMode.levels[levelIndex];
}

export async function startMode(modeDef) {
  if (!modeDef.levels?.length) {
    throw new Error(`Mode "${modeDef.name}" has no levels defined`);
  }

  activeMode = modeDef;
  levelIndex = 0;
  shuffledQueue = [];
  roundEndInProgress = false;
  gameState.roundNumber = 1;
  gameState.scores = {};
  gameState.matchOver = false;
  gameState.paused = false;

  activeLevel = await loadLevel(modeDef.levels[0]);
  gameState.currentLevel = { url: activeLevel.url };

  await callHook(activeLevel.def.hooks?.onRoundStart, getHookContext());
}

export function checkRoundEnd() {
  if (roundEndInProgress || gameState.matchOver) return;

  const result = evaluateWinCondition();
  if (!result) return;

  roundEndInProgress = true;
  const { winner, loser } = result;

  gameState.scores[winner] = (gameState.scores[winner] ?? 0) + 1;

  const roundsToWin = activeMode?.roundsToWin ?? 3;
  const isMatchWon = gameState.scores[winner] >= roundsToWin;

  broadcast({
    type: "roundEnded",
    winner,
    loser,
    roundNumber: gameState.roundNumber,
    scores: gameState.scores,
  });

  const postSimMs = activeMode?.postWinDelayMs ?? 2000;

  if (isMatchWon) {
    setTimeout(async () => {
      await callHook(activeMode?.hooks?.onRoundWon, getHookContext(), winner, loser);
      gameState.paused = true;
      gameState.matchOver = true;
      roundEndInProgress = false;
      await callHook(activeMode?.hooks?.onMatchWon, getHookContext(), winner);
      broadcast({
        type: "matchEnded",
        winner,
        scores: gameState.scores,
      });
    }, postSimMs);
    return;
  }

  const resetDelayMs = activeMode?.roundEndDelayMs ?? 2000;

  setTimeout(async () => {
    await callHook(activeMode?.hooks?.onRoundWon, getHookContext(), winner, loser);
    gameState.paused = true;
  }, postSimMs);

  setTimeout(async () => {
    gameState.roundNumber += 1;
    const nextLevelId = pickNextLevel();
    try {
      activeLevel = await loadLevel(nextLevelId);
    } catch (error) {
      console.error(`Failed to load next level "${nextLevelId}":`, error.message);
      roundEndInProgress = false;
      gameState.paused = false;
      return;
    }
    gameState.currentLevel = { url: activeLevel.url };
    gameState.paused = false;
    roundEndInProgress = false;
    await callHook(activeLevel.def.hooks?.onRoundStart, getHookContext());
    broadcast({
      type: "roundStarted",
      roundNumber: gameState.roundNumber,
      scores: gameState.scores,
      level: activeLevel.url,
    });
  }, resetDelayMs);
}

export async function resetMatch() {
  levelIndex = 0;
  shuffledQueue = [];
  try {
    activeLevel = await loadLevel(activeMode.levels[0]);
  } catch (error) {
    console.error(`Failed to load level "${activeMode.levels[0]}" on match reset:`, error.message);
    gameState.paused = false;
    roundEndInProgress = false;
    return;
  }
  gameState.currentLevel = { url: activeLevel.url };
  gameState.roundNumber = 1;
  gameState.scores = {};
  gameState.paused = false;
  gameState.matchOver = false;
  roundEndInProgress = false;
  await callHook(activeMode?.hooks?.onMatchReset, getHookContext());
  broadcast({
    type: "matchReset",
    roundNumber: gameState.roundNumber,
    scores: gameState.scores,
    level: activeLevel.url,
  });
}
