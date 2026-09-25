import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('../shared/inventory-uncertainty.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
const {comparisonUncertainty}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const fixtures=JSON.parse(await readFile(new URL('./fixtures/inventory-uncertainty.json',import.meta.url),'utf8'));
test('PLC y web aplican el mismo presupuesto a cotas y consumos, sin diferencias de decisión',()=>{
  for(const f of fixtures){
    const actual=comparisonUncertainty(f.calibrationId,f.initial,f.observed,f.metered);
    assert.equal(actual.policyId,f.expected.policyId);
    for(const field of ['expectedBounds','measuredBounds','differenceBounds']){
      for(const side of ['minLiters','maxLiters'])assert.ok(Math.abs(actual[field][side]-f.expected[field][side])<.00101,JSON.stringify({f,actual,field,side}));
    }
    assert.equal(actual.differenceBounds.minLiters>=20,f.expected.differenceBounds.minLiters>=20);
  }
});
