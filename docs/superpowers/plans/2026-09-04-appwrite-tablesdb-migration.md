# SQLite → Appwrite TablesDB Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the entire SQLite layer (`src/lib/db/driver.js` + 12 repos) with Appwrite TablesDB so data survives Appwrite Sites redeploys, with zero changes to the `src/lib/db/index.js` barrel API.

**Architecture:** Remote-first TablesDB + TTL in-memory read cache (hot path `/v1` does 0 extra reads) + write-behind coalescer (2 s flush) for usage/requestDetails. Spec: `docs/superpowers/specs/2026-09-04-appwrite-tablesdb-migration-design.md`.

**Tech Stack:** `node-appwrite` (TablesDB service), existing plain-JS ESM repo pattern, vitest (tests/ package).

## Global Constraints

- Barrel `src/lib/db/index.js` exports must NOT change names/signatures (40+ callers + `@/lib/localDb` shim + tests mock it).
- No import-time network I/O (Next build runs page-data collection). Client init must be lazy.
- Row IDs ≤36 chars `[a-zA-Z0-9._-]`; hashed IDs = `sha256(parts.join("|")).slice(0,32)`.
- Bulk ≤100 rows/request; staged transactions ≤100 ops (Free plan); `txRun` retries conflicts ×3 (50/100/200 ms).
- All env reads through `appwrite/client.js`; missing env → thrown error naming the var.
- `DATA_DIR`/`paths.js` stays (machine-id, cli-secret, logs). `usageDb.js` shim untouched.
- Conventional Commits. Tests run from `tests/` dir: `npx vitest run <file>`.
- Platform note: dev machine is Windows PowerShell — chain commands with `;`, never `&&`.

## File Structure

```
package.json                                    (modify: +node-appwrite, -better-sqlite3, +db:provision script)
.env.example                                    (modify: +APPWRITE_* vars)
src/lib/db/appwrite/client.js                   (create: lazy TablesDB singleton)
src/lib/db/appwrite/tables.js                   (create: row helpers, txRun, hashId)
src/lib/db/cache.js                             (create: TTL cache)
scripts/provision-appwrite-db.mjs               (create: idempotent schema)
scripts/seed-appwrite-db.mjs                    (create: seed from Profile-export JSON)
src/lib/db/repos/settingsRepo.js                (rewrite)
src/lib/db/repos/apiKeysRepo.js                 (rewrite)
src/lib/db/helpers/kvStore.js                   (rewrite)
src/lib/db/helpers/metaStore.js                 (rewrite)
src/lib/db/repos/aliasRepo.js                   (rewrite, imports unchanged)
src/lib/db/repos/pricingRepo.js                 (rewrite, imports unchanged)
src/lib/db/repos/disabledModelsRepo.js          (rewrite)
src/lib/db/repos/connectionsRepo.js             (rewrite)
src/lib/db/repos/nodesRepo.js                   (rewrite)
src/lib/db/repos/proxyPoolsRepo.js              (rewrite)
src/lib/db/repos/combosRepo.js                  (rewrite)
src/lib/db/index.js                             (modify: exportDb/importDb on TablesDB)
src/lib/db/appwrite/coalescer.js                (create: shared 2s flush scheduler)
src/lib/db/repos/usageRepo.js                   (rewrite)
src/lib/db/repos/requestDetailsRepo.js          (rewrite)
DELETE: src/lib/db/driver.js, adapters/*, migrations/*, schema.js, migrate.js, backup.js
tests/unit/aw-infra.test.js                     (create: cache + tables)
tests/unit/aw-config-repos.test.js              (create: settings/keys/kv/connections)
tests/unit/aw-usage.test.js                     (create: coalescer + usageRepo)
docs: CLAUDE.md persistence section, docs/ARCHITECTURE.md
```

---

### Task 1: Dependency + env contract

**Files:** `package.json`, `.env.example`, `.env`

- [ ] **Step 1: add node-appwrite, remove better-sqlite3**

```bash
npm install node-appwrite@latest
npm pkg delete optionalDependencies.better-sqlite3
node -e "const p=require('./package.json');console.log(JSON.stringify(p.dependencies.node_appwrite||p.dependencies['node-appwrite']),JSON.stringify(p.optionalDependencies))"
```
Expected: node-appwrite version printed; optionalDependencies without better-sqlite3 (may be `{}` — then `npm pkg delete optionalDependencies`).

- [ ] **Step 2: .env.example additions** (append under "Cloud sync variables" section):

```bash
# Appwrite TablesDB (replaces SQLite persistence)
# APPWRITE_ENDPOINT=https://sgp.cloud.appwrite.io/v1
# APPWRITE_PROJECT_ID=00000000000000000000
# APPWRITE_DATABASE_ID=router9
# APPWRITE_API_KEY=standard_xxx
```

- [ ] **Step 3: local `.env`** — set real values: `APPWRITE_ENDPOINT=https://sgp.cloud.appwrite.io/v1`, `APPWRITE_PROJECT_ID=6a469ecf0019c02577b9`, `APPWRITE_DATABASE_ID=router9`, `APPWRITE_API_KEY=<the standard_… key the user provided>`. (Never commit `.env`.)

- [ ] **Step 4: commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "feat(db): add node-appwrite dep and APPWRITE_* env contract"
```

---

### Task 2: `appwrite/client.js` + `cache.js` + tests

**Files:** Create `src/lib/db/appwrite/client.js`, `src/lib/db/cache.js`; Test `tests/unit/aw-infra.test.js`

**Interfaces (produced):** `getTables() → Promise<TablesDB>`, `getDatabaseId() → string`, `appwriteConfig() → {endpoint,projectId,apiKey,databaseId}`; `cached(key, ttlMs, loader)`, `invalidate(prefix)`, `invalidateAll()`.

- [ ] **Step 1: write failing test** `tests/unit/aw-infra.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

const tablesMock = { listRows: vi.fn() };
vi.mock("@/lib/db/appwrite/client.js", () => ({
  getTables: vi.fn(async () => tablesMock),
  getDatabaseId: vi.fn(() => "router9"),
  appwriteConfig: vi.fn(() => ({ endpoint: "https://x/v1", projectId: "p", apiKey: "k", databaseId: "router9" })),
}));

describe("cache", () => {
  beforeEach(() => vi.resetModules());
  it("loads once within ttl and reloads after invalidation", async () => {
    const { cached, invalidate } = await import("@/lib/db/cache.js");
    const loader = vi.fn(async () => ({ n: 1 }));
    expect(await cached("k", 10_000, loader)).toEqual({ n: 1 });
    expect(await cached("k", 10_000, loader)).toEqual({ n: 1 });
    expect(loader).toHaveBeenCalledTimes(1);
    invalidate("k");
    expect(await cached("k", 10_000, loader)).toEqual({ n: 1 });
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("tables.listRows", () => {
  beforeEach(() => vi.resetModules());
  it("passes databaseId/tableId and paginates listAllRows", async () => {
    const t = await import("@/lib/db/appwrite/tables.js");
    tablesMock.listRows
      .mockResolvedValueOnce({ total: 150, rows: Array.from({ length: 100 }, (_, i) => ({ $id: String(i) })) })
      .mockResolvedValueOnce({ total: 150, rows: Array.from({ length: 50 }, (_, i) => ({ $id: String(i) })) });
    const rows = await t.listAllRows("kv");
    expect(rows).toHaveLength(150);
    expect(tablesMock.listRows).toHaveBeenCalledTimes(2);
    const first = tablesMock.listRows.mock.calls[0][0];
    expect(first.databaseId).toBe("router9");
    expect(first.tableId).toBe("kv");
  });
  it("getRow returns null on 404", async () => {
    const t = await import("@/lib/db/appwrite/tables.js");
    tablesMock.listRows.mockReset();
    const err = Object.assign(new Error("not found"), { code: 404 });
    tablesMock.getRow = vi.fn().mockRejectedValue(err);
    expect(await t.getRow("settings", "main")).toBeNull();
  });
});
```

- [ ] **Step 2: run** `cd tests; npx vitest run unit/aw-infra.test.js` → **FAIL** (modules missing).

- [ ] **Step 3: implement** `src/lib/db/appwrite/client.js`:

```js
import * as sdk from "node-appwrite";

if (!global._awClient) global._awClient = { tables: null, initPromise: null, logged: false };
const state = global._awClient;

export function appwriteConfig() {
  const endpoint = process.env.APPWRITE_ENDPOINT;
  const projectId = process.env.APPWRITE_PROJECT_ID;
  const apiKey = process.env.APPWRITE_API_KEY;
  const databaseId = process.env.APPWRITE_DATABASE_ID || "router9";
  const missing = Object.entries({ APPWRITE_ENDPOINT: endpoint, APPWRITE_PROJECT_ID: projectId, APPWRITE_API_KEY: apiKey })
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`[DB] Missing env vars: ${missing.join(", ")}`);
  return { endpoint, projectId, apiKey, databaseId };
}

export function getDatabaseId() {
  return appwriteConfig().databaseId;
}

export async function getTables() {
  if (state.tables) return state.tables;
  if (!state.initPromise) {
    state.initPromise = (async () => {
      const { endpoint, projectId, apiKey } = appwriteConfig();
      const client = new sdk.Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
      state.tables = new sdk.TablesDB(client);
      if (!state.logged) { console.log("[DB] Appwrite TablesDB ready"); state.logged = true; }
      return state.tables;
    })();
  }
  return state.initPromise;
}
```

`src/lib/db/cache.js`:

```js
if (!global._dbCache) global._dbCache = new Map();
const store = global._dbCache;

export async function cached(key, ttlMs, loader) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.exp > now) return hit.v;
  const v = await loader();
  store.set(key, { v, exp: now + ttlMs });
  return v;
}

export function invalidate(prefix) {
  for (const k of [...store.keys()]) {
    if (k === prefix || k.startsWith(`${prefix}:`)) store.delete(k);
  }
}

export function invalidateAll() {
  store.clear();
}
```

`src/lib/db/appwrite/tables.js`:

```js
import crypto from "node:crypto";
import * as sdk from "node-appwrite";
import { getTables, getDatabaseId } from "./client.js";

export const Query = sdk.Query;
const PAGE = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function hashId(...parts) {
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

async function ids(tableId) {
  return { databaseId: getDatabaseId(), tableId };
}

function isNotFound(e) {
  return String(e?.code) === "404" || e?.type === "row_not_found";
}

export async function listRows(tableId, queries = []) {
  const tables = await getTables();
  return await tables.listRows({ ...(await ids(tableId)), queries });
}

export async function listAllRows(tableId, queries = [], { maxPages = 50 } = {}) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await listRows(tableId, [...queries, Query.limit(PAGE), Query.offset(out.length)]);
    out.push(...res.rows);
    if (res.rows.length < PAGE) break;
  }
  return out;
}

export async function getRow(tableId, rowId) {
  const tables = await getTables();
  try {
    return await tables.getRow({ ...(await ids(tableId)), rowId });
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

export async function upsertRow(tableId, rowId, data) {
  const tables = await getTables();
  return await tables.upsertRow({ ...(await ids(tableId)), rowId, data });
}

export async function updateRow(tableId, rowId, data) {
  const tables = await getTables();
  return await tables.updateRow({ ...(await ids(tableId)), rowId, data });
}

export async function deleteRow(tableId, rowId) {
  const tables = await getTables();
  try {
    await tables.deleteRow({ ...(await ids(tableId)), rowId });
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

export async function upsertRowsAll(tableId, rows) {
  const tables = await getTables();
  for (let i = 0; i < rows.length; i += PAGE) {
    await tables.upsertRows({ ...(await ids(tableId)), rows: rows.slice(i, i + PAGE) });
  }
}

export async function deleteRowsByQuery(tableId, queries = []) {
  const tables = await getTables();
  let n = 0;
  for (;;) {
    const res = await tables.deleteRows({ ...(await ids(tableId)), queries });
    const done = res.rows?.length ?? 0;
    n += done;
    if (done === 0) break;
  }
  return n;
}

function isConflict(e) {
  return String(e?.code) === "409" || e?.type === "transaction_conflict";
}

// Staged transaction with conflict retry. buildOps receives ctx whose helpers
// stage writes on the current transaction. Reads inside see committed state only.
export async function txRun(buildOps, { retries = 3 } = {}) {
  const tables = await getTables();
  for (let attempt = 1; ; attempt++) {
    const tx = await tables.createTransaction();
    const tid = tx.$id;
    const ctx = {
      getRow: async (tableId, rowId) => {
        try {
          return await tables.getRow({ ...(await ids(tableId)), rowId });
        } catch (e) {
          if (isNotFound(e)) return null;
          throw e;
        }
      },
      upsertRow: async (tableId, rowId, data) =>
        tables.upsertRow({ ...(await ids(tableId)), rowId, data, transactionId: tid }),
      updateRow: async (tableId, rowId, data) =>
        tables.updateRow({ ...(await ids(tableId)), rowId, data, transactionId: tid }),
      createRow: async (tableId, rowId, data) =>
        tables.createRow({ ...(await ids(tableId)), rowId, data, transactionId: tid }),
      deleteRow: async (tableId, rowId) =>
        tables.deleteRow({ ...(await ids(tableId)), rowId, transactionId: tid }),
      increment: async (tableId, rowId, column, value = 1) =>
        tables.incrementRowColumn({ ...(await ids(tableId)), rowId, column, value, transactionId: tid }),
    };
    try {
      await buildOps(ctx);
      await tables.updateTransaction({ transactionId: tid, commit: true });
      return;
    } catch (e) {
      await tables.updateTransaction({ transactionId: tid, rollback: true }).catch(() => {});
      if (attempt >= retries || !isConflict(e)) throw e;
      await sleep(50 * attempt);
    }
  }
}
```

- [ ] **Step 4: run test** → PASS. `cd tests; npx vitest run unit/aw-infra.test.js`

- [ ] **Step 5: commit**

```bash
git add src/lib/db/appwrite src/lib/db/cache.js tests/unit/aw-infra.test.js
git commit -m "feat(db): TablesDB client, row helpers with tx retry, TTL cache"
```

---

### Task 3: Provision script

**Files:** Create `scripts/provision-appwrite-db.mjs`; modify `package.json` scripts.

**Interfaces (produced):** Database `router9` with 11 tables/columns/indexes (idempotent).

- [ ] **Step 1: write script** (loads `.env` itself — 8-line parser, no new dep):

```js
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import * as sdk from "node-appwrite";

// minimal .env loader (KEY=VALUE lines, # comments)
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
  }
}

const client = new sdk.Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT || "")
  .setProject(process.env.APPWRITE_PROJECT_ID || "")
  .setKey(process.env.APPWRITE_API_KEY || "");
const tablesDB = new sdk.TablesDB(client);
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID || "router9";

const V = (key, size) => ({ key, type: "varchar", size, required: false });
const TXT = (key) => ({ key, type: "mediumtext", required: false });
const INT = (key) => ({ key, type: "integer", required: false });
const BIG = (key) => ({ key, type: "bigint", required: false });
const FLT = (key) => ({ key, type: "float", required: false });
const BOOL = (key) => ({ key, type: "boolean", required: false });
const DT = (key) => ({ key, type: "datetime", required: false });

const TABLES = {
  settings: { columns: [TXT("data")], indexes: [] },
  api_keys: {
    columns: [V("key", 64), V("name", 255), V("machineId", 64), BOOL("isActive"), DT("createdAt")],
    indexes: [{ key: "idx_key_unique", type: "unique", attributes: ["key"] }],
  },
  connections: {
    columns: [V("provider", 128), V("authType", 32), V("name", 255), V("email", 255), INT("priority"), BOOL("isActive"), DT("createdAt"), DT("updatedAt"), TXT("data")],
    indexes: [
      { key: "idx_provider", type: "key", attributes: ["provider"] },
      { key: "idx_isActive", type: "key", attributes: ["isActive"] },
    ],
  },
  provider_nodes: {
    columns: [V("type", 32), V("name", 255), DT("createdAt"), DT("updatedAt"), TXT("data")],
    indexes: [{ key: "idx_type", type: "key", attributes: ["type"] }],
  },
  proxy_pools: {
    columns: [BOOL("isActive"), V("testStatus", 16), DT("createdAt"), DT("updatedAt"), TXT("data")],
    indexes: [{ key: "idx_isActive", type: "key", attributes: ["isActive"] }],
  },
  combos: {
    columns: [V("name", 128), V("kind", 16), TXT("models"), DT("createdAt"), DT("updatedAt")],
    indexes: [{ key: "idx_name_unique", type: "unique", attributes: ["name"] }],
  },
  kv: {
    columns: [V("scope", 32), V("key", 255), TXT("value")],
    indexes: [
      { key: "idx_scope", type: "key", attributes: ["scope"] },
      { key: "idx_scope_key_unique", type: "unique", attributes: ["scope", "key"] },
    ],
  },
  meta: { columns: [BIG("num"), TXT("value")], indexes: [] },
  usage_history: {
    columns: [DT("timestamp"), V("provider", 64), V("model", 255), V("connectionId", 64), V("endpoint", 64), INT("promptTokens"), INT("completionTokens"), FLT("cost"), V("status", 16), TXT("tokens"), TXT("meta")],
    indexes: [
      { key: "idx_timestamp", type: "key", attributes: ["timestamp"] },
      { key: "idx_provider", type: "key", attributes: ["provider"] },
      { key: "idx_model", type: "key", attributes: ["model"] },
    ],
  },
  usage_daily: {
    columns: [V("dateKey", 10), TXT("data")],
    indexes: [{ key: "idx_dateKey_unique", type: "unique", attributes: ["dateKey"] }],
  },
  request_details: {
    columns: [DT("timestamp"), V("provider", 64), V("model", 255), V("connectionId", 64), V("status", 16), TXT("data")],
    indexes: [
      { key: "idx_timestamp", type: "key", attributes: ["timestamp"] },
      { key: "idx_provider", type: "key", attributes: ["provider"] },
      { key: "idx_model", type: "key", attributes: ["model"] },
      { key: "idx_status", type: "key", attributes: ["status"] },
    ],
  },
};

function ignoreExists(e) {
  const code = String(e?.code ?? "");
  return code === "409" || /already exists/i.test(e?.message ?? "");
}

async function main() {
  try {
    await tablesDB.createDatabase({ databaseId: DATABASE_ID, name: "router9" });
    console.log(`[provision] database ${DATABASE_ID} created`);
  } catch (e) {
    if (!ignoreExists(e)) throw e;
    console.log(`[provision] database ${DATABASE_ID} exists`);
  }
  for (const [tableId, def] of Object.entries(TABLES)) {
    try {
      await tablesDB.createTable({ databaseId: DATABASE_ID, tableId, name: tableId, columns: def.columns, indexes: def.indexes });
      console.log(`[provision] table ${tableId} created (${def.columns.length} cols, ${def.indexes.length} idx)`);
    } catch (e) {
      if (!ignoreExists(e)) throw e;
      console.log(`[provision] table ${tableId} exists — skipping`);
    }
  }
  console.log("[provision] done");
}

main().catch((e) => { console.error("[provision] FAILED:", e?.message ?? e); process.exit(1); });
```

- [ ] **Step 2: npm script** — `npm pkg set scripts.db:provision="node scripts/provision-appwrite-db.mjs"`

- [ ] **Step 3: run** `npm run db:provision` (needs `.env` from Task 1; retry if network flaky).
Expected: `[provision] done` with 11 tables. Verify in Console → Databases → router9.

- [ ] **Step 4: commit**

```bash
git add scripts/provision-appwrite-db.mjs package.json
git commit -m "feat(db): idempotent TablesDB provision script (11 tables)"
```

---

### Task 4: settingsRepo

**Files:** Rewrite `src/lib/db/repos/settingsRepo.js` (keep `DEFAULT_SETTINGS` lines 1-65 verbatim — only the data-access functions change). Test: extend `tests/unit/aw-config-repos.test.js`.

**Interfaces:** `getSettings()`, `updateSettings(updates)`, `isCloudEnabled()`, `getCloudUrl()`, `exportSettings()`, `mergeWithDefaults(raw)` — signatures unchanged.

- [ ] **Step 1: failing test** `tests/unit/aw-config-repos.test.js` (mock client, not tables, so real helper logic runs):

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

export function makeTablesMock() {
  const rows = new Map(); // tableId -> Map(rowId -> row)
  const t = (id) => { if (!rows.has(id)) rows.set(id, new Map()); return rows.get(id); };
  return {
    _rows: rows,
    listRows: vi.fn(async ({ tableId, queries }) => {
      const all = [...t(tableId).values()];
      const limQ = queries?.find((q) => q.includes('"method":"limit"'));
      const limit = limQ ? Number(JSON.parse(limQ).values[0]) : 25;
      return { total: all.length, rows: all.slice(0, limit) };
    }),
    getRow: vi.fn(async ({ tableId, rowId }) => {
      const r = t(tableId).get(rowId);
      if (!r) throw Object.assign(new Error("not found"), { code: 404 });
      return r;
    }),
    upsertRow: vi.fn(async ({ tableId, rowId, data }) => { t(tableId).set(rowId, { $id: rowId, ...data }); return { $id: rowId, ...data }; }),
    updateRow: vi.fn(async ({ tableId, rowId, data }) => { const cur = t(tableId).get(rowId) ?? {}; t(tableId).set(rowId, { ...cur, ...data }); return t(tableId).get(rowId); }),
    createRow: vi.fn(async ({ tableId, rowId, data }) => { t(tableId).set(rowId, { $id: rowId, ...data }); return { $id: rowId, ...data }; }),
    deleteRow: vi.fn(async ({ tableId, rowId }) => { t(tableId).delete(rowId); }),
    upsertRows: vi.fn(async ({ tableId, rows }) => { for (const r of rows) t(tableId).set(r.$id, r); }),
    deleteRows: vi.fn(async ({ tableId }) => { const n = t(tableId).size; t(tableId).clear(); return { rows: new Array(n) }; }),
    createTransaction: vi.fn(async () => ({ $id: "tx1" })),
    updateTransaction: vi.fn(async () => ({})),
    incrementRowColumn: vi.fn(async ({ tableId, rowId, column, value = 1 }) => {
      const cur = t(tableId).get(rowId) ?? { $id: rowId, num: 0 };
      cur[column] = (cur[column] ?? 0) + value;
      t(tableId).set(rowId, cur);
      return cur;
    }),
  };
}

export const tablesMock = makeTablesMock();

vi.mock("@/lib/db/appwrite/client.js", () => ({
  getTables: vi.fn(async () => tablesMock),
  getDatabaseId: vi.fn(() => "router9"),
  appwriteConfig: vi.fn(() => ({ endpoint: "e", projectId: "p", apiKey: "k", databaseId: "router9" })),
}));
```

Then a describe block:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import "./aw-infra-mocks.js"; // if split; alternatively inline mocks above in this file

describe("settingsRepo", () => {
  beforeEach(async () => {
    tablesMock._rows.clear();
    vi.resetModules();
    const { invalidateAll } = await import("@/lib/db/cache.js");
    invalidateAll();
  });
  it("merges defaults and persists updates", async () => {
    const repo = await import("@/lib/db/repos/settingsRepo.js");
    const s = await repo.getSettings();
    expect(s.requireApiKey).toBe(true);
    await repo.updateSettings({ cloudEnabled: true });
    const s2 = await repo.getSettings();
    expect(s2.cloudEnabled).toBe(true);
    expect((await repo.exportSettings()).cloudEnabled).toBe(true);
  });
});
```

(If vitest `vi.mock` must be top-level: keep mocks + helpers in the same file — final file = mock factory + all describes. Run from `tests/`.)

- [ ] **Step 2: run** → FAIL (repo still imports driver which needs sqlite file; module may throw).

- [ ] **Step 3: rewrite repo** — keep imports minus driver; replace functions:

```js
import { getRow, upsertRow } from "../appwrite/tables.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { cached, invalidate } from "../cache.js";
// ... DEFAULT_SETTINGS unchanged ...

async function readRaw() {
  const row = await getRow("settings", "main");
  return row ? parseJson(row.data, {}) : {};
}

// mergeWithDefaults unchanged (verbatim from current file)

export async function getSettings() {
  return cached("settings", 5000, async () => mergeWithDefaults(await readRaw()));
}

export async function updateSettings(updates) {
  let next;
  await txRun(async (ctx) => {
    const row = await ctx.getRow("settings", "main");
    const current = row ? parseJson(row.data, {}) : {};
    next = { ...current, ...updates };
    await ctx.upsertRow("settings", "main", { data: stringifyJson(next) });
  });
  invalidate("settings");
  return mergeWithDefaults(next);
}
```

`isCloudEnabled`/`getCloudUrl`/`exportSettings` unchanged except imports. Add `import { txRun } from "../appwrite/tables.js"`.

- [ ] **Step 4: run** → PASS.

- [ ] **Step 5: commit** `git commit -m "refactor(db): settingsRepo on TablesDB"`

---

### Task 5: apiKeysRepo

**Files:** Rewrite `src/lib/db/repos/apiKeysRepo.js`.

**Interfaces:** unchanged (`getApiKeys, getApiKeyById, createApiKey, updateApiKey, deleteApiKey, validateApiKey`). Spec: `key` varchar(64), `$id` = uuid.

- [ ] **Step 1: test** (append to `tests/unit/aw-config-repos.test.js`):

```js
describe("apiKeysRepo", () => {
  beforeEach(async () => {
    tablesMock._rows.clear();
    vi.resetModules();
    (await import("@/lib/db/cache.js")).invalidateAll();
  });
  it("creates, validates (cached), updates, deletes", async () => {
    const repo = await import("@/lib/db/repos/apiKeysRepo.js");
    const k = await repo.createApiKey("test");
    expect(k.key.startsWith("sk-")).toBe(true);
    expect(await repo.validateApiKey(k.key)).toBe(true);
    expect(await repo.validateApiKey("nope")).toBe(false);
    await repo.updateApiKey(k.id, { isActive: false });
    expect(await repo.validateApiKey(k.key)).toBe(false);
    await repo.deleteApiKey(k.id);
    expect(await repo.validateApiKey(k.key)).toBe(false);
    expect(await repo.getApiKeyById(k.id)).toBeNull();
  });
});
```

Note `machineId` is required by `createApiKey(name, machineId)` — pass a fixed `"test-machine"` in the test. Adjust test call: `repo.createApiKey("test", "test-machine")`.

- [ ] **Step 2: run** → FAIL. **Step 3: rewrite:**

```js
import { v4 as uuidv4 } from "uuid";
import { listAllRows, getRow, createRow, updateRow, deleteRow } from "../appwrite/tables.js";
import { cached, invalidate } from "../cache.js";
import { Query } from "../appwrite/tables.js";

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.$id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === true,
    createdAt: row.createdAt,
  };
}

async function loadKeys() {
  return cached("apiKeys", 30_000, async () => {
    const rows = await listAllRows("api_keys");
    return rows.map(rowToKey);
  });
}

export async function getApiKeys() {
  return await loadKeys();
}

export async function getApiKeyById(id) {
  return rowToKey(await getRow("api_keys", id));
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
  };
  await createRow("api_keys", apiKey.id, {
    key: apiKey.key, name: apiKey.name, machineId: apiKey.machineId,
    isActive: true, createdAt: apiKey.createdAt,
  });
  invalidate("apiKeys");
  return apiKey;
}

export async function updateApiKey(id, data) {
  const row = await getRow("api_keys", id);
  if (!row) return null;
  const merged = { ...rowToKey(row), ...data };
  await updateRow("api_keys", id, {
    key: merged.key, name: merged.name ?? null, machineId: merged.machineId ?? null,
    isActive: merged.isActive === true, createdAt: merged.createdAt,
  });
  invalidate("apiKeys");
  return merged;
}

export async function deleteApiKey(id) {
  const ok = await deleteRow("api_keys", id);
  invalidate("apiKeys");
  return ok;
}

export async function validateApiKey(key) {
  if (!key) return false;
  const keys = await loadKeys();
  return keys.some((k) => k.key === key && k.isActive);
}
```

(Note: `Query` import kept only if needed later — remove if lint complains.)
- [ ] **Step 4: run** → PASS. **Step 5: commit** `refactor(db): apiKeysRepo on TablesDB + 30s cache`

---

### Task 6: kvStore/metaStore helpers + alias/pricing/disabledModels repos

**Files:** Rewrite `src/lib/db/helpers/kvStore.js`, `src/lib/db/helpers/metaStore.js`; `repos/aliasRepo.js` and `repos/pricingRepo.js` and `repos/disabledModelsRepo.js` need NO changes (they call makeKv/txRun-shape APIs) EXCEPT they import `getAdapter` directly in some functions — verify with grep and port those.

**Interfaces:** `makeKv(scope)` same methods; `getMeta(key, fallback)`, `setMeta(key, value)`; **delete** `getMetaSync`/`setMetaSync` (only migrate.js used them — migrate.js deleted in Task 12; keep a stub throwing until then? No: delete and fix imports in the same task — migrate.js still imports them until Task 12. To keep every commit green, keep `getMetaSync`/`setMetaSync` as sync shims that throw "not supported on TablesDB" until Task 12 removes them.)

- [ ] **Step 1: test** (aw-config-repos.test.js):

```js
describe("kvStore + metaStore", () => {
  beforeEach(async () => {
    tablesMock._rows.clear();
    vi.resetModules();
    (await import("@/lib/db/cache.js")).invalidateAll();
  });
  it("kv set/get/remove/clear roundtrip", async () => {
    const { makeKv } = await import("@/lib/db/helpers/kvStore.js");
    const kv = makeKv("t1");
    await kv.set("a", { x: 1 });
    expect(await kv.get("a")).toEqual({ x: 1 });
    expect(Object.keys(await kv.getAll())).toEqual(["a"]);
    await kv.remove("a");
    expect(await kv.get("a")).toBeNull();
  });
  it("meta set/get", async () => {
    const meta = await import("@/lib/db/helpers/metaStore.js");
    await meta.setMeta("k1", "42");
    expect(await meta.getMeta("k1")).toBe("42");
    expect(await meta.getMeta("missing", "dflt")).toBe("dflt");
  });
});
```

- [ ] **Step 2: implement kvStore:**

```js
import { listAllRows, getRow, upsertRow, deleteRow, deleteRowsByQuery, upsertRowsAll, hashId, Query } from "../appwrite/tables.js";
import { parseJson, stringifyJson } from "./jsonCol.js";

export function makeKv(scope) {
  const id = (key) => hashId(scope, key);
  return {
    async get(key, fallback = null) {
      const row = await getRow("kv", id(key));
      return row ? parseJson(row.value, fallback) : fallback;
    },
    async getAll() {
      const rows = await listAllRows("kv", [Query.equal("scope", scope)]);
      const out = {};
      for (const r of rows) out[r.key] = parseJson(r.value);
      return out;
    },
    async set(key, value) {
      await upsertRow("kv", id(key), { scope, key, value: stringifyJson(value) });
    },
    async setMany(obj) {
      const rows = Object.entries(obj).map(([k, v]) => ({ $id: id(k), scope, key: k, value: stringifyJson(v) }));
      await upsertRowsAll("kv", rows);
    },
    async remove(key) {
      await deleteRow("kv", id(key));
    },
    async clear() {
      await deleteRowsByQuery("kv", [Query.equal("scope", scope)]);
    },
  };
}
```

**metaStore:**

```js
import { getRow, upsertRow, updateRow } from "../appwrite/tables.js";

export async function getMeta(key, fallback = null) {
  const row = await getRow("meta", key);
  return row ? (row.value ?? (row.num != null ? String(row.num) : fallback)) : fallback;
}

export async function setMeta(key, value) {
  await upsertRow("meta", key, { value: String(value) });
}

// Legacy sync API — only the removed SQLite migration used it.
export function getMetaSync() { throw new Error("getMetaSync not supported on TablesDB"); }
export function setMetaSync() { throw new Error("setMetaSync not supported on TablesDB"); }
```

- [ ] **Step 3: fix remaining `getAdapter` uses in the 3 repos.** Run: `grep -n "getAdapter\|driver.js" src/lib/db/repos/aliasRepo.js src/lib/db/repos/pricingRepo.js src/lib/db/repos/disabledModelsRepo.js`
  - `aliasRepo.addCustomModel` uses `db.transaction` + raw SQL — port to `txRun`:

```js
import { txRun } from "../appwrite/tables.js";
import { hashId } from "../appwrite/tables.js";

export async function addCustomModel({ providerAlias, id, type = "llm", name, caps }) {
  const k = customKey(providerAlias, id, type);
  let added = false;
  await txRun(async (ctx) => {
    const row = await ctx.getRow("kv", hashId("customModels", k));
    if (row) {
      const prev = parseJson(row.value) || {};
      const next = { ...prev, ...(name ? { name } : {}), ...(caps ? { caps } : {}) };
      await ctx.upsertRow("kv", hashId("customModels", k), { scope: "customModels", key: k, value: stringifyJson(next) });
      return;
    }
    const value = stringifyJson({ providerAlias, id, type, name: name || id, ...(caps ? { caps } : {}) });
    await ctx.upsertRow("kv", hashId("customModels", k), { scope: "customModels", key: k, value });
    added = true;
  });
  return added;
}
```

  - `pricingRepo.updatePricing`/`resetPricing`/`resetAllPricing`: replace `db.transaction` blocks — `updatePricing` loops providers doing RMW; port each provider RMW into one `txRun` staging all providers (≤100 ops fine):

```js
export async function updatePricing(pricingData) {
  await txRun(async (ctx) => {
    for (const [provider, models] of Object.entries(pricingData)) {
      const row = await ctx.getRow("kv", hashId("pricing", provider));
      const current = row ? (parseJson(row.value, {}) || {}) : {};
      const merged = { ...current };
      for (const [model, pricing] of Object.entries(models)) merged[model] = pricing;
      await ctx.upsertRow("kv", hashId("pricing", provider), { scope: "pricing", key: provider, value: stringifyJson(merged) });
    }
  });
  invalidate();
  return await getUserPricing();
}
```

  `resetPricing` same pattern (delete row when empty via `ctx.deleteRow`), `resetAllPricing` → `pricingKv.clear()` (already). Remove `getAdapter` import; keep `parseJson/stringifyJson` imports where used.

  - `disabledModelsRepo.disableModels/enableModels`: port RMW via `txRun` + `hashId("disabledModels", providerAlias)` + `ctx.deleteRow` on empty, same as current semantics.

- [ ] **Step 4: run all** `npx vitest run unit/aw-config-repos.test.js` → PASS.
- [ ] **Step 5: commit** `refactor(db): kv/meta stores + alias, pricing, disabledModels on TablesDB`

---

### Task 7: connectionsRepo

**Files:** Rewrite `src/lib/db/repos/connectionsRepo.js`. Hardest config repo — keep `OPTIONAL_FIELDS`, `deriveConnectionName`, dedup logic, reorder semantics byte-equivalent.

**Interfaces:** unchanged 8 exports.

- [ ] **Step 1: test:**

```js
describe("connectionsRepo", () => {
  beforeEach(async () => {
    tablesMock._rows.clear();
    vi.resetModules();
    (await import("@/lib/db/cache.js")).invalidateAll();
  });
  it("create dedups oauth by email, reorders priorities", async () => {
    const repo = await import("@/lib/db/repos/connectionsRepo.js");
    const a = await repo.createProviderConnection({ provider: "gemini", authType: "oauth", email: "a@x.com" });
    const dup = await repo.createProviderConnection({ provider: "gemini", authType: "oauth", email: "a@x.com" });
    expect(dup.id).toBe(a.id);
    const b = await repo.createProviderConnection({ provider: "gemini", authType: "oauth", email: "b@x.com" });
    expect(b.priority).toBe(2);
    const list = await repo.getProviderConnections({ provider: "gemini" });
    expect(list).toHaveLength(2);
    await repo.deleteProviderConnection(a.id);
    expect((await repo.getProviderConnections({ provider: "gemini" })).map((c) => c.id)).toEqual([b.id]);
    expect((await repo.getProviderConnections({ provider: "gemini" }))[0].priority).toBe(1);
  });
  it("updateProviderConnection merges oauth tokens", async () => {
    const repo = await import("@/lib/db/repos/connectionsRepo.js");
    const c = await repo.createProviderConnection({ provider: "codex", authType: "oauth", email: "c@x.com" });
    const u = await repo.updateProviderConnection(c.id, { accessToken: "tok", providerSpecificData: { chatgptAccountId: "ws1" } });
    expect(u.accessToken).toBe("tok");
    expect(u.providerSpecificData.chatgptAccountId).toBe("ws1");
  });
});
```

- [ ] **Step 2: run** → FAIL. **Step 3: rewrite** — structural changes only; logic verbatim:

```js
import { v4 as uuidv4 } from "uuid";
import { listAllRows, getRow, upsertRow, deleteRow, txRun, Query } from "../appwrite/tables.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { invalidate } from "../cache.js";
// OPTIONAL_FIELDS, deriveConnectionName: verbatim

function rowToConn(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.$id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: row.priority,
    isActive: row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function connToData(c) {
  const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
  return {
    provider: provider ?? null,
    authType: authType ?? null,
    name: name ?? null,
    email: email ?? null,
    priority: priority ?? null,
    isActive: isActive !== false,
    data: stringifyJson(rest),
    updatedAt: updatedAt ?? new Date().toISOString(),
  };
}

function upsert(conn) {
  return upsertRow("connections", conn.id, connToData(conn));
}

async function listByProvider(providerId) {
  const rows = await listAllRows("connections", [Query.equal("provider", providerId)]);
  return rows.map(rowToConn);
}

// reorderInTx port: read list, sort, stage updateRow priority for each
async function reorderInTx(ctx, providerId) {
  const rows = await listByProvider(providerId);
  rows.sort((a, b) => {
    const pDiff = (a.priority || 0) - (b.priority || 0);
    if (pDiff !== 0) return pDiff;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].priority !== i + 1) {
      rows[i].priority = i + 1;
      await ctx.updateRow("connections", rows[i].id, { priority: i + 1 });
    }
  }
}
```

`createProviderConnection`: wrap whole body in `txRun(async (ctx) => { ... })` — replace `db.transaction(() => {...})`; `upsert(db, merged)` → `await ctx.upsertRow("connections", merged.id, connToData(merged))` (id for new = uuidv4() as before); `reorderInTx(db, provider)` → `await reorderInTx(ctx, provider)`. Keep `result` captured outside. After txRun: `invalidate("connections")`.

`updateProviderConnection`: `txRun` — read row via `ctx.getRow("connections", id)` → `rowToConn` (note: row has same shape). Merge, `ctx.upsertRow`, conditional reorder. `invalidate("connections")`.

`deleteProviderConnection`: `txRun` — read provider, `ctx.deleteRow`, reorder.

`deleteProviderConnectionsByProvider(providerId)`: count via `listByProvider(providerId).length`, then `deleteRowsByQuery("connections", [Query.equal("provider", providerId)])`, invalidate, return count.

`getProviderConnections(filter)`: `listAllRows("connections")` → map → apply filter in memory (`provider`, `isActive`) → sort `(a.priority||999)-(b.priority||999)`. Cached 15 s when NO filter: `cached("connections:all", 15_000, loader)`; filtered queries bypass cache. invalidate("connections") on every write.

`getProviderConnectionById`: `rowToConn(await getRow(...))`.

`cleanupProviderConnections`: port loop — `listAllRows` → clean fields → `ctx.upsertRow` per dirty row inside `txRun` (≤100 ops; connections count small; if >90 dirty, chunk multiple txRuns).

- [ ] **Step 4: run** → PASS. **Step 5: commit** `refactor(db): connectionsRepo on TablesDB (tx + reorder)`

---

### Task 8: nodesRepo, proxyPoolsRepo, combosRepo

**Files:** Rewrite all three. Same mapping pattern as Task 7 (simpler — no reorder).

- [ ] **Step 1: tests** (aw-config-repos.test.js): create → get → update merge → delete returns object → second delete returns null; combos: `getComboByName` finds by name.

- [ ] **Step 2: rewrite pattern** (identical trio):
  - `rowToX(row)`: `id: row.$id`, scalar columns, `...parseJson(row.data, {})`.
  - `xToData(x)`: scalars + `data: stringifyJson(rest)` + `updatedAt`.
  - `getX(filter)`: `listAllRows` + in-memory filter + sort (nodes: none; pools: `updatedAt` desc; combos: `createdAt` asc → `Query.orderAsc("$createdAt")` or in-memory sort — use in-memory for consistency).
  - `createX`/`updateX`: plain `upsertRow` (no tx needed — single row, no read-merge... updateX DOES read-merge → use `txRun` with `ctx.getRow` + `ctx.upsertRow`).
  - `deleteX`: read → `deleteRow` → return old or null.
  - `invalidate("nodes")` / `invalidate("proxyPools")` / `invalidate("combos")` after writes; `getCombos` cached 15 s.
  - combos `name` uniqueness: rely on unique index — catch 409 on create → rethrow as-is (dashboard surfaces).
  - `getProxyPools(filter)` supports `isActive`/`testStatus` filters in memory.
  - `getComboByName(name)`: `listAllRows("combos", [Query.equal("name", name)])` → first or null (or `listRows` limit 1).

- [ ] **Step 3: run** → PASS. **Step 4: commit** `refactor(db): nodes, proxyPools, combos on TablesDB`

---

### Task 9: barrel exportDb/importDb

**Files:** Modify `src/lib/db/index.js` (replace inline exportDb/importDb; delete `getAdapter` import). Other barrel re-exports unchanged.

**Interfaces:** `exportDb()` / `importDb(payload)` same payload shape as today (see current index.js lines 71-166).

- [ ] **Step 1: test** (aw-config-repos.test.js):

```js
describe("exportDb/importDb", () => {
  beforeEach(async () => {
    tablesMock._rows.clear();
    vi.resetModules();
    (await import("@/lib/db/cache.js")).invalidateAll();
  });
  it("roundtrips a payload", async () => {
    const db = await import("@/lib/db/index.js");
    await db.importDb({
      settings: { cloudEnabled: true },
      providerConnections: [{ id: "c1", provider: "gemini", authType: "oauth", isActive: true }],
      apiKeys: [{ id: "k1", key: "sk-x", name: "n", isActive: true, createdAt: "2026-01-01T00:00:00Z" }],
      combos: [{ id: "cb1", name: "fast", models: ["a/b"] }],
      providerNodes: [],
      proxyPools: [],
      modelAliases: { "cl": "gemini/x" },
      customModels: [{ providerAlias: "bai", id: "m1", type: "llm", name: "M1" }],
      mitmAlias: {},
      pricing: {},
    });
    const out = await db.exportDb();
    expect(out.settings.cloudEnabled).toBe(true);
    expect(out.providerConnections[0].id).toBe("c1");
    expect(out.apiKeys[0].key).toBe("sk-x");
    expect(out.modelAliases.cl).toBe("gemini/x");
    expect(out.customModels[0].id).toBe("m1");
  });
});
```

- [ ] **Step 2: run** → FAIL. **Step 3: implement in index.js:**

```js
import { listAllRows, upsertRowsAll, deleteRowsByQuery, hashId, getRow } from "./appwrite/tables.js";
import { invalidateAll } from "./cache.js";

const CONNECTION_COLS = (r) => ({ ...parseJson(r.data, {}), id: r.$id, provider: r.provider, authType: r.authType, name: r.name, email: r.email, priority: r.priority, isActive: r.isActive === true, createdAt: r.createdAt, updatedAt: r.updatedAt });

export async function exportDb() {
  const { exportSettings } = await import("./repos/settingsRepo.js");
  const out = {
    settings: await exportSettings(),
    providerConnections: (await listAllRows("connections")).map(CONNECTION_COLS),
    providerNodes: (await listAllRows("provider_nodes")).map((r) => ({ ...parseJson(r.data, {}), id: r.$id, type: r.type, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    proxyPools: (await listAllRows("proxy_pools")).map((r) => ({ ...parseJson(r.data, {}), id: r.$id, isActive: r.isActive === true, testStatus: r.testStatus, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    apiKeys: (await listAllRows("api_keys")).map((r) => ({ id: r.$id, key: r.key, name: r.name, machineId: r.machineId, isActive: r.isActive === true, createdAt: r.createdAt })),
    combos: (await listAllRows("combos")).map((r) => ({ id: r.$id, name: r.name, kind: r.kind, models: parseJson(r.models, []), createdAt: r.createdAt, updatedAt: r.updatedAt })),
    modelAliases: {},
    customModels: [],
    mitmAlias: {},
    pricing: {},
  };
  for (const r of await listAllRows("kv", [Query.equal("scope", "modelAliases")])) out.modelAliases[r.key] = parseJson(r.value);
  for (const r of await listAllRows("kv", [Query.equal("scope", "customModels")])) out.customModels.push(parseJson(r.value));
  for (const r of await listAllRows("kv", [Query.equal("scope", "mitmAlias")])) out.mitmAlias[r.key] = parseJson(r.value);
  for (const r of await listAllRows("kv", [Query.equal("scope", "pricing")])) out.pricing[r.key] = parseJson(r.value);
  return out;
}

export async function importDb(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid database payload");
  for (const table of ["settings", "connections", "provider_nodes", "proxy_pools", "api_keys", "combos", "kv"]) {
    await deleteRowsByQuery(table);
  }
  if (payload.settings) await upsertRow("settings", "main", { data: stringifyJson(payload.settings) });
  await upsertRowsAll("connections", (payload.providerConnections || []).map((c) => {
    const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
    return { $id: id, provider, authType: authType || "oauth", name: name ?? null, email: email ?? null, priority: priority ?? null, isActive: isActive !== false, data: stringifyJson(rest), createdAt: createdAt || new Date().toISOString(), updatedAt: updatedAt || new Date().toISOString() };
  }));
  await upsertRowsAll("provider_nodes", (payload.providerNodes || []).map((n) => {
    const { id, type, name, createdAt, updatedAt, ...rest } = n;
    return { $id: id, type: type ?? null, name: name ?? null, data: stringifyJson(rest), createdAt: createdAt || new Date().toISOString(), updatedAt: updatedAt || new Date().toISOString() };
  }));
  await upsertRowsAll("proxy_pools", (payload.proxyPools || []).map((p) => {
    const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
    return { $id: id, isActive: isActive !== false, testStatus: testStatus ?? "unknown", data: stringifyJson(rest), createdAt: createdAt || new Date().toISOString(), updatedAt: updatedAt || new Date().toISOString() };
  }));
  await upsertRowsAll("api_keys", (payload.apiKeys || []).map((k) => ({ $id: k.id, key: k.key, name: k.name ?? null, machineId: k.machineId ?? null, isActive: k.isActive !== false, createdAt: k.createdAt || new Date().toISOString() })));
  await upsertRowsAll("combos", (payload.combos || []).map((c) => ({ $id: c.id, name: c.name, kind: c.kind ?? null, models: stringifyJson(c.models || []), createdAt: c.createdAt || new Date().toISOString(), updatedAt: c.updatedAt || new Date().toISOString() })));
  const kvRows = [
    ...Object.entries(payload.modelAliases || {}).map(([a, m]) => ({ $id: hashId("modelAliases", a), scope: "modelAliases", key: a, value: stringifyJson(m) })),
    ...(payload.customModels || []).map((m) => ({ $id: hashId("customModels", `${m.providerAlias}|${m.id}|${m.type || "llm"}`), scope: "customModels", key: `${m.providerAlias}|${m.id}|${m.type || "llm"}`, value: stringifyJson(m) })),
    ...Object.entries(payload.mitmAlias || {}).map(([tool, mappings]) => ({ $id: hashId("mitmAlias", tool), scope: "mitmAlias", key: tool, value: stringifyJson(mappings || {}) })),
    ...Object.entries(payload.pricing || {}).map(([provider, models]) => ({ $id: hashId("pricing", provider), scope: "pricing", key: provider, value: stringifyJson(models || {}) })),
  ];
  await upsertRowsAll("kv", kvRows);
  invalidateAll();
  return await exportDb();
}
```

(Barrel header imports adjusted: `parseJson/stringifyJson` stay, `getAdapter` import removed, add `upsertRow` to the tables import.)

- [ ] **Step 4: run** → PASS. **Step 5: commit** `feat(db): export/import backups on TablesDB`

---

### Task 10: coalescer + usageRepo

**Files:** Create `src/lib/db/appwrite/coalescer.js`; rewrite `src/lib/db/repos/usageRepo.js`.

**Interfaces (coalescer):** `scheduleFlush(fn)` — shared 2 s timer, error-isolated. **usageRepo:** all 9 exports unchanged; `saveRequestUsage` becomes enqueue + coalesced flush.

- [ ] **Step 1: coalescer code:**

```js
if (!global._awFlush) global._awFlush = { pending: new Set(), timer: null };
const state = global._awFlush;
const FLUSH_MS = 2000;

export function scheduleFlush(fn) {
  state.pending.add(fn);
  if (state.timer) return;
  state.timer = setTimeout(async () => {
    state.timer = null;
    const fns = [...state.pending];
    state.pending.clear();
    for (const fn of fns) {
      try { await fn(); } catch (e) { console.error("[DB] flush failed:", e?.message ?? e); }
    }
  }, FLUSH_MS);
  state.timer.unref?.();
}
```

- [ ] **Step 2: usageRepo rewrite.** Keep in-memory sections verbatim (global pending/ring/emitter, `trackPendingRequest`, `getActiveRequests`, `addToCounter`, `aggregateEntryToDay`, `calculateCost`, `maskApiKey`, `getLocalDateKey`). Replace DB-touching parts:

```js
import { listRows, listAllRows, upsertRowsAll, txRun, hashId, Query, deleteRowsByQuery } from "../appwrite/tables.js";
import { scheduleFlush } from "../appwrite/coalescer.js";
// getAdapter import removed; parseJson/stringifyJson kept

if (!global._usageBuf) global._usageBuf = { entries: [], flushing: false, seen: [] };
const buf = global._usageBuf;

function historyRowId(entry) {
  return hashId("uh", entry.timestamp ?? "", entry.provider ?? "", entry.model ?? "", entry.connectionId ?? "", entry.apiKey ?? "", entry.tokens?.prompt_tokens ?? entry.tokens?.input_tokens ?? 0, entry.tokens?.completion_tokens ?? entry.tokens?.output_tokens ?? 0);
}

function trim(v, n) { return v == null ? null : String(v).slice(0, n); }

function entryToHistoryRow(entry) {
  const tokens = entry.tokens || {};
  return {
    $id: historyRowId(entry),
    timestamp: entry.timestamp,
    provider: trim(entry.provider, 64),
    model: trim(entry.model, 255),
    connectionId: trim(entry.connectionId, 64),
    endpoint: trim(entry.endpoint, 64),
    promptTokens: tokens.prompt_tokens ?? tokens.input_tokens ?? 0,
    completionTokens: tokens.completion_tokens ?? tokens.output_tokens ?? 0,
    cost: entry.cost || 0,
    status: trim(entry.status || "ok", 16),
    tokens: stringifyJson(tokens),
    meta: stringifyJson({}),
  };
}

const RECENT_SEEN_CAP = 500;
function seenRecently(id) {
  if (buf.seen.includes(id)) return true;
  buf.seen.push(id);
  if (buf.seen.length > RECENT_SEEN_CAP) buf.seen = buf.seen.slice(-RECENT_SEEN_CAP);
  return false;
}

export async function saveRequestUsage(entry) {
  try {
    if (!entry.timestamp) entry.timestamp = new Date().toISOString();
    entry.cost = await calculateCost(entry.provider, entry.model, entry.tokens);
    buf.entries.push(entry);
    scheduleFlush(flushUsage);
  } catch (e) {
    console.error("Failed to queue usage stats:", e);
  }
}

async function flushUsage() {
  if (buf.flushing) return;
  buf.flushing = true;
  const entries = buf.entries.splice(0, buf.entries.length);
  try {
    const fresh = entries.filter((e) => !seenRecently(historyRowId(e)));
    if (fresh.length === 0) return;
    const byDate = new Map();
    for (const e of fresh) {
      const k = getLocalDateKey(e.timestamp);
      if (!byDate.has(k)) byDate.set(k, []);
      byDate.get(k).push(e);
    }
    let dailyApplied = false;
    try {
      for (const [dateKey, group] of byDate) {
        await txRun(async (ctx) => {
          const row = await ctx.getRow("usage_daily", dateKey);
          const day = row ? parseJson(row.data, {}) : { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, cachedTokens: 0, byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {} };
          for (const e of group) aggregateEntryToDay(day, e);
          await ctx.upsertRow("usage_daily", dateKey, { dateKey, data: stringifyJson(day) });
          await ctx.increment("meta", "lifetime_requests", "num", group.length);
        });
      }
      dailyApplied = true;
      await upsertRowsAll("usage_history", fresh.map(entryToHistoryRow));
      for (const e of fresh) pushToRing(e);
      scheduleStatsEvent("update", 250);
    } catch (e) {
      console.error("[DB] usage flush failed:", e?.message ?? e);
      if (!dailyApplied) buf.entries.push(...fresh); // requeue once — nothing applied
    }
  } finally {
    buf.flushing = false;
  }
}
```

`ensureRingInitialized`: `const rows = await listRows("usage_history", [Query.orderDesc("timestamp"), Query.limit(RING_CAP), Query.select(["timestamp","provider","model","connectionId","apiKey","endpoint","cost","status","tokens"])]);` → `rows.rows.reverse().map(...)` (tokens via parseJson).

`getUsageHistory(filter)`: build queries `Query.equal("provider", ...)`, `equal("model", ...)`, `greaterThanEqual("timestamp", ...)`, `lessThanEqual("timestamp", ...)`; `listAllRows` + `Query.orderAsc("timestamp")`; map with `apiKeyMasked: maskApiKey(r.apiKey)`.

`loadDaysInRange(maxDays)`: `listAllRows("usage_daily", maxDays == null ? [] : [Query.greaterThanEqual("dateKey", cutoffKey)])` → rows `{dateKey, data}`.

`getUsageStats(period)`: structure identical; replace:
- `recentRows` → `listRows("usage_history", [orderDesc timestamp, limit 100, select [...]])`
- `recent10` → same shape with `greaterThanEqual/lessThanEqual timestamp`
- `filtered` (24h/today) → `listAllRows("usage_history", [greaterThanEqual("timestamp", cutoff)], { maxPages: 5 })`
- **Intentional deviation:** the `histRows` overlay uses the same recent-100 rows instead of all rows in period (bounded reads; `lastUsed` date-precision preserved from daily rows).
- lifetime counter reads: `totalRequestsLifetime` consumers → replace with `getRow("meta", "lifetime_requests")?.num ?? 0` (grep `totalRequestsLifetime` and update each reader in this task).

`getChartData(period)`: same swaps (`rows` per today/24h via `listRows` ≥ start, `loadDaysInRange` for 7/30/60d).

`getRecentLogs(limit)`: `listRows("usage_history", [Query.orderDesc("timestamp"), Query.limit(limit), Query.select([...])])` → same formatting; `r.connectionId` etc from columns.

- [ ] **Step 3: test** `tests/unit/aw-usage.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
// reuse makeTablesMock from aw-config-repos test (extract to tests/unit/helpers/aw-mocks.js)

describe("usageRepo", () => {
  beforeEach(async () => {
    tablesMock._rows.clear();
    vi.resetModules();
    (await import("@/lib/db/cache.js")).invalidateAll();
    const g = global;
    g._usageBuf = { entries: [], flushing: false, seen: [] };
  });
  it("flushes queued usage into history + daily + counter", async () => {
    const repo = await import("@/lib/db/repos/usageRepo.js");
    await repo.saveRequestUsage({ provider: "gemini", model: "g/x", tokens: { prompt_tokens: 10, completion_tokens: 5 }, status: "ok" });
    const { __testFlush } = await import("@/lib/db/repos/usageRepo.js");
    await __testFlush();
    const hist = tablesMock._rows.get("usage_history");
    expect(hist.size).toBe(1);
    const daily = tablesMock._rows.get("usage_daily").get(new Date().toISOString().slice(0, 10) === "x" ? "" : [...tablesMock._rows.get("usage_daily").keys()][0]);
    expect(daily.data ? JSON.parse(daily.data).byModel["g/x"].requests : 0).toBe(1);
    expect(tablesMock._rows.get("meta").get("lifetime_requests").num).toBe(1);
  });
  it("dedups identical tuples within seen window", async () => {
    const repo = await import("@/lib/db/repos/usageRepo.js");
    const e = { provider: "p", model: "m", timestamp: "2026-09-04T00:00:00.000Z", tokens: { prompt_tokens: 1, completion_tokens: 1 }, status: "ok" };
    await repo.saveRequestUsage({ ...e });
    await repo.saveRequestUsage({ ...e });
    const { __testFlush } = await import("@/lib/db/repos/usageRepo.js");
    await __testFlush();
    await __testFlush();
    expect(tablesMock._rows.get("usage_history").size).toBe(1);
    expect(tablesMock._rows.get("meta").get("lifetime_requests").num).toBe(1);
  });
});
```

Export `__testFlush = flushUsage` from usageRepo (named export; harmless in prod).

Note the daily row id: compute in test from `getLocalDateKey` semantics — assert on the single key present (as above, first key).

- [ ] **Step 4: run** → PASS. **Step 5: commit** `feat(db): usageRepo on TablesDB with 2s write-behind coalescer`

---

### Task 11: requestDetailsRepo

**Files:** Rewrite `src/lib/db/repos/requestDetailsRepo.js`.

**Interfaces:** `saveRequestDetail`, `getRequestDetails`, `getRequestDetailById`, `getDistinctProviders`, `__test__.sanitizeHeaders` — unchanged.

- [ ] **Step 1: rewrite** — keep `getObservabilityConfig`, `sanitizeHeaders`, `generateDetailId`, `truncateField`, buffer logic; replace flush + reads:

```js
import { listRows, upsertRowsAll, deleteRowsByQuery, hashId, Query } from "../appwrite/tables.js";
import { scheduleFlush } from "../appwrite/coalescer.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { cached } from "../cache.js";
// getAdapter import removed

function detailRowId(item) {
  return `rd-${hashId("rd", item.id ?? `${item.timestamp}-${item.model}`)}`;
}
```
(`rd-` + 32 hex = 35 chars ≤36.)

`flushToDatabase`: keep drain-loop + config; inside, build rows `{ $id: detailRowId(item), timestamp, provider, model, connectionId, status, data: stringifyJson(record) }` (record as today incl. truncateField + sanitizeHeaders), `await upsertRowsAll("request_details", rows)`, then prune: `const probe = await listRows("request_details", [Query.orderAsc("timestamp"), Query.limit(1)]);` → `if ((probe.total ?? 0) > config.maxRecords)` → fetch overflow: `const oldest = await listRows("request_details", [Query.orderAsc("timestamp"), Query.limit(Math.min(100, probe.total - config.maxRecords)), Query.select(["$id"])]);` → `await deleteRowsByQuery("request_details", [Query.equal("$id", oldest.rows.map((r) => r.$id))])` (loop while over). Batch trigger uses `scheduleFlush(flushToDatabase)` instead of own timer.

`getRequestDetails(filter)`: queries = provider/model/connectionId equal, status equal, timestamp gte/lte; `const res = await listRows("request_details", [...filters, Query.orderDesc("timestamp"), Query.limit(pageSize), Query.offset(offset), Query.select(["data"])]);` → `details = res.rows.map((r) => parseJson(r.data, {}))`, `totalItems = res.total ?? details.length`.

`getDistinctProviders`: `listRows("request_details", [Query.isNotNull("provider"), Query.select(["provider"]), Query.limit(100)])` → unique sorted. (≤ maxRecords rows exist; single page of provider strings is representative.)

`getRequestDetailById(id)`: `listRows("request_details", [Query.equal("$id", `rd-${hashId("rd", id)}`), Query.select(["data"]), Query.limit(1)])` → first row parse or null.

- [ ] **Step 2: test** (aw-usage.test.js append): save 3 details → `__testFlushDetails` (export flush fn) → getRequestDetails paginates (total=3, page1 pageSize2 → 2 rows, hasNext), getDistinctProviders has 2 providers, getRequestDetailById returns record.

- [ ] **Step 3: run all tests** `npx vitest run` → PASS (including legacy mocked suites).
- [ ] **Step 4: commit** `refactor(db): requestDetailsRepo on TablesDB (batched flush + prune)`

---

### Task 12: delete SQLite layer

**Files:** Delete `src/lib/db/driver.js`, `src/lib/db/adapters/*` (4), `src/lib/db/migrations/*`, `src/lib/db/schema.js`, `src/lib/db/migrate.js`, `src/lib/db/backup.js`; modify `paths.js` (drop `DB_DIR`/`DATA_FILE`/`BACKUPS_DIR` if unreferenced), `package.json`.

- [ ] **Step 1: sweep references**

```bash
grep -rn "from \"./driver.js\"\|from \"../driver.js\"\|driver\.js\|getAdapter\|migrate\.js\|backup\.js\|schema\.js" src/ --include=*.js
```
Every hit must be within the deletion set or already rewritten. Fix stragglers (expected: none outside deleted files).

- [ ] **Step 2: paths.js** — remove `DB_DIR`, `DATA_FILE`, `BACKUPS_DIR` and their exports if grep shows no remaining importers; keep `DATA_DIR`, `ensureDirs` (machine-id/cli-secret need them).

- [ ] **Step 3: delete files**

```bash
git rm -r src/lib/db/adapters src/lib/db/migrations
git rm src/lib/db/driver.js src/lib/db/schema.js src/lib/db/migrate.js src/lib/db/backup.js
```

- [ ] **Step 4: package.json** — remove `better-sqlite3` (Task 1 removed from optionalDependencies; also verify no direct dep remains: `node -e "const p=require('./package.json'); console.log(JSON.stringify({d:p.dependencies,o:p.optionalDependencies}))"`) and drop `sql.js` if present ONLY under optionalDependencies and unreferenced in src/ (`grep -rn "sql.js" src/ --include=*.js` — adapters deleted, so expect zero).

- [ ] **Step 5: full verification**

```bash
cd tests; npx vitest run; npx eslint .
```
Expected: same pass/fail baseline as pre-migration run (`tests/__baseline__/verify-no-regression.mjs` must not show NEW failures).

- [ ] **Step 6: commit** `refactor(db): remove SQLite layer entirely (driver, adapters, migrations)`

---

### Task 13: seed script + docs

**Files:** Create `scripts/seed-appwrite-db.mjs`; modify `CLAUDE.md` persistence section, `docs/ARCHITECTURE.md`.

- [ ] **Step 1: seed script** — standalone `.mjs`, loads `.env` (same 8-line loader as provision), reads backup JSON path from `process.argv[2]`, maps payload → rows **identically to `importDb`** (duplicate the mappers; it cannot import `@/lib/db` without the Next alias):

```js
// key excerpt — full mapping copied from Task 9 importDb, replacing upsertRowsAll with
// chunked tablesDB.upsertRows calls and settings via tablesDB.upsertRow("settings","main",…)
// Usage: node scripts/seed-appwrite-db.mjs 9router-backup-2026-09-04.json
```

Implementation detail: reuse the same `TABLES` list for wipe order; wipe first (like importDb), then upsert; log counts per table; exit non-zero on any failure.

- [ ] **Step 2: docs** — update `CLAUDE.md` "Persistence — IMPORTANT" section: state is Appwrite TablesDB (`router9`), env contract `APPWRITE_*`, cache TTLs, coalescer; remove db.json/SQLite driver-chain narrative. Update `docs/ARCHITECTURE.md` data-model section with the 11 tables table (copy from spec §4).

- [ ] **Step 3: commit + push**

```bash
git add scripts/seed-appwrite-db.mjs CLAUDE.md docs/ARCHITECTURE.md
git commit -m "docs(db): TablesDB persistence docs + seed script"
git push origin master
```

⚠️ Push triggers a Site redeploy — the LAST wipe (SQLite era ends here).

---

### Task 14: env vars via MCP + deploy + verification

**Files:** none (ops).

- [ ] **Step 1: site variables** (MCP `appwrite2` → `sites_create_variable`, project `6a469ecf0019c02577b9`, site `6a99a48b00063c44aff8`; `confirm_write: true`):
  - `APPWRITE_ENDPOINT` = `https://sgp.cloud.appwrite.io/v1` (non-secret)
  - `APPWRITE_PROJECT_ID` = `6a469ecf0019c02577b9` (non-secret)
  - `APPWRITE_DATABASE_ID` = `router9` (non-secret)
  - `APPWRITE_API_KEY` already exists (secret, `variable_id: appwriteapikey`)
  - Also add the two missing vars from the earlier review: `BASE_URL` / `NEXT_PUBLIC_BASE_URL` = `https://zmxrouter.appwrite.network`
- [ ] **Step 2: verify deploy** via MCP `sites_list_deployments` — wait for latest (post-push) deployment `ready`; check build log has NO SQLite lines (`[DB] Driver:` / `better-sqlite3 unavailable` must be gone).
- [ ] **Step 3: seed cloud data** — user exports JSON from VPS instance (Profile → Export), then locally: `node scripts/seed-appwrite-db.mjs <backup.json>` (uses same project DB).
- [ ] **Step 4: functional verification** (browser on `zmxrouter.appwrite.network`):
  1. Login with INITIAL_PASSWORD (`qoriakbar99`) — settings row created.
  2. Providers page: import/see connections (from seed) — add/remove works.
  3. Endpoint & Key: create API key → test model via flask icon → **green**.
  4. Usage page renders stats + chart; Console Log page lists recent requests.
  5. Profile → Export → Import round-trip.
  6. **The kill test:** push any commit (or Redeploy button) → after deploy: login still works, providers/keys/usage all intact.

## Self-Review Notes

- Spec §5 "in-memory sort" → Tasks 7/8 use it (NULL-priority semantics preserved).
- Spec §6 at-most-once → Task 10 requeue-only-if-nothing-applied.
- Spec §6 lifetime counter → meta `lifetime_requests.num` (grep `totalRequestsLifetime` in Task 10 updates readers).
- Known deliberate deviations: `getUsageStats` overlay uses recent-100 rows (was O(n)); `getDistinctProviders` single page; dedup across flushes via 500-entry in-memory window (old SQL exact-match dedup).
