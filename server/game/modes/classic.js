// server/game/modes/classic.js
export default {
  name: "classic",
  levels: ["level1"],
  roundsToWin: 3,
  winCondition: "kingKnockout",
  kingKnockoutAngle: 45,
  postWinDelayMs: 2000,
  roundEndDelayMs: 2000,
  levelOrder: "sequential",
  hooks: {},
};
