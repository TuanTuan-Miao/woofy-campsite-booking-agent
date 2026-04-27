import { existsSync } from "node:fs";

import { chromium } from "playwright";

import { loadDotEnvIntoProcess } from "../src/env-file.js";
import { loginToRecreationGov } from "../src/recreation-login.js";

const resolveChromeExecutablePath = (): string | undefined => {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    `${process.env.HOME ?? ""}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  ];

  return candidates.find((candidate) => candidate && existsSync(candidate));
};

const formatCalendarLabel = (value: Date): string =>
  value.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

const addDays = (value: Date, days: number): Date => {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const main = async (): Promise<void> => {
  loadDotEnvIntoProcess();

  const campsiteId = process.argv[2] ?? "10300310";
  const arrivalDate = process.argv[3] ?? "05/13/2026";
  const nights = process.argv[4] ?? "2";
  const [month, day, year] = arrivalDate.split("/").map((piece) => Number(piece));
  const arrival = new Date(Date.UTC(year, month - 1, day));
  const checkout = addDays(arrival, Number(nights));
  const baseUrl = process.env.RECREATION_BASE_URL ?? "https://www.recreation.gov";

  if (!process.env.RECREATION_EMAIL || !process.env.RECREATION_PASSWORD) {
    throw new Error("RECREATION_EMAIL and RECREATION_PASSWORD are required.");
  }

  const executablePath = resolveChromeExecutablePath();
  const browser = await chromium.launch(
    executablePath
      ? {
          executablePath,
          headless: process.env.HEADLESS !== "false",
        }
      : { headless: process.env.HEADLESS !== "false" },
  );
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await loginToRecreationGov(page, {
      baseUrl,
      email: process.env.RECREATION_EMAIL,
      password: process.env.RECREATION_PASSWORD,
    });

    await page.goto(new URL(`/camping/campsites/${campsiteId}`, baseUrl).toString(), {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(2500);

    const siteAvailabilityTab = page.getByRole("button", { name: /site availability/i });
    if (await siteAvailabilityTab.isVisible().catch(() => false)) {
      await siteAvailabilityTab.click().catch(() => undefined);
      await page.waitForTimeout(1500);
    }

    const enterDatesButton = page.getByRole("button", { name: /enter dates/i }).first();
    if (await enterDatesButton.isVisible().catch(() => false)) {
      await enterDatesButton.click().catch(() => undefined);
      await page.waitForTimeout(1500);
    }

    const arrivalButton = page.getByRole("button", {
      name: new RegExp(`^${formatCalendarLabel(arrival)}(?: - .+)?$`, "i"),
    });
    if (await arrivalButton.isVisible().catch(() => false)) {
      await arrivalButton.click().catch(() => undefined);
      await page.waitForTimeout(1000);
    }

    const checkoutButton = page.getByRole("button", {
      name: new RegExp(`^${formatCalendarLabel(checkout)}(?: - .+)?$`, "i"),
    });
    if (await checkoutButton.isVisible().catch(() => false)) {
      await checkoutButton.click().catch(() => undefined);
      await page.waitForTimeout(2000);
    }

    const addToCartButton = page.getByRole("button", { name: /add to cart/i }).first();
    if (await addToCartButton.isVisible().catch(() => false)) {
      await addToCartButton.click().catch(() => undefined);
      await page.waitForTimeout(3000);
    }

    const cartLink = page.getByRole("link", { name: /cart/i }).first();
    if (await cartLink.isVisible().catch(() => false)) {
      await cartLink.click().catch(() => undefined);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await page.waitForTimeout(2000);
    }
    await page.goto(new URL("/cart", baseUrl).toString(), { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(2000);

    const arrivalInput = await page
      .locator('input, [contenteditable="true"], textarea')
      .evaluateAll((elements) =>
        elements.map((element) => ({
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute("type"),
          name: element.getAttribute("name"),
          id: element.getAttribute("id"),
          placeholder: element.getAttribute("placeholder"),
          ariaLabel: element.getAttribute("aria-label"),
          value: "value" in element ? String((element as { value?: string }).value || "") : "",
        })),
      );

    const buttons = await page.locator("button, a").evaluateAll((elements) =>
      elements
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          text: (element.textContent || "").trim(),
          ariaLabel: element.getAttribute("aria-label"),
          href: element.getAttribute("href"),
        }))
        .filter((element) => element.text || element.ariaLabel)
        .slice(0, 120),
    );

    const body = (await page.locator("body").innerText()).slice(0, 5000);
    const availabilityElements = await page.locator("[aria-label], [data-date], [data-testid]").evaluateAll((elements) =>
      elements
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          text: (element.textContent || "").trim(),
          ariaLabel: element.getAttribute("aria-label"),
          dataDate: element.getAttribute("data-date"),
          dataTestId: element.getAttribute("data-testid"),
          role: element.getAttribute("role"),
        }))
        .filter(
          (element) =>
            /available|checkout|reservation|enter dates|may|june|arrival|departure|check/i.test(
              `${element.text} ${element.ariaLabel} ${element.dataDate} ${element.dataTestId}`,
            ),
        )
        .slice(0, 200),
    );
    const dialogHtml =
      (await page
        .locator('[role="dialog"], .ReactModalPortal, [aria-modal="true"]')
        .first()
        .evaluate((element) => element.outerHTML)
        .catch(() => null)) ?? "";
    const summary = {
      url: page.url(),
      title: await page.title(),
      campsiteId,
      arrivalDate,
      nights,
      inputs: arrivalInput,
      buttons,
      availabilityElements,
      dialogHtml: dialogHtml.slice(0, 12000),
      body,
    };

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
};

await main();
