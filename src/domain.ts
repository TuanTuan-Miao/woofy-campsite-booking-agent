import { z } from "zod";

export const CandidateSiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().url(),
  priority: z.number().int().nonnegative(),
  strictPreference: z.boolean().default(false),
});

export const CommitModeSchema = z.enum(["cart", "payment"]);

export const ReservationRequestSchema = z.object({
  arrivalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nights: z.number().int().positive(),
  partySize: z.number().int().positive(),
  campgroundId: z.string().optional(),
  campsiteType: z.string().optional(),
  excludeRvSites: z.boolean().default(false),
  preferredCampsiteIds: z.array(z.string()).default([]),
  excludedCampsiteIds: z.array(z.string()).default([]),
  bookingEnabled: z.boolean(),
  allowAlternatives: z.boolean(),
  maxTotalPrice: z.number().positive(),
  headless: z.boolean(),
  baseUrl: z.string().url(),
  email: z.string().min(1),
  password: z.string().min(1),
  commitMode: CommitModeSchema,
  candidates: z.array(CandidateSiteSchema).default([]),
}).superRefine((value, context) => {
  if (!value.campgroundId && value.candidates.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide either campgroundId or at least one direct campsite candidate.",
      path: ["campgroundId"],
    });
  }
});

export const AvailabilityObservationSchema = z.object({
  campsiteId: z.string(),
  campsiteName: z.string(),
  url: z.string().url(),
  available: z.boolean(),
  releaseState: z.enum(["available", "unavailable", "not_yet_released", "unknown"]),
  totalPrice: z.number().nonnegative().optional(),
  arrivalDate: z.string(),
  nights: z.number().int().positive(),
  notes: z.array(z.string()).default([]),
  strictPreference: z.boolean(),
  priority: z.number().int().nonnegative(),
});

export const BookingDecisionSchema = z.object({
  action: z.enum(["book", "wait", "skip"]),
  selectedCampsiteId: z.string().optional(),
  selectedCampsiteName: z.string().optional(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

export const BookingReceiptSchema = z.object({
  success: z.boolean(),
  campsiteId: z.string(),
  campsiteName: z.string(),
  commitMode: CommitModeSchema,
  reservationReference: z.string().optional(),
  finalUrl: z.string().url().optional(),
  details: z.string(),
});

export const WorkflowResultSchema = z.object({
  observations: z.array(AvailabilityObservationSchema),
  decision: BookingDecisionSchema,
  bookingReceipt: BookingReceiptSchema.nullable(),
  journal: z.array(z.string()),
});

export type CandidateSite = z.infer<typeof CandidateSiteSchema>;
export type ReservationRequest = z.infer<typeof ReservationRequestSchema>;
export type AvailabilityObservation = z.infer<typeof AvailabilityObservationSchema>;
export type BookingDecision = z.infer<typeof BookingDecisionSchema>;
export type BookingReceipt = z.infer<typeof BookingReceiptSchema>;
export type WorkflowResult = z.infer<typeof WorkflowResultSchema>;
