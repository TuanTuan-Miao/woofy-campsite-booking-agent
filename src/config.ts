import { config as loadDotEnv } from "dotenv";

import { type CandidateSite, ReservationRequestSchema, type ReservationRequest } from "./domain.js";

loadDotEnv();

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === "") {
    return fallback;
  }

  return value.toLowerCase() === "true";
};

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number value: ${value}`);
  }

  return parsed;
};

const buildCandidates = (): CandidateSite[] => {
  const primaryUrl = process.env.PRIMARY_CAMPSITE_URL;
  if (!primaryUrl) {
    return [];
  }

  const primaryName = process.env.PRIMARY_CAMPSITE_NAME || "Primary campsite";
  const candidates: CandidateSite[] = [
    {
      id: "primary",
      name: primaryName,
      url: primaryUrl,
      priority: 0,
      strictPreference: true,
    },
  ];

  const alternativeUrls = (process.env.ALTERNATIVE_CAMPSITE_URLS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  alternativeUrls.forEach((url, index) => {
    candidates.push({
      id: `alternative-${index + 1}`,
      name: `Alternative campsite ${index + 1}`,
      url,
      priority: index + 1,
      strictPreference: false,
    });
  });

  return candidates;
};

export type SharedReservationConfig = {
  agentEnabled: boolean;
  partySize: number;
  bookingEnabled: boolean;
  allowAlternatives: boolean;
  maxTotalPrice: number;
  headless: boolean;
  baseUrl: string;
  email: string;
  password: string;
  commitMode: ReservationRequest["commitMode"];
  candidates: CandidateSite[];
};

export const loadSharedReservationConfigFromEnv = (): SharedReservationConfig => {
  const commitMode = process.env.COMMIT_MODE === "checkout" ? "payment" : process.env.COMMIT_MODE || "cart";

  return {
    agentEnabled: parseBoolean(process.env.AGENT_ENABLED, true),
    partySize: parseNumber(process.env.PARTY_SIZE, 2),
    bookingEnabled: parseBoolean(process.env.BOOKING_ENABLED, false),
    allowAlternatives: parseBoolean(process.env.ALLOW_ALTERNATIVES, true),
    maxTotalPrice: parseNumber(process.env.MAX_TOTAL_PRICE, 250),
    headless: parseBoolean(process.env.HEADLESS, true),
    baseUrl: process.env.RECREATION_BASE_URL || "https://www.recreation.gov",
    email: process.env.RECREATION_EMAIL || "",
    password: process.env.RECREATION_PASSWORD || "",
    commitMode: commitMode as ReservationRequest["commitMode"],
    candidates: buildCandidates(),
  };
};

export const buildReservationRequest = (
  overrides: Partial<ReservationRequest>,
  shared = loadSharedReservationConfigFromEnv(),
): ReservationRequest => {
  return ReservationRequestSchema.parse({
    partySize: shared.partySize,
    bookingEnabled: shared.bookingEnabled,
    allowAlternatives: shared.allowAlternatives,
    maxTotalPrice: shared.maxTotalPrice,
    headless: shared.headless,
    baseUrl: shared.baseUrl,
    email: shared.email,
    password: shared.password,
    commitMode: shared.commitMode,
    candidates: shared.candidates,
    preferredCampsiteIds: [],
    excludedCampsiteIds: [],
    excludeRvSites: false,
    ...overrides,
  });
};

export const loadReservationRequestFromEnv = (): ReservationRequest => {
  const overrides: Partial<ReservationRequest> = {
    nights: parseNumber(process.env.NIGHTS, 1),
    partySize: parseNumber(process.env.PARTY_SIZE, 2),
    preferredCampsiteIds: (process.env.PREFERRED_CAMPSITE_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    excludedCampsiteIds: (process.env.EXCLUDED_CAMPSITE_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    candidates: buildCandidates(),
  };

  if (process.env.ARRIVAL_DATE) {
    overrides.arrivalDate = process.env.ARRIVAL_DATE;
  }

  if (process.env.CAMPGROUND_ID) {
    overrides.campgroundId = process.env.CAMPGROUND_ID;
  }

  if (process.env.CAMPSITE_TYPE) {
    overrides.campsiteType = process.env.CAMPSITE_TYPE;
  }

  return buildReservationRequest(overrides);
};
