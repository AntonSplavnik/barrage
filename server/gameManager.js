import { BARRAGE_CONFIG } from "../public/config.js";
import { isKingName } from "./utils.js";
import { gameObjects, gameState } from "./state.js";
import { resetGameState } from "./input.js";
import { broadcast } from "./network.js";
import { reloadLevel } from "./level.js";
import { nextLevel, firstLevel } from "./levelCatalog.js";

let roundEndInProgress = false;

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
