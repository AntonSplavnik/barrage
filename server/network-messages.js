export function createNetworkMessenger({
  firstLevel,
  getActiveRoom,
  getPrimaryRoom,
  getSpectators,
  tickRate,
}) {
  function sendToClient(client, message) {
    if (client.socket.readyState === client.socket.OPEN) {
      client.socket.send(JSON.stringify(message));
    }
  }

  function roomOpponentFor(client) {
    for (const other of client.room.clients.values()) {
      if (other.id !== client.id) return other;
    }

    return null;
  }

  function sendWelcome(client) {
    sendToClient(client, {
      type: "welcome",
      clientId: client.id,
      playerId: client.playerId,
      tickRate,
    });
  }

  function sendLobby(client) {
    if (!client.room) {
      const room = getPrimaryRoom() ?? null;
      sendToClient(client, {
        type: "lobby",
        roomId: room?.id ?? null,
        playerId: client.playerId,
        status: "spectating",
        level: room?.level.url ?? firstLevel().url,
      });
      return;
    }

    sendToClient(client, {
      type: "lobby",
      roomId: client.room.id,
      playerId: client.playerId,
      status: "waiting",
      level: client.room.level.url,
    });
  }

  function notifySpectatorRenames(clientsToNotify) {
    for (const client of clientsToNotify) {
      sendWelcome(client);
      sendLobby(client);
    }
  }

  function broadcastRoomOneToSpectators(message) {
    if (getActiveRoom() !== getPrimaryRoom()) return;

    const payload = JSON.stringify(message);
    for (const client of getSpectators().values()) {
      if (client.socket.readyState === client.socket.OPEN) {
        client.socket.send(payload);
      }
    }
  }

  function sendMatched(room) {
    for (const client of room.clients.values()) {
      const opponent = roomOpponentFor(client);
      sendToClient(client, {
        type: "matched",
        roomId: room.id,
        playerId: client.playerId,
        opponentId: opponent?.playerId ?? null,
        level: room.level.url,
        roundNumber: room.roundNumber,
        scores: room.scores,
      });
    }
  }

  return {
    broadcastRoomOneToSpectators,
    notifySpectatorRenames,
    sendLobby,
    sendMatched,
    sendToClient,
    sendWelcome,
  };
}
