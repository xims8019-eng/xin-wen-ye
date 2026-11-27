import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** One cached payload per source key (hot lists, a news category, one feed). */
export const cacheSnapshots = sqliteTable("cache_snapshots", {
  key: text("key").primaryKey(),
  payload: text("payload").notNull(),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull(),
});

/** Feeds the user follows: preset catalog entries or their own RSS URLs. */
export const subscriptions = sqliteTable("subscriptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  feedKey: text("feed_key").notNull().unique(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  isCustom: integer("is_custom").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Articles the user saved to read later. */
export const bookmarks = sqliteTable("bookmarks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  url: text("url").notNull().unique(),
  source: text("source").notNull(),
  publishedAt: text("published_at"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Items the user dismissed ("ignored") — hidden everywhere, synced across devices. */
export const dismissedItems = sqliteTable("dismissed_items", {
  itemKey: text("item_key").primaryKey(),
  title: text("title").notNull(),
  dismissedAt: text("dismissed_at").notNull(),
});
