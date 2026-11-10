# NutriAgent Studio 工作约定

- 独立个人作品集仓库，禁止复制公司源码、真实客户记录、密钥或内部报告。
- 使用 Python 3.10+ 标准库实现后端与 CLI，网页使用原生 HTML/CSS/JS；无需 Node 运行时。
- `nutriagent/core.py` 管理配置/HTTP模型调用/原子存储；`nutrition.py` 管理真实饮食与日周总结；`agent.py` 管理合成示例工具；`server.py` 管理HTTP/SSE；`public/` 管理界面。
- 保持 JSON API 与旧数据兼容；不可忽略确认状态、并发幂等、版本检查或把缺失记录按0累计。
- 示例编排、真实模型、合成数据必须明确标注；图片份量及参考营养是估算，未接入的RAG不得宣传已实现。
- 修改业务逻辑后运行 `python3 -m compileall -q nutriagent run.py` 和 `python3 -m unittest discover -s tests_python -v`。
- `.env`、`.local/`、缓存、虚拟环境不提交。单个数据目录只由一个进程运行。
- 个人远端为 `jeremy-nbd/nutriagent-studio`，不要更改为公司账号。上传前检查全部暂存变更。
