import { existsSync } from "node:fs";

import { chromium, type Browser } from "playwright";

import type { ReservationRequest } from "./domain.js";
import type { PendingBookingState } from "./booking-state.js";
import { loginToRecreationGov } from "./recreation-login.js";
import { isCartHoldStage } from "./recreation-adapter.js";

export type PendingBookingStatus = {
  active: boolean;
  finalUrl: string | null;
  details: string;
};

const resolveChromeExecutablePath = (): string | undefined => {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    `${process.env.HOME ?? ""}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  ];

  return candidates.find((candidate) => candidate && existsSync(candidate));
};

const launchBrowser = async (headless: boolean): Promise<Browser> => {
  const executablePath = resolveChromeExecutablePath();
  if (executablePath) {
    return chromium.launch({
      executablePath,
      headless,
    });
  }

  return chromium.launch({ headless });
};

export const checkPendingBookingStatus = async (
  request: ReservationRequest,
  pending: PendingBookingState,
): Promise<PendingBookingStatus> => {
  const finalUrl = pending.receipt.finalUrl;
  if (!finalUrl) {
    return {
      active: false,
      finalUrl: null,
      details: "No payment-page URL was saved for this pending booking.",
    };
  }

  const browser = await launchBrowser(request.headless);
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await loginToRecreationGov(page, request);
    await page.goto(finalUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => undefined);

    const bodyText = await page.locator("body").innerText().catch(() => "");
    const currentUrl = page.url();
    const controls = await page
      .locator("button, a")
      .evaluateAll((elements) =>
        elements
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            text: (element.textContent || "").trim(),
            ariaLabel: element.getAttribute("aria-label"),
          }))
          .filter((element) => element.text || element.ariaLabel)
          .slice(0, 40),
      )
      .then((entries) => entries.map((entry) => `${entry.tag}:${entry.text || entry.ariaLabel}`))
      .catch(() => []);

    const stillActive = isCartHoldStage(currentUrl, bodyText, controls);

    if (stillActive) {
      const normalizedBody = bodyText.toLowerCase();
      const details = /order details|15 minutes/.test(normalizedBody)
        ? "Pending booking is still active in Recreation.gov order details."
        : /payment|credit card|billing/.test(normalizedBody) || /payment/.test(currentUrl)
          ? "Pending booking is still active at the payment step."
          : "Pending booking is still active in the cart hold.";
      return {
        active: true,
        finalUrl: currentUrl,
        details,
      };
    }

    return {
      active: false,
      finalUrl: currentUrl,
      details: "Pending booking no longer appears to be active in Recreation.gov cart/order details.",
    };
  } finally {
    await browser.close();
  }
};
