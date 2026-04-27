import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";

import { CompositeReservationAdapter } from "./composite-adapter.js";
import { LangChainDecisionEngine, type DecisionEngine, RuleBasedDecisionEngine } from "./decision-engine.js";
import {
  type AvailabilityObservation,
  type BookingDecision,
  type BookingReceipt,
  type ReservationRequest,
  WorkflowResultSchema,
} from "./domain.js";
import { WorkflowLogger } from "./log.js";
import type { ReservationAdapter } from "./recreation-adapter.js";

const WorkflowState = new StateSchema({
  request: z.any(),
  observations: z.array(z.any()).default([]),
  decision: z.any().nullable().default(null),
  bookingReceipt: z.any().nullable().default(null),
  journal: z.array(z.string()).default([]),
});

type WorkflowStateValue = {
  request: ReservationRequest;
  observations: AvailabilityObservation[];
  decision: BookingDecision | null;
  bookingReceipt: BookingReceipt | null;
  journal: string[];
};

export type WorkflowDependencies = {
  adapter?: ReservationAdapter;
  decisionEngine?: DecisionEngine;
  logger?: WorkflowLogger;
};

const chooseDecisionEngine = (): DecisionEngine => {
  if (process.env.OPENAI_API_KEY) {
    return new LangChainDecisionEngine(process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL);
  }

  return new RuleBasedDecisionEngine();
};

export const runReservationWorkflow = async (
  request: ReservationRequest,
  dependencies: WorkflowDependencies = {},
) => {
  const adapter = dependencies.adapter ?? new CompositeReservationAdapter();
  const decisionEngine = dependencies.decisionEngine ?? chooseDecisionEngine();
  const logger = dependencies.logger ?? new WorkflowLogger();

  const graph = new StateGraph(WorkflowState)
    .addNode("scout", async (state: WorkflowStateValue) => {
      logger.info("Scout agent is checking campsite availability.");
      const observations = await adapter.scanAvailability(state.request);
      return {
        observations,
        journal: [`Scout observed ${observations.length} campsite candidates.`],
      };
    })
    .addNode("strategist", async (state: WorkflowStateValue) => {
      logger.info("Strategy agent is evaluating booking options.");
      const decision = await decisionEngine.evaluate(state.request, state.observations);
      return {
        decision,
        journal: [`Strategy decided to ${decision.action}. ${decision.reasoning}`],
      };
    })
    .addNode("risk", async (state: WorkflowStateValue) => {
      logger.info("Risk agent is validating guardrails.");
      const decision = state.decision;
      if (!decision) {
        throw new Error("No decision was available for the risk review step.");
      }

      if (decision.action !== "book") {
        return {
          journal: ["Risk agent approved a non-booking outcome."],
        };
      }

      const selected = state.observations.find(
        (observation) => observation.campsiteId === decision.selectedCampsiteId,
      );

      if (!selected) {
        return {
          decision: {
            action: "wait",
            reasoning: "The selected campsite could not be found in scout observations.",
            confidence: 0.2,
          },
          journal: ["Risk agent downgraded the booking because the target campsite was missing."],
        };
      }

      if (!state.request.allowAlternatives && !selected.strictPreference) {
        return {
          decision: {
            action: "wait",
            reasoning: "Fallback campsites are disabled, so the system will keep polling.",
            confidence: 0.9,
          },
          journal: ["Risk agent blocked the fallback campsite because alternatives are disabled."],
        };
      }

      if (selected.totalPrice !== undefined && selected.totalPrice > state.request.maxTotalPrice) {
        return {
          decision: {
            action: "wait",
            reasoning: `Selected campsite exceeds the max price threshold of $${state.request.maxTotalPrice}.`,
            confidence: 0.95,
          },
          journal: ["Risk agent blocked the booking because the price exceeded the configured maximum."],
        };
      }

      if (!state.request.bookingEnabled) {
        return {
          decision: {
            ...decision,
            action: "skip",
            reasoning: `${decision.reasoning} Booking is currently disabled, so execution stops before reservation.`,
            confidence: decision.confidence,
          },
          journal: ["Risk agent converted the booking to a skip because BOOKING_ENABLED=false."],
        };
      }

      return {
        journal: ["Risk agent approved the booking attempt."],
      };
    })
    .addNode("booker", async (state: WorkflowStateValue) => {
      const decision = state.decision;
      if (!decision || decision.action !== "book" || !decision.selectedCampsiteId) {
        throw new Error("Booker reached an invalid state.");
      }

      logger.info(`Booking agent is attempting ${decision.selectedCampsiteName ?? decision.selectedCampsiteId}.`);
      const bookingReceipt = await adapter.book(state.request, decision.selectedCampsiteId);
      return {
        bookingReceipt,
        journal: [`Booking agent completed with success=${bookingReceipt.success}.`],
      };
    })
    .addEdge(START, "scout")
    .addEdge("scout", "strategist")
    .addEdge("strategist", "risk")
    .addConditionalEdges("risk", (state: WorkflowStateValue) => {
      return state.decision?.action === "book" ? "booker" : END;
    })
    .addEdge("booker", END)
    .compile();

  const result = (await graph.invoke({
    request,
    observations: [],
    decision: null,
    bookingReceipt: null,
    journal: [],
  })) as WorkflowStateValue;

  return WorkflowResultSchema.parse({
    observations: result.observations,
    decision: result.decision,
    bookingReceipt: result.bookingReceipt,
    journal: [...logger.snapshot(), ...result.journal],
  });
};
