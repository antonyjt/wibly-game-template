import { describe, it, expect } from "vitest";
import {
  validateManifestStrict,
  formatManifestReport,
  assertEnvelopeCompliance,
  type PlannedCall,
} from "@wibly/sdk-testkit";
import manifest from "../manifest";

describe("manifest", () => {
  it("validates structurally (guide §4.1)", () => {
    const report = validateManifestStrict(manifest);
    if (!report.valid) {
      // eslint-disable-next-line no-console
      console.error(formatManifestReport(report));
    }
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("stays within its inference envelope (guide §4.12)", () => {
    // TODO: replace with a realistic per-round call plan for your game.
    const plan: PlannedCall[] = [];

    const report = assertEnvelopeCompliance(manifest, plan);
    expect(report.violations).toEqual([]);
    expect(report.compliant).toBe(true);
  });
});
