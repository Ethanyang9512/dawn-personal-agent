# 运行与数据流

## 消息走哪条路

微信 iLink 长轮询 → 按扫码身份过滤 → 收件记录落盘、按消息 ID 去重 → Codex app-server 执行 → 结果落盘 → 微信发送队列 → 平台回执。桥重启会读取已有执行记录和投递状态。遇到执行进程已经中断、无法确认完成情况的任务，会保留记录供核对。

微信原文和最终回复分别保存角色及日期。后台整理给原记录附上索引词和可验证的原文摘录。原文、索引和可编辑 Markdown 各有用途。重建索引不会把助手写的草稿变成用户的原话。

## 本机目录

首次 `bin/dawn init` 打印配置位置。可先设置 `DAWN_HOME` 为一个独立的绝对路径。后续命令和后台服务要使用同一个目录。工作区或 vault 路径调整后可再次运行 init 补齐目录。已有模板和配置会保留用户的修改。

| 相对数据根目录 | 内容 |
| --- | --- |
| `config.json`、`codex/` | 实例设置、Codex 配置及登录状态 |
| `state/`、`logs/`、`outgoing/` | 微信配对材料、收件与投递状态、运行日志、待发条目 |
| `workspace/memory/` | 对话原文、检索标注和明确保存的事实 |
| `workspace/state/` | 可重建的聊天索引、长期任务状态与写入事务 |
| `workspace/收件/`、`workspace/发出/` | 收到的附件及用户要求交付的成果 |
| `vault/30_Resources/Dawn/` | 日常页、话题页、可编辑草稿与历史版本 |

在 `config.json` 里设置 `obsidianVault` 为已有知识库的绝对路径即可接入；使用路径的真实目录，托管笔记拒绝软链接。设为 `null` 可关闭 Obsidian 写入。`codexBin` 可填 CLI 绝对路径。`model` 默认为 null，由用户登录的 Codex 选择默认模型。`effort` 默认 high。网络需要模型代理时单独设置 `proxy`，微信链路独立连接。重启桥后配置生效。

运行端使用专属 Codex 目录及 workspace-write。聊天可以调用工作区工具。用于整理、日报与复盘的 exec 进程使用只读沙箱并关闭 shell，管线另检查模型工具调用与结果格式。操作系统账号决定进程能读取哪些文件；共享机器宜给 Dawn 分配独立系统用户。备份时先停桥，复制完整数据根目录和任何单独指定的 vault。备份内含原话和认证材料，应存入访问受限的本机位置。

## 保持运行

在终端运行 `bin/dawn start`，退出后桥会停止。希望系统登录后持续收消息时，可把同一条前台命令交给 macOS LaunchAgent 或 Linux systemd 用户服务。以下命令使用当前 checkout 和已初始化的实例来生成本机服务文件。

**macOS**

```sh
mkdir -p "$HOME/Library/LaunchAgents"
node deploy/service.mjs launchd > "$HOME/Library/LaunchAgents/org.dawn-personal-agent.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/org.dawn-personal-agent.plist"
```

停用时运行 `launchctl bootout "gui/$(id -u)/org.dawn-personal-agent"`。

**Linux**

```sh
mkdir -p "$HOME/.config/systemd/user"
node deploy/service.mjs systemd > "$HOME/.config/systemd/user/dawn-personal-agent.service"
systemctl --user daemon-reload
systemctl --user enable --now dawn-personal-agent.service
```

停用时运行 `systemctl --user disable --now dawn-personal-agent.service`。同一实例运行一份桥。保留 checkout 的路径，因为工作区工具和服务都引用它。

## 日报、复盘与提醒

- `bin/dawn digest --date 2026-01-08` 指定报告日期。采集器读取配置中公开 RSS 源的**当前**最近 48 小时，不会为历史日期重建当年的新闻。信息源在 `digest/sources.json`，编辑规则在 `digest/editor-prompt.md`。
- `bin/dawn review --days 7` 根据已有的任务、事实、产物和运行记录生成复盘正文及摘要。首次使用数据量少，复盘内容也少。
- `--send` 只表示允许排入本机投递队列。收件人的活动窗口、夜间静默和发送额度会影响实际送达。系统定时器或 cron 可按需要调用这些命令；发布版默认由操作者决定发送时间。
- 长图和卡片需要 Python 3、Pillow 和本机 Chrome/Chromium。可用 `CHROME_BIN` 指定浏览器可执行文件，在配置中用 `pythonBin` 指向装有 Pillow 的 Python。渲染失败时，本地仍可读生成的 Markdown 日报。
- 查状态先用 `bin/dawn status`。配对失效时重新运行 `bin/dawn login --fresh --no-open`；模型登录失败时用 `bin/dawn codex-login`。诊断日志可能包含个人内容，公开报告请另写一个虚构复现。
