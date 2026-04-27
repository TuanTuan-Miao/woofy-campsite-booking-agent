import { existsSync } from "node:fs";

import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

import {
  type AvailabilityObservation,
  type BookingReceipt,
  type CandidateSite,
  type ReservationRequest,
} from "./domain.js";
import { loginToRecreationGov } from "./recreation-login.js";
import { TelegramNotifier, type Notifier } from "./telegram-notifier.js";

export interface ReservationAdapter {
  scanAvailability(request: ReservationRequest): Promise<AvailabilityObservation[]>;
  book(request: ReservationRequest, campsiteId: string): Promise<BookingReceipt>;
}

type LiveAvailabilityCheck = {
  available: boolean;
  releaseState: AvailabilityObservation["releaseState"];
  totalPrice: number | undefined;
  notes: string[];
  siteName: string;
};

type PageReadyOptions = {
  timeoutMs?: number;
  requiredLocators?: Locator[];
};

const isoToUsDate = (value: string): string => {
  const [year, month, day] = value.split("-");
  return `${month}/${day}/${year}`;
};

const parseIsoDate = (value: string): Date => {
  const [yearString, monthString, dayString] = value.split("-");
  const year = Number(yearString);
  const month = Number(monthString);
  const day = Number(dayString);
  return new Date(Date.UTC(year, month - 1, day));
};

const formatIsoDate = (value: Date): string => {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const addDays = (value: Date, days: number): Date => {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const formatCalendarLabel = (value: Date): string =>
  value.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

const formatMonthDayYear = (value: Date): string =>
  value.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

const formatShortMonthDayYear = (value: Date): string =>
  value.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

const formatMonthYear = (value: Date): string =>
  value.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

const normalizeSiteNumber = (value: string): string => value.replace(/^0+/, "") || "0";
const normalizeText = (value: string): string => value.replace(/\s+/g, " ").trim();

const extractSiteNumber = (value: string): string | undefined => {
  const siteMatch = value.match(/\bsite\s+([a-z0-9-]+)/i);
  if (siteMatch?.[1]) {
    return siteMatch[1].toUpperCase();
  }

  const trailingMatch = value.match(/\b([0-9]{1,4}[A-Z]?)\b$/i);
  return trailingMatch?.[1]?.toUpperCase();
};

const normalizeForDetection = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim();

const humanVerificationPatterns = [
  /verify (?:that )?you(?:'re| are)? a human/,
  /verify you(?:'re| are)? not a robot/,
  /please verify you(?:'re| are)? human/,
  /human verification/,
  /security check/,
  /\bcaptcha\b/,
  /press (?:and |&)hold/,
  /check the box/,
  /unusual traffic/,
  /challenge/i,
];

export const isCampgroundSelectionSummary = (bodyText: string): boolean => {
  const normalized = normalizeForDetection(bodyText);
  return (
    /clear selection/.test(normalized) &&
    /price subtotal/.test(normalized) &&
    /\bnight stay\b/.test(normalized)
  );
};

export const isHumanVerificationStage = (url: string, bodyText: string, controls: string[]): boolean => {
  const haystacks = [
    normalizeForDetection(url),
    normalizeForDetection(bodyText),
    ...controls.map((value) => normalizeForDetection(value)),
  ];

  return haystacks.some((value) => humanVerificationPatterns.some((pattern) => pattern.test(value)));
};

export const isCartStage = (url: string, bodyText: string, _controls: string[]): boolean => {
  const normalizedUrl = normalizeForDetection(url);
  const normalizedBody = normalizeForDetection(bodyText);

  if (/your cart is empty/.test(normalizedBody)) {
    return false;
  }

  if (isCampgroundSelectionSummary(normalizedBody) && !/\/cart|\/checkout/.test(normalizedUrl)) {
    return false;
  }

  return (
    /\/cart|\/checkout\/cart/.test(normalizedUrl) ||
    /shopping cart|your reservation is in the cart|cart summary|items in your cart/.test(normalizedBody)
  );
};

export const isOrderDetailsStage = (url: string, bodyText: string, controls: string[]): boolean => {
  const normalizedUrl = normalizeForDetection(url);
  const normalizedBody = normalizeForDetection(bodyText);
  const normalizedControls = controls.map((value) => normalizeForDetection(value));

  if (isCampgroundSelectionSummary(normalizedBody) && !/\/reservations\/orderdetails/.test(normalizedUrl)) {
    return false;
  }

  return (
    /\/camping\/reservations\/orderdetails/.test(normalizedUrl) ||
    (/order details/.test(normalizedBody) &&
      (/15 minutes/.test(normalizedBody) ||
        /proceed to cart|continue to cart|continue to checkout/.test(normalizedBody))) ||
    (/reservation reference/.test(normalizedBody) &&
      normalizedControls.some((value) => /continue to cart|continue to payment/.test(value)))
  );
};

export const isPaymentStage = (url: string, bodyText: string, _controls: string[]): boolean => {
  const normalizedUrl = normalizeForDetection(url);
  const normalizedBody = normalizeForDetection(bodyText);

  if (isCampgroundSelectionSummary(normalizedBody) && !/\/checkout/.test(normalizedUrl)) {
    return false;
  }

  return (
    /\/checkout\/payment/.test(normalizedUrl) ||
    (/\/checkout/.test(normalizedUrl) &&
      /payment information|credit card|billing address|payment method|card number|security code|review order/.test(
        normalizedBody,
      )) ||
    /payment information|credit card|billing address|payment method|card number|security code/.test(normalizedBody)
  );
};

export const isCartHoldStage = (url: string, bodyText: string, controls: string[]): boolean =>
  isOrderDetailsStage(url, bodyText, controls) ||
  isCartStage(url, bodyText, controls) ||
  isPaymentStage(url, bodyText, controls);

const pickFirstVisible = async (candidates: Locator[]): Promise<Locator | null> => {
  for (const candidate of candidates) {
    const locator = candidate.first();
    try {
      if (await locator.isVisible({ timeout: 750 })) {
        return locator;
      }
    } catch {
      continue;
    }
  }

  return null;
};

const pickFirstEnabled = async (candidates: Locator[]): Promise<Locator | null> => {
  for (const candidate of candidates) {
    const locator = candidate.first();
    try {
      if ((await locator.count()) > 0 && (await locator.isVisible({ timeout: 750 })) && (await locator.isEnabled())) {
        return locator;
      }
    } catch {
      continue;
    }
  }

  return null;
};

const extractPrice = (value: string): number | undefined => {
  const match = value.match(/\$([0-9]+(?:\.[0-9]{2})?)/);
  if (!match) {
    return undefined;
  }

  return Number(match[1]);
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
      args: ["--disable-blink-features=AutomationControlled"],
    });
  }

  return chromium.launch({
    headless,
    args: ["--disable-blink-features=AutomationControlled"],
  });
};

const waitForSettledState = async (page: Page, timeout = 4000): Promise<void> => {
  await page.waitForLoadState("networkidle", { timeout }).catch(() => undefined);
};

const waitForPageReady = async (
  page: Page,
  { timeoutMs = 10000, requiredLocators = [] }: PageReadyOptions = {},
): Promise<void> => {
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => undefined);
  await page
    .waitForFunction(() => document.readyState === "complete", undefined, { timeout: timeoutMs })
    .catch(() => undefined);
  await waitForSettledState(page, Math.min(timeoutMs, 5000));
  await page
    .waitForFunction(
      () => {
        const busySelectors = [
          '[aria-busy="true"]',
          '[role="progressbar"]',
          '[data-testid*="loading"]',
          '[class*="loading"]',
          '[class*="spinner"]',
        ];

        return busySelectors.every((selector) =>
          Array.from(document.querySelectorAll(selector)).every((element) => {
            const htmlElement = element as HTMLElement;
            const style = window.getComputedStyle(htmlElement);
            const rect = htmlElement.getBoundingClientRect();
            const visible =
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              rect.width > 0 &&
              rect.height > 0;
            return !visible;
          }),
        );
      },
      undefined,
      { timeout: timeoutMs },
    )
    .catch(() => undefined);

  for (const locator of requiredLocators) {
    await locator.first().waitFor({ state: "visible", timeout: timeoutMs }).catch(() => undefined);
  }

  await page.waitForTimeout(400);
};

const waitForCartResponse = async (page: Page, delayMs = 7000): Promise<void> => {
  const previousUrl = page.url();
  await Promise.race([
    page.waitForURL((url) => url.toString() !== previousUrl, { timeout: delayMs }).catch(() => undefined),
    page
      .waitForFunction(
        () => {
          const body = (document.body?.innerText || "").toLowerCase().replace(/\s+/g, " ").trim();
          return (
            /order details|shopping cart|payment information|your cart is empty|reservation reference/.test(body) ||
            !/clear selection/.test(body)
          );
        },
        undefined,
        { timeout: delayMs },
      )
      .catch(() => undefined),
    page.waitForTimeout(delayMs),
  ]);
  await waitForPageReady(page, { timeoutMs: Math.max(delayMs, 8000) });
};

const hardenBrowserContext = async (context: BrowserContext): Promise<void> => {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    });
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });
  });
};

export class RecreationGovPlaywrightAdapter implements ReservationAdapter {
  private readonly candidateMap: Map<string, CandidateSite>;
  private verificationNotificationKey: string | null = null;

  constructor(
    private readonly browserOverride?: Browser,
    private readonly notifier: Notifier = new TelegramNotifier(),
    private readonly verificationWaitMs = Number(process.env.MANUAL_VERIFICATION_TIMEOUT_MS ?? 15 * 60 * 1000),
  ) {
    this.candidateMap = new Map();
  }

  async scanAvailability(request: ReservationRequest): Promise<AvailabilityObservation[]> {
    this.candidateMap.clear();
    request.candidates.forEach((candidate) => this.candidateMap.set(candidate.id, candidate));

    const browser = this.browserOverride ?? (await launchBrowser(request.headless));
    const context = await browser.newContext();
    await hardenBrowserContext(context);
    context.setDefaultTimeout(10000);
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(10000);

    try {
      const observations: AvailabilityObservation[] = [];
      for (const candidate of request.candidates) {
        const result = await this.inspectCandidate(page, candidate, request);
        observations.push({
          campsiteId: candidate.id,
          campsiteName: result.siteName,
          url: candidate.url,
          available: result.available,
          releaseState: result.releaseState,
          totalPrice: result.totalPrice,
          arrivalDate: request.arrivalDate,
          nights: request.nights,
          notes: result.notes,
          strictPreference: candidate.strictPreference,
          priority: candidate.priority,
        });
      }

      return observations;
    } finally {
      if (this.browserOverride) {
        await context.close();
      } else {
        await browser.close();
      }
    }
  }

  async book(request: ReservationRequest, campsiteId: string): Promise<BookingReceipt> {
    this.verificationNotificationKey = null;
    const candidate = this.candidateMap.get(campsiteId) ?? request.candidates.find((item) => item.id === campsiteId);
    const campsiteUrl = candidate?.url ?? new URL(`/camping/campsites/${campsiteId}`, request.baseUrl).toString();
    const campsiteFallbackName = candidate?.name ?? `Campsite ${campsiteId}`;

    const browser = this.browserOverride ?? (await launchBrowser(request.headless));
    const context = await browser.newContext();
    await hardenBrowserContext(context);
    context.setDefaultTimeout(10000);
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(10000);

    try {
      await loginToRecreationGov(page, request);
      console.log(`[booking] logged in for campsite ${campsiteId}`);
      const bookingCandidate = {
        id: campsiteId,
        name: campsiteFallbackName,
        url: campsiteUrl,
        priority: candidate?.priority ?? 0,
        strictPreference: candidate?.strictPreference ?? false,
      };

      let bookedFromDirectPage = false;
      try {
        bookedFromDirectPage = await this.tryBookFromDirectCampsitePage(page, request, bookingCandidate);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[booking] direct campsite flow failed for ${campsiteId}: ${message}`);
      }

      console.log(`[booking] direct campsite flow used=${bookedFromDirectPage} for campsite ${campsiteId}`);

      if (bookedFromDirectPage) {
        await this.assertCartHold(page, request, campsiteFallbackName);
        console.log(`[booking] confirmed direct campsite cart hold for ${campsiteId}`);
      } else {
        const bookedFromCampgroundPage = await this.tryBookFromCampgroundPage(page, request, bookingCandidate);
        console.log(`[booking] campground flow used=${bookedFromCampgroundPage} for campsite ${campsiteId}`);
        if (bookedFromCampgroundPage) {
          await this.assertCartHold(page, request, campsiteFallbackName);
          console.log(`[booking] confirmed campground cart hold for ${campsiteId}`);
        } else {
        await this.openCandidateAvailability(page, bookingCandidate, request);
        console.log(`[booking] opened direct campsite page for ${campsiteId}`);

        const reserveButton = await pickFirstVisible([
          page.getByRole("button", { name: /book now|reserve now|add to cart|continue/i }),
          page.getByRole("link", { name: /book now|reserve now|add to cart|continue/i }),
          page.locator('[data-testid="book-now"]'),
        ]);

        if (!reserveButton) {
          const buttonTexts = await this.readVisibleControls(page);
          throw new Error(
            [
              "Could not find a reservation action for the selected campsite.",
              `URL: ${page.url()}`,
              `Visible controls: ${buttonTexts.join(" | ")}`,
            ].join("\n"),
          );
        }

        const reserveButtonText = (await reserveButton.innerText().catch(() => "")).trim();
        await reserveButton.click();
        await waitForSettledState(page);
        await page.waitForTimeout(2000);

        if (/add to cart/i.test(reserveButtonText)) {
          await this.assertCartHold(page, request, campsiteFallbackName);
          console.log(`[booking] confirmed cart hold for ${campsiteId}`);
        }
        }
      }

      const bodyText = await page.locator("body").innerText();
      const referenceMatch =
        bodyText.match(/Reservation Reference[:\s#]+([A-Z0-9-]+)/i) ??
        bodyText.match(/Confirmation[:\s#]+([A-Z0-9-]+)/i);

      return {
        success: true,
        campsiteId,
        campsiteName: await this.readSiteName(page, campsiteFallbackName),
        commitMode: "cart",
        reservationReference: referenceMatch?.[1],
        finalUrl: page.url(),
        details: "Reservation was added to the cart hold. Complete checkout before Recreation.gov releases it.",
      };
    } finally {
      if (this.browserOverride) {
        await context.close();
      } else {
        await browser.close();
      }
    }
  }

  private async inspectCandidate(
    page: Page,
    candidate: CandidateSite,
    request: ReservationRequest,
  ): Promise<LiveAvailabilityCheck> {
    await this.openCandidateAvailability(page, candidate, request);
    const bodyText = await page.locator("body").innerText();
    const lowerText = bodyText.toLowerCase();

    const siteName = await this.readSiteName(page, candidate.name);
    const totalPrice =
      extractPrice(await page.locator("body").innerText()) ??
      extractPrice(await page.locator("main").innerText().catch(() => ""));

    if (/not yet released/.test(lowerText)) {
      return {
        available: false,
        releaseState: "not_yet_released",
        totalPrice,
        notes: ["This campsite is not yet released for the requested arrival date."],
        siteName,
      };
    }

    if (/not available|unavailable|sold out/.test(lowerText)) {
      return {
        available: false,
        releaseState: "unavailable",
        totalPrice,
        notes: ["The campsite is unavailable for the requested dates."],
        siteName,
      };
    }

    if (/\bavailable\b/.test(lowerText)) {
      return {
        available: true,
        releaseState: "available",
        totalPrice,
        notes: ["Availability text was detected on the page."],
        siteName,
      };
    }

    const bookingControl = await pickFirstVisible([
      page.getByRole("button", { name: /book now|reserve now|add to cart|continue/i }),
      page.getByRole("link", { name: /book now|reserve now|add to cart|continue/i }),
      page.locator('[data-testid="book-now"]'),
    ]);

    return {
      available: bookingControl !== null,
      releaseState: bookingControl ? "available" : "unknown",
      totalPrice,
      notes: bookingControl ? ["Booking control detected on the page."] : ["No booking control detected."],
      siteName,
    };
  }

  private async openCandidateAvailability(
    page: Page,
    candidate: CandidateSite,
    request: ReservationRequest,
  ): Promise<void> {
    await page.goto(candidate.url, { waitUntil: "domcontentloaded" });
    await waitForPageReady(page);

    const siteAvailabilityTab = await pickFirstVisible([
      page.getByRole("button", { name: /site availability/i }),
      page.locator('[href="#site-availability"]'),
    ]);
    if (siteAvailabilityTab) {
      await siteAvailabilityTab.click().catch(() => undefined);
      await page.waitForTimeout(1000);
    }

    const arrivalInput = await pickFirstVisible([
      page.getByLabel(/arrival|start date|check-?in/i),
      page.getByPlaceholder(/mm\/dd\/yyyy/i),
      page.locator('input[name*="arrival" i]'),
      page.locator('input[name*="date" i]').first(),
      page.locator('[data-testid="arrival-date"]'),
    ]);

    const nightsInput = await pickFirstVisible([
      page.getByLabel(/night/i),
      page.locator('input[name*="night" i]'),
      page.locator('[data-testid="nights"]'),
    ]);

    if (arrivalInput && nightsInput) {
      await arrivalInput.fill(isoToUsDate(request.arrivalDate));
      await nightsInput.fill(String(request.nights));
      const search = await pickFirstVisible([
        page.getByRole("button", { name: /check availability|search availability|search|apply dates/i }),
        page.getByRole("link", { name: /check availability|search availability|search|apply dates/i }),
        page.locator('[data-testid="check-availability"]'),
      ]);

      if (search) {
        await search.click();
        await waitForPageReady(page);
      }
      return;
    }

    const enterDatesButton = await pickFirstVisible([
      page.getByRole("button", { name: /enter dates/i }),
      page.getByRole("button", { name: /clear dates/i }),
    ]);
    if (enterDatesButton && /enter dates/i.test((await enterDatesButton.innerText().catch(() => "")).trim())) {
      await enterDatesButton.click().catch(() => undefined);
      await page.waitForTimeout(1000);
    }

    const arrivalDate = parseIsoDate(request.arrivalDate);
    const checkoutDate = addDays(arrivalDate, request.nights);
    const arrivalButton = await pickFirstVisible([
      page.getByRole("button", {
        name: new RegExp(`^${formatCalendarLabel(arrivalDate)}(?: - .+)?$`, "i"),
      }),
    ]);
    const checkoutButton = await pickFirstVisible([
      page.getByRole("button", {
        name: new RegExp(`^${formatCalendarLabel(checkoutDate)}(?: - .+)?$`, "i"),
      }),
    ]);

    if (arrivalButton && checkoutButton) {
      await arrivalButton.click().catch(() => undefined);
      await page.waitForTimeout(500);
      await checkoutButton.click().catch(() => undefined);
      await waitForPageReady(page);
    }
  }

  private async readSiteName(page: Page, fallback: string): Promise<string> {
    const headline = await pickFirstVisible([
      page.locator("h1"),
      page.locator('[data-testid="campsite-name"]'),
    ]);

    if (!headline) {
      return fallback;
    }

    const text = (await headline.innerText()).trim();
    return text || fallback;
  }

  private async assertCartHold(
    page: Page,
    request: ReservationRequest,
    campsiteName: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await waitForCartResponse(page);
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const controls = await this.readVisibleControls(page);

      if (await this.handleHumanVerificationIfPresent(page, request, campsiteName, bodyText, controls)) {
        continue;
      }

      if (/your cart is empty/i.test(bodyText)) {
        throw new Error(
          [
            "The site dates were selected, but Recreation.gov reported an empty cart after Add to Cart.",
            `URL: ${page.url()}`,
          ].join("\n"),
        );
      }

      if (isCartHoldStage(page.url(), bodyText, controls)) {
        return;
      }

      await this.followCartLink(page);

      const fallbackBody = await page.locator("body").innerText().catch(() => "");
      const fallbackControls = await this.readVisibleControls(page);

      if (await this.handleHumanVerificationIfPresent(page, request, campsiteName, fallbackBody, fallbackControls)) {
        continue;
      }

      if (/your cart is empty/i.test(fallbackBody)) {
        throw new Error(
          [
            "The site dates were selected, but Recreation.gov reported an empty cart after Add to Cart.",
            `URL: ${page.url()}`,
          ].join("\n"),
        );
      }

      if (isCartHoldStage(page.url(), fallbackBody, fallbackControls)) {
        return;
      }

      throw new Error(
        [
          "The site dates were selected, but Recreation.gov did not expose an order-details, cart, or payment hold page.",
          `URL: ${page.url()}`,
          `Visible controls: ${fallbackControls.join(" | ")}`,
        ].join("\n"),
      );
    }

    throw new Error(
      [
        "The site dates were selected, but Recreation.gov never exposed a cart hold after the verification wait.",
        `URL: ${page.url()}`,
      ].join("\n"),
    );
  }

  private async handleHumanVerificationIfPresent(
    page: Page,
    request: ReservationRequest,
    campsiteName: string,
    bodyText: string,
    controls: string[],
  ): Promise<boolean> {
    if (!isHumanVerificationStage(page.url(), bodyText, controls)) {
      return false;
    }

    const notificationKey = `${request.arrivalDate}:${request.nights}:${page.url()}`;
    if (this.verificationNotificationKey !== notificationKey) {
      this.verificationNotificationKey = notificationKey;
      await this.safeNotify(
        [
          `Woofy needs manual human verification for ${campsiteName}.`,
          `Arrival: ${request.arrivalDate}`,
          `Nights: ${request.nights}`,
          "Please complete the verification in the open browser window.",
          `Current page: ${page.url()}`,
          `Woofy will wait up to ${Math.max(1, Math.round(this.verificationWaitMs / 60000))} minute(s) and continue automatically.`,
        ].join("\n"),
      );
    }

    const resolved = await this.waitForHumanVerificationToClear(page);
    if (!resolved) {
      throw new Error(
        [
          "Human verification is still blocking the booking flow after waiting for manual completion.",
          `URL: ${page.url()}`,
        ].join("\n"),
      );
    }

    await waitForCartResponse(page, 5000);
    return true;
  }

  private async waitForHumanVerificationToClear(page: Page): Promise<boolean> {
    const deadline = Date.now() + this.verificationWaitMs;

    while (Date.now() < deadline) {
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const controls = await this.readVisibleControls(page);
      if (!isHumanVerificationStage(page.url(), bodyText, controls)) {
        return true;
      }

      await page.waitForTimeout(1500);
      await waitForPageReady(page, { timeoutMs: 4000 });
    }

    return false;
  }

  private async safeNotify(text: string): Promise<void> {
    try {
      await this.notifier.sendMessage(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Notifier error: ${message}`);
    }
  }

  private async clickAddToCartFlow(page: Page): Promise<void> {
    const cartButtons = [
      page.getByRole("button", { name: /^add to cart$/i }),
      page.locator("button").filter({ hasText: /^Add to Cart$/i }),
      page.getByRole("button", { name: /^reserve$/i }),
      page.getByRole("button", { name: /^book now$/i }),
    ];

    let addToCartButton: Locator | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      addToCartButton = await pickFirstEnabled(cartButtons);
      if (addToCartButton) {
        break;
      }

      await page.waitForTimeout(200);
    }

    if (!addToCartButton) {
      const buttonTexts = await this.readVisibleControls(page);
      throw new Error(
        [
          "Add to Cart / Reserve did not become enabled after selecting the campsite dates.",
          `URL: ${page.url()}`,
          `Visible controls: ${buttonTexts.join(" | ")}`,
        ].join("\n"),
      );
    }

    await addToCartButton.click();
    await waitForCartResponse(page);

    const preCartAction = await pickFirstEnabled([
      page.getByRole("button", { name: /continue|confirm/i }),
      page.getByRole("link", { name: /continue|confirm/i }),
    ]);
    if (preCartAction) {
      await preCartAction.click().catch(() => undefined);
      await waitForCartResponse(page);
    }

    const closeModal = await pickFirstVisible([
      page.getByRole("button", { name: /close the modal/i }),
    ]);
    if (closeModal) {
      const addToCartButtons = page.getByRole("button", { name: /^add to cart$/i });
      const buttonCount = await addToCartButtons.count();
      if (buttonCount > 1) {
        const modalAddToCart = addToCartButtons.nth(buttonCount - 1);
        if (await modalAddToCart.isEnabled().catch(() => false)) {
          await modalAddToCart.click().catch(() => undefined);
          await waitForCartResponse(page);
        }
      }
    }
  }

  private async followCartLink(page: Page): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const cartAction = await pickFirstEnabled([
        page.getByRole("link", { name: /view cart|proceed to checkout|continue to cart|checkout/i }),
        page.getByRole("button", { name: /view cart|proceed to checkout|continue to cart|checkout/i }),
        page.getByRole("link", { name: /^cart$/i }),
        page.getByRole("button", { name: /^cart$/i }),
        page.locator('a[href*="/checkout"]'),
        page.locator('a[href*="/cart"]'),
        page.locator('button[aria-label*="cart" i]'),
      ]);

      if (cartAction) {
        await cartAction.click().catch(() => undefined);
        await waitForSettledState(page);
        await page.waitForTimeout(1500);
        return;
      }

      await page.waitForTimeout(250);
    }
  }

  private async readVisibleControls(page: Page): Promise<string[]> {
    return (
      await page.locator("button, a").evaluateAll((elements) =>
        elements
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            text: (element.textContent || "").trim(),
            ariaLabel: element.getAttribute("aria-label"),
          }))
          .filter((element) => element.text || element.ariaLabel)
          .slice(0, 40),
      )
    ).map((element) => `${element.tag}:${element.text || element.ariaLabel}`);
  }

  private async tryBookFromCampgroundPage(
    page: Page,
    request: ReservationRequest,
    candidate: CandidateSite,
  ): Promise<boolean> {
    if (!request.campgroundId || !/recreation\.gov/i.test(request.baseUrl)) {
      return false;
    }

    const siteNumber = extractSiteNumber(candidate.name);
    if (!siteNumber) {
      return false;
    }

    const campgroundUrl = new URL(`/camping/campgrounds/${request.campgroundId}`, request.baseUrl).toString();
    await page.goto(campgroundUrl, { waitUntil: "domcontentloaded" });
    await waitForPageReady(page, {
      requiredLocators: [
        page.getByRole("button", { name: /campsite list/i }),
        page.getByRole("button", { name: /calendar|clear dates/i }),
      ],
    });
    console.log(`[booking] opened campground page ${campgroundUrl}`);

    await this.setCampgroundDateRange(page, request);
    console.log(`[booking] set campground date range for site ${siteNumber}`);
    await this.filterCampgroundSiteList(page, siteNumber);
    console.log(`[booking] filtered campground list to site ${siteNumber}`);
    await this.selectCampgroundGridDates(page, siteNumber, request);
    console.log(`[booking] selected campground grid dates for site ${siteNumber}`);

    const addToCart = await pickFirstVisible([
      page.getByRole("button", { name: /^add to cart$/i }),
      page.locator("button").filter({ hasText: /^Add to Cart$/i }),
      page.getByRole("button", { name: /reserve/i }),
    ]);

    if (!addToCart) {
      const buttonTexts = await this.readVisibleControls(page);
      throw new Error(
        [
          `Could not find the campground Add to Cart action for site ${siteNumber}.`,
          `URL: ${page.url()}`,
          `Visible controls: ${buttonTexts.join(" | ")}`,
        ].join("\n"),
      );
    }

    await this.clickAddToCartFlow(page);
    console.log(`[booking] clicked add to cart for site ${siteNumber}`);
    return true;
  }

  private async tryBookFromDirectCampsitePage(
    page: Page,
    request: ReservationRequest,
    candidate: CandidateSite,
  ): Promise<boolean> {
    if (!/recreation\.gov/i.test(request.baseUrl)) {
      return false;
    }

    await page.goto(candidate.url, { waitUntil: "domcontentloaded" });
    await waitForSettledState(page);
    await page.waitForTimeout(1500);
    console.log(`[booking] opened direct campsite page ${candidate.url}`);

    await this.ensureDirectSiteCalendarVisible(page);

    const arrivalDate = parseIsoDate(request.arrivalDate);
    const checkoutDate = addDays(arrivalDate, request.nights);
    await this.clickDirectSiteStartAndEnd(page, arrivalDate, checkoutDate);
    console.log(`[booking] selected direct campsite calendar for ${candidate.id}`);

    await this.clickAddToCartFlow(page);
    console.log(`[booking] clicked add to cart on direct campsite page for ${candidate.id}`);
    return true;
  }

  private async ensureDirectSiteCalendarVisible(page: Page): Promise<void> {
    const calendarGrid = page.locator("div.calendar-table").first();
    if (await calendarGrid.isVisible().catch(() => false)) {
      return;
    }

    const expandCalendar = await pickFirstVisible([
      page.getByRole("button", { name: /check availability|view availability|availability/i }),
      page.locator('[data-testid="check-availability"]'),
    ]);
    if (expandCalendar) {
      await expandCalendar.click().catch(() => undefined);
    }

    await page.locator("div.calendar-table").first().waitFor({ state: "visible", timeout: 8000 });
  }

  private async clickDirectSiteStartAndEnd(page: Page, arrivalDate: Date, checkoutDate: Date): Promise<void> {
    const startCell = await this.findDirectSiteDayCell(page, arrivalDate, "start");
    if (!startCell) {
      throw new Error(`Start date ${formatIsoDate(arrivalDate)} was not visible on the direct campsite calendar.`);
    }

    await startCell.scrollIntoViewIfNeeded().catch(() => undefined);
    await startCell.click({ timeout: 2500, force: true }).catch(() => undefined);

    const endCell = await this.findDirectSiteDayCell(page, checkoutDate, "end");
    if (!endCell) {
      throw new Error(`Checkout date ${formatIsoDate(checkoutDate)} was not visible on the direct campsite calendar.`);
    }

    await endCell.scrollIntoViewIfNeeded().catch(() => undefined);
    await endCell.click({ timeout: 2500, force: true }).catch(() => undefined);
  }

  private async findDirectSiteDayCell(
    page: Page,
    targetDate: Date,
    role: "start" | "end",
  ): Promise<Locator | null> {
    const targetDay = targetDate.getUTCDate();
    const monthLabel = formatMonthYear(targetDate);
    const dateLabel = formatMonthDayYear(targetDate);
    const dayPattern = new RegExp(`^${targetDay}$`);

    const monthGridByAria = page.locator(`div.calendar-table[aria-label*="${monthLabel}"]`).first();
    const monthGrid =
      (await monthGridByAria.count()) > 0
        ? monthGridByAria
        : page.locator("div.calendar-table").filter({ hasText: monthLabel }).first();

    if ((await monthGrid.count()) > 0) {
      const base = monthGrid.locator(
        'div.calendar-cell-td > div.calendar-cell[role="button"]:not([aria-disabled="true"])',
      );
      const dayWithAvailabilitySymbol = base
        .filter({ has: monthGrid.locator("span.date", { hasText: dayPattern }) })
        .filter({ has: monthGrid.locator("span.symbol", { hasText: /^A$/ }) });

      const preferredWithSymbol = dayWithAvailabilitySymbol.filter({
        has: monthGrid.locator(role === "start" ? ".available" : ".checkout"),
      });
      if ((await preferredWithSymbol.count()) > 0) {
        return preferredWithSymbol.first();
      }
      if ((await dayWithAvailabilitySymbol.count()) > 0) {
        return dayWithAvailabilitySymbol.first();
      }

      const dayAny = base.filter({ has: monthGrid.locator("span.date", { hasText: dayPattern }) });
      const preferredAny = dayAny.filter({
        has: monthGrid.locator(role === "start" ? ".available" : ".checkout"),
      });
      if ((await preferredAny.count()) > 0) {
        return preferredAny.first();
      }
      if ((await dayAny.count()) > 0) {
        return dayAny.first();
      }
    }

    const fallback = page
      .locator(
        `div.calendar-cell-td > div.calendar-cell[role="button"][aria-label*="${dateLabel}"]:not([aria-disabled="true"])`,
      )
      .first();
    return (await fallback.count()) > 0 ? fallback : null;
  }

  private async filterCampgroundSiteList(page: Page, siteNumber: string): Promise<void> {
    const searchInput = await pickFirstVisible([
      page.getByPlaceholder(/search site number|search site/i),
      page.locator('input[aria-label*="Search Site" i]'),
      page.locator('input[placeholder*="Site" i]'),
    ]);

    if (!searchInput) {
      return;
    }

    await searchInput.fill(siteNumber);
    await waitForPageReady(page, { timeoutMs: 4000 });
  }

  private async setCampgroundDateRange(page: Page, request: ReservationRequest): Promise<void> {
    const arrivalDate = parseIsoDate(request.arrivalDate);
    const checkoutDate = addDays(arrivalDate, request.nights);
    const calendarButton = await pickFirstVisible([
      page.getByRole("button", { name: /calendar/i }),
      page.locator(".toggle-calendar-button"),
    ]);

    if (!calendarButton) {
      return;
    }

    await calendarButton.click().catch(() => undefined);
    await waitForPageReady(page, { timeoutMs: 5000 });
    await this.navigateCampgroundDatePicker(page, arrivalDate);

    const arrivalControl = await pickFirstVisible([
      page.getByRole("button", {
        name: new RegExp(formatCalendarLabel(arrivalDate), "i"),
      }),
      page.locator(`[aria-label="${formatCalendarLabel(arrivalDate)}"]`),
    ]);
    const checkoutControl = await pickFirstVisible([
      page.getByRole("button", {
        name: new RegExp(formatCalendarLabel(checkoutDate), "i"),
      }),
      page.locator(`[aria-label="${formatCalendarLabel(checkoutDate)}"]`),
    ]);

    if (!arrivalControl || !checkoutControl) {
      throw new Error(
        `Could not find campground date picker controls for ${formatMonthDayYear(arrivalDate)} -> ${formatMonthDayYear(checkoutDate)}.`,
      );
    }

    await arrivalControl.click().catch(() => undefined);
    await page.waitForTimeout(300);
    await checkoutControl.click().catch(() => undefined);
    await waitForPageReady(page, {
      timeoutMs: 8000,
      requiredLocators: [page.getByRole("button", { name: /clear dates/i })],
    });
  }

  private async navigateCampgroundDatePicker(page: Page, targetDate: Date): Promise<void> {
    const targetLabel = formatCalendarLabel(targetDate);

    for (let attempt = 0; attempt < 18; attempt += 1) {
      const targetControl = await pickFirstVisible([
        page.getByRole("button", { name: new RegExp(targetLabel, "i") }),
        page.locator(`[aria-label="${targetLabel}"]`),
      ]);

      if (targetControl) {
        return;
      }

      const nextButton = await pickFirstVisible([
        page.getByRole("button", { name: /^next$/i }),
        page.locator(".next-prev-button").last(),
      ]);

      if (!nextButton) {
        break;
      }

      await nextButton.click().catch(() => undefined);
      await waitForPageReady(page, { timeoutMs: 4000 });
    }
  }

  private async selectCampgroundGridDates(
    page: Page,
    siteNumber: string,
    request: ReservationRequest,
  ): Promise<void> {
    const arrivalDate = parseIsoDate(request.arrivalDate);
    const checkoutDate = addDays(arrivalDate, request.nights);
    await this.advanceCampgroundGridToDate(page, arrivalDate);

    const addToCartButton = page.getByRole("button", { name: /^add to cart$/i }).first();
    const clickSiteAvailability = async (targetDate: Date): Promise<void> => {
      const shortDate = formatShortMonthDayYear(targetDate);
      const targetButton = await pickFirstVisible([
        page.getByRole("button", {
          name: new RegExp(`${shortDate}\\s+-\\s+Site\\s+${siteNumber}\\s+is\\s+available`, "i"),
        }),
        page.locator(`button[aria-label="${shortDate} - Site ${siteNumber} is available"]`),
      ]);

      if (!targetButton) {
        throw new Error(`The campground grid did not expose an available control for Site ${siteNumber} on ${shortDate}.`);
      }

      await targetButton.scrollIntoViewIfNeeded().catch(() => undefined);
      await targetButton.click({ force: true }).catch(() => undefined);
    };

    await clickSiteAvailability(arrivalDate);
    await page.waitForFunction(
      ({ nights, normalizedSiteNumber }) => {
        const body = (document.body?.innerText || "").toLowerCase().replace(/\s+/g, " ").trim();
        const addToCartEnabled = Array.from(document.querySelectorAll("button")).some((button) => {
          const element = button as HTMLButtonElement;
          return /add to cart/i.test(element.innerText || "") && !element.disabled;
        });
        return (
          addToCartEnabled ||
          (body.includes(`${nights} night stay`) &&
            (body.includes(`site ${normalizedSiteNumber}`) || body.includes(`site ${Number(normalizedSiteNumber)}`)))
        );
      },
      { nights: request.nights, normalizedSiteNumber: siteNumber },
      { timeout: 8000 },
    ).catch(() => undefined);
    await waitForPageReady(page, { timeoutMs: 5000 });

    const addToCartEnabled = await addToCartButton.isEnabled().catch(() => false);
    if (!addToCartEnabled) {
      const shortCheckoutDate = formatShortMonthDayYear(checkoutDate);
      const checkoutControl = await pickFirstVisible([
        page.getByRole("button", {
          name: new RegExp(`${shortCheckoutDate}\\s+-\\s+Site\\s+${siteNumber}\\s+-\\s+Selection end date`, "i"),
        }),
        page.getByRole("button", {
          name: new RegExp(`${shortCheckoutDate}\\s+-\\s+Site\\s+${siteNumber}\\s+is\\s+available`, "i"),
        }),
      ]);

      if (!checkoutControl) {
        throw new Error(`The campground grid did not expose an available control for Site ${siteNumber} on ${shortCheckoutDate}.`);
      }

      await checkoutControl.scrollIntoViewIfNeeded().catch(() => undefined);
      await checkoutControl.click({ force: true }).catch(() => undefined);
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll("button")).some((button) => {
            const element = button as HTMLButtonElement;
            return /add to cart/i.test(element.innerText || "") && !element.disabled;
          }),
        undefined,
        { timeout: 8000 },
      ).catch(() => undefined);
    }

    await waitForPageReady(page, {
      timeoutMs: 5000,
      requiredLocators: [page.getByRole("button", { name: /^add to cart$/i }).first()],
    });
  }

  private async advanceCampgroundGridToDate(page: Page, targetDate: Date): Promise<void> {
    const targetDay = String(targetDate.getUTCDate());

    for (let attempt = 0; attempt < 80; attempt += 1) {
      const headers = (
        await page.locator("thead th, [role='columnheader']").evaluateAll((elements) =>
          elements.map((element) => (element.textContent || "").replace(/\s+/g, " ").trim()),
        )
      ).filter(Boolean);

      if (headers.some((header) => header.endsWith(targetDay) || header.includes(` ${targetDay}`))) {
        return;
      }

      const nextFiveDays = await pickFirstVisible([
        page.getByRole("button", { name: /next 5 days/i }),
        page.locator("button").filter({ hasText: /next 5 days/i }),
      ]);
      if (!nextFiveDays) {
        break;
      }

      await nextFiveDays.click().catch(() => undefined);
      await waitForPageReady(page, { timeoutMs: 4000 });
    }
  }
}
