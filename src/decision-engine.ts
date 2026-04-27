import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

import {
  type AvailabilityObservation,
  type BookingDecision,
  BookingDecisionSchema,
  type ReservationRequest,
} from "./domain.js";

export interface DecisionEngine {
  evaluate(request: ReservationRequest, observations: AvailabilityObservation[]): Promise<BookingDecision>;
}

export class RuleBasedDecisionEngine implements DecisionEngine {
  async evaluate(
    request: ReservationRequest,
    observations: AvailabilityObservation[],
  ): Promise<BookingDecision> {
    const availableCandidates = observations
      .filter((observation) => observation.available)
      .filter(
        (observation) =>
          observation.totalPrice === undefined || observation.totalPrice <= request.maxTotalPrice,
      )
      .sort((left, right) => left.priority - right.priority);

    const strictMatch = availableCandidates.find((candidate) => candidate.strictPreference);
    if (strictMatch) {
      return {
        action: "book",
        selectedCampsiteId: strictMatch.campsiteId,
        selectedCampsiteName: strictMatch.campsiteName,
        reasoning: `Primary site ${strictMatch.campsiteName} is available within price limits.`,
        confidence: 0.95,
      };
    }

    if (request.allowAlternatives && availableCandidates.length > 0) {
      const [selected] = availableCandidates;
      if (!selected) {
        return {
          action: "wait",
          reasoning: "No acceptable alternative campsite was available after filtering.",
          confidence: 0.5,
        };
      }

      return {
        action: "book",
        selectedCampsiteId: selected.campsiteId,
        selectedCampsiteName: selected.campsiteName,
        reasoning: `Primary site was unavailable, so the system selected fallback ${selected.campsiteName}.`,
        confidence: 0.82,
      };
    }

    const notYetReleased = observations.find(
      (observation) => observation.releaseState === "not_yet_released",
    );
    if (notYetReleased) {
      return {
        action: "wait",
        reasoning: `${notYetReleased.campsiteName} is not yet released for booking.`,
        confidence: 0.72,
      };
    }

    return {
      action: "wait",
      reasoning: "No acceptable campsite is available yet, so the workflow should keep polling.",
      confidence: 0.7,
    };
  }
}

const StructuredDecisionSchema = z.object({
  action: z.enum(["book", "wait", "skip"]),
  selectedCampsiteId: z.string().optional(),
  selectedCampsiteName: z.string().optional(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

export class LangChainDecisionEngine implements DecisionEngine {
  private readonly fallback = new RuleBasedDecisionEngine();

  constructor(
    private readonly apiKey: string | undefined,
    private readonly modelName = process.env.OPENAI_MODEL || "gpt-4.1-mini",
  ) {}

  async evaluate(
    request: ReservationRequest,
    observations: AvailabilityObservation[],
  ): Promise<BookingDecision> {
    if (!this.apiKey) {
      return this.fallback.evaluate(request, observations);
    }

    try {
      const model = new ChatOpenAI({
        apiKey: this.apiKey,
        model: this.modelName,
        temperature: 0,
      }).withStructuredOutput(StructuredDecisionSchema, {
        name: "campground_booking_decision",
        strict: true,
      });

      const decision = await model.invoke([
        {
          role: "system",
          content:
            "You are a campground booking strategist. Prefer the strict preference campsite. Only choose alternatives if allowed, available, and within price. Return wait when nothing acceptable can be booked right now.",
        },
        {
          role: "user",
          content: JSON.stringify({
            request,
            observations,
          }),
        },
      ]);

      return BookingDecisionSchema.parse(decision);
    } catch {
      return this.fallback.evaluate(request, observations);
    }
  }
}
