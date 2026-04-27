# Woofy

Woofy is a Recreation.gov reservation watcher and booking assistant built with TypeScript, LangGraph, and Playwright.

It is designed to:

- poll one or more trip targets from `watchlist.json`
- scout campground availability through the public Recreation.gov API
- choose a candidate with deterministic rules or an optional OpenAI-backed strategist
- open a real browser, log in, and try to add a campsite to a cart or checkout hold
- notify you in Telegram when a booking needs manual attention
- keep running in the foreground or as a macOS `launchd` agent

## Use It Wisely

This tool is already a convenience. Don't spoil it with unethical use, don't ruin access for other people, and be kind to the world and the people around you.

## What The Code Does Today

For each target, Woofy:

1. loads shared settings from `.env`
2. loads watch targets from `watchlist.json`, or falls back to single-target `.env` settings when no watchlist exists
3. scouts availability through the Recreation.gov API when a `campgroundId` is available
4. chooses the best campsite with either a rule-based engine or an optional OpenAI-backed engine
5. opens a Playwright browser, logs in, and attempts to add the selected stay to a hold
6. records pending hold state in `.runtime/booking-state.json`
7. sends Telegram messages when availability is found, a hold is active, a hold is released, or a run fails

The current live flow is optimized for manual checkout handoff. `COMMIT_MODE=cart` is the supported operating mode for real bookings.

## Requirements

- Node.js 20+ recommended
- `npm`
- a Playwright-supported browser
- a Recreation.gov account
- macOS if you want to use the included `launchd` helper scripts
- an optional Telegram bot token and chat id for notifications and remote control

## Quick Start

Install dependencies and the browser runtime:

```bash
npm install
npx playwright install chromium
```

Create local config files:

```bash
cp .env.example .env
cp watchlist.example.json watchlist.json
```

Fill in at least:

- `RECREATION_EMAIL`
- `RECREATION_PASSWORD`
- `COMMIT_MODE=cart`

Then validate the repo:

```bash
npm run check
npm run test
```

Run one pass:

```bash
npm run run-once
```

Start the scheduler in the foreground:

```bash
npm run schedule
```

## Configuration

Shared settings live in `.env`. The checked-in `.env.example` now includes all currently supported environment variables.

Common settings:

- `AGENT_ENABLED`: pause or resume monitoring without deleting config
- `POLL_CRON`: scheduler cadence for `npm run schedule`
- `HEADLESS`: `false` is recommended for live booking
- `BOOKING_ENABLED`: set `false` to scout without attempting a reservation
- `COMMIT_MODE`: keep this set to `cart`
- `MANUAL_VERIFICATION_TIMEOUT_MS`: how long Woofy waits for a CAPTCHA or manual verification step
- `MAX_TOTAL_PRICE`
- `ALLOW_ALTERNATIVES`
- `PARTY_SIZE`

Credentials and integrations:

- `RECREATION_EMAIL`
- `RECREATION_PASSWORD`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`

Notes:

- `OPENAI_API_KEY` is optional. Without it, Woofy uses the rule-based decision engine.
- Telegram is optional. If it is not configured, the scheduler still runs locally.
- `.env` is local state and should never be committed.

## Watchlist Mode

`watchlist.json` is the preferred way to manage real trips. Start from `watchlist.example.json`.

Each entry supports:

- `id`
- `name`
- `campgroundId`
- `arrivalDate`
- `nights`
- optional `partySize`
- optional `campsiteType`
- optional `excludeRvSites`
- optional `preferredCampsiteIds`
- optional `excludedCampsiteIds`
- optional `bookingEnabled`
- optional `allowAlternatives`
- optional `maxTotalPrice`
- optional `commitMode`

Example:

```json
[
  {
    "id": "trip-a",
    "name": "Trip A",
    "campgroundId": "233116",
    "arrivalDate": "2026-05-15",
    "nights": 2,
    "excludeRvSites": true,
    "preferredCampsiteIds": ["64674"],
    "excludedCampsiteIds": []
  }
]
```

If `watchlist.json` is missing or empty, Woofy falls back to the single-target `.env` values:

- `CAMPGROUND_ID`
- `ARRIVAL_DATE`
- `NIGHTS`
- `CAMPSITE_TYPE`
- `PREFERRED_CAMPSITE_IDS`
- `EXCLUDED_CAMPSITE_IDS`

## Direct Candidate Mode

If you want to inspect a specific campsite URL instead of scouting by campground id, you can use:

- `PRIMARY_CAMPSITE_NAME`
- `PRIMARY_CAMPSITE_URL`
- `ALTERNATIVE_CAMPSITE_URLS`

When `PRIMARY_CAMPSITE_URL` is present, Woofy can inspect those direct campsite pages with Playwright even without a `campgroundId`.

## Commands

```bash
npm run check
npm run test
npm run run-once
npm run schedule
npm run bot
```

What they do:

- `npm run run-once` runs the workflow once for each target and prints JSON results to stdout
- `npm run schedule` starts the polling controller in the foreground
- `npm run bot` starts the controller and requires `TELEGRAM_BOT_TOKEN`

If `TELEGRAM_BOT_TOKEN` is configured, `npm run schedule` also starts the Telegram control bot automatically.

## Background Mode On macOS

The repository includes `launchd` helper scripts for a persistent local agent:

```bash
./scripts/start_live.sh
./scripts/status.sh
./scripts/kill_switch.sh
```

These scripts:

- register Woofy as a per-user `launchd` agent
- write logs to `.runtime/agent.log`
- write status snapshots to `.runtime/agent-status.json`
- use the generic label `dev.woofy.agent`

## Telegram Control

When Telegram is configured, the bot supports:

- `/help`
- `/start`
- `/restart`
- `/resume`
- `/stop`
- `/status`
- `/list`
- `/env`
- `/run`
- `/configure <id> <campgroundId> <arrivalDate> <nights> [excludeRV=true|false]`
- `/remove <id>`
- `/set <KEY> <VALUE>`

Examples:

```text
/status
/list
/stop
/restart
/configure trip-a 233116 2026-05-15 2 true
/set MAX_TOTAL_PRICE 250
```

Security note:

- `/set` writes values directly into `.env`
- avoid sending passwords or bot tokens over Telegram unless you are comfortable with that transport

## Runtime Files

Woofy writes local runtime files under `.runtime/`:

- `agent.log`: rolling scheduler log
- `agent-status.json`: latest controller snapshot
- `booking-state.json`: pending cart or payment hold information

These files are local-only and should not be committed.

## Status Output

Telegram `/status` includes:

- `Cron`
- `Running`
- `AGENT_ENABLED=true|false`
- `WATCH_COUNT`
- one `WATCH:` line per watch target
- recent `Last <watch>` decision summaries

Notes:

- blank `CAMPGROUND_ID`, `ARRIVAL_DATE`, and `NIGHTS` are expected in watchlist mode
- `Running: false` means the scheduler is idle between polls, not that it is disabled

## Availability States

Woofy maps Recreation.gov scout responses into:

- `available`
- `unavailable`
- `not_yet_released`
- `unknown`

`not_yet_released` means the requested stay is not open for booking yet, not that it is sold out.

## Operational Caveats

- Recreation.gov can change selectors, layout, and booking flows at any time.
- A headed browser is usually more reliable than headless mode for live booking.
- If the machine sleeps or the logged-in session locks, live browser automation can fail.
- Recreation.gov may show CAPTCHAs or human verification prompts; Woofy waits for manual completion up to `MANUAL_VERIFICATION_TIMEOUT_MS`.
- The public availability API can occasionally rate limit with responses such as `429 Too Many Requests`.
- Woofy does not submit payment for you in the supported live setup. Treat the hold notification as the handoff point.

## Repository Layout

- `src/index.ts`: CLI entry point
- `src/workflow.ts`: LangGraph workflow
- `src/recreation-api.ts`: API-based scouting
- `src/recreation-adapter.ts`: live Playwright adapter
- `src/agent-controller.ts`: scheduler, reminders, status snapshots
- `src/telegram-control.ts`: Telegram command handling
- `src/watchlist.ts`: watchlist parsing and request construction
- `src/env-file.ts`: local `.env` reload and update helpers
- `scripts/start_live.sh`: macOS background launcher
- `scripts/kill_switch.sh`: background stop helper
- `scripts/status.sh`: background status helper
