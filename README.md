# Hotel Offer Orchestrator

Aggregates overlapping hotel offers from two suppliers, deduplicates them by
hotel name keeping the cheaper price, caches the result, and serves price-range
queries filtered **inside Redis**.

Orchestration runs on [Temporal](https://temporal.io/): the two supplier calls
fan out in parallel, and if one supplier is down the request still succeeds with
the other supplier's offers.

**Stack:** Node.js 20 · TypeScript (strict) · Express · Temporal.io · Redis ·
Docker Compose

---

## Contents

- [Architecture](#architecture)
- [Why Temporal](#why-temporal)
- [Why a Redis sorted set](#why-a-redis-sorted-set)
- [Prerequisites](#prerequisites)
- [Quickstart with Docker](#quickstart-with-docker)
- [Local development without Docker](#local-development-without-docker)
- [API reference](#api-reference)
- [Interactive API docs (Swagger)](#interactive-api-docs-swagger)
- [How in-Redis filtering works](#how-in-redis-filtering-works)
- [How graceful degradation works](#how-graceful-degradation-works)
- [Health checks](#health-checks)
- [Running the tests](#running-the-tests)
- [Temporal UI](#temporal-ui)
- [Postman collection](#postman-collection)
- [Configuration](#configuration)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)

---

## Architecture

```mermaid
flowchart TD
    Client([Client])

    subgraph api["app-api container"]
        Express["Express API<br/>GET /api/hotels"]
        TClient["Temporal client"]
        Mocks["Mock supplier routes<br/>/supplierA/hotels · /supplierB/hotels"]
    end

    subgraph temporal["Temporal server"]
        Queue[["Task queue: hotel-offers"]]
    end

    subgraph worker["app-worker container"]
        WF["getHotelsWorkflow(city)"]
        ActA["fetchSupplierA"]
        ActB["fetchSupplierB"]
        Dedup["dedupeAndSelectBest<br/>pure, runs in the workflow"]
        Save["saveToRedis"]
    end

    Redis[("Redis<br/>ZSET hotels:{city}<br/>score = price")]

    Client -->|"GET /api/hotels?city=delhi"| Express
    Express --> TClient
    TClient -->|start workflow| Queue
    Queue --> WF

    WF -->|in parallel| ActA
    WF -->|in parallel| ActB
    ActA -->|HTTP| Mocks
    ActB -->|HTTP| Mocks

    ActA -->|offers| Dedup
    ActB -->|offers| Dedup
    Dedup --> Save
    Save -->|"DEL + ZADD + EXPIRE (MULTI)"| Redis

    Dedup -.->|deduplicated list| TClient
    TClient -.->|JSON response| Client

    Express -->|"minPrice / maxPrice:<br/>ZRANGEBYSCORE hotels:{city} min max"| Redis
    Redis -.->|matching offers only| Express
```

Two things to read off the diagram:

- **The unfiltered path goes through Temporal**, and every side effect —
  supplier HTTP, the Redis write — happens inside an activity. Only the pure
  `dedupeAndSelectBest` runs in workflow code.
- **The filtered path reads Redis directly** from the API. That is not workflow
  code, so determinism does not apply, and routing a read back through Temporal
  would add a round trip for nothing. If the city is not cached yet, the API
  runs the workflow first (to populate Redis) and then issues the same
  `ZRANGEBYSCORE`.

### Why Temporal

The task is "call two services in parallel, merge, persist" — which a
`Promise.all` in a request handler could do in ten lines. Temporal earns its
place when that request stops being the happy path:

- **Retries are declarative, not hand-rolled.** Each supplier activity retries
  3× with exponential backoff from a policy object. A 4xx is marked
  non-retryable, because retrying a malformed request cannot help. No retry
  loops, no bespoke backoff, no timers in application code.
- **Partial failure has somewhere to live.** "One supplier down should still
  return results, both down should fail" is orchestration logic. In a plain
  handler it becomes nested try/catch around a `Promise.allSettled`; in a
  workflow it is linear code that reads like the requirement.
- **Every run is inspectable after the fact.** When a request returns 6 offers
  instead of 8, the Temporal UI shows exactly which activity failed, each retry
  attempt, and the inputs and outputs — without reproducing anything locally.
- **A crash mid-flight is recoverable.** Workflow state is durable. If the
  worker dies between fetching suppliers and writing to Redis, Temporal replays
  the workflow on another worker from its event history rather than losing the
  request.
- **The API and the orchestration scale separately.** They are two processes
  from one image; supplier latency is absorbed by workers, not by Express event
  loops.

The cost is honest: one more moving part (a Temporal server and its datastore),
and workflow code must stay deterministic — which is precisely why all I/O is
pushed into activities.

### Why a Redis sorted set

The requirement is that price filtering happens _inside_ Redis, not by loading
the catalogue into Node and filtering there. A sorted set is the data structure
that makes that a one-liner:

```
ZADD hotels:delhi 4950 '{"name":"Holtin",...}'     # score = price
ZRANGEBYSCORE hotels:delhi 4000 9000               # the filter itself
```

- **The score _is_ the filter key.** Price range queries are the native
  operation on a ZSET — `O(log N + M)` for M results, rather than `O(N)` plus
  transferring every offer to the app just to discard most of them.
- **Members are the finished offers.** Storing the serialized `HotelOffer` as
  the member means a range query returns complete results with no second lookup
  or hydration step.
- **Results arrive price-ordered for free**, which is the natural order for a
  price-range query.
- **Set semantics prevent duplicates.** Member identity is the exact string, so
  a re-save cannot produce two entries for the same hotel — as long as
  serialization is stable, which `serializeOffer` guarantees by writing keys in
  a fixed order.

Alternatives considered: a plain `SET`/`GET` of a JSON blob would force
filtering in JavaScript (the thing the requirement rules out), and a `HASH`
gives O(1) lookup by name but no range query at all.

---

## Prerequisites

**With Docker (recommended)** — nothing else is needed:

| Tool           | Version                                     |
| -------------- | ------------------------------------------- |
| Docker Engine  | 20.10+                                      |
| Docker Compose | v2 (`docker compose`, not `docker-compose`) |

**Without Docker**, additionally:

| Tool         | Version                                             |
| ------------ | --------------------------------------------------- |
| Node.js      | 20+ (uses global `fetch` and `AbortSignal.timeout`) |
| npm          | 9+                                                  |
| Redis        | 7+                                                  |
| Temporal CLI | for `temporal server start-dev`                     |

---

## Quickstart with Docker

```bash
git clone <repo-url> && cd hotel-offer-orchestrator
docker compose up --build
```

That is the whole setup — no migrations, no seeding, no manual namespace
creation. Compose builds the app image, starts Postgres, Redis, the Temporal
server and the Temporal UI, waits for each to pass a healthcheck, and only then
starts the API and the worker. A cold start takes about 15 seconds.

```bash
# the deduplicated catalogue
curl 'http://localhost:3000/api/hotels?city=delhi'

# filtered inside Redis
curl 'http://localhost:3000/api/hotels?city=delhi&minPrice=4000&maxPrice=9000'

# live dependency probes
curl 'http://localhost:3000/health'
```

| Service     | URL                   |
| ----------- | --------------------- |
| API         | http://localhost:3000 |
| Temporal UI | http://localhost:8080 |
| Redis       | localhost:6379        |

Stop with `docker compose down`, or `docker compose down -v` to drop the Redis
and Postgres volumes too.

> **A host port is already in use?** Every published port is overridable. Copy
> `.env.example` to `.env` and set `API_HOST_PORT`, `TEMPORAL_UI_PORT`,
> `TEMPORAL_GRPC_PORT` or `REDIS_HOST_PORT`. Compose reads `.env` automatically.

---

## Local development without Docker

Four terminals. The API hosts the mock supplier routes, which is why the worker
needs to be told where to find them.

```bash
# 0. dependencies
npm install

# 1. infrastructure
temporal server start-dev              # Temporal on :7233, its own UI on :8233
docker run --rm -d -p 6379:6379 redis:7-alpine

# 2. API (terminal 1)
SUPPLIER_A_URL=http://localhost:3000/supplierA/hotels \
SUPPLIER_B_URL=http://localhost:3000/supplierB/hotels \
npm run dev

# 3. Temporal worker (terminal 2)
SUPPLIER_A_URL=http://localhost:3000/supplierA/hotels \
SUPPLIER_B_URL=http://localhost:3000/supplierB/hotels \
npm run dev:worker

# 4. end-to-end smoke test (terminal 3)
npm run verify
```

`npm run verify` runs the workflow for `delhi`, `mumbai` and an unknown city and
asserts the expected winners — it exits non-zero if anything drifts.

Everything else defaults to `localhost:7233` and `redis://localhost:6379`, so no
other configuration is needed.

### npm scripts

| Script                 | Does                                     |
| ---------------------- | ---------------------------------------- |
| `npm run dev`          | API with hot reload (tsx watch)          |
| `npm run dev:worker`   | Temporal worker with hot reload          |
| `npm run build`        | Compile TypeScript to `dist/`            |
| `npm run start:api`    | Run the compiled API                     |
| `npm run start:worker` | Run the compiled worker                  |
| `npm test`             | Unit + integration tests (vitest)        |
| `npm run lint`         | ESLint (type-aware)                      |
| `npm run format`       | Prettier, write                          |
| `npm run typecheck`    | `tsc --noEmit`                           |
| `npm run verify`       | End-to-end check against a running stack |

---

## API reference

### `GET /api/hotels?city={city}`

Runs the Temporal workflow: both suppliers are called in parallel, the results
are deduplicated by hotel name keeping the cheaper offer, and the list is cached
in Redis before being returned.

**Request**

```bash
curl 'http://localhost:3000/api/hotels?city=delhi'
```

**Response** `200 OK`

```json
[
  { "name": "Andaz Delhi", "price": 10500, "supplier": "Supplier B", "commissionPct": 10 },
  { "name": "Bloomrooms Janpath", "price": 3100, "supplier": "Supplier A", "commissionPct": 18 },
  { "name": "Holtin", "price": 4950, "supplier": "Supplier B", "commissionPct": 9 },
  { "name": "Hyatt Regency", "price": 7250, "supplier": "Supplier B", "commissionPct": 13 },
  { "name": "Leela Palace", "price": 9800, "supplier": "Supplier A", "commissionPct": 15 },
  { "name": "Radison", "price": 6100, "supplier": "Supplier A", "commissionPct": 10 },
  { "name": "Taj Mahal Hotel", "price": 11900, "supplier": "Supplier B", "commissionPct": 7 },
  { "name": "The Imperial", "price": 8700, "supplier": "Supplier A", "commissionPct": 11 }
]
```

Six hotels from each supplier, four names overlapping, merging to eight offers:

| Hotel              | Supplier A | Supplier B | Winner                                  |
| ------------------ | ---------- | ---------- | --------------------------------------- |
| Holtin             | 5200       | **4950**   | B — cheaper                             |
| Radison            | **6100**   | 6400       | A — cheaper                             |
| Leela Palace       | **9800**   | 9800       | A — exact tie, broken deterministically |
| Taj Mahal Hotel    | 12400      | **11900**  | B — cheaper                             |
| The Imperial       | 8700       | —          | A only                                  |
| Bloomrooms Janpath | 3100       | —          | A only                                  |
| Hyatt Regency      | —          | 7250       | B only                                  |
| Andaz Delhi        | —          | 10500      | B only                                  |

Names are matched trimmed and case-insensitively. An exact price tie resolves to
Supplier A, independent of argument order. Output is sorted by name, so the same
query always returns the same bytes — which Temporal replay requires and the
tests depend on.

`mumbai` is also populated. Any other city returns `[]`.

### `GET /api/hotels?city={city}&minPrice={min}&maxPrice={max}`

Same endpoint, filtered by price **inside Redis**. Both bounds are inclusive and
either may be omitted.

**Request**

```bash
curl 'http://localhost:3000/api/hotels?city=delhi&minPrice=4000&maxPrice=9000'
```

**Response** `200 OK`

```json
[
  { "name": "Holtin", "price": 4950, "supplier": "Supplier B", "commissionPct": 9 },
  { "name": "Hyatt Regency", "price": 7250, "supplier": "Supplier B", "commissionPct": 13 },
  { "name": "Radison", "price": 6100, "supplier": "Supplier A", "commissionPct": 10 },
  { "name": "The Imperial", "price": 8700, "supplier": "Supplier A", "commissionPct": 11 }
]
```

### `GET /health`

See [Health checks](#health-checks).

### `GET /api-docs` · `GET /api-docs.json`

See [Interactive API docs](#interactive-api-docs-swagger).

### `GET /supplierA/hotels?city={city}` · `GET /supplierB/hotels?city={city}`

The mock supplier feeds, returning raw records before normalization.

**Response** `200 OK`

```json
[{ "hotelId": "A-DEL-001", "name": "Holtin", "price": 5200, "city": "delhi", "commissionPct": 12 }]
```

Two test switches: `?delayMs=1500` simulates latency (makes the parallel fan-out
visible), and `?fail=1` returns 503 to exercise degradation.

### Errors

Every error — 400, 404, 5xx alike — uses one shape:

```json
{
  "error": "invalid_price_range",
  "message": "minPrice must be less than or equal to maxPrice",
  "details": { "min": 9000, "max": 4000 }
}
```

| Condition                          | Status | `error`                 |
| ---------------------------------- | ------ | ----------------------- |
| `city` missing or empty            | 400    | `city_required`         |
| Bound not a number, or negative    | 400    | `invalid_price`         |
| `minPrice > maxPrice`              | 400    | `invalid_price_range`   |
| Unknown route                      | 404    | `not_found`             |
| Both suppliers unavailable         | 502    | `suppliers_unavailable` |
| Workflow failed for another reason | 502    | `workflow_failed`       |
| Redis unreachable                  | 503    | `redis_unavailable`     |
| Temporal unreachable               | 503    | `temporal_unavailable`  |

An unknown city is **not** an error — it returns `200 []`.

Every response carries an `x-request-id` header (reused if the client sends
one), and that id appears in every log line for the request.

---

## Interactive API docs (Swagger)

Swagger UI is served by the API itself — no extra container, no separate build
step.

|                          |                                     |
| ------------------------ | ----------------------------------- |
| Interactive UI           | http://localhost:3000/api-docs      |
| Raw OpenAPI 3.0 document | http://localhost:3000/api-docs.json |

Every endpoint is documented with its parameters, response schemas and
realistic examples, grouped under **Hotels**, **Health** and
**Suppliers (mock)**. **Try it out** works against the running instance: the
server entry is built from the configured `PORT`, so hitting
`GET /api/hotels?city=delhi` in the browser returns the real deduplicated list.

The contract lives in one typed object, `src/api/openapi.ts`, rather than in
JSDoc annotations spread across route files — annotations sit next to code that
changes for unrelated reasons and drift out of sync silently. Typing it as
`OpenAPIV3.Document` makes a malformed spec a compile error, and
`test/openapi.test.ts` fails if a `$ref` dangles or a schema stops matching the
TypeScript type it describes.

Feed the raw document to other tooling directly:

```bash
curl -s http://localhost:3000/api-docs.json | jq '.paths | keys'
```

---

## How in-Redis filtering works

A city's deduplicated catalogue is stored as a sorted set scored by price:

```
hotels:{city}        ZSET     score = price, member = serialized HotelOffer
hotels:{city}:meta   STRING   {"count":8,"savedAt":"2026-09-21T10:17:57.742Z"}
```

Writing (in `saveToRedis`, inside one `MULTI`):

```
MULTI
  DEL    hotels:delhi
  ZADD   hotels:delhi 3100 '{"name":"Bloomrooms Janpath",...}' 4950 '{"name":"Holtin",...}' ...
  EXPIRE hotels:delhi 300
  SET    hotels:delhi:meta '{"count":8,...}' EX 300
EXEC
```

Reading:

```
ZRANGEBYSCORE hotels:delhi 4000 9000
```

Design decisions worth knowing:

- **Replace, never merge.** `DEL` + `ZADD` in one transaction means a reader
  sees the old snapshot or the new one, never half of either — and re-running
  the activity leaves identical state, which is what makes it safe under
  Temporal's at-least-once execution.
- **Stable serialization.** `serializeOffer` writes keys in a fixed order.
  Member identity in a ZSET is the exact string, so an unstable key order would
  let one hotel appear twice.
- **The meta key is the "is this cached?" marker, not the sorted set.** A city
  with no hotels has no sorted set at all, so without a separate marker every
  request for an unknown city would re-run the workflow.
- **Omitted bounds become `-inf` / `+inf`**, passed straight through to Redis.
- **Results are re-sorted by name** after reading, so a list served from Redis
  is byte-identical to one served straight from the workflow. A client cannot
  tell which path answered.
- **Cache miss on a filtered request** runs the workflow for its populating side
  effect, then issues the same `ZRANGEBYSCORE` — hit and miss share one code
  path.

Watch it happen:

```bash
docker compose exec redis redis-cli MONITOR
# then, in another terminal:
curl 'http://localhost:3000/api/hotels?city=delhi&minPrice=4000&maxPrice=9000'
```

```
"exists" "hotels:delhi:meta"
"zrangebyscore" "hotels:delhi" "4000" "9000"
```

---

## How graceful degradation works

The workflow settles each supplier call separately rather than using
`Promise.all`, which would reject on the first failure:

```
fetchSupplierA ──┐
                 ├── both awaited concurrently, each failure caught
fetchSupplierB ──┘
```

| Situation              | Result                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------- |
| Both suppliers respond | Full catalogue — 8 offers for `delhi`                                                   |
| **One supplier fails** | **200 with the other supplier's offers**, warning logged, partial snapshot still cached |
| Both suppliers fail    | `502 suppliers_unavailable`                                                             |
| Redis write fails      | Request fails — see below                                                               |

By the time the workflow sees a rejection, Temporal has already exhausted the
retry policy (3 attempts, exponential backoff), so it genuinely means the
supplier is unavailable.

**Why a Redis failure is treated differently from a supplier failure.** A failed
`saveToRedis` fails the request, rather than returning uncached results. Redis
is the read path for filtered queries, so quietly returning data that was never
cached would let a later `minPrice`/`maxPrice` request serve stale or missing
results with no indication anything was wrong.

**A degraded run still caches its partial snapshot** — it is the best data
available, and the alternative is serving nothing from the filtered endpoint.

Try it. The worker reads supplier URLs from its environment at startup, so point
it at the failing URL and restart it:

```bash
docker compose run --rm \
  -e SUPPLIER_A_URL='http://app-api:3000/supplierA/hotels?fail=1' \
  app-worker node dist/temporal/worker.js
```

```bash
curl 'http://localhost:3000/api/hotels?city=delhi'   # 200, 6 offers, all "Supplier B"
curl 'http://localhost:3000/health'                  # "status": "degraded"
```

---

## Health checks

`GET /health` actively probes **both suppliers, Redis and Temporal** on every
call. Nothing is cached or inferred from config — all four probes run
concurrently, so the endpoint costs one timeout at worst.

```bash
curl 'http://localhost:3000/health'
```

```json
{
  "status": "ok",
  "suppliers": {
    "A": { "status": "up", "latencyMs": 9 },
    "B": { "status": "up", "latencyMs": 10 }
  },
  "redis": { "status": "up", "latencyMs": 3 },
  "temporal": { "status": "up", "latencyMs": 14 },
  "checkedAt": "2026-09-21T10:17:57.742Z",
  "uptimeSeconds": 21
}
```

A failing dependency carries the reason:

```json
"A": { "status": "down", "latencyMs": 10, "error": "HTTP 503" }
```

| `status`   | HTTP | Meaning                                           |
| ---------- | ---- | ------------------------------------------------- |
| `ok`       | 200  | Everything reachable                              |
| `degraded` | 200  | One supplier down — still serving, from the other |
| `down`     | 503  | Redis or Temporal down, or _both_ suppliers down  |

`degraded` deliberately stays **200**. Losing one supplier is exactly the
failure the workflow is designed to absorb, so returning 503 would pull a
perfectly capable container out of rotation. Compose uses this endpoint as the
`app-api` healthcheck.

---

## Running the tests

```bash
npm test
```

| Suite                                   | Covers                                                                                                                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/dedupe.test.ts`                   | Cheaper wins in both directions, exact tie resolving to Supplier A regardless of argument order, A-only and B-only passthrough, empty inputs, case/whitespace matching, commission carried from the winner, deterministic ordering, and the full delhi fixture |
| `test/repository.test.ts`               | Offer serialization round-trip, fixed key order, rejection of malformed members                                                                                                                                                                                |
| `test/redis-filter.integration.test.ts` | The real `ZRANGEBYSCORE` path against a live Redis                                                                                                                                                                                                             |

The integration test **skips itself** when no Redis is reachable, so `npm test`
is green on a machine with nothing running. To include it:

```bash
docker compose up -d redis
npm test

# or point it somewhere else
REDIS_URL=redis://localhost:6381 npm test
```

It uses its own key prefix (`test-hotels:`) and cleans up after itself, so it is
safe against a shared Redis. It asserts inclusive bounds, `-inf`/`+inf`
handling, empty ranges, no duplicate names, replace-not-append on refresh, TTLs
on both keys, and that a city with no hotels is still marked as cached.

Also available: `npm run lint`, `npm run typecheck`, and `npm run verify` (an
end-to-end check that needs the whole stack running).

---

## Temporal UI

http://localhost:8080 — mapped from the `temporal-ui` service.

Open **Workflows**, select a `hotels:{city}` run, and the Event History shows
the whole execution: both supplier activities starting concurrently, every retry
attempt with its input and output, the `saveToRedis` call, and the workflow
result. When a request comes back with 6 offers instead of 8, this is where you
see which activity failed and why — no local reproduction needed.

Each run's memo carries the `requestId` of the HTTP request that started it, and
the API logs the `workflowId` and `runId` it started, so you can move between
logs and UI in either direction.

Running without Docker, `temporal server start-dev` serves its own UI on
http://localhost:8233.

---

## Postman collection

`postman/HotelOfferOrchestrator.postman_collection.json` (Collection v2.1) with
`postman/HotelOfferOrchestrator.postman_environment.json`.

Import both into Postman and select the environment, or run it headless:

```bash
npx newman run postman/HotelOfferOrchestrator.postman_collection.json \
  -e postman/HotelOfferOrchestrator.postman_environment.json

# different port?
npx newman run postman/HotelOfferOrchestrator.postman_collection.json \
  --env-var baseUrl=http://localhost:3100
```

44 assertions across the valid city, both price-filter paths, a city with no
results, health, both raw supplier feeds, and a documented supplier-outage
scenario. Every request returning offers asserts the response shape and that
**no hotel name appears twice**. Run the requests in order — request 1 populates
the cache request 2 reads.

---

## Configuration

Everything is environment driven with working defaults; nothing is hardcoded and
no secrets live in the repo. See `.env.example`.

| Variable                            | Default                     | Purpose                                           |
| ----------------------------------- | --------------------------- | ------------------------------------------------- |
| `PORT`                              | `3000`                      | API port inside the container                     |
| `LOG_LEVEL`                         | `debug` (`info` in compose) | pino level                                        |
| `REDIS_URL`                         | `redis://localhost:6379`    | Redis connection                                  |
| `REDIS_KEY_PREFIX`                  | `hotels`                    | Key namespace                                     |
| `REDIS_TTL_SECONDS`                 | `300`                       | How long a city's snapshot is cached              |
| `REDIS_COMMAND_TIMEOUT_MS`          | `2000`                      | Upper bound on a single Redis command             |
| `TEMPORAL_ADDRESS`                  | `localhost:7233`            | Temporal frontend                                 |
| `TEMPORAL_NAMESPACE`                | `default`                   | Namespace                                         |
| `TEMPORAL_TASK_QUEUE`               | `hotel-offers`              | Queue shared by API and worker                    |
| `TEMPORAL_START_TIMEOUT_MS`         | `10000`                     | Bound on starting a workflow before returning 503 |
| `SUPPLIER_A_URL` / `SUPPLIER_B_URL` | localhost supplier routes   | Supplier endpoints                                |
| `SUPPLIER_TIMEOUT_MS`               | `5000`                      | Per-supplier request timeout                      |
| `SUPPLIER_HEALTH_TIMEOUT_MS`        | `2000`                      | Shorter budget for `/health` probes               |
| `SHUTDOWN_GRACE_MS`                 | `10000`                     | Grace period before a forced exit                 |

Compose-only host port overrides: `API_HOST_PORT`, `TEMPORAL_UI_PORT`,
`TEMPORAL_GRPC_PORT`, `REDIS_HOST_PORT`.

---

## Project layout

```
src/
  api/          Express app, middleware, routes, error mapping, health probes,
                openapi.ts (the API contract, single source of truth)
  temporal/     activities, workflow, worker, client, connect-with-retry
  suppliers/    mock supplier fixtures and their Express routes
  redis/        connection + sorted-set repository
  domain/       framework-free types and the pure dedup function
  config/       env parsing with defaults — the only place reading process.env
  scripts/      verify-workflow end-to-end check
  shutdown.ts   shared graceful-shutdown plumbing
  logger.ts     pino
test/           vitest suites
postman/        collection + environment
```

`domain/` depends on nothing, which is what lets `dedupeAndSelectBest` run
safely inside workflow code. `api/` wires things together; nothing imports
upward into it.

**Operational behaviour.** Both processes handle SIGTERM/SIGINT: they stop
taking new work, drain in flight, close connections in order, and exit 0. A
second signal exits immediately; a hung dependency is force-exited after
`SHUTDOWN_GRACE_MS`. On startup, the Temporal client retries with exponential
backoff, because the frontend accepts gRPC slightly before the default namespace
finishes registering — but on the request path that retry is capped, so a
request fails fast with 503 instead of hanging while reconnection continues in
the background.

---

## Troubleshooting

**`Bind for 0.0.0.0:3000 failed: port is already allocated`**
Another process holds the port. Copy `.env.example` to `.env` and change
`API_HOST_PORT` (and/or `TEMPORAL_UI_PORT`, `TEMPORAL_GRPC_PORT`,
`REDIS_HOST_PORT`). Check what is holding it with `ss -ltnp | grep 3000`.

**`dependency failed to start: container ... is unhealthy`**
Temporal takes longest on a cold start because it creates its schema. Inspect
with `docker compose logs temporal`. If Postgres was interrupted mid-setup, a
clean slate fixes it: `docker compose down -v && docker compose up --build`.

**Code changes are not showing up in Docker**
`docker compose up --build` does not always recreate containers whose image was
rebuilt. Use `docker compose up --build --force-recreate`.

**`503 temporal_unavailable`**
The API cannot reach Temporal. `docker compose ps` should show `temporal` as
healthy; `curl localhost:3000/health` reports it per-dependency. The API
reconnects on its own once Temporal returns — no restart needed.

**`503 redis_unavailable`**
Redis is unreachable. Check `docker compose ps redis` and
`docker compose logs redis`. The filtered endpoint depends on Redis; the
unfiltered one does too, because the workflow caches before returning.

**`/health` says `degraded`**
One supplier is failing — `suppliers.A.error` or `suppliers.B.error` says why.
This is expected behaviour, not an outage: requests still succeed with the other
supplier's offers.

**The price filter returns `[]` but the city has hotels**
The range may genuinely contain nothing — the `delhi` prices jump from 4950 to
6100, so `minPrice=5000&maxPrice=6000` is correctly empty. Confirm with
`docker compose exec redis redis-cli ZRANGE hotels:delhi 0 -1 WITHSCORES`.

**Worker keeps calling a supplier I thought I changed**
`SUPPLIER_A_URL` / `SUPPLIER_B_URL` are read once at startup. Restart the worker
after changing them.

**`npm test` skips the integration test**
That is by design when no Redis is reachable. Start one
(`docker compose up -d redis`) or point the test at yours with `REDIS_URL=...`.

**Native module errors from `@temporalio/core-bridge`**
It ships prebuilt binaries for glibc. The image is Debian slim for this reason —
switching it to Alpine will break the worker.
