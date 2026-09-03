# Design: SQLite → Appwrite TablesDB Migration

Date: 2026-09-04
Status: approved direction (full rewrite, no SQLite remaining)
Decisions logged: minimal-privilege API key (option A); all SQLite-backed data moves to Appwrite Databases (TablesDB).

## 1. Context & problem

9router persists all state in a SQLite file (`DATA_DIR/db/data.sqlite`) via `src/lib/db/`
(adapter chain `better-sqlite3 → node:sqlite → bun:sqlite → sql.js`, 12 repos using raw
SQL through `db.all/get/run/transaction`).

Deployed on Appwrite Sites, the container filesystem is ephemeral: **every redeploy wipes
all data** (providers, OAuth tokens, API keys, combos, settings, password hash, usage).
Current workaround (manual export/import JSON) does not scale.

Appwrite Databases (TablesDB) removes the rate-limit objection: **Server SDK + API key is
exempt from rate limits**, and the platform now offers staged transactions, bulk operations
(≤100 rows/request Free), and atomic increment/decrement — enough to model the existing
workloads.

## 2. Goals / non-goals

**Goals**
- Survive redeploy with zero data loss for config; bounded loss for usage (see §6).
- Hot path (`/v1` requests) adds ≤1 remote write per coalescing window, not per request.
- Public API of `src/lib/db/index.js` (and `@/lib/localDb` shim) unchanged → 40+ call sites,
  dashboard, and existing unit tests (which mock the barrel) untouched.
- Delete every SQLite artifact at the end (driver, adapters, migrations, schema, backup,
  `better-sqlite3` optional dep).

**Non-goals**
- Multi-instance write concurrency (single-instance assumption; conflict retries suffice).
- Real-time cross-instance cache invalidation (TTL only).
- Migrating `usageDb.js` — it is a pure re-export shim, nothing to migrate.
- Removing `DATA_DIR` — still hosts `machine-id`, `auth/cli-secret`, and log files.

## 3. Architecture

```
src/lib/db/
├── appwrite/
│   ├── client.js      # lazy singleton: node-appwrite Client + TablesDB from env
│   ├── tables.js      # thin helpers: list/get/create/upsert/delete/bulk + txRun(retry)
│   └── coalescer.js   # write-behind buffer for usage/requestDetails (flush every 2s)
├── cache.js           # TTL in-memory: get(key, ttlMs, loader), invalidate(key)
├── helpers/           # jsonCol.js kept; kvStore.js/metaStore.js → TablesDB-backed
├── repos/*            # same exported functions, internals rewritten
├── index.js           # barrel unchanged (exportDb/importDb reimplemented on TablesDB)
└── paths.js, version.js, dataDir  # kept (non-SQLite concerns)
```

- **New dependency**: `node-appwrite` in `dependencies` (Sites prod install skips devDeps).
- **Lazy init everywhere**: `next build` runs page-data collection; no module may touch the
  network at import time. First DB call constructs the client.
- **Env contract** (site variables; `APPWRITE_API_KEY` already created as secret):
  - `APPWRITE_ENDPOINT=https://sgp.cloud.appwrite.io/v1`
  - `APPWRITE_PROJECT_ID=6a469ecf0019c02577b9`
  - `APPWRITE_DATABASE_ID=router9`
  - `APPWRITE_API_KEY` (secret; scopes: databases.read, tablesdb.read/write — minimal)
- Missing env at runtime → clear thrown error naming the missing var (no silent fallback).

## 4. Schema — database `router9`, 11 tables

Row-ID rules: ≤36 chars, `[a-zA-Z0-9._-]`. Hashed IDs = `sha256(...).hex.slice(0,32)`.
All tables: row security off (server-key access only). JSON payloads live in `data`
`mediumtext` columns (4 MB cap ≫ current 5 KB truncation limit).

| table | row $id | typed/indexed columns | blob |
|---|---|---|---|
| `settings` | `main` | — | `data` |
| `api_keys` | uuid | `key` varchar(64) **unique**, `name` varchar(255), `machineId` varchar(64), `isActive` boolean, `createdAt` datetime | — |
| `connections` | uuid | `provider` varchar(128), `authType` varchar(32), `name` varchar(255), `email` varchar(255), `priority` integer, `isActive` boolean, `createdAt`/`updatedAt` datetime | `data` |
| `provider_nodes` | uuid | `type` varchar(32), `name` varchar(255) | `data` |
| `proxy_pools` | uuid | `isActive` boolean, `testStatus` varchar(16) | `data` |
| `combos` | uuid | `name` varchar(128) **unique**, `kind` varchar(16) | `models` (mediumtext) |
| `kv` | hash(`scope\|key`) | `scope` varchar(32), `key` varchar(255), composite **unique** (`scope`,`key`) | `value` |
| `meta` | = key | `num` integer (counters only) | `value` |
| `usage_history` | hash(dedup tuple) | `timestamp` datetime, `provider` varchar(64), `model` varchar(255), `connectionId` varchar(64), `endpoint` varchar(64), `promptTokens`/`completionTokens` integer, `cost` float, `status` varchar(16) | `tokens`, `meta` |
| `usage_daily` | = dateKey (`YYYY-MM-DD`) | `dateKey` varchar(10) unique | `data` (aggregated day JSON) |
| `request_details` | `rd-` + hash(generateDetailId) (≤36; original id kept in `data`) | `timestamp` datetime, `provider` varchar(64), `model` varchar(255), `connectionId` varchar(64), `status` varchar(16) | `data` (full record JSON) |

`disabledModels` stays inside `kv` (scope `disabledModels`) — matches current code.
Indexes: one per queried column/combo listed above (key indexes; unique where marked).

## 5. Repo mapping patterns

- **Config repos** (settings, apiKeys, connections, nodes, proxyPools, combos, kv/alias/
  pricing/disabledModels, meta): direct 1:1. `db.get(byId)` → `getRow`; `db.all(ORDER BY)`
  → `listRows` + in-memory sort (datasets <500 rows; preserves current NULL-priority sort
  semantics); `reorderProviderConnections` → `updateRows` loop (≤50 ops).
- **`validateApiKey`** → `listRows(Query.equal('key', …))` → cached 30 s + invalidated on
  key create/update/delete.
- **`kv` upserts** → `upsertRow` with hashed `$id`.
- **`disableModels`/`enableModels` RMW** → `txRun` (§6).
- **`exportDb`/`importDb`** (Profile backup): read all 11 tables → same JSON shape as today;
  import = wipe (`deleteRows` per table) + `upsertRows` in ≤100-row batches.

## 6. Usage & request details (write-heavy path)

**Write-behind coalescer** (`appwrite/coalescer.js`), replacing per-request SQL writes:
- `saveRequestUsage` / `saveRequestDetail` push into an in-memory buffer (dedup by hashed
  `$id` happens here too) and return immediately — same fire-and-forget semantics as today.
- A single flusher (every 2 s, or at 100 buffered rows, or on shutdown handlers) applies:
  1. `upsertRows` for `usage_history` / `request_details` (≤100/request bulk, atomic
     all-or-nothing per docs). Upsert (not create) keeps replays idempotent: same hashed
     `$id` → same row overwritten, no batch failure on duplicates.
  2. One `usage_daily` read-modify-write transaction per affected dateKey (stages: get →
     merge all buffered entries via existing `aggregateEntryToDay` → upsert → `increment`
     `num` on meta row `lifetime_requests`). Existing aggregation code is reused verbatim.
- Flush failure → log + re-queue once **only if nothing was applied** (first call failed).
  If the history bulk succeeded but the daily tx failed, the delta is logged and dropped
  (at-most-once): prevents double-counting daily aggregates. Bounded loss: ≤2 s of stats,
  never config.
- `request_details` pruning (maxRecords): after flush, `listRows` total → if over, fetch
  oldest overflow (`orderAsc timestamp`, limit) → `deleteRows` by ids.
- `usage_history` retention: hourly interval deletes rows older than 90 days
  (`deleteRows` + `Query.lessThan('timestamp', cutoff)`, looped while matched).
- Reads (`getUsageStats`, `getChartData`, `getRecentLogs`, `getRequestDetails`):
  - `usage_daily` rows for 7d/30d/60d/all → 1 listRows (≤60 rows).
  - today/24h raw paths → paginate `listRows` (100/page, cap 5 pages, TTL cache 5 s).
  - `getDistinctProviders` → derive from cached `request_details` list (≤200 rows).
  - `recentRing` (in-memory 50) stays as-is; initialized from one `listRows` on first use.

**Concurrency**: `txRun` = `createTransaction` → stage ops → commit; on conflict error,
refetch + re-stage, max 3 attempts with 50/100/200 ms backoff. Single-instance + coalescer
makes contention rare; VPS+Sites dual-writer is explicitly out of scope (last-writer-wins
per flush).

## 7. Caching & hot path

`cache.js`: `Map<key,{v,exp}>`, `get(key, ttl, loader)`, `invalidate(key|prefix)`.

| data | TTL | invalidation |
|---|---|---|
| settings | 5 s | own writes |
| connections list | 15 s | own writes |
| apiKeys (validate) | 30 s | key CRUD |
| combos + aliases + kv | 15 s | own writes |
| pricing | 60 s | own writes |

Worst case per `/v1` request after cache: 0 reads + 1 buffered write → **no added upstream
latency**. Cold cache first request: ≤4 parallel listRows (~50-150 ms same-region).

## 8. Provisioning, seeding, rollout

- `scripts/provision-appwrite-db.mjs` (idempotent): creates database + 11 tables + columns +
  indexes via SDK. Run once locally with env from `.env` (`npm run db:provision`).
- Seed from existing data: `scripts/seed-appwrite-db.mjs <backup.json>` consumes the current
  Profile-export JSON format (no SQLite needed) → bulk upserts. Run once against the VPS
  export.
- Site variables `APPWRITE_ENDPOINT/PROJECT_ID/DATABASE_ID` created via MCP (non-secret);
  `APPWRITE_API_KEY` already stored as secret. Effective on next deploy.

## 9. Deletion list (end state — zero SQLite)

`driver.js`, `adapters/*` (4 files), `migrations/*`, `schema.js`, `migrate.js`, `backup.js`,
`better-sqlite3` from `optionalDependencies`; `DATA_DIR`-related code kept.
`paths.js` kept (machine-id, cli-secret, logs).

## 10. Phases

| phase | content | exit check |
|---|---|---|
| P1 | deps + `appwrite/*` + `cache.js` + provision script + unit tests | `db:provision` creates schema in project |
| P2 | 10 config repos + kv/meta helpers + exportDb/importDb on TablesDB | dashboard CRUD works against cloud; unit tests green |
| P3 | usage + requestDetails + coalescer; delete SQLite files; seed script | usage/chart/logs pages correct |
| P4 | env vars live, deploy, seed VPS export, verify | **redeploy → everything survives** |

## 11. Testing

- Existing vitest suite mocks the barrel → must stay green (API unchanged).
- New unit tests: `cache.js`, `tables.js` (mocked TablesDB service), coalescer flush
  batching/dedup, `txRun` conflict-retry, provision script (dry-run mode).
- Manual verification per phase on `zmxrouter.appwrite.network` (test-model green, usage
  chart, logs pagination, export/import round-trip, login after redeploy).

## 12. Risks & mitigations

| risk | mitigation |
|---|---|
| Sites request timeout (15 s) during long flushes | flusher runs detached from request; bulk ≤100 rows |
| `usage_daily` commit conflicts under burst | coalescer serializes per instance; txRun retry ×3 |
| Crash loses ≤2 s of usage buffer | acceptable for stats; config writes are synchronous |
| Free-plan row/storage caps (usage_history) | 90-day retention prune; request_details maxRecords already exists |
| Build-time network calls | lazy client; no import-time I/O; build log check |
| API key leak | stored as site **secret**; rotate after migration (user action) |
| Outage of Appwrite API → 9router read-only/broken writes | cache TTL keeps reads alive briefly; writes fail-soft with logged error (same as current disk errors) |

## 13. Rollback

Phases are separate commits; P1-P3 keep SQLite deletable-last, so `git revert` to the prior
phase restores SQLite operation (data written only to TablesDB meanwhile must be re-imported
via Profile export). Provisioned TablesDB data is inert until code deploys.
