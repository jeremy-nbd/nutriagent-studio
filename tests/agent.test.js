import test from "node:test";
import assert from "node:assert/strict";
import { executeTool, runDemo, runLive } from "../src/agent.js";
import { createMeals } from "../src/domain.js";
const makeRun = (overrides = {}) => ({
  prompt: "生成三日报告",
  status: "running",
  version: 1,
  events: [],
  ...overrides,
});
const noop = () => {};

test("信息不足时暂停，明确份量后能继续生成报告", async () => {
  const run = makeRun({ scenario: "clarify", prompt: "一碗米饭" });
  await runDemo(run, noop, { stepDelay: 0 });
  assert.equal(run.status, "awaiting_input");
  assert.ok(!run.report);
  run.prompt = "米饭实际吃了100克";
  run.status = "running";
  await runDemo(run, noop, { stepDelay: 0 });
  assert.equal(
    run.report.analysis.rows.find((r) => r.id === "lunch-2").evidence[0].grams,
    100,
  );
});

test("报告步骤失败保留中间结果，恢复只执行报告工具", async () => {
  const run = makeRun({ simulateFailure: true });
  await assert.rejects(runDemo(run, noop, { stepDelay: 0 }), /演示故障/);
  assert.ok(run.analysis);
  assert.equal(run.validation.passed, true);
  assert.ok(!run.report);
  run.resumeReport = true;
  const names = [];
  await runDemo(
    run,
    (type, data) => {
      if (type === "tool_start") names.push(data.name);
    },
    { stepDelay: 0 },
  );
  assert.deepEqual(names, ["generate_report"]);
  assert.ok(run.report);
});

test("模型不能虚构修订克数；未知工具被拒绝", async () => {
  const run = makeRun({ meals: createMeals(), prompt: "生成米饭报告" });
  await assert.rejects(
    executeTool(run, "revise_rice_portion", { grams: 50 }, noop),
    /不能由模型猜测/,
  );
  await assert.rejects(executeTool(run, "__proto__", {}, noop), /不支持的工具/);
  run.prompt = "米饭只吃一半";
  await executeTool(run, "revise_rice_portion", { grams: 90 }, noop);
  assert.equal(run.meals.find((r) => r.id === "lunch-2").items[0].grams, 90);
  await executeTool(run, "revise_rice_portion", { grams: 90 }, noop);
  assert.equal(run.meals.find((r) => r.id === "lunch-2").items[0].grams, 90);
  await assert.rejects(
    executeTool(run, "revise_rice_portion", { grams: 45 }, noop),
    /不能重复折算/,
  );
});

test("其他食物的克数不能被静默应用到米饭", async () => {
  const run = makeRun({ prompt: "鸡胸肉改为100克" });
  await runDemo(run, noop, { stepDelay: 0 });
  assert.equal(run.status, "awaiting_input");
  assert.ok(!run.report);
});

test("真实模式消费模型工具调用，通过同一执行器完成闭环", async () => {
  const names = [
    "get_meal_records",
    "calculate_nutrition",
    "validate_report_data",
    "generate_report",
  ];
  let round = 0;
  const requests = [];
  const fetchMock = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const name = names[round++];
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call-${round}`,
                  type: "function",
                  function: { name, arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
    };
  };
  const run = makeRun();
  await runLive(
    run,
    noop,
    {
      model: "fixture",
      apiKey: "test-only",
      baseURL: "http://invalid.example",
      timeoutMs: 1000,
    },
    fetchMock,
  );
  assert.equal(round, 4);
  assert.ok(run.report);
  assert.equal(requests[1].messages.at(-1).role, "tool");
  assert.equal(requests[0].tools.length, 6);
});

test("模型只返回文字不能冒充报告完成；错误状态不泄露上游响应", async () => {
  const run = makeRun();
  await runLive(
    run,
    noop,
    { timeoutMs: 1000, baseURL: "https://invalid.example" },
    async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "报告已完成" } }] }),
    }),
  );
  assert.equal(run.status, "awaiting_input");
  assert.ok(!run.report);
  await assert.rejects(
    runLive(
      makeRun(),
      noop,
      { timeoutMs: 1000, baseURL: "https://invalid.example" },
      async () => ({ ok: false, status: 401 }),
    ),
    /HTTP 401/,
  );
});
