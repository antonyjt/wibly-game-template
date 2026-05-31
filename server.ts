/**
 * Server-side sandbox hooks — stub implementations.
 *
 * Runs inside the Wibly Runtime (isolated-vm). No Node globals.
 * See the Game Builders Guide §8 for the full hook surface.
 *
 * Replace each stub with your game's logic as you add phases and inputs.
 */

type JsonPatchOp =
  | { op: "add" | "replace" | "test"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "move" | "copy"; from: string; path: string };

type SandboxContext = {
  state: {
    get(): Promise<unknown>;
    set(next: unknown): Promise<unknown>;
    applyPatch(patches: ReadonlyArray<JsonPatchOp>): Promise<unknown>;
  };
  players: { list(): Promise<ReadonlyArray<{ id: string }>> };
  persona: {
    memory: {
      read(input: { personaId: string; key: string }): Promise<{ ok: boolean; entry: unknown }>;
      write(input: {
        personaId: string;
        key: string;
        value: unknown;
        mode: "replace" | "append-array" | "merge-object";
        idempotencyKey?: string;
      }): Promise<{ ok: boolean }>;
    };
  };
  llm: {
    call(input: {
      callKind: string;
      qualityTier: string;
      slots: Record<string, string>;
    }): Promise<{ ok: boolean; output?: unknown }>;
  };
  tts: {
    speak(input: { personaId: string; text: string }): Promise<{ ok: boolean }>;
  };
  score: {
    award(input: {
      playerId: string;
      dimension: string;
      amount: number;
      reason: string;
    }): Promise<{ ok: boolean }>;
  };
  runSubPhase(input: { subPhaseKey: string }): Promise<{ ok: boolean }>;
  replaceActor(input: { playerId: string; actorKind: string }): Promise<{ ok: boolean }>;
};

export const onSessionStart = async (ctx: SandboxContext): Promise<void> => {
  await ctx.state.applyPatch([
    { op: "replace", path: "/session/roundNumber", value: 1 },
    { op: "replace", path: "/session/totalRounds", value: 1 },
  ]);
};

export const onPhaseStart = async (
  _ctx: SandboxContext,
  _payload: { phaseId: string },
): Promise<void> => {
  // TODO: seed phase-specific session state (content picks, deadlines, etc.)
};

export const onPhaseEnd = async (
  _ctx: SandboxContext,
  _payload: { phaseId: string },
): Promise<void> => {
  // TODO: run inference, scoring prep, persona memory writes
};

export const onSessionEnd = async (_ctx: SandboxContext): Promise<void> => {
  // TODO: write session-end persona memory with idempotencyKey
};
