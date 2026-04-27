import cron from "node-cron";

import { type ReservationRequest } from "./domain.js";
import { runReservationWorkflow } from "./workflow.js";

export const startScheduler = (request: ReservationRequest, cronExpression: string): void => {
  cron.schedule(cronExpression, async () => {
    try {
      const result = await runReservationWorkflow(request);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Scheduled workflow failed:", error);
    }
  });
};
