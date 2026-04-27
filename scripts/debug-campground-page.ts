import { existsSync } from "node:fs";

import { chromium } from "playwright";

import { loadDotEnvIntoProcess } from "../src/env-file.js";
import { loginToRecreationGov } from "../src/recreation-login.js";

const parseUsDate = (value: string): Date => {
  const [month, day, year] = value.split("/").map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
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

const resolveChromeExecutablePath = (): string | undefined => {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    `${process.env.HOME ?? ""}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  ];

  return candidates.find((candidate) => candidate && existsSync(candidate));
};

const main = async (): Promise<void> => {
  loadDotEnvIntoProcess();

  const campgroundId = process.argv[2] ?? "232769";
  const siteNumber = process.argv[3] ?? "002";
  const arrivalDate = process.argv[4] ?? "08/25/2026";
  const checkoutDate = process.argv[5] ?? "08/26/2026";
  const baseUrl = process.env.RECREATION_BASE_URL ?? "https://www.recreation.gov";

  const executablePath = resolveChromeExecutablePath();
  const browser = await chromium.launch(
    executablePath
      ? { executablePath, headless: process.env.HEADLESS !== "false" }
      : { headless: process.env.HEADLESS !== "false" },
  );
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await loginToRecreationGov(page, {
      baseUrl,
      email: process.env.RECREATION_EMAIL ?? "",
      password: process.env.RECREATION_PASSWORD ?? "",
    });

    await page.goto(new URL(`/camping/campgrounds/${campgroundId}`, baseUrl).toString(), {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(3000);

    const bodiesBefore = (await page.locator("body").innerText()).slice(0, 2000);

    const allInputs = await page.locator("input").evaluateAll((elements) =>
      elements.map((element) => ({
        type: element.getAttribute("type"),
        id: element.getAttribute("id"),
        name: element.getAttribute("name"),
        placeholder: element.getAttribute("placeholder"),
        ariaLabel: element.getAttribute("aria-label"),
        value: element.value,
      })),
    );

    const calendarButton = page.getByRole("button", { name: /calendar/i }).first();
    if (await calendarButton.isVisible().catch(() => false)) {
      await calendarButton.click().catch(() => undefined);
      await page.waitForTimeout(1500);
    }

    const arrival = parseUsDate(arrivalDate);
    const checkout = parseUsDate(checkoutDate);
    for (let attempt = 0; attempt < 18; attempt += 1) {
      const targetVisible = await page
        .getByRole("button", { name: new RegExp(formatCalendarLabel(arrival), "i") })
        .first()
        .isVisible()
        .catch(() => false);
      if (targetVisible) {
        break;
      }

      await page.getByRole("button", { name: /^next$/i }).first().click().catch(() => undefined);
      await page.waitForTimeout(500);
    }

    await page
      .getByRole("button", { name: new RegExp(formatCalendarLabel(arrival), "i") })
      .first()
      .click()
      .catch(() => undefined);
    await page.waitForTimeout(300);
    await page
      .getByRole("button", { name: new RegExp(formatCalendarLabel(checkout), "i") })
      .first()
      .click()
      .catch(() => undefined);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(1500);

    const dateChip = await page.locator("button, div, input").evaluateAll((elements, targetDate) =>
      elements
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          text: (element.textContent || "").trim(),
          ariaLabel: element.getAttribute("aria-label"),
          value: "value" in element ? String((element as { value?: string }).value || "") : "",
        }))
        .filter((element) =>
          `${element.text} ${element.ariaLabel} ${element.value}`.includes(targetDate),
        )
        .slice(0, 30),
      arrivalDate,
    );

    const hiddenValues = {
      start: await page.locator("#campground-calendar-hidden-start").inputValue().catch(() => ""),
      end: await page.locator("#campground-calendar-hidden-end").inputValue().catch(() => ""),
    };

    const dateButtons = await page.locator("button, [role='button']").evaluateAll((elements) =>
      elements
        .map((element) => ({
          text: (element.textContent || "").trim().replace(/\s+/g, " "),
          ariaLabel: element.getAttribute("aria-label"),
          disabled:
            element instanceof HTMLButtonElement
              ? element.disabled
              : element.getAttribute("aria-disabled"),
          className: element.getAttribute("class"),
        }))
        .filter((element) =>
          /august|aug|check in|check out|arrival|depart|next month|previous month|next|prev|calendar/i.test(
            `${element.text} ${element.ariaLabel ?? ""}`,
          ),
        )
        .slice(0, 80),
    );

    const searchSiteInput = await page.getByPlaceholder(/search site number|search site/i).first();
    if (await searchSiteInput.isVisible().catch(() => false)) {
      await searchSiteInput.fill(siteNumber).catch(() => undefined);
      await page.waitForTimeout(1500);
    }

    const rowButtonsBefore = await page.locator("button").evaluateAll((elements, target) =>
      elements
        .map((element) => ({
          text: (element.textContent || "").trim().replace(/\s+/g, " "),
          ariaLabel: element.getAttribute("aria-label"),
          disabled: element instanceof HTMLButtonElement ? element.disabled : false,
        }))
        .filter((element) => `${element.text} ${element.ariaLabel ?? ""}`.includes(target))
        .slice(0, 40),
      siteNumber,
    );

    await page
      .getByRole("button", { name: new RegExp(`Aug 25, 2026 - Site ${siteNumber} is available`, "i") })
      .first()
      .click()
      .catch(() => undefined);
    await page.waitForTimeout(500);

    const rowButtonsAfterFirstClick = await page.locator("button").evaluateAll((elements, target) =>
      elements
        .map((element) => ({
          text: (element.textContent || "").trim().replace(/\s+/g, " "),
          ariaLabel: element.getAttribute("aria-label"),
          disabled: element instanceof HTMLButtonElement ? element.disabled : false,
          className: element.getAttribute("class"),
        }))
        .filter((element) => `${element.text} ${element.ariaLabel ?? ""}`.includes(target))
        .slice(0, 40),
      siteNumber,
    );

    await page
      .getByRole("button", { name: /site 002/i })
      .filter({ hasText: /^A$|^R$|^X$|✓$/ })
      .nth(1)
      .click()
      .catch(() => undefined);
    await page.waitForTimeout(500);

    const addToCartState = await page.locator("button").filter({ hasText: /^Add to Cart$/i }).first().evaluate((button) => ({
      text: (button.textContent || "").trim(),
      disabled: button instanceof HTMLButtonElement ? button.disabled : button.getAttribute("aria-disabled"),
      className: button.getAttribute("class"),
    })).catch(() => null);

    const rowCandidates = await page.locator("[role='row'], tr, button, div").evaluateAll((elements, target) =>
      elements
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          text: (element.textContent || "").trim().replace(/\s+/g, " "),
          ariaLabel: element.getAttribute("aria-label"),
          role: element.getAttribute("role"),
          className: element.getAttribute("class"),
        }))
        .filter((element) => element.text.includes(target) || `${element.ariaLabel ?? ""}`.includes(target))
        .slice(0, 60),
      siteNumber,
    );

    const buttons = await page.locator("button, a").evaluateAll((elements) =>
      elements
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          text: (element.textContent || "").trim(),
          ariaLabel: element.getAttribute("aria-label"),
        }))
        .filter((element) => element.text || element.ariaLabel)
        .slice(0, 120),
    );

    const summary = {
      url: page.url(),
      title: await page.title(),
      bodiesBefore,
      allInputs,
      dateChip,
      hiddenValues,
      dateButtons,
      rowButtonsBefore,
      rowButtonsAfterFirstClick,
      addToCartState,
      rowCandidates,
      buttons,
      body: (await page.locator("body").innerText()).slice(0, 5000),
    };

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
};

await main();
