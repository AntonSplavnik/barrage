# Codex Notes

## GLB Analysis

Do not add GLB inspection tools to `package.json` unless they become part of the app build or CI.

When analyzing GLB assets for size, geometry, texture dimensions, or material structure, use the glTF Transform CLI through `npx`:

```bash
npx --yes @gltf-transform/cli inspect public/assets/level1.glb
```

For another asset:

```bash
npx --yes @gltf-transform/cli inspect public/assets/example.glb
```

This keeps Cloudflare Pages deploy dependencies focused on the app while still giving Codex a repeatable GLB parser when needed.

## Cloudflare Pages

This project is a Cloudflare Pages app. Use:

```bash
npm run build
npm run dev
```

The local dev server is served by Wrangler from `public/`, with Pages Functions in `functions/` and D1 bound as `DB`.
