// server/game/levels/level1.js
export default {
	arena: "levels/level1.glb",

	setup(spawn) {
		spawn("trebuchets/basic", { x: -25, y: 1, player: 1 });
		spawn("trebuchets/basic", { x: 25, y: 1, player: 2 });

		spawn("kings/default-R", { x: -37, y: 1.05, player: 1, shape: "convex_hull" });
		spawn("kings/default-L", { x: 37, y: 1.05, player: 2, shape: "convex_hull" });

		spawn("blocks/defarult-R", { x: -12, y: 1, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/defarult-R", { x: -12, y: 9, rotation: 45, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/defarult-L", { x: 12, y: 1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/defarult-L", { x: 12, y: 9, rotation: -45, fragmentTemplate: "blocks/fragmented-L" });

		spawn("missiles/basic", { x: 0, y: 0.5 });
		spawn("missiles/basic", { x: 0, y: 6 });
	},

	hooks: {
		onBlockDestroyed(block, missile, ctx) {
			ctx.shatterBlock(block, missile);
		},
	},
};
