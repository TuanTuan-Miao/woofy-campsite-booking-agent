import {
  type AvailabilityObservation,
  type ReservationRequest,
} from "./domain.js";

type RecreationAvailabilityResponse = {
  campsites: Record<
    string,
    {
      availabilities: Record<string, string>;
      campsite_id: string;
      campsite_type?: string;
      site?: string;
      loop?: string;
    }
  >;
};

type RecreationCampgroundResponse = {
  campground?: {
    facility_name?: string;
  };
};

type FetchLike = typeof fetch;

const requestDateFormat = (value: Date): string => {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}T00:00:00.000Z`;
};

const responseDateFormat = (value: Date): string => {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}T00:00:00Z`;
};

const addDays = (value: Date, days: number): Date => {
  const copy = new Date(value);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
};

const parseIsoDate = (value: string): Date => {
  return new Date(`${value}T00:00:00.000Z`);
};

const getRequiredStayDates = (arrivalDate: string, nights: number): string[] => {
  const dates: string[] = [];
  const start = parseIsoDate(arrivalDate);
  for (let offset = 0; offset < nights; offset += 1) {
    dates.push(responseDateFormat(addDays(start, offset)));
  }
  return dates;
};

const getMonthStarts = (arrivalDate: string, nights: number): string[] => {
  const start = parseIsoDate(arrivalDate);
  const lastNight = addDays(start, nights - 1);
  const monthStarts: string[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const end = new Date(Date.UTC(lastNight.getUTCFullYear(), lastNight.getUTCMonth(), 1));

  while (cursor <= end) {
    monthStarts.push(requestDateFormat(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return monthStarts;
};

const buildCampsiteName = (siteNumber: string | undefined, campsiteId: string): string => {
  if (siteNumber) {
    return `Site ${siteNumber}`;
  }

  return `Campsite ${campsiteId}`;
};

const buildCampsiteUrl = (baseUrl: string, campsiteId: string): string => {
  return new URL(`/camping/campsites/${campsiteId}`, baseUrl).toString();
};

const isRvSite = (campsiteType: string | undefined): boolean => {
  if (!campsiteType) {
    return false;
  }

  return /\brv\b|recreational vehicle/i.test(campsiteType);
};

export class RecreationGovApiScout {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async scanAvailability(request: ReservationRequest): Promise<AvailabilityObservation[]> {
    if (!request.campgroundId) {
      return [];
    }

    const stayDates = getRequiredStayDates(request.arrivalDate, request.nights);
    const monthStarts = getMonthStarts(request.arrivalDate, request.nights);
    const months = await Promise.all(
      monthStarts.map((startDate) => this.fetchMonthAvailability(request.baseUrl, request.campgroundId!, startDate)),
    );

    const campgroundName = await this.fetchCampgroundName(request.baseUrl, request.campgroundId);
    const mergedCampsites = new Map<
      string,
      RecreationAvailabilityResponse["campsites"][string]
    >();

    for (const month of months) {
      for (const [campsiteId, campsite] of Object.entries(month.campsites)) {
        const existing = mergedCampsites.get(campsiteId);
        if (!existing) {
          mergedCampsites.set(campsiteId, {
            ...campsite,
            availabilities: { ...campsite.availabilities },
          });
          continue;
        }

        mergedCampsites.set(campsiteId, {
          ...existing,
          ...campsite,
          availabilities: {
            ...existing.availabilities,
            ...campsite.availabilities,
          },
        });
      }
    }

    const preferredSet = new Set(request.preferredCampsiteIds);
    const excludedSet = new Set(request.excludedCampsiteIds);

    const observations = Array.from(mergedCampsites.entries())
      .filter(([campsiteId]) => !excludedSet.has(campsiteId))
      .filter(([, campsite]) => {
        if (!request.campsiteType) {
          return !request.excludeRvSites || !isRvSite(campsite.campsite_type);
        }

        return campsite.campsite_type === request.campsiteType && (!request.excludeRvSites || !isRvSite(campsite.campsite_type));
      })
      .map(([campsiteId, campsite]) => {
        const allAvailable = stayDates.every(
          (date) => campsite.availabilities[date] === "Available",
        );
        const anyNotYetReleased = stayDates.some((date) => {
          const state = campsite.availabilities[date];
          return typeof state === "string" && /not reservable/i.test(state);
        });

        const preferredIndex = request.preferredCampsiteIds.indexOf(campsiteId);
        const strictPreference = preferredSet.has(campsiteId);
        const priority = strictPreference ? preferredIndex : request.preferredCampsiteIds.length + Number(campsite.site ?? Number.MAX_SAFE_INTEGER);

        return {
          campsiteId,
          campsiteName: campgroundName
            ? `${campgroundName} ${buildCampsiteName(campsite.site, campsiteId)}`
            : buildCampsiteName(campsite.site, campsiteId),
          url: buildCampsiteUrl(request.baseUrl, campsiteId),
          available: allAvailable,
          releaseState: allAvailable
            ? "available"
            : anyNotYetReleased
              ? "not_yet_released"
              : "unavailable",
          arrivalDate: request.arrivalDate,
          nights: request.nights,
          notes: allAvailable
            ? [`API shows ${request.nights} consecutive available night(s) starting ${request.arrivalDate}.`]
            : [`API did not show ${request.nights} consecutive available night(s) starting ${request.arrivalDate}.`],
          strictPreference,
          priority: Number.isFinite(priority) ? priority : request.preferredCampsiteIds.length + 100000,
        } satisfies AvailabilityObservation;
      })
      .sort((left, right) => left.priority - right.priority || Number(left.campsiteId) - Number(right.campsiteId));

    return observations;
  }

  private async fetchMonthAvailability(
    baseUrl: string,
    campgroundId: string,
    startDate: string,
  ): Promise<RecreationAvailabilityResponse> {
    const url = new URL(`/api/camps/availability/campground/${campgroundId}/month`, baseUrl);
    url.searchParams.set("start_date", startDate);

    const response = await this.fetchImpl(url, {
      headers: {
        "User-Agent": "woofy-camp-scout/0.1",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed campground availability request: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as RecreationAvailabilityResponse;
  }

  private async fetchCampgroundName(baseUrl: string, campgroundId: string): Promise<string | undefined> {
    const url = new URL(`/api/camps/campgrounds/${campgroundId}`, baseUrl);
    const response = await this.fetchImpl(url, {
      headers: {
        "User-Agent": "woofy-camp-scout/0.1",
      },
    });

    if (!response.ok) {
      return undefined;
    }

    const payload = (await response.json()) as RecreationCampgroundResponse;
    return payload.campground?.facility_name;
  }
}
