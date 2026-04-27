import { describe, expect, it } from "vitest";

import { CompositeReservationAdapter } from "../src/composite-adapter.js";
import type { AvailabilityObservation, BookingReceipt, ReservationRequest } from "../src/domain.js";
import { buildObservation, buildRequest } from "./helpers/fixtures.js";

class ScoutStub {
  constructor(private readonly observations: AvailabilityObservation[]) {}

  async scanAvailability(): Promise<AvailabilityObservation[]> {
    return this.observations;
  }
}

class BookerStub {
  public seenRequest: ReservationRequest | null = null;

  async scanAvailability(): Promise<AvailabilityObservation[]> {
    return [];
  }

  async book(request: ReservationRequest, campsiteId: string): Promise<BookingReceipt> {
    this.seenRequest = request;
    return {
      success: true,
      campsiteId,
      campsiteName: "Booked site",
      commitMode: request.commitMode,
      details: "ok",
    };
  }
}

describe("CompositeReservationAdapter", () => {
  it("hydrates booking candidates from scout observations for campground searches", async () => {
    const request = buildRequest({
      campgroundId: "232769",
      candidates: [],
    });
    const observations = [
      buildObservation({
        campsiteId: "64674",
        campsiteName: "FALLEN LEAF CAMPGROUND Site 002",
        url: "https://example.test/camping/campsites/64674",
        strictPreference: false,
        priority: 2,
      }),
    ];
    const scout = new ScoutStub(observations);
    const booker = new BookerStub();
    const adapter = new CompositeReservationAdapter(
      scout as never,
      booker as never,
    );

    await adapter.scanAvailability(request);
    await adapter.book(request, "64674");

    expect(booker.seenRequest?.candidates).toEqual([
      {
        id: "64674",
        name: "FALLEN LEAF CAMPGROUND Site 002",
        url: "https://example.test/camping/campsites/64674",
        priority: 2,
        strictPreference: false,
      },
    ]);
  });
});
