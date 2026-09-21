/**
 * Additive column reconciliation for the SQLite store.
 *
 * `migrate()` creates tables with `CREATE TABLE IF NOT EXISTS`, which is
 * idempotent but *not* a migration: once a database file exists, adding a new
 * field to `shared/schema.ts` never reaches it, so the app starts reading a
 * column the database does not have. Published deployments preserve `data.db`
 * across redeploys, which is exactly the case where this bites.
 *
 * This module compares the live table shape against the Drizzle schema — the
 * single source of truth — and issues `ALTER TABLE ... ADD COLUMN` for anything
 * missing. Because the expected shape is derived from the schema rather than a
 * hand-maintained list, a column added to `shared/schema.ts` is picked up here
 * automatically with no second edit.
 *
 * Deliberately additive only. It never drops, renames, retypes, or reorders a
 * column, and never rewrites data: those need a considered, data-aware
 * migration and must not happen implicitly on boot in a system of financial
 * record. Anything it cannot do safely is reported rather than forced.
 */
import { sql } from "drizzle-orm";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { db } from "./storage-db";
import * as schema from "@shared/schema";

export interface ColumnChange {
  table: string;
  column: string;
  ddl: string;
}

export interface ReconcileReport {
  applied: ColumnChange[];
  /** Columns that exist in the schema but cannot be added safely. */
  skipped: { table: string; column: string; reason: string }[];
}

/** Renders a default into a SQL literal, or null when it cannot be inlined. */
function defaultLiteral(value: unknown): string | null {
  if (value === null) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  return null;
}

function existingColumns(table: string): Set<string> {
  /* PRAGMA returns one row per column; an unknown table yields no rows. */
  const rows = db.all<{ name: string }>(sql.raw(`PRAGMA table_info('${table}')`));
  return new Set(rows.map((r) => r.name));
}

export function reconcileColumns(): ReconcileReport {
  const report: ReconcileReport = { applied: [], skipped: [] };

  /* `schema` also exports zod validators and types, so pick out just the
     Drizzle tables by the brand symbol Drizzle stamps onto them. */
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is SQLiteTable<any> =>
      typeof v === "object" && v !== null && Symbol.for("drizzle:Name") in v,
  );

  for (const table of tables) {
    const config = getTableConfig(table);
    const present = existingColumns(config.name);

    /* No rows means the table itself is absent. migrate() owns table creation,
       so leave it alone rather than half-building it one column at a time. */
    if (present.size === 0) continue;

    for (const column of config.columns) {
      if (present.has(column.name)) continue;

      /* An identity/primary-key column cannot be introduced by ADD COLUMN. */
      if (column.primary) {
        report.skipped.push({
          table: config.name,
          column: column.name,
          reason: "primary key columns cannot be added to an existing table",
        });
        continue;
      }

      const type = column.getSQLType();
      const literal = column.hasDefault ? defaultLiteral(column.default) : null;

      let ddl: string;
      if (column.notNull) {
        /* SQLite rejects a NOT NULL column without a default, since existing
           rows would have nothing to hold. Fall back to adding it nullable so
           boot still succeeds, and surface it for a real backfill. */
        if (literal === null || literal === "NULL") {
          report.skipped.push({
            table: config.name,
            column: column.name,
            reason: "NOT NULL without an inlinable default; needs a backfill migration",
          });
          continue;
        }
        ddl = `ALTER TABLE "${config.name}" ADD COLUMN "${column.name}" ${type} NOT NULL DEFAULT ${literal}`;
      } else {
        ddl =
          literal === null
            ? `ALTER TABLE "${config.name}" ADD COLUMN "${column.name}" ${type}`
            : `ALTER TABLE "${config.name}" ADD COLUMN "${column.name}" ${type} DEFAULT ${literal}`;
      }

      db.run(sql.raw(ddl));
      report.applied.push({ table: config.name, column: column.name, ddl });
    }
  }

  return report;
}
