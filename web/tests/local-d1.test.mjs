import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalD1 } from "../runtime/local-d1.mjs";

test("el adaptador D1 local persiste consultas y revierte batches fallidos", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fuel-edge-d1-"));
  const databasePath = join(directory, "fuel-edge.sqlite3");
  const database = createLocalD1(databasePath);

  try {
    await database.prepare("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)").run();
    await database.prepare("INSERT INTO users(id, name) VALUES (?, ?)").bind("usr-1", "Pedro").run();
    assert.deepEqual(
      await database.prepare("SELECT id, name FROM users WHERE id = ?").bind("usr-1").first(),
      { id: "usr-1", name: "Pedro" },
    );
    assert.deepEqual(
      await database.prepare("SELECT id FROM users ORDER BY id").all(),
      { success: true, results: [{ id: "usr-1" }] },
    );

    await assert.rejects(database.batch([
      database.prepare("INSERT INTO users(id, name) VALUES (?, ?)").bind("usr-2", "Ana"),
      database.prepare("INSERT INTO users(id, name) VALUES (?, ?)").bind("usr-1", "Duplicado"),
    ]));
    assert.equal(
      await database.prepare("SELECT id FROM users WHERE id = ?").bind("usr-2").first(),
      null,
    );
  } finally {
    database.close();
  }

  const reopened = createLocalD1(databasePath);
  try {
    assert.deepEqual(
      await reopened.prepare("SELECT id, name FROM users WHERE id = ?").bind("usr-1").first(),
      { id: "usr-1", name: "Pedro" },
    );
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
