# CodeRelay 0.1.0 · 首次候选发布

提供统一 MCP 网关和可安装 MiniMax Code 桌面 Mini App。

- 持久化任务队列、租约、请求幂等、命令回执、事件序号与审计。
- OAuth PKCE、一次性连接码、客户端/设备凭据隔离和撤销。
- 官方 MCP SDK 的新旧协议连接、12 个任务工具与有界结果分页。
- 专用项目会话、审批/问卷、追加要求、取消、失租和重启恢复。
- 独立 Git 证据与本地用户配置的真实验证进程。
- 中文界面、容器/原生部署、备份及明确的未知结果处理。

## 下载

- `coderelay-gateway-0.1.0.tar.gz`：已编译网关、源码及维护文档。解压后运行 `npm ci --omit=dev`。
- `coderelay-minimax-0.1.0.zip`：自包含桌面插件，无需 npm 安装。保留隐藏的 `.minimax-plugin` 目录。
- `SHA256SUMS`：上述制品校验和。

## 验证边界

自动化覆盖实际 HTTP、SQLite、官方 MCP Client、Git 与验证子进程。MiniMax Host 在测试中明确是合成 fixture；真实已登录 MiniMax Desktop、ChatGPT/Claude 账号和实际额度尚未实机验收。因此此版本保留为 **prerelease**，不宣称已经完成生产封存。

安装和最终验收流程见仓库 README、`docs/operations.md` 和 `docs/acceptance.md`。
