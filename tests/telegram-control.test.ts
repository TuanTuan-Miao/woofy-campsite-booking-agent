import { describe, expect, it, vi } from "vitest";

import { TelegramControlBot, handleTelegramCommand } from "../src/telegram-control.js";

describe("telegram command handling", () => {
  it("creates or updates a watch target with /configure", async () => {
    const upsertWatchTarget = vi.fn(async () => ({
      cronExpression: "*/5 * * * *",
      configSummary: ["WATCH:trip-a 999 2026-07-20 2n"],
      running: false,
      lastResults: [],
    }));
    const controller = {
      getStatus: vi.fn(() => ({
        cronExpression: "*/5 * * * *",
        configSummary: [],
        running: false,
        lastResults: [],
      })),
      runNow: vi.fn(),
      updateConfiguration: vi.fn(),
      pauseMonitoring: vi.fn(),
      resumeMonitoring: vi.fn(),
      listWatchTargets: vi.fn(() => []),
      upsertWatchTarget,
      removeWatchTarget: vi.fn(),
    };

    const reply = await handleTelegramCommand("/configure trip-a 999 2026-07-20 2", {
      controller,
    });

    expect(upsertWatchTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "trip-a",
        name: "trip-a",
        campgroundId: "999",
        arrivalDate: "2026-07-20",
        nights: 2,
        excludeRvSites: undefined,
      }),
    );
    expect(reply).toContain("Updated watch target trip-a");
  });

  it("updates arbitrary env keys with /set", async () => {
    const updateConfiguration = vi.fn(async () => ({
      cronExpression: "*/5 * * * *",
      configSummary: ["BOOKING_ENABLED=true"],
      running: false,
      lastResults: [],
    }));
    const controller = {
      getStatus: vi.fn(),
      runNow: vi.fn(),
      updateConfiguration,
      pauseMonitoring: vi.fn(),
      resumeMonitoring: vi.fn(),
      listWatchTargets: vi.fn(() => []),
      upsertWatchTarget: vi.fn(),
      removeWatchTarget: vi.fn(),
    };

    const reply = await handleTelegramCommand("/set BOOKING_ENABLED true", {
      controller,
    });

    expect(updateConfiguration).toHaveBeenCalledWith(
      {
        BOOKING_ENABLED: "true",
      },
      "telegram set BOOKING_ENABLED",
    );
    expect(reply).toContain("Updated BOOKING_ENABLED");
  });

  it("lists watch targets with /list", async () => {
    const controller = {
      getStatus: vi.fn(),
      runNow: vi.fn(),
      updateConfiguration: vi.fn(),
      pauseMonitoring: vi.fn(),
      resumeMonitoring: vi.fn(),
      listWatchTargets: vi.fn(() => [
        {
          id: "trip-a",
          name: "trip-a",
          campgroundId: "999",
          arrivalDate: "2026-07-20",
          nights: 2,
          excludeRvSites: true,
          preferredCampsiteIds: [],
          excludedCampsiteIds: [],
        },
      ]),
      upsertWatchTarget: vi.fn(),
      removeWatchTarget: vi.fn(),
    };

    const reply = await handleTelegramCommand("/list", { controller });

    expect(reply).toContain("trip-a");
    expect(reply).toContain("2026-07-20");
  });

  it("shows shared env keys with /env", async () => {
    const controller = {
      getStatus: vi.fn(),
      runNow: vi.fn(),
      updateConfiguration: vi.fn(),
      pauseMonitoring: vi.fn(),
      resumeMonitoring: vi.fn(),
      listWatchTargets: vi.fn(() => []),
      upsertWatchTarget: vi.fn(),
      removeWatchTarget: vi.fn(),
    };

    const reply = await handleTelegramCommand("/env", { controller });

    expect(reply).toContain("Shared .env keys you can change with /set:");
    expect(reply).toContain("BOOKING_ENABLED true|false");
    expect(reply).toContain("Use /configure <id> <campgroundId> <arrivalDate> <nights>");
  });

  it("removes watch targets with /remove", async () => {
    const removeWatchTarget = vi.fn(async () => ({
      cronExpression: "*/5 * * * *",
      configSummary: [],
      running: false,
      lastResults: [],
    }));
    const controller = {
      getStatus: vi.fn(),
      runNow: vi.fn(),
      updateConfiguration: vi.fn(),
      pauseMonitoring: vi.fn(),
      resumeMonitoring: vi.fn(),
      listWatchTargets: vi.fn(() => []),
      upsertWatchTarget: vi.fn(),
      removeWatchTarget,
    };

    const reply = await handleTelegramCommand("/remove trip-a", { controller });

    expect(removeWatchTarget).toHaveBeenCalledWith("trip-a");
    expect(reply).toContain("Removed watch target trip-a");
  });

  it("pauses and resumes monitoring with /stop and /restart", async () => {
    const pauseMonitoring = vi.fn(async () => ({
      cronExpression: "*/1 * * * *",
      configSummary: ["AGENT_ENABLED=false"],
      running: false,
      lastResults: [],
    }));
    const resumeMonitoring = vi.fn(async () => ({
      cronExpression: "*/1 * * * *",
      configSummary: ["AGENT_ENABLED=true"],
      running: false,
      lastResults: [],
    }));
    const controller = {
      getStatus: vi.fn(),
      runNow: vi.fn(),
      updateConfiguration: vi.fn(),
      pauseMonitoring,
      resumeMonitoring,
      listWatchTargets: vi.fn(() => []),
      upsertWatchTarget: vi.fn(),
      removeWatchTarget: vi.fn(),
    };

    const stopReply = await handleTelegramCommand("/stop", { controller });
    const restartReply = await handleTelegramCommand("/restart", { controller });

    expect(pauseMonitoring).toHaveBeenCalledOnce();
    expect(resumeMonitoring).toHaveBeenCalledOnce();
    expect(stopReply).toContain("Monitoring paused.");
    expect(restartReply).toContain("Monitoring resumed.");
  });

  it("keeps polling after a transient telegram fetch failure", async () => {
    const controller = {
      getStatus: vi.fn(),
      runNow: vi.fn(),
      updateConfiguration: vi.fn(),
      pauseMonitoring: vi.fn(),
      resumeMonitoring: vi.fn(),
      listWatchTargets: vi.fn(() => []),
      upsertWatchTarget: vi.fn(),
      removeWatchTarget: vi.fn(),
    };

    let callCount = 0;
    let bot: TelegramControlBot;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => ({ ok: true, result: [] }),
        };
      }

      if (callCount === 2) {
        throw new TypeError("fetch failed");
      }

      bot.stop();
      return {
        ok: true,
        json: async () => ({ ok: true, result: [] }),
      };
    });

    bot = new TelegramControlBot("bot-token", "123", controller, fetchMock as unknown as typeof fetch);
    await bot.start();

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
