import { scene } from "./engine.js";

const { SceneLoader } = BABYLON;

const templateCache = new Map();

export async function initTemplateRegistry(templatePaths) {
  for (const templatePath of templatePaths) {
    const before = new Set(scene.rootNodes);
    await SceneLoader.AppendAsync("/assets/templates/", `${templatePath}.glb`, scene);
    const newRoot = scene.rootNodes.find((n) => !before.has(n));
    newRoot.name = `__template_${templatePath}__`;
    newRoot.setEnabled(false);
    templateCache.set(templatePath, newRoot);
    console.log(`Template loaded: ${templatePath}`);
  }
}

export function getTemplateRoot(templatePath) {
  return templateCache.get(templatePath);
}
