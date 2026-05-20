import { engine } from "./engine.js";
import { setupInput } from "./input.js";
import { fitCameraToAspect } from "./level.js";
import "./network.js";
import "./aim.js";

setupInput();

window.addEventListener("resize", () => {
  engine.resize();
  fitCameraToAspect();
});
