import { renderMarkdown } from './markdown.js';
const basePath = location.pathname.startsWith("/family/") ? "/family" : "";
let draftKey = "nutriagent:foodDraft";
let trendMetric = "grams", weekStats = null, trendDate = null;
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
    ? "<span>✳︎</span> 正在识别…"
    : "<span>✳︎</span> 识别这餐饮食 <span>↗</span>";
}
function switchView(view) {
  state.view = view;
  document.body.classList.toggle("advisor-mode", view === "advisor");
  $("#record-view").hidden = view !== "record";
  $("#summary-view").hidden = view !== "summary";
  $("#advisor-view").hidden = view !== "advisor";
  $("#admin-view").hidden = view !== "admin";
  const loading = view === "advisor" ? loadAdvisor() : null;
  if (view === "admin") void loadAdmin();
  $$(".nav").forEach((el) =>
    el.classList.toggle("active", el.dataset.view === view),
  );
  if (view === "summary") void refreshSummary();
  return loading;
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
  $("#camera-image").value = "";
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
      ? "修改这一餐"
      : "确认这一餐";
  $("#draft-model").textContent = "AI 估算 · 请核对";
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
    $('#draft-content').innerHTML = `
      <div class="draft-intro"><strong>${esc(draft.title)}</strong><span>${esc(draft.date)} · ${esc(draft.slot)}</span><p>核对吃下的份量，没吃的取消计入。</p></div>
      <div class="draft-food-list">${draft.items.map(item => `
        <article class="draft-food" data-food="${esc(item.id)}">
          <div class="draft-food-heading"><h3>${esc(item.name)}</h3><label class="food-include"><input type="checkbox" checked data-include="${esc(item.id)}" aria-label="计入${esc(item.name)}">计入</label></div>
          <div class="food-portion"><label for="grams-${esc(item.id)}">吃了多少</label><div class="portion-input"><input id="grams-${esc(item.id)}" type="number" inputmode="decimal" step="0.1" min="0.1" max="5000" value="${item.grams ?? ''}" data-grams="${esc(item.id)}" aria-label="${esc(item.name)}克数"><span>克</span></div><button type="button" class="halve-button" data-halve="${esc(item.id)}">一半</button></div>
          ${item.grams == null ? '<p class="portion-hint">份量未知，请填写实际吃下的克数。</p>' : ''}
          <div class="draft-food-metrics">${nutrients.map(([key,label,unit]) => `<div><span>${label}</span><strong data-value="${key}">${num(item.nutrition?.[key])}<small>${unit}</small></strong></div>`).join('')}</div>
          <details class="food-detail"><summary>识别依据 · ${amountLabels[item.amountSource] || '待核对'}</summary><p>${esc(item.portion || '未提供份量描述')}${item.note ? ' · ' + esc(item.note) : ''}</p></details>
        </article>`).join('')}</div>
      <div class="draft-total"><span id="draft-total-label">这餐营养合计</span><div id="draft-total-values" class="draft-total-values"></div></div>
      <details class="draft-method"><summary>估算说明</summary><p>营养值来自 AI 每100克参考值，按填写份量换算。识别不准确时，可补充文字重新识别。模型：${esc(draft.model)}。</p>${draft.notes.length ? `<ul>${draft.notes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul>` : ''}</details>
      <div class="draft-actions"><span>确认保存后计入日、周统计。</span><div><button class="button secondary" data-discard>${draft.status === 'saved' ? '取消修改' : '暂不保存'}</button><button class="button primary" id="save-meal">${draft.status === 'saved' ? '保存修改' : '保存这餐'}</button></div></div><div id="draft-error" class="error-box" role="alert" hidden></div>`;
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
    const hint = row.querySelector(".portion-hint"); if (hint) hint.hidden = valid || !included;
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
  state.stats = null; weekStats = null;
  $("#week-chart").textContent = "正在读取一周记录…";
  $("#trend-detail").textContent = ""; $("#trend-range").textContent = ""; $("#trend-coverage").textContent = "";
  $("#generate-summary").disabled = true;
  showError("#summary-error", "");
  $("#summary-hint").textContent = "正在读取已确认的饮食…";
  try {
    const period = state.period;
    const [stats, week] = await Promise.all([
      api(`/api/nutrition/overview?date=${date}&period=${period}`),
      period === 'week' ? Promise.resolve(null) : api(`/api/nutrition/overview?date=${date}&period=week`)
    ]);
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
    weekStats = week || stats; trendDate = date; renderChart(weekStats);
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
    $('#summary-hint').textContent = stats.mealCount ? '带上所选日 / 周的记录，到营养师对话中生成总结。' : '这段时间还没有已确认的饮食，记录后即可总结。';
    $('#generate-summary').disabled = !stats.mealCount || !state.config.advisorReady;

  } catch (error) {
    if (epoch === state.summaryEpoch) {
      $("#week-chart").textContent = "趋势暂时无法加载，请重新选择日期重试。";
      showError("#summary-error", error.message);
      $('#summary-hint').textContent = '读取记录失败，请稍后重试。';
    }
  }
}
const trendMetrics = {count:['记录餐数','餐'],grams:['已知饭量','g'],kcal:['热量','kcal'],protein:['蛋白质','g'],carbs:['碳水','g'],fat:['脂肪','g']};
function trendValue(day) {
  if (!day.recorded) return null;
  const value = trendMetric === 'count' ? day.count : trendMetric === 'grams' ? day.grams : day.totals?.[trendMetric];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function renderChart(stats) {
  const [label,unit] = trendMetrics[trendMetric];
  const values = stats.days.map(trendValue), max = Math.max(1,...values.filter(v=>v!==null));
  const scale = 10 ** Math.floor(Math.log10(max));
  const top = trendMetric === 'count' ? Math.max(2,Math.ceil(max/2)*2) : Math.ceil(max/scale)*scale;
  const selected = stats.days.find(d=>d.date===trendDate) || stats.days[0]; trendDate = selected.date;
  $('#trend-range').textContent = `${stats.start.slice(5).replace('-','/')}–${stats.end.slice(5).replace('-','/')} · 周一至周日`;
  $('#trend-title').textContent = `${label} · ${unit}`;
  $('#trend-coverage').textContent = `${stats.recordedDays} / 7 天有记录`;
  $('#trend-panel').setAttribute('aria-labelledby','trend-tab-'+trendMetric);
  $('#week-chart').innerHTML = `<div class="trend-axis" aria-hidden="true"><span>${num(top)}</span><span>${num(top/2)}</span><span>0</span></div><div class="trend-columns">${stats.days.map((d,i)=>{
    const v=values[i], missing=v===null, partial=trendMetric==='grams'&&d.unknownPortions>0&&v!==null;
    const description=!d.recorded?'未记录':missing?(trendMetric==='grams'?'重量未知':'数值未知'):`${num(v)} ${unit}${partial?'（部分重量）':''}`;
    return `<button type="button" class="trend-day${d.date===trendDate?' selected':''}" data-trend-date="${esc(d.date)}" aria-pressed="${d.date===trendDate}" aria-label="${esc(d.date+' '+label+' '+description)}"><span class="trend-plot">${missing?'<span class="trend-missing">—</span>':`<span class="trend-stick${v===0?' zero':''}" style="--bar-height:${v/top*100}%"><span class="trend-number">${num(v)}${partial?'*':''}</span></span>`}</span><span class="trend-weekday">${['一','二','三','四','五','六','日'][i]}</span><span class="trend-date">${d.date.slice(5).replace('-','/')}</span></button>`;
  }).join('')}</div>`;
  renderTrendDetail(selected);
}
function renderTrendDetail(day) {
  const [label,unit]=trendMetrics[trendMetric], value=trendValue(day);
  $('#trend-detail').innerHTML = `<span>${esc(day.date)} · ${label}</span><strong>${!day.recorded?'未记录':value===null?(trendMetric==='grams'?'重量未知':'数值未知'):`${num(value)} <small>${unit}</small>`}</strong><p>${!day.recorded?'这一天没有已保存餐食，不按零摄入计算。':trendMetric==='grams'&&day.unknownPortions?`已记录 ${day.count} 餐，${day.unknownPortions} 项份量未知${value===null?'。':'；图中仅为已知重量。'}`:`来自已保存的 ${day.count} 餐，仅代表已记录部分。`}</p>`;
}
$('#week-chart').addEventListener('click',event=>{
  const button=event.target.closest('[data-trend-date]');if(!button||!weekStats)return;
  trendDate=button.dataset.trendDate;
  $('#week-chart').querySelectorAll('[data-trend-date]').forEach(b=>{b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',String(b===button));});
  renderTrendDetail(weekStats.days.find(d=>d.date===trendDate));
});
async function generateSummary() {
  if (state.summaryBusy || !state.stats?.mealCount || !state.config.advisorReady) return;
  if (consultController) { switchView('advisor'); toast('营养师正在回答，请等本次完成后再生成总结。'); return; }
  const date = $('#summary-date').value, period = state.period;
  state.summaryBusy = true; $('#generate-summary').disabled = true;
  try {
    const ready = await switchView('advisor');
    if (!ready) return;
    $('#consult-date').value = date; $('#consult-period').value = period;
    continueChat = false; conversationId = crypto.randomUUID();
    $('#consult-history').innerHTML = '';
    $('#consult-question').value = `请总结 ${date}${period === 'week' ? ' 所在周（周一至周日）' : ' 当天'}的饮食和营养，看看热量、三大营养素及搭配情况，并建议接下来怎么吃。`;
    resizeComposer(); $('#consult-form').requestSubmit();
  } finally { state.summaryBusy = false; $('#generate-summary').disabled = !state.stats?.mealCount || !state.config.advisorReady; }
}

$("#meal-form").addEventListener("submit", analyze);
$$("#food-image,#camera-image").forEach(input => input.addEventListener("change", async (event) => {
  if (event.target.files[0])
    try {
      await loadImage(event.target.files[0]);
    } catch (error) {
      showError("#form-error", error.message);
    }
}));
$("#take-photo").addEventListener("click", () => $("#camera-image").click());
$("#choose-photo").addEventListener("click", () => $("#food-image").click());
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
    $("#meal-text-details").open = true;
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
     resizeComposer(); switchView("advisor");
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
    $("#meal-text-details").open = true;
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
  document.querySelectorAll("[data-trend]").forEach(b => { b.classList.toggle("active", b === button); b.setAttribute('aria-selected',String(b===button)); b.tabIndex=b===button?0:-1; });
  if (weekStats) renderChart(weekStats);
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

let memory = {revision: 0, entries: []}, editingMemory = null, advisorLoaded = false, advisorLoading = null, continueChat = true, consultController = null, conversationId = null, conversationHistory = [];
function sourceHTML(source) {
  let url = '';
  if (source.url?.startsWith('/api/rag/page?')) url = basePath + source.url.replace('/api/rag/page?', '/api/nutrition/page?');
  else if (/^https?:\/\//.test(source.url || '')) url = source.url;
  return `<article class="source-card"><strong>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(source.title)} ↗</a>` : esc(source.title)}</strong><p>${esc(source.detail || '')}</p>${source.excerpt ? `<blockquote>${esc(source.excerpt)}</blockquote>` : ''}</article>`;
}
function answerHTML(result) {
  return `<div class="answer-text markdown-body">${renderMarkdown(result.answer)}</div>${result.sources?.length ? `<details class="sources"><summary>数据与参考来源 · ${result.sources.length}</summary>${result.sources.map(sourceHTML).join('')}</details>` : ''}`;
}
async function loadAdvisor() {
  if (advisorLoaded) return true;
  if (advisorLoading) return advisorLoading;
  advisorLoading = (async () => {
  try {
    const [m, history, p] = await Promise.all([api('/api/nutrition/memory'), api('/api/nutrition/consultations'), api('/api/nutrition/profile')]);
    personal = p;
    memory = m; conversationHistory = history; renderMemory(); renderProfileConversations();
    conversationId = history.at(-1)?.conversationId || null;
    const current = conversationId ? history.filter(h => h.conversationId === conversationId) : history;
    $('#consult-history').innerHTML = current.slice(-30).map(h => chatTurnHTML(h.question,h.result)).join('') || welcomeHTML();
    renderPersonal(); renderProposals();
    if (!personal.onboarding) openPersonal(true);
    scrollChat();
    advisorLoaded = true;
    if (state.config.advisorReady) {
      void api('/api/nutrition/library').then(library => {
      $('#library-status').innerHTML = `<p class="subtle">${library.ready ? `已连接 · ${library.documents.length} 份资料 / ${library.chunks} 个片段` : '知识库尚未完成建库'}</p>${library.documents.map(d => `<p>${esc(d.name)} <small>${d.pages} 页</small></p>`).join('')}`;
      }).catch(e => { $('#library-status').textContent = e.message; });
    } else $('#library-status').textContent = '营养师知识服务尚未连接，请联系管理员。';
    return true;
  } catch (e) { toast(e.message); return false; }
  finally { advisorLoading = null; }
  })();
  return advisorLoading;
}
function welcomeHTML() {
  return '<div class="chat-welcome"><span>✳︎</span><h3>今天，想怎么吃？</h3><p>聊聊营养、搭配，或你喜欢的食物。<br>我会带上你的饮食记录，一起想办法。</p></div>';
}
function chatTurnHTML(question,result,wrap=true) {
  return `${wrap ? '<article class="consult-turn">' : ''}<div class="chat-message user-message"><small>你</small><div class="question-text">${esc(question)}</div></div><div class="chat-message assistant-message"><small>✳︎ 营养师</small>${answerHTML(result)}</div>${wrap ? '</article>' : ''}`;
}
function scrollChat() { const log = $('#consult-history'); log.scrollTop = log.scrollHeight; }
function renderProfileConversations() {
  $('#conversation-count').textContent = `最近 ${conversationHistory.length} 次`;
  $('#profile-conversations').innerHTML = conversationHistory.slice().reverse().map(h => `<details><summary>${esc(h.createdAt.slice(0,10))} · ${esc(h.question)}</summary>${answerHTML(h.result)}</details>`).join('') || '<p class="subtle">从第一条消息开始，后续可以继续聊。</p>';
}
function renderMemory() {
  $('#profile-context-status').textContent = memory.entries.length ? `记住了 ${memory.entries.length} 条饮食偏好与资料` : '对话已保存 · 资料由你确认';
  $('#memory-list').innerHTML = memory.entries.map(e => `<article class="memory-entry"><strong>${esc(e.content)}</strong><small>${({preference:'偏好',goal:'目标',restriction:'限制'})[e.kind]} · ${e.status === 'ended' ? '已结束' : e.status === 'review' || e.kind === 'restriction' && e.validUntil && e.validUntil < state.config.today ? '待确认' : e.validFrom > state.config.today ? '尚未生效' : '已记录'} · ${e.sourceText?.startsWith("来自营养师对话：") ? "来自对话 · " : "手动记录 · "}${esc(e.validFrom)}${e.validUntil ? ' 至 ' + esc(e.validUntil) : ''}</small><div><button data-memory-edit="${e.id}">修改</button>${e.status !== 'ended' ? `<button data-memory-end="${e.id}">明确结束</button>` : ''}<button data-memory-delete="${e.id}">删除</button></div></article>`).join('') || '<p class="subtle">还没有饮食记忆，按需填写即可。</p>';
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
  const quick = event.target.closest('[data-question]'); if (quick) { $('#consult-question').value = quick.dataset.question; resizeComposer(); $('#consult-question').focus(); }
});
$('#new-consult').addEventListener('click', () => { if (consultController) return; continueChat = false; conversationId = crypto.randomUUID(); $('#consult-history').innerHTML = welcomeHTML(); renderProposals(); $('#consult-question').value = ''; resizeComposer(); toast('已开启新对话，个人资料仍会保留。'); });
$('#cancel-consult').addEventListener('click', () => consultController?.abort());
$('#consult-form').addEventListener('submit', async event => {
  event.preventDefault(); if (consultController) return;
  const question = $('#consult-question').value.trim();
  if (!question || !state.config.advisorReady) return;
  const turn = document.createElement('article'); turn.className = 'consult-turn';
  turn.innerHTML = `<div class="chat-message user-message"><small>你</small><div class="question-text">${esc(question)}</div></div><div class="chat-message assistant-message"><small>✳︎ 营养师</small><small class="consult-progress">正在查看你的资料…</small><div class="answer-text"></div></div>`;
  $('#consult-history .chat-welcome')?.remove(); $('#consult-history').append(turn); scrollChat();
  consultController = new AbortController(); $('#ask-advisor').disabled = true; $('#cancel-consult').hidden = false; showError('#consult-error', '');
  let completed = false, reader, answerBuffer = '';
  try {
    const response = await fetch(basePath + '/api/nutrition/consult', {method:'POST', headers:{'Content-Type':'application/json'}, signal:consultController.signal, body:JSON.stringify({question, date:$('#consult-date').value, period:$('#consult-period').value, continue:continueChat, conversationId, requestId:crypto.randomUUID()})});
    if (!response.ok) { if (response.status === 401) location.replace(basePath + '/login'); throw new Error((await response.json()).error || '咨询失败'); }
    reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const {value, done} = await reader.read(); if (done) break;
      buffer += decoder.decode(value, {stream:true});
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue;
        const item = JSON.parse(line);
        if (item.type === 'answer_delta') { answerBuffer += item.data.text; const answer = turn.querySelector('.answer-text'); answer.classList.add('markdown-body'); answer.innerHTML = renderMarkdown(answerBuffer); if ($('#consult-history').scrollHeight - $('#consult-history').scrollTop - $('#consult-history').clientHeight < 180) scrollChat(); }
        if (item.type === 'trace' && turn.querySelector('.consult-progress')) turn.querySelector('.consult-progress').textContent = item.data.title || '正在查询与核对…';
        if (item.type === 'error') throw new Error(item.data.message);
        if (item.type === 'answer_complete' || item.type === 'result') {
          turn.innerHTML = chatTurnHTML(question,item.data,false); completed = true; continueChat = true; conversationId = item.data.conversationId || conversationId;
          if (item.type === 'answer_complete') turn.insertAdjacentHTML('beforeend','<small class="profile-save-note">对话已保存，正在整理个人上下文…</small>');
          else turn.querySelector('.profile-save-note')?.remove();
          scrollChat();
        }
        if (item.type === 'profile_proposed') { personal = item.data.personal; renderPersonal(); }
        if (item.type === 'profile_notice') toast(item.data.message);
      }
    }
    if (!completed) throw new Error('回答中断，请重新提问。');
    $('#consult-question').value = ''; resizeComposer();
    conversationHistory = await api('/api/nutrition/consultations'); renderProfileConversations(); renderProposals(); scrollChat();
  } catch(e) {
    const message = e.name === 'AbortError' ? completed ? '回答已保存，已停止后续资料整理。' : '已停止生成；当前显示内容未完成。' : e.message;
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
    if (!adminLoaded) { const users = await api('/api/admin/users'); $('#admin-user').innerHTML = users.map(u => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join(''); adminLoaded = true; }
    const result = await api(`/api/admin/data?userId=${encodeURIComponent($('#admin-user').value)}&date=${$('#admin-date').value}&period=${$('#admin-period').value}`);
    if (epoch !== adminEpoch) return;
    $('#admin-content').innerHTML = `<section class="panel admin-panel"><h2>${esc(result.user.name)} · ${result.stats.mealCount} 餐</h2><div class="metrics">${metricHTML(result.stats.totals)}</div><div class="daily-table-wrap"><table class="daily-table"><thead><tr><th>日期</th><th>餐数</th><th>已知饭量 · g</th><th>热量 · kcal</th></tr></thead><tbody>${result.stats.days.map(d => `<tr><th title="${esc(d.date)}">${esc(d.date.slice(5).replace("-","/"))}<small>${d.recorded ? '已记录' : '未记录'}</small></th><td>${d.count || '—'}</td><td>${num(d.grams)}${d.unknownPortions ? `<small>${d.unknownPortions} 项重量未知</small>` : ''}</td><td>${num(d.totals?.kcal)}</td></tr>`).join('')}</tbody></table></div>${result.stats.records.length ? `<details class="admin-records"><summary>本期餐食 · ${result.stats.mealCount} 餐</summary>${result.stats.records.map(r => mealHTML(r,false)).join('')}</details>` : '<p class="subtle">此日期范围没有记录。</p>'}${result.drafts.length ? `<p class="subtle">另有 ${result.drafts.length} 条未确认草稿，未计入统计。</p>` : ''}</section><details class="panel admin-panel admin-more"><summary>个人档案</summary>${personalSummaryHTML(result.personal)}${weightHistoryHTML(result.personal, false)}</details><details class="panel admin-panel admin-more"><summary>饮食偏好</summary>${result.memory.entries.map(e => `<p>${esc(e.content)} <small>· ${({active:'已记录',review:'待确认',ended:'已结束'})[e.status] || '待确认'}</small></p>`).join('') || '<p>暂无记忆。</p>'}</details><details class="panel admin-panel admin-more"><summary>咨询记录</summary>${result.consultations.slice().reverse().map(h => `<details><summary>${esc(h.createdAt.slice(0,10))} · ${esc(h.question)}</summary>${answerHTML(h.result)}</details>`).join('') || '<p>暂无咨询。</p>'}</details>`;
  } catch(e) { $('#admin-content').textContent = e.message; }
}
['#admin-user','#admin-date','#admin-period'].forEach(id => $(id).addEventListener('change', () => void loadAdmin()));

$('#open-profile').addEventListener('click', async () => { if (await loadAdvisor()) { await refreshPersonal(); $('#profile-dialog').showModal(); } });
$('#close-profile').addEventListener('click', () => $('#profile-dialog').close());
$('#consult-question').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && window.matchMedia('(min-width:761px)').matches) { event.preventDefault(); if (!consultController && $('#consult-question').value.trim()) $('#consult-form').requestSubmit(); }
});

function resizeComposer() {
  const input = $('#consult-question');
  input.style.height = 'auto';
  input.style.height = Math.min(160, Math.max(36, input.scrollHeight)) + 'px';
}
$('#consult-question').addEventListener('input', resizeComposer);

// One confirmed account profile, whether information starts in a form or a conversation.
let personal = {revision:0,onboarding:false,fields:{},weights:[],pending:[]};
const personalLabels = {age:'年龄',sex:'性别',height:'身高（厘米）',weight:'体重（公斤）',hometown:'家乡',residence:'常住地',preferences:'口味偏好',goal:'当前目标',conditions:'疾病史（自述）',allergies:'食物过敏（自述）',restrictions:'医生交代的饮食限制'};
const healthKeys = ['conditions','allergies','restrictions'];
$('#health-fields').innerHTML = healthKeys.map(k => `<label>${personalLabels[k]}<select name="${k}Status" aria-label="${personalLabels[k]}"><option value="">暂未填写</option><option value="none">无</option><option value="yes">有，请补充</option><option value="unknown">不清楚</option><option value="private">暂不提供</option></select><input name="${k}" aria-label="${personalLabels[k]}详情" maxlength="300" placeholder="记录你的自述或医生交代的内容" hidden /></label>`).join('');
const personalForm = $('#personal-form');
for (const k of healthKeys) personalForm.elements[k+'Status'].addEventListener('change', () => { personalForm.elements[k].hidden = personalForm.elements[k+'Status'].value !== 'yes'; });
function personalSummaryHTML(p) {
  if (!p) return '<p class="subtle">暂无资料</p>';
  const groups = [['身体情况',['age','sex','height']],['饮食习惯',['hometown','residence','preferences']],['健康注意事项',healthKeys],['当前目标',['goal']]];
  return groups.map(([title,keys]) => `<section class="personal-group"><h3>${title}</h3><dl>${keys.map(k => { const f=p.fields[k]; return `<div><dt>${personalLabels[k]}</dt><dd>${f ? esc(String(f.value)) : '<span class="subtle">未填写</span>'}${f ? `<small>${f.source === 'chat' ? '来自对话 · 已确认' : '手动填写'} · ${esc(f.updatedOn)}</small>` : ''}</dd></div>`; }).join('')}</dl></section>`).join('');
}
function weightHistoryHTML(p,editable=true) {
  return p?.weights.length ? `<ul class="weight-history">${p.weights.slice().reverse().map(w => `<li><div><strong>${num(w.value)} 公斤</strong><span>${num(w.value*2)} 斤 · ${esc(w.date)}</span><small>${w.source === 'chat' ? '来自对话 · 已确认' : '手动填写'}</small></div>${editable ? `<button class="text-button" type="button" data-delete-weight="${esc(w.id)}">删除</button>` : ''}</li>`).join('')}</ul>` : '<p class="subtle">还没有体重记录。</p>';
}
function renderPersonal() {
  $('#personal-summary').innerHTML = personalSummaryHTML(personal);
  $('#weight-history').innerHTML = weightHistoryHTML(personal);
  $('#profile-context-status').textContent = `个人资料 ${Object.keys(personal.fields).length} 项${personal.pending.length ? ` · ${personal.pending.length} 条待确认` : ' · 随时可修改'}`;
  $('#personal-pending').innerHTML = proposalsHTML();
}
function proposalsHTML() {
  return personal.pending.map(p => `<section class="profile-proposal" data-proposal="${esc(p.id)}"><h3>要记住这些信息吗？</h3><p class="subtle">确认后用于后续建议，可能更新已有资料。${esc(p.date)}</p><blockquote>${esc(p.quote)}</blockquote><div class="proposal-fields">${Object.entries(p.values).map(([k,v]) => `<label>${personalLabels[k]}${k === 'sex' ? `<select data-fact="${k}">${['男','女','暂不提供'].map(o=>`<option${o===v?' selected':''}>${o}</option>`).join('')}</select>` : `<input data-fact="${k}" value="${esc(String(v))}" maxlength="300" ${['age','height','weight'].includes(k) ? 'type="number" step="any" inputmode="decimal"' : ''} />`}${personal.fields[k] ? `<small>已存：${esc(String(personal.fields[k].value))}</small>` : ''}</label>`).join('')}</div><div class="personal-actions"><button type="button" class="button primary" data-accept-profile="${esc(p.id)}">确认保存</button><button type="button" class="text-button" data-reject-profile="${esc(p.id)}">仅本次使用</button></div><p class="subtle">可直接修改上面的内容；仅本次使用不会写入个人档案，聊天原文仍保留。</p></section>`).join('');
}
function renderProposals() {
  $('#consult-history .chat-profile-proposals')?.remove();
  if (personal.pending.length) {
    $('#consult-history .chat-welcome')?.remove();
    $('#consult-history').insertAdjacentHTML('beforeend', `<div class="chat-profile-proposals">${proposalsHTML()}</div>`);
  }
}
async function refreshPersonal() { personal = await api('/api/nutrition/profile'); renderPersonal(); renderProposals(); }
async function changePersonal(data) {
  try { personal = await send('/api/nutrition/profile', {revision:personal.revision,...data}); renderPersonal(); renderProposals(); }
  catch(e) { await refreshPersonal().catch(()=>{}); throw e; }
}
function personalStep(second) {
  $('#personal-step-one').hidden = second; $('#personal-step-two').hidden = !second;
  $('#personal-next').hidden = second; $('#personal-prev').hidden = !second;
  $('#personal-step-label').textContent = second ? '2 / 2 · 饮食习惯与注意事项' : '1 / 2 · 基本情况';
}
function openPersonal(first=false) {
  personalForm.reset(); personalStep(false); showError('#personal-error','');
  for (const [k,f] of Object.entries(personal.fields)) {
    if (healthKeys.includes(k)) {
      const status = ({'无':'none','不清楚':'unknown','暂不提供':'private'})[f.value] || 'yes';
      personalForm.elements[k+'Status'].value = status; personalForm.elements[k].value = status === 'yes' ? f.value : '';
    } else if (personalForm.elements[k]) personalForm.elements[k].value = f.value;
  }
  for (const k of healthKeys) personalForm.elements[k].hidden = personalForm.elements[k+'Status'].value !== 'yes';
  personalForm.elements.weightDate.value = state.config.today; personalForm.elements.weightDate.max = state.config.today;
  personalForm.dataset.revision = String(personal.revision);
  personalForm.hidden = false; $('#personal-summary').hidden = true; $('#edit-personal').hidden = true;
  $('#personal-intro').textContent = first ? '先认识一下你，让建议更适合你' : '更新我的个人资料';
  if (!$('#profile-dialog').open) $('#profile-dialog').showModal();
  $('#profile-dialog').scrollTop = 0;
}
function closePersonalForm() { personalForm.hidden = true; $('#personal-summary').hidden = false; $('#edit-personal').hidden = false; }
$('#edit-personal').addEventListener('click',()=>openPersonal());
$('#personal-next').addEventListener('click',()=>{ if (personalForm.reportValidity()) personalStep(true); });
$('#personal-prev').addEventListener('click',()=>personalStep(false));
$('#personal-skip').addEventListener('click',async()=>{ try { await changePersonal({action:'dismiss'}); closePersonalForm(); $('#profile-dialog').close(); } catch(e){showError('#personal-error',e.message);} });
personalForm.addEventListener('submit',async event=>{
  event.preventDefault(); const button=event.submitter; button.disabled=true;
  try {
    const values={};
    for(const k of Object.keys(personalLabels)) {
      if(k==='weight') continue;
      const input=personalForm.elements[k];
      if(healthKeys.includes(k)) {
        const status=personalForm.elements[k+'Status'].value;
        if(status==='yes' && !input.value.trim()) throw new Error(`请补充${personalLabels[k]}，或选择不清楚／暂不提供。`);
        values[k]= status==='yes' ? input.value.trim() : ({none:'无',unknown:'不清楚',private:'暂不提供'})[status] || null;
      } else values[k]=input.value.trim() ? ['age','height'].includes(k) ? Number(input.value) : input.value.trim() : null;
    }
    if(personalForm.elements.weight.value) values.weight=Number(personalForm.elements.weight.value)/(personalForm.elements.weightUnit.value==='jin'?2:1);
    await changePersonal({action:'save',revision:Number(personalForm.dataset.revision),values,date:personalForm.elements.weightDate.value || state.config.today});
    closePersonalForm(); toast('个人资料已保存，后续建议会参考这些信息。');
  } catch(e){ showError('#personal-error',e.message); if(Number(personalForm.dataset.revision)!==personal.revision) { showError('#personal-error',e.message+' 请关闭并重新打开填写，避免覆盖新资料。'); } }
  finally{button.disabled=false;}
});
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-accept-profile],[data-reject-profile],[data-delete-weight]'); if(!button)return;
  button.disabled=true;
  try {
    if(button.dataset.deleteWeight) {
      if(!confirm('删除这条体重记录？')) return;
      await changePersonal({action:'delete_weight',id:button.dataset.deleteWeight});
    } else if(button.dataset.acceptProfile) {
      const values={};
      for(const input of button.closest('[data-proposal]').querySelectorAll('[data-fact]')) values[input.dataset.fact]=['age','height','weight'].includes(input.dataset.fact) ? (input.value ? Number(input.value) : null) : input.value;
      await changePersonal({action:'accept',id:button.dataset.acceptProfile,values}); toast('已确认并记入个人资料。');
    } else { await changePersonal({action:'reject',id:button.dataset.rejectProfile}); toast('不会记入个人档案。'); }
  } catch(e){toast(e.message);} finally{button.disabled=false;}
});
$('#profile-dialog').addEventListener('close',closePersonalForm);

$('#trend-controls').addEventListener('keydown',event=>{
  const tabs=$$('[data-trend]'),index=tabs.indexOf(event.target);if(index<0)return;
  const next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;
  if(next!==null){event.preventDefault();tabs[next].focus();tabs[next].click();}
});
