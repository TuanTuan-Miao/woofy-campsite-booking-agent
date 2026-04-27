import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentController } from "../src/agent-controller.js";
import type { ReservationRequest, WorkflowResult } from "../src/domain.js";
import type { Notifier } from "../src/telegram-notifier.js";

const createWorkflowResult = (request: ReservationRequest): WorkflowResult => ({
  observations: [],
  decision: {
    action: "wait",
    reasoning: `Watching ${request.campgroundId ?? "n/a"}`,
    confidence: 0.5,
  },
  bookingReceipt: null,
  journal: [],
});

describe("AgentController", () => {
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = { ...originalEnv };
  });

  it("reloads config from .env updates and reruns the workflow", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woofy-controller-"));
    process.chdir(dir);
    writeFileSync(
      path.join(dir, ".env"),
      [
        "POLL_CRON=*/5 * * * *",
        "HEADLESS=true",
        "BOOKING_ENABLED=false",
        "COMMIT_MODE=cart",
        "RECREATION_BASE_URL=https://example.test",
        "RECREATION_EMAIL=camper@example.com",
        "RECREATION_PASSWORD=secret",
        "CAMPGROUND_ID=123",
        "ARRIVAL_DATE=2026-07-17",
        "NIGHTS=2",
        "MAX_TOTAL_PRICE=100",
        "ALLOW_ALTERNATIVES=true",
        "PARTY_SIZE=2",
      ].join("\n"),
      "utf8",
    );

    const seen: Array<{ campgroundId: string | undefined; arrivalDate: string; nights: number }> = [];
    const notifier: Notifier = {
      sendMessage: async () => undefined,
    };

    const controller = new AgentController(async (request) => {
      seen.push({
        campgroundId: request.campgroundId,
        arrivalDate: request.arrivalDate,
        nights: request.nights,
      });
      return createWorkflowResult(request);
    }, notifier);

    await controller.start();
    await controller.updateConfiguration({
      CAMPGROUND_ID: "456",
      ARRIVAL_DATE: "2026-07-20",
      NIGHTS: "3",
    });

    controller.stop();

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({
      campgroundId: "123",
      arrivalDate: "2026-07-17",
      nights: 2,
    });
    expect(seen[1]).toEqual({
      campgroundId: "456",
      arrivalDate: "2026-07-20",
      nights: 3,
    });
  });

  it("sends a telegram notification when availability is found", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woofy-controller-"));
    process.chdir(dir);
    writeFileSync(
      path.join(dir, ".env"),
      [
        "POLL_CRON=*/5 * * * *",
        "HEADLESS=true",
        "BOOKING_ENABLED=true",
        "COMMIT_MODE=payment",
        "RECREATION_BASE_URL=https://example.test",
        "RECREATION_EMAIL=camper@example.com",
        "RECREATION_PASSWORD=secret",
        "CAMPGROUND_ID=123",
        "ARRIVAL_DATE=2026-07-17",
        "NIGHTS=2",
        "MAX_TOTAL_PRICE=100",
        "ALLOW_ALTERNATIVES=true",
        "PARTY_SIZE=2",
      ].join("\n"),
      "utf8",
    );

    const sent: string[] = [];
    const notifier: Notifier = {
      sendMessage: async (text) => {
        sent.push(text);
      },
    };

    const controller = new AgentController(async (request) => ({
      observations: [
        {
          campsiteId: "site-1",
          campsiteName: "River Bend 03",
          url: "https://example.test/camping/campsites/site-1",
          available: true,
          releaseState: "available",
          arrivalDate: request.arrivalDate,
          nights: request.nights,
          notes: [],
          strictPreference: false,
          priority: 1,
        },
      ],
      decision: {
        action: "book",
        selectedCampsiteId: "site-1",
        selectedCampsiteName: "River Bend 03",
        reasoning: "The site is available.",
        confidence: 0.9,
      },
      bookingReceipt: {
        success: true,
        campsiteId: "site-1",
        campsiteName: "River Bend 03",
        commitMode: "cart",
        finalUrl: "https://example.test/camping/reservations/orderdetails?id=abc123",
        details: "Reservation was added to the cart hold. Complete checkout before Recreation.gov releases it.",
      },
      journal: [],
    }), notifier);

    await controller.start();
    controller.stop();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Woofy found campsite availability.");
    expect(sent[0]).toContain("Open this page to finish manually: https://example.test/camping/reservations/orderdetails?id=abc123");
  });

  it("sends recurring reminders while a cart hold is still active", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woofy-controller-"));
    process.chdir(dir);
    writeFileSync(
      path.join(dir, ".env"),
      [
        "POLL_CRON=*/1 * * * *",
        "HEADLESS=true",
        "BOOKING_ENABLED=true",
        "COMMIT_MODE=cart",
        "RECREATION_BASE_URL=https://example.test",
        "RECREATION_EMAIL=camper@example.com",
        "RECREATION_PASSWORD=secret",
        "MAX_TOTAL_PRICE=100",
        "ALLOW_ALTERNATIVES=true",
        "PARTY_SIZE=2",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(dir, "watchlist.json"),
      JSON.stringify(
        [
          {
            id: "trip-a",
            name: "Trip A",
            campgroundId: "111",
            arrivalDate: "2026-07-17",
            nights: 2,
          },
        ],
        null,
        2,
      ),
      "utf8",
    );
    mkdirSync(path.join(dir, ".runtime"), { recursive: true });
    writeFileSync(
      path.join(dir, ".runtime", "booking-state.json"),
      JSON.stringify(
        {
          watches: {
            "trip-a": {
              status: "cart_pending",
              updatedAt: new Date().toISOString(),
              receipt: {
                success: true,
                campsiteId: "site-1",
                campsiteName: "River Bend 03",
                commitMode: "cart",
                finalUrl: "https://example.test/camping/reservations/orderdetails?id=abc123",
                details: "Reservation was added to the cart hold. Complete checkout before Recreation.gov releases it.",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const sent: string[] = [];
    const notifier: Notifier = {
      sendMessage: async (text) => {
        sent.push(text);
      },
    };
    const workflowRunner = vi.fn(async (request: ReservationRequest) => createWorkflowResult(request));
    const pendingMonitorModule = await import("../src/pending-booking-monitor.js");
    const pendingMonitor = vi
      .spyOn(pendingMonitorModule, "checkPendingBookingStatus")
      .mockResolvedValue({
        active: true,
        finalUrl: "https://example.test/camping/reservations/orderdetails?id=abc123",
        details: "Pending booking is still active in Recreation.gov order details.",
      });

    const controller = new AgentController(workflowRunner, notifier);
    const runs = await controller.runNow("pending-reminder");
    controller.stop();

    expect(workflowRunner).not.toHaveBeenCalled();
    expect(runs[0]?.status).toBe("cart_pending");
    expect(sent[0]).toContain("Woofy still has an active cart hold for Trip A.");
    pendingMonitor.mockRestore();
  });

  it("runs one workflow per watch target", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woofy-controller-"));
    process.chdir(dir);
    writeFileSync(
      path.join(dir, ".env"),
      [
        "POLL_CRON=*/5 * * * *",
        "HEADLESS=true",
        "BOOKING_ENABLED=false",
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
    writeFileSync(
      path.join(dir, "watchlist.json"),
      JSON.stringify(
        [
          {
            id: "trip-a",
            name: "Trip A",
            campgroundId: "111",
            arrivalDate: "2026-07-17",
            nights: 2,
          },
          {
            id: "trip-b",
            name: "Trip B",
            campgroundId: "222",
            arrivalDate: "2026-08-01",
            nights: 1,
          },
        ],
        null,
        2,
      ),
      "utf8",
    );

    const seen: string[] = [];
    const notifier: Notifier = {
      sendMessage: async () => undefined,
    };
    const controller = new AgentController(async (request) => {
      seen.push(`${request.campgroundId}:${request.arrivalDate}:${request.nights}`);
      return createWorkflowResult(request);
    }, notifier);

    const runs = await controller.runNow("test-watchlist");
    controller.stop();

    expect(seen).toEqual(["111:2026-07-17:2", "222:2026-08-01:1"]);
    expect(runs).toHaveLength(2);
    expect(runs.map((item) => item.id)).toEqual(["trip-a", "trip-b"]);
  });

  it("pauses monitoring without running the workflow", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woofy-controller-"));
    process.chdir(dir);
    writeFileSync(
      path.join(dir, ".env"),
      [
        "AGENT_ENABLED=true",
        "POLL_CRON=*/5 * * * *",
        "HEADLESS=true",
        "BOOKING_ENABLED=false",
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
    writeFileSync(
      path.join(dir, "watchlist.json"),
      JSON.stringify(
        [
          {
            id: "trip-a",
            name: "Trip A",
            campgroundId: "111",
            arrivalDate: "2026-07-17",
            nights: 2,
          },
        ],
        null,
        2,
      ),
      "utf8",
    );

    const workflowRunner = vi.fn(async (request: ReservationRequest) => createWorkflowResult(request));
    const notifier: Notifier = {
      sendMessage: async () => undefined,
    };
    const controller = new AgentController(workflowRunner, notifier);

    await controller.pauseMonitoring();
    const runs = await controller.runNow("paused-check");
    controller.stop();

    expect(workflowRunner).not.toHaveBeenCalled();
    expect(runs[0]?.result.decision.reasoning).toContain("paused");
  });

  it("does not crash startup when a scheduled run cannot be built", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woofy-controller-"));
    process.chdir(dir);
    writeFileSync(
      path.join(dir, ".env"),
      [
        "AGENT_ENABLED=true",
        "POLL_CRON=*/5 * * * *",
        "HEADLESS=true",
        "BOOKING_ENABLED=true",
        "COMMIT_MODE=cart",
        "RECREATION_BASE_URL=https://example.test",
        "RECREATION_EMAIL=camper@example.com",
        "RECREATION_PASSWORD=secret",
        "MAX_TOTAL_PRICE=100",
        "ALLOW_ALTERNATIVES=true",
        "PARTY_SIZE=2",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(path.join(dir, "watchlist.json"), "not-json", "utf8");

    const sent: string[] = [];
    const notifier: Notifier = {
      sendMessage: async (text) => {
        sent.push(text);
      },
    };

    const controller = new AgentController(async (request) => createWorkflowResult(request), notifier);

    await expect(controller.start()).resolves.toBeUndefined();
    controller.stop();

    expect(sent[0]).toContain("Woofy controller run failed (startup).");
  });
});
