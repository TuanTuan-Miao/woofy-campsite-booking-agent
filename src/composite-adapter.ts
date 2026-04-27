import {
  type AvailabilityObservation,
  type BookingReceipt,
  type ReservationRequest,
} from "./domain.js";
import { RecreationGovApiScout } from "./recreation-api.js";
import { RecreationGovPlaywrightAdapter, type ReservationAdapter } from "./recreation-adapter.js";

export class CompositeReservationAdapter implements ReservationAdapter {
  constructor(
    private readonly scout = new RecreationGovApiScout(),
    private readonly booker: ReservationAdapter = new RecreationGovPlaywrightAdapter(),
  ) {}

  async scanAvailability(request: ReservationRequest): Promise<AvailabilityObservation[]> {
    if (request.campgroundId) {
      const observations = await this.scout.scanAvailability(request);
      request.candidates = observations.map((observation) => ({
        id: observation.campsiteId,
        name: observation.campsiteName,
        url: observation.url,
        priority: observation.priority,
        strictPreference: observation.strictPreference,
      }));
      return observations;
    }

    return this.booker.scanAvailability(request);
  }

  async book(request: ReservationRequest, campsiteId: string): Promise<BookingReceipt> {
    return this.booker.book(request, campsiteId);
  }
}
