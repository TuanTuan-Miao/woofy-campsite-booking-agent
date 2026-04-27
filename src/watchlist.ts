import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { loadDotEnvIntoProcess } from "./env-file.js";
import {
  buildReservationRequest,
  loadReservationRequestFromEnv,
  loadSharedReservationConfigFromEnv,
} from "./config.js";
import { CommitModeSchema, type ReservationRequest } from "./domain.js";

const resolveDefaultWatchlistPath = (): string => path.resolve(process.cwd(), "watchlist.json");

export const WatchTargetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  campgroundId: z.string().min(1),
  arrivalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nights: z.number().int().positive(),
  partySize: z.number().int().positive().optional(),
  campsiteType: z.string().optional(),
  excludeRvSites: z.boolean().optional(),
  preferredCampsiteIds: z.array(z.string()).default([]),
  excludedCampsiteIds: z.array(z.string()).default([]),
  bookingEnabled: z.boolean().optional(),
  allowAlternatives: z.boolean().optional(),
  maxTotalPrice: z.number().positive().optional(),
  commitMode: CommitModeSchema.optional(),
});

export type WatchTarget = z.infer<typeof WatchTargetSchema>;

export type TrackedReservationRequest = {
  id: string;
  name: string;
  request: ReservationRequest;
};

const WatchlistSchema = z.array(WatchTargetSchema);

export const loadWatchTargets = (watchlistPath = resolveDefaultWatchlistPath()): WatchTarget[] => {
  if (!existsSync(watchlistPath)) {
    return [];
  }

  const contents = readFileSync(watchlistPath, "utf8").trim();
  if (contents === "") {
    return [];
  }

  return WatchlistSchema.parse(JSON.parse(contents));
};

export const saveWatchTargets = (
  targets: WatchTarget[],
  watchlistPath = resolveDefaultWatchlistPath(),
): void => {
  const normalized = WatchlistSchema.parse(targets);
  writeFileSync(watchlistPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
};

export const upsertWatchTarget = (
  target: WatchTarget,
  watchlistPath = resolveDefaultWatchlistPath(),
): WatchTarget[] => {
  const normalizedTarget = WatchTargetSchema.parse(target);
  const existing = loadWatchTargets(watchlistPath);
  const next = existing.filter((item) => item.id !== normalizedTarget.id);
  next.push(normalizedTarget);
  next.sort((left, right) => left.id.localeCompare(right.id));
  saveWatchTargets(next, watchlistPath);
  return next;
};

export const removeWatchTarget = (
  id: string,
  watchlistPath = resolveDefaultWatchlistPath(),
): WatchTarget[] => {
  const existing = loadWatchTargets(watchlistPath);
  const next = existing.filter((item) => item.id !== id);
  saveWatchTargets(next, watchlistPath);
  return next;
};

export const buildTrackedRequests = (
  watchlistPath = resolveDefaultWatchlistPath(),
): TrackedReservationRequest[] => {
  loadDotEnvIntoProcess();
  const watchTargets = loadWatchTargets(watchlistPath);
  if (watchTargets.length === 0) {
    return [
      {
        id: "env-default",
        name: "Env default",
        request: loadReservationRequestFromEnv(),
      },
    ];
  }

  const shared = loadSharedReservationConfigFromEnv();
  return watchTargets.map((target) => ({
    id: target.id,
    name: target.name,
    request: buildReservationRequest(
      {
        arrivalDate: target.arrivalDate,
        nights: target.nights,
        partySize: target.partySize ?? shared.partySize,
        campgroundId: target.campgroundId,
        campsiteType: target.campsiteType,
        excludeRvSites: target.excludeRvSites ?? false,
        preferredCampsiteIds: target.preferredCampsiteIds,
        excludedCampsiteIds: target.excludedCampsiteIds,
        bookingEnabled: target.bookingEnabled ?? shared.bookingEnabled,
        allowAlternatives: target.allowAlternatives ?? shared.allowAlternatives,
        maxTotalPrice: target.maxTotalPrice ?? shared.maxTotalPrice,
        commitMode: target.commitMode ?? shared.commitMode,
      },
      shared,
    ),
  }));
};

export const getDefaultWatchlistPath = (): string => resolveDefaultWatchlistPath();
