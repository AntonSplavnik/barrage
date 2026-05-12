import { engine } from "./engine.js";
import { setupInput } from "./input.js";
import "./network.js";
import "./aim.js";

setupInput();

window.addEventListener("resize", () => {
  engine.resize();
});
