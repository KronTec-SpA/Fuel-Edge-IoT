import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import ts from "typescript";
const source = await readFile(new URL("../app/site-time.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { databaseInstant, formatSiteDate, siteDateKey } = await import(moduleUrl);
const clock = { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" };
test("UTC, offsets and SQLite timestamps identify the same failure", () => {
  for (const value of ["2026-09-03T21:43:51.343Z", "2026-09-03T17:43:51.343-04:00", "2026-09-03 21:43:51.343", "2026-09-03T21:43:51.343"]) {
    assert.equal(databaseInstant(value).toISOString(), "2026-09-03T21:43:51.343Z");
    assert.equal(formatSiteDate(value, clock), "17:43:51");
  }
  assert.equal(formatSiteDate("sin fecha"), "sin fecha");
});
test("civil dates respect midnight and Chilean DST", () => {
  assert.equal(formatSiteDate("2026-09-06T03:59:59Z", clock), "23:59:59");
  assert.equal(siteDateKey("2026-09-06T03:59:59Z"), "2026-09-05");
  assert.equal(formatSiteDate("2026-09-06T04:00:00Z", clock), "01:00:00");
  assert.equal(siteDateKey("2026-09-06T04:00:00Z"), "2026-09-06");
  assert.equal(siteDateKey("2026-09-09T02:59:59Z"), "2026-09-08");
  assert.equal(siteDateKey("2026-09-09T03:00:00Z"), "2026-09-09");
});
test("display and parsing do not depend on the browser/server timezone", () => {
  const script = `const {formatSiteDate, siteDateKey} = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify([formatSiteDate('2026-09-03 21:43:51'), siteDateKey('2026-09-09T02:30:00Z')]));`;
  const outputs = ["UTC", "America/Santiago", "Asia/Tokyo", "America/Los_Angeles"].map(TZ => execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ }, encoding: "utf8" }));
  assert.ok(outputs.every(value => value === outputs[0]));
});
