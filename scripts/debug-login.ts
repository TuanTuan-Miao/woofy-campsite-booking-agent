import { existsSync } from "node:fs";

import { chromium } from "playwright";

const resolveChromeExecutablePath = (): string | undefined => {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    `${process.env.HOME ?? ""}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  ];

  return candidates.find((candidate) => candidate && existsSync(candidate));
};

const main = async (): Promise<void> => {
  console.error("launching browser");
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
    console.error("opening login page");
    await page.goto("https://www.recreation.gov/log-in", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);

    const loginTrigger = page.getByRole("button", { name: /sign up|log in/i }).first();
    if (await loginTrigger.isVisible().catch(() => false)) {
      console.error("clicking login trigger");
      await loginTrigger.dispatchEvent("click").catch(() => undefined);
      await page.waitForTimeout(2500);
    }

    console.error("collecting DOM summary");

    console.error("reading dialog html");
    const dialogHtml =
      (await page
        .locator('[role="dialog"], .ReactModalPortal, [aria-modal="true"]')
        .first()
        .evaluate((element) => element.outerHTML)
        .catch(() => null)) ?? "";
    console.error("reading inputs");
    const inputs = await page.locator("input").evaluateAll((elements) =>
      elements.map((element) => ({
        type: element.getAttribute("type"),
        name: element.getAttribute("name"),
        id: element.getAttribute("id"),
        placeholder: element.getAttribute("placeholder"),
        ariaLabel: element.getAttribute("aria-label"),
        autocomplete: element.getAttribute("autocomplete"),
      })),
    );
    console.error("reading buttons");
    const buttons = (
      await page.locator("button").evaluateAll((elements) =>
        elements.map((element) => ({
          text: (element.textContent || "").trim(),
          ariaLabel: element.getAttribute("aria-label"),
          id: element.getAttribute("id"),
          type: element.getAttribute("type"),
        })),
      )
    ).slice(0, 50);
    console.error("reading forms");
    const forms = await page.locator("form").evaluateAll((elements) =>
      elements.map((element) => ({
        id: element.getAttribute("id"),
        action: element.getAttribute("action"),
        text: (element.textContent || "").trim().slice(0, 500),
      })),
    );
    console.error("reading body");
    const body = (await page.locator("body").innerText()).slice(0, 1500);
    console.error("printing summary");

    const summary = {
      url: page.url(),
      title: await page.title(),
      inputs,
      buttons,
      forms,
      body,
      dialogHtml: dialogHtml.slice(0, 6000),
    };

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    console.error("closing browser");
    await context.close();
    await browser.close();
  }
};

await main();
