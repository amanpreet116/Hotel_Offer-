# Hotel Offer Orchestrator — Project Guide

> Working context for Claude Code. Keep this file current: when an architecture
> decision changes, change it here first.

## Assignment spec (verbatim)

**Title:** Hotel Offer Orchestrator
**Stack:** Node.js (TypeScript), Express, Temporal, Redis, Docker Compose

### Overview

Aggregate overlapping hotel offers from two mock suppliers, dedupe hotels, and
select the best offer per hotel. Add the ability to filter hotels by price
range.

### Objective

Build and deploy a system that:

- Calls two mocked supplier hotel APIs
- Compares hotel listings based on price
- Returns the best-priced hotel for each name (de-duplicated)
- Uses Temporal.io to orchestrate the comparison logic
- Ability to filter hotel list by price range

### Functional requirements

**Endpoints**

`GET /api/hotels?city=delhi`

Workflow behavior — use Temporal to orchestrate this process:

- Call Supplier A and Supplier B **in parallel**
- Each returns a list of hotels for the requested city
- Deduplicate hotels by name
- For each hotel name that appears in both lists: select the one with the
  cheaper price
- If only one supplier returns a hotel, select that one
- Return the final de-duplicated list to the client

`GET /api/hotels?city=delhi&minPrice=<min>&maxPrice=<max>`

- Deduplicated list must also be saved in Redis
- Implement price filtering **inside Redis**

**Response format**

```json
[
  { "name": "Holtin", "price": 5340, "supplier": "Supplier B", "commissionPct": 20 },
  { "name": "Radison", "price": 5900, "supplier": "Supplier A", "commissionPct": 13 }
]
```

**Mock supplier APIs** — create two mock endpoints within your service:
`GET /supplierA/hotels`, `GET /supplierB/hotels`. Each returns a static JSON
array like:

```json
[{ "hotelId": "a1", "name": "Holtin", "price": 6000, "city": "delhi", "commissionPct": 10 }]
```

Values can be hardcoded or randomly selected, but must include overlapping hotel
names between A and B for meaningful comparisons.

### DevOps requirements

- Containerize the application using Docker

### Postman collection

Create a Postman collection to test the API:

- Valid city with expected overlaps (e.g. `city=delhi`)
- City with no results
- Simulate one supplier being down (optional)

### Submission checklist

GitHub repository with: source code; Dockerfile; README.md with clear setup &
deployment steps; Postman collection file (`.json`).

### Optional bonus points

- Health check endpoint (`/health`) must inform about the health of both the
  suppliers
- Logging & error handling in activities/workflows

## Locked architecture decisions

These are decided. Do not relitigate them mid-implementation.

1. **Express delegates to Temporal.** `GET /api/hotels` starts/executes a
   Temporal workflow and returns its result. The route holds no orchestration
   logic.
2. **The workflow fans out in parallel.** It calls the two supplier activities
   concurrently, dedupes by name (cheapest wins), saves the result to Redis via
   an activity, and returns it.
3. **No I/O in workflow code.** HTTP calls and Redis _writes_ happen only
   inside Temporal activities — workflow code must stay deterministic and
   replay-safe, so it gets no clock, no randomness and no sockets. The pure
   `dedupeAndSelectBest` function is the one exception: it runs inline in the
   workflow. The Express API _reads_ the Redis cache directly for price-range
   queries; that is not workflow code, so determinism does not apply, and
   routing a read through Temporal would add a round trip for nothing.
4. **Price filtering happens inside Redis.** Offers are indexed in a sorted set
   scored by price and queried with `ZRANGEBYSCORE`. Never fetch the whole set
   and filter in JavaScript. Both the cache-hit and cache-miss paths answer
   from the same `ZRANGEBYSCORE` — a miss runs the workflow purely for its
   side effect of populating Redis, then queries.
5. **Config comes from env with defaults.** Read `src/config`, never
   `process.env`, outside that module.
6. **Graceful degradation over supplier failure.** If one supplier activity
   fails after its retries, the workflow still succeeds with the other
   supplier's offers and logs a warning. It fails only if _both_ fail. A
   `saveToRedis` failure, by contrast, _does_ fail the workflow — Redis is a
   declared dependency and the price-filter endpoint reads from it, so silently
   returning unsaved data would let a later filtered query serve stale results.
7. **Supplier identity is the display name.** `HotelOffer.supplier` is
   `"Supplier A"` / `"Supplier B"`, matching the spec's response format exactly.
   The _route paths_ stay `/supplierA/hotels` and `/supplierB/hotels` as the
   spec requires. Don't let the two drift into one identifier.

## Layout

```
src/
  api/          Express app, middleware, orchestrator routes
    routes/     health, hotels
  temporal/     activities, workflows, worker, client
  suppliers/    mock supplier fixtures + their Express routes
  redis/        client + repository (sorted-set index)  [not wired yet]
  domain/       framework-free types + dedupe logic
  config/       env parsing with defaults
  scripts/      operational one-off scripts (verify-workflow)
  logger.ts     pino
test/           vitest unit tests
```

Import rule: `domain/` depends on nothing. `suppliers/`, `redis/`, `temporal/`
may depend on `domain/` and `config/`. `api/` wires things together. Nothing
imports upward into `api/`.

**Two processes, two entrypoints:** `src/index.ts` (Express API) and
`src/temporal/worker.ts` (Temporal worker). They never share a process — that's
what lets the worker scale and restart independently.

## Domain types

```ts
type SupplierId = 'Supplier A' | 'Supplier B';
interface RawHotel {
  hotelId: string;
  name: string;
  price: number;
  city: string;
  commissionPct: number;
}
interface HotelOffer {
  name: string;
  price: number;
  supplier: SupplierId;
  commissionPct: number;
}
```

`RawHotel` is what a supplier returns over HTTP; `HotelOffer` is the normalized
internal/external shape and is exactly the spec's response format.
`toHotelOffer(raw, supplier)` converts.

## Dedup contract (`src/domain/dedupe.ts`)

`dedupeAndSelectBest(a: HotelOffer[], b: HotelOffer[]): HotelOffer[]`

- Groups by name, compared trimmed and case-insensitively.
- Cheaper price wins; the winner keeps its own supplier tag, commission and
  display name.
- Exact price ties break by supplier id ascending → `Supplier A` wins, and the
  result does not depend on argument order.
- Single-supplier hotels pass through.
- Output is sorted by name, then price, then supplier — deterministic output is
  required for Temporal replay and for stable test assertions.

## Temporal design

- **Task queue:** `hotel-offers` (config `TEMPORAL_TASK_QUEUE`).
- **Workflow:** `getHotelsWorkflow(city) -> HotelOffer[]`.
- **Activities:** `fetchSupplierA`, `fetchSupplierB`, `saveToRedis`. All are
  idempotent — they are reads, or an overwrite of one city's cached list — so
  Temporal's at-least-once delivery is safe.
- **Retries:** 3 maximum attempts, 200 ms initial interval, backoff ×2, 10 s
  `startToCloseTimeout`. Supplier 4xx responses are surfaced as
  non-retryable application failures; 5xx and network errors retry.
- **Workflow ID:** `hotels:<city>`, with conflict policy `USE_EXISTING`, so two
  concurrent requests for the same city join one run instead of fanning out to
  the suppliers twice. Reuse policy `ALLOW_DUPLICATE` lets the next request
  after completion start a fresh run.

## Redis layout (`src/redis/repository.ts`)

```
hotels:{city}        ZSET    score = price, member = JSON.stringify(offer)
hotels:{city}:meta   STRING  {"count":n,"savedAt":"<iso>"}
```

- Both keys carry `REDIS_TTL_SECONDS` (default 300).
- A save is `DEL` + `ZADD` + `EXPIRE` inside one `MULTI`, so a reader sees the
  old snapshot or the new one, never half of either. Replacing rather than
  merging is what keeps `saveToRedis` idempotent under Temporal's
  at-least-once execution.
- `serializeOffer` writes keys in a fixed order. Member identity in a ZSET is
  the exact string, so an unstable key order would let one hotel appear twice.
- **The meta key, not the sorted set, is the "is this city cached?" flag.** A
  city with no hotels has no sorted set at all, and without the marker every
  request for an unknown city would re-run the workflow.
- Reads are re-sorted with `compareOffers` so a list from Redis (which comes
  back price-ascending) matches a list straight from the workflow.

## API contract

| Request                                          | Behavior                                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `GET /api/hotels?city=delhi`                     | Runs the workflow, returns its list                                                                      |
| `GET /api/hotels?city=delhi&minPrice=&maxPrice=` | `ZRANGEBYSCORE`, populating first on a miss. Bounds are inclusive; either may be omitted (`-inf`/`+inf`) |
| missing/empty `city`                             | 400 `city_required`                                                                                      |
| non-numeric or negative bound                    | 400 `invalid_price`                                                                                      |
| `minPrice > maxPrice`                            | 400 `invalid_price_range`                                                                                |
| unknown city                                     | 200 `[]`                                                                                                 |

Every error — 400, 404, 500 alike — is rendered by the one handler in
`api/server.ts` from an `ApiError`, as `{ error, message, details? }`. Each
request gets an `x-request-id` (echoed if the client sent one) that appears in
every log line for that request.

## Mock supplier fixtures

`GET /supplierA/hotels?city=delhi`, `GET /supplierB/hotels?city=delhi`
(default city `delhi`; unknown city → `[]`; `?delayMs=` simulates latency;
`?fail=1` returns 503 to exercise graceful degradation).

Delhi is the demo case: 6 hotels each, 4 overlapping names, merging to 8 offers.

| Hotel              | A     | B     | Winner        |
| ------------------ | ----- | ----- | ------------- |
| Holtin             | 5200  | 4950  | B             |
| Radison            | 6100  | 6400  | A             |
| Leela Palace       | 9800  | 9800  | A (tie-break) |
| Taj Mahal Hotel    | 12400 | 11900 | B             |
| The Imperial       | 8700  | —     | A only        |
| Bloomrooms Janpath | 3100  | —     | A only        |
| Hyatt Regency      | —     | 7250  | B only        |
| Andaz Delhi        | —     | 10500 | B only        |

Mumbai has 4 hotels per supplier (2 overlapping, one of them a tie).

## Build order

- [x] **Step 1 — foundation.** TypeScript + Express skeleton, config, logger,
      domain types, dedup + unit tests, mock supplier routes.
- [x] **Step 2 — Temporal.** Activities, workflow with parallel fan-out and
      graceful degradation, worker, client, `GET /api/hotels?city=`.
- [x] **Step 3 — Redis.** Client, repository writing a price-scored sorted set,
      real `saveToRedis`, `minPrice`/`maxPrice` served by `ZRANGEBYSCORE`,
      centralized JSON errors and per-request logging.
- [x] **Step 4 — Docker.** Multi-stage Dockerfile (one image, api vs worker by
      command override), compose with postgres + redis + temporal auto-setup +
      temporal-ui, healthchecks gating dependents, README.
- [x] **Step 5 — Bonus + polish.** `/health` live-probing both suppliers, Redis
      and Temporal; structured logging with request/workflow correlation;
      infrastructure error mapping; graceful shutdown.
- [x] **Step 6 — Postman.** Collection v2.1 + environment under `postman/`,
      44 assertions, verified green with newman against the compose stack.
- [x] **Step 7 — Submission polish.** Full README (mermaid architecture, why
      Temporal, why a ZSET, troubleshooting), ESLint + Prettier, expanded
      tests incl. a Redis integration suite, dead code removed, clean-clone
      `docker compose up` verified.
- [x] **Step 8 — Swagger.** OpenAPI 3.0 in one typed object
      (`src/api/openapi.ts`), UI at `/api-docs`, raw spec at `/api-docs.json`,
      drift-guard tests.
- [ ] **Remaining for submission.** `git init` and first commit — the repo is
      not under version control yet.

Postman notes: request 2 uses the spec's `minPrice=5000&maxPrice=6000`, which is
legitimately empty against the delhi fixtures (prices jump 4950 -> 6100), so 2b
covers a populated range. Request 6 documents that hitting `?fail=1` directly
does not degrade the workflow — the worker reads `SUPPLIER_A_URL` at startup, so
it must be restarted with the failing URL.

## Docker

- One image, two entrypoints: `app-api` runs `dist/index.js`, `app-worker`
  overrides `command` to `dist/temporal/worker.js`.
- **Debian slim, not Alpine**: `@temporalio/core-bridge` is a native Rust addon
  whose prebuilt binaries target glibc.
- Compose gotchas already paid for, do not reintroduce:
  - Temporal's healthcheck must address `temporal:7233`, **not** `127.0.0.1` —
    the frontend binds the container's network IP, so loopback is refused.
  - Do **not** set `DYNAMIC_CONFIG_FILE_PATH=config/dynamicconfig/development-sql.yaml`
    (as older reference composes do). Image 1.29 ships only `docker.yaml` and
    exits at startup if pointed elsewhere.
  - The api healthcheck uses `node -e "fetch(...)"` because `node:20-slim` has
    no curl.
  - `docker compose up --build` does not always recreate running containers
    after a rebuild; use `--force-recreate` when verifying a code change.
- Host ports are all overridable via `.env` (`API_HOST_PORT`, `TEMPORAL_UI_PORT`,
  `TEMPORAL_GRPC_PORT`, `REDIS_HOST_PORT`) because 3000/6379/8080 are commonly
  taken.

## Operational behavior

- **Health.** `checkHealth()` probes suppliers, Redis and Temporal concurrently.
  `down` (503) means Redis or Temporal is out, or _both_ suppliers are.
  `degraded` (200) means one supplier is out — deliberately not 503, since that
  is the exact failure the workflow absorbs, and 503 would pull the container
  from rotation.
- **Timeouts on the request path.** The Temporal SDK retries `UNAVAILABLE`
  forever, so both client acquisition and `workflow.start` are bounded by
  `TEMPORAL_START_TIMEOUT_MS`; `handle.result()` stays unbounded because a run
  is legitimately long. Workflows also carry a server-side
  `workflowExecutionTimeout`.
- **Error mapping** (`api/error-mapping.ts`) unwraps the whole Temporal cause
  chain. `WorkflowFailedError` wraps an `ActivityFailure` ("Activity task
  failed") which wraps the `ApplicationFailure` that actually says what broke —
  only the flattened chain is diagnostic.
- **Shutdown steps run sequentially, not in parallel.** For the worker,
  `worker.shutdown()` merely _initiates_ draining; the promise returned by
  `worker.run()` is what resolves when draining is done. Closing the connection
  before that fails with "Workers hold a reference to it".

## Documentation layer

- The OpenAPI contract is **one typed object**, `src/api/openapi.ts`, not JSDoc
  annotations on routes — annotations drift silently. `OpenAPIV3.Document`
  typing makes a malformed spec a compile error, and `test/openapi.test.ts`
  fails on a dangling `$ref` or a schema that stops matching its TS type.
- `servers[0]` is **relative (`/`)** and must stay first: Swagger UI's "Try it
  out" targets the origin serving the docs. An absolute URL built from `PORT`
  breaks the moment the container port is published on a different host port.
- `/api-docs.json` is registered **before** the `/api-docs` UI mount, or
  swagger-ui-express's own index swallows it.

## Tooling

- ESLint flat config (`eslint.config.js`) with type-aware rules; it lints
  `test/` too via `tsconfig.eslint.json` (which must re-declare `exclude`,
  since `tsconfig.json` excludes `test`).
- Async Express handlers go through `asyncHandler` — Express 4 ignores returned
  promises, so a rejection escaping a handler becomes an unhandled rejection
  instead of reaching the error middleware.
- `enableOfflineQueue` stays **on** for Redis. Turning it off to get fail-fast
  behaviour means any command issued between process start and the socket
  becoming ready is rejected outright — a spurious 503 right after boot.
  Fail-fast comes from `maxRetriesPerRequest` + `commandTimeout` instead.
- Only `app-api` declares `build:` in compose. Declaring it on `app-worker` too
  makes Compose run two concurrent builds of an identical image — wasted work,
  and it caused a flaky `npm ci` failure under load.

## Conventions

- `"type": "module"`, `NodeNext` resolution → **relative imports need the `.js`
  extension**, even from `.ts` files.
- `strict`, `noImplicitAny`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes` are all on. Indexing an array yields `T |
undefined`; handle it rather than asserting.
- Structured logging via `logger` (pino) in activities and the API; the
  replay-safe `log` from `@temporalio/workflow` inside workflow code. No
  `console.log`.
- Prices are integers (INR) throughout.

## Commands

```bash
npm run dev           # API, tsx watch
npm run dev:worker    # Temporal worker, tsx watch
npm start             # API from dist/
npm run start:worker  # worker from dist/
npm run verify        # end-to-end workflow smoke test
npm test              # vitest
npm run typecheck     # tsc --noEmit
```

Local Temporal dev server: `temporal server start-dev` (UI on :8233, gRPC on
:7233).
