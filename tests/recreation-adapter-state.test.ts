import { describe, expect, it } from "vitest";

import {
  isCartHoldStage,
  isCampgroundSelectionSummary,
  isCartStage,
  isHumanVerificationStage,
  isOrderDetailsStage,
  isPaymentStage,
} from "../src/recreation-adapter.js";

describe("recreation adapter booking stage detection", () => {
  it("does not treat the campground selection summary as a cart state", () => {
    const bodyText = `
      Site 002, Loop AREA FALLEN LEAF CAMPGROUND
      1 Night Stay 8/25/26 - 8/26/26
      Price Subtotal $55.00
      Clear selection
      Add to Cart
    `;

    expect(isCampgroundSelectionSummary(bodyText)).toBe(true);
    expect(
      isCartStage(
        "https://www.recreation.gov/camping/campgrounds/232769",
        bodyText,
        ["button:Add to Cart"],
      ),
    ).toBe(false);
    expect(
      isPaymentStage(
        "https://www.recreation.gov/camping/campgrounds/232769",
        bodyText,
        ["button:Add to Cart"],
      ),
    ).toBe(false);
  });

  it("recognizes a real cart state", () => {
    expect(
      isCartStage(
        "https://www.recreation.gov/cart",
        "Shopping Cart Your reservation is in the cart.",
        ["button:Proceed to Checkout"],
      ),
    ).toBe(true);
  });

  it("recognizes an order-details hold state", () => {
    const bodyText = `
      Order Details
      You have 15 minutes to complete the order details for this reservation.
      Proceed to Cart
    `;

    expect(
      isOrderDetailsStage(
        "https://www.recreation.gov/camping/reservations/orderdetails?id=abc123",
        bodyText,
        ["button:Proceed to Cart"],
      ),
    ).toBe(true);
    expect(
      isCartHoldStage(
        "https://www.recreation.gov/camping/reservations/orderdetails?id=abc123",
        bodyText,
        ["button:Proceed to Cart"],
      ),
    ).toBe(true);
  });

  it("recognizes a real payment state", () => {
    expect(
      isPaymentStage(
        "https://www.recreation.gov/checkout/payment",
        "Payment Information Enter payment to complete the booking.",
        ["button:Submit Payment"],
      ),
    ).toBe(true);
    expect(
      isCartHoldStage(
        "https://www.recreation.gov/checkout/payment",
        "Payment Information Enter payment to complete the booking.",
        ["button:Submit Payment"],
      ),
    ).toBe(true);
  });

  it("recognizes a human verification challenge state", () => {
    const bodyText = `
      Please verify you are a human to continue.
      Complete the security check before proceeding.
    `;

    expect(
      isHumanVerificationStage(
        "https://www.recreation.gov/camping/campsites/64273",
        bodyText,
        ["button:Verify you are human", "button:Continue"],
      ),
    ).toBe(true);
  });
});
