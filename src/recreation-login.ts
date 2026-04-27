import type { Locator, Page } from "playwright";

type LoginRequest = {
  baseUrl: string;
  email: string;
  password: string;
};

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

const waitForSettledState = async (page: Page, timeout = 4000): Promise<void> => {
  await page.waitForLoadState("networkidle", { timeout }).catch(() => undefined);
};

const findEmailField = (page: Page): Promise<Locator | null> =>
  pickFirstVisible([
    page.locator("#email"),
    page.getByLabel(/email/i),
    page.getByPlaceholder(/email/i),
    page.locator('input[type="email"]'),
    page.locator('input[name*="email" i]'),
    page.locator('[data-testid="email"]'),
  ]);

const findPasswordField = (page: Page): Promise<Locator | null> =>
  pickFirstVisible([
    page.locator("#rec-acct-sign-in-password"),
    page.getByLabel(/password/i),
    page.getByPlaceholder(/password/i),
    page.locator('input[type="password"]'),
    page.locator('input[name*="password" i]'),
    page.locator('[data-testid="password"]'),
  ]);

const openLoginModal = async (page: Page): Promise<void> => {
  const trigger = await pickFirstVisible([
    page.locator("#ga-global-nav-log-in-link"),
    page.getByRole("button", { name: /sign up or log in|sign up \/ log in|log in/i }),
    page.getByRole("button", { name: /sign up/i }),
  ]);

  if (!trigger) {
    return;
  }

  await trigger.dispatchEvent("click").catch(() => undefined);
  await page.waitForTimeout(2500);
};

export const loginToRecreationGov = async (page: Page, request: LoginRequest): Promise<void> => {
  await page.goto(new URL("/log-in", request.baseUrl).toString(), {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(2500);

  let emailField = await findEmailField(page);
  let passwordField = await findPasswordField(page);

  if (!emailField || !passwordField) {
    await openLoginModal(page);
    emailField = await findEmailField(page);
    passwordField = await findPasswordField(page);
  }

  if (!emailField || !passwordField) {
    throw new Error("Could not find login fields on the page.");
  }

  await emailField.fill(request.email);
  await passwordField.fill(request.password);

  const submit = await pickFirstVisible([
    page.getByRole("button", { name: /^log ?in$/i }),
    page.locator('form button[type="submit"]'),
    page.locator('button[type="submit"]'),
    page.locator('[data-testid="login-submit"]'),
  ]);

  if (!submit) {
    throw new Error("Could not find a login submit button.");
  }

  await submit.click();
  await waitForSettledState(page);
  await page.waitForTimeout(2500);
};
