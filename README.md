# truelayer

Syncs UK bank transactions from [TrueLayer](https://truelayer.com) into a self-hosted [Actual Budget](https://actualbudget.org) instance.

Runs as a Docker container. Supports one-shot mode (triggered by external cron) or a built-in loop for continuous syncing.

## Cribsheets

### Pin a new account to history already in Actual

Import the history into Actual first, then:

- `just add` - authenticate the bank, pick the matching Actual account, `s` to skip the rest
- At `First Sync Start Dates`, Enter to accept the offered date (or type `YYYY-MM-DD`)
- `cat data/config.json` - confirm `backfillFrom` on the new entry
- `just refresh` - first sync, starts at `backfillFrom` and clears it

## How it works

1. **One-time setup** (`npm run setup`) — OAuth flow with TrueLayer, interactive pairing of bank accounts to Actual accounts, saves `data/config.json` and `data/tokens.json`.
2. **Sync** (`npm run sync`) — reads config, refreshes the TrueLayer token, fetches new transactions per account, imports them into Actual, logs any balance drift. Runs once and exits, or loops on an interval if `SYNC_INTERVAL_HOURS` is set.

```
┌─────────────────────────────────┐
│  npm run setup  (run once)      │
│  - TrueLayer OAuth via browser  │
│  - List bank accounts + cards   │
│  - Interactive CLI pairing      │
│  - Save config.json + tokens    │
└────────────────┬────────────────┘
                 │ data/config.json
                 │ data/tokens.json
     ┌───────────▼──────────────────┐
     │  npm run sync                │
     │  1. Load config + tokens     │
     │  2. Refresh TrueLayer token  │
     │  3. For each account:        │
     │     a. Fetch transactions    │
     │     b. Map to Actual format  │
     │     c. importTransactions()  │
     │     d. Log balance drift     │
     │  4. Save updated config      │
     │  5. api.shutdown()           │
     │  6. exit 0                   │
     └──────────────────────────────┘
```

## Prerequisites

- A [TrueLayer](https://console.truelayer.com) account with a registered application
- A self-hosted [Actual Budget](https://actualbudget.org) server
- Node.js 20+ (or Docker)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/jasmucrai/truelayer.git
cd truelayer
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
# TrueLayer — from console.truelayer.com
# Use a sandbox- prefix client ID for testing
TRUELAYER_CLIENT_ID=
TRUELAYER_CLIENT_SECRET=
TRUELAYER_REDIRECT_URI=http://localhost:3000/callback

# Actual Budget
ACTUAL_SERVER_URL=http://your-nas:5006
ACTUAL_PASSWORD=
ACTUAL_SYNC_ID=                     # found in Actual → Settings → Advanced
ACTUAL_ENCRYPTION_PASSWORD=         # optional — only if E2E encryption is enabled

# If Actual uses a self-signed certificate:
# NODE_TLS_REJECT_UNAUTHORIZED=0

# Sync behaviour
SYNC_DAYS_LOOKBACK=7      # minimum days re-fetched on every sync
SYNC_INTERVAL_HOURS=0     # 0 = one-shot (use external cron); >0 = built-in loop
SETUP_PORT=3000
```

> **Important:** `@actual-app/api` must match your Actual server version. If you get an `out-of-sync-migrations` error, run:
>
> ```bash
> npm install @actual-app/api@<your-server-version>
> ```

### 3. Pair accounts

```bash
npm run setup
```

This opens a browser for TrueLayer OAuth, then prompts you to map each bank account/card to an Actual account. Supports multiple banks — you'll be asked after each one if you want to add another.

### 4. Sync

```bash
npm run sync
```

Every run takes the **earlier** of the last sync timestamp and `SYNC_DAYS_LOOKBACK` days ago, so recently-settled transactions that were pending last time are always re-fetched. Actual dedupes them on `imported_id`.

The exception is an account's first sync. If setup found existing transactions in the paired Actual account, it records that date as `backfillFrom` in `data/config.json` and the first sync starts there exactly, with no lookback overlap - see [Migrating from another tool](#migrating-from-another-tool). An account with no history at all falls back to `SYNC_DAYS_LOOKBACK`.

### Migrating from another tool

If you have imported history into Actual from somewhere else, pair the account **after** that import. Setup reads the newest transaction in each Actual account and offers it as the first-sync start date, so there is no gap between where the old tool stopped and where this one starts. Press Enter to accept, type a different `YYYY-MM-DD`, or `n` to use the plain lookback instead.

Actual cannot dedupe against migrated rows on its own. Its fuzzy matcher only considers existing rows where `imported_id` is null, and most migration paths stamp their own id (YNAB writes `YNAB:<amount>:<date>:<n>`), so a re-fetched transaction lands as a duplicate however well it matches. This tool therefore runs its own guard before every import: any incoming transaction with the same date and amount as an existing row that it did not import is skipped, and logged as `Skipped N transaction(s) already present in Actual`. Each existing row is consumed once, so two genuine same-day payments of the same value still import as two.

The same guard covers TrueLayer reissuing a `transaction_id` for something already synced, which would otherwise sail past the id match.

Deletions stick, too - imports run with `reimportDeleted: false`, so a transaction you delete in Actual is not resurrected on the next sync.

Two things worth knowing before the first sync:

- Run it soon after `npm run setup`. Unattended access to more than 90 days of history depends on a fresh consent.
- How far back TrueLayer will go is the bank's call, usually 12-24 months. Ask for more and you simply get less, without an error.

## Docker

### Build and run setup

```bash
docker build -t truelayer .
docker run --rm -it \
  -p 3000:3000 \
  -v /path/to/data:/app/data \
  --env-file .env \
  truelayer node dist/commands/setup.js
```

### docker-compose.yml

```yaml
services:
  truelayer:
    image: truelayer:latest
    container_name: truelayer
    volumes:
      - /path/to/data:/app/data
    env_file: .env
    restart: "no"  # triggered by cron, not always-on
```

Run a sync:

```bash
docker compose run --rm truelayer
```

## Scheduling

The sync command supports two modes, controlled by `SYNC_INTERVAL_HOURS` in `.env`:

### Option A: External cron (default, `SYNC_INTERVAL_HOURS=0`)

The container starts, syncs once, and exits. Scheduling is handled externally — ideal for Synology Task Scheduler or any cron.

**Synology Task Scheduler:**

1. **Control Panel → Task Scheduler → Create → Scheduled Task → User-defined script**
2. Run as: `root` (or a docker-capable user)
3. Schedule: daily at 06:00 (or your preferred time)
4. Script:

   ```bash
   docker compose -f /volume1/docker/truelayer/docker-compose.yml \
     run --rm truelayer
   ```

5. Enable **"Send run details by email"** and **"Send only when script terminates abnormally"**

### Option B: Built-in loop (`SYNC_INTERVAL_HOURS=6`)

Set `SYNC_INTERVAL_HOURS` to a positive number and the container runs continuously, syncing on that interval. Change `restart: "no"` to `restart: unless-stopped` in `docker-compose.yml`:

```yaml
services:
  truelayer:
    image: truelayer:latest
    container_name: truelayer
    volumes:
      - /volume1/docker/truelayer/data:/app/data
    env_file: .env
    restart: unless-stopped
```

## Sandbox / testing

TrueLayer provides a sandbox environment with a mock bank that returns predictable test data — no real bank credentials needed.

1. Create a sandbox app at [console.truelayer.com](https://console.truelayer.com)
2. Set `TRUELAYER_CLIENT_ID=sandbox-<your-id>` in `.env` - the `sandbox-` prefix is detected automatically and switches all API calls to sandbox endpoints
3. Register your redirect URI in the console under the sandbox app's **Allowed redirect URIs**, byte for byte - `http://localhost:3000/callback` if you are running setup on your machine. TrueLayer matches on scheme, host, port and path, so a missing `/callback` or a different port fails the exchange
4. Run `npm run setup` and authenticate with **Mock Bank**, username `john`, password `doe`

Sandbox only has the Mock Bank provider (`uk-cs-mock`) available; the live provider groups (`uk-ob-all`, `uk-oauth-all`) are not valid there. Setup picks the right filter per environment - mixing live ids into a sandbox auth link invalidates the whole filter and the login page sits on "Connecting" forever.

The redirect URI is only used by the browser on the machine running setup; it has nothing to do with Docker networking. If you run setup inside the container instead, publish the port (`-p 3000:3000`) so `localhost:3000` still reaches it.

## npm scripts

| Script | Description |
| --- | --- |
| `npm run setup` | One-time OAuth + account pairing |
| `npm run sync` | Sync transactions (one-shot or loop) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start:setup` | Run compiled setup |
| `npm run start:sync` | Run compiled sync |
| `npm test` | Run unit tests |

## Project structure

```
src/
├── commands/
│   ├── setup.ts        # OAuth flow + interactive account pairing
│   └── sync.ts         # Main sync entry point
├── auth/
│   ├── server.ts       # Temporary Express OAuth callback server
│   └── tokens.ts       # Token storage, refresh, expiry check
├── clients/
│   ├── truelayer.ts    # TrueLayer Data API (accounts, transactions, balance)
│   └── actual.ts       # Actual Budget API wrapper
├── mapper.ts           # TrueLayer transaction → Actual transaction
├── config.ts           # config.json read/write with zod validation
└── logger.ts           # Structured logging
data/                   # Gitignored — mount as a volume to persist state
├── tokens.json         # TrueLayer OAuth tokens
├── config.json         # Account mappings + sync state
└── actual-cache/       # @actual-app/api local budget cache
```

## License

MIT
