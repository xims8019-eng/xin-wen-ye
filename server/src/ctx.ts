// Runtime context for the standalone (Vercel + Turso) deployment.
//
// Replaces the Muse-hosted context object: instead of a `db()` accessor
// the handlers now use `ctx.db` directly, and `ctx.invalidateQueries()`
// is a no-op (there is no hosted query cache to invalidate — the client
// refetches with react-query instead).
//
// IMPORTANT — why the database client is the pure-HTTP one:
// `@libsql/client`'s default Node entry eagerly imports the native NAPI
// package `libsql`, which loads its platform binary with a computed
// dynamic `require("@libsql/" + target)`. Vercel's file tracer
// (@vercel/nft) cannot trace that dynamic require, so the `.node` binary
// is dropped from the serverless bundle and the function dies at import
// time with `Cannot find module '@libsql/linux-x64-gnu'` —
// FUNCTION_INVOCATION_FAILED before any handler (or its try/catch) runs.
// `drizzle-orm/libsql` has the same problem: its driver imports
// `createClient` from `@libsql/client` at runtime.
// The fix is to use the pure-JavaScript Hrana-over-HTTP client
// (`@libsql/client/http` + `drizzle-orm/libsql/http`) for every remote
// database URL. It has no native code at all, so there is nothing for the
// bundler to drop. The local `file:` fallback below is only for local
// development and is loaded with a dynamic `import()`, so it never enters
// the serverless bundle's static import graph.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient as createHttpClient } from "@libsql/client/http";
import { drizzle as drizzleHttp } from "drizzle-orm/libsql/http";
import type { LibSQLDatabase } from "drizzle-orm/libsql/driver-core";
import * as schema from "./schema";
import { createInference, type Inference } from "./llm";

export interface Ctx {
  db: LibSQLDatabase<typeof schema>;
  inference: Inference | null;
  invalidateQueries: () => void;
}

// Same three tables as drizzle/0002_news_tables_replace_entries.sql,
// inlined so the serverless function never has to read SQL files at runtime.
const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS cache_snapshots (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  is_custom INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  published_at TEXT,
  created_at INTEGER NOT NULL
);
`;

let cached: Ctx | null = null;
let initPromise: Promise<Ctx> | null = null;

/**
 * Returns the process-wide singleton context. The first call opens the
 * database (Turso over plain HTTPS when TURSO_DATABASE_URL is set,
 * otherwise a local SQLite file at ./data/app.db for local development)
 * and creates the tables if needed.
 *
 * A failed first attempt clears `initPromise` so a later call can retry
 * instead of reusing the rejected promise; the API handlers already turn
 * the error into a readable JSON 500 instead of crashing the function.
 */
export function getCtx(): Promise<Ctx> {
  if (cached) return Promise.resolve(cached);
  if (initPromise) return initPromise;
  initPromise = (async (): Promise<Ctx> => {
    try {
      const url = process.env.TURSO_DATABASE_URL;
      let db: LibSQLDatabase<typeof schema>;
      if (url) {
        // Remote Turso over HTTPS — pure JS, no native binding anywhere
        // in this import graph.
        const client = createHttpClient({
          url,
          authToken: process.env.TURSO_AUTH_TOKEN,
        });
        db = drizzleHttp(client, { schema });
        await client.executeMultiple(CREATE_TABLES_SQL);
      } else {
        // Local development only. Loaded lazily so the native `libsql`
        // binding never appears in the serverless bundle's static
        // imports; if it cannot load here, the error surfaces as a
        // readable JSON 500 from the handler instead of a cold-start crash.
        const fileUrl = "file:./data/app.db";
        const filePath = fileUrl.slice("file:".length);
        const dir = dirname(filePath);
        if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
        const [{ createClient }, { drizzle }] = await Promise.all([
          import("@libsql/client"),
          import("drizzle-orm/libsql"),
        ]);
        const client = createClient({ url: fileUrl });
        db = drizzle(client, { schema });
        await client.executeMultiple(CREATE_TABLES_SQL);
      }
      cached = {
        db,
        inference: createInference(),
        invalidateQueries: () => {},
      };
      return cached;
    } catch (e) {
      initPromise = null;
      throw e;
    }
  })();
  return initPromise;
}
