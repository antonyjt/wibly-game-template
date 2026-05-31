/**
 * Host bundle — TV surface stub.
 *
 * Exports mount(session, container) per the Wibly mount contract (guide §3.2).
 * Replace phase views as you implement your game's host UI (guide §6).
 */

import { useEffect, useState, type FC, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Session, SessionState } from "@wibly/sdk";
import type { Mount } from "./types";
import "./styles.css";

type GameState = {
  readonly session?: {
    readonly joinCode?: string;
    readonly roundNumber?: number;
    readonly totalRounds?: number;
  };
};

const readState = (snap: SessionState): GameState => {
  const s = snap.state;
  return (s && typeof s === "object" ? (s as GameState) : {}) ?? {};
};

const Stage: FC<{ children: ReactNode }> = ({ children }) => (
  <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-[color:var(--color-surface)] px-12 py-16 text-[color:var(--color-foreground)]">
    {children}
  </main>
);

const HostStub: FC<{ session: Session }> = ({ session }) => {
  const [snap, setSnap] = useState(() => session.getState());

  useEffect(() => session.subscribe(() => setSnap(session.getState())), [session]);

  const phaseId = snap.phaseId ?? "lobby";
  const state = readState(snap);
  const joinCode = state.session?.joinCode ?? "------";

  const startOrAdvance = (): void => {
    if (phaseId === "lobby") {
      session.host.advancePhase();
      return;
    }
    if (phaseId === "main") {
      session.host.advancePhase({ when: "play_again" });
    }
  };

  return (
    <Stage>
      <p className="text-sm uppercase tracking-[0.35em] text-[color:var(--color-muted)]">
        Host · {phaseId}
      </p>
      <h1 className="text-center text-5xl font-semibold">My Wibly Game</h1>
      {phaseId === "lobby" && (
        <>
          <p className="font-mono text-6xl tracking-[0.3em]">{joinCode}</p>
          <button
            type="button"
            onClick={startOrAdvance}
            className="rounded-xl bg-[color:var(--color-accent)] px-10 py-5 text-2xl font-semibold text-[color:var(--color-surface)]"
          >
            Start session
          </button>
        </>
      )}
      {phaseId === "main" && (
        <>
          <p className="max-w-2xl text-center text-2xl text-[color:var(--color-muted)]">
            Main phase placeholder — replace with your host UI.
          </p>
          <button
            type="button"
            onClick={startOrAdvance}
            className="rounded-xl border border-[color:var(--color-accent)] px-10 py-5 text-xl text-[color:var(--color-accent)]"
          >
            Play again
          </button>
        </>
      )}
    </Stage>
  );
};

export const mount: Mount = (session, container) => {
  const root: Root = createRoot(container);
  root.render(<HostStub session={session} />);
  return () => root.unmount();
};
