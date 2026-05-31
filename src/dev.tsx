// Local dev harness — never shipped in bundles.
// Toggle surface: ?surface=host | ?surface=player (default: player)
// Toggle phase:   ?phase=lobby | ?phase=main

import type { Session, SessionState } from "@wibly/sdk";
import { mount as mountHost } from "./host";
import { mount as mountPlayer } from "./player";

const container = document.getElementById("root");
if (!container) throw new Error("#root missing");

const params = new URLSearchParams(window.location.search);
const surface = params.get("surface") ?? "player";
const phase = params.get("phase") ?? "lobby";

const state: SessionState = {
  connectionState: "connected" as SessionState["connectionState"],
  state: {
    session: {
      phase,
      phaseId: phase,
      joinCode: "WI BLY",
      roundNumber: 1,
      totalRounds: 1,
    },
    host: {},
    playerPublic: { cumulativeScore: 0 },
    playerPrivate: {},
  },
  projectedState: null,
  appliedSeq: 0,
  phaseId: phase,
  sessionPaused: false,
  pauseReason: null,
  recoveryCode: null,
  recoveryCodeHint: null,
  isPreview: true,
};

const noopUnsub = (): void => {};
const okResult = { ok: true as const, value: { id: "dev" } };

const stubSession = {
  sessionId: "sess_dev" as Session["sessionId"],
  playerId: "p1",
  isPreview: true,
  getState: () => state,
  subscribe: () => noopUnsub,
  submit: async () => ({ ok: true as const, value: { id: "dev" } }),
  host: {
    pause: () => okResult,
    resume: () => okResult,
    advancePhase: () => okResult,
    reclaim: () => okResult,
  },
  voice: {
    speak: async () => ({ ok: true as const, value: { messageId: "dev", durationMs: 0 } }),
  },
  lifecycle: {
    onPhaseEntered: () => noopUnsub,
    onPhaseExited: () => noopUnsub,
    onPaused: () => noopUnsub,
    onResumed: () => noopUnsub,
    onError: () => noopUnsub,
  },
  time: {
    serverNow: () => Date.now(),
    recordEvent: () => {},
  },
  events: { onEvent: () => noopUnsub, onAnyEvent: () => noopUnsub },
} as unknown as Session;

if (surface === "host") {
  mountHost(stubSession, container);
} else {
  container.style.minHeight = "100vh";
  container.style.display = "flex";
  container.style.alignItems = "flex-start";
  container.style.justifyContent = "center";
  container.style.background = "#111";
  container.style.padding = "24px 0";

  const phone = document.createElement("div");
  phone.style.width = "390px";
  phone.style.minHeight = "844px";
  phone.style.background = "var(--color-surface, #1a1a2e)";
  phone.style.borderRadius = "32px";
  phone.style.overflow = "hidden";
  phone.style.boxShadow = "0 30px 80px rgba(0,0,0,0.6)";
  container.appendChild(phone);

  mountPlayer(stubSession, phone);
}
