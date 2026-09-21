import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";

/* The database file lives next to the executable during plain-node use, but a
   packaged desktop install puts the program in a read-only location, so the
   host sets CHECKWRITER_DB_PATH to a writable per-user data directory. */
const dbPath = process.env.CHECKWRITER_DB_PATH || "data.db";
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite);
