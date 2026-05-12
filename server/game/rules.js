import { BARRAGE_CONFIG } from "../../public/config.js";
import {
  isKingName,
  restArmAngleForTrebuchet,
  ARM_STATE_IDLE,
} from "./entities.js";
import { gameObjects, gameState, dragState } from "./state.js";
import { broadcast } from "../net/broadcast.js";
import { reloadLevel } from "./level.js";
import { nextLevel, firstLevel } from "./levelCatalog.js";
import { syncPhysicsBodyFromObject, setPhysicsBodyTrigger } from "./physics.js";

let roundEndInProgress = false;

export function resetGameState() {
  dragState.clear();

  for (const object of gameObjects.values()) {
    object.x = object.originX;
    object.y = object.originY;
    object.z = object.originZ;
    object.rot = 0;
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

    syncPhysicsBodyFromObject(object, { x: 0, y: 0, z: 0 });
  }
}

export function checkKingKnockout() {
  const threshold = BARRAGE_CONFIG.kingKnockoutAngle ?? 45;
  for (const object of gameObjects.values()) {
    if (isKingName(object.id) && Math.abs(object.rot) >= threshold) {
      return object;
    }
  }
  return null;
}

export function playerIdForKing(king) {
  return king.originX < 0 ? "P1" : "P2";
}

export function tryRecordRoundWin() {
  if (roundEndInProgress || gameState.matchOver) return;

  const knockedKing = checkKingKnockout();
  if (!knockedKing) return;

  roundEndInProgress = true;
  const loserId = playerIdForKing(knockedKing);
  const winnerId = loserId === "P1" ? "P2" : "P1";

  gameState.scores[winnerId] = (gameState.scores[winnerId] ?? 0) + 1;

  const roundsToWin = BARRAGE_CONFIG.roundsToWin ?? 3;
  const isMatchWon = gameState.scores[winnerId] >= roundsToWin;

  broadcast({
    type: "roundEnded",
    winner: winnerId,
    loser: loserId,
    roundNumber: gameState.roundNumber,
    scores: gameState.scores,
  });

  const postSimMs = BARRAGE_CONFIG.postWinSimulationMs ?? 5000;

  if (isMatchWon) {
    setTimeout(() => {
      gameState.paused = true;
      gameState.matchOver = true;
      roundEndInProgress = false;
      broadcast({
        type: "matchEnded",
        winner: winnerId,
        scores: gameState.scores,
      });
    }, postSimMs);
    return;
  }

  const resetDelayMs = BARRAGE_CONFIG.roundEndDelayMs ?? 5000;

  setTimeout(() => {
    gameState.paused = true;
  }, postSimMs);

  setTimeout(async () => {
    gameState.roundNumber += 1;
    const level = nextLevel(gameState.currentLevel?.id);
    await reloadLevel(level);
    gameState.paused = false;
    roundEndInProgress = false;
    broadcast({
      type: "roundStarted",
      roundNumber: gameState.roundNumber,
      scores: gameState.scores,
      level: level.url,
    });
  }, resetDelayMs);
}

export async function resetMatch() {
  const level = firstLevel();
  await reloadLevel(level);
  gameState.roundNumber = 1;
  gameState.scores = {};
  gameState.paused = false;
  gameState.matchOver = false;
  roundEndInProgress = false;
  broadcast({
    type: "matchReset",
    roundNumber: gameState.roundNumber,
    scores: gameState.scores,
    level: level.url,
  });
}
