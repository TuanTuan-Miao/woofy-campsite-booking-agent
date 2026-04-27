import { describe, expect, it } from "vitest";

import { runReservationWorkflow } from "../src/workflow.js";
import { buildObservation, buildRequest, FakeAdapter, StaticDecisionEngine } from "./helpers/fixtures.js";

describe("reservation workflow guardrails", () => {
  it("does not attempt booking when booking is disabled", async () => {
    const request = buildRequest({ bookingEnabled: false });
    const adapter = new FakeAdapter([buildObservation()]);
    const decisionEngine = new StaticDecisionEngine({
      action: "book",
      selectedCampsiteId: "primary",
      selectedCampsiteName: "Pine View 12",
      reasoning: "Primary is open.",
      confidence: 0.9,
    });

    const result = await runReservationWorkflow(request, {
      adapter,
      decisionEngine,
    });

    expect(result.decision.action).toBe("skip");
    expect(result.bookingReceipt).toBeNull();
    expect(adapter.bookCalls).toHaveLength(0);
  });

  it("blocks fallback booking when alternatives are disabled", async () => {
    const request = buildRequest({ allowAlternatives: false });
    const adapter = new FakeAdapter([
      buildObservation({
        campsiteId: "fallback",
        campsiteName: "River Bend 03",
        url: "https://example.test/camping/campsites/fallback",
        strictPreference: false,
        priority: 1,
      }),
    ]);
    const decisionEngine = new StaticDecisionEngine({
      action: "book",
      selectedCampsiteId: "fallback",
      selectedCampsiteName: "River Bend 03",
      reasoning: "Fallback is available.",
      confidence: 0.88,
    });

    const result = await runReservationWorkflow(request, {
      adapter,
      decisionEngine,
    });

    expect(result.decision.action).toBe("wait");
    expect(result.decision.reasoning).toContain("Fallback campsites are disabled");
    expect(adapter.bookCalls).toHaveLength(0);
  });

  it("blocks booking when the selected campsite exceeds the max price", async () => {
    const request = buildRequest({ maxTotalPrice: 50 });
    const adapter = new FakeAdapter([
      buildObservation({
        totalPrice: 80,
      }),
    ]);
    const decisionEngine = new StaticDecisionEngine({
      action: "book",
      selectedCampsiteId: "primary",
      selectedCampsiteName: "Pine View 12",
      reasoning: "Primary is available.",
      confidence: 0.9,
    });

    const result = await runReservationWorkflow(request, {
      adapter,
      decisionEngine,
    });

    expect(result.decision.action).toBe("wait");
    expect(result.decision.reasoning).toContain("max price threshold");
    expect(adapter.bookCalls).toHaveLength(0);
  });

  it("downgrades the decision when the selected campsite was not observed by the scout", async () => {
    const request = buildRequest();
    const adapter = new FakeAdapter([buildObservation()]);
    const decisionEngine = new StaticDecisionEngine({
      action: "book",
      selectedCampsiteId: "missing",
      selectedCampsiteName: "Missing Site",
      reasoning: "Reserve the missing site.",
      confidence: 0.4,
    });

    const result = await runReservationWorkflow(request, {
      adapter,
      decisionEngine,
    });

    expect(result.decision.action).toBe("wait");
    expect(result.decision.reasoning).toContain("could not be found");
    expect(adapter.bookCalls).toHaveLength(0);
  });
});
