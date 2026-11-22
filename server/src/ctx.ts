// Runtime context for the standalone (Vercel + Turso) deployment.
//
// Replaces the Muse-hosted context object: instead of a `db()` accessor
// the handlers now use `ctx.db` directly, and `ctx.invalidateQueries()`
// is a no-op (there is no hosted query cache to invalidate — the client
// refetches with react-query instead).
//
// IMPORTANT — why the database client is the pure-HTTP one, and why there
// is NO local `file:` fallback in this file:
// `@libsql/client`'s default Node entry eagerly imports the native NAPI
// package `libsql`, which loads its platform binary with a computed
// dynamic `require("@libsql/" + target)`, and it also pulls in the `ws`
// package. Vercel's bundler (esbuild) INLINES a dynamic
// `import("@libsql/client")` into the serverless bundle even when the
// branch is never taken at runtime, so that CJS native-loader code runs
// at module-evaluation time and dies with
// `Dynamic require of "events" is not supported` —
// FUNCTION_INVOCATION_FAILED before any handler (or its try/catch) runs.
// The previous fix (lazy dynamic import) did not help for exactly this
// reason: lazy at runtime is not lazy at bundle time. The only safe fix
// is to never reference `@libsql/client` (without `/http`) anywhere in
// the server code, so the native binding never enters the bundle graph.
// `drizzle-orm/libsql` has the same problem; only
// `@libsql/client/http` + `drizzle-orm/libsql/http` (pure JavaScript
// Hrana-over-HTTP, no native code at all) may be used.

import { createClient as createHttpClient } from "@libsql/client/http";
import { drizzle as drizzleHttp } from "drizzle-orm/libsql/http";
import type { LibSQLDatabase } from "drizzle-orm/libsql/driver-core";
import * as schema from "./schema.js";
import { createInference, type Inference } from "./llm.js";

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
 * database (Turso over plain HTTPS — TURSO_DATABASE_URL is required) and
 * creates the tables if needed.
 *
 * There is deliberately no local `file:` fallback: any reference to
 * `@libsql/client` (without `/http`) would pull the native binding into
 * the serverless bundle and crash the function at import time (see the
 * header comment). A missing TURSO_DATABASE_URL therefore throws a clear
 * error, which the API handlers turn into a readable JSON 500.
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
      if (!url) {
        throw new Error(
          "TURSO_DATABASE_URL 未配置：请在 Vercel 项目的环境变量里设置 Turso 数据库地址（libsql://…），并同时设置 TURSO_AUTH_TOKEN",
        );
      }
      // Remote Turso over HTTPS — pure JS, no native binding anywhere
      // in this import graph.
      const client = createHttpClient({
        url,
        authToken: process.env.TURSO_AUTH_TOKEN,
      });
      const db = drizzleHttp(client, { schema });
      await client.executeMultiple(CREATE_TABLES_SQL);
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
