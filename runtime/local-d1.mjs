import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

function normalizeBinding(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return Number(value);
  return value;
}

class LocalD1PreparedStatement {
  constructor(owner, query, values = []) {
    this.owner = owner;
    this.query = query;
    this.values = values;
  }

  bind(...values) {
    return new LocalD1PreparedStatement(
      this.owner,
      this.query,
      values.map(normalizeBinding),
    );
  }

  async run() {
    return this.runSync();
  }

  async first() {
    const row = this.owner.database.prepare(this.query).get(...this.values);
    return row ? { ...row } : null;
  }

  async all() {
    const results = this.owner.database.prepare(this.query).all(...this.values)
      .map((row) => ({ ...row }));
    return { success: true, results };
  }

  runSync() {
    const result = this.owner.database.prepare(this.query).run(...this.values);
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

export class LocalD1Database {
  constructor(databasePath) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode=WAL");
    this.database.exec("PRAGMA synchronous=FULL");
    this.database.exec("PRAGMA foreign_keys=ON");
    this.database.exec("PRAGMA busy_timeout=5000");
  }

  prepare(query) {
    return new LocalD1PreparedStatement(this, query);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof LocalD1PreparedStatement) || statement.owner !== this) {
          throw new TypeError("La operación batch contiene una sentencia de otra base de datos.");
        }
        return statement.runSync();
      });
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}

export function createLocalD1(databasePath) {
  return new LocalD1Database(databasePath);
}
