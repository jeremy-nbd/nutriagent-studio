# 家庭营养记录

Python 标准库服务 + 手机网页。家庭成员用独立账号登录，照片/文字识别后核对保存，也可手动填写整餐热量、蛋白质、碳水、脂肪和可选重量。直接调用已配置模型，不提供演示模式切换。

## 记录与汇总

- 每天汇总餐数、已知食物总重量和四项营养值；周趋势可切换重量/热量，周一至周日。
- 未记录日不是零摄入；手动记录的未知重量不是零克；部分重量会明确标注。
- 食物识别保留用户确认步骤，支持修改克数、减半和取消计入。AI 参考值不是权威食物成分数据库。
- 日周总结给出饮食观察和下一餐建议。只有确认记录进入统计。

## 账号和存储

设置 `AUTH_MODE=family`、`PUBLIC_ORIGIN=https://your-domain`，可选 `BASE_PATH=/family`。默认 local 模式仍供个人本机使用，禁止把未认证的 local 模式直接暴露到公网。

```sh
python3 -m nutriagent --data-dir /absolute/private/data account create --username jeremy --name 我 --role superadmin
python3 -m nutriagent --data-dir /absolute/private/data account create --username dad --name 爸爸
python3 -m nutriagent --data-dir /absolute/private/data account list
python3 -m nutriagent --data-dir /absolute/private/data account reset --username dad
```

密码交互输入，不出现在命令行参数。成员角色为 member；superadmin 在独立的“家人”页查看全部账号的日周统计、餐食、饮食记忆和咨询记录，该页面不提供代录或删除操作。普通成员只能读写自己记录。登录页会告知管理员可查看。

密码使用带随机盐的 PBKDF2-SHA256；会话保存令牌哈希，有效期7天。HTTPS 下 Cookie 设置 Secure、HttpOnly、SameSite=Strict。密码更新撤销该用户全部会话。登录按账号与连接来源限制失败次数。反向代理同机连接会共用来源限额，持续失败可等待15分钟恢复。

数据目录结构：

```text
accounts.sqlite3
users/<server-generated-user-id>/
  nutrition/<record-id>.json
  diet-memory.json
  consultations.json
```

原 local 模式的数据不会自动分配给任何家庭成员。部署使用独立 Docker 卷。备份时停止家庭容器，完整备份数据卷；恢复时保留账号数据库和对应 users 目录，避免只恢复单边。不要提交数据、账号文件或模型配置。

## 复用 Wellnest 营养能力

复用个人开源项目 Wellnest 的私有 Python 服务，配置：

```dotenv
WELLNEST_URL=http://127.0.0.1:3012
BACKEND_SERVICE_TOKEN=填写服务端共享令牌
```

适配层 `nutriagent/advisor.py` 仅允许同机 loopback 服务，不接受浏览器指定上游地址或令牌。运行时仍无新增 Python 第三方依赖；Wellnest 的 FastAPI、OCR、向量检索依赖留在已有服务中。

| Wellnest 能力 | 家庭版接入 |
| --- | --- |
| 营养师餐食解读、下一餐建议、连续问答 | 营养师页 + 每餐“营养师解读”；服务端读取当前账号选定日期记录 |
| 单专家直接回答 / 必要时协作 / 流式输出 | 固定营养师偏好进入原流程，转发真实输出；错误或中断不标记成功 |
| 饮食偏好、目标、带时间限制 | 账号内编辑、结束或删除；日期和版本校验；原 Wellnest 记忆规则负责处理过期限制作待确认 |
| PDF 资料与混合检索 | 复用 NAS 已有 OCR、向量、FTS5 和 RRF 索引；界面显示资料数量与片段 |
| 页码来源、原页核对 | 来源折叠区、原页图片链接；营养师可按原流程调用视觉核对工具 |
| 识别分量、吃一半、核对营养 | NutriAgent 原识别与确认流程，增加快捷减半；不把 AI 参考营养伪装成 PDF 查表结果 |

每次咨询只发送当前用户所选时间范围的记录摘要、饮食记忆及明确继续咨询时最近4轮成功对话。明细超过上游档案容量时明确标注省略，并保留代码计算的总量。咨询记录最多保存100次；统计和餐食本身不受此上限影响。新问题不携带旧对话；跨账号数据不进入咨询上下文。管理员查看家人数据不会改变其自身咨询身份。

PDF 文件和索引使用 NAS 现有私有挂载，不复制进公开仓库。资料著作权属于原权利人。Wellnest 的共享演示会话不会导入家庭记录；其后端无咨询持久化，家庭记录仅由本项目按账号存储。

## NAS 部署

服务继续只监听 localhost；通过与现有网关共享容器网络访问。家庭端口4372与原演示4371分开。`/family/` 由家庭账号认证，其他演示路径仍维持原有访客认证。

模型 Key 使用 NAS 私有配置文件供容器读取，不出现在网页和 Git 中。Compose 文件、私有配置、账号种子只在本地 `.local/family-deploy/` 与 NAS 部署目录保存。账号种子仅在空数据卷第一次启动时复制，重启不覆盖已有账号或密码。

可复用的 Compose 模板在 `deploy/family.compose.yaml`；首次启动脚本为 `deploy/run_family.py`，部署时放入源码目录并命名为 `run-family.py`。初始化账号数据库可用上面的 account CLI 在私有 seed 目录生成。

修改代码：同步源码到 NAS 部署目录，再重启家庭容器。更新环境配置后需重新创建容器，使环境变量生效。网关重建后，共享其网络命名空间的服务需要一起重建；NAS 已有演示服务也是同一网络结构。

## 验证

```sh
python3 -m compileall -q nutriagent run.py
python3 -m unittest discover -s tests_python -v
```

测试覆盖两账号隔离、超级管理员只读权限、密码重置/会话撤销、跨源拒绝、手动录入幂等、未知重量与周汇总、饮食记忆版本冲突、咨询只读取服务端记录、失败回答不保存，以及原有识别/确认/汇总/报告流程。
