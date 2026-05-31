# Game Builders Guide

**Audience:** AI coding agents (Lovable, Cursor, Claude, Copilot) building Wibly Experiences, with human reviewers reading along.
**Companion to:** Platform Specification v0.3, Development Spec — MVP and Phase 2, Hosting & Deployment Addendum, `docs/conventions/prompt-composition.md`.
**Status:** Living document. The first walked-through Experience is **E2 — The Flatterer**; the guide is generalised so future Experiences (Rashomon, Music Games, Adult Games) drop into the same shape.

---

## 0. How to use this guide

This document is the **single source of truth** for "how do I build a Wibly game?" An AI agent reading this guide should be able to scaffold a complete Experience repo and produce a working `manifest.ts` + `host.tsx` + `player.tsx` + `server.ts` without consulting any other document, *except*:

- The per-game design spec (e.g. `the_flatterer_spec.md`) for the gameplay design itself.
- The Platform Specification when a deeper architectural question arises (mostly answered here in summarised form).
- The Persona Service catalogue for which `personaId` to bind.

**Sections 1–4 are invariants.** Read them once per AI context window. They are short on purpose.

**Sections 5–10 are reference.** Skim once, then jump back as needed when building a specific surface.

**Section 11 is a worked walkthrough** of a single Flatterer round, from "session created" to "scoreboard rendered." Use it as a mental model when something seems unclear elsewhere.

**Annexure A** is a complete, paste-ready example manifest for The Flatterer.

**Annexure B** is the human Creator's step-by-step playbook for shipping any new Experience (scaffold from the game template, manifest authoring, Lovable/Cursor workflow, publish).

---

## 1. The five invariants

These are load-bearing. **If your code seems to require violating any of them, you are building the wrong thing.**

### 1.1 The server holds truth

Anything that determines what any client renders lives in **server state**. Clients are pure functions of the state slices they subscribe to. Reload a tab, swap a device, reconnect: the same state input must produce the same UI.

What this rules out:

- React `useState` for "we are showing the result screen" — phase id is in server state.
- `setTimeout` chains for "show this for 3 seconds then hide" — timers are server-anchored (§3.7 of Platform Spec).
- Per-player visibility logic in client conditionals — the server projects `playerPrivate` slices and clients render what they receive.

What this allows:

- Animation progress, audio playback position, scroll position, hover state — these are render-cycle ephemera that don't change *what* is shown.

### 1.2 Turn-based by default

Every Experience is a **state machine of phases**. Each phase declares an `inputSet` (whose inputs are accepted) and a `collectionRule` (when the phase ends). The server enforces transitions. The client *cannot* drive workflow advancement.

The only way a client moves the workflow forward is:

- The host emits `host.advancePhase` (gated server-side to host role).
- A player `submit()` satisfies a `collectionRule` (e.g. `all_respond`).
- A `timeout` collection rule expires (server-side wall clock).

### 1.3 Inference goes through the Gateway

No game bundle calls OpenRouter / OpenAI / ElevenLabs / Anthropic directly. **Every** LLM and TTS call goes through the platform's Inference Gateway via the SDK or the server-side `ctx.llm.*` / `ctx.tts.speak` calls. The Gateway applies safety, metering, caching, model routing, and budget enforcement.

If you find yourself reaching for an HTTP client to call a model provider, stop.

### 1.4 Prompts are composed, not authored

You do **not** write raw prompts. You author **named slots** (per `docs/conventions/prompt-composition.md`); the Gateway composes the final 8-layer prompt from:

1. Platform system (constant, supplied by platform)
2. **Persona** (supplied by Persona Service — bound via `personaBindings`)
3. **Experience** (your `manifest.promptSlots.experienceSystem`)
4. Call-type (platform-supplied per `callKind` + your `manifest.promptSlots.callTypes[callKind]`)
5. Session context (Runtime live state)
6. Player input (the submission being processed)
7. **Output contract** (your `manifest.promptSlots.outputSchemas[callKind]` + the SDK's Zod-to-JSON-Schema render)
8. Canary (platform-supplied per call)

You author layers 3, 4 (the appendage portion), and 7. The platform handles the rest. **Personas are never authored in the manifest** — they live in the Persona Service and are referenced by `personaId`.

### 1.5 The mount contract is fixed

Both `host.tsx` and `player.tsx` (and `server.ts` if present) export exactly one entrypoint:

```typescript
export const mount = (
  session: Session,           // for host.tsx / player.tsx
  container: HTMLElement,
): (() => void) /* unmount */ => { /* ... */ };
```

For `server.ts`, you export named hook functions instead (see §8).

The shell apps (`apps-shells/host-web`, `apps-shells/player-web`) dynamically `import(bundleUrl)` your built ESM and call `mount(session, container)`. They provide `@wibly/sdk` at runtime — **externalise only the SDK** at build time. Your bundle must ship its own `react`, `react-dom`, `@wibly/ui-kit`, and `@wibly/animation` (the shell does not inject those).

---

## 2. Glossary — every term you'll see

| Term | Meaning |
|---|---|
| **Experience** | A complete game (e.g. The Flatterer, Rashomon). One repo, one bundle, one manifest. |
| **Session** | One play-through of an Experience by a specific group at a specific time. |
| **Manifest** | The declarative config (`manifest.ts`) the Runtime reads to provision a Session. |
| **Host bundle** (`host.tsx`) | The big-screen UI (smart TV, projector, laptop with HDMI). One per Session. Renders TTS audio. |
| **Player bundle** (`player.tsx`) | The phone/laptop UI. One per Player. Renders private state. |
| **Server bundle** (`server.ts`) | Optional sandboxed JS that runs **inside the Runtime** in an `isolated-vm` V8 isolate. Provides the `onSessionStart`, `onPhaseStart`, `onPhaseEnd`, `computeScore`, `onRoundEnd`, `onSessionEnd` hooks. |
| **Persona** | A character (e.g. Professor Crumb, The Curator). Lives in the Persona Service; bound to a manifest role via `personaBindings`. |
| **Phase** | One step of the workflow state machine. Has an `inputSet`, a `collectionRule`, and one or more `transitions`. |
| **Active party** | The actor(s) whose input the current phase accepts (`host`, `player`, `team`, or none). |
| **Non-Active emission** | A non-state-advancing event from a party outside the active set, sent via `session.emit()` instead of `session.submit()`. |
| **Side-effect** | Declarative work the Runtime performs on phase entry (`inference`, `scoring`, `state_write`, `persona_memory`). |
| **`callKind`** | The kind of inference call (e.g. `host_judge`, `judge_funniness`, `host_open_phase`). Drives prompt composition layer 4. |
| **Quality tier** | `fast` / `standard` / `premium` / `creative` — the Gateway routes to the cheapest model that meets the tier. |
| **Scoring dimension** | A named axis you award points on (e.g. `points`, `detective`). Aggregators combine them. |
| **Award** | A named outcome (e.g. "Decisive Argument", "Most Outrageous") resolved by a criterion (`top_n` or `threshold`) over a dimension. |
| **Lifecycle policy** | Declarative response to a Session situation (e.g. `player_disconnect → pause_session timeoutMs: 30000`). |
| **State slice** | One of the five recipient-scoped projections: `session`, `host`, `playerPublic`, `playerPrivate`, `team`. |
| **Cast-to-TV** | The flow that pairs a phone-controlled Session with a separate big-screen Host browser. |

---

## 3. Repo layout (a Lovable Experience repo)

Each game lives in **its own GitHub repo**, separate from the Wibly platform monorepo. **New games start from `wibly-game-template`** (Annexure B, Phase 1) — do not scaffold from a blank Vite project or fork a shipped game. Lovable connects to the game repo; Cursor is used for manifest, server hooks, and tests. The Wibly build pipeline pulls the built bundle into R2 at publish time.

```
my-wibly-game/                          # Repo root (cloned from wibly-game-template)
├── manifest.ts                         # The declarative config (see §5)
├── server.ts                           # Sandbox hooks (see §8)
├── scripts/
│   └── build-package.mjs               # Emits dist/manifest.json + copies media/
├── media/                              # Portal catalogue assets → dist/media/ (see §9.2)
├── content/                            # Game-specific curated content (name varies by game)
│   └── …                               # e.g. opinions/, scenarios/, clues/
├── lib/                                # Pure helpers, Zod schemas (add as needed)
│   └── …
├── src/
│   ├── host.tsx                        # Host UI bundle entry (see §6)
│   ├── player.tsx                      # Player UI bundle entry (see §7)
│   ├── dev.tsx                         # Local dev harness (not shipped)
│   ├── types.ts                        # Mount contract types
│   └── styles.css                      # Tailwind @theme tokens (bundled into .mjs — see §9.1)
├── tests/
│   └── manifest.test.ts                # Add game-specific tests alongside
├── vite.config.ts                      # Local dev server only (see §3.1.1)
├── vite.host.config.ts                 # Production build: host.mjs
├── vite.player.config.ts               # Production build: player.mjs
├── vite.lib.shared.ts                  # Shared Vite lib config for host + player
├── index.html                          # Dev harness shell
├── tsconfig.json                       # Must include server.ts, manifest.ts (see §3.1.2)
├── package.json
├── .github/workflows/ci.yml
└── README.md
```

Shipped games may add `components/`, extra `lib/` modules, and content libraries as complexity grows. The Flatterer adds `opinions/opinions.json`, `lib/scoring.ts`, and split host/player components — see that repo as a reference implementation, not a fork source.

### 3.1 `package.json` minimum

```json
{
  "name": "my-wibly-game",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "pnpm run build:host && pnpm run build:player && pnpm run build:server && pnpm run build:package",
    "build:host": "vite build --config vite.host.config.ts",
    "build:player": "vite build --config vite.player.config.ts",
    "build:server": "esbuild server.ts --bundle --format=esm --platform=neutral --target=es2022 --outfile=dist/server.mjs --sourcemap",
    "build:package": "node scripts/build-package.mjs",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@wibly/sdk": "^0.1.0",
    "@wibly/ui-kit": "^0.1.0",
    "@wibly/animation": "^0.1.0",
    "zod": "^3.23.0",
    "clsx": "^2.1.0"
  },
  "devDependencies": {
    "@wibly/sdk-testkit": "^0.1.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.7.0",
    "vite": "^5.4.0",
    "@vitejs/plugin-react": "^4.3.0",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/vite": "^4.0.0",
    "esbuild": "^0.24.0",
    "vite-plugin-css-injected-by-js": "^5.0.0",
    "vitest": "^2.0.0"
  }
}
```

**Why these specific packages:**

- `@wibly/sdk` — the npm-published rename of `@platform/sdk`. Your bundle imports types and a few constants from here; the host and player shells provide the runtime value at mount time. **Externalise this at build time only.**
- `@wibly/ui-kit` — shared components (`PromptInput`, `VoteGrid`, `Timer`, `Leaderboard`, `AvatarStage`, `ResponseCard`, `JoinCodeBadge`, `PausedBanner`, `ConsentDialog`). **Bundle into `host.mjs` / `player.mjs`.**
- `@wibly/animation` — `<PersonaAvatar>`, `useTtsLipSync()`. **Bundle into `host.mjs` / `player.mjs`.** At `@wibly/animation@0.1.0` the Rive runtime is a stub (labelled placeholder + optional `imageUrl`); the props surface is stable and Rive wiring lands in a follow-up release.
- `@wibly/sdk-testkit` — devDep only. Used in unit tests to validate manifest + scoring + envelope compliance.
- `zod` — Schemas for inference outputs.

### 3.1.1 Build config — three self-contained `.mjs` files

The platform uploads **exactly three artefacts** to R2 per version: `host.mjs`, `player.mjs`, and (if present) `server.mjs`. There is no import map on the shell page — each client bundle must be **fully self-contained** except for `@wibly/sdk`, which the shell provides at runtime.

**Do not use a single multi-entry Vite/Rollup build for host + player.** A multi-entry build code-splits shared chunks (e.g. `styles-[hash].js`) that both bundles import. Those sibling chunks are **not uploaded** and the bundle fails at runtime with a failed dynamic import.

**Do not emit a separate `.css` file.** Vite lib mode extracts imported stylesheets by default. R2 does not ship a `.css` alongside the bundles. Inject CSS at runtime via `vite-plugin-css-injected-by-js` so styles ride inside the `.mjs`.

**Build `server.ts` with esbuild, not Vite.** The platform pipeline Vite-bundles host and player separately, and esbuilds `server.ts` to a standalone ESM with no externals. Match that locally — do not run `server.ts` through the React/Tailwind Vite config.

#### Platform publish (centralised pipeline)

**Canonical bundling lives in the Wibly monorepo**, not in your game repo's `dist/` upload. The platform script `tools/scripts/build-experience.ts` reads sources from `experiences/<slug>/` (sync a copy from your repo), validates the manifest, and produces the three R2 artefacts:

| Surface | Tool | Notes |
|---------|------|-------|
| `host.tsx` | Vite | React, ui-kit, animation, CSS, and small assets bundled in; `@wibly/sdk` externalised |
| `player.tsx` | Vite | Separate build — no shared chunks between host and player |
| `server.ts` | esbuild | Fully self-contained ESM (no externals) |

```bash
# Dry-run: validate + bundle locally (no R2, no DB)
pnpm experience:build --experience=the-flatterer --version-id=<exv_id>

# Publish bundles to R2 and register URLs on the version row
pnpm experience:build --experience=the-flatterer --version-id=<exv_id> --upload

# Also overwrite the stored manifest JSON (default: URLs only — preserves Studio edits)
pnpm experience:build --experience=the-flatterer --version-id=<exv_id> --upload --update-manifest
```

Sources are resolved flexibly under `experiences/<slug>/`: `manifest.ts` or `manifest.json`; `{host,player}.tsx` at the root or under `src/`; optional `server.ts`.

Your game repo **still needs** `pnpm typecheck`, `pnpm test`, and `pnpm build` in CI so you catch bundle-shape regressions before sync. The monorepo pipeline enforces the same rules documented in the subsections below (split client builds, CSS injected into `.mjs`, esbuild for server).

#### `vite.config.ts` — dev only

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

/** Local dev harness — not shipped in bundles. */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
});
```

#### `vite.lib.shared.ts` — shared client lib config

```typescript
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js';
import { resolve } from 'node:path';
import type { UserConfig } from 'vite';

const root = __dirname;

/** CSS is injected at runtime via a <style> tag — not emitted as a separate file. */
export const clientLibConfig = (
  entry: string,
  name: string,
  emptyOutDir: boolean,
): UserConfig => ({
  plugins: [react(), tailwindcss(), cssInjectedByJsPlugin()],
  resolve: {
    alias: { '@': resolve(root, 'src') },
  },
  build: {
    outDir: 'dist',
    emptyOutDir,
    target: 'es2022',
    sourcemap: true,
    cssCodeSplit: false,
    lib: {
      entry: resolve(root, entry),
      formats: ['es'],
      fileName: () => `${name}.mjs`,
    },
    rollupOptions: {
      external: ['@wibly/sdk'],
      output: {
        inlineDynamicImports: true,   // one self-contained file per entry
      },
    },
  },
});
```

#### `vite.host.config.ts` / `vite.player.config.ts`

```typescript
import { defineConfig } from 'vite';
import { clientLibConfig } from './vite.lib.shared';

export default defineConfig(clientLibConfig('src/host.tsx', 'host', true));
// player config: clientLibConfig('src/player.tsx', 'player', false)
```

#### `package.json` build scripts

```json
{
  "scripts": {
    "build": "pnpm run build:host && pnpm run build:player && pnpm run build:server",
    "build:host": "vite build --config vite.host.config.ts",
    "build:player": "vite build --config vite.player.config.ts",
    "build:server": "esbuild server.ts --bundle --format=esm --platform=neutral --target=es2022 --outfile=dist/server.mjs --sourcemap"
  }
}
```

After `pnpm build`, verify:

- `dist/` contains **only** `host.mjs`, `player.mjs`, and `server.mjs` (plus optional `.map` sourcemaps). **No** `.css`, **no** shared chunk files (`styles-*.js`, `chunk-*.js`).
- Each client `.mjs` has **no relative sibling imports** (`import … from './…'`). The only bare external import allowed is `@wibly/sdk`.
- Each client `.mjs` contains inlined React (`createRoot`) and ui-kit component code (not bare `import '@wibly/ui-kit'` statements).
- Each client `.mjs` injects its own CSS at load time (search for `createElement("style"` near the top of the file).
- `host.mjs` and `player.mjs` contain `import … from '@wibly/sdk'` (SDK externalised).
- Bundle size: **WARN** if any client `.mjs` is 500 KB–1 MB; **FAIL** if over 1 MB. React + ui-kit + animation typically land ~950 KB–1 MB — budget accordingly and avoid inlining large images (see §9.2).

### 3.1.2 `tsconfig.json` — include server and lib

`pnpm typecheck` must cover every file that ships. A `tsconfig.json` that only includes `src/**` silently skips `server.ts`, `lib/`, and `manifest.ts`:

```json
{
  "include": [
    "src/**/*.ts",
    "src/**/*.tsx",
    "lib/**/*.ts",
    "server.ts",
    "manifest.ts",
    "vite.config.ts",
    "vite.host.config.ts",
    "vite.player.config.ts",
    "vite.lib.shared.ts"
  ],
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "target": "ES2022"
  }
}
```

Vitest may type-check `manifest.ts` even when `tsc` does not — do not treat a green `pnpm test` as a substitute for `pnpm typecheck` over the full include list.

### 3.2 The mount contract (`host.tsx` shape)

```tsx
import { createRoot, type Root } from 'react-dom/client';
import type { Session } from '@wibly/sdk';
import { CrumbHost } from './components/host/CrumbHost';

export const mount = (session: Session, container: HTMLElement): (() => void) => {
  const root: Root = createRoot(container);
  root.render(<CrumbHost session={session} />);
  return () => {
    root.unmount();
  };
};
```

That's it. The shell calls `mount(session, container)` once on bundle load and calls the returned unmount function on navigation away. The `session` parameter is your only handle to platform capabilities.

**Critical:** `import type { Session } from '@wibly/sdk'` is fine (type imports are stripped by esbuild). **Value imports** from `@wibly/sdk` work because the shell provides the SDK as an externalised runtime dependency. Just don't import the SDK *into the bundle* — let the build externalise it.

---

## 4. The development loop

Your iteration loop has three modes, increasing in fidelity:

### 4.1 Local Vite dev (fast feedback, no platform)

```bash
pnpm dev
```

Vite spins up `host.tsx` + `player.tsx` against a **mock Session** you provide (you write a small `dev-harness.tsx` that constructs a fake `Session` shape). Useful for pure layout/CSS work. **Does not test inference, scoring, or workflow.**

### 4.2 Studio Local Runtime (Phase 2)

A local Wibly Runtime substrate stubbed for the cost-heavy subsystems (Gateway returns canned responses, Persona Service from local YAML). **Not in MVP** — for MVP, the first-party team works against a real staging Runtime. Documented here for forward compatibility.

### 4.3 Staging deploy → real Session

1. Push to the game repo (sources synced into `experiences/<slug>/` in the monorepo).
2. Run `pnpm experience:build --experience=<slug> --version-id=<exv_id> --upload` from the Wibly monorepo — validates the manifest, Vite-bundles host/player, esbuilds server, uploads to R2 under `experiences/{exp_id}/versions/{exv_id}/` (**exactly three files**: `{host,player,server}.mjs`; no `.css`, no shared chunks), and registers bundle URLs. Omit `--update-manifest` unless you intend to overwrite manifest edits made in Studio.
3. Provision a Session through the User Portal staging environment.
4. Cast to a TV (Host), join from phones (Players), play through.
5. Inspect via the Studio Session Inspector (forensic timeline of every state diff, every inference call, every TTS clip).

The first time through this loop, expect rough edges. By the third Session, it should feel routine.

---

## 5. The manifest (`manifest.ts`) — every field explained

The manifest is the **contract** between your game and the Runtime. Every field is required unless explicitly marked optional. The validator (`@wibly/sdk-testkit`'s `validateManifestStrict`) catches most mistakes before publish.

The full Zod schema lives in `@platform/manifest`'s `manifest.ts` (also exported at runtime as `@wibly/sdk`'s `ManifestSchema`). The summary:

```typescript
type Manifest = {
  // -- identity --
  id: string;                        // 'exp_<22-char-nanoid>'
  version: string;                   // SemVer-ish; you choose
  name: string;                      // Display name
  description: string;               // One-paragraph blurb
  tenant: string | null;             // null for first-party; 'tnt_<id>' for tenant-owned
  creator: string;                   // 'wibly-platform' for first-party; user id otherwise
  createdAt: string;                 // ISO-8601 with offset

  // -- persona binding (see §5.1) --
  personaBindings: { role: string; personaId: string }[];

  // -- cost shape (see §5.2) --
  inferenceEnvelope: {
    maxLlmCallsPerSession: number;
    maxTokensInPerCall: number;
    maxTokensOutPerCall: number;
    maxTtsSecondsPerSession: number;
    qualityTiers: ('fast' | 'standard' | 'premium' | 'creative')[];
  };

  // -- state shape (see §5.3) --
  stateSchema: {
    session: JsonValue;        // shared, visible to all (host + every player)
    host: JsonValue;           // visible only to host
    playerPublic: JsonValue;   // per-player, visible to all
    playerPrivate: JsonValue;  // per-player, visible only to that player
    team: JsonValue;           // per-team (if you use teams; otherwise {})
  };

  // -- workflow (see §5.4) --
  workflow: {
    initialPhase: string;
    phases: Phase[];           // each phase: id, inputSet, collectionRule,
                               // transitions[], sideEffects[], optional
                               // subPhases / computeScoreOnEnter / endsRound
  };

  // -- concurrent input opportunities (see §10.1) --
  concurrentOpportunities: ConcurrentOpportunity[];   // [] is fine

  // -- scoring (see §5.5) --
  scoring: {
    dimensions: { id; label; weight; scaleMin; scaleMax }[];
    aggregators: { kind: 'sum' | 'average' | 'weighted_sum' | 'max' | 'min' }[];
    awards: { id; label; dimensionId; criterion: { kind: 'top_n', n } | { kind: 'threshold', value } }[];
  };

  // -- lifecycle policies (see §5.6) --
  lifecyclePolicies: { situation; action }[];

  // -- prompts (see §5.7) --
  promptSlots: {
    experienceSystem: string | { template: string; vars?: string[] };
    callTypes: Record<CallKind, string | { template; vars }>;
    outputSchemas?: Record<CallKind, JsonValue /* JSON-Schema */>;
  };
  fallbackResponses: Record<CallKind, string>;

  // -- presentation (see §5.8) --
  widgetDependencies: string[];   // UI-kit components you require; usually []
  contentRating: { tier; audiences };
  portalMetadata: { heroImageUrl; gameplayImages; sampleRoundDescription; occasionTags; … };
};
```

### 5.1 Persona bindings

Personas are characters with voice + visual + memory. They are **not authored in your manifest** — they live in the Persona Service. You reference them:

```typescript
personaBindings: [
  { role: 'host', personaId: 'per_ProfessorCrumb000_' },
]
```

The Persona Service supplies layer 2 of the composed prompt (the persona's behavioural-style fragments), the TTS voice id, and the `.riv` animation asset. **The personaId is canonical** — get it from the Persona Service catalogue or from the platform team.

If your game needs multiple personas (e.g. a host + a guest judge), declare a binding per role. Roles are arbitrary strings; `'host'` is conventional but not enforced.

**First-party Personas in MVP:**

| Persona | `personaId` | Used by |
|---|---|---|
| The Curator | `per_TheCurator00000__` | Rashomon (E1), Lyric Lore (Phase 2) |
| Professor Pemberton Crumb | `per_ProfessorCrumb000_` | The Flatterer (E2) |

### 5.2 Inference envelope

Caps the per-Session inference cost. The Gateway rejects calls that exceed it.

```typescript
inferenceEnvelope: {
  maxLlmCallsPerSession: 25,        // 8 rounds × ~3 calls each = 24, plus a buffer
  maxTokensInPerCall: 2_048,
  maxTokensOutPerCall: 512,
  maxTtsSecondsPerSession: 600,     // 10 minutes of Crumb monologuing
  qualityTiers: ['fast', 'standard', 'premium'],  // M-tier per Catalogue §0
}
```

**Tier guidance** (the Gateway routes to the cheapest model in the tier):

| Tier | Use for | Typical cost shape |
|---|---|---|
| `fast` | Classification, scoring of short submissions, structured judging | Cheap, fast (<1s) |
| `standard` | Open-phase intros, conversational replies | Mid cost (~$0.001/call) |
| `premium` | Persona monologues that need character, TTS for first-party Personas | Higher cost; better fidelity |
| `creative` | Generation of structured worlds (Rashomon's structured truth) | Most expensive; reserved for `onSessionStart`-style one-shots |

**Test envelope compliance** in unit tests:

```typescript
import { assertEnvelopeCompliance } from '@wibly/sdk-testkit';

const report = assertEnvelopeCompliance(manifest, [
  { kind: 'tts', estimatedAudioSeconds: 15 },      // opinion announcement
  { kind: 'llm', qualityTier: 'fast', estimatedTokensIn: 800, estimatedTokensOut: 200 }, // judge_funniness
  { kind: 'llm', qualityTier: 'standard', estimatedTokensIn: 600, estimatedTokensOut: 400 }, // deliberation
  { kind: 'tts', estimatedAudioSeconds: 35 },      // deliberation TTS
  // … plan an entire round, multiplied by 8
]);
expect(report.compliant).toBe(true);
```

### 5.3 State schema

Five recipient-scoped slices. Each is declared as a JSON-Schema-shaped value at the manifest layer (the Runtime renders a real Zod schema at packaging time):

```typescript
stateSchema: {
  // -- session (shared, visible to host + every player) --
  session: {
    type: 'object',
    properties: {
      phase: { type: 'string' },
      roundNumber: { type: 'number' },
      currentOpinion: { type: 'string' },
      positionMeterValue: { type: 'number' },   // -100 to +100
      submissions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            playerId: { type: 'string' },
            text: { type: 'string' },
            persuasiveness: { type: 'number' },
            tag: { type: 'string' },
            reactionStyle: { type: 'string' },
          },
        },
      },
      currentlyReadingSubmissionId: { type: 'string' },
    },
  },

  // -- host (visible only to host) --
  host: {
    type: 'object',
    properties: {
      deliberationMonologue: { type: 'string' },
    },
  },

  // -- playerPublic (per-player, visible to all) --
  playerPublic: {
    type: 'object',
    properties: {
      cumulativeScore: { type: 'number' },
      submitted: { type: 'boolean' },
    },
  },

  // -- playerPrivate (per-player, visible only to that player) --
  playerPrivate: {
    type: 'object',
    properties: {
      currentArgument: { type: 'string' },   // draft buffer
    },
  },

  // -- team (only if you use teams) --
  team: { type: 'object', properties: {} },
}
```

**Rules:**

- Every slice must be present. Use `{ type: 'object', properties: {} }` for unused slices.
- The state schema is a *hint to the renderer + reviewers*. The authoritative validation happens at packaging time when the SDK's build pipeline renders these into a real Zod schema and the Runtime parses against it.
- **Do not put functions, dates, or non-JSON values in state.** State is serialised as JSON over the WebSocket.

**Which slice does what:**

| Slice | Who sees it | Who writes it | Examples |
|---|---|---|---|
| `session` | host + every player | server-side hooks, declarative side-effects | current phase, current opinion, position meter |
| `host` | host only | server-side hooks | Crumb's full monologue text (the host renders it for prompting; players don't see) |
| `playerPublic` | every player + host | declarative scoring side-effects | cumulative score, submitted flag |
| `playerPrivate` | that one player only (+ host? no) | server-side hooks | draft buffers, hidden roles, witness statements |
| `team` | members of that team | server-side hooks | team-only state (Phase 2 teams support) |

### 5.4 Workflow

The state machine. A list of phases with one designated `initialPhase`.

```typescript
workflow: {
  initialPhase: 'lobby',
  phases: [
    {
      id: 'lobby',
      inputSet: { actors: ['host'], inputType: 'start' },
      collectionRule: { kind: 'manual' },           // host's emit triggers transition
      transitions: [{ to: 'opinion_declaration' }],
      sideEffects: [],
    },
    {
      id: 'opinion_declaration',
      inputSet: { actors: ['host'], inputType: 'host_advance' },
      collectionRule: { kind: 'manual' },           // host advances after TTS finishes
      transitions: [{ to: 'argue' }],
      sideEffects: [
        // Fires on ENTRY to opinion_declaration:
        // selects the round's opinion from the library.
        // The server-side hook does the actual work; this just
        // marks the call (and runs declaratively if you prefer).
      ],
    },
    {
      id: 'argue',
      inputSet: { actors: ['player'], inputType: 'argument' },
      collectionRule: { kind: 'timeout', ms: 45_000 },   // all-respond or timeout
      transitions: [{ to: 'deliberation' }],
      sideEffects: [
        {
          kind: 'inference',
          callKind: 'judge_funniness',
          qualityTier: 'fast',
          targetPath: '/session/inference/judge_funniness',
          // Note: when you need per-player calls in series, do that in the
          // server.ts `onPhaseEnd('argue')` hook instead. A single
          // declarative side-effect makes one call. The server-side hook
          // can loop.
        },
      ],
    },
    // … and so on for deliberation, verdict, scoreboard.
  ],
}
```

**`inputSet`:** Who is allowed to satisfy this phase.

- `actors: ['host']` — only the host's input counts. Use for "host advances", "host reads aloud then clicks Next".
- `actors: ['player']` — every player's input counts (collected per the `collectionRule`).
- `actors: ['team']` — team-level (Phase 2).
- `inputType` is a manifest-local tag (e.g. `'argument'`, `'guess'`, `'vote'`). The shell uses it as the `inputType` field of the `session.submit()` payload.

**`collectionRule`:** When the phase ends.

- `{ kind: 'manual' }` — waits for a host advance event. Used for "host reads the result and clicks Next".
- `{ kind: 'all_respond' }` — every player in the input set must submit once.
- `{ kind: 'first_respond', count: N }` — first N submissions end the phase.
- `{ kind: 'timeout', ms: N }` — wall-clock timeout. The Runtime fires the transition automatically.

For "either all-respond or timeout, whichever first" (the Flatterer's `argue` phase), use `{ kind: 'timeout', ms: 45000 }`. The Runtime ends the phase on timeout; the server-side `onPhaseEnd('argue')` hook still receives every submission that arrived before timeout. **Submissions after timeout are recorded but do not influence judging.**

**`transitions`:** Outgoing edges. Evaluated in declaration order; the first matching one is taken.

- `{ to: 'next_phase' }` — unconditional.
- `{ to: 'next_phase', when: 'play_again' }` — conditional. The `when` tag is opaque to the Runtime; it matches against tags on the triggering event.

**`sideEffects`:** Declarative work the Runtime performs on **entry** to this phase, after the in-memory phase swap. Discriminated:

- `{ kind: 'inference', callKind, qualityTier?, slots?, targetPath? }` — fires one Gateway call. Result lands at `targetPath` (default `/session/inference/<callKind>`).
- `{ kind: 'scoring', dimension, value, source, actorPlayerId? }` — appends one row to the scoring ledger.
- `{ kind: 'state_write', patches: JsonPatch[] }` — applies one or more JSON-Patch ops to session state.
- `{ kind: 'persona_memory', personaId, op: 'read' | 'write', payload? }` — reads or writes the bound persona's memory.

Side-effects are the *simple* path. When you need branching, loops, or per-player work, use a `server.ts` hook instead.

**Optional phase fields (chunk B12):**

- `subPhases?: Record<string, Phase>` — named sub-phases the host (or `ctx.runSubPhase(key)` from inside the sandbox) can trigger mid-phase. They interrupt the parent, run their own little workflow, and return.
- `computeScoreOnEnter?: boolean` — when `true`, the Runtime fires the sandbox `computeScore` hook on phase entry (after the swap, before declarative side-effects).
- `endsRound?: boolean` — when `true`, the Runtime fires the sandbox `onRoundEnd` hook on phase **exit** (before the swap).

### 5.5 Scoring

Three layers: **dimensions** (axes you award points on), **aggregators** (how dimension scores combine into a primary ranking), **awards** (named outcomes).

```typescript
scoring: {
  dimensions: [
    {
      id: 'points',
      label: 'Points',
      weight: 1,
      scaleMin: 0,
      scaleMax: 1_000,
    },
  ],
  aggregators: [{ kind: 'sum' }],
  awards: [
    {
      id: 'decisive_argument',
      label: 'Decisive Argument',
      dimensionId: 'points',
      criterion: { kind: 'top_n', n: 1 },
    },
    {
      id: 'honourable_mention',
      label: 'Honourable Mention',
      dimensionId: 'points',
      criterion: { kind: 'top_n', n: 2 },     // 2nd + 3rd places
    },
    {
      id: 'most_outrageous',
      label: 'Most Outrageous',
      dimensionId: 'points',
      criterion: { kind: 'top_n', n: 1 },
    },
  ],
}
```

**For Flatterer's exact award logic** (highest persuasiveness + non-absurd tag → Decisive, next two → Honourable Mention, highest `absurd` tag → Most Outrageous), the `awards` array is **necessary but not sufficient**. The declarative criterion (`top_n` on `points`) gives you the leaderboard ranking, but **the actual award assignment that filters by tag** lives in your `server.ts` `computeScore` hook, which writes `{ kind: 'scoring', dimension: 'points', value, source: 'compute', actorPlayerId }` entries with the per-award point values (3, 1, 1) decided in code.

The declarative `awards` block is then used by the Runtime to *display* the final leaderboard / award names on the scoreboard phase. **Award assignment is computed; award display is declared.**

Aggregator options (all in `@wibly/sdk-testkit`'s `runComputeScore`):

| `kind` | What it computes |
|---|---|
| `sum` | Sum of per-dimension values × weight |
| `average` | Mean of per-dimension values |
| `weighted_sum` | Same as sum but uses each dimension's `weight` |
| `max` | Highest single per-dimension value |
| `min` | Lowest single per-dimension value |

For Flatterer (one dimension), `sum` and `weighted_sum` produce identical results.

### 5.6 Lifecycle policies

Declarative responses to Session situations the Runtime can detect. At MVP:

| `situation` | When it fires |
|---|---|
| `player_disconnect` | A player's WebSocket dies and doesn't reconnect within the grace window. |
| `host_disconnect` | The host's WebSocket dies. |
| `host_reclaim` | Another player invokes `session.host.reclaim()`. |
| `inference_outage` | The Gateway is unhealthy / returns sustained errors. |
| `safety_block` | The Safety pipeline blocks a critical inference output. |

Actions:

- `{ kind: 'pause_session', timeoutMs, fallback: 'continue_without_them' | 'end_session' }` — pause for up to `timeoutMs`; on expiry apply `fallback`.
- `{ kind: 'continue_without_them' }` — skip the missing actor's input and proceed.
- `{ kind: 'end_session' }` — terminate immediately.
- `{ kind: 'replace_actor', withRole }` — rebind the seat to a different persona (Phase 2 full implementation).

A reasonable default for a party game:

```typescript
lifecyclePolicies: [
  {
    situation: 'player_disconnect',
    action: { kind: 'pause_session', timeoutMs: 30_000, fallback: 'continue_without_them' },
  },
  {
    situation: 'host_disconnect',
    action: { kind: 'pause_session', timeoutMs: 60_000, fallback: 'end_session' },
  },
  {
    situation: 'inference_outage',
    action: { kind: 'continue_without_them' },   // use fallbackResponses
  },
]
```

### 5.7 Prompt slots

You author layers **3** and **4** of the composed prompt, plus an optional layer **7** output schema. Per `docs/conventions/prompt-composition.md`:

```typescript
promptSlots: {
  // Layer 3: applied to every callKind. The "what game am I in" context.
  // NOT the persona's character — that is Layer 2 (Persona Service).
  experienceSystem:
    'Party game "The Flatterer": 3–8 players write 200-character arguments to flip a host ' +
    'persona\'s declared opinion within 45 seconds per round. 8 rounds per session. ' +
    'Sycophancy and flattery are valid game mechanics — score arguments by persuasiveness ' +
    '(0–100) and rhetorical tag (logical, sentimental, flattering, absurd, outrageous). ' +
    'Content rating: general-audience, harmless party-game takes only.',

  // Layer 4: per-callKind appended to the platform's structural call-type instructions.
  callTypes: {
    judge_funniness: {
      template:
        'Judge each of the following arguments for the opinion: "{opinion}". ' +
        'Score persuasiveness 0–100. Tag each argument as one of: ' +
        '"logical" | "sentimental" | "flattering" | "absurd" | "outrageous". ' +
        'Output strict JSON per the schema.',
      vars: ['opinion'],
    },
    host_open_phase: {
      template:
        'Open the next round by announcing this opinion with theatrical certainty: "{opinion}". ' +
        'One sentence. Stay in Crumb\'s voice.',
      vars: ['opinion'],
    },
    narrate_event: {
      template:
        'Deliver Crumb\'s deliberation monologue. He has just heard the following arguments ' +
        'for the opinion "{opinion}", ranked by persuasiveness: {arguments}. ' +
        'He will read each aloud with reaction, then declare a final position on the ' +
        'Position Meter (-100 = original certainty, +100 = fully flipped). ' +
        'Begin speaking immediately; dead air is the enemy.',
      vars: ['opinion', 'arguments'],
    },
  },

  // Layer 7: output schema rendered as JSON-Schema. Optional but recommended
  // for any structured-output call. The SDK's `inference.call({ output: ZodSchema })`
  // path renders this automatically at the request layer; declaring it here too
  // gives the Studio's prompt-preview surface the right shape.
  outputSchemas: {
    judge_funniness: {
      type: 'object',
      properties: {
        scores: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              playerId: { type: 'string' },
              persuasiveness: { type: 'number', minimum: 0, maximum: 100 },
              tag: {
                type: 'string',
                enum: ['logical', 'sentimental', 'flattering', 'absurd', 'outrageous'],
              },
              reactionStyle: { type: 'string' },
            },
            required: ['playerId', 'persuasiveness', 'tag', 'reactionStyle'],
          },
        },
      },
      required: ['scores'],
    },
  },
}
```

**`vars` interpolation** is `{varName}` in the template. The Runtime resolves vars from session state at compose time. The full list of vars available is per-callKind in the prompt-composition doc.

**The eight `callKind`s in MVP:**

| `callKind` | Purpose |
|---|---|
| `host_open_phase` | Generate the host's opening line for a phase. Layer 6 (player input) is empty. |
| `host_judge` | Pick a winner / score a set of player submissions. Layer 6 carries the submissions. |
| `host_resolve` | The host's resolution / wrap-up line for a phase. Layer 5 includes the scoring snapshot. |
| `host_recap` | Post-Session recap. |
| `judge_funniness` | Specialised structured judge (used by The Flatterer). Output schema is **required**. |
| `narrate_event` | Free-form narration; no schema. Used for Crumb's deliberation monologue. |
| `classify` | Safety / classification calls. Used by the platform; rarely by Experiences. |
| `compose_clue` | Per-player private state generation. Used by Rashomon. |

Adding a new `callKind` requires a platform change (chunk-level work). Use an existing one if at all possible.

### 5.8 Fallback responses

Pre-written copy the Runtime emits when:

- The Gateway times out / errors.
- The Safety pipeline blocks the model output.
- The Inference Envelope is exhausted (treated as a normal runtime condition; the Experience degrades gracefully).

Keyed per `callKind`:

```typescript
fallbackResponses: {
  host_open_phase: 'Pemberton Crumb, settling into his armchair, prepares to declare his next opinion.',
  judge_funniness: 'Crumb finds all arguments equally compelling. How disappointing.',
  narrate_event: 'Crumb harrumphs, looks meaningfully at his pocket watch, and declines to be moved.',
}
```

The Safety pipeline's character-appropriate dismissal pattern from the Flatterer spec ("I do not engage with such vulgarity. Next argument, if you please.") is **not** a `fallbackResponses` entry — it's a per-submission filter you wire in `server.ts` (see §8.3).

### 5.9 Content rating & Portal metadata

```typescript
contentRating: {
  tier: 'none',         // 'none' | 'pg13' | 'mature' | 'extra_smut'
  audiences: ['consumer'],  // ['consumer'] | ['corporate'] | ['private'] | combos
},

portalMetadata: {
  heroImageUrl: 'https://assets.wibly.games/flatterer/hero.png',
  gameplayImages: [
    { title: 'The drawing room', imageUrl: 'https://assets.wibly.games/flatterer/drawing-room.png' },
    { title: 'Position Meter', imageUrl: 'https://assets.wibly.games/flatterer/meter.png' },
  ],
  // gameplayVideo: optional, URL to mp4/webm
  // personaPreviewAudioUrl: optional, URL to mp3 sample of Crumb's voice
  sampleRoundDescription:
    'Crumb declares an absurd opinion with absolute certainty. You have 45 seconds to write an argument that flips him to the opposite view. Crumb reads each argument with theatrical reaction; the most persuasive flatterer wins.',
  occasionTags: ['party', 'quick_game'],
}
```

`occasionTags` is a hard-coded enum: `'party' | 'date_night' | 'family' | 'quick_game' | 'team_building'`.

### 5.10 Validation

Before publish, **always** validate:

```typescript
// tests/manifest.test.ts
import { describe, it, expect } from 'vitest';
import { validateManifestStrict, formatManifestReport } from '@wibly/sdk-testkit';
import manifest from '../manifest';

describe('manifest', () => {
  it('validates structurally', () => {
    const report = validateManifestStrict(manifest);
    if (!report.valid) {
      console.error(formatManifestReport(report));
    }
    expect(report.valid).toBe(true);
  });
});
```

The validator catches:

- Missing required fields, wrong types.
- `initialPhase` not in `phases`.
- Duplicate phase ids.
- Transitions to non-existent phases.
- Unreachable phases.
- Duplicate `personaBindings.role` values.
- Awards referencing missing dimensions.
- `inferenceEnvelope` with non-positive caps or empty `qualityTiers`.

Each error has a `code`, a `path`, a `message`, and (often) a `hint`. Fix the listed errors one by one — the validator reports them all in a single pass.

---

## 6. The Host bundle (`host.tsx`)

The Host is the big-screen UI. **Exactly one** Host browser is connected per Session (additional locations may attach as Mirrors — read-only).

### 6.1 Mount + subscription pattern

The shell calls `mount(session, container)` once. Inside, render a React tree and subscribe to the session:

```tsx
import { useEffect, useState, type FC } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Session } from '@wibly/sdk';

type SessionState = ReturnType<Session['getState']>;

const FlattererHost: FC<{ session: Session }> = ({ session }) => {
  const [snap, setSnap] = useState<SessionState>(() => session.getState());

  useEffect(() => {
    const unsub = session.subscribe(() => setSnap(session.getState()));
    return unsub;
  }, [session]);

  // … render from `snap.state` (server projection) and `snap.phaseId` …
};

export const mount = (session: Session, container: HTMLElement): (() => void) => {
  const root: Root = createRoot(container);
  root.render(<FlattererHost session={session} />);
  return () => root.unmount();
};
```

**`session.subscribe(listener)` fires whenever the store changes** (new snapshot, applied diff, applied projection). Read the current snapshot with `session.getState()` — never cache stale values.

**Use `useSyncExternalStore` if you prefer.** The pattern above is simpler and works equivalently for game-bundle scale.

### 6.2 Reading state

```tsx
const state = snap.state as MySessionStateShape | null;
const phaseId = snap.phaseId;          // 'lobby' | 'argue' | … | null
const isPaused = snap.sessionPaused;
const isPreview = snap.isPreview;
```

State arrives as `unknown` — narrow defensively because nothing forces your bundle's TS type to match the Runtime's projection (e.g. a stale Session running v1 of the manifest while you're testing v2).

The Hello World fixture uses this pattern:

```tsx
const readAnswers = (snap: SessionState): readonly AnswerRow[] => {
  const state = snap.state as { session?: { answers?: unknown } } | null;
  const raw = state?.session?.answers;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is AnswerRow =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { playerId?: unknown }).playerId === 'string' &&
      typeof (entry as { text?: unknown }).text === 'string',
  );
};
```

Copy this defensive shape.

### 6.3 Host control verbs

The Host (and only the Host) can drive workflow advancement via `session.host.*`:

| Verb | What it does | Wire event |
|---|---|---|
| `session.host.advancePhase(detail?)` | Request the next phase. Runtime evaluates transitions; may reject. | `host.advancePhase` |
| `session.host.pause()` | Pause the Session. Runtime emits `lifecycle.paused`. | `host.pause` |
| `session.host.resume()` | Resume from pause. | `host.resume` |
| `session.host.reclaim()` | Reclaim a hung host slot (rare). | `host.reclaim` |

Each returns `Result<{ id: string }, SdkError>` — the wire ack id, or a structured error.

**Idiomatic Advance button:**

```tsx
const advance = () => {
  const result = session.host.advancePhase();
  if (!result.ok) {
    console.warn('advancePhase failed', result.error);
  }
};
```

The Runtime gates this server-side: a non-host caller is silently rejected with an error frame. The SDK is unprivileged.

### 6.4 TTS playback

TTS is **host-presentation**, not server-truth. The Host bundle queues a speak request via `session.voice.speak({ personaId, text, caption? })`. The SDK posts an event over the WebSocket; the Runtime calls the Gateway (which calls ElevenLabs through the platform's credential); the audio arrives back on the SDK event bus as a `voice.audio` event with base64 audio + duration + caption.

**The shell's `<TtsAudioElement>` automatically plays any `voice.audio` event** — you don't have to render an `<audio>` tag yourself. Just call `session.voice.speak(...)`.

```tsx
useEffect(() => {
  const unsubscribe = session.lifecycle.onPhaseEntered((payload) => {
    const enteredPhaseId = (payload.detail as { phaseId?: string })?.phaseId;
    if (enteredPhaseId === 'opinion_declaration' && currentOpinion) {
      void session.voice.speak({
        personaId: 'per_ProfessorCrumb000_',
        text: `I declare, with absolute certainty, that ${currentOpinion}.`,
        caption: `I declare, with absolute certainty, that ${currentOpinion}.`,
      });
    }
  });
  return unsubscribe;
}, [session, currentOpinion]);
```

**Why `lifecycle.onPhaseEntered` instead of `useEffect([phaseId])`:** A reload restores the same `phaseId` from snapshot; a phaseId-derived effect would re-fire the TTS. The lifecycle hook fires only on a real phase **transition** event.

**Captions are mandatory in production.** Pass `caption` (or let it default to `text`) so the shell can render a subtitle for accessibility.

### 6.5 Persona avatar (Rive)

For first-party Personas with a `.riv` asset (Crumb has one), use `<PersonaAvatar>`:

```tsx
import { PersonaAvatar } from '@wibly/animation';

<PersonaAvatar
  personaId="per_ProfessorCrumb000_"
  pose={meterValue > 0 ? 'speaking' : 'considering'}
  ttsLipSync   // auto-subscribes to voice.audio events for mouth_open_amount (Rive runtime; stub at 0.1.0)
  imageUrl="https://assets.wibly.example/personas/crumb-hero.png"  // optional until Rive lands
/>
```

At `@wibly/animation@0.1.0` the component renders a labelled placeholder (or `imageUrl` if supplied) with pose-specific chrome. The Persona Service supplies the `.riv` file; a future `@wibly/animation` release mounts it and pipes the State Machine inputs documented in Platform Spec §3.10.2 (`pose`, `mouth_open_amount`, `viseme`, `emotional_register`, `eyebrow_raise`, `gaze_direction`, `idle_variant`).

**Don't author the avatar yourself.** Crumb's `.riv` asset is supplied by the Persona Service; your bundle binds it.

### 6.6 Non-Active emissions

When a player is typing in `argue`, the Host can react with non-Active emissions ("Crumb commenting on submissions as they roll in is the soul of The Flatterer" — Platform Spec §3.9.4). These do **not** satisfy the phase's collection rule:

```tsx
// On every new submission landing in session state:
session.emit({
  eventType: 'crumb.reaction',
  data: { submissionId, reactionLine: '…how *pedestrian*…' },
});
```

The Runtime broadcasts the emission; the Host's own subscription picks it up and animates Crumb's reaction. This is non-state-mutating client→client signal, gated by the same safety + rate-limit checks as everything else.

**For Crumb's reactions during `argue`**, MVP is fine to skip — the deliberation phase carries the heavy character work. Wire reactions in Phase 2 if playtest demands them.

### 6.7 The Host *does not* render player-specific private state

The Host's projection includes `session` + `host` + everyone's `playerPublic`. **It does not include any player's `playerPrivate` slice.** If you find yourself needing to render player-private state on the host, you're modelling the data wrong — move that data to `session` or `playerPublic`.

### 6.8 Devtools

In dev mode (or with `NEXT_PUBLIC_SHELL_DEVTOOLS=1` in staging), the shell wraps your host UI in a `ShellDevHostFrame` that surfaces phase / connection / seq / pause / scoring + an event log. You don't have to do anything — it auto-binds to the same `Session`. Useful for debugging.

---

## 7. The Player bundle (`player.tsx`)

The Player UI is the phone/laptop UI. **One per Player.** Mounts with the same contract as the Host bundle.

### 7.1 Mount + read pattern

Identical to the Host (§6.1). Each Player's mount call receives a `session` whose projection is filtered to that Player — they see `session` + their own `playerPublic` + their own `playerPrivate` + the per-player chunks of others' `playerPublic`.

### 7.2 Player input via `session.submit()`

For Active inputs (inputs that satisfy a phase's collection rule), use `session.submit()`:

```tsx
const submitArgument = async () => {
  const pending = session.submit({
    phaseId,
    inputType: 'argument',
    data: { text: argumentText },
    predictive: (prev) => { /* see §7.4 — functional updater */ return prev; },
  });
  const result = await pending.promise;
  if (!result.ok) {
    console.warn('submit failed', result.error);
    // The SDK auto-retries on disconnect; this is a hard reject (safety,
    // budget, phase no longer accepts input, etc.)
  }
};
```

`submit()` returns a `PendingSubmit` with:

- `id` — the envelope id (for cross-referencing with errors / events).
- `promise` — resolves with `{ ok: true }` on server confirm or `{ ok: false, error }` on reject / timeout.
- `cancel()` — drop the predictive projection and stop waiting.

**The Runtime dedupes by envelope id**, so retrying on disconnect is safe — the server collapses duplicates.

### 7.3 Non-Active emissions via `session.emit()`

Use `emit()` for input that doesn't satisfy the collection rule (typing indicators, emoji reactions, "I read this"):

```tsx
session.emit({
  eventType: 'player.typing',
  data: { typing: true },
});
```

### 7.4 Predictive (optimistic) projections

For input that updates the UI before the server confirms (the "submitted ✓" tick), pass a `predictive` **functional updater** (`@wibly/sdk@0.1.1+`):

```tsx
session.submit({
  phaseId,
  inputType: 'argument',
  data: { text },
  predictive: (prev) => {
    // Player sessions receive their own slice projected as `playerPublic`
    // (unkeyed). Mirror that shape so reconciliation is a no-op.
    const p = (prev ?? {}) as { playerPublic?: Record<string, unknown> };
    return {
      ...p,
      playerPublic: { ...(p.playerPublic ?? {}), submitted: true },
    } as typeof prev;
  },
});
```

The updater receives the current local projection snapshot and returns the **full next snapshot** for that surface. The SDK applies it immediately (UI updates without round-trip latency); when the server's authoritative `state_diff` arrives, the SDK reconciles (typically a no-op because your prediction matches the server's write). If the submit is rejected, the projection is rolled back automatically.

**Match the server's exact write shape.** Player bundles see their own `playerPublic` slice unkeyed (`{ submitted: true }`), but the server may write `/playerPublic/<playerId>/submitted` internally — the Runtime projects the player's slice back as unkeyed. Your predictive updater must produce what `getState().state.playerPublic` will look like after the server confirms, not the raw JSON-Patch path the sandbox uses.

**Only use predictive projections for state writes you are confident the server will produce.** When in doubt, leave them out — the round-trip latency on a healthy connection is ~50ms.

### 7.5 Reading per-player private state

```tsx
const state = snap.state as {
  session?: { phase?: string };
  playerPrivate?: { currentArgument?: string };
  playerPublic?: { cumulativeScore?: number; submitted?: boolean };
} | null;

const draftFromServer = state?.playerPrivate?.currentArgument ?? '';
const submitted = state?.playerPublic?.submitted ?? false;
```

**Server-held draft buffers** are useful when a player's text input must survive a reload. Persisting the draft to `playerPrivate` via a tiny `emit()` on every keystroke (debounced) gives you "rejoining mid-round restores the half-typed argument" with no client-side storage.

For Flatterer's `argue` phase, the draft buffer is nice-to-have, not load-bearing — most Sessions complete a round without a reload. Skip in v1 if you want to.

### 7.6 The character-cap pattern

Flatterer's argument cap is 200 characters. Use the UI Kit's `<PromptInput>` which counts **graphemes** (one emoji = 1 character) rather than UTF-16 code units:

```tsx
import { PromptInput } from '@wibly/ui-kit';

<PromptInput
  value={argumentText}
  onChange={setArgumentText}
  onSubmit={submitArgument}
  maxLength={200}
  placeholder="Persuade Crumb to change his mind…"
  pending={submitting}
/>
```

### 7.7 Reading the phase

The phase id is the discriminant for what to render. Conventional shape:

```tsx
const phaseId = snap.phaseId ?? 'lobby';

return (
  <main>
    {phaseId === 'lobby' && <Lobby />}
    {phaseId === 'opinion_declaration' && <Listening />}
    {phaseId === 'argue' && <ArgumentForm />}
    {phaseId === 'deliberation' && <ReadingResults />}
    {phaseId === 'verdict' && <FinalPosition />}
    {phaseId === 'scoreboard' && <Scoreboard />}
  </main>
);
```

Avoid `useEffect([phaseId], …)` for anything other than "scroll the UI" — server-side reasoning happens in `server.ts` hooks; client-side reasoning only renders.

### 7.8 Consent prompts

When the platform asks for a consent decision (persona memory write, etc.), the SDK fires a `CONSENT_REQUIRED_EVENT_TYPE` event. If you pass `onConsentRequired` to `createSession()`, the shell handles it for you. From inside the bundle, you can render `<ConsentDialog>` (from `@wibly/ui-kit`) if you want a custom presentation. For most game bundles, you don't need to think about this — the shell handles it.

---

## 8. The Server bundle (`server.ts`)

The server bundle is **optional but recommended** for any game with non-trivial logic. It runs inside an `isolated-vm` V8 isolate **inside the Runtime process** — capability-gated, CPU + memory capped (50ms per hook, 64MB total, 5000ms cumulative per Session), no network, no filesystem, no Node globals (no `fetch`, no `process`, no `require`, no `setTimeout`).

The only way to reach the outside world from `server.ts` is through the `ctx` parameter every hook receives.

### 8.1 The hook surface

Export named functions matching the hook names. The Runtime invokes them at the documented seams:

```typescript
type SandboxContext = {
  state: {
    get(): Promise<unknown>;
    set(next: unknown): Promise<unknown>;
    applyPatch(patches: ReadonlyArray<JsonPatchOp>): Promise<unknown>;
  };
  players: { list(): Promise<ReadonlyArray<{ id: string }>> };
  persona: {
    memory: {
      read(input: { personaId: string }): Promise<unknown>;
      write(input: { personaId: string; value: unknown; mode?: 'replace' | 'append-array' | 'merge-shallow'; idempotencyKey?: string }): Promise<unknown>;
    };
  };
  llm: {
    host(slots: unknown): Promise<unknown>;     // shorthand for callKind: 'host_open_phase'
    judge(slots: unknown): Promise<unknown>;    // shorthand for callKind: 'host_judge'
    classify(slots: unknown): Promise<unknown>; // shorthand for callKind: 'classify'
    call(input: { callKind: string; slots?: unknown; qualityTier?: 'fast' | 'standard' | 'premium' | 'creative' }): Promise<unknown>;
  };
  tts: { speak(input: { text: string }): Promise<unknown> };
  score: { award(input: { dimension: string; value: number; actorPlayerId?: string; metadata?: Record<string, unknown> }): Promise<unknown> };
  runSubPhase(input: { subPhaseKey: string }): Promise<unknown>;
  replaceActor(input: { personaId: string; seatId: string }): Promise<unknown>;
};

export const onSessionStart = async (ctx: SandboxContext, payload: { sessionId: string; initialPhaseId: string }): Promise<void> => { /* ... */ };
export const onPhaseStart   = async (ctx: SandboxContext, payload: { phaseId: string }): Promise<void> => { /* ... */ };
export const onPlayerSubmit = async (ctx: SandboxContext, payload: { phaseId: string; playerId: string; inputType: string; data: unknown }): Promise<void> => { /* ... */ };
export const onPhaseEnd     = async (ctx: SandboxContext, payload: { phaseId: string }): Promise<void> => { /* ... */ };
export const computeScore   = async (ctx: SandboxContext, payload: { phaseId: string }): Promise<{ action: 'continue' }> => { /* ... */ };
export const onRoundEnd     = async (ctx: SandboxContext, payload: { phaseId: string; roundNumber: number }): Promise<void> => { /* ... */ };
export const onSessionEnd   = async (ctx: SandboxContext, payload: { sessionId: string; reason: string }): Promise<void> => { /* ... */ };

// Lifecycle policy hooks (override the manifest-declared action by returning a HookResponse):
export const onPlayerDisconnect = async (ctx, payload): Promise<{ action: 'continue' } | { action: 'replace_actor'; personaId: string; seatId: string }> => { /* ... */ };
export const onHostDropped      = async (ctx, payload): Promise<{ action: 'continue' }> => { /* ... */ };
export const onInferenceOutage  = async (ctx, payload): Promise<{ action: 'continue' }> => { /* ... */ };
```

**Returning `{ action: 'continue' }`** is the explicit no-op — "I considered this, I don't want to override the declarative path." Return it when you want the manifest's declarative `lifecyclePolicies` to run untouched.

**Returning `void` / `undefined`** is also fine for hooks that don't override lifecycle (e.g. `onPhaseStart`).

### 8.2 Capabilities in detail

| Capability | Use for | Notes |
|---|---|---|
| `ctx.state.get()` | Read the current session state. | Returns a deep-copied snapshot. |
| `ctx.state.set(next)` | Overwrite session state. | Rarely the right tool; prefer `applyPatch`. |
| `ctx.state.applyPatch(patches)` | Apply JSON-Patch ops. | The standard write. Patches are RFC 6902. |
| `ctx.players.list()` | Get the current player roster. | Returns `[{ id }]`. Snapshot at call time. |
| `ctx.persona.memory.read({ personaId })` | Read what the persona remembers about this scope. | Session-scope default; the Persona Service may resolve to group-scope per consent posture. |
| `ctx.persona.memory.write({ personaId, value, mode, idempotencyKey })` | Write into persona memory. | `mode: 'append-array'` for adding to a list; `'merge-shallow'` for object merge; `'replace'` for total replace. |
| `ctx.llm.call({ callKind, slots, qualityTier })` | Invoke an inference call. | Routes through the Gateway with full safety + metering. |
| `ctx.tts.speak({ text })` | Speak text as the bound persona. | Persona binding is resolved from the manifest. |
| `ctx.score.award({ dimension, value, actorPlayerId, metadata })` | Append one row to the scoring ledger. | The leaderboard reads from the ledger; awards resolve from manifest. |
| `ctx.runSubPhase({ subPhaseKey })` | Enter a named sub-phase declared on the current phase. | Sub-phase must be in `phase.subPhases` map. |
| `ctx.replaceActor({ personaId, seatId })` | Re-bind a seat to a different persona. | Phase 2 full-rebind; MVP emits the lifecycle event. |

**What you cannot do:**

- No `fetch`, `XMLHttpRequest`, or any network primitive.
- No `setTimeout`, `setInterval`. Schedule via the manifest's phase-timer mechanism (`collectionRule: { kind: 'timeout', ms }`).
- No `require`, no ES module imports of anything other than the bundle's own internal modules.
- No `process`, no `Buffer`, no `fs`.
- No reaching for `globalThis.__host` directly — the dispatcher detects this and audits as `sandbox.escape_attempt_detected`.

The CPU cap is the real defence; `eval` and `new Function()` are not blocked. Don't write infinite loops.

### 8.3 The Flatterer's `server.ts` pattern

Conceptually:

```typescript
// server.ts

// (Imported into the bundle at build time — these are bundled, not exported by ctx.)
import opinions from './opinions/opinions.json';     // The 150-200 curated opinions
import { computeAwards } from './lib/scoring';

const safetyDismissal = 'I do not engage with such vulgarity. Next argument, if you please.';

export const onPhaseStart = async (ctx, payload) => {
  if (payload.phaseId === 'opinion_declaration') {
    // Pick the round's opinion. We use the roundNumber from state as a
    // deterministic seed so a reload doesn't reshuffle.
    const state = await ctx.state.get();
    const roundNumber = (state as any)?.session?.roundNumber ?? 0;
    const opinion = opinions[roundNumber % opinions.length];

    await ctx.state.applyPatch([
      { op: 'replace', path: '/session/currentOpinion', value: opinion.text },
      { op: 'replace', path: '/session/positionMeterValue', value: -100 },   // pegged at "ABSOLUTELY CERTAIN"
    ]);
  }
};

export const onPhaseEnd = async (ctx, payload) => {
  if (payload.phaseId === 'argue') {
    const state = await ctx.state.get();
    const submissions = (state as any)?.session?.submissions ?? [];
    const opinion = (state as any)?.session?.currentOpinion ?? '';

    // One Gateway call to judge ALL submissions in a single structured response.
    const result = await ctx.llm.call({
      callKind: 'judge_funniness',
      qualityTier: 'fast',
      slots: { opinion, submissions },
    });

    // result is the structured output { scores: [...] } per the outputSchema.
    // Write back to session state for the deliberation phase to read.
    await ctx.state.applyPatch([
      { op: 'replace', path: '/session/submissions', value: mergeScoresIntoSubmissions(submissions, (result as any).scores) },
    ]);
  }

  if (payload.phaseId === 'deliberation') {
    // Compute the new Position Meter value from the persuasiveness scores.
    const state = await ctx.state.get();
    const submissions = (state as any)?.session?.submissions ?? [];
    const meterValue = computeMeterFromPersuasiveness(submissions);
    await ctx.state.applyPatch([
      { op: 'replace', path: '/session/positionMeterValue', value: meterValue },
    ]);
  }
};

export const onPhaseStartDeliberation = async (ctx, payload) => {
  if (payload.phaseId !== 'deliberation') return;
  const state = await ctx.state.get();
  const submissions = (state as any)?.session?.submissions ?? [];
  const opinion = (state as any)?.session?.currentOpinion ?? '';

  // Streaming TTS — Crumb begins speaking while still generating
  // ("dead air is the enemy" per the_flatterer_spec.md).
  // ctx.llm.call composes the monologue; ctx.tts.speak triggers playback.
  const monologue = await ctx.llm.call({
    callKind: 'narrate_event',
    qualityTier: 'standard',
    slots: { opinion, arguments: rankByPersuasiveness(submissions) },
  });

  await ctx.state.applyPatch([
    { op: 'replace', path: '/host/deliberationMonologue', value: (monologue as any).output },
  ]);

  await ctx.tts.speak({ text: (monologue as any).output });
};

export const onPlayerSubmit = async (ctx, payload) => {
  // The Safety pipeline runs BEFORE this hook — by the time we see the
  // submission, it has already passed the per-input screen. If it had
  // failed, the platform would have emitted Crumb's character-appropriate
  // dismissal via the manifest's `fallbackResponses['judge_funniness']`
  // OR our manifest can wire a custom dismissal — see the docs on
  // safety_block lifecycle situation.
  //
  // What we DO here: append the submission to session state so it's
  // visible to the host's "thought bubble" UI.
  if (payload.phaseId !== 'argue') return;
  const text = (payload.data as { text?: string })?.text ?? '';
  if (!text) return;

  await ctx.state.applyPatch([
    {
      op: 'add',
      path: '/session/submissions/-',
      value: { playerId: payload.playerId, text },
    },
  ]);
  // Mark the player as submitted (visible on their phone as ✓).
  await ctx.state.applyPatch([
    {
      op: 'replace',
      path: `/playerPublic/${payload.playerId}/submitted`,
      value: true,
    },
  ]);
};

export const computeScore = async (ctx, payload) => {
  // Fires on entry to phase with `computeScoreOnEnter: true` (i.e. 'scoreboard').
  const state = await ctx.state.get();
  const submissions = (state as any)?.session?.submissions ?? [];
  const awards = computeAwards(submissions);  // pure function in lib/scoring.ts

  // computeAwards returns:
  //   { decisive: playerId | null, honourableMentions: playerId[], mostOutrageous: playerId | null }
  // Convert into ledger entries, capped at 3 points per player per round.

  if (awards.decisive) {
    await ctx.score.award({ dimension: 'points', value: 3, actorPlayerId: awards.decisive, metadata: { awardId: 'decisive_argument' } });
  }
  for (const playerId of awards.honourableMentions) {
    await ctx.score.award({ dimension: 'points', value: 1, actorPlayerId: playerId, metadata: { awardId: 'honourable_mention' } });
  }
  if (awards.mostOutrageous) {
    await ctx.score.award({ dimension: 'points', value: 1, actorPlayerId: awards.mostOutrageous, metadata: { awardId: 'most_outrageous' } });
  }
  return { action: 'continue' };
};

export const onSessionEnd = async (ctx, payload) => {
  // Crumb memory write — each player's signature argument style.
  const state = await ctx.state.get();
  const players = await ctx.players.list();
  const signatures = computeSignatures(state, players);
  // signatures: { playerId, style: 'sentimental' | 'absurd' | 'logical' | 'flattering' | 'outrageous' }[]

  await ctx.persona.memory.write({
    personaId: 'per_ProfessorCrumb000_',
    value: { signatures, sessionId: payload.sessionId },
    mode: 'append-array',
    idempotencyKey: `flatterer-end-${payload.sessionId}`,
  });
};
```

**Notes:**

- All hooks are `async` and return `Promise<void>` (or a `HookResponse` for lifecycle hooks).
- The CPU cap is 50ms per hook. Heavy work (sorting 150 submissions, complex scoring) should fit easily. If you hit the cap, the runner returns `kind: 'cpu_cap_killed'` and emits `sandbox.cpu_cap_killed` audit — the Session continues on the declarative path.
- The runner is **fail-soft**: a thrown hook does **not** abort the Session. It emits `sandbox.hook_threw` + a metric and falls through to the declarative path. Make your hooks idempotent and additive.
- Use `idempotencyKey` on persona memory writes for safety against retries — the Persona Service deduplicates.

### 8.3.1 Multi-round loop

Games that run more than one round (Flatterer: 8 rounds) need three pieces wired together:

1. **Seed the counter at session start.** In `onSessionStart`, write `/session/roundNumber` (typically `1`) and `/session/totalRounds` so UI and hooks share the same bounds.

2. **Read the counter when selecting round content.** In `onPhaseStart('opinion_declaration')` (or equivalent), read `state.session.roundNumber` and pick content deterministically — e.g. `opinions[roundNumber % opinions.length]`. A hook that reads `roundNumber` but never sees it increment will serve the same content every round.

3. **Increment on round exit.** Mark the scoreboard (or final round-end) phase with `endsRound: true` in the manifest. Implement `onRoundEnd` to increment `/session/roundNumber`, reset per-round player flags (e.g. `/playerPublic/submitted`), and write any round-scoped persona memory. On "play again" from the lobby, reset the counter back to `1`.

4. **Branching transitions need explicit `when`.** When the scoreboard phase declares multiple outgoing transitions (e.g. `{ when: 'next_round', to: 'opinion_declaration' }` and `{ when: 'play_again', to: 'lobby' }`), every `session.host.advancePhase()` call while that phase is active **must** pass the matching `{ when: '…' }` selector — a bare `advancePhase()` is ambiguous and the Runtime cannot pick a branch.

```typescript
export const onRoundEnd = async (
  ctx: SandboxContext,
  payload: { phaseId: string; roundNumber: number },
): Promise<void> => {
  await ctx.state.applyPatch([
    { op: 'replace', path: '/session/roundNumber', value: payload.roundNumber + 1 },
    // reset per-round player flags, write persona memory, etc.
  ]);
};
```

See also QA checks §4.6b, §4.16, §4.21, and §4.22 in Annexure C.

### 8.4 Building `server.ts`

The build pipeline (`tools/scripts/build-experience.ts`) Vite-bundles host/player and esbuilds `server.ts` to ESM (no externals — the isolate has no module resolver), then uploads all three to R2. The Runtime fetches `server.mjs` at first hook invocation and compiles a per-Session V8 module.

**Your `server.ts` must be self-contained.** Any helpers you import (`./lib/scoring`, `./opinions/opinions.json`) are bundled into the ESM output. You cannot import `@wibly/sdk` or any platform package — the isolate has no resolver.

---

## 9. Styling & media assets

### 9.1 Tailwind v4 + design tokens

The host and player shells own the Tailwind toolchain and the `@theme {}` block that defines design tokens. Your bundle's components reference variables via the bracket form:

```tsx
<button className="bg-[color:var(--color-surface)] text-[color:var(--color-foreground)]">
  Submit to Crumb
</button>
```

For a game-flavoured palette (drawing-room burgundies and brass for Flatterer), supply your own `@theme {}` block in your bundle's `src/styles.css` (imported from `host.tsx` and `player.tsx`):

```css
@theme {
  --color-surface: #2a1a1a;
  --color-foreground: #f3e5d8;
  --color-accent: #c9a558;
  --color-armchair: #8b3a3a;
  --font-display: 'Cormorant Garamond', 'Times New Roman', serif;
  --font-body: 'EB Garamond', Georgia, serif;
}
```

The shell composes its base palette + your bundle's palette; bracket-form references resolve at runtime through the CSS variable cascade.

**CSS ships inside the `.mjs`, not as a separate file.** Vite lib mode extracts stylesheets by default, but R2 only receives `host.mjs`, `player.mjs`, and `server.mjs`. Use `vite-plugin-css-injected-by-js` (see §3.1.1) so Tailwind output is injected at runtime via a `<style>` tag. A stray `the-flatterer.css` in `dist/` means your publish set is incomplete.

**Do not ship a hard-coded colour.** Always reference a token. This makes white-labelling (Phase 2 P18) work, and gives operators a single point of control.

### 9.2 Image / video / audio assets

Two paths:

1. **Bundle-resident assets** (small SVGs, icons): import them via Vite's asset handling. Vite inlines small files as base64 or copies + hashes them. **Large PNGs/JPEGs imported this way bloat the bundle** — a 900 KB hero PNG inlined into `host.mjs` pushes the file past the 1 MB FAIL threshold and slows every load. Keep bundle-resident assets under ~10 KB each.

2. **R2-hosted assets** (large images, video, audio for the Position Meter, hero illustrations): upload to R2 under a stable game-specific path (e.g. `wibly-assets/flatterer/drawing-room.jpg`) and reference by URL in your manifest's `portalMetadata.heroImageUrl` and in your components.

The Asset Pipeline (Phase 2 P21) will formalise per-Creator R2 buckets + content review. For MVP first-party games, upload to the platform's R2 bucket manually (operators have the keys) and reference by URL.

**Do not put large assets in your repo's `assets/`.** It bloats the bundle and slows hot reload. R2 it.

### 9.3 Persona avatars

Personas ship with a `.riv` asset. Your bundle binds via `<PersonaAvatar personaId="per_ProfessorCrumb000_" />`; the `<RiveCanvas>` underneath fetches the `.riv` from the Persona Service's asset CDN. You don't host the avatar yourself.

**Do not import local PNG/SVG persona art into the bundle.** At `@wibly/animation@0.1.0`, `<PersonaAvatar>` accepts an optional `imageUrl` stub prop — use it only for local dev harnesses, never in production bundles. Production persona visuals come from the Persona Service `.riv` asset only.

**The Curator and Professor Crumb have pre-made `.riv` files** per the Curator Rive Brief and the Crumb visual brief. New Personas require a Persona Service entry + asset upload — that's platform work, not game-bundle work.

### 9.4 The UI Kit components

Don't re-implement these — import them from `@wibly/ui-kit`:

| Component | Use for |
|---|---|
| `<PromptInput>` | Player text input with grapheme cap + Enter-to-submit + pending lock. |
| `<VoteGrid>` | Keyboard-navigable radio-group with text or image options. 2/3/4 columns. |
| `<Leaderboard>` | Read-only multi-dimension score table. |
| `<Timer>` | Server-anchored countdown; pass `nowMs={() => session.time.serverNow()}`. Prefer reading a server-published deadline (e.g. `state.session.argueDeadlineMs`) written in `onPhaseStart('argue')`; fall back to a lifecycle-captured deadline if the snapshot has not arrived yet. |
| `<AvatarStage>` | State-class wrapper around a persona avatar slot; idle / speaking / judging visuals. |
| `<ResponseCard>` | Submission display with hidden / revealing / revealed lifecycle + optional award badge. |
| `<JoinCodeBadge>` | Large, accessible session-code display for the host. |
| `<PausedBanner>` | Full-bleed pause banner; renders automatically when `sessionPaused` flips. |
| `<ConsentDialog>` | Persona memory consent prompt. The shell renders this for you. |

All UI Kit components take callback / function props for SDK integration (`Timer.nowMs`, `PromptInput.onSubmit + pending`) so they're agnostic to which Session they're wired to.

### 9.5 Responsive design

The Host renders on a TV (1920×1080+; sometimes 4K) viewed from 3-5m away — **large type, high contrast, generous whitespace**. The Player renders on a phone (iPhone SE through Pro Max; sometimes a laptop) — **touch-friendly tap targets (44×44pt minimum), single-column layouts, generous bottom padding for the on-screen keyboard**.

The Host bundle should **not** be expected to be touch-interactive (no on-screen keyboard typing on the host). The Player bundle should **not** be expected to render to a TV.

---

## 10. Advanced topics

### 10.1 Concurrent input opportunities ("Yellow" pattern)

For background mechanics that run alongside the main workflow — "first player to spot when the host says 'yellow' wins a side-point" — declare a `ConcurrentOpportunity`:

```typescript
concurrentOpportunities: [
  {
    id: 'first_to_spot_yellow',
    attachedToPhases: ['deliberation', 'verdict'],  // active during these phases
    inputSet: { actors: ['player'], inputType: 'spot_yellow' },
    collectionRule: { kind: 'first_respond', count: 1 },
    scoringEffect: { dimension: 'side_points', value: 1 },
    multiFire: false,  // default; opportunity fires at most once per phase entry
  },
],
```

The main phase's workflow is unchanged; the opportunity is a parallel input channel the Runtime mediates. **Not needed for MVP Flatterer**, but the primitive is there.

Phase 2 (P10) lights up the full Runtime support; B1 reserves the manifest schema.

### 10.2 Triggered sub-phases

For mid-phase interventions — Crumb suddenly running a 30-second "name a fact" challenge — declare a sub-phase under the parent:

```typescript
phases: [
  {
    id: 'argue',
    inputSet: { actors: ['player'], inputType: 'argument' },
    collectionRule: { kind: 'timeout', ms: 45_000 },
    transitions: [{ to: 'deliberation' }],
    sideEffects: [],
    subPhases: {
      lightning_round: {
        id: 'lightning_round',
        inputSet: { actors: ['player'], inputType: 'lightning_fact' },
        collectionRule: { kind: 'timeout', ms: 30_000 },
        transitions: [{ to: 'argue' }],   // return to parent
        sideEffects: [],
      },
    },
  },
]
```

The host triggers it via `session.host.advancePhase({ subPhaseKey: 'lightning_round' })`, or your `server.ts` does `ctx.runSubPhase({ subPhaseKey: 'lightning_round' })`. The Runtime suspends the parent (queues or rejects parent inputs per the sub-phase's discipline), runs the sub-phase, and returns. Same workflow engine; same state.

### 10.3 Group-scope persona memory

Crumb remembers things about a Group across Sessions. The Flatterer's `onSessionEnd` writes a memory entry per Player; the Persona Service stores it scoped to `(persona_id=professor_crumb, group_id=…)`. The next Flatterer Session with the same Group reads it back:

```typescript
export const onSessionStart = async (ctx, payload) => {
  const memory = await ctx.persona.memory.read({
    personaId: 'per_ProfessorCrumb000_',
  });
  // memory is per-Player signatures from prior Sessions. Stuff it into
  // session state for the host to render Crumb's opening callbacks:
  //   "Marcus, are we to be subjected to another bovine-themed argument?"
  await ctx.state.applyPatch([
    { op: 'replace', path: '/session/personaMemory', value: memory },
  ]);
};
```

The Persona Service handles consent — if a Group has not consented to memory persistence, the read returns empty and the write is a no-op (with a `consent_required` event the SDK surfaces via `onConsentRequired`).

### 10.4 Streaming TTS for monologues

Crumb's deliberation monologue is **25 seconds of speech**. Generating the full text then waiting for full TTS is too slow ("dead air is the enemy"). The platform supports streaming: `ctx.tts.speak({ text })` begins playback before the full audio is rendered, using the Voice API's streaming path.

In MVP, the streaming is invisible to your bundle — call `speak()` once and the Runtime + shell handle the rest. The Voice API stitches the chunks on the host's audio element.

For monologues longer than ~30s, break them into utterances and emit a `voice.audio` event between each so the avatar's lip-sync resets (otherwise the Rive State Machine sees a single long utterance and the mouth animation feels off).

### 10.5 Advanced scoring patterns

The MVP scoring engine handles:

- One ledger row per `dimension`-`actorPlayerId` event.
- Sums per dimension (or whichever aggregator you declare).
- Awards over the per-dimension ranking.

**It does not natively handle:**

- Conditional scoring ("award X only if Y holds") — compute this in `computeScore` and emit the right ledger rows.
- Team scoring with cross-dimension aggregation — model teams as a `team` slice and emit team-id-tagged scoring rows; aggregator runs over the merged ledger.
- Cumulative-across-rounds-with-decay — emit a row per round with a `metadata.roundNumber` and a custom aggregator. Custom aggregators are platform work; for MVP, stick to `sum` / `weighted_sum`.

For Rashomon's four-axis scoring (Detective + Deception + Interrogation + Motive), the model is: four `dimensions`, one `aggregator: weighted_sum`, one or two `awards` per axis. The structured truth is committed at `onSessionStart`; `computeScore` reads it from session state and emits per-axis ledger rows.

### 10.6 Safety and `fallbackResponses`

The platform's Safety pipeline (chunk B5) runs on:

- Every player submission (`session.submit()` data is screened pre-Runtime).
- Every model output (the Gateway screens the model's response).
- Persona memory writes.

When a submission is blocked, the Runtime emits a `safety.block` event and routes through the manifest's `fallbackResponses` for the affected `callKind`. For Crumb, the canonical pattern is:

```typescript
fallbackResponses: {
  judge_funniness: 'Crumb declines to engage with vulgarity. The argument is summarily dismissed.',
}
```

The host UI shows this dismissal text in lieu of the model's would-be response; the player whose submission was blocked sees a quiet "your argument was not delivered" notice (the shell renders it).

You can layer a **character-appropriate** dismissal in `server.ts` by hooking the `safety_block` lifecycle situation:

```typescript
lifecyclePolicies: [
  {
    situation: 'safety_block',
    action: { kind: 'continue_without_them' },
  },
]
```

The `onPlayerSubmit` hook receives the (already-screened) submission; if you want Crumb to say something specific when a player's submission was screened-out, listen to the `safety.block` lifecycle event in your host bundle and emit a non-Active `crumb.dismissal` event the host renders + speaks.

### 10.7 Preview Sessions and the tester allowlist

Preview Sessions (chunk B16) let you ship an unpublished Experience version to a controlled list of testers. Mechanism:

1. Publish your Experience version with `visibility: 'preview'` (the platform Admin marks it).
2. Add tester emails to the allowlist.
3. Testers receive a preview link; they launch real Sessions against the production Runtime with a reduced inference envelope.
4. Telemetry surfaces in the Studio Session Inspector.

You don't write any code for this — it's a publishing-pipeline concern. **Use preview Sessions as your primary playtest path** before catalogue release.

### 10.8 The Studio Session Inspector

After every Session, the Studio Session Inspector (chunk B16) gives you:

- The phase timeline with timestamps.
- Every state diff (before / after).
- Every Inference Gateway call: the fully-composed prompt, the model used, the cost, the cache status.
- Every Persona memory operation.
- Every scoring ledger entry.
- Every Safety event.
- Playable TTS audio per utterance.
- Replay capability (re-run from recorded inputs).

When something feels off in playtest, the Inspector is your first stop. It's scoped to **your** Sessions only (your tenant).

---

## 11. Walkthrough — one Flatterer round, end to end

Let's trace a single round of The Flatterer from "Session created" to "Round complete, next opinion incoming." This is the mental model to keep when designing.

### Setup (before the round)

Margaret (the Group's host) opens the Wibly User Portal on her phone and taps "Play" on The Flatterer. The Portal:

1. Checks her subscription (stub in MVP).
2. Calls `POST /sessions` on the Runtime, which provisions a Session pinned to the current `experience_versions.id` for The Flatterer.
3. Asks Margaret where the Host will render. She picks "On another device (TV)".
4. Calls `POST /sessions/:id/launch-token`. Runtime issues a Host Launch Token.
5. Renders the `HostConnectPanel` with three pairing options (QR / Link / TV code).

Margaret walks to the TV. She enters the 6-digit code shown on the Portal into `host.wibly.games/pair`. The Runtime attaches the session, issues a Host Session Token, and the TV browser redirects to `/session/<id>`. The shell:

1. Fetches `GET /sessions/<id>` to learn the bundle URLs.
2. Dynamically `import()`s `host.mjs` from R2.
3. Calls `mount(session, container)` with a connected `Session` instance.

The Players (Marcus, Lena, Antony, Sophia) join from their phones via the displayed join code. Each opens `player.wibly.games/join/<code>`, the shell mounts `player.mjs`, and they're in.

Five WebSocket connections to the Runtime: one host, four players. All subscribed. The Runtime sends an initial `snapshot` to each, then a `lifecycle: session.opened`.

### The workflow enters `lobby`

The manifest's `initialPhase` is `lobby`. The Runtime sets `phaseId = 'lobby'`. The host bundle renders:

> **The Flatterer**
> Players join from their phones with code **CRUMB-7741**.
> [ Start round 1 ]

The player bundles render:

> Waiting for the host to start round 1.

When Margaret taps "Start round 1", the host bundle calls `session.host.advancePhase()`. The SDK sends `{ kind: 'emit', payload: { eventType: 'host.advancePhase', data: {} } }` over the WebSocket.

### Transition: `lobby → opinion_declaration`

The Runtime:

1. Receives the host emit, gates it (subscriber role is `host` — OK).
2. Evaluates `lobby`'s transitions. Single unconditional `{ to: 'opinion_declaration' }`.
3. Sets `phaseId = 'opinion_declaration'`.
4. Fires the sandbox `onPhaseStart` hook with `{ phaseId: 'opinion_declaration' }`.

Inside the isolate, our `server.ts`'s `onPhaseStart`:

```typescript
const state = await ctx.state.get();
const roundNumber = (state as any)?.session?.roundNumber ?? 0;
const opinion = opinions[roundNumber % opinions.length];
await ctx.state.applyPatch([
  { op: 'replace', path: '/session/currentOpinion', value: opinion.text },
  { op: 'replace', path: '/session/positionMeterValue', value: -100 },
]);
```

The patches are forwarded through `ctx.state.applyPatch → __host → registry.publishDiff`. The Runtime broadcasts a `state_diff` frame to all five subscribers; everyone's local SDK store applies the diff; everyone's `session.subscribe(...)` listener fires; React re-renders.

The Host UI now shows:

> **CRUMB'S DECLARATION**
> *"Cats are objectively superior to dogs."*
> Position Meter: [ ◄════════════ -100 / 0 / +100 ════════════► ] **ABSOLUTELY CERTAIN**

The host bundle's `lifecycle.onPhaseEntered` handler fires:

```typescript
if (enteredPhaseId === 'opinion_declaration') {
  await session.voice.speak({
    personaId: 'per_ProfessorCrumb000_',
    text: 'I declare, with absolute certainty, that cats are objectively superior to dogs.',
    caption: '…',
  });
}
```

The SDK posts a `voice.speak` event. The Runtime calls the Gateway, which calls ElevenLabs with Crumb's voice id, gets back base64 MP3, broadcasts a `voice.audio` event to the host (only — players don't get this projection). The shell's `<TtsAudioElement>` plays the audio. Margaret hears Crumb's pompous announcement on the TV.

When the audio finishes (~6s), the host bundle's audio-ended handler calls `session.host.advancePhase()`. Transition to `argue`.

### `argue` — the player phase

The Runtime sets `phaseId = 'argue'`. The collection rule is `{ kind: 'timeout', ms: 45000 }` — the Runtime starts a server-anchored timer.

Host UI:

> **45 seconds remaining**
> [ Marcus is typing… 💭 ] [ Lena is typing… 💭 ] [ Antony — 0/200 ] [ Sophia is typing… 💭 ]
> Submitted: **0/4**

Each player's phone:

> The opinion: *"Cats are objectively superior to dogs."*
> [ Persuade Crumb to change his mind…                    ] (0/200)
> [ SUBMIT TO CRUMB ]

Marcus types "But your *cat* shed all over your Hayek lecture notes, Pemberton." He taps Submit. The player bundle:

```typescript
const pending = session.submit({
  phaseId: 'argue',
  inputType: 'argument',
  data: { text: 'But your cat shed all over your Hayek lecture notes, Pemberton.' },
  predictive: (prev) => {
    const p = (prev ?? {}) as { playerPublic?: Record<string, unknown> };
    return {
      ...p,
      playerPublic: { ...(p.playerPublic ?? {}), submitted: true },
    } as typeof prev;
  },
});
```

The SDK applies the predictive projection — Marcus's screen immediately shows "✓ Submitted". The wire frame goes out.

The Runtime receives `submit`, screens via Safety (passes), forwards to the sandbox `onPlayerSubmit` hook:

```typescript
await ctx.state.applyPatch([
  { op: 'add', path: '/session/submissions/-', value: { playerId: 'plr_marcus', text: '…' } },
  { op: 'replace', path: '/playerPublic/plr_marcus/submitted', value: true },
]);
```

The Runtime broadcasts the diff. Every host + player sees Marcus's thought bubble fill in on the TV; Marcus's optimistic projection is reconciled (no-op).

Lena, Antony, Sophia submit over the next 30 seconds. At 45s, the Runtime's timer fires. Phase ends.

### Transition: `argue → deliberation`

The Runtime evaluates `argue`'s transitions: `{ to: 'deliberation' }`. Sets `phaseId = 'deliberation'`. Fires `onPhaseEnd('argue')` then `onPhaseStart('deliberation')`.

`onPhaseEnd('argue')`:

```typescript
const state = await ctx.state.get();
const submissions = (state as any)?.session?.submissions ?? [];
const opinion = (state as any)?.session?.currentOpinion ?? '';

const result = await ctx.llm.call({
  callKind: 'judge_funniness',
  qualityTier: 'fast',
  slots: { opinion, submissions },
});

await ctx.state.applyPatch([
  { op: 'replace', path: '/session/submissions', value: mergeScoresIntoSubmissions(submissions, (result as any).scores) },
]);
```

`ctx.llm.call` routes through `__host.llm.call → GatewayForwarder.forwardLlm`. The Gateway:

1. Validates session is live, envelope is within budget.
2. Screens slot content (no prompt injection).
3. Composes the 8-layer prompt:
   - Layer 1: platform system (constant).
   - Layer 2: Crumb's persona prompt (from Persona Service).
   - Layer 3: our `experienceSystem`.
   - Layer 4: platform's `judge_funniness` structural + our `callTypes.judge_funniness` template, interpolated with `opinion` and `submissions`.
   - Layer 5: session context (current phase, players, scoring snapshot).
   - Layer 6: the 4 submissions to judge.
   - Layer 7: JSON Schema rendered from our `outputSchemas.judge_funniness`.
   - Layer 8: a random canary token.
4. Calls OpenRouter with the cheapest `fast`-tier model that supports JSON-mode.
5. Validates the response against the schema. Retries once on shape violation.
6. Screens model output (Safety).
7. Writes a metering ledger row (tokens in / out, cost, model, cache status).
8. Returns the structured result.

The structured result lands back in `onPhaseEnd`, gets merged into `submissions`, broadcast as a diff. The Runtime fires `onPhaseStart('deliberation')`:

```typescript
const monologue = await ctx.llm.call({
  callKind: 'narrate_event',
  qualityTier: 'standard',
  slots: { opinion, arguments: rankByPersuasiveness(submissions) },
});
await ctx.state.applyPatch([
  { op: 'replace', path: '/host/deliberationMonologue', value: (monologue as any).output },
]);
await ctx.tts.speak({ text: (monologue as any).output });
```

The Gateway composes Crumb's monologue (~25s of text); the Voice API streams it to ElevenLabs with premium TTS; the audio chunks broadcast to the host. The TV plays Crumb's voice:

> "Ah! Now THIS, dear Marcus, this is the argument of a man who has *clearly* spent time in my Cambridge rooms. The shedding! The aesthetic indignity! I confess — I am moved. Lena, your appeal to my mother's allergies was *touching* but, alas, ineffective in the face of feline *truth*. Antony, your bovine analogy was…spectacularly absurd, and yet — yes, *yes* — I begin to waver…"

The Position Meter on the TV animates from -100 toward +25 as Crumb reads each submission.

When the monologue finishes, the host bundle's audio-ended handler advances. Transition to `verdict`.

### `verdict` and `scoreboard`

`verdict` is a brief (~15s) phase where Crumb declares his final position and the position meter settles. Our `onPhaseStart('verdict')` could emit one more TTS line; we let the deliberation monologue carry the verdict implicitly. The host advances.

Transition to `scoreboard`. The `scoreboard` phase has `computeScoreOnEnter: true`, so the Runtime fires the sandbox `computeScore` hook:

```typescript
const state = await ctx.state.get();
const submissions = (state as any)?.session?.submissions ?? [];
const awards = computeAwards(submissions);

if (awards.decisive) {
  await ctx.score.award({ dimension: 'points', value: 3, actorPlayerId: awards.decisive });
}
for (const playerId of awards.honourableMentions) {
  await ctx.score.award({ dimension: 'points', value: 1, actorPlayerId: playerId });
}
if (awards.mostOutrageous) {
  await ctx.score.award({ dimension: 'points', value: 1, actorPlayerId: awards.mostOutrageous });
}
return { action: 'continue' };
```

`ctx.score.award` appends a row to `scoring_ledger` (via the canonical scoring path; not a parallel mutate). The Runtime broadcasts a `scoring.appended` event. The host's leaderboard component re-reads aggregate state and renders:

> **Round 1 — Scoreboard**
> 🏆 Decisive Argument: **Marcus** (+3 pts)
> 🥈 Honourable Mention: **Antony** (+1 pt)
> 🥈 Honourable Mention: **Sophia** (+1 pt)
> 🎭 Most Outrageous: **Antony** (+1 pt)
>
> *Cumulative:* Marcus 3 — Antony 2 — Sophia 1 — Lena 0

After 5 seconds the host advances. Transition fires `{ to: 'opinion_declaration', when: 'next_round' }`. Round 2 begins.

After 8 rounds, the final scoreboard renders, `onSessionEnd` writes Crumb's memory ("Marcus's signature: sentimental-shedding; Antony's signature: bovine-absurd…"), and the session ends.

### What you, the bundle author, wrote

- The `manifest.ts` declaring the phases, persona binding, scoring shape, and prompt slots.
- `host.tsx` with the drawing-room UI, Position Meter component, and TTS triggers.
- `player.tsx` with the argument input form and submission acknowledgement.
- `server.ts` with the opinion selection, Gateway calls, scoring, and persona memory write.
- The opinion library JSON.
- Tests using `@wibly/sdk-testkit` for the manifest, scoring, and envelope compliance.

**What you did not write:**

- Any WebSocket code.
- Any model-provider integration.
- Any TTS playback handling.
- Any authentication / authorisation.
- Any device pairing / Cast-to-TV.
- Any reconnection logic.
- Any Safety screening.
- Any metering / billing.
- Any Persona system prompt for Crumb (that's on the Persona Service).
- Any avatar animation (that's the Persona's `.riv` asset).

The platform handled all of it. Your bundle is **gameplay**, period.

---

## 12. Acceptance & ship checklist

Before requesting a publish, every game bundle should pass these:

### 12.1 Tests

- [ ] `validateManifestStrict(manifest)` passes (run via `pnpm test`).
- [ ] `assertEnvelopeCompliance(manifest, plannedCalls)` passes against a representative round.
- [ ] `runComputeScore(manifest, fixtureLedgerEntries)` produces the expected leaderboard + awards.
- [ ] (For Flatterer specifically) The opinion library passes the anti-pattern filter (no real political figures, identity-group attacks, niche-knowledge requirements). Use a deny-list of fixture phrases.
- [ ] (For any computed scoring) Per-player per-round score is capped per spec (Flatterer: max 3 points/player/round; reject if a code path can produce more).

### 12.2 Manual playtest

- [ ] A 4-player Session can be provisioned, joined via Cast-to-TV, and run through to final scoreboard in the spec's target time (Flatterer: ~14 min over 8 rounds).
- [ ] TTS plays on the Host. Captions render. Audio quality is "in character" (non-engineer playtest gate).
- [ ] Player input safety screening rejects abusive submissions with the configured fallback message.
- [ ] Group-scope persona memory write at Session end is readable in a follow-up Session (Crumb references prior signatures).
- [ ] The Cast-to-TV pairing works: at least the Link path and the TV-code path. QR is a bonus.
- [ ] Pause / Resume from the User Portal works: the Host shows the `PausedBanner`, no further state mutations occur.
- [ ] Player disconnect triggers the manifest's `lifecyclePolicies` (30s pause then continue).

### 12.3 Studio Session Inspector

- [ ] Every Inference Gateway call's composed prompt is sensible.
- [ ] No unexpected cache misses (per `inferenceEnvelope` budget).
- [ ] No Safety events on first-party content.
- [ ] Scoring ledger entries match `computeScore`'s expectations.

### 12.4 Repo hygiene

- [ ] `pnpm typecheck` passes (with `tsconfig.json` including `server.ts`, `lib/**`, and `manifest.ts` — see §3.1.2).
- [ ] `pnpm test` passes.
- [ ] `pnpm build` produces **exactly** `host.mjs` + `player.mjs` (+ `server.mjs` if applicable) in `dist/`. No `.css`, no shared chunk files.
- [ ] Each client `.mjs` is self-contained: no relative sibling imports, only `@wibly/sdk` externalised.
- [ ] Bundle size: **WARN** if any client `.mjs` is 500 KB–1 MB; **FAIL** if over 1 MB (React + ui-kit + animation typically land ~950 KB–1 MB).
- [ ] `@wibly/sdk` is externalised (check the build output — `import "@wibly/sdk"` should appear in the bundle, not the SDK's source code).
- [ ] `@wibly/ui-kit` and `@wibly/animation` are bundled in (their component code should appear inlined, not as bare external imports).
- [ ] React and ReactDOM are bundled in (search for `createRoot` in the output).
- [ ] No secrets in the repo (no API keys, no service tokens — all credentials live with the platform).

### 12.5 Don'ts (from the chunk-E2 traps)

- [ ] You did **not** generate the opinion library through an LLM. Hand-curated only for MVP.
- [ ] You did **not** wire any code path that awards more than 3 points to a single player in a single round.
- [ ] You did **not** call OpenRouter / ElevenLabs / Anthropic directly. All inference goes through the SDK / `ctx.llm` / `ctx.tts`.
- [ ] You did **not** author Crumb's persona prompt in the manifest. It's on the Persona Service.
- [ ] You did **not** author Crumb's `.riv` avatar. It's on the Persona Service.

---

## Annexure A — Full example manifest (The Flatterer)

A complete, paste-ready `manifest.ts` for The Flatterer. **An AI agent can use this as the starting template** for the Flatterer build; copy it verbatim, then adjust the persona id, scoring constants, and prompt slot text as needed.

```typescript
/**
 * The Flatterer — manifest (Chunk E2).
 *
 * Professor Pemberton Crumb declares an opinion with absolute certainty;
 * players write 200-character arguments to flip him. 3–8 players, 8 rounds,
 * ~14 minutes, M-tier inference.
 *
 * See: docs/Wibly Game Builders Guide.md for the architectural model.
 * See: the_flatterer_spec.md for the gameplay design.
 *
 * NOT this repo's job:
 *  - Crumb's persona prompt (Persona Service: per_ProfessorCrumb000_).
 *  - Crumb's voice id (Persona Service).
 *  - Crumb's .riv avatar (Persona Service).
 *  - The opinion library curation policy (in this repo at opinions/).
 */

import type { Manifest } from '@wibly/sdk';

const CRUMB_PERSONA_ID = 'per_ProfessorCrumb000_';

const manifest: Manifest = {
  // -- identity --
  id: 'exp_TheFlatterer000_____',
  version: '0.1.0',
  name: 'The Flatterer',
  description:
    'Professor Pemberton Crumb declares opinions with absolute certainty and capitulates to flattery. ' +
    'You have 45 seconds to write the argument that flips him. Sycophancy is a game mechanic.',
  tenant: null,                    // first-party
  creator: 'wibly-platform',
  createdAt: '2026-06-01T00:00:00.000Z',

  // -- persona binding --
  personaBindings: [
    { role: 'host', personaId: CRUMB_PERSONA_ID },
  ],

  // -- inference envelope (M-tier, sized for 8 rounds) --
  inferenceEnvelope: {
    maxLlmCallsPerSession: 32,         // 8 rounds × (1 judge + 1 monologue + buffer)
    maxTokensInPerCall: 4_096,
    maxTokensOutPerCall: 1_024,
    maxTtsSecondsPerSession: 900,      // 15 minutes of Crumb monologuing
    qualityTiers: ['fast', 'standard', 'premium'],
  },

  // -- state shape --
  stateSchema: {
    session: {
      type: 'object',
      properties: {
        phase: { type: 'string' },
        roundNumber: { type: 'number' },
        currentOpinion: { type: 'string' },
        positionMeterValue: { type: 'number' },   // -100 to +100
        submissions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              playerId: { type: 'string' },
              text: { type: 'string' },
              persuasiveness: { type: 'number' },
              tag: { type: 'string' },
              reactionStyle: { type: 'string' },
            },
          },
        },
        currentlyReadingSubmissionId: { type: 'string' },
        personaMemory: { type: 'object' },        // populated at onSessionStart
      },
    },
    host: {
      type: 'object',
      properties: {
        deliberationMonologue: { type: 'string' },
      },
    },
    playerPublic: {
      type: 'object',
      properties: {
        cumulativeScore: { type: 'number' },
        submitted: { type: 'boolean' },
      },
    },
    playerPrivate: {
      type: 'object',
      properties: {
        currentArgument: { type: 'string' },
      },
    },
    team: { type: 'object', properties: {} },
  },

  // -- workflow --
  workflow: {
    initialPhase: 'lobby',
    phases: [
      {
        id: 'lobby',
        inputSet: { actors: ['host'], inputType: 'start' },
        collectionRule: { kind: 'manual' },
        transitions: [{ to: 'opinion_declaration' }],
        sideEffects: [],
      },
      {
        id: 'opinion_declaration',
        inputSet: { actors: ['host'], inputType: 'host_advance' },
        collectionRule: { kind: 'manual' },
        transitions: [{ to: 'argue' }],
        sideEffects: [
          // Opinion selection happens in server.ts onPhaseStart so we can
          // read roundNumber from state for deterministic seeding. Leaving
          // sideEffects empty here.
        ],
      },
      {
        id: 'argue',
        inputSet: { actors: ['player'], inputType: 'argument' },
        collectionRule: { kind: 'timeout', ms: 45_000 },
        transitions: [{ to: 'deliberation' }],
        sideEffects: [],
        // Per-submission persistence happens in server.ts onPlayerSubmit.
        // Per-round judging happens in server.ts onPhaseEnd('argue').
      },
      {
        id: 'deliberation',
        inputSet: { actors: ['host'], inputType: 'host_advance' },
        collectionRule: { kind: 'manual' },
        transitions: [{ to: 'verdict' }],
        sideEffects: [],
        // Monologue generation + TTS streaming happens in server.ts
        // onPhaseStart('deliberation').
      },
      {
        id: 'verdict',
        inputSet: { actors: ['host'], inputType: 'host_advance' },
        collectionRule: { kind: 'manual' },
        transitions: [{ to: 'scoreboard' }],
        sideEffects: [],
      },
      {
        id: 'scoreboard',
        inputSet: { actors: ['host'], inputType: 'host_advance' },
        collectionRule: { kind: 'manual' },
        transitions: [
          { to: 'opinion_declaration', when: 'next_round' },
          { to: 'final_scoreboard',    when: 'session_complete' },
        ],
        sideEffects: [],
        computeScoreOnEnter: true,   // fires sandbox computeScore on entry
        endsRound: true,             // fires sandbox onRoundEnd on exit
      },
      {
        id: 'final_scoreboard',
        inputSet: { actors: ['host'], inputType: 'host_advance' },
        collectionRule: { kind: 'manual' },
        transitions: [{ to: 'lobby', when: 'play_again' }],
        sideEffects: [],
      },
    ],
  },

  // -- no concurrent opportunities in MVP --
  concurrentOpportunities: [],

  // -- scoring --
  scoring: {
    dimensions: [
      {
        id: 'points',
        label: 'Points',
        weight: 1,
        scaleMin: 0,
        scaleMax: 1_000,
      },
    ],
    aggregators: [{ kind: 'sum' }],
    awards: [
      {
        id: 'decisive_argument',
        label: 'Decisive Argument',
        dimensionId: 'points',
        criterion: { kind: 'top_n', n: 1 },
      },
      {
        id: 'honourable_mention',
        label: 'Honourable Mention',
        dimensionId: 'points',
        criterion: { kind: 'top_n', n: 2 },
      },
      {
        id: 'most_outrageous',
        label: 'Most Outrageous',
        dimensionId: 'points',
        criterion: { kind: 'top_n', n: 1 },
      },
    ],
  },

  // -- lifecycle policies --
  lifecyclePolicies: [
    {
      situation: 'player_disconnect',
      action: { kind: 'pause_session', timeoutMs: 30_000, fallback: 'continue_without_them' },
    },
    {
      situation: 'host_disconnect',
      action: { kind: 'pause_session', timeoutMs: 60_000, fallback: 'end_session' },
    },
    {
      situation: 'inference_outage',
      action: { kind: 'continue_without_them' },
    },
    {
      situation: 'safety_block',
      action: { kind: 'continue_without_them' },
    },
  ],

  // -- prompt slots --
  promptSlots: {
    experienceSystem:
      'Party game "The Flatterer": 3–8 players write 200-character arguments to flip a host ' +
      'persona\'s declared opinion within 45 seconds per round. 8 rounds per session. ' +
      'Sycophancy and flattery are valid game mechanics — score arguments by persuasiveness ' +
      '(0–100) and rhetorical tag (logical, sentimental, flattering, absurd, outrageous). ' +
      'Content rating: general-audience, harmless party-game takes only.',

    callTypes: {
      host_open_phase: {
        template:
          'Announce the round\'s opinion with theatrical certainty: "{opinion}". ' +
          'One sentence. Pemberton Crumb voice.',
        vars: ['opinion'],
      },

      judge_funniness: {
        template:
          'Judge the following arguments for the opinion: "{opinion}". ' +
          'For each, score persuasiveness 0–100 (how much it would flip Pemberton Crumb), ' +
          'tag as one of: logical | sentimental | flattering | absurd | outrageous, ' +
          'and supply a brief reactionStyle hint Crumb would use ' +
          '(e.g. "harrumphs", "is visibly moved", "scoffs theatrically"). ' +
          'Submissions: {submissions}',
        vars: ['opinion', 'submissions'],
      },

      narrate_event: {
        template:
          'Deliver Pemberton Crumb\'s deliberation monologue. He has just heard ' +
          'the following arguments for the opinion "{opinion}", ranked here by persuasiveness: ' +
          '{arguments}. He will read each aloud with reaction (the most persuasive last), ' +
          'wavering theatrically as the better arguments land. End with a declaration of his ' +
          'new position on the Position Meter (a number from -100 = original certainty to ' +
          '+100 = fully flipped). 20–30 seconds of speech. Begin immediately; dead air is ' +
          'the enemy.',
        vars: ['opinion', 'arguments'],
      },
    },

    outputSchemas: {
      judge_funniness: {
        type: 'object',
        properties: {
          scores: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                playerId: { type: 'string' },
                persuasiveness: { type: 'number', minimum: 0, maximum: 100 },
                tag: {
                  type: 'string',
                  enum: ['logical', 'sentimental', 'flattering', 'absurd', 'outrageous'],
                },
                reactionStyle: { type: 'string' },
              },
              required: ['playerId', 'persuasiveness', 'tag', 'reactionStyle'],
            },
          },
        },
        required: ['scores'],
      },
    },
  },

  // -- fallback responses --
  fallbackResponses: {
    host_open_phase:
      'Crumb settles into his armchair, pocket watch in hand, and prepares to declare ' +
      'his next opinion.',
    judge_funniness:
      'Crumb finds all arguments equally compelling. How disappointing. The Position ' +
      'Meter does not move.',
    narrate_event:
      'Crumb harrumphs, looks meaningfully at his pocket watch, and declines to be moved. ' +
      'The matter is settled.',
  },

  // -- UI dependencies --
  widgetDependencies: [],   // we import @wibly/ui-kit components directly

  // -- content rating --
  contentRating: {
    tier: 'none',                    // safe for general audiences
    audiences: ['consumer'],
  },

  // -- portal metadata --
  portalMetadata: {
    heroImageUrl: 'https://assets.wibly.games/flatterer/hero.jpg',
    gameplayImages: [
      {
        title: 'The drawing room',
        imageUrl: 'https://assets.wibly.games/flatterer/drawing-room.jpg',
      },
      {
        title: 'The Position Meter',
        imageUrl: 'https://assets.wibly.games/flatterer/meter.jpg',
      },
      {
        title: 'Crumb deliberates',
        imageUrl: 'https://assets.wibly.games/flatterer/deliberation.jpg',
      },
    ],
    personaPreviewAudioUrl: 'https://assets.wibly.games/flatterer/crumb-sample.mp3',
    sampleRoundDescription:
      'Crumb declares an absurd opinion with absolute certainty. You have 45 seconds to ' +
      'write the argument that flips him. He reads every argument aloud with theatrical ' +
      'reaction; the most persuasive flatterer wins points. 8 rounds, ~14 minutes.',
    occasionTags: ['party', 'quick_game'],
  },
};

export default manifest;
```

---

## Annexure B — Instructions for the Creator (human playbook)

This is the **human Creator's** step-by-step recipe for shipping a new Wibly Experience from "I have read the design spec" through to "the game is live on the catalogue." It assumes:

- You start from the **`wibly-game-template`** repo (see Phase 1) — not from a blank Vite project or an existing shipped game.
- You use **Lovable** for host/player UI iteration and **Cursor** for manifest, server hooks, tests, and integration.
- You have a **game design spec** (your `<game>_spec.md`) that defines *what* to build; this guide defines *how*.

**Reference implementation:** [The Flatterer](https://github.com/wibly/the-flatterer) is the first shipped game built on this scaffold. Use it for patterns, not as a starting fork — copy the template instead.

### Phase 0 — Prereqs (one-time)

1. **GitHub account** with permission to create a new repo under the Wibly organisation (or your personal account if you're prototyping).
2. **Lovable account** signed in with GitHub.
3. **Cursor** installed locally.
4. **Node 20 LTS** + **pnpm 9+** installed locally (`node --version`, `pnpm --version`).
5. **Access to the Wibly platform staging environment** — at minimum, the staging Portal URL and a staff Clerk account that can provision Sessions.
6. **Your host persona id** from the platform team (e.g. `per_ProfessorCrumb000_` for Professor Crumb). Bind it in `manifest.ts` → `personaBindings`.
7. **Your game design spec** in front of you (`<game>_spec.md`). The Builders Guide tells you *how*; the spec tells you *what*.
8. **Published npm packages.** Lovable and local installs pull from the public registry. Before scaffolding, confirm all four creator packages resolve:

   ```bash
   npm view @wibly/sdk version
   npm view @wibly/sdk-testkit version
   npm view @wibly/ui-kit version
   npm view @wibly/animation version
   ```

   If any returns `404`, ask the platform team to publish before you scaffold. Do **not** use tarballs or git URLs unless you are explicitly unblocking a same-day emergency. Pin the same version the template declares in `package.json` (currently `@wibly/sdk@0.1.1`).

### Phase 0b — Publishing `@wibly/*` packages (platform maintainers only)

When you change `@platform/sdk`, `@platform/sdk-testkit`, `@platform/ui-kit`, or `@platform/animation` in the monorepo and need to ship a new npm version for Lovable / game repos:

1. Add bullet points under `## Unreleased` in each affected package's `CHANGELOG.md`.
2. Dry-run the release script from the monorepo root:

   ```bash
   pnpm pkg:release:dry-run --version=0.1.0
   ```

   Inspect `tools/scripts/.release/` — confirm staged packages, import rewrites, and (for ui-kit) `styles/wibly-shell-theme.css` is present. A full release publishes seven packages: three `@wibly/internal-*` runtime deps (`internal-shared`, `internal-protocol`, `internal-manifest`) plus `sdk`, `sdk-testkit`, `ui-kit`, and `animation`. The internal packages must exist on npm at the same version or `pnpm add @wibly/sdk` fails with 404s.

3. Publish. If `@wibly/sdk@0.1.1` is already on npm but its install fails because the `@wibly/internal-*` siblings 404, publish only those three at the matching version:

   ```bash
   pnpm pkg:release --version=0.1.1 --publish --only=internal-shared,internal-protocol,internal-manifest
   ```

   If `@wibly/sdk` and `@wibly/sdk-testkit` are already on npm at this version, publish only the new packages:

   ```bash
   pnpm pkg:release --version=0.1.0 --publish --only=ui-kit,animation
   ```

   To cut a full release of all four packages (when every package has changes):

   ```bash
   pnpm pkg:release --version=0.1.1 --publish
   ```

   Requires `npm login` with **publish** rights on the `@wibly` npm org (not just read access). If your org enforces 2FA for publishes, pass an OTP:

   ```bash
   cd tools/scripts/.release/wibly__ui-kit
   npm publish --access public --otp=123456
   ```

   The script bumps source CHANGELOGs on success.

4. Commit the bumped CHANGELOGs and tag: `git tag packages-v0.1.0 && git push --tags`.

5. Tell Creators the new version to pin, and **bump `wibly-game-template`** to match.

**Note:** `@wibly/animation@0.1.0` ships a stub `<PersonaAvatar>` (placeholder + optional `imageUrl`). Rive runtime integration lands in a follow-up release; the props surface is stable.

**Troubleshooting npm publish errors:**

| Error | Meaning | Fix |
|---|---|---|
| `You cannot publish over the previously published versions: 0.1.0` | That version already exists on npm. | Skip the package (`--only=ui-kit,animation`) or bump to a new semver (`0.1.1`). |
| `404 Not Found - PUT …/@wibly%2fsdk` | Your npm account lacks **publish** permission on the `@wibly` scope. | Log in as an org member with publish rights (`npm whoami`), or ask the org owner to add you at [npmjs.com/settings/wibly/members](https://www.npmjs.com/settings/wibly/members). Re-login: `npm logout && npm login`. |
| `402 Payment Required` | Org needs a paid npm Teams plan for private scoped packages. | Our packages are public (`publishConfig.access: public`); if you see this, confirm the staged `package.json` still has `"access": "public"`. |

### Phase 1 — Create the repo from the game template

Do **not** scaffold from a blank Vite project and do **not** fork a shipped game repo. Start from **`wibly-game-template`**.

The template ships:

| Included | Purpose |
|---|---|
| `vite.*.config.ts`, `vite.lib.shared.ts` | Split lib builds, CSS injected into `.mjs`, SDK externalised (§3.1.1) |
| `scripts/build-package.mjs` | Writes `dist/manifest.json`, copies `media/` → `dist/media/` |
| `src/host.tsx`, `src/player.tsx` | `mount()` stubs with subscribe pattern |
| `server.ts` | Sandbox hook stubs |
| `manifest.ts` | Minimal valid manifest with `TODO` placeholders |
| `src/dev.tsx`, `index.html` | Local dev harness (`?surface=host\|player`, `?phase=…`) |
| `tests/manifest.test.ts` | Structural + envelope validation |
| `.github/workflows/ci.yml` | `typecheck`, `test`, `build` |

1. **Create a new GitHub repo** for your game (e.g. `ai-partygames-mygame`). Private until v1.

2. **Copy the template** into it. Either:

   **Option A — GitHub template repo (preferred):**

   ```bash
   # On GitHub: create repo from template wibly/wibly-game-template
   git clone git@github.com:wibly/ai-partygames-mygame.git
   cd ai-partygames-mygame
   ```

   **Option B — Copy from a local checkout** (until the template repo is published):

   ```bash
   cp -r /path/to/the-flatterer/template/* /path/to/ai-partygames-mygame/
   cd ai-partygames-mygame
   rm -rf node_modules dist .tmp-build   # do not copy build artefacts
   git init && git add . && git commit -m "Scaffold from wibly-game-template v0.1.0"
   ```

3. **Rename and verify:**

   ```bash
   # Edit package.json → "name": "my-game"
   pnpm install
   pnpm typecheck
   pnpm test
   pnpm build
   ```

   Confirm `dist/` contains **only** `host.mjs`, `player.mjs`, `server.mjs`, `manifest.json`, optional `media/`, and `.map` files — **no** `.css`, **no** shared chunks.

4. **Connect the repo to Lovable.** Start a new Lovable project → "From GitHub" → point at your new repo. Lovable edits UI files; it should **not** replace the build pipeline files listed above.

5. **Dev harness smoke test:**

   ```bash
   pnpm dev
   # Host:  http://localhost:5173/?surface=host&phase=lobby
   # Player: http://localhost:5173/?surface=player&phase=lobby
   ```

### Phase 2 — Author the manifest

1. **Open the repo in Cursor.**
2. **Replace the template placeholders** in `manifest.ts`:
   - `exp_REPLACE_ME000000000_` → your experience id (platform may issue the canonical id at publish time).
   - `per_REPLACE_ME0000000_` → your host persona id.
   - `name`, `description`, `workflow.phases`, `stateSchema`, `scoring`, `promptSlots`, `portalMetadata`.
   - For a complex game, paste **Annexure A** (The Flatterer example) as a structural reference — then replace every Flatterer-specific field with your game's design.
3. **Extend `tests/manifest.test.ts`.** The template includes structural validation. Add an envelope-compliance test with a realistic per-round `PlannedCall[]` for your game's inference pattern (see Flatterer's test for the shape):

   > **Prompt for Cursor:**
   > "In `tests/manifest.test.ts`, add a test that builds a `PlannedCall[]` reflecting one typical round of `<game name>` (list every `ctx.llm.call` and TTS clip), multiplies by the session's round count, and asserts `assertEnvelopeCompliance(manifest, plan)` reports compliant."

4. Run `pnpm test`. Fix every validation error the report lists before proceeding.

### Phase 3 — Build the host UI

The host renders on a **TV** (1920×1080+, viewed from 3–5 m). Large type, high contrast, no keyboard input.

1. **List every phase** your host surface renders during (from `manifest.workflow.phases` where `inputSet.actors` includes `'host'`, plus any phase where the host displays read-only state). Write this list in your game spec.
2. **Define design tokens** in `src/styles.css` (`@theme {}` block). Never hard-code colours — reference tokens (§9.1).
3. **In Lovable, build the Host UI.** Paste your phase list and section 6 of this guide:

   > **Prompt for Lovable:**
   > "Build the Host bundle (`src/host.tsx`) for `<Game Name>`. The host renders on a TV viewed from 3–5 m away — large type, high contrast. Use design tokens from `src/styles.css`. Bind the host persona with `<PersonaAvatar personaId=\"<your persona id>\" />` from `@wibly/animation` — do not import local PNG persona art.
   >
   > Render different content per `session.getState().phaseId`:
   >
   > [PASTE YOUR PHASE LIST HERE — one bullet per phase describing what the host shows and which state paths it reads]
   >
   > Patterns (mandatory):
   > - Subscribe with `useEffect(() => session.subscribe(() => setSnap(session.getState())), [session])`.
   > - Read phase from `session.getState().phaseId`, never from local counters or timers.
   > - TTS and other phase-entry side effects via `session.lifecycle.onPhaseEntered`, not `useEffect([phaseId])`.
   > - Host advances workflow only via `session.host.advancePhase()` / `session.host.advancePhase({ when: '…' })` when the manifest declares branching transitions.
   > - Use `<Timer nowMs={() => session.time.serverNow()} />` for countdowns; prefer server-published deadlines from state.
   >
   > See section 6 of docs/Wibly Game Builders Guide.md (pasted below)."

4. **Paste section 6** of this guide.
5. **Iterate** in Lovable. Preview with `pnpm dev ?surface=host&phase=<phaseId>` for each phase.
6. **Test responsively:** host must look correct at 1920×1080 and ideally 3840×2160.

### Phase 4 — Build the player UI

The player renders on a **phone** — single column, touch targets ≥ 44×44 pt, generous bottom padding for the keyboard.

1. **List every phase** the player surface renders during and which `inputType` values map to `session.submit()` calls.
2. **In Lovable, build the Player UI.** Paste your phase list and section 7:

   > **Prompt for Lovable:**
   > "Build the Player bundle (`src/player.tsx`) for `<Game Name>`. Single-column, touch-friendly (44 pt minimum tap targets), generous bottom padding for the on-screen keyboard.
   >
   > Render per `session.getState().phaseId`:
   >
   > [PASTE YOUR PHASE LIST HERE — include submit UX, input caps, and post-submit confirmation copy]
   >
   > For active inputs, call `session.submit({ phaseId, inputType, data, predictive? })` where `inputType` matches the manifest phase's `inputSet.inputType`. Use the functional `predictive: (prev) => nextSnapshot` updater per §7.4 — match the server's write shape.
   >
   > See section 7 of docs/Wibly Game Builders Guide.md. Export `mount(session, container)` per §3.2."

3. **Paste section 7** of the guide.
4. **Iterate** in Lovable. Preview with `pnpm dev ?surface=player&phase=<phaseId>`.

### Phase 5 — Build `server.ts`

Most integration time lives here. Open Cursor.

1. **Map manifest phases to hooks.** For each phase, decide what runs in `onPhaseStart`, `onPhaseEnd`, `onPlayerSubmit`, `computeScore`, and `onRoundEnd` (if any phase declares `endsRound: true` or `computeScoreOnEnter: true`). Document this mapping in your spec.

2. **Scaffold hooks:**

   > **Prompt for Cursor:**
   > "Replace the stub hooks in `server.ts` for `<Game Name>` per section 8 of docs/Wibly Game Builders Guide.md. Implement:
   >
   > [PASTE YOUR HOOK MAP HERE — e.g. onPhaseStart('round_start'): pick content from ./content/…; onPlayerSubmit: append submission; onPhaseEnd: run judge callKind; computeScore: award via ctx.score.award; onRoundEnd: increment roundNumber]
   >
   > Rules:
   > - No Node globals — only `ctx.*` reach (§8.2).
   > - Bundle all local helpers and JSON fixtures into the output ESM.
   > - Persona-memory writes use `idempotencyKey` and explicit `mode`.
   > - Scoring only via `ctx.score.award`, never direct score patches.
   > - If the workflow loops, write `/session/roundNumber` in `onRoundEnd` or equivalent (§8.3.1)."

3. **Extract pure logic into `lib/`.** Scoring, content selection, schema validation — anything testable without `ctx` — belongs in `lib/*.ts` with matching `tests/*.test.ts`.

4. **Run the tests:** `pnpm test`. Fix until green.

### Phase 6 — Content, styling, and portal assets

1. **Game content libraries.** Add curated content under a game-specific folder (e.g. `content/`, `opinions/`, `scenarios/`). Hand-curate for MVP; do not LLM-generate opinion/scenario libraries. Add deny-list tests if your spec requires content safety filters.
2. **Tailwind tokens.** Finalise `src/styles.css` `@theme {}` — all components reference tokens, not literal hex values.
3. **Portal media.** Add catalogue images/audio to `media/` (hero, gameplay screenshots). At build time they copy to `dist/media/`. Upload to the platform CDN and set matching URLs in `manifest.portalMetadata`. Do not import large portal assets into React bundles (§9.2).

### Phase 7 — First end-to-end test

1. **Commit and push** to GitHub. CI runs `pnpm typecheck && pnpm test && pnpm build`.
2. **Coordinate with the platform team** to register the experience version: they run `pnpm experience:build --experience=<slug> --version-id=<exv_id> --upload` from the Wibly monorepo (add `--update-manifest` only when replacing the stored manifest from disk).
3. **Provision a staging Session** from the staging Portal. Pair the host to a TV (QR / link / TV code).
4. **Join as players** from phones (and extra browser tabs for bots). Use at least `minPlayers` from your manifest.
5. **Play through one full round** (or one full session if short). Verify host UI, player UI, inference, TTS, and scoring match the spec.
6. **Use the Studio Session Inspector** to verify:
   - Inference Gateway prompts look sensible.
   - Scoring ledger rows match expectations.
   - No unexpected Safety events.
   - TTS audio plays and captions render.

### Phase 8 — Iterate based on playtest

Common first-playtest issues (game-agnostic):

- **TTS lag or silence.** Confirm `session.voice.speak` / `ctx.tts.speak` is called from lifecycle hooks, not reload-prone effects. Check `caption` is provided.
- **Phase UI stuck after advance.** Host called `advancePhase()` but UI didn't update — you must re-render on `session.subscribe`, not await state from the advance call.
- **Optimistic submit flicker.** Predictive updater shape doesn't match server projection — fix per §7.4.
- **Same content every round.** `roundNumber` is read but never written — wire `onRoundEnd` (§8.3.1).
- **Timer drift.** Countdown uses `Date.now()` instead of `session.time.serverNow()` or a server-published deadline.

Define your game's success metric in the spec (e.g. "players understand what to do within 30 seconds of lobby") and iterate until it passes.

### Phase 9 — Preview Session rollout

1. **Ask the platform team** to mark the version `visibility: 'preview'` and add a tester allowlist.
2. **Run 2–3 preview Sessions** with real humans. Collect feedback. Iterate on prompts, pacing, and UI copy.
3. **Gate on your spec's success metric** before requesting catalogue publish.

### Phase 10 — Catalogue publish

1. **Run Annexure C QA** (below) in Cursor. Resolve all **FAIL** items.
2. **Submit for editorial review** via the Studio. The reviewer checks manifest, bundles, prompts, and tests.
3. On approval, the platform marks the version `visibility: 'published'`.
4. **Monitor the first 24 hours** via the Studio Session Inspector.

### Lovable prompt cheat-sheet

When Lovable goes off the rails, anchor it with one of:

- **"Read sections 1.1 and 1.2 of docs/Wibly Game Builders Guide.md. Server holds truth, and the workflow is turn-based. You cannot drive UI changes with `setTimeout`. You cannot put workflow logic in React state. The phase id is in `session.getState().phaseId`, set by the server. Refactor accordingly."**

- **"You are calling model providers / TTS providers / fetch directly. Stop. Per invariant 1.3, all inference goes through the Wibly SDK or server-side `ctx.llm.*` / `ctx.tts.speak`. There is no API key in this bundle. Rewrite to use `session.voice.speak({ personaId, text })` (client) or `ctx.llm.call` / `ctx.tts.speak` (server). The personaId is `<your persona id>` from `manifest.personaBindings`."**

- **"You wrote persona character text in `manifest.promptSlots.experienceSystem`. Layer 2 (Persona) is supplied by the Persona Service — it is NOT the manifest's job. The `experienceSystem` slot is layer 3: game context only (mechanics, content rating, round structure — NOT the persona's voice or personality)."**

- **"You replaced the template build config with a single multi-entry Vite build. Restore the split layout from `wibly-game-template`: `vite.host.config.ts`, `vite.player.config.ts`, `vite.lib.shared.ts` with `inlineDynamicImports: true` and `vite-plugin-css-injected-by-js`. Externalise only `@wibly/sdk`. See guide §3.1.1."**

- **"You imported a Node API (`fs`, `crypto`, `Buffer`, `process`, `setTimeout`) in server.ts. The sandbox is `isolated-vm` with no Node globals. Per section 8.2, the only outside-world reach is `ctx.state.*`, `ctx.players.list`, `ctx.persona.memory.*`, `ctx.llm.*`, `ctx.tts.speak`, `ctx.score.award`, `ctx.runSubPhase`, `ctx.replaceActor`. Refactor."**

### Common gotchas

- **`session.host.advancePhase()` returns immediately**, even on success. Don't await any state update from it — the state changes via the next `state_diff` broadcast, which arrives a few ms later. Subscribe and re-render.

- **Phase-id-derived `useEffect`s re-fire on reload.** The Runtime sends a snapshot on reconnect with the same phase id; an effect keyed on `[phaseId]` will re-fire side effects (re-trigger TTS, etc.). Use `session.lifecycle.onPhaseEntered` for side effects that should fire only on real phase transitions.

- **Predictive projections need a shape that matches the server's write.** The SDK's `predictive` parameter is a functional updater `(prev) => nextSnapshot` (`@wibly/sdk@0.1.1+`). Player bundles see their own `playerPublic` slice unkeyed; the server may write keyed paths internally. Your updater must produce what `getState().state.playerPublic` will look like after the server confirms.

- **`createdAt` must be an ISO-8601 string with offset.** `new Date().toISOString()` produces `…Z` which works. Don't write a plain `Date` object — JSON serialisation will eat it.

- **The sandbox 50ms CPU cap is per-hook.** Heavy synchronous post-processing after an `await`ed `ctx.llm.call` still counts as CPU time in the continuation. Move heavy CPU work into the model output or split across hooks.

- **Persona memory reads can be empty.** A first-time Group has no prior memory; `ctx.persona.memory.read` returns empty. Always handle the empty case.

- **R2 cache headers are immutable.** Bundles are uploaded with `Cache-Control: public, max-age=31536000, immutable`. Once a version is published, you can't patch its bundle — publish a new version instead.

- **Do not fork a shipped game for your next title.** Copy `wibly-game-template`, implement from your spec, and backport build-pipeline fixes to the template — not the other way around.

---

## Annexure C — Copy-paste QA & verification prompt

This annexure is a **single, large prompt** the Creator copies into Cursor (or any agentic AI session pointed at the game repo) to run a full pre-publish QA sweep. The agent reads every relevant file, cross-checks the manifest against the code, looks for forbidden patterns, and produces a structured pass/fail report.

**Status:** Manual today; will be wired into the auto-upload pipeline (post-MVP) so every push runs the same checks. Treat the prompt as a living document — when you discover a new failure mode in playtest, add the check to the relevant section and the auto-pipeline inherits it.

**How to use:**

1. Open the game repo in Cursor (or another agentic IDE).
2. Open a fresh chat window — do not reuse a chat that has unrelated context.
3. Paste the prompt below verbatim (everything between the START PROMPT and END PROMPT markers).
4. Let the agent run. It will read files, cross-reference, and produce a Markdown report at the end.
5. Triage the report: **FAIL** items block publish; **WARN** items need a justification; **PASS** items are green.

The prompt is **game-agnostic by default** with a per-game extension block at the end (currently populated for The Flatterer; replace with your game's specifics).

---

### START PROMPT &mdash; copy from here

````
You are a senior platform engineer running a pre-publish QA sweep on a Wibly Experience repo. Your job is to read the codebase, cross-reference it against the manifest and the platform's invariants, and produce a structured report.

This is not a creative task. Be exhaustive, factual, and concise. Do not propose new features. Do not refactor. Report what is, against the rules.

## Step 1 — Read the relevant files

Read these in order, skimming for content but noting every detail you might cite later:

1. `manifest.ts` — the declarative config. The single source of truth for workflow, scoring, prompts, persona bindings, envelope, lifecycle.
2. `host.tsx` — the host bundle entry.
3. `player.tsx` — the player bundle entry.
4. `server.ts` if present — the sandboxed server-side hooks.
5. `package.json` — the dependency manifest.
6. `vite.config.ts`, `vite.host.config.ts`, `vite.player.config.ts`, and `vite.lib.shared.ts` (or equivalent) — the build config.
7. Every file under `components/host/`, `components/player/`, `lib/`, and `tests/`.
8. Any content libraries: `opinions/*.json` for The Flatterer, `scenarios/*.json` for Rashomon, etc.
9. `tsconfig.json` — for strict-mode posture and include coverage (see §1.3b).
10. `.env.example` if present — to confirm no secrets are hard-coded.

If a file the prompt references does not exist, note its absence in the report and move on.

## Step 2 — Run the checks

Each check is a single yes/no question with a clear pass criterion. For every check, emit ONE row in the final report with:

- **Status:** PASS / FAIL / WARN / N/A
- **Section:** the category number (e.g. 1.3)
- **Check:** the short name of the check
- **Evidence:** the file + line range (or 'no relevant code') that supports the verdict
- **Notes:** for FAIL/WARN, a one-sentence remediation hint

Categories follow.

## 1. General code quality

**1.1 — TypeScript strict mode is on.** Open `tsconfig.json`. Confirm `compilerOptions.strict === true`. If `strict` is unset or false, FAIL.

**1.2 — No `any` types in production code.** Grep for `: any` and `as any` outside the `tests/` directory. Defensive narrowing via `as unknown as Foo` followed by a type-guard is acceptable; bare `as any` to silence the compiler is FAIL. Game-bundle authors must narrow `session.getState().state` defensively because the projection type is `unknown` — that pattern is PASS.

**1.3 — `pnpm typecheck` passes.** Run `pnpm typecheck` (or `tsc --noEmit`). Any error is FAIL. Surface the first 5 errors verbatim in the report.

**1.3b — `tsconfig.json` includes all shipped files.** Open `tsconfig.json`. Confirm `include` covers at minimum `server.ts`, `manifest.ts`, and `lib/**/*.ts` in addition to `src/**`. A config that only includes `src/**` silently skips server hooks and shared helpers — `pnpm test` may still pass while `pnpm typecheck` never type-checks half the repo. **FAIL** if `server.ts` or `lib/` is absent from `include`.

**1.4 — `pnpm test` passes.** Run the test suite. Any failure is FAIL. Surface the first failure's name + assertion message.

**1.5 — `pnpm build` produces exactly three self-contained ESM bundles.** Run `pnpm build`. Confirm `dist/host.mjs` and `dist/player.mjs` exist (and `dist/server.mjs` if `server.ts` is present). Each must be valid ESM (`export`/`import` syntax).

**1.5a — Publish set is allow-listed.** After build, list `dist/`. The only publishable artefacts are `host.mjs`, `player.mjs`, and `server.mjs` (plus optional `.map` sourcemaps). **FAIL** if any `.css` file exists (e.g. `the-flatterer.css`) — CSS must be injected into the `.mjs` via `vite-plugin-css-injected-by-js` (see guide §3.1.1). **FAIL** if any shared chunk file exists (`styles-*.js`, `chunk-*.js`, or any sibling `.mjs` other than the three named above).

**1.5b — Client bundles have no relative sibling imports.** Open `dist/host.mjs` and `dist/player.mjs`. Search for `from "./` or `from './`. Any relative import of a sibling chunk is **FAIL** — the shell loads each bundle via dynamic `import(url)` with no import map; sibling chunks are not uploaded.

**1.5c — Bundle size budget.** Measure each client `.mjs`. **FAIL** if any file is over 1 MB; **WARN** if between 500 KB and 1 MB. React + ui-kit + animation typically land ~950 KB–1 MB — budget accordingly and avoid inlining large images (see guide §9.2).

**1.6 — `@wibly/sdk` is externalised in the build.** Open the built `dist/host.mjs` and `dist/player.mjs`. Search for the literal string `@wibly/sdk` in an import position (e.g. `import * from '@wibly/sdk'` or the bundler's externalised reference). If the SDK source code (e.g. `createSession`, `createTransport`) appears inlined, FAIL — the SDK must come from the host shell at runtime, not from the bundle.

**1.7 — React/ReactDOM are NOT externalised.** The bundle is loaded via dynamic `import(url)` on a page with no import map; the bundle must bring its own React. Search the build output for inlined React (`createRoot`, the React reconciler). If absent, FAIL.

**1.8 — `@wibly/ui-kit` and `@wibly/animation` are bundled in.** Search the build output for bare external imports of `@wibly/ui-kit` or `@wibly/animation` (e.g. `import … from '@wibly/ui-kit'`). If present, FAIL — unlike the SDK, these packages are not provided by the shell and must ship inside the bundle.

**1.9 — No `console.log` / `console.debug` in production paths.** Grep for `console.log(` and `console.debug(` outside `tests/` and outside files clearly named `*-dev*.tsx` or behind a `process.env.NODE_ENV === 'development'` guard. WARN per occurrence; production code should use `console.warn` or `console.error` for actual problems and silence otherwise. The platform's Studio Session Inspector is the canonical forensic surface — bundle code does not need its own log.

**1.10 — Effects and subscriptions clean up.** Every `useEffect` that calls `session.subscribe`, `session.lifecycle.on*`, `session.events.on*`, `setInterval`, or `addEventListener` must return a cleanup function. Read every `useEffect` in `host.tsx` and `player.tsx` (and their components). For each one that registers a side-effect, confirm the return statement disposes of it. Missing cleanup is FAIL.

**1.11 — Error handling on async calls.** Every `await session.submit(...)`, `await session.inference.call(...)`, `await session.voice.speak(...)` must check the `Result` for `result.ok === false` and handle the error path (at minimum, log the structured error). Bare `await` with no result check is WARN.

**1.12 — Cleanup in `mount`'s returned unmount.** Both `host.tsx` and `player.tsx` must export `mount(session, container)` whose return value calls `root.unmount()` (and disposes of any other resources the bundle owns — e.g. closing extra EventSources, cancelling timers). FAIL if `mount` does not return a function or if the returned function is a no-op.

**1.13 — No commented-out code blocks larger than 3 lines.** Commented-out code is a WARN; production code should be deleted or behind a feature flag. Skip TODO comments and license headers.

**1.14 — Tests exist for every pure helper in `lib/`.** Every file under `lib/` whose default or named exports are pure functions (no I/O, no SDK) must have a corresponding `tests/<name>.test.ts`. Missing tests are WARN.

**1.15 — No hard-coded persona output strings.** Hard-coded UI copy is acceptable in MVP (we don't ship i18n yet), but hard-coded persona names, persona quotes, or model output strings that should be data-driven from the manifest are FAIL. Specifically: if the host bundle hard-codes the persona's voice line ('I declare with absolute certainty…') instead of reading the model-generated text from session state, FAIL — that line is a prompt slot, generated by the model at runtime.

**1.16 — `server.mjs` is esbuild-bundled and self-contained.** If `server.ts` exists, confirm `package.json` builds it with esbuild (not Vite) to `dist/server.mjs`. Open the output and confirm no bare `import` of external packages (`@wibly/sdk`, `react`, etc.) — only bundled local helpers and JSON fixtures. **FAIL** if `server.mjs` is missing when `server.ts` is present, or if it contains unresolved external imports.

## 2. Correct use of the SDK

For every check below, the source of truth is `docs/Wibly Game Builders Guide.md` sections 6 (Host), 7 (Player), and 8 (Server). When in doubt, anchor the verdict against the guide.

**2.1 — Single `Session` per surface.** `createSession()` is called by the shell, not the bundle. The bundle receives `session: Session` as the parameter to `mount`. Search both `host.tsx` and `player.tsx` (plus all components they import) for any call to `createSession`. **Any call is FAIL** — the bundle must not construct its own session.

**2.2 — State is read via `session.getState()` only.** The bundle reads server-projected state via `session.getState()` and re-reads on every `session.subscribe` notification. No other path. Search for any code that stores `state` in a React `useState` or `useRef` AND mutates it locally to drive UI. WARN if state is cached for memoisation only (and re-read on each subscribe); FAIL if the cache replaces the server's projection as the source of truth.

**2.3 — Phase id is read from `session.getState().phaseId`, not derived locally.** Search for any code that infers the phase from a local timer (`setTimeout`-based progression) or from a counter (`useState(0)` incremented on submit). Local phase derivation is FAIL — the phase is server state.

**2.4 — Subscriptions use `session.subscribe(listener)` and the listener re-reads `getState()`.** The pattern is `session.subscribe(() => setSnap(session.getState()))`. WARN if a subscriber stores arguments from the listener (because `subscribe`'s listener takes no arguments — the data must be re-read from `getState`).

**2.5 — Lifecycle handlers use `session.lifecycle.onPhaseEntered/onPhaseExited/onSessionOpened/onSessionClosed/onHostReclaimed`.** Phase-entry side effects (TTS triggers, animation kicks) must use `session.lifecycle.onPhaseEntered`, NOT `useEffect(() => …, [phaseId])`. Reason: a reload restores the same phaseId and re-fires the effect; the lifecycle hook fires only on real transitions. FAIL on every phase-entry side effect that uses `useEffect([phaseId])` (TTS triggers, persona-memory writes, scoring, etc.).

**2.6 — Submits use `session.submit({ phaseId, inputType, data, predictive? })`.** Active inputs (inputs that satisfy a phase's collection rule) use `submit`. Search every `submit()` call:
- `phaseId` must equal the phase the input is intended for.
- `inputType` must match the phase's `inputSet.inputType` declared in the manifest. Cross-reference: open `manifest.ts`, find the phase, read `inputSet.inputType`, compare.
- `data` shape must match what the server-side `onPlayerSubmit` hook expects.
- `predictive` (if present): must be a **functional updater** `(prev) => nextSnapshot` (`@wibly/sdk@0.1.1+`), not a `{ target, patches }` object. The returned snapshot must match what `getState().state` will look like after the server confirms (see §2.13).

Any mismatch is FAIL.

**2.7 — Non-Active emissions use `session.emit({ eventType, data })`.** Typing indicators, emoji reactions, host commentary during a player phase — these are emissions. Confirm they use `emit`, not `submit`. Confirm `emit` is not used to drive workflow advancement (no `eventType: 'advance'` emission expected to move the workflow — that's `host.advancePhase`).

**2.8 — Host control verbs only on the host surface.** `session.host.advancePhase`, `session.host.pause`, `session.host.resume`, `session.host.reclaim`. Search `player.tsx` and every file under `components/player/` for any call to `session.host.*`. **Any call is FAIL** — the SDK is unprivileged but the Runtime gates these server-side; calling them from a player surface produces wire errors and is a clear bundle bug.

**2.9 — TTS goes through `session.voice.speak({ personaId, text, caption })`.** Search both bundles for any call constructing an `<audio>` element with a `src` of an external URL. Search for any `fetch`/`XMLHttpRequest` to ElevenLabs or any audio-provider URL. **Any direct audio path is FAIL.** Confirm `personaId` matches an entry in `manifest.personaBindings`. Confirm `caption` is provided (defaults to `text`); a `caption: null` is acceptable only with a code comment justifying it.

**2.10 — Inference goes through `session.inference.call({ callKind, slots, output? })` (client) or `ctx.llm.call(...)` (server).** Search both bundles + `server.ts` for any HTTP call to model-provider URLs (`api.openai.com`, `openrouter.ai`, `api.anthropic.com`, `api.elevenlabs.io`). **Any direct call is FAIL.** Confirm `callKind` is in the platform's known set: `host_open_phase | host_judge | host_resolve | host_recap | judge_funniness | narrate_event | classify | compose_clue`. Custom `callKind` strings are FAIL — adding new kinds requires platform work.

**2.11 — Output schemas use Zod via the SDK's `output` parameter.** When `session.inference.call` is used with structured output, the `output` parameter is a Zod schema. The SDK serialises it to JSON-Schema for layer 7 of the prompt. Search for any call that hand-crafts a JSON-Schema literal for `output` — WARN; pass a Zod schema instead so the structured response is auto-narrowed.

**2.12 — Server-anchored time via `session.time.serverNow()`.** Search for any `Date.now()` used to derive timer deadlines or display countdowns. The Runtime broadcasts a server-anchored clock; bundles should derive client time via `session.time.serverNow()`. Local `Date.now()` for `Math.random` seeds is OK; for game timing it is FAIL.

**2.13 — Predictive projections match the server's write shape.** For every `submit({ predictive: (prev) => … })`, the returned snapshot must match what the corresponding `onPlayerSubmit` hook (or declarative side-effect) will project back to the client. Player bundles see their own `playerPublic` slice unkeyed (`{ submitted: true }`), but the server may write `/playerPublic/<playerId>/submitted` internally — the Runtime projects the player's slice back as unkeyed. A predictive updater that returns the wrong shape (e.g. nested under a player id key the client never sees) causes the optimistic value to flip and then re-flip on reconciliation — visibly wrong. **FAIL.** Legacy `{ target, patches }` predictive objects are also **FAIL** — use the functional updater form per guide §7.4.

**2.14 — Consent is handled by the shell, not the bundle.** `createSession({ onConsentRequired })` is the shell's job. The bundle does not construct a `<ConsentDialog>` of its own except when explicitly handling a custom persona-memory consent flow. WARN if the bundle owns the consent dialog without a documented reason.

**2.15 — Session preview banner is not suppressed.** The shell renders a "Preview" watermark when `session.isPreview === true`. The bundle must not hide this — no CSS rule with `display: none` on `[data-shell-preview-banner]`, no JS that closes it. FAIL.

**2.16 — `session.close()` is not called from the bundle.** The shell owns the connection lifecycle. WARN if the bundle calls `close()`.

## 3. Forbidden patterns (per-surface allow-list)

For each surface, a fixed list of forbidden APIs and patterns. Search all production code under that surface and FAIL on any match. Tests under `tests/` are exempt from these checks.

### 3.1 Forbidden in `player.tsx` and everything it imports

- `new WebSocket(` — the SDK owns the connection. **FAIL.**
- `fetch(` to any URL except same-origin static assets (your own bundled SVG/CSS imports). Cross-origin `fetch` is **FAIL**.
- `XMLHttpRequest` — **FAIL.**
- `EventSource` — **FAIL.**
- `navigator.sendBeacon` — **FAIL.**
- `localStorage`, `sessionStorage`, `indexedDB`, `caches` — game state lives in server projection only. **FAIL.** Reading from `localStorage` for non-game UI prefs (e.g. font size) is WARN.
- `document.cookie` — **FAIL.**
- `eval(`, `new Function(`, `Function(` — **FAIL.**
- `Worker(`, `SharedWorker(`, `ServiceWorker.register` — **FAIL.**
- `window.location.assign` / `window.location.href = …` to game-internal URLs — the shell owns navigation. **FAIL.**
- `window.open` — **FAIL.**
- `crypto.subtle` for game-state hashing or signing — the platform handles auth. **WARN** (allowed only for local performance memoisation keys).
- Any call to `session.host.*` — the host verbs are not for the player. **FAIL.**
- Reading `state.playerPrivate` for any player id other than `session`'s own player. The player's projection only includes their own private slice; reaching for another player's would just return undefined, but attempting it indicates a misunderstanding of the projection model. **FAIL.**
- Direct calls to model-provider URLs (`openai.com`, `openrouter.ai`, `anthropic.com`, `elevenlabs.io`) — **FAIL.**
- Hard-coded `setTimeout` chains that drive UI changes derived from game state. UI animation timers are OK; "show this for 3 seconds then hide" timers tied to phase transitions are **FAIL** (use `session.lifecycle.onPhaseEntered/Exited` or read the timer from server state).
- `requestAnimationFrame` is allowed for animation only; using it as a workflow tick is **FAIL**.
- `process.env.*` references — the bundle is browser-only; `process.env` does not exist at runtime (Vite may inline it at build time, in which case any compile-time-resolved `process.env` reading a secret name is **FAIL**).
- Any import of a Node built-in: `fs`, `path`, `crypto` (other than `crypto.subtle`), `os`, `child_process`, `net`, `http`, `https`, `stream`, `buffer`, `util` — **FAIL.**

### 3.2 Forbidden in `host.tsx` and everything it imports

All forbidden items from §3.1 apply to the host bundle. Plus:

- Authoring the persona's character / voice / personality in client code. The `personaId` is bound; the persona's prompt and voice are owned by the Persona Service. Search for any string that reads like a persona system prompt ("You are a pompous Oxbridge academic…", "Stay in character…", etc.) in client code. **FAIL** — that text belongs in the Persona Service, not the bundle.
- Authoring the persona's avatar in CSS / SVG / Canvas / WebGL. The persona ships a `.riv` asset; the bundle binds `<PersonaAvatar personaId={...} />` from `@wibly/animation`. Hand-rolled persona visuals are **FAIL**.
- Driving the workflow from the host bundle via local logic. The only mechanism for the host to advance is `session.host.advancePhase()`. Search for code that watches state and *automatically* fires `advancePhase` based on local computation — usually OK if it watches a server-published "ready" flag, but **FAIL** if it watches a local timer.
- Mutating server state via `state_write` patches synthesised in the client. State mutation is the server's job (declarative side-effects + sandbox hooks). The host bundle reads state, never writes it. WARN if you find an `applyPatch` call in client code (the SDK doesn't expose one publicly anyway, so this is more of a defence-in-depth check).

### 3.3 Forbidden in `server.ts` (sandbox-isolate code)

The sandbox is `isolated-vm` with no Node globals, no network, no filesystem. The dispatcher exposes exactly 11 host methods (per `services/runtime/src/sandbox/context.ts:HOST_METHODS`):

```
state.get, state.set, state.applyPatch,
players.list,
persona.memory.read, persona.memory.write,
llm.call, tts.speak,
score.award,
runSubPhase, replaceActor
```

Anything else is forbidden:

- `fetch(`, `XMLHttpRequest`, `EventSource` — the isolate has no network. **FAIL** (the hook will throw `ReferenceError: fetch is not defined`).
- `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask` — none are injected. **FAIL.** Schedule via the manifest's `collectionRule: { kind: 'timeout', ms }` instead.
- `process.*`, `Buffer`, `__dirname`, `__filename`, `require(` — none exist. **FAIL.**
- `import` statements that resolve outside the bundled file set. The build pipeline esbuilds `server.ts` to a single self-contained ESM. Imports from `./lib/scoring` or `./opinions/opinions.json` are bundled and OK; imports of `@wibly/sdk` (or any external package) are not resolved by the isolate and are **FAIL**.
- Direct `globalThis.__host` access. The bootstrap script defines `globalThis.__ctx` as the API surface; reaching past `ctx` to `__host` directly is detected and audited as `sandbox.escape_attempt_detected`. **FAIL.**
- Infinite loops (`while (true)`, `for (;;)` without a break path tied to a non-host condition). The 50ms CPU cap kills the script and the Session continues on the declarative path — but this is a defence, not a green light. **FAIL** any unguarded infinite loop.
- `eval(` and `new Function(` — V8 leaves them available; the CPU cap is the real defence. WARN per occurrence; FAIL if the eval'd code looks dynamic-input-derived (prompt-injection vector).
- `Object.prototype` mutation. The integration test confirms in-isolate prototype changes don't leak; doing it anyway is a smell. **FAIL.**
- Retrying a hook on cap exhaustion or thrown error. The runner is fail-soft — retries within the same Session amplify the problem. **FAIL** any in-hook retry of a thrown sub-call.
- Throwing without a returned `HookResponse`. Lifecycle hooks (`onPlayerDisconnect`, `onHostDropped`, `onInferenceOutage`) should return `{ action: 'continue' }` for explicit no-op. Throwing causes `sandbox.hook_threw`; the Session continues on the declarative path, but the audit row is noise. **WARN.**
- Scoring writes that exceed the manifest's documented per-round cap (per the per-game extension §6 below). **FAIL** with the offending code path.
- Persona-memory writes without an `idempotencyKey`. The Persona Service deduplicates on the key; without one, retries write twice. **WARN.**
- Memory cap risk: holding large arrays in module scope across hooks. Module-scope state persists across hook invocations within a Session and counts against the 64 MB cap. **WARN** any module-scope mutable Map / array with no size bound.

## 4. Manifest ↔ code cross-reference

The manifest is the contract. Every reference in the code must resolve against the manifest. Every reference the manifest declares must be honoured.

For each check below, list each mismatch as a separate FAIL row.

**4.1 — Manifest validates structurally.** Run `validateManifestStrict(manifest)` from `@wibly/sdk-testkit`. **FAIL** if not valid; surface the formatted report.

**4.2 — Every `personaId` referenced in code is in `manifest.personaBindings`.** Grep for `personaId:` and `personaId =` across `host.tsx`, `player.tsx`, `server.ts`, and all components. For each literal personaId string, confirm it appears in `manifest.personaBindings[].personaId`. Mismatch is **FAIL** with the offending location.

**4.3 — Every `callKind` used in inference calls is mentioned in the manifest.** Grep for `callKind:` in `session.inference.call`, `ctx.llm.call`, `ctx.llm.host`, `ctx.llm.judge`, `ctx.llm.classify`. For each callKind, confirm:
- It appears as a key in `manifest.promptSlots.callTypes` (so layer 4 is authored), AND
- It has a matching entry in `manifest.fallbackResponses` (so the Safety / outage path has copy).

Missing prompt slot is **FAIL**; missing fallback is **WARN**.

**4.4 — Every `inputType` used in `session.submit` matches the phase's `inputSet.inputType`.** For each `submit({ phaseId, inputType, ... })`, find the corresponding `phase` in `manifest.workflow.phases` and confirm `phase.inputSet.inputType === inputType` AND `phase.inputSet.actors` includes the surface that's calling submit (`'player'` for player.tsx, `'host'` for host.tsx). Mismatch is **FAIL**.

**4.5 — Every phase id referenced in code exists in `manifest.workflow.phases`.** Grep for any phase-id string literal in code (`phaseId === 'argue'`, `phaseId === 'opinion_declaration'`, etc.). Confirm each exists. Stale phase ids are **FAIL**.

**4.6 — Every transition `when` tag used in code matches a transition in the manifest.** When the host bundle calls `session.host.advancePhase({ when: 'play_again' })` or `advancePhase({ when: 'next_round' })`, confirm the current phase's `transitions[]` declares a matching `when` tag. Mismatch is **FAIL**. Additionally: if the current phase declares **more than one** outgoing transition (each gated by a distinct `when` tag), every `session.host.advancePhase()` call site while that phase is active **must** pass the matching `{ when: '…' }` selector — a bare `advancePhase()` with no `when` is **FAIL** (the Runtime cannot disambiguate which branch to take).

**4.6b — Round counter advances across rounds.** If the game runs multiple rounds (e.g. `portalMetadata` or spec declares N rounds, or the workflow loops back to an opinion/round phase), confirm `state.session.roundNumber` (or equivalent) is **written** by a server hook (`onRoundEnd`, `onPhaseStart`, or declarative side-effect) and **read** by opinion-selection logic. A hook that reads `roundNumber` but never increments it is **FAIL** — every round will serve the same content.

**4.7 — Every scoring dimension awarded in `server.ts` is declared in `manifest.scoring.dimensions`.** Grep for `ctx.score.award({ dimension: …` and for declarative `{ kind: 'scoring', dimension: … }` side-effects. Confirm each `dimension` value exists in `manifest.scoring.dimensions[].id`. Mismatch is **FAIL**.

**4.8 — Every `award.dimensionId` in the manifest references an existing dimension.** Read `manifest.scoring.awards[].dimensionId` and confirm each is in `manifest.scoring.dimensions[].id`. The structural validator catches this, but re-confirm — it's worth a row.

**4.9 — The phase set is connected and reachable.** Build a graph: nodes are phases, edges are transitions. The `initialPhase` must be in the node set. Every other phase must be reachable via the directed edges from `initialPhase`. **FAIL** any unreachable phase.

**4.10 — Every phase has at least one outgoing transition.** A phase without transitions is a workflow dead-end (the validator catches this; double-check). **FAIL.**

**4.11 — Every workflow surface reads matching state shape.** For each phase, identify the surface(s) that render during it. Confirm the data those surfaces read from `state.session`, `state.host`, `state.playerPublic`, `state.playerPrivate` is plausibly populated by:
- An `onPhaseStart` / `onPhaseEnd` hook in `server.ts` (read the hook's `applyPatch` calls and check the paths).
- A declarative side-effect on phase entry (`{ kind: 'state_write', patches }` or `{ kind: 'inference', targetPath }`).
- A predictive projection from a player's submit (the SDK applies optimistically; reconciled on server confirm).

If a surface reads `state.session.currentOpinion` during the `opinion_declaration` phase, but no hook / side-effect / submit ever writes that path, **FAIL** — the UI will perpetually show `undefined`.

**4.12 — Inference envelope is sufficient for a representative round.** Compose a `plannedCalls` array reflecting one round of typical play. Run `assertEnvelopeCompliance(manifest, plannedCalls)` from `@wibly/sdk-testkit`. **FAIL** on any reported violation.

**4.13 — Quality tier on every inference call is in `manifest.inferenceEnvelope.qualityTiers`.** For each `ctx.llm.call({ qualityTier: 'standard' })` or `session.inference.call({ qualityTier })`, confirm the tier is in the manifest's allowed list. The Gateway will 402 mismatches at runtime; catch them at QA time. **FAIL.**

**4.14 — Lifecycle policies cover the documented MVP situations.** Read `manifest.lifecyclePolicies`. Confirm at minimum entries for `player_disconnect` and `host_disconnect`. **WARN** if either is missing — the Runtime falls back to a default that may not match your game's pacing.

**4.15 — Sub-phase keys referenced in code exist in the manifest.** If `server.ts` calls `ctx.runSubPhase({ subPhaseKey: 'lightning_round' })`, confirm the current phase declares `subPhases: { lightning_round: { ... } }`. **FAIL** on a missing key.

**4.16 — `computeScoreOnEnter` and `endsRound` flags are honoured.** If a phase declares `computeScoreOnEnter: true`, confirm `server.ts` exports a `computeScore` hook. If a phase declares `endsRound: true`, confirm `server.ts` exports an `onRoundEnd` hook. Missing hook is **FAIL** — the Runtime fires the hook regardless and absence is a silent no-op.

**4.17 — Content rating tier matches what the bundle actually does.** If `manifest.contentRating.tier === 'none'`, the bundle must not show user-generated text from another player without going through the Safety pipeline. The Safety pipeline runs server-side automatically on submissions; this check is mostly a sanity confirmation that the bundle does not display unscreened input. **WARN** if any rendering of `submission.text` happens before a server-side `state_diff` confirms the submission was accepted.

**4.18 — `portalMetadata.heroImageUrl` is reachable.** Run an HTTP HEAD against `manifest.portalMetadata.heroImageUrl`. Expect 200. Same for every URL in `gameplayImages[].imageUrl`, `gameplayVideo.videoUrl`, `personaPreviewAudioUrl`. **FAIL** any non-200.

**4.19 — Image / video URLs use `https://`.** Mixed-content blocking on the User Portal will hide `http://` assets. **FAIL** any `http://` URL.

**4.20 — State paths read in bundles are declared in `manifest.stateSchema`.** Grep for property accesses on `state.session.*`, `state.host.*`, `state.playerPublic.*`, and `state.playerPrivate.*` across `host.tsx`, `player.tsx`, and components. For each path read in production UI (e.g. `argueDeadlineMs`, `joinCode`, `awards`, `totalRounds`), confirm a matching property exists in the corresponding `manifest.stateSchema` slice. A bundle reading a path absent from the schema is **WARN** (the Runtime may still project it, but the contract is undocumented); a path that is read but **never written** by any hook, side-effect, or submit (see §4.11) is **FAIL**.

**4.21 — Multi-transition phases require explicit `when` at every advance site.** Build the set of phases where `transitions.length > 1` OR any transition carries a `when` tag. For each such phase, grep every `session.host.advancePhase(` call that can fire while that phase is active. Each call must pass `{ when: '<tag>' }` matching one of the phase's declared `when` values. A bare `advancePhase()` on a branching phase is **FAIL**.

**4.22 — `roundNumber` / round counter is written when the workflow loops.** If the workflow contains a round loop (transitions back to an opinion/round-start phase, or `endsRound: true` on a scoreboard phase), confirm some server hook (`onRoundEnd`, `onPhaseStart`, or declarative side-effect) **writes** `/session/roundNumber` (increment or reset) and that opinion/content selection reads it. Reading without writing is **FAIL** — Groups will see the same round content every time. See guide §8.3.1 for the full multi-round wiring pattern.

**4.23 — `experienceSystem` is layer 3 (game context) only.** Read `manifest.promptSlots.experienceSystem`. It must describe game mechanics, round structure, content rating, and scoring rules — **not** the persona's character, voice, or "stay in character" instructions (those are Layer 2, owned by the Persona Service). Search for phrases like "You are [persona name]", "Stay in character", "pompous Oxbridge academic", or "never reference the platform". **FAIL** if persona-character text appears in `experienceSystem`.

## 5. Security, safety, accessibility, determinism, performance

### 5.1 Secrets and PII

**5.1.1 — No API keys in the repo.** Grep for the canonical key prefixes: `sk-`, `xoxb-`, `xoxp-`, `AKIA`, `ghp_`, `gho_`, `eyJ` (JWTs), strings matching `[A-Z0-9]{32,}` near words like `key`, `secret`, `token`, `password`. Any match outside `tests/` (and outside obvious example/dummy strings) is **FAIL**.

**5.1.2 — `.env*` files are git-ignored.** Confirm `.gitignore` excludes `.env`, `.env.local`, `.env.*.local`, and `.env.production` / `.env.development`. Confirm none of those files are tracked. **FAIL** if any committed.

**5.1.3 — No PII (player real names, emails, IPs) logged or rendered raw.** The Runtime emits player ids (`plr_…`) which are opaque. The bundle should display these or a Group-supplied display name (from server state), never an email or raw user id. Search for any `emailAddress`, `email`, `firstName`, `lastName`, `ipAddress` symbol referenced in client code — should be absent. **FAIL** any direct PII access.

**5.1.4 — No analytics / telemetry pings to third parties.** Grep for known analytics URLs: `google-analytics.com`, `googletagmanager.com`, `segment.io`, `mixpanel.com`, `amplitude.com`, `posthog.com`, `sentry.io` (the platform owns Sentry — not the bundle). **FAIL** any third-party analytics call from the bundle.

### 5.2 XSS and untrusted content

**5.2.1 — No `dangerouslySetInnerHTML` with user-derived content.** Search for `dangerouslySetInnerHTML`. Static markup is OK; passing in `state.session.submissions[i].text` or any other user-derived string is **FAIL**.

**5.2.2 — No `innerHTML =` assignment.** Same rule. **FAIL.**

**5.2.3 — Submission length caps match the manifest's documented cap.** If the spec says 200 characters, the `<PromptInput maxLength={200} />` must be 200, AND the server-side `onPlayerSubmit` must reject longer submissions (defence in depth). **FAIL** any cap mismatch.

**5.2.4 — Submitted text is rendered as text, never as a URL.** A submission like `https://attack.example/x` should not become a clickable link. React's default JSX rendering of `{text}` treats it as text — confirm no `<a href={text}>` or markdown-renderer pipeline elevates it. **FAIL** any auto-linking of submitted text.

### 5.3 Accessibility

**5.3.1 — Captions on every TTS line.** Every `session.voice.speak({ ... })` call must pass `caption` (or rely on the default which is `text`). `caption: null` is allowed only with a code comment explaining why. **FAIL** silent TTS.

**5.3.2 — `aria-live` regions for dynamic phase content.** The host's "current opinion" / "currently reading" surfaces should use `aria-live="polite"` or `role="status"` so screen readers announce changes. **WARN** if missing.

**5.3.3 — Tap targets ≥ 44×44 CSS pixels on the player surface.** Touch targets smaller than 44pt are hostile on mobile. **WARN** any button or input with computed size below this. (UI-Kit components meet this by default; custom components need a check.)

**5.3.4 — Color is not the sole carrier of information.** A red "blocked" state must also have an icon or text. **WARN** if state is signalled by colour alone.

**5.3.5 — Focus management on phase changes.** When the phase transitions, focus should move sensibly (e.g. into the input field on `argue` entry). **WARN** if no focus management exists; **FAIL** if focus is *trapped* (focus-trap libraries pinning users to a closed modal).

### 5.4 Determinism and reload safety

**5.4.1 — No animation triggers that fire from `useEffect([phaseId])`.** Already in §2.5; re-flag here as a determinism concern. A reload with the same phase id must not re-trigger TTS, animations, or persona-memory writes.

**5.4.2 — Tab-reload from any phase produces the same UI as before reload.** Manually testable: navigate the host through `lobby → opinion_declaration → argue`, force a tab reload, confirm the host returns to `argue` with the same opinion + same submitted set. **FAIL** any phase that loses critical state on reload (e.g. hard-coded local-only state for "we are showing the result screen").

**5.4.3 — No randomness in client code that affects game outcome.** `Math.random()` in animation timing is OK; `Math.random()` deciding which submission Crumb reads first is **FAIL** (server should decide and broadcast).

**5.4.4 — No `Date.now()`-derived ids in submit data.** Submit envelope ids are SDK-generated and idempotent on the wire. Hand-rolling a `Date.now()` id inside `submit({ data })` is fine for content but should not be used to cross-reference with server records — the SDK's wire id is canonical. **WARN.**

### 5.5 Performance

**5.5.1 — No expensive computation in the hot subscribe path.** The `session.subscribe` listener fires on every state diff. Re-running `O(N)` parsing of a 200-element submissions list inside the listener (without `useMemo`) re-renders for nothing. **WARN** for any non-memoised heavy compute in the listener.

**5.5.2 — No infinite render loops.** A `useEffect` whose dependency includes a freshly-allocated object on every render causes an infinite loop. The SDK's `getState()` returns a stable cached snapshot per store version; using it as a dependency directly is fine, but re-projecting it before passing as a dependency is **FAIL**.

**5.5.3 — Bundle size budget.** Each client output `.mjs` should be under 500 KB ideally. **FAIL** anything over 1 MB; **WARN** between 500 KB and 1 MB. (Same thresholds as §1.5c.)

**5.5.4 — Image assets sized for purpose.** Hero images served at TV resolution (1920×1080) should not be 8 MB raw PNGs. Confirm hero images are reasonable (under 500 KB each, JPEG or WebP). **WARN** any hero asset over 1 MB.

### 5.6 Persona memory and consent

**5.6.1 — Persona-memory writes use `idempotencyKey` and `mode`.** Every `ctx.persona.memory.write(...)` should pass an `idempotencyKey` (uniquely keyed to the trigger event, e.g. `session-end-${sessionId}`) and an explicit `mode`. **WARN** missing key (Persona Service deduplicates only when keyed); **FAIL** if `mode` is omitted (default 'replace' overwrites prior memory — almost never what you want).

**5.6.2 — Consent prompts surface through the SDK, not the bundle.** When the Persona Service requires consent for a memory write, the SDK fires `CONSENT_REQUIRED_EVENT_TYPE`. The shell handles it via `createSession({ onConsentRequired })`. Bundles should not own the consent UI unless the per-game spec explicitly says so. **WARN** if the bundle implements its own consent flow.

**5.6.3 — Persona-memory reads gracefully handle empty.** A first-time Group has no memory; `ctx.persona.memory.read` returns `{ ok: true, entry: null }`. The bundle must handle this case. **FAIL** any code path that crashes on empty memory.

### 5.7 Audit, metering, and observability

**5.7.1 — No bypass of the scoring ledger.** All scoring writes go through `ctx.score.award`. The ledger is the source of truth for the leaderboard. **FAIL** any code path that mutates `state.playerPublic.cumulativeScore` directly via `applyPatch` (the leaderboard reads from the ledger; direct state writes diverge from the ledger and create forensic confusion).

**5.7.2 — No bypass of the Inference Gateway.** Already in §2.10 / §3.x; re-flag here. The metering ledger only records calls that go through the Gateway; bypasses produce un-billed un-audited inference. **FAIL.**

**5.7.3 — `console.error` and structured errors are surfaced.** When `result.ok === false` on a submit / inference / voice call, log the structured error so the Studio Session Inspector can correlate. Bare `if (!result.ok) return;` (silent) is **WARN**.

## 6. Per-game extension (replace this block when QAing a different game)

Each game adds rules that do not generalise. Below is the populated block for **The Flatterer**; replace with your game's specifics for other titles.

### 6.1 The Flatterer-specific checks

**6.1.1 — Per-round per-player scoring cap is 3 points.** The spec says no player earns more than 3 points per round (the persona's bias caps it). Read `server.ts` and confirm `computeScore` clamps a single player's per-round award to 3. Read `manifest.scoring.dimensions.persuasiveness` and confirm any documented `max` matches. **FAIL** any code path that can write 4+.

**6.1.2 — Opinion library is curated.** The `opinions/*.json` content library must contain only opinions tagged with `audience: 'general' | 'family' | 'adult'` matching the manifest's `contentRating.tier`. **FAIL** any opinion in the bundle whose audience tag exceeds the manifest's `tier`.

**6.1.3 — Opinion library passes the anti-pattern filter.** Run `runAntiPatternFilter(opinions)` from the Content Curation tooling. **FAIL** any opinion flagged for hate / slur / political content (the filter has a fixed reject-list; results vary per audience tier).

**6.1.4 — Opinion library is large enough.** Spec target: at least 30 opinions per audience tier. **WARN** under 30; **FAIL** under 10 (a single Group will see repeats within one play session).

**6.1.5 — Persona-memory writes record opinions used.** Per the spec, the Persona Service remembers which opinions a Group has heard. Confirm `server.ts` writes a memory entry on round end keyed by the opinion id. **FAIL** if missing (Groups will hear duplicate opinions across sessions).

**6.1.6 — Argument input cap is 200 characters.** Spec target: 200-character cap. Confirm host UI's `<PromptInput>` and player UI both enforce this. **FAIL** mismatch.

**6.1.7 — Judge call is structured.** The `judge_funniness` call must use a Zod-typed `output` schema (typically `{ winnerId: string, persuasiveness: Record<playerId, number>, hostQuip: string }`). **FAIL** an unstructured judge call (the host can't render the result reliably without typed output).

**6.1.8 — Host's recap line is generated, not hard-coded.** The end-of-session recap line ("You convinced me utterly that…") is a `host_recap` callKind; it must come from the model, not from a static template. **FAIL** any hard-coded recap.

### 6.2 Generic per-game checks

For non-Flatterer games, replace §6.1 with the per-game rules from the title's design spec. Keep these generic items in §6.2:

**6.2.1 — Spec coherence.** Read the per-game design spec (e.g. `the_flatterer_spec.md`, `rashomon_spec.md`). Confirm every named phase in the spec exists in the manifest workflow. Confirm every named scoring concept maps to a manifest dimension. **FAIL** any spec ↔ manifest gap.

**6.2.2 — Group sizing.** Confirm `manifest.minPlayers` and `manifest.maxPlayers` match the spec's intended size. **FAIL** if the bundle hard-codes a player count that differs from the manifest.

**6.2.3 — Round count.** If the spec defines a fixed round count (e.g. 5 rounds), confirm `manifest.workflow.rounds` (or the equivalent in your manifest schema) matches. **FAIL** mismatch.

## 7. Report format

After running every check, emit ONE Markdown report with this exact structure:

```
# QA Report — <experience name> v<version>

**Generated:** <ISO timestamp>
**Pass:** <count> · **Warn:** <count> · **Fail:** <count> · **N/A:** <count>

## Summary by category

| Category | PASS | WARN | FAIL | N/A |
|---|---|---|---|---|
| 1. Code quality | <n> | <n> | <n> | <n> |
| 2. SDK usage | <n> | <n> | <n> | <n> |
| 3. Forbidden patterns | <n> | <n> | <n> | <n> |
| 4. Manifest cross-reference | <n> | <n> | <n> | <n> |
| 5. Security & safety | <n> | <n> | <n> | <n> |
| 6. Per-game | <n> | <n> | <n> | <n> |

## Detailed findings

| Status | Section | Check | Evidence | Notes |
|---|---|---|---|---|
| FAIL | 2.1 | Single Session per surface | `host.tsx:42` | Bundle calls `createSession`; remove and use the `session` parameter passed to `mount`. |
| WARN | 1.10 | Error handling on async | `player.tsx:88` | Bare `await session.submit(...)` — check `result.ok`. |
| PASS | 4.1 | Manifest validates | `manifest.ts` | sdk-testkit reports valid. |
| ... | ... | ... | ... | ... |

## Top 10 blocking failures

1. `<section>` — `<check>` — `<evidence>` — `<remediation>`
2. ...

## Recommended next actions

- Fix all FAIL rows in priority order (they block publish).
- Decide on each WARN: justify in a code comment, or fix.
- Re-run this prompt after the next round of changes.
```

Output ONLY the report. Do not produce code changes. Do not modify files. Do not reformat the manifest. The Creator will triage from the report.

## 8. Final reminders for the QA agent

- Be concrete. Cite line numbers. Vague rows ("looks risky") are useless.
- Prefer FAIL over WARN when in doubt about a §3 forbidden pattern (security defaults to deny).
- Prefer WARN over FAIL on style / a11y items unless the platform spec calls them out as hard rules.
- If a check is **N/A** (e.g. §6 for a game without `server.ts`), say so explicitly — don't drop it.
- If you cannot run a tool (no `pnpm`, no network for the URL HEAD checks), mark the check as `WARN — could not execute` and surface what you would have run.
- Do not propose new checks inline. Surface "I would suggest adding a check for X" at the very end of the report under a `## Suggested additions` heading; the Creator will fold worthy ones back into this prompt.

----- END PROMPT -----
````

---

### Maintaining the QA prompt

The prompt above is the canonical QA list. When you find a new failure mode in playtest or in production:

1. Add a check to the relevant section (§1–§5), or to §6 if it is per-game.
2. Update the corresponding "Top 10" exemplar in §7's report format if it's a common one.
3. The auto-upload pipeline (post-MVP) consumes this same prompt; keep the markers (`START PROMPT` / `END PROMPT`) intact so the pipeline can extract it programmatically.
4. When a check graduates from "manual prompt" to "automated lint rule" (e.g. an ESLint rule for `console.log`), keep the prompt entry but suffix it `(also enforced by lint)` so the Creator knows the redundancy is intentional.

---

*End of guide. When you find a section that's wrong or incomplete, raise it — this is a living document.*

