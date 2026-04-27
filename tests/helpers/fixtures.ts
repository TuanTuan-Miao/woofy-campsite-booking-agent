import {
  ReservationRequestSchema,
  type AvailabilityObservation,
  type BookingDecision,
  type BookingReceipt,
  type ReservationRequest,
} from "../../src/domain.js";
import type { DecisionEngine } from "../../src/decision-engine.js";
import type { ReservationAdapter } from "../../src/recreation-adapter.js";

export const buildRequest = (overrides: Partial<ReservationRequest> = {}): ReservationRequest => {
  return ReservationRequestSchema.parse({
    arrivalDate: "2026-07-17",
    nights: 2,
    partySize: 2,
    bookingEnabled: true,
    allowAlternatives: true,
    maxTotalPrice: 100,
    headless: true,
    baseUrl: "https://example.test",
    email: "camper@example.com",
    password: "camp-pass",
    commitMode: "payment",
    candidates: [
      {
        id: "primary",
        name: "Pine View 12",
        url: "https://example.test/camping/campsites/primary",
        priority: 0,
        strictPreference: true,
      },
      {
        id: "fallback",
        name: "River Bend 03",
        url: "https://example.test/camping/campsites/fallback",
        priority: 1,
        strictPreference: false,
      },
    ],
    ...overrides,
  });
};

export const buildObservation = (
  overrides: Partial<AvailabilityObservation> = {},
): AvailabilityObservation => ({
  campsiteId: "primary",
  campsiteName: "Pine View 12",
  url: "https://example.test/camping/campsites/primary",
  available: true,
  releaseState: "available",
  totalPrice: 48,
  arrivalDate: "2026-07-17",
  nights: 2,
  notes: [],
  strictPreference: true,
  priority: 0,
  ...overrides,
});

export class FakeAdapter implements ReservationAdapter {
  public bookCalls: string[] = [];

  constructor(
    private readonly observations: AvailabilityObservation[],
    private readonly bookingReceipt: BookingReceipt = {
      success: true,
      campsiteId: "fallback",
      campsiteName: "River Bend 03",
      commitMode: "payment",
      reservationReference: "MOCK-1234",
      finalUrl: "https://example.test/confirmation",
      details: "Reservation reached the payment page.",
    },
  ) {}

  async scanAvailability(): Promise<AvailabilityObservation[]> {
    return this.observations;
  }

  async book(_request: ReservationRequest, campsiteId: string): Promise<BookingReceipt> {
    this.bookCalls.push(campsiteId);
    return {
      ...this.bookingReceipt,
      campsiteId,
    };
  }
}

export class StaticDecisionEngine implements DecisionEngine {
  constructor(private readonly decision: BookingDecision) {}

  async evaluate(): Promise<BookingDecision> {
    return this.decision;
  }
}
