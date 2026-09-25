import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../shared/volume-format.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { formatLiters, formatVolumeCsv, receiptVolumeToSave } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("un decimal fijo para la captura, ceros, empates, negativos y miles", () => {
  for (const [value, expected] of [[38.933,"38,9 L"],[1.64,"1,6 L"],[6.7,"6,7 L"],[17.98,"18,0 L"],
    [0,"0,0 L"],[0.01,"0,0 L"],[1.25,"1,3 L"],[-1.25,"-1,3 L"],[1.15,"1,2 L"],
    [-0.01,"0,0 L"],[-0,"0,0 L"],[2500,"2.500,0 L"],[999.95,"1.000,0 L"]]) {
    assert.equal(formatLiters(value), expected);
  }
  for (const missing of [undefined,null,NaN,Infinity]) assert.equal(formatLiters(missing), "—");
});
test("CSV usa la misma aproximación sin separador de miles y conserva ausencias", () => {
  assert.equal(formatVolumeCsv(1005.85), "1005.9");
  assert.equal(formatVolumeCsv(18), "18.0");
  assert.equal(formatVolumeCsv(-0.01), "0.0");
  assert.equal(formatVolumeCsv(null), "");
});
test("el total se redondea después de sumar las mediciones originales", () => {
  const readings = [1.24,1.24,1.24];
  assert.equal(formatLiters(readings.reduce((sum, value) => sum + value, 0)), "3,7 L");
  assert.deepEqual(readings, [1.24,1.24,1.24]);
});
test("la revisión documental conserva la precisión original; una corrección cambia el volumen", () => {
  assert.equal(receiptVolumeToSave(38.9, 38.933), 38.933);
  assert.equal(receiptVolumeToSave(39.0, 38.933), 39.0);
});
