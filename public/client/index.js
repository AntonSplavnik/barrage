import { engine, scene } from "./engine.js";
import { loadLevel } from "./level.js";
import { setupInput } from "./input.js";
import "./network.js";

setupInput();

loadLevel().then(() => {
  engine.runRenderLoop(() => {
    scene.render();
  });
});

window.addEventListener("resize", () => {
  engine.resize();
});
