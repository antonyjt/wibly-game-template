# Wibly Game Template

Starting scaffold for a new [Wibly](https://wibly.games) Experience (party game bundle).

**Template version:** `0.1.0` (aligned with `@wibly/sdk@0.1.1`)

## What's included

| Area | Files |
|---|---|
| Build pipeline | `vite.*.config.ts`, `vite.lib.shared.ts`, `scripts/build-package.mjs` |
| Runtime bundles | `src/host.tsx`, `src/player.tsx`, `server.ts` (stubs) |
| Contract | `manifest.ts` (minimal valid manifest), `src/types.ts` |
| Dev harness | `index.html`, `src/dev.tsx` |
| Tests | `tests/manifest.test.ts` |
| Publish layout | `media/` → copied to `dist/media/` at build time |

## First steps after copying this template

1. **Rename the repo** and update `package.json` → `name`.
2. **Replace placeholders** in `manifest.ts`:
   - `exp_REPLACE_ME000000000_` → your experience id
   - `per_REPLACE_ME0000000_` → your host persona id
   - `name`, `description`, `workflow`, `promptSlots`, `portalMetadata`
3. **Implement your game** in `host.tsx`, `player.tsx`, and `server.ts`.
4. **Add portal art** under `media/` and update CDN URLs in `manifest.ts`.
5. **Read the Game Builders Guide** — do not copy it into this repo; use the canonical platform doc.

## Commands

```bash
pnpm install
pnpm dev              # local harness — ?surface=host | ?surface=player
pnpm typecheck
pnpm test
pnpm build            # dist/host.mjs, player.mjs, server.mjs, manifest.json, media/
```

## Publish artefact layout

After `pnpm build`, `dist/` should contain:

```
dist/
  host.mjs
  player.mjs
  server.mjs
  manifest.json
  media/              # optional portal assets
  *.map               # sourcemaps
```

The platform uploads runtime bundles to R2; portal media typically lands on a separate CDN path.
See the Game Builders Guide §3.1.1 and §12.4.

## Dev harness query params

| Param | Values | Default |
|---|---|---|
| `surface` | `host`, `player` | `player` |
| `phase` | any phase id from your manifest | `lobby` |

Examples:

- `http://localhost:5173/?surface=host&phase=lobby`
- `http://localhost:5173/?surface=player&phase=main`

## Keeping the template in sync

When the platform build pipeline changes (new Vite plugin, SDK mount contract, etc.),
backport updates from `wibly-game-template` — do not re-copy from a shipped game repo.

## QA before publish

Run the Annexure C QA prompt from the Game Builders Guide against your repo before the first upload.
