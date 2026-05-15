export function createRoomLifecycle({
  bindRoom,
  compactWaitingRooms,
  createRoomRuntime,
  enableHavokPhysics,
  isMatched,
  loadLevelIfPresent,
  notifySpectatorRenames,
  promoteSpectatorToSlot,
  resetGameState,
  resetRoomProgress,
  saveActiveRoomTick,
  sendLobby,
  sendMatched,
  sendState,
  sendWelcome,
}) {
  async function resetRoomToFirstLevel(room) {
    resetRoomProgress(room);
    createRoomRuntime(room);
    bindRoom(room);
    await enableHavokPhysics();
    await loadLevelIfPresent();
    saveActiveRoomTick();
  }

  function notifyRoomStatus(room) {
    if (isMatched(room)) {
      bindRoom(room);
      room.paused = false;
      room.roundWinner = null;
      resetGameState();
      saveActiveRoomTick();
      sendMatched(room);
      sendState();
      return;
    }

    for (const client of room.clients.values()) {
      sendLobby(client);
    }
  }

  async function compactAndNotifyWaitingRooms() {
    const moves = compactWaitingRooms();
    if (moves.length === 0) return false;

    const touchedRooms = new Set();
    for (const move of moves) {
      touchedRooms.add(move.sourceRoom);
      touchedRooms.add(move.targetRoom);
    }

    for (const room of touchedRooms) {
      if (isMatched(room)) {
        await resetRoomToFirstLevel(room);
      }
      notifyRoomStatus(room);
    }

    return true;
  }

  async function handlePlayerVacancy({ room, playerId }) {
    const promotion = promoteSpectatorToSlot(room, playerId);
    if (promotion) {
      const { spectator: promoted, spectatorRenames } = promotion;
      sendWelcome(promoted);
      notifySpectatorRenames(spectatorRenames);
      await resetRoomToFirstLevel(room);
      notifyRoomStatus(room);
      return;
    }

    if (!await compactAndNotifyWaitingRooms()) {
      notifyRoomStatus(room);
    }
  }

  return {
    compactAndNotifyWaitingRooms,
    handlePlayerVacancy,
    notifyRoomStatus,
    resetRoomToFirstLevel,
  };
}
