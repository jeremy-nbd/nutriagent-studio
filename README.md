# NutriAgent Studio

以 **Python 为核心**的个人 AI 应用工程作品集：图片 / 文字饮食识别、营养记录、日周总结，以及可追溯的 Agent 工具编排。浏览器使用原生 HTML / CSS / JavaScript，服务端和命令行不依赖 Node.js。

![NutriAgent 工作台](docs/assets/workspace.png)

> 截图展示 `/studio` 的合成数据工程演示。首页为真实输入的饮食记录与日周总结，两者数据独立。

## 快速启动

Python 3.10+，运行时仅使用标准库，无需安装第三方依赖。

```sh
python3 run.py
# 或
python3 -m nutriagent serve --port 4371
```

打开 <http://127.0.0.1:4371/>。只有模型调用需要 Key；没有 Key 时可以访问 <http://127.0.0.1:4371/studio> 体验合成数据工具编排。

首次配置：复制 `.env.example` 为 `.env`，填写自己的 Key，再启动服务。已有 `.env` 请直接保留。环境变量优先于文件；配置修改后需要重启。

```dotenv
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_API_KEY=
LLM_DEFAULT_MODEL_ID=qwen3.5-plus
LLM_TEMPERATURE=0.2
LLM_TIMEOUT_S=60
VLM_DEFAULT_MODEL_ID=qwen3-vl-plus
VLM_TIMEOUT_S=120
```

支持 Chat Completions 兼容服务，LLM 需支持结构化 JSON / 工具调用，VLM 需支持图片输入。百炼 Qwen3 默认关闭思考模式以适配同步请求。旧 `MODEL_*` 仍兼容，只有完全不存在 LLM 连接字段时才启用旧组，避免跨服务混用 Key。Key 仅由后端读取；`.env` 与 `.local/` 不提交。

## 两个主要功能

1. **记录饮食**：发送图片、文字或组合输入，识别吃了什么、吃了多少；展示热量、蛋白质、碳水、脂肪。核对或修改克数、去掉没吃的项目，确认后计入统计。支持 JPG / PNG / WebP，最大6 MB。
2. **日周总结**：按选定日期汇总确认记录；一周按周一至周日计算。展示总量、记录日日均、逐日变化和 AI 观察。缺失日不按零摄入处理；AI 观察必须附有效记录引用。

图片份量和每100克参考值均为模型估算，尚未接入权威营养数据库或 RAG。后端根据确认克数换算营养，未知份量需补齐。没有完整摄入与个体目标时不判断营养是否达标。

## Python 命令行脚本

```sh
# 文字识别，输出 JSON 并保存待确认草稿
python3 -m nutriagent analyze --text "150克熟米饭和两个水煮蛋" --slot 午餐

# 图片 + 补充描述
python3 -m nutriagent analyze --image /absolute/path/lunch.jpg --text "米饭只吃了一半"

# 基于已确认记录生成日 / 周总结
python3 -m nutriagent summary --date 2026-11-10 --period day
python3 -m nutriagent summary --date 2026-11-10 --period week

# 使用独立数据目录或环境配置
python3 -m nutriagent --data-dir /tmp/nutriagent-demo --env-file .env serve
```

识别脚本保存的是草稿，需要在网页核对确认。**同一个数据目录仅供一个进程使用**：使用 CLI 前先停止 Web 服务，或用独立 `--data-dir`，避免多个进程持有不同的文件缓存。CLI 操作后重启网页服务以读取新记录。

## 工程演示

`/studio` 保留合成三日记录：取数 → 份量修订 → 营养计算 → 校验 → 报告。支持缺失份量追问、SSE 执行事件、断线续接、失败步骤恢复、报告版本、Markdown 下载和浏览器打印 PDF。真实模型最多6轮、12次工具调用，所有数值由 Python 计算。

## 代码结构

| 文件 | 职责 |
|---|---|
| `run.py`、`nutriagent/__main__.py` | 启动与 CLI |
| `nutriagent/core.py` | 环境配置、模型 HTTP 请求、原子文件保存 |
| `nutriagent/nutrition.py` | 图片校验、食物识别、确认修改、日周统计与总结 |
| `nutriagent/agent.py` | 合成数据计算、工具执行与模型编排 |
| `nutriagent/server.py` | 本地 HTTP / SSE API、后台任务与恢复 |
| `nutriagent/demo.json`、`prompts.json` | 合成参考数据、工具定义与提示词 |
| `public/` | 网页界面 |
| `tests_python/` | Python 单元和 HTTP 集成测试 |

```sh
python3 -m compileall -q nutriagent run.py
python3 -m unittest discover -s tests_python -v
```

GitHub Actions 使用 Python 3.10 / 3.12 / 3.13。维护时先运行测试，再检查 `git diff` 后提交推送。

## 存储与边界

- 兼容原 Node 版本的 `.local/runs/*.json` 与 `.local/runs/nutrition/*.json`，已有记录不需迁移。
- 原图不落盘；识别时发送本次文字与图片给配置的服务，总结时发送所选周期的确认记录。文字、结构化草稿和记录存本机。
- 确认幂等、修订版本检查、文件原子替换；移除采用软删除。总结缓存只在进程内，服务重启后重新生成。
- 默认仅监听 localhost，有 Host / Origin 限制。Python 标准库 HTTP 服务用于本机演示，没有认证、多租户或公开部署能力。
- 全部工程演示资料为自建合成数据，未复制公司源码、客户资料或内部报告。真实食物照片准确率尚未系统评测。

验证见 [验证记录](docs/VALIDATION.md)，实现见 [架构](docs/ARCHITECTURE.md)。
