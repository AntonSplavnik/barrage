export const clients = new Map();
export const gameObjects = new Map();
export const dragState = new Map();
export const loadTargets = new Map();
export const destroyedBlocks = new Map();

export const gameState = {
  tick: 0,
  nextClientId: 1,
  roundNumber: 1,
  scores: {},
  paused: false,
  matchOver: false,
  currentLevel: null,
};
