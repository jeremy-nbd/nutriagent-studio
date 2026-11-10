const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const number = (n) =>
  new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(n);
const state = {
  config: null,
  active: null,
  report: null,
  sample: null,
  events: [],
  source: null,
  busy: false,
  tab: "report",
  reports: [],
  pending: null,
};
const storage = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(`nutriagent:${key}`)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`nutriagent:${key}`, JSON.stringify(value));
    } catch {
      toast("浏览器存储不可用；服务器仍保存任务。");
    }
  },
};
state.reports = storage.get("reports", []);
if (!Array.isArray(state.reports)) state.reports = [];

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败，请稍后再试。");
  return data;
}

let toastTimeout;
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    $("#toast").hidden = true;
  }, 4500);
}

function switchView(view) {
  ["workspace", "library", "about"].forEach((name) => {
    $(`#${name}-view`).hidden = name !== view;
  });
  $$(".nav-item").forEach((el) =>
    el.classList.toggle("active", el.dataset.view === view),
  );
  $("#breadcrumb").textContent = {
    workspace: "Agent 工作台",
    library: "我的报告",
    about: "项目与架构",
  }[view];
  if (view === "library") renderLibrary();
}

function setBusy(busy) {
  state.busy = busy;
  $("#send-button").disabled = busy;
  $("#prompt").disabled = busy;
  $("#new-task").disabled = busy;
  $$(".scenario-start").forEach((el) => {
    el.disabled = busy;
  });
  $("#task-state").textContent = busy
    ? "正在执行"
    : state.active?.status === "awaiting_input"
      ? "等待补充"
      : state.active?.status === "failed"
        ? "可重试"
        : "准备就绪";
  $("#task-state").classList.toggle("busy", busy);
  $("#download-md").disabled = busy || state.active?.status !== "completed";
  $("#print-report").disabled = busy || state.active?.status !== "completed";
}

function renderWelcome() {
  const icons = ["▤", "◌", "↻"];
  $("#messages").innerHTML =
    `<div class="welcome"><div class="welcome-icon">✳</div><h3>从一份记录开始，<br>一起看懂饮食。</h3><p>我可以整理记录、计算营养，并生成一份带有依据的报告。先选一个任务，看看我如何完成。</p><div class="suggestions">${state.config.scenarios.map((s, i) => `<button class="suggestion scenario-start" data-scenario="${s.id}"><span class="suggestion-icon">${icons[i]}</span><span><strong>${s.label}</strong><small>${s.description}</small></span><span class="suggestion-arrow">↗</span></button>`).join("")}</div><div class="welcome-footnote">${state.config.mode === "live" ? "当前使用真实模型编排。模型决定调用哪些工具。" : "无需配置密钥。示例采用固定编排，计算工具真实执行。"}<br>所有示例数据均为虚构，不关联个人健康资料。</div></div>`;
}

function appendMessage(role, text, retry = false) {
  const el = document.createElement("div");
  el.className = `chat-message ${role}`;
  el.innerHTML = `<div class="message-name">${role === "user" ? "你" : '<span class="small-symbol">✳</span> NutriAgent'}</div><div class="message-bubble">${escapeHTML(text)}</div>${retry ? '<button class="retry-button" data-retry>↻ 重试失败步骤</button>' : ""}`;
  $("#messages").append(el);
  scrollMessages();
}

function scrollMessages() {
  $("#messages").scrollTop = $("#messages").scrollHeight;
}
function working(text) {
  let el = $("#working-message");
  if (!el) {
    el = document.createElement("div");
    el.id = "working-message";
    el.className = "working";
    $("#messages").append(el);
  }
  el.textContent = text;
  scrollMessages();
}
function stopWorking() {
  $("#working-message")?.remove();
}

const plate = `<svg class="plate-art" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="45" fill="#f1ebdf"/><circle cx="50" cy="50" r="35" fill="#fffdf6" stroke="#e2d6c0"/><path d="M33 32c9-5 17-4 19 5s-3 18-13 17-16-15-6-22Z" fill="#b6bd8b"/><circle cx="31" cy="36" r="7" fill="#9da972"/><circle cx="39" cy="30" r="8" fill="#a9b47d"/><circle cx="45" cy="39" r="8" fill="#a3b178"/><path d="M55 30c7-3 18 7 19 15 2 9-5 12-13 9-10-4-13-20-6-24Z" fill="#d6a17b"/><path d="m57 35 12 11m-13-5 10 10" stroke="#f3d0b1" stroke-width="2"/><path d="M31 60c3-9 19-8 25-3 9 7 5 16-7 17-11 0-23-4-18-14Z" fill="#e5d8b4"/><path d="m38 61 5 2m3-5 5 3m-11 6 5 2m6-4 4 2" stroke="#f9f1d8" stroke-width="2" stroke-linecap="round"/><circle cx="68" cy="66" r="5" fill="#b97450"/><circle cx="62" cy="71" r="4" fill="#c98a62"/></svg>`;

function reportHTML(report) {
  const a = report.analysis;
  const max = Math.max(...a.days.map((d) => d.kcal)) * 1.13;
  return `<article class="report-sheet"><div class="sheet-kicker"><strong><span>✳</span> NUTRIAGENT / FIELD NOTES</strong><span>NUTRITION REPORT</span></div><div class="report-title-row"><div><h2>${escapeHTML(report.title)}</h2><p>${a.days[0].date.replaceAll("-", ".")} — ${a.days.at(-1).date.replaceAll("-", ".")} <span> / </span> ${a.rows.length} 条已记录饮食</p><span class="report-tag">合成示例 · 计算来源可追溯</span></div>${plate}</div><div class="metric-grid">${[
    ["已记录日均能量", "kcal", "kcal"],
    ["蛋白质", "protein", "g"],
    ["碳水化合物", "carbs", "g"],
    ["脂肪", "fat", "g"],
  ]
    .map(
      ([label, key, unit]) =>
        `<div class="metric"><small>${label}</small><strong>${number(a.average[key])}<span>${unit}</span></strong></div>`,
    )
    .join(
      "",
    )}</div><section class="report-section"><div class="chart-heading"><h3><span class="section-number">01</span> 每日营养概览</h3><div class="chart-legend"><span><i class="legend-protein"></i>蛋白质</span><span><i class="legend-carbs"></i>碳水</span><span><i class="legend-fat"></i>脂肪</span></div></div><div class="chart" role="img" aria-label="三日已记录能量：${a.days.map((d) => `${d.date} ${d.kcal}千卡`).join("；")}"><span class="chart-unit">kcal</span>${a.days
    .map((d) => {
      const energy = d.protein * 4 + d.carbs * 4 + d.fat * 9;
      return `<div class="chart-col"><span class="chart-value">${number(d.kcal)}</span><div class="chart-stack" style="height:${(d.kcal / max) * 72}px"><span class="segment-protein" style="height:${((d.protein * 4) / energy) * 100}%"></span><span class="segment-carbs" style="height:${((d.carbs * 4) / energy) * 100}%"></span><span class="segment-fat" style="height:${((d.fat * 9) / energy) * 100}%"></span></div></div>`;
    })
    .join(
      "",
    )}</div><div class="chart-labels">${a.days.map((d) => `<span>${d.date.slice(5).replace("-", "/")}</span>`).join("")}</div><div class="chart-note">柱高为参考表能量；色块按三大营养素 4/4/9 系数归一化，仅作构成示意。</div></section><section class="report-section"><h3><span class="section-number">02</span> 从记录中看到的饮食特点</h3><div class="observations">${report.observations.map((o) => `<div class="observation"><strong><span>↗</span>${escapeHTML(o.title)}</strong><p>${escapeHTML(o.text)}</p></div>`).join("")}</div></section><div class="sheet-footnote"><span>依据项目内示例参考表计算。已记录不代表完整摄入；<br>无个体目标，不作营养达标判断。</span><span>NUTRIAGENT STUDIO<br>REPORT / V${report.version}</span></div></article>`;
}

function evidenceHTML(report, print = false) {
  const a = report.analysis;
  return `<article class="report-sheet ${print ? "print-evidence" : ""}"><div class="sheet-kicker"><strong>DATA & EVIDENCE</strong><span>DETERMINISTIC COMPUTATION</span></div><h2 class="evidence-title">每个数字，都有出处。</h2><p class="evidence-intro">${escapeHTML(a.sourceNote)}<br>能量 = 每 100 g 参考值 × 实际份量 ÷ 100。已包含示例烹调油。</p><div class="validation-box">✓ ${report.validation.checks.map(escapeHTML).join(" · ")}<br>${escapeHTML(report.validation.note)}</div><table class="evidence-table"><thead><tr><th>原料</th><th>份量</th><th>换算过程</th><th>kcal</th></tr></thead><tbody>${a.rows.map((row) => `<tr class="group-row"><td colspan="4">${row.date} / ${row.slot} · ${escapeHTML(row.name)}</td></tr>${row.evidence.map((e) => `<tr><td>${escapeHTML(e.name)}<small>合成参考表 / ${escapeHTML(e.food)}</small></td><td>${e.grams} g</td><td>${e.formula}</td><td>${e.kcal}</td></tr>`).join("")}`).join("")}</tbody></table></article>`;
}

function renderReport() {
  const report = state.report || state.sample;
  if (!report) return;
  $("#report-container").innerHTML =
    state.tab === "evidence" ? evidenceHTML(report) : reportHTML(report);
  $("#version-badge").textContent = state.report
    ? `V${report.version}`
    : "样张";
  $("#report-footer-label").textContent = state.report
    ? state.busy
      ? "上一版报告 · 新任务执行中"
      : "计算已校验 · 已保存在本机"
    : "示例样张 · 尚未运行任务";
}

function traceDescription(event) {
  const result = event.data.result;
  if (event.type === "tool_error") return event.data.error;
  if (event.type === "tool_start") return "正在执行…";
  if (!result) return event.data.message || "";
  if (event.data.name === "get_meal_records")
    return `${result.records} 条合成记录 · ${result.dates.join(" / ")}`;
  if (event.data.name === "revise_rice_portion")
    return `最近一日午餐米饭已更新为 ${result.grams} g；旧计算已失效。`;
  if (event.data.name === "calculate_nutrition")
    return `已记录日均 ${result.average.kcal} kcal · 由参考表和份量确定性计算`;
  if (event.data.name === "validate_report_data")
    return result.checks.join(" · ");
  if (event.data.name === "generate_report")
    return `${result.title} · V${result.version}`;
  if (event.data.name === "ask_user") return result.question;
  return "";
}

function renderTrace() {
  const rows = [];
  for (const event of state.events) {
    if (event.type === "tool_start") rows.push({ start: event, end: null });
    if (event.type === "tool_end" || event.type === "tool_error") {
      const row = rows.findLast(
        (r) => !r.end && r.start.data.name === event.data.name,
      );
      if (row) row.end = event;
    }
    if (event.type === "model") rows.push({ start: event, end: event });
  }
  $("#trace-list").innerHTML = rows.length
    ? rows
        .map((row) => {
          const e = row.end || row.start;
          const failed = e.type === "tool_error";
          const label =
            e.type === "model"
              ? `模型编排 · 第 ${e.data.round} 轮`
              : e.data.label;
          return `<div class="trace-row ${failed ? "failed" : !row.end ? "pending" : ""}"><span class="trace-status">${failed ? "!" : !row.end ? "·" : "✓"}</span><div class="trace-details"><strong>${escapeHTML(label)}</strong><span>${escapeHTML(e.data.name || e.data.model)}</span><p>${escapeHTML(traceDescription(e))}</p>${row.end && e.data.result ? `<details><summary>查看工具结果</summary><pre>${escapeHTML(JSON.stringify(e.data.result, null, 2))}</pre></details>` : ""}</div><span class="trace-time">${e.data.durationMs !== undefined ? `${e.data.durationMs} ms` : ""}</span></div>`;
        })
        .join("")
    : '<div class="trace-row"><div class="trace-details"><p>启动任务后，这里会展示实际工具调用、结果与执行耗时。</p></div></div>';
  const complete = rows.filter((r) => r.end?.type === "tool_end").length;
  $("#trace-summary").textContent = rows.length
    ? `${complete} 个工具已完成${state.busy ? " · 执行中" : ""}`
    : "等待开始任务";
  $("#trace-mode").textContent = state.active
    ? state.active.mode === "live"
      ? "真实模型编排 · 合成数据"
      : "示例编排 · 合成数据"
    : "真实工具结果，无隐藏思维链";
}

function rememberReport() {
  const r = state.active;
  if (!r?.report || r.status !== "completed") return;
  state.reports = [
    {
      id: r.id,
      title: r.report.title,
      version: r.report.version,
      kcal: r.report.analysis.average.kcal,
      createdAt: r.createdAt,
      mode: r.mode,
    },
    ...state.reports.filter((x) => x.id !== r.id),
  ].slice(0, 60);
  storage.set("reports", state.reports);
  $("#report-count").textContent = state.reports.length;
}

function connectEvents(id, after = 0) {
  state.source?.close();
  const source = new EventSource(`/api/runs/${id}/events?after=${after}`);
  state.source = source;
  source.onmessage = (message) => {
    if (state.active?.id !== id) return;
    const event = JSON.parse(message.data);
    if (state.events.some((e) => e.id === event.id)) return;
    state.events.push(event);
    if (event.type === "tool_start") working(event.data.label + "…");
    if (event.type === "model") working("模型正在选择下一步工具…");
    if (event.type === "message") appendMessage("assistant", event.data.text);
    if (event.type === "completed") {
      source.close();
      stopWorking();
      state.active.status = "completed";
      state.active.report = event.data.report;
      state.active.answer = event.data.answer;
      state.report = event.data.report;
      setBusy(false);
      renderReport();
      appendMessage("assistant", event.data.answer);
      rememberReport();
    }
    if (event.type === "awaiting_input") {
      source.close();
      stopWorking();
      state.active.status = "awaiting_input";
      state.active.question = event.data.question;
      setBusy(false);
      appendMessage("assistant", event.data.question);
      $("#prompt").placeholder = "例如：米饭实际吃了 100 克";
      $("#prompt").focus();
    }
    if (event.type === "failed") {
      source.close();
      stopWorking();
      state.active.status = "failed";
      state.active.error = event.data.error;
      setBusy(false);
      appendMessage("error", event.data.error, true);
    }
    renderTrace();
  };
  source.onerror = async () => {
    try {
      const snapshot = await api(`/api/runs/${id}`);
      if (
        snapshot.status !== "running" &&
        state.active?.id === id &&
        state.busy
      ) {
        source.close();
        await loadRun(id);
      } else if (state.busy) working("连接中断，正在恢复执行记录…");
    } catch {
      working("服务暂时不可达，连接恢复后会继续同步…");
    }
  };
}

async function submit(
  prompt,
  { scenario = null, fresh = false, retry = false } = {},
) {
  if (state.busy || !prompt.trim()) return;
  switchView("workspace");
  const previous = fresh ? null : state.active;
  if (fresh || !state.active) {
    $("#messages").innerHTML = "";
    state.report = null;
  }
  appendMessage("user", retry ? "重试上一次失败的任务。" : prompt);
  setBusy(true);
  working("正在创建任务…");
  try {
    const result = await api("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        scenario,
        previousRunId: previous?.id,
        retry,
      }),
    });
    state.active = {
      id: result.id,
      prompt,
      mode: result.mode,
      status: "running",
      createdAt: new Date().toISOString(),
      scenario,
    };
    state.events = [];
    storage.set("active", result.id);
    $("#prompt").value = "";
    $("#prompt").placeholder = "继续补充，例如：最后一天午餐米饭只吃了 100 克";
    state.tab = "report";
    $$(".report-tabs button").forEach((el) =>
      el.classList.toggle("active", el.dataset.tab === state.tab),
    );
    renderReport();
    renderTrace();
    connectEvents(result.id);
  } catch (error) {
    stopWorking();
    setBusy(false);
    appendMessage("error", error.message);
  }
}

async function loadRun(id) {
  const run = await api(`/api/runs/${id}`);
  state.source?.close();
  state.active = run;
  state.events = run.events;
  state.report = run.report;
  storage.set("active", id);
  $("#messages").innerHTML = "";
  appendMessage("user", run.prompt);
  if (run.status === "completed") appendMessage("assistant", run.answer);
  if (run.status === "awaiting_input") appendMessage("assistant", run.question);
  if (run.status === "failed") appendMessage("error", run.error, true);
  setBusy(run.status === "running");
  renderReport();
  renderTrace();
  if (run.status === "running") {
    working("已恢复任务，正在同步进度…");
    connectEvents(id, run.events.at(-1)?.id || 0);
  }
  rememberReport();
  switchView("workspace");
}

function renderLibrary() {
  $("#library-list").innerHTML = state.reports.length
    ? state.reports
        .map(
          (r) =>
            `<button class="library-card panel" data-run="${escapeHTML(r.id)}"><div class="eyebrow">NUTRITION / V${r.version}</div><h3>${escapeHTML(r.title)}</h3><p>合成饮食记录 · ${r.mode === "live" ? "真实模型编排" : "示例编排"}<br>工具计算与来源已校验</p><div class="library-value">${number(r.kcal)} <small>kcal / 已记录日均</small></div><footer><span>${new Date(r.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span><span>查看与修订 ↗</span></footer></button>`,
        )
        .join("")
    : '<div class="empty-state panel"><div class="welcome-icon" style="margin:0 auto">▤</div><h3>你的第一份报告，从这里开始。</h3><p>完成一次分析后，报告会自动出现在这里。<br>每次修订都会保留独立版本。</p><button class="button primary" data-start-first>生成第一份报告 ↗</button></div>';
}

function newTask() {
  if (state.busy) return;
  state.source?.close();
  state.active = null;
  state.report = null;
  state.events = [];
  state.tab = "report";
  storage.set("active", null);
  $("#prompt").value = "";
  $("#prompt").placeholder = "描述你的任务，或选择上面的示例…";
  $$(".report-tabs button").forEach((el) =>
    el.classList.toggle("active", el.dataset.tab === "report"),
  );
  renderWelcome();
  renderReport();
  renderTrace();
  setBusy(false);
  switchView("workspace");
}

document.addEventListener("click", async (event) => {
  const scenarioButton = event.target.closest("[data-scenario]");
  if (scenarioButton) {
    const s = state.config.scenarios.find(
      (x) => x.id === scenarioButton.dataset.scenario,
    );
    if (s) await submit(s.prompt, { scenario: s.id, fresh: true });
  }
  const nav = event.target.closest("[data-view]");
  if (nav) switchView(nav.dataset.view);
  const tab = event.target.closest("[data-tab]");
  if (tab) {
    state.tab = tab.dataset.tab;
    $$(".report-tabs button").forEach((el) =>
      el.classList.toggle("active", el === tab),
    );
    renderReport();
  }
  if (event.target.closest("[data-retry]") && state.active?.status === "failed")
    await submit(state.active.prompt, { retry: true });
  const report = event.target.closest("[data-run]");
  if (report) {
    if (state.busy) return toast("请等待当前任务完成，再打开其他报告。");
    try {
      await loadRun(report.dataset.run);
    } catch (error) {
      toast(error.message);
    }
  }
  if (event.target.closest("[data-start-first]")) {
    const s = state.config.scenarios[0];
    await submit(s.prompt, { scenario: s.id, fresh: true });
  }
});
$("#chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void submit($("#prompt").value);
});
$("#prompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("#chat-form").requestSubmit();
  }
});
$("#new-task").addEventListener("click", newTask);
$("#trace-toggle").addEventListener("click", () => {
  const open = $("#trace-list").hidden;
  $("#trace-list").hidden = !open;
  $("#trace-toggle").setAttribute("aria-expanded", String(open));
  $("#trace-chevron").textContent = open ? "⌃" : "⌄";
  renderTrace();
});
$("#settings-button").addEventListener("click", () =>
  $("#settings-dialog").showModal(),
);
$("#close-settings").addEventListener("click", () =>
  $("#settings-dialog").close(),
);
$("#settings-done").addEventListener("click", () =>
  $("#settings-dialog").close(),
);
$("#help-button").addEventListener("click", () => switchView("about"));
$("#expand-report").addEventListener("click", () => {
  const open = $(".report-panel").classList.toggle("expanded");
  $("#expand-report").setAttribute(
    "aria-label",
    open ? "收起报告" : "展开报告",
  );
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") $(".report-panel").classList.remove("expanded");
});
$("#download-md").addEventListener("click", () => {
  if (state.active?.status === "completed")
    window.location.href = `/api/runs/${state.active.id}/markdown`;
});
$("#print-report").addEventListener("click", () => {
  if (!state.report || state.active?.status !== "completed") return;
  $("#print-root").innerHTML =
    reportHTML(state.report) +
    `<div class="print-limitations"><h3>使用范围与限制</h3><ul>${state.report.limitations.map((x) => `<li>${escapeHTML(x)}</li>`).join("")}</ul><p>${escapeHTML(state.report.validation.note)}</p></div>` +
    evidenceHTML(state.report, true);
  const original = document.title;
  document.title = `NutriAgent-饮食报告-V${state.report.version}`;
  window.print();
  document.title = original;
});

async function boot() {
  try {
    const [config, sample] = await Promise.all([
      api("/api/config"),
      api("/api/sample"),
    ]);
    state.config = config;
    $("#connection-status").textContent =
      config.mode === "live"
        ? `已配置 ${config.provider} · ${config.configuredModel}，温度 ${config.temperature}，单次请求超时 ${config.timeoutSeconds} 秒。连接结果以实际任务为准。`
        : config.configuredModel
          ? `已选择 ${config.provider} · ${config.configuredModel}，等待在本地填写 API Key。`
          : "尚未配置模型，当前使用示例模式。";
    state.sample = sample;
    $("#mode-badge").innerHTML =
      `<i></i>${config.mode === "live" ? "真实模型 · 示例数据" : "示例模式 · 无需密钥"}`;
    $("#sidebar-scenarios").innerHTML = config.scenarios
      .map(
        (s) =>
          `<button class="scenario-start" data-scenario="${s.id}"><span class="scenario-dot"></span>${s.label}</button>`,
      )
      .join("");
    $("#report-count").textContent = state.reports.length;
    renderWelcome();
    renderReport();
    renderTrace();
    const active = storage.get("active", null);
    if (active) {
      try {
        await loadRun(active);
      } catch {
        storage.set("active", null);
        toast("历史任务不可用，已打开新的工作空间。");
      }
    }
  } catch (error) {
    $("#mode-badge").textContent = "服务连接失败";
    $("#messages").innerHTML =
      `<div class="welcome"><h3>暂时无法连接服务。</h3><p>${escapeHTML(error.message)}<br>请确认已运行 python3 run.py，然后刷新页面。</p></div>`;
    $("#send-button").disabled = true;
  }
}
void boot();
