/**
 * Player bundle — phone surface stub.
 *
 * Exports mount(session, container) per the Wibly mount contract (guide §3.2).
 * Replace phase views as you implement your game's player UI (guide §7).
 */

import { useEffect, useState, type FC, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Session, SessionState } from "@wibly/sdk";
import type { Mount } from "./types";
import "./styles.css";

type PlayerPublic = {
  readonly cumulativeScore?: number;
};

type GameState = {
  readonly playerPublic?: PlayerPublic;
};

const readState = (snap: SessionState): GameState => {
  const s = snap.state;
  return (s && typeof s === "object" ? (s as GameState) : {}) ?? {};
};

const Shell: FC<{ children: ReactNode }> = ({ children }) => (
  <main
    className="flex min-h-screen flex-col px-5 py-8 text-[color:var(--color-foreground)]"
    style={{
      paddingBottom: "max(env(safe-area-inset-bottom), 6rem)",
      background: "var(--color-surface)",
    }}
  >
    {children}
  </main>
);

const PlayerStub: FC<{ session: Session }> = ({ session }) => {
  const [snap, setSnap] = useState(() => session.getState());

  useEffect(() => session.subscribe(() => setSnap(session.getState())), [session]);

  const phaseId = snap.phaseId ?? "lobby";
  const score = readState(snap).playerPublic?.cumulativeScore ?? 0;

  let body: ReactNode;
  switch (phaseId) {
    case "lobby":
      body = <p className="text-xl">Waiting for the host to start…</p>;
      break;
    case "main":
      body = (
        <p className="text-xl">
          Main phase placeholder — replace with your player UI. Score: {score}
        </p>
      );
      break;
    default:
      body = <p className="text-xl">Loading…</p>;
  }

  return (
    <Shell>
      <p className="mb-6 text-xs uppercase tracking-[0.35em] text-[color:var(--color-muted)]">
        Player · {phaseId}
      </p>
      {body}
    </Shell>
  );
};

export const mount: Mount = (session, container) => {
  const root: Root = createRoot(container);
  root.render(<PlayerStub session={session} />);
  return () => root.unmount();
};
