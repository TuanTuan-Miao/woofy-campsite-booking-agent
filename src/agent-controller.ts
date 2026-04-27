import cron, { type ScheduledTask } from "node-cron";

import {
  clearPendingBookingState,
  getPendingBookingState,
  setPendingBookingState,
} from "./booking-state.js";
import type { ReservationRequest, WorkflowResult } from "./domain.js";
import { loadDotEnvIntoProcess, updateEnvFile } from "./env-file.js";
import { checkPendingBookingStatus } from "./pending-booking-monitor.js";
import { writeRuntimeStatus } from "./runtime-status.js";
import type { Notifier } from "./telegram-notifier.js";
import { TelegramNotifier } from "./telegram-notifier.js";
import {
  type WatchTarget,
  buildTrackedRequests,
  loadWatchTargets,
  removeWatchTarget,
  upsertWatchTarget,
} from "./watchlist.js";
import { runReservationWorkflow } from "./workflow.js";

export type WorkflowRunner = typeof runReservationWorkflow;
export type WatchRunResult = {
  id: string;
  name: string;
  result: WorkflowResult;
  status: "idle" | "cart_pending" | "payment_pending";
};

export type ControllerStatus = {
  cronExpression: string;
  configSummary: string[];
  running: boolean;
  lastResults: WatchRunResult[];
};

export class AgentController {
  private task: ScheduledTask | null = null;
  private activeRun: Promise<WatchRunResult[]> | null = null;
  private reloadRequestedDuringRun = false;
  private lastResults: WatchRunResult[] = [];
  private cronExpression = process.env.POLL_CRON || "*/5 * * * *";

  constructor(
    private readonly workflowRunner: WorkflowRunner = runReservationWorkflow,
    private readonly notifier: Notifier = new TelegramNotifier(),
  ) {}

  async start(): Promise<void> {
    await this.reload("startup", false);
    await this.safeRunNow("startup");
  }

  stop(): void {
    this.task?.stop();
    this.task?.destroy();
    this.task = null;
  }

  async runNow(reason = "manual"): Promise<WatchRunResult[]> {
    if (this.activeRun) {
      return this.activeRun;
    }

    const run = this.executeRun(reason);
    this.activeRun = run;

    try {
      const results = await run;
      this.lastResults = results;
      return results;
    } finally {
      this.activeRun = null;
      if (this.reloadRequestedDuringRun) {
        this.reloadRequestedDuringRun = false;
        await this.reload("pending-reload", true);
      }
    }
  }

  async updateConfiguration(
    updates: Record<string, string>,
    reason = "telegram update",
  ): Promise<ControllerStatus> {
    updateEnvFile(updates);
    if (this.activeRun) {
      this.reloadRequestedDuringRun = true;
    } else {
      await this.reload(reason, true);
    }

    return this.getStatus();
  }

  async pauseMonitoring(): Promise<ControllerStatus> {
    return this.updateConfiguration({ AGENT_ENABLED: "false" }, "telegram stop");
  }

  async resumeMonitoring(): Promise<ControllerStatus> {
    return this.updateConfiguration({ AGENT_ENABLED: "true" }, "telegram restart");
  }

  getStatus(): ControllerStatus {
    loadDotEnvIntoProcess();
    const status = this.buildStatusSnapshot(this.lastResults, this.activeRun !== null);
    this.persistStatus(status);
    return status;
  }

  listWatchTargets(): WatchTarget[] {
    loadDotEnvIntoProcess();
    return loadWatchTargets();
  }

  async upsertWatchTarget(target: WatchTarget): Promise<ControllerStatus> {
    upsertWatchTarget(target);
    if (this.activeRun) {
      this.reloadRequestedDuringRun = true;
    } else {
      await this.reload(`watchlist upsert ${target.id}`, true);
    }

    return this.getStatus();
  }

  async removeWatchTarget(id: string): Promise<ControllerStatus> {
    removeWatchTarget(id);
    if (this.activeRun) {
      this.reloadRequestedDuringRun = true;
    } else {
      await this.reload(`watchlist remove ${id}`, false);
    }

    return this.getStatus();
  }

  private async reload(reason: string, runImmediately: boolean): Promise<void> {
    loadDotEnvIntoProcess();
    this.cronExpression = process.env.POLL_CRON || "*/5 * * * *";

    this.stop();
    this.task = cron.schedule(this.cronExpression, () => {
      void this.safeRunNow("scheduled");
    });

    console.log(`Controller reloaded (${reason}) with cron ${this.cronExpression}`);
    this.persistStatus(this.buildStatusSnapshot(this.lastResults, this.activeRun !== null));

    if (runImmediately) {
      await this.safeRunNow(reason);
    }
  }

  private async safeRunNow(reason: string): Promise<WatchRunResult[]> {
    try {
      return await this.runNow(reason);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Controller run failed (${reason}): ${message}`);
      await this.safeNotify(`Woofy controller run failed (${reason}).\n${message}`);
      this.persistStatus(this.buildStatusSnapshot(this.lastResults, false));
      return this.lastResults;
    }
  }

  private async executeRun(reason: string): Promise<WatchRunResult[]> {
    loadDotEnvIntoProcess();
    const trackedRequests = buildTrackedRequests();
    console.log(`Starting workflow run (${reason}) for ${trackedRequests.length} target(s)`);

    if (!this.isAgentEnabled()) {
      const pausedResults = trackedRequests.map((trackedRequest) => ({
        id: trackedRequest.id,
        name: trackedRequest.name,
        status: "idle" as const,
        result: {
          observations: [],
          decision: {
            action: "skip" as const,
            reasoning: "Agent monitoring is paused.",
            confidence: 1,
          },
          bookingReceipt: null,
          journal: ["Agent monitoring is paused."],
        },
      }));
      this.persistStatus({
        ...this.buildStatusSnapshot(pausedResults, false),
      });
      return pausedResults;
    }

    const results: WatchRunResult[] = [];
    for (const trackedRequest of trackedRequests) {
      try {
        const pendingState = getPendingBookingState(trackedRequest.id);
        if (pendingState) {
          const pendingStatus = await checkPendingBookingStatus(trackedRequest.request, pendingState);
          if (pendingStatus.active) {
            const result: WorkflowResult = {
              observations: [],
              decision: {
                action: "skip",
                selectedCampsiteId: pendingState.receipt.campsiteId,
                selectedCampsiteName: pendingState.receipt.campsiteName,
                reasoning: pendingStatus.details,
                confidence: 1,
              },
              bookingReceipt: {
                ...pendingState.receipt,
                finalUrl: pendingStatus.finalUrl ?? pendingState.receipt.finalUrl,
              },
              journal: [`Pending booking for ${trackedRequest.name} is still active.`],
            };

            console.log(
              JSON.stringify(
                {
                  watchId: trackedRequest.id,
                  watchName: trackedRequest.name,
                  status: pendingState.status,
                  result,
                },
                null,
                2,
              ),
            );
            await this.safeNotify(
              [
                `Woofy still has an active cart hold for ${trackedRequest.name}.`,
                pendingStatus.details,
                pendingStatus.finalUrl ? `Open this page to finish manually: ${pendingStatus.finalUrl}` : "",
              ]
                .filter(Boolean)
                .join("\n"),
            );
            results.push({
              id: trackedRequest.id,
              name: trackedRequest.name,
              result,
              status: pendingState.status,
            });
            continue;
          }

          clearPendingBookingState(trackedRequest.id);
          await this.safeNotify(
            [
              `Pending hold released for ${trackedRequest.name}.`,
              pendingStatus.details,
              pendingStatus.finalUrl ? `Last known page: ${pendingStatus.finalUrl}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }

        const result = await this.workflowRunner(trackedRequest.request);
        const status =
          result.bookingReceipt?.success
            ? result.bookingReceipt.commitMode === "payment"
              ? "payment_pending"
              : "cart_pending"
            : "idle";
        if ((status === "payment_pending" || status === "cart_pending") && result.bookingReceipt) {
          setPendingBookingState(trackedRequest.id, result.bookingReceipt);
        }
        await this.notifyForResult(trackedRequest.name, trackedRequest.request, result);
        console.log(
          JSON.stringify(
            {
              watchId: trackedRequest.id,
              watchName: trackedRequest.name,
              status,
              result,
            },
            null,
            2,
          ),
        );
        results.push({
          id: trackedRequest.id,
          name: trackedRequest.name,
          result,
          status,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failureResult: WorkflowResult = {
          observations: [],
          decision: {
            action: "wait",
            reasoning: `Run failed for ${trackedRequest.name}: ${message}`,
            confidence: 0,
          },
          bookingReceipt: null,
          journal: [message],
        };
        console.error(
          JSON.stringify(
            {
              watchId: trackedRequest.id,
              watchName: trackedRequest.name,
              status: "idle",
              error: message,
            },
            null,
            2,
          ),
        );
        await this.safeNotify(
          [
            `Woofy booking attempt failed for ${trackedRequest.name}.`,
            message,
          ].join("\n"),
        );
        results.push({
          id: trackedRequest.id,
          name: trackedRequest.name,
          result: failureResult,
          status: "idle",
        });
      }
    }

    this.persistStatus({
      ...this.buildStatusSnapshot(results, false),
    });
    return results;
  }

  private isAgentEnabled(): boolean {
    const value = process.env.AGENT_ENABLED;
    return value === undefined || value === "" ? true : value.toLowerCase() === "true";
  }

  private buildStatusSnapshot(lastResults: WatchRunResult[], running: boolean): ControllerStatus {
    let watchTargets: ReturnType<typeof loadWatchTargets> = [];
    let watchlistError: string | null = null;
    try {
      watchTargets = loadWatchTargets();
    } catch (error) {
      watchlistError = error instanceof Error ? error.message : String(error);
    }

    return {
      cronExpression: this.cronExpression,
      configSummary: [
        `AGENT_ENABLED=${this.isAgentEnabled()}`,
        `WATCH_COUNT=${watchTargets.length || 1}`,
        `CAMPGROUND_ID=${process.env.CAMPGROUND_ID ?? ""}`,
        `ARRIVAL_DATE=${process.env.ARRIVAL_DATE ?? ""}`,
        `NIGHTS=${process.env.NIGHTS ?? ""}`,
        `PREFERRED_CAMPSITE_IDS=${process.env.PREFERRED_CAMPSITE_IDS ?? ""}`,
        `BOOKING_ENABLED=${process.env.BOOKING_ENABLED ?? ""}`,
        `COMMIT_MODE=${process.env.COMMIT_MODE ?? ""}`,
        ...(watchlistError ? [`WATCHLIST_ERROR=${watchlistError}`] : []),
        ...watchTargets.map(
          (target) =>
            `WATCH:${target.id} ${target.campgroundId} ${target.arrivalDate} ${target.nights}n${target.excludeRvSites ? " excludeRV" : ""}`,
        ),
      ],
      running,
      lastResults,
    };
  }

  private persistStatus(status: ControllerStatus): void {
    writeRuntimeStatus({
      updatedAt: new Date().toISOString(),
      pid: process.pid,
      agentEnabled: this.isAgentEnabled(),
      cronExpression: status.cronExpression,
      running: status.running,
      configSummary: status.configSummary,
      lastResults: status.lastResults.map((item) => ({
        id: item.id,
        name: item.name,
        status: item.status,
        decisionAction: item.result.decision.action,
        reasoning: item.result.decision.reasoning,
        ...(item.result.bookingReceipt?.details
          ? { bookingDetails: item.result.bookingReceipt.details }
          : {}),
        ...(item.result.bookingReceipt?.finalUrl
          ? { bookingUrl: item.result.bookingReceipt.finalUrl }
          : {}),
      })),
    });
  }

  private async notifyForResult(
    watchName: string,
    request: ReservationRequest,
    result: WorkflowResult,
  ): Promise<void> {
    const availableObservations = result.observations.filter((observation) => observation.available);
    if (availableObservations.length === 0) {
      return;
    }

    const header = [
      "Woofy found campsite availability.",
      `Watch: ${watchName}`,
      `Arrival: ${request.arrivalDate}`,
      `Nights: ${request.nights}`,
      `Decision: ${result.decision.action}`,
      `Reasoning: ${result.decision.reasoning}`,
    ];

    const sites = availableObservations
      .slice(0, 5)
      .map((observation) => `- ${observation.campsiteName} (${observation.campsiteId})`);

    const bookingDetails =
      result.bookingReceipt?.finalUrl
        ? [
            `Booking stage reached: ${result.bookingReceipt.details}`,
            `Open this page to finish manually: ${result.bookingReceipt.finalUrl}`,
          ]
        : [];

    await this.safeNotify([...header, ...sites, ...bookingDetails].join("\n"));
  }

  private async safeNotify(text: string): Promise<void> {
    try {
      await this.notifier.sendMessage(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Notifier error: ${message}`);
    }
  }
}
