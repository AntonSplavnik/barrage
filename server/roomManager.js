const ROOM_SIZE = 2;
const MAX_ROOMS = 3;

function playerIdForRoomSlot(roomIndex, slotIndex) {
  return `Player_${roomIndex * ROOM_SIZE + slotIndex + 1}`;
}

export class RoomManager {
  constructor({ createRoom }) {
    this.createRoom = createRoom;
    this.rooms = [];
    this.spectators = new Map();
    this.pendingRoom = null;
    this.assignmentQueue = Promise.resolve();
  }

  async assignClient(client) {
    const assignment = this.assignmentQueue.then(() => this.assignClientUnlocked(client));
    this.assignmentQueue = assignment.catch(() => {});
    return assignment;
  }

  async assignClientUnlocked(client) {
    const room = await this.openRoom();
    if (!room) {
      const spectatorNumber = this.nextSpectatorNumber();
      const spectatorId = `Spectator_${spectatorNumber}`;
      client.playerId = spectatorId;
      client.room = null;
      client.spectatorNumber = spectatorNumber;
      this.spectators.set(client.id, client);
      return {
        room: null,
        playerId: spectatorId,
        matched: false,
        becameMatched: false,
        spectator: true,
      };
    }

    const playerId = room.playerIds.find((id) => !room.clients.has(id));
    const wasMatched = this.isMatched(room);
    if (!playerId) {
      throw new Error(`No open player slot in ${room.id}`);
    }

    room.clients.set(playerId, client);
    client.playerId = playerId;
    client.room = room;
    const matched = this.isMatched(room);

    return {
      room,
      playerId,
      matched,
      becameMatched: !wasMatched && matched,
    };
  }

  removeClient(client) {
    if (!client.room) {
      this.spectators.delete(client.id);
      return { spectatorRenames: this.renumberSpectators() };
    }

    const room = client.room;
    const playerId = client.playerId;

    room.clients.delete(playerId);
    client.room = null;
    return { room, playerId };
  }

  promoteSpectatorToSlot(room, playerId) {
    const spectator = [...this.spectators.values()]
      .sort((a, b) => a.spectatorNumber - b.spectatorNumber)[0];
    if (!spectator) return null;

    this.spectators.delete(spectator.id);
    spectator.playerId = playerId;
    spectator.room = room;
    spectator.spectatorNumber = null;
    room.clients.set(playerId, spectator);
    return {
      spectator,
      spectatorRenames: this.renumberSpectators(),
    };
  }

  compactWaitingRooms() {
    const waitingRooms = this.rooms.filter((room) => room.clients.size === 1 && !room.matchEnded);
    const moves = [];

    while (waitingRooms.length >= ROOM_SIZE) {
      const targetRoom = waitingRooms.shift();
      const sourceRoom = waitingRooms.shift();
      const sourceClient = [...sourceRoom.clients.values()][0];
      const previousPlayerId = sourceClient.playerId;
      const nextPlayerId = targetRoom.playerIds.find((id) => !targetRoom.clients.has(id));

      if (!sourceClient || !nextPlayerId) continue;

      sourceRoom.clients.delete(previousPlayerId);
      targetRoom.clients.set(nextPlayerId, sourceClient);
      sourceClient.playerId = nextPlayerId;
      sourceClient.room = targetRoom;
      moves.push({ sourceRoom, targetRoom, client: sourceClient, previousPlayerId, nextPlayerId });
    }

    this.rooms = this.rooms.filter((room) => room.clients.size > 0);
    return moves;
  }

  isMatched(room) {
    return room.clients.size === ROOM_SIZE;
  }

  activeRooms() {
    return this.rooms.filter((room) => this.isMatched(room) && !room.paused);
  }

  renumberSpectators() {
    const renames = [];
    const spectators = [...this.spectators.values()].sort((a, b) => a.spectatorNumber - b.spectatorNumber);

    for (let index = 0; index < spectators.length; index += 1) {
      const client = spectators[index];
      const nextNumber = index + 1;
      const nextPlayerId = `Spectator_${nextNumber}`;
      if (client.spectatorNumber === nextNumber && client.playerId === nextPlayerId) continue;

      client.spectatorNumber = nextNumber;
      client.playerId = nextPlayerId;
      renames.push(client);
    }

    return renames;
  }

  nextSpectatorNumber() {
    const used = new Set([...this.spectators.values()].map((client) => client.spectatorNumber));
    let number = 1;

    while (used.has(number)) {
      number += 1;
    }

    return number;
  }

  async openRoom() {
    const existing = this.rooms.find((room) => room.clients.size < ROOM_SIZE && !room.matchEnded);
    if (existing) return existing;

    if (this.pendingRoom) return this.pendingRoom;
    if (this.rooms.length >= MAX_ROOMS) return null;

    const index = this.rooms.length;
    this.pendingRoom = this.createRoom({
      id: `room-${index + 1}`,
      index,
      playerIds: Array.from({ length: ROOM_SIZE }, (_value, slotIndex) => playerIdForRoomSlot(index, slotIndex)),
    });
    let room = null;
    try {
      room = await this.pendingRoom;
    } finally {
      this.pendingRoom = null;
    }
    this.rooms.push(room);
    return room;
  }
}
