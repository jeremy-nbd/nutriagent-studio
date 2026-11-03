import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/server.js";

async function app(t, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "nutriagent-test-"));
  const instance = createApp({ dataDir, env: {}, stepDelay: 0, ...options });
  await new Promise((resolve) =>
    instance.server.listen(0, "127.0.0.1", resolve),
  );
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  t.after(async () => {
    instance.server.closeAllConnections();
    await new Promise((resolve) => instance.server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { ...instance, base, dataDir };
}
const post = (base, body, headers = {}) =>
  fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
async function complete(base, input) {
  const response = await post(base, input);
  assert.equal(response.status, 202);
  const { id } = await response.json();
  const stream = await (await fetch(`${base}/api/runs/${id}/events`)).text();
  const run = await (await fetch(`${base}/api/runs/${id}`)).json();
  return { run, stream };
}

test("HTTP、SSE、Markdown、份量修订与报告版本贯通", async (t) => {
  const { base } = await app(t);
  const { run, stream } = await complete(base, {
    prompt: "生成报告",
    scenario: "weekly",
  });
  assert.equal(run.status, "completed");
  assert.match(stream, /tool_start/);
  assert.match(stream, /completed/);
  const markdown = await fetch(`${base}/api/runs/${run.id}/markdown`);
  assert.equal(markdown.status, 200);
  assert.match(await markdown.text(), /饮食明细/);
  const next = await complete(base, {
    prompt: "米饭改为100克",
    previousRunId: run.id,
  });
  assert.equal(next.run.report.version, 2);
  assert.ok(
    next.run.report.analysis.totals.kcal < run.report.analysis.totals.kcal,
  );
  const replay = await (
    await fetch(`${base}/api/runs/${run.id}/events?after=2`)
  ).text();
  assert.ok(!replay.includes("id: 1\n"));
  assert.ok(replay.includes("id: 3\n"));
});

test("失败重试复用校验；已保存报告可由新服务实例恢复", async (t) => {
  const { base, dataDir } = await app(t);
  const first = await complete(base, {
    prompt: "生成报告",
    scenario: "recovery",
  });
  assert.equal(first.run.status, "failed");
  const second = await complete(base, {
    prompt: "生成报告",
    previousRunId: first.run.id,
    retry: true,
  });
  assert.equal(second.run.status, "completed");
  assert.deepEqual(
    second.run.events
      .filter((e) => e.type === "tool_start")
      .map((e) => e.data.name),
    ["generate_report"],
  );
  const restored = createApp({ dataDir, env: {} });
  assert.equal(
    restored.runs.get(second.run.id).report.title,
    "三日饮食观察报告",
  );
});

test("中断任务启动时标记失败，防止永久运行态", async (t) => {
  const { dataDir } = await app(t);
  const id = randomUUID();
  writeFileSync(
    join(dataDir, `${id}.json`),
    JSON.stringify({ id, status: "running", events: [] }),
  );
  const restored = createApp({ dataDir, env: {} });
  assert.equal(restored.runs.get(id).status, "failed");
  assert.match(restored.runs.get(id).error, /服务已重启/);
});

test("跨站请求、错误输入与未生成报告的下载被拒绝，配置不返回密钥", async (t) => {
  const { base } = await app(t);
  assert.equal(
    (
      await post(
        base,
        { prompt: "生成报告" },
        { Origin: "https://untrusted.example" },
      )
    ).status,
    403,
  );
  assert.equal((await post(base, { prompt: "" })).status, 400);
  assert.equal(
    (await post(base, { prompt: "生成报告", previousRunId: randomUUID() }))
      .status,
    404,
  );
  const { run } = await complete(base, {
    prompt: "一碗米饭",
    scenario: "clarify",
  });
  assert.equal(
    (await fetch(`${base}/api/runs/${run.id}/markdown`)).status,
    409,
  );
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.mode, "demo");
  assert.ok(!Object.hasOwn(config, "apiKey"));
  assert.equal((await fetch(`${base}/.env`)).status, 404);
});
