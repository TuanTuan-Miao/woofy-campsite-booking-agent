import { AgentController } from "./agent-controller.js";
import { runReservationWorkflow } from "./workflow.js";
import { TelegramControlBot } from "./telegram-control.js";
import { buildTrackedRequests } from "./watchlist.js";

const installProcessGuards = (): void => {
  process.on("unhandledRejection", (error) => {
    console.error("Unhandled promise rejection in Woofy:", error);
  });

  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception in Woofy:", error);
  });
};

const main = async (): Promise<void> => {
  const command = process.argv[2] ?? "run-once";

  if (command === "schedule" || command === "bot") {
    installProcessGuards();
    const controller = new AgentController();
    await controller.start();

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (command === "bot") {
      if (!token) {
        throw new Error("TELEGRAM_BOT_TOKEN is required for bot mode.");
      }

      const bot = new TelegramControlBot(token, process.env.TELEGRAM_CHAT_ID, controller);
      await bot.start();
      return;
    }

    if (token) {
      const bot = new TelegramControlBot(token, process.env.TELEGRAM_CHAT_ID, controller);
      void bot.start().catch((error) => {
        console.error("Telegram control bot failed:", error);
      });
      console.log("Telegram control bot started.");
    }

    console.log(`Scheduler started with cron ${process.env.POLL_CRON || "*/5 * * * *"}`);
    await new Promise(() => {
      setInterval(() => undefined, 60_000);
    });
    return;
  }

  const trackedRequests = buildTrackedRequests();
  const results = [];
  for (const trackedRequest of trackedRequests) {
    const result = await runReservationWorkflow(trackedRequest.request);
    results.push({
      watchId: trackedRequest.id,
      watchName: trackedRequest.name,
      result,
    });
  }
  console.log(JSON.stringify(results, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
