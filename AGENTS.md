# AGENTS.md

## Project Overview

Woofy is a TypeScript reservation agent for Recreation.gov.

The current runtime flow is:

1. Load shared settings from `.env`.
2. Load watch targets from `watchlist.json`, or fall back to single-target `.env` settings.
3. Scout campground availability through the public Recreation.gov API when a `campgroundId` is available.
4. Pick a candidate with either deterministic rules or an optional OpenAI-backed decision engine.
5. Open a real Playwright browser, log in, and try to add the selected site to a cart or checkout hold.
6. Persist hold state in `.runtime/booking-state.json` and send Telegram notifications when configured.

The live adapter is designed around a manual handoff before checkout is submitted. Use `COMMIT_MODE=cart` for normal operation.

## Setup

1. Install dependencies with `npm install`.
2. Install a Playwright browser with `npx playwright install chromium`.
3. Copy `.env.example` to `.env`.
4. Copy `watchlist.example.json` to `watchlist.json`.
5. Fill in Recreation.gov credentials and, if wanted, Telegram settings in `.env`.

## Commands

- `npm run check`: Type-check the project.
- `npm run test`: Run the Vitest suite.
- `npm run run-once`: Execute the workflow once for each watch target and print JSON results.
- `npm run schedule`: Start the polling controller in the foreground. If Telegram is configured, the control bot is started automatically.
- `npm run bot`: Start the controller and require a Telegram bot token.
- `./scripts/start_live.sh`: Register the scheduler as a macOS `launchd` agent.
- `./scripts/status.sh`: Show `launchd` status and the latest runtime snapshot.
- `./scripts/kill_switch.sh`: Stop the background `launchd` agent.

## Configuration Notes

- `watchlist.json` is the preferred way to track multiple trips.
- If `watchlist.json` is missing or empty, Woofy falls back to single-target `.env` settings like `CAMPGROUND_ID`, `ARRIVAL_DATE`, and `NIGHTS`.
- If `PRIMARY_CAMPSITE_URL` is set, Woofy can also inspect direct campsite URLs without using campground API scouting.
- `OPENAI_API_KEY` is optional. Without it, the rule-based decision engine is used.
- `MANUAL_VERIFICATION_TIMEOUT_MS` controls how long Woofy waits if Recreation.gov shows a CAPTCHA or human verification step.

## Important Files

- `src/index.ts`: CLI entry point for `run-once`, `schedule`, and `bot`.
- `src/agent-controller.ts`: Scheduler, status snapshots, pending-hold reminders, and watchlist orchestration.
- `src/workflow.ts`: LangGraph workflow for scout, strategist, risk, and booking steps.
- `src/recreation-api.ts`: Public Recreation.gov availability scout.
- `src/recreation-adapter.ts`: Live Playwright inspection and booking adapter.
- `src/telegram-control.ts`: Telegram polling bot and commands.
- `src/env-file.ts`: `.env` reload and in-place updates for Telegram `/set`.
- `src/watchlist.ts`: Watchlist parsing, validation, and fallback request construction.
- `scripts/debug-*.ts`: Manual debugging helpers for login and live page inspection.

## Security And Local State

- Do not commit `.env`, `watchlist.json`, `.runtime/`, `.playwright-cli/`, or `playwright/.auth`.
- Treat Telegram bot tokens, chat ids, Recreation.gov credentials, and booking hold URLs as sensitive.
- Telegram `/set` writes values directly into `.env`. Avoid sending secrets that way unless you are comfortable with them passing through Telegram.
- The `launchd` scripts now use the generic label `dev.woofy.agent` instead of a user-specific namespace.
