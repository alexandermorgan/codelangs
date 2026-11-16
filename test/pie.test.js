import assert from "node:assert/strict";
import { test } from "bun:test";
import { register, render } from "../public/vendor/pele/core.js";
import pie from "../public/vendor/pele/diagrams/pie.js";
import { pieValues } from "../public/js/chart.js";

register(pie);
const entries = (totals) => Object.entries(totals).map(([name, total]) => ({ name, total }));
const slices = (es) => {
  const { values } = pieValues(es);
  const { svg } = render(["pie", ...es.map((e, i) => `  "${e.name}" : ${values[i]}`)].join("\n"));
  return [...svg.matchAll(/class="pele-slice" data-id="([^"]+)"/g)].map((m) => m[1]);
};

test("pele itself leaves out slices under 1% (why pieValues exists)", () => {
  const { svg } = render('pie\n  "Big" : 9990\n  "Tiny" : 10');
  assert.ok(!svg.includes('data-id="Tiny" d='));
});

test("every language gets a visible slice, however small", () => {
  const es = entries({ "JS/TS": 600000, Python: 250000, Rust: 100000, "C++": 40000, Other: 300 });
  assert.deepEqual(slices(es), ["JS/TS", "Python", "Rust", "C++", "Other"]);
  assert.deepEqual(pieValues(es).enlarged, ["Other"]);
});

test("several tiny slices all show", () => {
  const es = entries({ A: 1e6, B: 900, C: 500, D: 40, E: 1 });
  assert.deepEqual(slices(es), ["A", "B", "C", "D", "E"]);
  assert.deepEqual(pieValues(es).enlarged, ["B", "C", "D", "E"]);
});

test("slices of 1% or more are drawn at their real size", () => {
  const es = entries({ A: 700, B: 200, C: 100 });
  assert.deepEqual(pieValues(es), { values: [700, 200, 100], enlarged: [] });
});
