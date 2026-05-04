import { spawnSync } from "node:child_process";

const dependencies = [
  "@babylonjs/core",
  "@babylonjs/loaders",
  "@babylonjs/havok",
  "express",
  "ws",
  "xhr2",
];

const result = spawnSync("npm", ["install", ...dependencies], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
