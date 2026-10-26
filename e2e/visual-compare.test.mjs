import test from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { compareVisual } from "./visual-compare.mjs";
const fixture = () => { const p = new PNG({ width: 100, height: 100 }); p.data.fill(255); return p; };
const compare = (a, b) => compareVisual(PNG.sync.write(a), PNG.sync.write(b));
test("identical raster and measured small raster noise accepted", () => {
  const a = fixture(), b = fixture();
  assert.equal(compare(a,b).passed,true);
  for(let i=0;i<26;i++) b.data[i*4] -= 4;
  assert.equal(compare(a,b).passed,true);
});
test("single visible pixel, alpha, dimensions and diffuse changes rejected", () => {
  const a=fixture(); let b=fixture(); b.data[0]-=5;
  assert.equal(compare(a,b).passed,false);
  b=fixture(); b.data[3]-=1;
  assert.equal(compare(a,b).passed,false);
  b=fixture(); for(let i=0;i<33;i++) b.data[i*4]-=1;
  assert.equal(compare(a,b).passed,false);
  assert.equal(compare(a,new PNG({width:99,height:100})).passed,false);
});
test("a moved control or removed label cannot be accepted as raster noise", () => {
  const a=fixture(), b=fixture();
  for(let y=20;y<40;y++) for(let x=20;x<50;x++) a.data[(y*100+x)*4]=0;
  for(let y=20;y<40;y++) for(let x=21;x<51;x++) b.data[(y*100+x)*4]=0;
  assert.equal(compare(a,b).passed,false);
  assert.equal(compare(a,fixture()).passed,false);
});
