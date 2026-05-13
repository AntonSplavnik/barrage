// server/game/levels/level1.js
export default {
  arena: "levels/level1.glb",

  setup(spawn) {
    spawn("trebuchets/basic", { x: -25, y: 1, player: 1 });
    spawn("trebuchets/basic", { x: 25, y: 1, player: 2 });

    spawn("kings/default-L", { x: -37, y: 1.05, player: 1 });
    spawn("kings/default-R", { x: 37, y: 1.05, player: 2 });

    spawn("blocks/defarult-L", { x: -12, y: 1 });
    spawn("blocks/defarult-L", { x: -12, y: 9, rotation: 45 });
    spawn("blocks/fragmented-L", { x: 12, y: 1 });
    spawn("blocks/fragmented-R", { x: 12, y: 9, rotation: -45 });

    spawn("missiles/basic", { x: 0, y: 0.5 });
    spawn("missiles/basic", { x: 0, y: 6 });
  },

  hooks: {},
};
