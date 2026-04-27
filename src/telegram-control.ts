import { WatchTargetSchema } from "./watchlist.js";
import type { AgentController } from "./agent-controller.js";

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: {
      id: number;
    };
    text?: string;
  };
};

type TelegramGetUpdatesResponse = {
  ok: boolean;
  result: TelegramUpdate[];
};

type FetchLike = typeof fetch;

type CommandContext = {
  controller: Pick<
    AgentController,
    | "getStatus"
    | "runNow"
    | "updateConfiguration"
    | "listWatchTargets"
    | "upsertWatchTarget"
    | "removeWatchTarget"
    | "pauseMonitoring"
    | "resumeMonitoring"
  >;
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const BOT_HELP = [
  "Woofy Telegram commands:",
  "/help - show this help message",
  "/start - resume monitoring and run immediately",
  "/restart - resume monitoring and run immediately",
  "/stop - pause monitoring but keep the bot online",
  "/status - show active config",
  "/list - list watch targets",
  "/env - list shared .env keys you can change with /set",
  "/run - run the checker immediately",
  "/configure <id> <campgroundId> <arrivalDate> <nights> [excludeRV=true|false] - create or replace a watch target",
  "/remove <id> - remove a watch target",
  "/set <KEY> <VALUE> - update any .env key and restart checking",
].join("\n");

const ENV_HELP = [
  "Shared .env keys you can change with /set:",
  "RECREATION_EMAIL <email>",
  "RECREATION_PASSWORD <password>",
  "AGENT_ENABLED true|false",
  "BOOKING_ENABLED true|false",
  "COMMIT_MODE cart",
  "MAX_TOTAL_PRICE <number>",
  "ALLOW_ALTERNATIVES true|false",
  "HEADLESS true|false",
  "POLL_CRON <cron>",
  "CAMPSITE_TYPE <type>",
  "PREFERRED_CAMPSITE_IDS <id1,id2>",
  "EXCLUDED_CAMPSITE_IDS <id1,id2>",
  "TELEGRAM_BOT_TOKEN <token>",
  "TELEGRAM_CHAT_ID <chat_id>",
  "",
  "Per-trip values like campground/date/nights belong in the watchlist.",
  "Use /configure <id> <campgroundId> <arrivalDate> <nights> [excludeRV=true|false] for those.",
].join("\n");

const formatStatus = (status: ReturnType<AgentController["getStatus"]>): string => {
  const lines = [
    `Cron: ${status.cronExpression}`,
    `Running: ${status.running}`,
    ...status.configSummary,
  ];

  for (const item of status.lastResults.slice(0, 5)) {
    lines.push(`Last ${item.name}: ${item.result.decision.action}`);
    lines.push(`Reasoning: ${item.result.decision.reasoning}`);
  }

  return lines.join("\n");
};

const formatWatchTargets = (
  targets: ReturnType<AgentController["listWatchTargets"]>,
): string => {
  if (targets.length === 0) {
    return "No watch targets are configured. Falling back to single-target .env mode.";
  }

  return targets
    .map(
      (target) =>
        `${target.id}: ${target.name} | campground=${target.campgroundId} | arrival=${target.arrivalDate} | nights=${target.nights}${target.excludeRvSites ? " | excludeRV=true" : ""}${target.campsiteType ? ` | type=${target.campsiteType}` : ""}`,
    )
    .join("\n");
};

export const handleTelegramCommand = async (
  text: string,
  context: CommandContext,
): Promise<string> => {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "/help") {
    return BOT_HELP;
  }

  if (trimmed === "/start" || trimmed === "/restart" || trimmed === "/resume") {
    const status = await context.controller.resumeMonitoring();
    return `Monitoring resumed.\n${formatStatus(status)}`;
  }

  if (trimmed === "/stop") {
    const status = await context.controller.pauseMonitoring();
    return `Monitoring paused.\n${formatStatus(status)}`;
  }

  if (trimmed === "/status") {
    return formatStatus(context.controller.getStatus());
  }

  if (trimmed === "/list") {
    return formatWatchTargets(context.controller.listWatchTargets());
  }

  if (trimmed === "/env") {
    return ENV_HELP;
  }

  if (trimmed === "/run") {
    const results = await context.controller.runNow("telegram");
    return results
      .map(
        (item) =>
          `${item.name}: ${item.result.decision.action} - ${item.result.decision.reasoning}`,
      )
      .join("\n");
  }

  if (trimmed.startsWith("/configure ")) {
    const [, id, campgroundId, arrivalDate, nights, excludeRvValue] = trimmed.split(/\s+/);
    if (!id || !campgroundId || !arrivalDate || !nights) {
      return "Usage: /configure <id> <campgroundId> <arrivalDate> <nights> [excludeRV=true|false]";
    }

    const target = WatchTargetSchema.parse({
      id,
      name: id,
      campgroundId,
      arrivalDate,
      nights: Number(nights),
      excludeRvSites: excludeRvValue ? excludeRvValue.toLowerCase() === "true" : undefined,
    });
    const status = await context.controller.upsertWatchTarget(target);

    return `Updated watch target ${id} and restarted checking.\n${formatStatus(status)}`;
  }

  if (trimmed.startsWith("/remove ")) {
    const [, id] = trimmed.split(/\s+/);
    if (!id) {
      return "Usage: /remove <id>";
    }

    const status = await context.controller.removeWatchTarget(id);
    return `Removed watch target ${id}.\n${formatStatus(status)}`;
  }

  if (trimmed.startsWith("/set ")) {
    const parts = trimmed.split(/\s+/);
    const key = parts[1];
    const value = trimmed.slice(`/set ${key ?? ""}`.length).trim();
    if (!key || value === "") {
      return "Usage: /set <KEY> <VALUE>";
    }

    const status = await context.controller.updateConfiguration(
      {
        [key]: value,
      },
      `telegram set ${key}`,
    );

    return `Updated ${key} and restarted checking.\n${formatStatus(status)}`;
  }

  return BOT_HELP;
};

export class TelegramControlBot {
  private offset = 0;
  private stopped = false;

  constructor(
    private readonly token: string,
    private readonly chatId: string | undefined,
    private readonly controller: Pick<
      AgentController,
      | "getStatus"
      | "runNow"
      | "updateConfiguration"
      | "listWatchTargets"
      | "upsertWatchTarget"
      | "removeWatchTarget"
      | "pauseMonitoring"
      | "resumeMonitoring"
    >,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async start(): Promise<void> {
    await this.safeSendMessage("Woofy control bot is online. Send /help for commands.");
    let consecutiveFailures = 0;

    while (!this.stopped) {
      try {
        const updates = await this.getUpdates();
        consecutiveFailures = 0;

        for (const update of updates) {
          this.offset = update.update_id + 1;
          if (!update.message?.text) {
            continue;
          }

          if (this.chatId && String(update.message.chat.id) !== this.chatId) {
            continue;
          }

          try {
            const reply = await handleTelegramCommand(update.message.text, {
              controller: this.controller,
            });
            await this.sendMessage(reply, update.message.chat.id);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.safeSendMessage(`Command failed: ${message}`, update.message.chat.id);
          }
        }
      } catch (error) {
        consecutiveFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Telegram control bot loop failed: ${message}`);
        await sleep(Math.min(30_000, 1000 * 2 ** Math.min(consecutiveFailures - 1, 5)));
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const url = new URL(`https://api.telegram.org/bot${this.token}/getUpdates`);
    url.searchParams.set("timeout", "20");
    url.searchParams.set("offset", String(this.offset));

    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Telegram getUpdates failed with ${response.status}`);
    }

    const payload = (await response.json()) as TelegramGetUpdatesResponse;
    return payload.result ?? [];
  }

  private async sendMessage(text: string, chatId: string | number | undefined = this.chatId): Promise<void> {
    if (!chatId) {
      return;
    }

    const url = new URL(`https://api.telegram.org/bot${this.token}/sendMessage`);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: String(chatId),
        text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed with ${response.status}`);
    }
  }

  private async safeSendMessage(text: string, chatId: string | number | undefined = this.chatId): Promise<void> {
    try {
      await this.sendMessage(text, chatId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Telegram control bot send failed: ${message}`);
    }
  }
}
