# 仓库维护与上传

这是独立 Git 仓库，位置是 `nutriagent-studio/`，与业务前后端仓库相互独立。可以将整个目录（包括隐藏的 `.git`）移动到自己的个人项目目录，不依赖父目录文件。

## GitHub 账号与日常更新

远端账号为 `jeremy-nbd`，仓库地址为 [jeremy-nbd/nutriagent-studio](https://github.com/jeremy-nbd/nutriagent-studio)，使用私有可见性。提交使用该账号的 GitHub 隐私邮箱，仅在本仓库配置，不影响其他项目。

更换电脑或登录失效时，由自己完成授权：

```sh
gh auth login
gh auth status
```

确认当前账号为 `jeremy-nbd` 后，在本仓库目录更新：

```sh
git remote -v
npm run check
npm test
git add .
git commit -m "更新作品集"
git push origin main
```

首次克隆到其他电脑后，可配置本仓库的提交身份：

```sh
git config user.name "jeremy-nbd"
git config user.email "351866118+jeremy-nbd@users.noreply.github.com"
```

账号登录与提交署名是不同设置；修改这里的配置只影响本仓库，不改全局配置。现有仓库无需再次执行 `gh repo create`。

完善个人贡献说明、模型连接及许可后，再自行决定是否改为公开仓库。

## 本地配置与数据

- `.env`：模型密钥与地址，已加入忽略规则。
- `.local/runs/`：任务文件与报告，已加入忽略规则。
- 浏览器 `nutriagent:*` localStorage：当前任务与报告列表索引。
- 清理浏览器索引不会删除任务文件；新浏览器不会自动列出旧报告。

不要用 `git add -f` 提交配置或任务文件。备份数据时单独保存 `.local`，不要混进作品集源码。

## 常见修改

替换姓名和个人介绍：编辑 `public/index.html`。扩展示例餐食：修改 `src/domain.js`，同步报告观察模板和回归测试。新工具：先添加输入校验和执行前置条件，再注册工具 schema，最后补上失败与恢复测试。

修改前端后刷新页面；修改服务端时 `npm run dev` 自动重启，进行中的任务会被标记中断，可手动重试。
