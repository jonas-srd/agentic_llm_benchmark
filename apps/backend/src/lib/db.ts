import { DatabaseSync } from "node:sqlite";
import pg from "pg";
export type Row = Record<string, any>;
export interface Result<T = Row> {
  rows: T[];
  rowCount: number;
}
export interface Queryable {
  query<T = Row>(sql: string, params?: unknown[]): Promise<Result<T>>;
}
const jsonColumns = new Set([
  "config",
  "snapshot",
  "payload",
  "result",
  "usage",
  "tests",
  "metadata_json",
  "data",
]);
function decode<T>(row: Row): T {
  for (const key of jsonColumns)
    if (typeof row[key] === "string") {
      try {
        row[key] = JSON.parse(row[key]);
      } catch {}
    }
  return row as T;
}
function param(value: unknown) {
  return value !== null && typeof value === "object"
    ? JSON.stringify(value)
    : (value ?? null);
}
export class Database implements Queryable {
  private sqlite?: DatabaseSync;
  private pool?: pg.Pool;
  private gate: Promise<unknown> = Promise.resolve();
  constructor(url: string) {
    if (url.startsWith("postgres"))
      this.pool = new pg.Pool({
        connectionString: url.replace("postgresql+psycopg://", "postgresql://"),
        max: 10,
      });
    else {
      this.sqlite = new DatabaseSync(
        url === ":memory:" ? url : url.replace(/^sqlite:\/\/\//, ""),
      );
      this.sqlite.exec(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=20000;",
      );
    }
  }
  get postgres() {
    return !!this.pool;
  }
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>((r) => {
      release = r;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  private async sqliteQuery<T>(
    sql: string,
    params: unknown[] = [],
  ): Promise<Result<T>> {
    const bindings: unknown[] = [];
    const translated = sql.replace(/\$(\d+)/g, (_, n) => {
      const p = param(params[Number(n) - 1]);
      bindings.push(typeof p === "boolean" ? Number(p) : p);
      return "?";
    });
    const statement = this.sqlite!.prepare(translated);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
      const rows = statement
        .all(...(bindings as any[]))
        .map((r) => decode<T>(r));
      return { rows, rowCount: rows.length };
    }
    const result = statement.run(...(bindings as any[]));
    return { rows: [], rowCount: Number(result.changes) };
  }
  async query<T = Row>(
    sql: string,
    params: unknown[] = [],
  ): Promise<Result<T>> {
    if (this.pool) {
      const r = await this.pool.query(sql, params.map(param));
      return { rows: r.rows.map(decode<T>), rowCount: r.rowCount || 0 };
    }
    return this.locked(() => this.sqliteQuery<T>(sql, params));
  }
  async tx<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          query: async <R>(sql: string, params: unknown[] = []) => {
            const r = await client.query(sql, params.map(param));
            return { rows: r.rows.map(decode<R>), rowCount: r.rowCount || 0 };
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }
    return this.locked(async () => {
      this.sqlite!.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn({
          query: <R>(sql: string, p?: unknown[]) => this.sqliteQuery<R>(sql, p),
        });
        this.sqlite!.exec("COMMIT");
        return result;
      } catch (e) {
        this.sqlite!.exec("ROLLBACK");
        throw e;
      }
    });
  }
  async close() {
    if (this.pool) await this.pool.end();
    else this.sqlite!.close();
  }
}
export async function one<T = Row>(
  db: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  return (await db.query<T>(sql, params)).rows[0];
}
export async function insert(db: Queryable, table: string, values: Row) {
  const keys = Object.keys(values);
  if (![table, ...keys].every((k) => /^[a-z_]+$/.test(k)))
    throw new Error("Invalid internal SQL identifier");
  return db.query(
    `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map((_, i) => "$" + (i + 1)).join(",")})`,
    Object.values(values),
  );
}
export function isUnique(e: unknown) {
  return (
    !!e &&
    typeof e === "object" &&
    (("code" in e && e.code === "23505") ||
      ("message" in e &&
        String(e.message).includes("UNIQUE constraint failed")))
  );
}
export const now = () => Date.now() / 1000;
