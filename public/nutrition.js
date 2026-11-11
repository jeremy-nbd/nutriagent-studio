const basePath = location.pathname.startsWith("/family/") ? "/family" : "";
let draftKey = "nutriagent:foodDraft";
let trendMetric = "grams";
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const num = (n) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(n);
const state = {
  config: null,
  image: null,
  draft: null,
  busy: false,
  day: null,
  period: "day",
  stats: null,
  summaryBusy: false,
  summaryEpoch: 0,
  dayEpoch: 0,
  requestId: null,
  inputSignature: null,
  view: "record",
};
const nutrients = [
  ["kcal", "热量", "kcal"],
  ["protein", "蛋白质", "g"],
  ["carbs", "碳水", "g"],
  ["fat", "脂肪", "g"],
];
const slotIcon = { 早餐: "☀", 午餐: "◒", 晚餐: "☾", 加餐: "◌" };
function rememberDraft(id) {
  try {
    if (id) localStorage.setItem(draftKey, id);
    else localStorage.removeItem(draftKey);
  } catch {}
}
async function api(path, options = {}) {
  const response = await fetch(basePath + path, options);
  if (response.status === 401) { location.replace(basePath + "/login"); throw new Error("请重新登录。"); }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("服务返回异常，请确认服务正在运行后重试。");
  }
  if (!response.ok) throw new Error(data.error || "请求失败，请重试。");
  return data;
}
const send = (path, body, method = "POST") =>
  api(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
let toastTimer;
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 4500);
}
function showError(id, message) {
  $(id).textContent = message;
  $(id).hidden = !message;
}
function empty(title, text, small = false) {
  return `<div class="empty-state ${small ? "small" : ""}">${small ? "" : '<div class="empty-illustration">◯</div>'}<h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;
}
function metricHTML(totals, averages = null) {
  return nutrients
    .map(
      ([key, label, unit]) =>
        `<div class="metric"><label>${label}</label><strong>${num(totals?.[key])}<small>${unit}</small></strong>${averages ? `<small>记录日日均 ${num(averages[key])} ${unit}</small>` : ""}</div>`,
    )
    .join("");
}
function setBusy(busy) {
  state.busy = busy;
  $$(
    "#meal-form input,#meal-form textarea,#meal-form select,#meal-form button",
  ).forEach((el) => (el.disabled = busy));
  if (!busy) $("#analyze").disabled = !state.config?.textReady;
  $("#analysis-status").hidden = !busy;
  if (busy)
    $("#analysis-status").textContent = state.image
      ? "正在识别图片中的食物、份量和营养参考值，可能需要一点时间…"
      : "正在整理饮食描述并估算营养，请稍候…";
  $("#analyze").innerHTML = busy
    ? "<span>✳</span> 正在识别…"
    : "<span>✳</span> 识别这餐饮食 <span>↗</span>";
}
function switchView(view) {
  state.view = view;
  $("#record-view").hidden = view !== "record";
  $("#summary-view").hidden = view !== "summary";
  $("#advisor-view").hidden = view !== "advisor";
  $("#admin-view").hidden = view !== "admin";
  if (view === "advisor") void loadAdvisor();
  if (view === "admin") void loadAdmin();
  $$(".nav").forEach((el) =>
    el.classList.toggle("active", el.dataset.view === view),
  );
  if (view === "summary") void refreshSummary();
}
function mealHTML(meal, actions = true) {
  return `<article class="meal-row" data-record-id="${esc(meal.id)}"><div class="meal-icon">${slotIcon[meal.slot] || "◌"}</div><div class="meal-row-main"><div class="meal-row-heading"><h3>${esc(meal.title)}</h3><span>${num(meal.totals.kcal)} <small>kcal</small></span></div><p>${meal.items.map((i) => `${esc(i.name)} ${i.grams == null ? "重量未知" : `${num(i.grams)}g`}`).join(" · ")}</p><div class="meal-row-meta"><span>${esc(meal.slot)}</span><span>${meal.source === "manual" ? "手动填写" : "营养为 AI 估算"}</span>${actions ? `${meal.source === "manual" ? "" : `<button data-edit="${esc(meal.id)}">修改份量</button>`}<button data-consult-date="${esc(meal.date)}">营养师解读</button><button data-delete="${esc(meal.id)}" data-revision="${meal.revision}">移除</button>` : ""}</div></div></article>`;
}
async function refreshDay() {
  const epoch = ++state.dayEpoch;
  const date = $("#meal-date").value;
  if (!date) return;
  $("#day-panel-title").textContent =
    date === state.config.today
      ? "今日已记录"
      : `${date.slice(5).replace("-", "月")}日已记录`;
  try {
    const data = await api(`/api/nutrition/overview?date=${date}&period=day`);
    if (epoch !== state.dayEpoch) return;
    state.day = data;
    $("#day-count").textContent = data.mealCount
      ? `${data.mealCount} 餐 · ${data.records.reduce((n, r) => n + r.items.length, 0)} 项食物`
      : "从第一餐开始";
    $("#day-metrics").innerHTML = metricHTML(data.totals);
    $("#meal-list").innerHTML = data.mealCount
      ? data.records.map((r) => mealHTML(r)).join("")
      : empty(
          "这一天，还没有饮食记录",
          "拍张照片或写下一餐，确认后就会出现在这里。",
        );
  } catch (error) {
    if (epoch === state.dayEpoch)
      $("#meal-list").innerHTML = empty("暂时无法读取记录", error.message);
  }
}
async function refreshDrafts() {
  try {
    const drafts = await api("/api/nutrition/drafts");
    const other = drafts.filter((d) => d.id !== state.draft?.id);
    $("#pending-drafts").hidden = !other.length;
    $("#pending-drafts").innerHTML =
      `<span>还有 ${other.length} 份待确认记录</span>${other
        .slice(0, 5)
        .map(
          (d) =>
            `<button data-open-draft="${esc(d.id)}">${esc(d.date.slice(5))} ${esc(d.title)} ↗</button>`,
        )
        .join("")}`;
  } catch {
    /* 不影响当前识别表单；记录列表的读取错误单独展示。 */
  }
}
async function loadImage(file) {
  if (state.busy) return;
  showError("#form-error", "");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    return showError(
      "#form-error",
      "请使用 JPG、PNG 或 WebP 图片，暂不支持 HEIC。",
    );
  if (file.size > 6 * 1024 * 1024)
    return showError("#form-error", "图片超过6 MB，请选择较小的图片。");
  if (!state.config?.imageReady)
    return showError(
      "#form-error",
      "视觉模型尚未配置，请在本地 .env 设置 VLM_DEFAULT_MODEL_ID 后重启。",
    );
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("图片读取失败。"));
    reader.readAsDataURL(file);
  });
  state.image = data;
  $("#preview-image").src = data;
  $("#image-name").textContent = file.name;
  $("#image-preview").hidden = false;
  $("#upload-zone").hidden = true;
  state.requestId = null;
}
function clearImage() {
  state.image = null;
  $("#preview-image").removeAttribute("src");
  $("#food-image").value = "";
  $("#image-preview").hidden = true;
  $("#upload-zone").hidden = false;
  state.requestId = null;
}
async function analyze(event) {
  event.preventDefault();
  if (state.busy) return;
  showError("#form-error", "");
  const text = $("#meal-text").value.trim();
  if (!text && !state.image)
    return showError("#form-error", "先上传食物图片，或者写下这一餐吃了什么。");
  const input = {
    date: $("#meal-date").value,
    slot: $("#meal-slot").value,
    text,
    image: state.image,
  };
  const signature = JSON.stringify(input);
  if (state.inputSignature !== signature || !state.requestId) {
    state.requestId = crypto.randomUUID();
    state.inputSignature = signature;
  }
  setBusy(true);
  try {
    const draft = await send("/api/nutrition/analyze", {
      ...input,
      requestId: state.requestId,
    });
    showDraft(draft);
    void refreshDrafts();
  } catch (error) {
    showError("#form-error", error.message);
  } finally {
    setBusy(false);
  }
}
function showDraft(draft) {
  state.draft = draft;
  rememberDraft(draft.status === "draft" ? draft.id : null);
  switchView("record");
  $("#draft-panel").hidden = false;
  $("#draft-title").textContent =
    draft.status === "saved"
      ? `修改份量 · ${draft.title}`
      : `识别结果 · ${draft.title}`;
  $("#draft-model").textContent = draft.model;
  if (!draft.items.length) {
    $("#draft-content").innerHTML =
      `${empty("还需要一点信息", draft.question, true)}<div class="draft-actions"><span>未识别到食物，不会计入营养汇总。</span><button class="button secondary" data-discard>返回重新描述</button></div>`;
  } else {
    const amountLabels = {
      extracted: "从描述提取 · 请核对",
      estimated: "AI 估计份量",
      unknown: "需要补充份量",
      user_corrected: "你修订的份量",
    };
    $("#draft-content").innerHTML =
      `<div class="draft-explanation">${esc(draft.date)} · ${esc(draft.slot)} &nbsp; 请核对吃下的食物和克数，取消勾选没有吃的项目。份量可以修改；食物识别不对时，请补充描述重新识别。<br>营养值来自 AI 每100克参考估算，按份量换算，不代表称重或检测结果。</div><p class="table-hint">左右滑动表格，查看全部营养和「计入」选项 →</p><div class="draft-table-wrap"><table class="draft-table"><thead><tr><th>食物</th><th>吃了多少</th><th>热量</th><th>蛋白质</th><th>碳水</th><th>脂肪</th><th>计入</th></tr></thead><tbody>${draft.items.map((item) => `<tr data-food="${esc(item.id)}"><td class="food-cell"><strong>${esc(item.name)}</strong><small>原描述：${esc(item.portion)}${item.note ? ` · ${esc(item.note)}` : ""}</small></td><td class="amount-cell"><input type="number" inputmode="decimal" step="0.1" min="0.1" max="5000" value="${item.grams ?? ""}" data-grams="${esc(item.id)}" aria-label="${esc(item.name)}克数"><span>g</span><button type="button" class="halve-button" data-halve="${esc(item.id)}">吃了一半</button><small class="source-label ${item.amountSource === "estimated" ? "estimated" : ""}">${amountLabels[item.amountSource] || "待核对"}</small></td>${nutrients.map(([key, , unit]) => `<td class="nutrition-number" data-value="${key}">${num(item.nutrition?.[key])}<small>${unit}</small></td>`).join("")}<td><input class="exclude-checkbox" type="checkbox" checked data-include="${esc(item.id)}" aria-label="计入${esc(item.name)}"></td></tr>`).join("")}</tbody></table></div><div class="draft-total"><span id="draft-total-label">这餐营养合计</span><div id="draft-total-values" class="draft-total-values"></div></div>${draft.notes.length ? `<ul class="draft-notes">${draft.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}<div class="draft-actions"><span>日期与餐次：${esc(draft.date)} / ${esc(draft.slot)}<br>确认后才会计入日、周总结。</span><div><button class="button secondary" data-discard>${draft.status === "saved" ? "取消修改" : "暂不保存"}</button><button class="button primary" id="save-meal">${draft.status === "saved" ? "保存份量修改" : "确认并保存这餐"} ↗</button></div></div><div id="draft-error" class="error-box" role="alert" hidden></div>`;
    recalculateDraft();
  }
  $("#draft-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}
function currentItems() {
  return state.draft.items
    .filter((i) => $(`[data-include="${i.id}"]`)?.checked)
    .map((i) => ({
      id: i.id,
      grams:
        $(`[data-grams="${i.id}"]`).value === ""
          ? null
          : Number($(`[data-grams="${i.id}"]`).value),
    }));
}
function recalculateDraft() {
  if (!state.draft?.items.length) return;
  const total = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  let missing = 0,
    count = 0;
  for (const item of state.draft.items) {
    const input = $(`[data-grams="${item.id}"]`);
    const grams = input.value === "" ? null : Number(input.value);
    const valid = Number.isFinite(grams) && grams > 0 && grams <= 5000;
    const included = $(`[data-include="${item.id}"]`).checked;
    const row = $(`[data-food="${item.id}"]`);
    row.classList.toggle("excluded", !included);
    if (included) {
      count++;
      if (!valid) missing++;
    }
    for (const [key, , unit] of nutrients) {
      const value = valid ? (item.per100g[key] * grams) / 100 : null;
      row.querySelector(`[data-value="${key}"]`).innerHTML =
        `${num(value)}<small>${unit}</small>`;
      if (included && value !== null) total[key] += value;
    }
  }
  $("#draft-total-values").innerHTML = nutrients
    .map(
      ([key, label, unit]) =>
        `<span><small>${label}</small><strong>${num(total[key])}</strong>${unit}</span>`,
    )
    .join("");
  $("#draft-total-label").textContent = missing
    ? `已知份量小计 · ${missing}项需补充`
    : `这餐营养合计 · ${count}项食物`;
  $("#save-meal").disabled = missing > 0 || count === 0;
}
async function saveMeal() {
  const draft = state.draft;
  if (!draft) return;
  const button = $("#save-meal");
  button.disabled = true;
  showError("#draft-error", "");
  try {
    const payload = {
      revision: draft.revision,
      items: currentItems(),
      date: draft.date,
      slot: draft.slot,
    };
    const saved = await send(
      `/api/nutrition/records/${draft.id}${draft.status === "saved" ? "" : "/confirm"}`,
      payload,
      draft.status === "saved" ? "PATCH" : "POST",
    );
    state.draft = null;
    rememberDraft(null);
    $("#draft-panel").hidden = true;
    $("#meal-date").value = saved.date;
    state.requestId = null;
    $("#meal-text").value = "";
    clearImage();
    await refreshDay();
    await refreshDrafts();
    state.stats = null;
    state.summaryEpoch++;
    toast("这餐已保存，日、周统计已更新。");
    $(".day-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showError("#draft-error", error.message);
    button.disabled = false;
  }
}
async function openRecord(id) {
  if (state.busy) return toast("请等待当前识别完成。");
  try {
    showDraft(await api(`/api/nutrition/records/${id}`));
    void refreshDrafts();
  } catch (error) {
    toast(error.message);
  }
}
async function removeRecord(id, revision) {
  if (!window.confirm("将这餐从饮食记录和日、周统计中移除？")) return;
  try {
    await send(
      `/api/nutrition/records/${id}`,
      { revision: Number(revision) },
      "DELETE",
    );
    if (state.draft?.id === id) {
      state.draft = null;
      rememberDraft(null);
      $("#draft-panel").hidden = true;
    }
    state.summaryEpoch++;
    await refreshDay();
    await refreshDrafts();
    if (state.view === "summary") await refreshSummary();
    toast("已移除，这餐不再计入统计。");
  } catch (error) {
    toast(error.message);
  }
}
async function refreshSummary() {
  const date = $("#summary-date").value;
  if (!date) return;
  const epoch = ++state.summaryEpoch;
  state.summaryBusy = false;
  state.stats = null;
  $("#generate-summary").disabled = true;
  showError("#summary-error", "");
  $("#summary-content").innerHTML = empty(
    "整理这段时间的记录",
    "正在读取已确认的饮食…",
    true,
  );
  try {
    const stats = await api(
      `/api/nutrition/overview?date=${date}&period=${state.period}`,
    );
    if (epoch !== state.summaryEpoch) return;
    state.stats = stats;
    $("#summary-title").textContent =
      state.period === "week" ? "本周已记录营养总量" : "当日已记录营养总量";
    $("#range-label").textContent =
      stats.start === stats.end
        ? `${stats.start} · 北京时间`
        : `${stats.start} — ${stats.end} · 周一至周日`;
    $("#coverage-badge").textContent =
      state.period === "week"
        ? `已记录 ${stats.recordedDays} / 7 天`
        : `已记录 ${stats.mealCount} 餐`;
    $("#summary-metrics").innerHTML = metricHTML(
      stats.totals,
      state.period === "week" ? stats.averagePerRecordedDay : null,
    );
    $("#summary-coverage").textContent =
      state.period === "week"
        ? `本周${stats.recordedDays}天有饮食记录，${stats.missingDays}天未记录。日均按有记录的${stats.recordedDays}天计算；未记录日不按0摄入处理。${stats.notice}`
        : stats.notice;
    $("#week-chart").hidden = state.period !== "week";
    $("#trend-controls").hidden = state.period !== "week";
    renderDailyTable(stats);
    if (state.period === "week") renderChart(stats);
    $("#period-count").textContent = `${stats.mealCount} 餐`;
    $("#period-list").innerHTML = stats.mealCount
      ? `<div class="meal-list">${stats.days
          .filter((d) => d.recorded)
          .map(
            (d) =>
              `<div class="period-date">${d.date}</div>${stats.records
                .filter((r) => r.date === d.date)
                .map((r) => mealHTML(r, false))
                .join("")}`,
          )
          .join("")}</div>`
      : empty("还没有可汇总的记录", "先记录一餐，确认保存后再来查看。", true);
    $("#summary-content").innerHTML = stats.mealCount
      ? empty(
          "看看这段时间的饮食特点",
          "点击“生成总结”，AI 会基于已有食物记录给出观察与建议。",
          true,
        )
      : empty(
          "有记录，才能有总结",
          "这段时间暂无已确认饮食，不会生成虚构的营养分析。",
          true,
        );
    $("#generate-summary").disabled =
      !stats.mealCount || !state.config.textReady;
    $("#generate-summary").textContent = "生成总结 ↗";
  } catch (error) {
    if (epoch === state.summaryEpoch) {
      showError("#summary-error", error.message);
      $("#summary-content").innerHTML = empty(
        "读取记录失败",
        "请稍后重新选择日期。",
        true,
      );
    }
  }
}
function renderDailyTable(stats) {
  $("#daily-rows").innerHTML = stats.days.map(d => `<tr class="${d.recorded ? "" : "unrecorded"}"><th scope="row">${esc(d.date.slice(5).replace("-", "/"))}<small>${d.recorded ? "已记录" : "未记录"}</small></th><td>${d.recorded ? d.count : "—"}</td><td>${d.recorded ? num(d.grams) : "—"}${d.unknownPortions ? `<small>${d.unknownPortions} 项重量未知</small>` : ""}</td>${nutrients.map(([k]) => `<td>${num(d.totals?.[k])}</td>`).join("")}</tr>`).join("");
}
function renderChart(stats) {
  const weight = trendMetric === "grams";
  const value = d => weight ? d.grams : d.totals?.kcal;
  const max = Math.max(1, ...stats.days.map(d => value(d) ?? 0));
  const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
  $("#week-chart").innerHTML = stats.days.map((d, i) => {
    const v = value(d);
    const title = !d.recorded ? "未记录" : v == null ? "重量未知" : `${num(v)} ${weight ? "g" : "kcal"}${weight && d.unknownPortions ? "（部分重量）" : ""}`;
    return `<div class="week-day" title="${esc(d.date + " " + title)}" aria-label="${esc(d.date + " " + title)}">${v != null ? `<div class="week-column"><span class="week-value">${num(v)}${weight && d.unknownPortions ? "*" : ""}</span><div class="week-bar" style="height:${Math.max(2, v / max * 90)}px"></div></div>` : `<div class="week-column missing">${d.recorded ? "重量未知" : "未记录"}</div>`}<div class="week-label">周${weekdays[i]}<small>${d.date.slice(5).replace("-", "/")}</small></div></div>`;
  }).join("") + (weight && stats.days.some(d => d.unknownPortions) ? '<p class="chart-note">* 仅包含已知重量；未知份量未按 0 克计算。</p>' : "");
}
async function generateSummary() {
  if (state.summaryBusy || !state.stats?.mealCount) return;
  const epoch = state.summaryEpoch;
  const date = $("#summary-date").value;
  const period = state.period;
  state.summaryBusy = true;
  $("#generate-summary").disabled = true;
  showError("#summary-error", "");
  $("#summary-content").innerHTML =
    '<div class="summary-loading">✳ 正在阅读这段时间的饮食记录，整理营养特点与建议…</div>';
  try {
    const data = await send("/api/nutrition/summary", { date, period });
    if (epoch !== state.summaryEpoch) return;
    state.stats = data.stats;
    renderAISummary(data);
    $("#generate-summary").textContent = "再次查看总结 ↗";
  } catch (error) {
    if (epoch === state.summaryEpoch) {
      showError("#summary-error", error.message);
      $("#summary-content").innerHTML = empty(
        "这次总结没有完成",
        "饮食记录和统计仍然保留，可以重新生成。",
        true,
      );
    }
  } finally {
    if (epoch === state.summaryEpoch) {
      state.summaryBusy = false;
      $("#generate-summary").disabled = !state.stats?.mealCount;
    }
  }
}
function renderAISummary(data) {
  if (!data.analysis) {
    $("#summary-content").innerHTML = empty("暂无可用总结", data.reason, true);
    return;
  }
  const a = data.analysis;
  $("#summary-content").innerHTML =
    `<p class="ai-overview">${esc(a.overview)}</p>${a.observations
      .map(
        (o, i) =>
          `<article class="observation"><h3><span>0${i + 1}</span>${esc(o.title)}</h3><p>${esc(o.text)}</p><div class="evidence-links">${o.recordIds
            .map((id) => data.stats.records.find((r) => r.id === id))
            .filter(Boolean)
            .map((r) => `<span>${r.date.slice(5)} · ${esc(r.slot)}</span>`)
            .join("")}</div></article>`,
      )
      .join(
        "",
      )}${a.suggestions.length ? `<div class="suggestions-box"><h3>下一餐，可以试试</h3><ul>${a.suggestions.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>` : ""}<div class="analysis-limitations">${a.limitations.map((l) => `<p>${esc(l)}</p>`).join("")}<p>由 ${esc(a.model)} 生成 · 依据 ${data.stats.mealCount} 条确认记录</p></div>`;
}

$("#meal-form").addEventListener("submit", analyze);
$("#food-image").addEventListener("change", async (event) => {
  if (event.target.files[0])
    try {
      await loadImage(event.target.files[0]);
    } catch (error) {
      showError("#form-error", error.message);
    }
});
$("#remove-image").addEventListener("click", clearImage);
$("#upload-zone").addEventListener("dragover", (e) => {
  e.preventDefault();
  if (!state.busy) $("#upload-zone").classList.add("dragover");
});
$("#upload-zone").addEventListener("dragleave", () =>
  $("#upload-zone").classList.remove("dragover"),
);
$("#upload-zone").addEventListener("drop", async (e) => {
  e.preventDefault();
  $("#upload-zone").classList.remove("dragover");
  if (e.dataTransfer.files[0])
    try {
      await loadImage(e.dataTransfer.files[0]);
    } catch (error) {
      showError("#form-error", error.message);
    }
});
$("#meal-date").addEventListener("change", () => void refreshDay());
$("#summary-date").addEventListener("change", () => void refreshSummary());
$("#generate-summary").addEventListener("click", generateSummary);
$("#go-day-summary").addEventListener("click", () => {
  $("#summary-date").value = $("#meal-date").value;
  state.period = "day";
  $$("[data-period]").forEach((el) =>
    el.classList.toggle("active", el.dataset.period === "day"),
  );
  switchView("summary");
});
$("#back-to-record").addEventListener("click", () => switchView("record"));
$("#connection").addEventListener("click", () =>
  $("#model-dialog").showModal(),
);
$("#close-model").addEventListener("click", () => $("#model-dialog").close());
$("#model-done").addEventListener("click", () => $("#model-dialog").close());
document.addEventListener("input", (e) => {
  if (e.target.matches("[data-grams]")) recalculateDraft();
});
document.addEventListener("change", (e) => {
  if (e.target.matches("[data-include]")) recalculateDraft();
});
document.addEventListener("click", async (e) => {
  const nav = e.target.closest("[data-view]");
  if (nav) switchView(nav.dataset.view);
  const example = e.target.closest("[data-example]");
  if (example) {
    $("#meal-text").value = example.dataset.example;
    $("#meal-slot").value = example.textContent === "早餐" ? "早餐" : "午餐";
    $("#meal-text").focus();
  }
  const period = e.target.closest("[data-period]");
  if (period) {
    state.period = period.dataset.period;
    $$("[data-period]").forEach((el) =>
      el.classList.toggle("active", el === period),
    );
    void refreshSummary();
  }
  const consultMeal = e.target.closest("[data-consult-date]");
  if (consultMeal) {
    $("#consult-date").value = consultMeal.dataset.consultDate;
    $("#consult-period").value = "day";
    const record = state.day?.records.find(r => r.date === consultMeal.dataset.consultDate && r.id === consultMeal.closest("[data-record-id]").dataset.recordId);
    $("#consult-question").value = `请结合当天记录，解读${record?.slot || "这餐"}的${record?.title || "饮食"}，建议下一餐怎么搭配。`;
    switchView("advisor");
  }
  const half = e.target.closest("[data-halve]");
  if (half) { const input = $(`[data-grams="${half.dataset.halve}"]`); if (Number(input.value) > 0) { input.value = Math.round(Number(input.value) * 5) / 10; recalculateDraft(); } }
  const edit = e.target.closest("[data-edit]");
  if (edit) await openRecord(edit.dataset.edit);
  const remove = e.target.closest("[data-delete]");
  if (remove)
    await removeRecord(remove.dataset.delete, remove.dataset.revision);
  const pending = e.target.closest("[data-open-draft]");
  if (pending) await openRecord(pending.dataset.openDraft);
  if (e.target.closest("#save-meal")) await saveMeal();
  if (e.target.closest("[data-discard]")) {
    state.draft = null;
    rememberDraft(null);
    $("#draft-panel").hidden = true;
    void refreshDrafts();
    $("#meal-text").focus();
  }
});
async function boot() {
  try {
    const auth = await api("/api/auth/me");
    if (auth.family) {
      if (!auth.user) { location.replace(basePath + "/login"); return; }
      draftKey = "nutriagent:foodDraft:" + auth.user.id;
      $("#admin-nav").hidden = auth.user.role !== "superadmin";
      $("#account-button").hidden = false;
      $("#account-button").textContent = auth.user.name;
      $("#account-name").textContent = auth.user.name + " · " + auth.user.username;
      document.querySelector('a[href$="/studio"]')?.remove();
    }
    state.config = await api("/api/nutrition/config");
    const c = state.config;
    $("#connection span").textContent = c.textReady
      ? "AI 已配置"
      : "等待配置 API";
    $("#connection").classList.toggle("offline", !c.textReady);
    $("#today-display").textContent = c.today.slice(5).replace("-", " / ");
    $("#today-label").textContent = `${c.today.slice(0, 4)} · TODAY`;
    $("#meal-date").value = c.today;
    $("#summary-date").value = c.today;
    $("#consult-date").value = c.today; $("#admin-date").value = c.today; $("#memory-start").value = c.today;
    $("#ask-advisor").disabled = !c.advisorReady;
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: c.timeZone,
        hour: "2-digit",
        hour12: false,
      }).format(new Date()),
    );
    $("#meal-slot").value =
      hour < 10 ? "早餐" : hour < 15 ? "午餐" : hour < 21 ? "晚餐" : "加餐";
    $("#model-details").innerHTML =
      `<div class="config-row"><span>模型服务</span><strong>${esc(c.provider)}</strong></div><div class="config-row"><span>文字分析 / 营养总结</span><strong>${esc(c.model || "未配置")}</strong></div><div class="config-row"><span>图片识别</span><strong>${esc(c.visionModel || "未配置")}</strong></div><div class="config-row"><span>状态</span><strong>${c.textReady ? "配置已启用" : "请填写本地 API Key"}</strong></div>`;
    setBusy(false);
    await refreshDay();
    let saved;
    try {
      saved = localStorage.getItem(draftKey);
    } catch {}
    if (saved) {
      try {
        const draft = await api(`/api/nutrition/records/${saved}`);
        if (draft.status === "draft") showDraft(draft);
        else rememberDraft(null);
      } catch {
        rememberDraft(null);
      }
    }
    await refreshDrafts();
  } catch (error) {
    $("#connection span").textContent = "服务未连接";
    $("#analyze").disabled = true;
    showError("#form-error", error.message);
  }
}
let manualRequest = null, manualSignature = null;
$("#manual-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = {title: $("#manual-title").value.trim(), date: $("#meal-date").value, slot: $("#meal-slot").value, grams: $("#manual-grams").value === "" ? null : Number($("#manual-grams").value), totals: Object.fromEntries(nutrients.map(([k]) => [k, Number($("#manual-" + k).value)]))};
  const signature = JSON.stringify(data);
  if (signature !== manualSignature || !manualRequest) { manualRequest = crypto.randomUUID(); manualSignature = signature; }
  form.querySelectorAll("input,button").forEach(e => e.disabled = true);
  showError("#manual-error", "");
  try {
    await send("/api/nutrition/manual", {...data, requestId: manualRequest});
    manualRequest = null; form.reset(); state.summaryEpoch++;
    await refreshDay(); if (state.view === "summary") await refreshSummary();
    toast("已保存这一餐，可以查看当天饮食建议。");
  } catch (error) { showError("#manual-error", error.message); }
  finally { form.querySelectorAll("input,button").forEach(e => e.disabled = false); }
});
document.querySelectorAll("[data-trend]").forEach(button => button.addEventListener("click", () => {
  trendMetric = button.dataset.trend;
  document.querySelectorAll("[data-trend]").forEach(b => b.classList.toggle("active", b === button));
  if (state.stats) renderChart(state.stats);
}));
$("#account-button").addEventListener("click", () => $("#account-dialog").showModal());
$("#close-account").addEventListener("click", () => $("#account-dialog").close());
$("#logout").addEventListener("click", async () => {
  try { await send("/api/auth/logout", {}); location.replace(basePath + "/login"); }
  catch (error) { toast(error.message); }
});
$("#password-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button"); button.disabled = true;
  try { await send("/api/auth/password", {current: $("#old-password").value, password: $("#new-password").value}); location.replace(basePath + "/login"); }
  catch (error) { $("#account-error").textContent = error.message; }
  finally { button.disabled = false; }
});
window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
void boot();

let memory = {revision: 0, entries: []}, editingMemory = null, advisorLoaded = false, continueChat = false, consultController = null;
function sourceHTML(source) {
  let url = '';
  if (source.url?.startsWith('/api/rag/page?')) url = basePath + source.url.replace('/api/rag/page?', '/api/nutrition/page?');
  else if (/^https?:\/\//.test(source.url || '')) url = source.url;
  return `<article class="source-card"><strong>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(source.title)} ↗</a>` : esc(source.title)}</strong><p>${esc(source.detail || '')}</p>${source.excerpt ? `<blockquote>${esc(source.excerpt)}</blockquote>` : ''}</article>`;
}
function answerHTML(result) {
  return `<div class="answer-text">${esc(result.answer)}</div>${result.sources?.length ? `<details class="sources"><summary>数据与参考来源 · ${result.sources.length}</summary>${result.sources.map(sourceHTML).join('')}</details>` : ''}`;
}
async function loadAdvisor() {
  if (advisorLoaded) return;
  try {
    const [m, history] = await Promise.all([api('/api/nutrition/memory'), api('/api/nutrition/consultations')]);
    memory = m; renderMemory();
    $('#consult-history').innerHTML = history.slice(-6).map(h => `<article class="consult-turn"><div class="question-text">${esc(h.question)}</div><small>${esc(h.date)} · ${h.period === 'week' ? '周记录' : '日记录'}</small>${answerHTML(h.result)}</article>`).join('') || '<p class="advisor-welcome">今天吃了什么、下一餐怎么搭配，都可以从这里开始。</p>';
    advisorLoaded = true;
    if (state.config.advisorReady) {
      const library = await api('/api/nutrition/library');
      $('#library-status').innerHTML = `<p class="subtle">${library.ready ? `已连接 · ${library.documents.length} 份资料 / ${library.chunks} 个片段` : '知识库尚未完成建库'}</p>${library.documents.map(d => `<p>${esc(d.name)} <small>${d.pages} 页</small></p>`).join('')}`;
    } else $('#library-status').textContent = '营养师知识服务尚未连接，请联系管理员。';
  } catch (e) { toast(e.message); }
}
function renderMemory() {
  $('#memory-list').innerHTML = memory.entries.map(e => `<article class="memory-entry"><strong>${esc(e.content)}</strong><small>${({preference:'偏好',goal:'目标',restriction:'限制'})[e.kind]} · ${e.status === 'ended' ? '已结束' : e.status === 'review' || e.kind === 'restriction' && e.validUntil && e.validUntil < state.config.today ? '待确认' : e.validFrom > state.config.today ? '尚未生效' : '已记录'} · ${esc(e.validFrom)}${e.validUntil ? ' 至 ' + esc(e.validUntil) : ''}</small><div><button data-memory-edit="${e.id}">修改</button>${e.status !== 'ended' ? `<button data-memory-end="${e.id}">明确结束</button>` : ''}<button data-memory-delete="${e.id}">删除</button></div></article>`).join('') || '<p class="subtle">还没有饮食记忆，按需填写即可。</p>';
}
async function saveMemory(entries) {
  memory = await send('/api/nutrition/memory', {revision: memory.revision, entries}); renderMemory();
}
function resetMemoryForm() { editingMemory = null; $('#memory-form').reset(); $('#memory-start').value = state.config.today; $('#cancel-memory').hidden = true; }
$('#memory-form').addEventListener('submit', async event => {
  event.preventDefault();
  const old = memory.entries.find(e => e.id === editingMemory);
  const entry = {...old, id: editingMemory || crypto.randomUUID(), kind: $('#memory-kind').value, content: $('#memory-content').value.trim(), status: 'active', saidOn: old?.saidOn || state.config.today, validFrom: $('#memory-start').value, validUntil: $('#memory-end').value || null, confirmedOn: state.config.today, sourceText: ''};
  try { await saveMemory([...memory.entries.filter(e => e.id !== entry.id), entry]); resetMemoryForm(); }
  catch(e) { $('#memory-error').textContent = e.message; }
});
$('#cancel-memory').addEventListener('click', resetMemoryForm);
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-memory-edit],[data-memory-end],[data-memory-delete]');
  if (button) {
    const id = button.dataset.memoryEdit || button.dataset.memoryEnd || button.dataset.memoryDelete;
    const entry = memory.entries.find(e => e.id === id);
    if (button.dataset.memoryEdit) { editingMemory = id; $('#memory-kind').value = entry.kind; $('#memory-content').value = entry.content; $('#memory-start').value = entry.validFrom; $('#memory-end').value = entry.validUntil || ''; $('#cancel-memory').hidden = false; }
    else {
      if (!confirm(button.dataset.memoryEnd ? '确认这项偏好、目标或限制已经结束？' : '删除这条饮食记忆？')) return;
      try { await saveMemory(button.dataset.memoryEnd ? memory.entries.map(e => e.id === id ? {...e, status:'ended'} : e) : memory.entries.filter(e => e.id !== id)); }
      catch(e) { toast(e.message); }
    }
  }
  const quick = event.target.closest('[data-question]'); if (quick) $('#consult-question').value = quick.dataset.question;
});
$('#new-consult').addEventListener('click', () => { if (consultController) return; continueChat = false; $('#consult-history').innerHTML = ''; $('#consult-question').value = ''; toast('新问题会读取当前饮食记忆与所选日期，不带入旧对话。'); });
$('#cancel-consult').addEventListener('click', () => consultController?.abort());
$('#consult-form').addEventListener('submit', async event => {
  event.preventDefault(); if (consultController) return;
  const question = $('#consult-question').value.trim();
  const turn = document.createElement('article'); turn.className = 'consult-turn';
  turn.innerHTML = `<div class="question-text">${esc(question)}</div><small class="consult-progress">正在整理饮食记录与资料…</small><div class="answer-text"></div>`;
  $('#consult-history').append(turn);
  consultController = new AbortController(); $('#ask-advisor').disabled = true; $('#cancel-consult').hidden = false; showError('#consult-error', '');
  let completed = false, reader;
  try {
    const response = await fetch(basePath + '/api/nutrition/consult', {method:'POST', headers:{'Content-Type':'application/json'}, signal:consultController.signal, body:JSON.stringify({question, date:$('#consult-date').value, period:$('#consult-period').value, continue:continueChat, requestId:crypto.randomUUID()})});
    if (!response.ok) { if (response.status === 401) location.replace(basePath + '/login'); throw new Error((await response.json()).error || '咨询失败'); }
    reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const {value, done} = await reader.read(); if (done) break;
      buffer += decoder.decode(value, {stream:true});
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue;
        const item = JSON.parse(line);
        if (item.type === 'answer_delta') turn.querySelector('.answer-text').textContent += item.data.text;
        if (item.type === 'trace') turn.querySelector('.consult-progress').textContent = item.data.title || '正在查询与核对…';
        if (item.type === 'error') throw new Error(item.data.message);
        if (item.type === 'result') { turn.innerHTML = `<div class="question-text">${esc(question)}</div>${answerHTML(item.data)}`; completed = true; continueChat = true; }
      }
    }
    if (!completed) throw new Error('回答中断，请重新提问。');
    $('#consult-question').value = '';
  } catch(e) {
    const message = e.name === 'AbortError' ? '已停止生成；当前显示内容未完成。' : e.message;
    showError('#consult-error', message); turn.querySelector('.consult-progress')?.remove();
    turn.insertAdjacentHTML('beforeend', `<p class="subtle">${esc(message)}</p>`);
  } finally { if (!completed) await reader?.cancel().catch(() => {}); consultController = null; $('#ask-advisor').disabled = !state.config.advisorReady; $('#cancel-consult').hidden = true; }
});
$('#library-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true; $('#library-results').textContent = '正在检索…';
  try {
    const result = await send('/api/nutrition/search', {query:$('#library-query').value});
    $('#library-results').innerHTML = `<p class="subtle">${esc(result.mode)} · ${esc(result.warning || '')}</p>` + (result.hits.map(h => sourceHTML({title:`${h.filename} · PDF 第 ${h.page} 页`, detail:h.extraction, excerpt:h.text, url:'/api/rag/page?document='+encodeURIComponent(h.documentId)+'&page='+h.page})).join('') || '<p>暂无相关片段，请换一个具体问题。</p>');
  } catch(e) { $('#library-results').textContent = e.message; } finally { button.disabled = false; }
});
let adminLoaded = false, adminEpoch = 0;
async function loadAdmin() {
  const epoch = ++adminEpoch;
  try {
    if (!adminLoaded) { const users = await api('/api/admin/users'); $('#admin-user').innerHTML = users.map(u => `<option value="${esc(u.id)}">${esc(u.name)} · ${esc(u.username)}</option>`).join(''); adminLoaded = true; }
    const result = await api(`/api/admin/data?userId=${encodeURIComponent($('#admin-user').value)}&date=${$('#admin-date').value}&period=${$('#admin-period').value}`);
    if (epoch !== adminEpoch) return;
    $('#admin-content').innerHTML = `<section class="panel admin-panel"><h2>${esc(result.user.name)} · ${result.stats.mealCount} 餐</h2><div class="metrics">${metricHTML(result.stats.totals)}</div><div class="daily-table-wrap"><table class="daily-table"><thead><tr><th>日期</th><th>餐数</th><th>已知饭量 · g</th><th>热量 · kcal</th></tr></thead><tbody>${result.stats.days.map(d => `<tr><th>${d.date}<small>${d.recorded ? '已记录' : '未记录'}</small></th><td>${d.count || '—'}</td><td>${num(d.grams)}${d.unknownPortions ? `<small>${d.unknownPortions} 项重量未知</small>` : ''}</td><td>${num(d.totals?.kcal)}</td></tr>`).join('')}</tbody></table></div>${result.stats.records.map(r => mealHTML(r,false)).join('') || '<p>此日期范围没有记录。</p>'}<p class="subtle">另有 ${result.drafts.length} 条未确认草稿，未计入统计。</p></section><section class="panel admin-panel"><h2>饮食记忆</h2>${result.memory.entries.map(e => `<p>${esc(e.content)} <small>· ${esc(e.status)}</small></p>`).join('') || '<p>暂无记忆。</p>'}</section><section class="panel admin-panel"><h2>咨询记录</h2>${result.consultations.slice().reverse().map(h => `<details><summary>${esc(h.createdAt.slice(0,10))} · ${esc(h.question)}</summary>${answerHTML(h.result)}</details>`).join('') || '<p>暂无咨询。</p>'}</section>`;
  } catch(e) { $('#admin-content').textContent = e.message; }
}
['#admin-user','#admin-date','#admin-period'].forEach(id => $(id).addEventListener('change', () => void loadAdmin()));
