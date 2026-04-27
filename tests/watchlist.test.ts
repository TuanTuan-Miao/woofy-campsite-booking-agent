import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTrackedRequests, loadWatchTargets, removeWatchTarget, upsertWatchTarget } from "../src/watchlist.js";

describe("watchlist", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), "woofy-watchlist-"));
    process.chdir(dir);
    writeFileSync(
      path.join(dir, ".env"),
      [
        "HEADLESS=true",
        "BOOKING_ENABLED=true",
        "COMMIT_MODE=payment",
        "RECREATION_BASE_URL=https://example.test",
        "RECREATION_EMAIL=camper@example.com",
        "RECREATION_PASSWORD=secret",
        "MAX_TOTAL_PRICE=100",
        "ALLOW_ALTERNATIVES=true",
        "PARTY_SIZE=2",
      ].join("\n"),
      "utf8",
    );
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it("stores watch targets and builds one request per target", () => {
    upsertWatchTarget({
      id: "trip-a",
      name: "Trip A",
      campgroundId: "111",
      arrivalDate: "2026-07-20",
      nights: 2,
      excludeRvSites: true,
      preferredCampsiteIds: ["site-1"],
      excludedCampsiteIds: [],
    });
    upsertWatchTarget({
      id: "trip-b",
      name: "Trip B",
      campgroundId: "222",
      arrivalDate: "2026-08-01",
      nights: 3,
      preferredCampsiteIds: [],
      excludedCampsiteIds: ["site-x"],
    });

    const targets = loadWatchTargets();
    const tracked = buildTrackedRequests();

    expect(targets).toHaveLength(2);
    expect(tracked).toHaveLength(2);
    expect(tracked[0]?.id).toBe("trip-a");
    expect(tracked[0]?.request.campgroundId).toBe("111");
    expect(tracked[0]?.request.excludeRvSites).toBe(true);
    expect(tracked[1]?.request.campgroundId).toBe("222");
    expect(tracked[1]?.request.nights).toBe(3);
  });

  it("removes watch targets by id", () => {
    upsertWatchTarget({
      id: "trip-a",
      name: "Trip A",
      campgroundId: "111",
      arrivalDate: "2026-07-20",
      nights: 2,
      preferredCampsiteIds: [],
      excludedCampsiteIds: [],
    });
    upsertWatchTarget({
      id: "trip-b",
      name: "Trip B",
      campgroundId: "222",
      arrivalDate: "2026-08-01",
      nights: 3,
      preferredCampsiteIds: [],
      excludedCampsiteIds: [],
    });

    removeWatchTarget("trip-a");

    expect(loadWatchTargets().map((target) => target.id)).toEqual(["trip-b"]);
  });
});
