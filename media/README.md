# Portal media assets

Source files for catalogue / portal imagery referenced in `manifest.ts` → `portalMetadata`
(`heroImageUrl`, `gameplayImages`, `personaPreviewAudioUrl`, etc.).

At build time this folder is copied to `dist/media/` alongside the runtime bundles and
`dist/manifest.json`. Upload tooling maps these files to the canonical CDN URLs declared in
the manifest.

**Do not import these files from React bundles** — large assets belong on the CDN, not inside
`host.mjs` / `player.mjs`. Persona avatars (`.riv`) are owned by the Persona Service.

Suggested files once art is ready:

- `hero.jpg` — catalogue hero image
- Additional gameplay screenshots as needed
