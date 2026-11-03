import test from "node:test";
import assert from "node:assert/strict";
import {
  createMeals,
  calculateNutrition,
  reviseRice,
  validateAnalysis,
  buildReport,
  reportMarkdown,
} from "../src/domain.js";

test("180g 熟饭按每100g参考值换算为208.8kcal，原始份量不被修改", () => {
  const meals = createMeals();
  const analysis = calculateNutrition(meals);
  assert.equal(
    analysis.rows
      .find((r) => r.id === "lunch-0")
      .evidence.find((e) => e.food === "rice").kcal,
    208.8,
  );
  const revised = reviseRice(meals, 100);
  const after = calculateNutrition(revised);
  assert.equal(
    Math.round((analysis.totals.kcal - after.totals.kcal) * 10) / 10,
    92.8,
  );
  assert.equal(meals.find((r) => r.id === "lunch-2").items[0].grams, 180);
  assert.equal(revised.find((r) => r.id === "lunch-2").items[0].grams, 100);
});

test("未知原料、空记录和非法份量不会生成伪造数值", () => {
  assert.throws(() => calculateNutrition([]), /没有可分析/);
  assert.throws(
    () => calculateNutrition([{ items: [{ food: "unknown", grams: 100 }] }]),
    /无效/,
  );
  for (const grams of [-1, 0, NaN, Infinity, 2001])
    assert.throws(() => reviseRice(createMeals(), grams));
});

test("报告前必须核对汇总；导出保留来源、限制及版本", () => {
  const analysis = calculateNutrition(createMeals());
  assert.throws(() => buildReport(analysis, null), /校验/);
  const report = buildReport(analysis, validateAnalysis(analysis), 2);
  const markdown = reportMarkdown(report);
  assert.match(markdown, /版本 2/);
  assert.match(markdown, /合成示例/);
  assert.match(markdown, /不代表/);
  analysis.totals.kcal += 100;
  assert.throws(() => validateAnalysis(analysis), /不一致/);
});
