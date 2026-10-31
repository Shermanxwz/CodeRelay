# 部署与维护

## 推荐：Docker Compose + HTTPS

准备一个自己控制的域名，将 DNS 指向网关服务器，允许服务器接收 80/443。不要把未鉴权的内部程序端口转发到公网。

```sh
git clone https://github.com/Shermanxwz/CodeRelay.git
cd CodeRelay
cp .env.example .env
```

编辑 `.env` 中的 `CODERELAY_DOMAIN`。然后以实际域名初始化一次：

```sh
docker compose build
docker compose run --rm gateway node dist/src/cli.js init --public-url https://relay.example.com --host 0.0.0.0
docker compose up -d
docker compose exec gateway node dist/src/cli.js doctor
docker compose exec gateway node dist/src/cli.js pair --name "我的开发机"
docker compose exec gateway node dist/src/cli.js connector-code
```

网关使用非 root 用户；根文件系统只读，SQLite 和私密配置保存在 `coderelay-data` 卷。Caddy 负责 TLS，网关端口仅在 Compose 网络内开放。Caddy 镜像与 Node 基础镜像跟随各自稳定主版本；上线前记录实际镜像 digest，升级时重新验证，不把标签当不可变制品。

`.env` 只配置域名，不放模型 API Key。CodeRelay 不需要 MiniMax 登录令牌。`init` 生成的管理员凭据只保存在私密配置中；保留整个状态卷。不要运行 `docker compose down -v` 来更新服务。

## 不使用容器

Node 24/26、`npm ci` 和 `npm run build` 后运行 CLI。默认绑定 `127.0.0.1:8787`。已有反向代理可转发到该地址，并保持原始 Host。

Linux 系统服务示例是 `deploy/coderelay.service`。创建专用 `coderelay` 用户，将程序放在 `/opt/coderelay`、状态放在 `/var/lib/coderelay`，确认 `/usr/bin/node` 指向支持的 Node 版本。在该用户身份下初始化，再安装服务文件。程序文件可只读；状态目录必须可写。

默认状态目录为 `~/.coderelay`，可用 `--data-dir PATH` 或 `CODERELAY_DATA_DIR` 指定。POSIX 上目录要求 `0700`，配置要求 `0600`；Windows 使用受保护的用户目录并核对其继承 ACL。不要将状态目录放在共享或云同步文件夹。

支持环境变量：

| 变量                   | 含义                                            |
| ---------------------- | ----------------------------------------------- |
| `CODERELAY_DATA_DIR`   | 私密状态目录                                    |
| `CODERELAY_PUBLIC_URL` | 对外 HTTPS origin，覆盖配置中的地址             |
| `CODERELAY_HOST`       | 监听地址；公网绑定需要 HTTPS origin 和 TLS 代理 |
| `CODERELAY_PORT`       | 内部端口，默认 8787                             |

`PUBLIC_URL` 必须是 origin，不能带子路径、查询、账号密码或片段。修改域名会改变 OAuth audience；重新连接客户端，不复制旧令牌去绕过绑定。

## 客户端凭据

ChatGPT／Claude 优先通过 OAuth 连接。CodeRelay 提供 DCR、授权码、PKCE S256、刷新轮换和撤销。一次性 owner 授权码五分钟有效；OAuth access token 一小时有效；刷新家族存在绝对时限。

只有在明确需要静态 Bearer 的 CLI 集成时生成访问令牌：

```sh
node dist/src/cli.js access-token --name "我的CLI" --scopes tasks:read,tasks:write
```

令牌只输出一次，默认 30 天有效。放进客户端的凭据管理器或受保护环境，不放代码、URL、工单或聊天。撤销时使用标准输入传入：

```sh
node dist/src/cli.js revoke-token < /path/to/private-token-file
```

该文件仅应包含待撤销的令牌。OAuth access token 的管理员撤销会撤销其整条家族。客户端也可使用标准 OAuth revoke 端点。

设备撤销：

```sh
node dist/src/cli.js revoke-device --id DEVICE_ID
```

设备凭据立即失效；已在设备执行的任务不被假定已停止，会保留为未知结果。需要在真实设备确认停止。

## 日常检查

```sh
node dist/src/cli.js status
node dist/src/cli.js audit
node dist/src/cli.js doctor
```

`doctor` 检查配置和本地网关就绪，**不验证 MiniMax 已登录、模型额度或公网 DNS/TLS**。公网可从另一台设备访问 `/healthz`；MCP、任务、设备记录都需要对应凭据。网关应用日志只输出请求 ID 和错误类别，不输出凭据或完整任务文本。反向代理也不应记录授权头或请求体。

## 中断和未知结果

网关重启保留 SQLite 中的租约。设备仍在线且租约未过期时可以续报进度；过期后标记 unknown，不能自动领取替代任务。桌面插件重启从暂停接单状态开始，已开始但结果未知的任务不会自动调用 Agent。

处理顺序：

1. 在 MiniMax 查看对应专用会话与实际进程；确认是否仍在运行。
2. 查看工作区的实际变更，保存需要的日志、产物和验证证据。
3. 确认进程已经停止后，用 `reconcile` 写入明确结论及理由。
4. 在插件选择检查处理结果。宿主会话是否可继续不能确定时，重新绑定项目专用会话。
5. 新任务使用新的 `requestKey`，只重试网络交付时才沿用旧键。

取消也是请求，不是执行结束的证明。Agent 或验证程序可能创建脱离其进程组的后台进程，CodeRelay 不承诺 OS 级隔离或远端副作用恰好一次。

## 备份和恢复

使用 SQLite 在线备份 API，可在网关运行时生成各数据库的一致性快照：

```sh
node dist/src/cli.js backup --output /private/backups/coderelay-2026-10-31
```

输出目录必须尚不存在。最终 `manifest.json` 列出每个文件的 SHA-256，只有生成 manifest 并校验通过的目录才视为完成备份。备份包含管理员凭据、授权状态、任务与审计，按秘密数据保存。

恢复时先暂停接单并停止网关和设备桥接，核对 manifest，将数据库及配置恢复到受保护的状态目录；确保没有残留旧 WAL/SHM 文件混入新的快照。恢复后核对活跃/unknown 任务的真实执行结果，不能仅凭旧快照重新运行。需要更换管理员密钥或重新授权时，按实际泄露范围处理，不能假定备份中的旧凭据仍可信。

## 容量、更新与回滚

当前是个人/单团队拥有者的有界队列：每设备最多 256 项目、1000 排队任务，部署最多 10000 任务，单任务最多 50000 事件、100 待处理命令。结果最多 512 KiB、事件批次最多 128 KiB。达到限制会明确拒绝，不静默丢弃旧任务。没有自动归档或定时删除审计功能，定期检查磁盘并在容量前完成备份与人工归档规划。

升级前暂停接单、等待活跃任务结束、处理 unknown、备份。安装完整版本，执行依赖和测试检查，再启动网关；MiniMax 插件应在退出服务后整体替换，保留它独立的运行数据。数据库版本比程序更新时应拒绝启动，不强行降级；回滚应使用兼容版本和已核对的备份。安全更新不属于“封存后永远不维护”的承诺。
