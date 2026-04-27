import { describe, expect, it } from "vitest";

import { RuleBasedDecisionEngine } from "../src/decision-engine.js";
import { buildObservation, buildRequest } from "./helpers/fixtures.js";

describe("RuleBasedDecisionEngine", () => {
  it("books the strict preference campsite when available", async () => {
    const engine = new RuleBasedDecisionEngine();
    const request = buildRequest();
    const observations = [
      buildObservation(),
      buildObservation({
        campsiteId: "fallback",
        campsiteName: "River Bend 03",
        url: "https://example.test/camping/campsites/fallback",
        strictPreference: false,
        priority: 1,
        totalPrice: 42,
      }),
    ];

    const decision = await engine.evaluate(request, observations);

    expect(decision.action).toBe("book");
    expect(decision.selectedCampsiteId).toBe("primary");
    expect(decision.reasoning).toContain("Primary site");
  });

  it("books the fallback campsite when the primary site is unavailable", async () => {
    const engine = new RuleBasedDecisionEngine();
    const request = buildRequest();
    const observations = [
      buildObservation({
        available: false,
        releaseState: "unavailable",
      }),
      buildObservation({
        campsiteId: "fallback",
        campsiteName: "River Bend 03",
        url: "https://example.test/camping/campsites/fallback",
        strictPreference: false,
        priority: 1,
        totalPrice: 42,
      }),
    ];

    const decision = await engine.evaluate(request, observations);

    expect(decision.action).toBe("book");
    expect(decision.selectedCampsiteId).toBe("fallback");
  });

  it("waits when the only available option exceeds the configured max price", async () => {
    const engine = new RuleBasedDecisionEngine();
    const request = buildRequest({ maxTotalPrice: 40 });
    const observations = [
      buildObservation({
        totalPrice: 55,
      }),
    ];

    const decision = await engine.evaluate(request, observations);

    expect(decision.action).toBe("wait");
    expect(decision.reasoning).toContain("keep polling");
  });

  it("waits when the release window has not opened yet", async () => {
    const engine = new RuleBasedDecisionEngine();
    const request = buildRequest();
    const observations = [
      buildObservation({
        available: false,
        releaseState: "not_yet_released",
      }),
    ];

    const decision = await engine.evaluate(request, observations);

    expect(decision.action).toBe("wait");
    expect(decision.reasoning).toContain("not yet released");
  });
});
