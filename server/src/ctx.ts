// Runtime context for the standalone (Vercel + Turso) deployment.
//
// Replaces the Muse-hosted context object: instead of a `db()` accessor
// the handlers now use `ctx.db` directly, and `ctx.invalidateQueries()`
// is a no-op (there is no hosted query cache to invalidate — the client
// refetches with react-query instead).

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
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
 * database (Turso when TURSO_DATABASE_URL/TURSO_AUTH_TOKEN are set, otherwise
 * a local SQLite file at ./data/app.db) and creates the tables if needed.
 */
export function getCtx(): Promise<Ctx> {
  if (cached) return Promise.resolve(cached);
  if (initPromise) return initPromise;
  initPromise = (async (): Promise<Ctx> => {
    const url = process.env.TURSO_DATABASE_URL ?? "file:./data/app.db";
    if (url.startsWith("file:")) {
      // @libsql/client creates the file but not its parent directory.
      const filePath = url.slice("file:".length);
      const dir = dirname(filePath);
      if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
    }
    const client = createClient({
      url,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
    const db = drizzle(client, { schema });
    await client.executeMultiple(CREATE_TABLES_SQL);
    cached = {
      db,
      inference: createInference(),
      invalidateQueries: () => {},
    };
    return cached;
  })();
  return initPromise;
}
