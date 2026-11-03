import http from "node:http";
import { randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildReport,
  calculateNutrition,
  createMeals,
  reportMarkdown,
  SCENARIOS,
  validateAnalysis,
} from "./domain.js";
import { runDemo, runLive } from "./agent.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/;
const ASSETS = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
};
export function createApp({
  dataDir = join(ROOT, ".local", "runs"),
  env = process.env,
  stepDelay = 350,
  fetchImpl = fetch,
} = {}) {
  mkdirSync(dataDir, { recursive: true });
  const runs = new Map();
  const subscribers = new Map();
  const config = {
    apiKey: env.MODEL_API_KEY || "",
    model: env.MODEL_NAME || "",
    baseURL: env.MODEL_BASE_URL || "https://api.openai.com/v1",
    timeoutMs: Number(env.MODEL_TIMEOUT_MS) || 45000,
  };
  const mode = config.apiKey && config.model ? "live" : "demo";
  const save = (run) => {
    const target = join(dataDir, `${run.id}.json`);
    writeFileSync(`${target}.tmp`, JSON.stringify(run), { mode: 0o600 });
    renameSync(`${target}.tmp`, target);
  };
  for (const file of readdirSync(dataDir).filter((f) =>
    /^[0-9a-f-]+\.json$/.test(f),
  )) {
    try {
      const run = JSON.parse(readFileSync(join(dataDir, file), "utf8"));
      if (!UUID.test(run.id)) continue;
      if (run.status === "running") {
        run.status = "failed";
        run.error = "服务已重启，中间结果仍保留。请重试任务。";
        run.events.push({
          id: run.events.length + 1,
          type: "failed",
          at: new Date().toISOString(),
          data: { error: run.error },
        });
        save(run);
      }
      runs.set(run.id, run);
    } catch {
      /* 不读取损坏文件，不阻止其他报告恢复。 */
    }
  }
  function emit(run, type, data) {
    const event = {
      id: run.events.length + 1,
      type,
      at: new Date().toISOString(),
      data,
    };
    run.events.push(event);
    run.updatedAt = event.at;
    save(run);
    for (const res of subscribers.get(run.id) || [])
      res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  const json = (res, status, value) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  const snapshot = (run) => ({
    id: run.id,
    status: run.status,
    prompt: run.prompt,
    mode: run.mode,
    scenario: run.scenario,
    version: run.version,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    question: run.question,
    answer: run.answer,
    error: run.error,
    report: run.report,
    events: run.events,
  });
  async function body(req) {
    let result = "";
    for await (const chunk of req) {
      result += chunk;
      if (Buffer.byteLength(result) > 24000) throw new Error("请求内容过长。");
    }
    return JSON.parse(result || "{}");
  }
  async function execute(run) {
    const send = (type, data) => emit(run, type, data);
    try {
      send("started", {
        mode: run.mode,
        message:
          run.mode === "live"
            ? "真实模型编排 · 合成饮食数据"
            : "示例编排 · 实际执行计算工具",
      });
      run.answer =
        run.mode === "live"
          ? await runLive(run, send, config, fetchImpl)
          : await runDemo(run, send, { stepDelay });
      if (run.status === "awaiting_input")
        send("awaiting_input", { question: run.question });
      else {
        if (!run.report) throw new Error("任务未产生有效报告。");
        run.status = "completed";
        send("completed", { answer: run.answer, report: run.report });
      }
    } catch (error) {
      run.status = "failed";
      run.error =
        error.name === "TimeoutError"
          ? "模型请求超时，任务已保存，可重试。"
          : error.message;
      send("failed", { error: run.error });
    } finally {
      for (const res of subscribers.get(run.id) || []) res.end();
      subscribers.delete(run.id);
    }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const url = new URL(req.url, "http://localhost");
    try {
      // 本地单人服务：拒绝跨站写入及任意 Host，避免浏览器页面替用户触发模型费用。
      const host = req.headers.host || "";
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host))
        return json(res, 403, { error: "此版本仅支持本机访问。" });
      if (req.headers.origin && req.headers.origin !== `http://${host}`)
        return json(res, 403, { error: "不允许跨站请求。" });
      if (req.method === "GET" && url.pathname === "/api/config")
        return json(res, 200, {
          mode,
          model: mode === "live" ? config.model : null,
          scenarios: SCENARIOS,
          dataKind: "synthetic",
        });
      if (req.method === "GET" && url.pathname === "/api/sample") {
        const analysis = calculateNutrition(createMeals());
        return json(
          res,
          200,
          buildReport(analysis, validateAnalysis(analysis)),
        );
      }
      if (req.method === "POST" && url.pathname === "/api/runs") {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          return json(res, 415, { error: "请使用 JSON 请求。" });
        const input = await body(req);
        if (
          typeof input.prompt !== "string" ||
          !input.prompt.trim() ||
          input.prompt.length > 2000
        )
          return json(res, 400, { error: "请输入 1–2000 字的任务。" });
        if (
          [...runs.values()].filter((r) => r.status === "running").length >= 2
        )
          return json(res, 429, { error: "已有任务执行中，请稍后再试。" });
        const previous = input.previousRunId
          ? runs.get(input.previousRunId)
          : null;
        if (input.previousRunId && !previous)
          return json(res, 404, { error: "上一条任务不存在。请新建任务。" });
        if (previous?.status === "running")
          return json(res, 409, { error: "上一条任务尚未结束。" });
        if (input.scenario && !SCENARIOS.some((s) => s.id === input.scenario))
          return json(res, 400, { error: "示例场景不存在。" });
        const retry = input.retry === true && previous?.status === "failed";
        const scenario =
          input.scenario ||
          (previous?.status === "awaiting_input" ? previous.scenario : null);
        const effectiveMode =
          scenario === "recovery" || (retry && previous.mode === "demo")
            ? "demo"
            : mode;
        const run = {
          id: randomUUID(),
          status: "running",
          mode: effectiveMode,
          scenario,
          prompt: input.prompt.trim(),
          previousRunId: previous?.id || null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: retry
            ? previous.version
            : (previous?.report?.version || 0) + 1,
          events: [],
          meals: previous?.meals ? structuredClone(previous.meals) : null,
          analysis: retry ? previous.analysis : null,
          validation: retry ? previous.validation : null,
          resumeReport: Boolean(
            retry && previous.analysis && previous.validation?.passed,
          ),
          simulateFailure: scenario === "recovery" && !retry,
          history: previous
            ? [
                ...(previous.history || []),
                { role: "user", content: previous.prompt },
                {
                  role: "assistant",
                  content:
                    previous.answer ||
                    previous.question ||
                    previous.error ||
                    "上轮任务已结束。",
                },
              ].slice(-6)
            : [],
          report: null,
        };
        runs.set(run.id, run);
        save(run);
        json(res, 202, { id: run.id, mode: run.mode });
        void execute(run);
        return;
      }
      const match = url.pathname.match(
        /^\/api\/runs\/([0-9a-f-]+)(?:\/(events|markdown))?$/,
      );
      if (match && req.method === "GET") {
        const run = UUID.test(match[1]) && runs.get(match[1]);
        if (!run) return json(res, 404, { error: "任务不存在。" });
        if (match[2] === "markdown") {
          if (!run.report || run.status !== "completed")
            return json(res, 409, { error: "报告尚未生成。" });
          res.writeHead(200, {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": `attachment; filename="nutrition-report-v${run.version}.md"`,
          });
          return res.end(reportMarkdown(run.report));
        }
        if (match[2] === "events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          const after = Number(
            req.headers["last-event-id"] || url.searchParams.get("after") || 0,
          );
          for (const event of run.events.filter((e) => e.id > after))
            res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
          if (run.status !== "running") return res.end();
          if (!subscribers.has(run.id)) subscribers.set(run.id, new Set());
          subscribers.get(run.id).add(res);
          const pulse = setInterval(() => res.write(": heartbeat\n\n"), 15000);
          res.on("close", () => {
            clearInterval(pulse);
            subscribers.get(run.id)?.delete(res);
          });
          return;
        }
        return json(res, 200, snapshot(run));
      }
      if (req.method === "GET" && ASSETS[url.pathname]) {
        const [file, type] = ASSETS[url.pathname];
        res.writeHead(200, {
          "Content-Type": type,
          "Cache-Control": "no-cache",
        });
        return res.end(readFileSync(join(ROOT, "public", file)));
      }
      return json(res, 404, { error: "页面或接口不存在。" });
    } catch (error) {
      if (!res.headersSent)
        json(res, 400, {
          error:
            error instanceof SyntaxError ? "请求格式不正确。" : error.message,
        });
      else res.end();
    }
  });
  return { server, runs, mode };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const host = process.env.HOST || "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host))
    throw new Error(
      "此版本仅面向本机单人使用，HOST 必须为 localhost。公开部署请先实现身份与费用控制。",
    );
  const port = Number(process.env.PORT) || 4371;
  const { server, mode } = createApp();
  server.listen(port, host, () =>
    console.log(
      `NutriAgent Studio\nLocal: http://${host === "::1" ? "[::1]" : host}:${port}\nMode: ${mode === "live" ? "真实模型编排 / 合成数据" : "示例编排 / 合成数据"}`,
    ),
  );
}
