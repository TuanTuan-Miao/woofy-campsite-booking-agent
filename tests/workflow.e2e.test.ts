import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CompositeReservationAdapter } from "../src/composite-adapter.js";
import { RuleBasedDecisionEngine } from "../src/decision-engine.js";
import { ReservationRequestSchema } from "../src/domain.js";
import { runReservationWorkflow } from "../src/workflow.js";
import { startMockRecreationServer } from "./helpers/mock-recreation-server.js";

let server: Awaited<ReturnType<typeof startMockRecreationServer>>;

describe("reservation workflow", () => {
  beforeAll(async () => {
    server = await startMockRecreationServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it(
    "books the fallback campsite when the preferred site is unavailable",
    async () => {
      const request = ReservationRequestSchema.parse({
        arrivalDate: "2026-07-17",
        nights: 2,
        partySize: 2,
        campgroundId: "mock-campground",
        preferredCampsiteIds: ["primary-site"],
        excludedCampsiteIds: [],
        bookingEnabled: true,
        allowAlternatives: true,
        maxTotalPrice: 100,
        headless: true,
        baseUrl: server.baseUrl,
        email: "camper@example.com",
        password: "camp-pass",
        commitMode: "cart",
        candidates: [],
      });

      const result = await runReservationWorkflow(request, {
        adapter: new CompositeReservationAdapter(),
        decisionEngine: new RuleBasedDecisionEngine(),
      });

      expect(result.observations).toHaveLength(2);
      expect(result.decision.action).toBe("book");
      expect(result.decision.selectedCampsiteId).toBe("fallback-site");
      expect(result.bookingReceipt?.success).toBe(true);
      expect(result.bookingReceipt?.commitMode).toBe("cart");
      expect(result.bookingReceipt?.campsiteName).toContain("River Bend 03");
      expect(result.bookingReceipt?.details).toContain("added to the cart hold");
      expect(server.state.reservations).toHaveLength(1);
      expect(server.state.reservations[0]?.siteId).toBe("fallback-site");
    },
    30000,
  );
});
