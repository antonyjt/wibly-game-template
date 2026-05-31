/**
 * Minimal Wibly Experience manifest — starting point for a new game.
 *
 * Replace placeholders marked TODO before publish:
 *  - id, name, description, personaBindings[].personaId
 *  - workflow phases to match your game design
 *  - promptSlots, scoring, portalMetadata URLs
 *
 * See the Wibly Game Builders Guide (Annexure A) for a full example.
 */

/** TODO: bind your host persona from the Persona Service. */
const HOST_PERSONA_ID = "per_REPLACE_ME0000000_";

const manifest = {
  id: "exp_REPLACE_ME000000000_",
  version: "0.1.0",
  name: "My Wibly Game",
  description: "Replace with a one-paragraph catalogue blurb for your game.",
  tenant: null,
  creator: "wibly-platform",
  createdAt: "2026-01-01T00:00:00.000Z",

  personaBindings: [{ role: "host", personaId: HOST_PERSONA_ID }],

  inferenceEnvelope: {
    maxLlmCallsPerSession: 8,
    maxTokensInPerCall: 4_096,
    maxTokensOutPerCall: 1_024,
    maxTtsSecondsPerSession: 300,
    qualityTiers: ["fast", "standard"],
  },

  stateSchema: {
    session: {
      type: "object",
      properties: {
        phase: { type: "string" },
        joinCode: { type: "string" },
        roundNumber: { type: "number" },
        totalRounds: { type: "number" },
      },
    },
    host: { type: "object", properties: {} },
    playerPublic: {
      type: "object",
      properties: {
        cumulativeScore: { type: "number" },
      },
    },
    playerPrivate: { type: "object", properties: {} },
    team: { type: "object", properties: {} },
  },

  workflow: {
    initialPhase: "lobby",
    phases: [
      {
        id: "lobby",
        inputSet: { actors: ["host"], inputType: "start" },
        collectionRule: { kind: "manual" },
        transitions: [{ to: "main" }],
        sideEffects: [],
      },
      {
        id: "main",
        inputSet: { actors: ["host"], inputType: "host_advance" },
        collectionRule: { kind: "manual" },
        transitions: [{ to: "lobby", when: "play_again" }],
        sideEffects: [],
      },
    ],
  },

  concurrentOpportunities: [],

  scoring: {
    dimensions: [
      {
        id: "points",
        label: "Points",
        weight: 1,
        scaleMin: 0,
        scaleMax: 1_000,
      },
    ],
    aggregators: [{ kind: "sum" }],
    awards: [
      {
        id: "round_winner",
        label: "Round Winner",
        dimensionId: "points",
        criterion: { kind: "top_n", n: 1 },
      },
    ],
  },

  lifecyclePolicies: [
    {
      situation: "player_disconnect",
      action: { kind: "pause_session", timeoutMs: 30_000, fallback: "continue_without_them" },
    },
    {
      situation: "host_disconnect",
      action: { kind: "pause_session", timeoutMs: 60_000, fallback: "end_session" },
    },
    {
      situation: "inference_outage",
      action: { kind: "continue_without_them" },
    },
    {
      situation: "safety_block",
      action: { kind: "continue_without_them" },
    },
  ],

  promptSlots: {
    experienceSystem:
      "Replace with layer-3 game context only: mechanics, round structure, content rating. " +
      "Do NOT author the persona character here — that is owned by the Persona Service.",

    callTypes: {},

    outputSchemas: {},
  },

  fallbackResponses: {},

  widgetDependencies: [],

  contentRating: {
    tier: "none",
    audiences: ["consumer"],
  },

  portalMetadata: {
    minPlayers: 2,
    maxPlayers: 8,
    estimatedDurationMinutes: 15,
    heroImageUrl: "https://assets.wibly.games/TODO/hero.jpg",
    gameplayImages: [],
    sampleRoundDescription: "Replace with a short sample-round description for the catalogue.",
    occasionTags: ["party"],
  },
};

export default manifest;
