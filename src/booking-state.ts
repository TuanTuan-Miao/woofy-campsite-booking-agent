import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { BookingReceipt } from "./domain.js";

const resolveStatePath = (): string => path.resolve(process.cwd(), ".runtime", "booking-state.json");

const PendingStatusSchema = z.enum(["cart_pending", "payment_pending"]);

const PendingBookingStateSchema = z.object({
  status: PendingStatusSchema,
  updatedAt: z.string(),
  receipt: z.object({
    success: z.boolean(),
    campsiteId: z.string(),
    campsiteName: z.string(),
    commitMode: z.enum(["cart", "payment"]),
    reservationReference: z.string().optional(),
    finalUrl: z.string().url().optional(),
    details: z.string(),
  }),
});

const BookingStateFileSchema = z.object({
  watches: z.record(z.string(), PendingBookingStateSchema).default({}),
});

export type PendingBookingState = z.infer<typeof PendingBookingStateSchema>;
export type BookingStateFile = z.infer<typeof BookingStateFileSchema>;
export type PendingBookingStatus = z.infer<typeof PendingStatusSchema>;

const ensureRuntimeDir = (): void => {
  mkdirSync(path.dirname(resolveStatePath()), { recursive: true });
};

export const loadBookingStateFile = (): BookingStateFile => {
  const statePath = resolveStatePath();
  if (!existsSync(statePath)) {
    return { watches: {} };
  }

  const contents = readFileSync(statePath, "utf8").trim();
  if (contents === "") {
    return { watches: {} };
  }

  return BookingStateFileSchema.parse(JSON.parse(contents));
};

export const saveBookingStateFile = (state: BookingStateFile): void => {
  ensureRuntimeDir();
  writeFileSync(resolveStatePath(), `${JSON.stringify(BookingStateFileSchema.parse(state), null, 2)}\n`, "utf8");
};

export const getPendingBookingState = (watchId: string): PendingBookingState | null => {
  const state = loadBookingStateFile();
  return state.watches[watchId] ?? null;
};

export const setPendingBookingState = (watchId: string, receipt: BookingReceipt): void => {
  const state = loadBookingStateFile();
  state.watches[watchId] = {
    status: receipt.commitMode === "payment" ? "payment_pending" : "cart_pending",
    updatedAt: new Date().toISOString(),
    receipt,
  };
  saveBookingStateFile(state);
};

export const clearPendingBookingState = (watchId: string): void => {
  const state = loadBookingStateFile();
  if (!(watchId in state.watches)) {
    return;
  }

  delete state.watches[watchId];
  saveBookingStateFile(state);
};
