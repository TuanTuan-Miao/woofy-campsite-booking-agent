import { describe, expect, it } from "vitest";

import { ReservationRequestSchema } from "../src/domain.js";
import { RecreationGovApiScout } from "../src/recreation-api.js";

const jsonResponse = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });

describe("RecreationGovApiScout", () => {
  it("finds a campsite that is available for the full requested stay", async () => {
    const fetchMock: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/api/camps/campgrounds/999") {
        return jsonResponse({
          campground: {
            facility_name: "Mock Campground",
          },
        });
      }

      return jsonResponse({
        campsites: {
          "1001": {
            campsite_id: "1001",
            campsite_type: "STANDARD NONELECTRIC",
            site: "12",
            availabilities: {
              "2026-07-17T00:00:00Z": "Available",
              "2026-07-18T00:00:00Z": "Available",
            },
          },
          "1002": {
            campsite_id: "1002",
            campsite_type: "STANDARD NONELECTRIC",
            site: "13",
            availabilities: {
              "2026-07-17T00:00:00Z": "Available",
              "2026-07-18T00:00:00Z": "Reserved",
            },
          },
        },
      });
    };

    const scout = new RecreationGovApiScout(fetchMock);
    const request = ReservationRequestSchema.parse({
      arrivalDate: "2026-07-17",
      nights: 2,
      partySize: 2,
      campgroundId: "999",
      preferredCampsiteIds: ["1002", "1001"],
      excludedCampsiteIds: [],
      bookingEnabled: false,
      allowAlternatives: true,
      maxTotalPrice: 100,
      headless: true,
      baseUrl: "https://example.test",
      email: "camper@example.com",
      password: "camp-pass",
      commitMode: "cart",
      candidates: [],
    });

    const observations = await scout.scanAvailability(request);

    expect(observations).toHaveLength(2);
    expect(observations[0]?.campsiteId).toBe("1002");
    expect(observations[0]?.strictPreference).toBe(true);
    expect(observations[0]?.available).toBe(false);
    expect(observations[1]?.campsiteId).toBe("1001");
    expect(observations[1]?.available).toBe(true);
    expect(observations[1]?.url).toBe("https://example.test/camping/campsites/1001");
  });

  it("reads across month boundaries and honors excluded site ids", async () => {
    const fetchMock: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/api/camps/campgrounds/999") {
        return jsonResponse({
          campground: {
            facility_name: "Boundary Campground",
          },
        });
      }

      const startDate = url.searchParams.get("start_date");
      if (startDate?.startsWith("2026-07")) {
        return jsonResponse({
          campsites: {
            "2001": {
              campsite_id: "2001",
              campsite_type: "STANDARD NONELECTRIC",
              site: "01",
              availabilities: {
                "2026-07-31T00:00:00Z": "Available",
              },
            },
            "2002": {
              campsite_id: "2002",
              campsite_type: "STANDARD NONELECTRIC",
              site: "02",
              availabilities: {
                "2026-07-31T00:00:00Z": "Available",
              },
            },
          },
        });
      }

      return jsonResponse({
        campsites: {
          "2001": {
            campsite_id: "2001",
            campsite_type: "STANDARD NONELECTRIC",
            site: "01",
            availabilities: {
              "2026-08-01T00:00:00Z": "Available",
            },
          },
          "2002": {
            campsite_id: "2002",
            campsite_type: "STANDARD NONELECTRIC",
            site: "02",
            availabilities: {
              "2026-08-01T00:00:00Z": "Available",
            },
          },
        },
      });
    };

    const scout = new RecreationGovApiScout(fetchMock);
    const request = ReservationRequestSchema.parse({
      arrivalDate: "2026-07-31",
      nights: 2,
      partySize: 2,
      campgroundId: "999",
      preferredCampsiteIds: [],
      excludedCampsiteIds: ["2002"],
      bookingEnabled: false,
      allowAlternatives: true,
      maxTotalPrice: 100,
      headless: true,
      baseUrl: "https://example.test",
      email: "camper@example.com",
      password: "camp-pass",
      commitMode: "cart",
      candidates: [],
    });

    const observations = await scout.scanAvailability(request);

    expect(observations).toHaveLength(1);
    expect(observations[0]?.campsiteId).toBe("2001");
    expect(observations[0]?.available).toBe(true);
  });

  it("filters RV campsites when excludeRvSites is enabled", async () => {
    const fetchMock: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/api/camps/campgrounds/999") {
        return jsonResponse({
          campground: {
            facility_name: "Mock Campground",
          },
        });
      }

      return jsonResponse({
        campsites: {
          "3001": {
            campsite_id: "3001",
            campsite_type: "RV NONELECTRIC",
            site: "1",
            availabilities: {
              "2026-07-17T00:00:00Z": "Available",
            },
          },
          "3002": {
            campsite_id: "3002",
            campsite_type: "STANDARD NONELECTRIC",
            site: "2",
            availabilities: {
              "2026-07-17T00:00:00Z": "Available",
            },
          },
        },
      });
    };

    const scout = new RecreationGovApiScout(fetchMock);
    const request = ReservationRequestSchema.parse({
      arrivalDate: "2026-07-17",
      nights: 1,
      partySize: 2,
      campgroundId: "999",
      excludeRvSites: true,
      preferredCampsiteIds: [],
      excludedCampsiteIds: [],
      bookingEnabled: false,
      allowAlternatives: true,
      maxTotalPrice: 100,
      headless: true,
      baseUrl: "https://example.test",
      email: "camper@example.com",
      password: "camp-pass",
      commitMode: "cart",
      candidates: [],
    });

    const observations = await scout.scanAvailability(request);

    expect(observations).toHaveLength(1);
    expect(observations[0]?.campsiteId).toBe("3002");
  });
});
