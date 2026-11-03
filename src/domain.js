// 数字由代码计算。此目录只有自建合成数据，不含原业务仓库的代码或用户资料。
export const REFERENCES = Object.freeze({
  rice: { name: "熟米饭", kcal: 116, protein: 2.6, carbs: 25.9, fat: 0.3 },
  chicken: { name: "鸡胸肉（熟）", kcal: 165, protein: 31, carbs: 0, fat: 3.6 },
  broccoli: { name: "西兰花", kcal: 34, protein: 2.8, carbs: 6.6, fat: 0.4 },
  oats: { name: "燕麦片", kcal: 379, protein: 13.2, carbs: 67.7, fat: 6.5 },
  milk: { name: "牛奶", kcal: 61, protein: 3.2, carbs: 4.8, fat: 3.3 },
  egg: { name: "鸡蛋", kcal: 143, protein: 12.6, carbs: 0.7, fat: 9.5 },
  apple: { name: "苹果", kcal: 52, protein: 0.3, carbs: 13.8, fat: 0.2 },
  salmon: { name: "三文鱼", kcal: 208, protein: 20, carbs: 0, fat: 13 },
  potato: { name: "土豆", kcal: 77, protein: 2, carbs: 17, fat: 0.1 },
  oil: { name: "烹调油", kcal: 884, protein: 0, carbs: 0, fat: 100 },
});

export const SOURCE_NOTE =
  "项目内合成演示参考表，每 100 g 可食部分；用于验证工具链与换算，不代表实验室测量或个人完整摄入。";
export const SCENARIOS = [
  {
    id: "weekly",
    label: "生成三日饮食报告",
    prompt: "分析这三天的饮食记录，生成一份带图表和依据的报告。",
    description: "取数 → 计算 → 校验 → 报告",
  },
  {
    id: "clarify",
    label: "试试资料不足",
    prompt: "午餐吃了一碗米饭，帮我分析并生成报告。",
    description: "补充份量后继续执行",
  },
  {
    id: "recovery",
    label: "试试失败恢复",
    prompt: "生成三日饮食报告，演示一次报告任务失败后的恢复。",
    description: "保留结果，只重试失败步骤",
  },
];

export function createMeals() {
  const days = ["2026-10-30", "2026-10-31", "2026-11-01"];
  return days.flatMap((date, i) => [
    {
      id: `breakfast-${i}`,
      date,
      slot: "早餐",
      name: "燕麦牛奶 · 水煮蛋",
      items: [
        { food: "oats", grams: 45 + i * 5 },
        { food: "milk", grams: 250 },
        { food: "egg", grams: 50 },
      ],
      origin: "合成记录",
    },
    {
      id: `lunch-${i}`,
      date,
      slot: "午餐",
      name: "鸡胸肉 · 米饭 · 西兰花",
      items: [
        { food: "rice", grams: 180 },
        { food: "chicken", grams: 130 + i * 10 },
        { food: "broccoli", grams: 150 },
        { food: "oil", grams: 8 },
      ],
      origin: "合成记录",
    },
    {
      id: `dinner-${i}`,
      date,
      slot: "晚餐",
      name: "香煎三文鱼 · 土豆",
      items: [
        { food: "salmon", grams: 120 },
        { food: "potato", grams: 200 + i * 20 },
        { food: "broccoli", grams: 120 },
        { food: "oil", grams: 5 },
      ],
      origin: "合成记录",
    },
    {
      id: `snack-${i}`,
      date,
      slot: "加餐",
      name: "苹果",
      items: [{ food: "apple", grams: 180 }],
      origin: "合成记录",
    },
  ]);
}

export function reviseRice(meals, grams) {
  if (!Number.isFinite(grams) || grams < 1 || grams > 2000)
    throw new Error("米饭份量应为 1–2000 g。");
  const next = structuredClone(meals);
  const meal = next.filter((m) => m.slot === "午餐").at(-1);
  if (!meal) throw new Error("没有可以修订的午餐记录。");
  const rice = meal.items.find((i) => i.food === "rice");
  if (!rice) throw new Error("该餐没有米饭记录。");
  rice.grams = grams;
  meal.origin = "用户修订的示例记录";
  return next;
}

const round = (n) => Math.round(n * 10) / 10;
const zero = () => ({ kcal: 0, protein: 0, carbs: 0, fat: 0 });
export function calculateNutrition(meals) {
  if (!Array.isArray(meals) || !meals.length)
    throw new Error("没有可分析的饮食记录。");
  const totals = zero();
  const days = new Map();
  const rows = meals.map((meal) => {
    const values = zero();
    const evidence = meal.items.map((item) => {
      const ref = REFERENCES[item.food];
      if (!ref || !Number.isFinite(item.grams) || item.grams <= 0)
        throw new Error("原料或重量无效，不能生成营养结论。");
      for (const key of Object.keys(values))
        values[key] += (ref[key] * item.grams) / 100;
      return {
        food: item.food,
        name: ref.name,
        grams: item.grams,
        reference: { ...ref },
        formula: `${ref.kcal} × ${item.grams} ÷ 100`,
        kcal: round((ref.kcal * item.grams) / 100),
      };
    });
    if (!days.has(meal.date)) days.set(meal.date, zero());
    for (const key of Object.keys(values)) {
      totals[key] += values[key];
      days.get(meal.date)[key] += values[key];
    }
    return {
      ...meal,
      values: Object.fromEntries(
        Object.entries(values).map(([k, v]) => [k, round(v)]),
      ),
      evidence,
    };
  });
  return {
    rows,
    days: [...days].map(([date, v]) => ({
      date,
      ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])),
    })),
    totals: Object.fromEntries(
      Object.entries(totals).map(([k, v]) => [k, round(v)]),
    ),
    average: Object.fromEntries(
      Object.entries(totals).map(([k, v]) => [k, round(v / days.size)]),
    ),
    sourceNote: SOURCE_NOTE,
  };
}

export function validateAnalysis(analysis) {
  if (!analysis?.rows?.length) throw new Error("分析数据尚未就绪。");
  for (const key of ["kcal", "protein", "carbs", "fat"]) {
    const sum = analysis.rows.reduce((n, r) => n + r.values[key], 0);
    if (
      !Number.isFinite(analysis.totals[key]) ||
      Math.abs(sum - analysis.totals[key]) > analysis.rows.length * 0.11
    )
      throw new Error("明细与汇总不一致。");
  }
  return {
    passed: true,
    checks: ["原料与份量有效", "明细与汇总一致", "引用与计算来源完整"],
    note: "校验只证明结构与计算一致，不证明照片识别或营养估算准确率。",
  };
}

export function buildReport(analysis, validation, version = 1) {
  if (!validation?.passed) throw new Error("请先完成数据校验。");
  return {
    title: analysis.days.length === 1 ? "单日饮食观察报告" : "三日饮食观察报告",
    version,
    generatedAt: new Date().toISOString(),
    analysis,
    validation,
    observations: [
      {
        title: "蛋白质来源有变化",
        text: "示例记录包含鸡蛋、牛奶、鸡胸肉和三文鱼。此处描述食物构成，不据此判断个体摄入是否达标。",
        evidence: ["breakfast", "lunch", "dinner"],
      },
      {
        title: "蔬菜种类较集中",
        text: "记录中的蔬菜主要为西兰花。下一次记录可补充实际摄入的其他蔬菜、调味料和烹调油。",
        evidence: ["lunch", "dinner"],
      },
    ],
    limitations: [
      "全部输入为合成示例，日期固定，并非你的个人健康数据。",
      "未记录的食物不等于未进食；没有个体目标，不能判断营养是否充足。",
      "营养量采用示例参考值换算，不用于诊断、治疗或个体膳食处方。",
    ],
  };
}

export function reportMarkdown(report) {
  const a = report.analysis;
  return `# ${report.title}\n\n版本 ${report.version} · ${a.days[0].date} 至 ${a.days.at(-1).date}\n\n> 合成示例 · ${a.sourceNote}\n\n## 已记录日均营养\n\n| 能量 kcal | 蛋白质 g | 碳水 g | 脂肪 g |\n|---|---|---|---|\n| ${a.average.kcal} | ${a.average.protein} | ${a.average.carbs} | ${a.average.fat} |\n\n## 饮食明细\n\n| 日期 | 餐次 | 食物 | 能量 kcal |\n|---|---|---|---|\n${a.rows.map((r) => `| ${r.date} | ${r.slot} | ${r.name} | ${r.values.kcal} |`).join("\n")}\n\n## 观察\n\n${report.observations.map((o) => `### ${o.title}\n\n${o.text}`).join("\n\n")}\n\n## 依据与限制\n\n${report.limitations.map((x) => `- ${x}`).join("\n")}\n\n${report.validation.note}\n`;
}
