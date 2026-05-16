// server/game/levels/level1.js
export default {
	arena: "levels/level1.glb",

	setup(spawn) {
		// spawn("trebuchets/basic", { x: -25, y: 1, player: 1 });
		// spawn("trebuchets/basic", { x: 25, y: 1, player: 2 });

		// spawn("kings/default-R", { x: -37, y: 1.05, player: 1, shape: "convex_hull" });
		// spawn("kings/default-L", { x: 37, y: 1.05, player: 2, shape: "convex_hull" });

		// spawn("blocks/defarult-R", { x: -12, y: 1, fragmentTemplate: "blocks/fragmented-R" });
		// spawn("blocks/defarult-R", { x: -12, y: 9, rotation: 45, fragmentTemplate: "blocks/fragmented-R" });
		// spawn("blocks/defarult-L", { x: 12, y: 1, fragmentTemplate: "blocks/fragmented-L" });
		// spawn("blocks/defarult-L", { x: 12, y: 9, rotation: -45, fragmentTemplate: "blocks/fragmented-L" });

		// spawn("missiles/basic", { x: 0, y: 0.5 });
		// spawn("missiles/basic", { x: 0, y: 6 });


		spawn("kings/default-L", { x: -31, y: 13.05, z: -1, shape: "convex_hull" });
		spawn("kings/default-R", { x: 30.98, y: 12.96, shape: "convex_hull" });

		spawn("blocks/default-L", { x: -31, y: 1, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -34, y: 1, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -28, y: 1, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -31, y: 3, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -34, y: 3, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -28, y: 3, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -31, y: 5, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -34, y: 5, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -28, y: 5, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -31, y: 7, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -34, y: 7, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -28, y: 7, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -31, y: 9, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -34, y: 9, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -28, y: 9, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -31, y: 11, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -34, y: 11, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -28, y: 11, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -34, y: 13, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -28, y: 13, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -34, y: 15, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -28, y: 15, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -33, y: 17, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -29, y: 17, z: -1, fragmentTemplate: "blocks/fragmented-L" });
		spawn("blocks/default-L", { x: -31, y: 19, z: -1, fragmentTemplate: "blocks/fragmented-L" });

		spawn("blocks/default-R", { x: 34, y: 13, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 34, y: 15, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 31, y: 1, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 34, y: 1, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 29, y: 17, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 28, y: 1, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 31, y: 3, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 34, y: 3, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 33, y: 17, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 28, y: 3, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 31, y: 5, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 34, y: 5, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 34, y: 11, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 28, y: 5, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 31, y: 7, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 34, y: 7, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 28, y: 7, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 31, y: 9, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 34, y: 9, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 28, y: 9, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 31, y: 11, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 31, y: 19, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 28, y: 11, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 28, y: 13, fragmentTemplate: "blocks/fragmented-R" });
		spawn("blocks/default-R", { x: 28, y: 15, fragmentTemplate: "blocks/fragmented-R" });

		spawn("missiles/basic", { y: 0.7 });
		spawn("missiles/basic", { x: -1.4, y: 0.7 });
		spawn("missiles/basic", { x: 1.4, y: 0.7 });
		spawn("missiles/basic", { y: 2.1 });
		spawn("missiles/basic", { x: -1.4, y: 2.1 });
		spawn("missiles/basic", { x: 1.4, y: 2.1 });

		// spawn("missiles/bomb", { x: 38.8, y: 0.7 });
		// spawn("missiles/bomb", { x: -38.6, y: 0.7 });
		// spawn("missiles/bomb", { x: -37.2, y: 0.7 });
		// spawn("missiles/bomb", { x: 37.4, y: 0.7 });
		// spawn("missiles/bomb", { x: -38.6, y: 2.1 });
		// spawn("missiles/bomb", { x: -37.2, y: 2.1 });
		// spawn("missiles/bomb", { x: 37.4, y: 2.1 });
		// spawn("missiles/bomb", { x: 38.8, y: 2.1 });

		spawn("trebuchets/trebuche-R", { x: -15, y: 1, player: 1 });
		spawn("trebuchets/trebuche-L", { x: 15, y: 1, player: 2 });
	},

	config: {
		crackSystem: true,
		fragmentation: true,
	},
};
