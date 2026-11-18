# Dawn Personal Agent

[English](README.en.md) · [运行与数据流](docs/operation.md) · [版本记录](CHANGELOG.md)

Dawn 是可以在自己电脑上运行的单用户微信助理。你在微信里随手说一句，隔几天换个说法问回来，Dawn 可以查找带日期和说话人的原话。零散材料能整理成有来源的 Obsidian 草稿，继续改时保留上一版。

## 先试两分钟

需要 Node.js 24 或更高版本。下面的演示只用 Node.js 内置模块，输入是两段虚构的图册装订讨论。

```sh
git clone https://github.com/Ethanyang9512/dawn-personal-agent.git
cd dawn-personal-agent
npm run demo
```

终端会列出两段原话、草稿版本 2 和知识库目录。用 Obsidian 打开最后那个目录，可以对照当前稿和历史稿；也可以直接用文本编辑器阅读 Markdown。演示预置了两条检索标注，便于逐步观察证据如何变成草稿。

## 接入自己的微信

在 macOS 或 Linux 上安装 Node.js 24+、npm 和已支持 `app-server` 与 `exec` 的 OpenAI Codex CLI。微信端需要能使用 iLink 扫码配对的账号。[Codex CLI](https://github.com/openai/codex) · [腾讯 iLink 协议说明](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md)

```sh
npm ci
bin/dawn init
bin/dawn codex-login
bin/dawn login --no-open
bin/dawn start
```

第一步初始化会打印配置、工作区和知识库的位置。Codex 登录和微信扫码是两次独立授权。扫码后，用绑定的微信给 Dawn 发一条消息。另开终端运行 `bin/dawn status` 可看配对状态和最近一次成功轮询时间。桥只接受绑定用户的单聊消息。

## 三件可以试的事

| 场景 | 在微信里怎么说 | Dawn 有什么依据 |
| --- | --- | --- |
| 重新考虑机会 | “上次那个工坊职位为什么先搁下？如果只排白班呢？” | 从机会记录回查当时的原话，把后来证实的变化与假设分别列出。 |
| 把聊天接成稿子 | “把这几次聊到的纸张和装订整理成一份制作说明，接着上版改。” | 查找原话和已有草稿，按当前版本修订。遇到手改冲突时可以重读并合并。 |
| 持续跟进 | “明天下午三点提醒我向工坊确认班次。” | 到期提醒、长任务与投递回执落在本机。相近话题无法区分时，助理手册要求只追问一个辨别问题。 |

新安装从空白记忆开始。表中的职位和图册都是虚构示例，实际使用需要先提供自己的材料。原话和结构化决策可以复查，换说法能否找对仍受素材、标注和模型判断影响。

## 数据和日常运行

- 默认数据根目录为 `~/.dawn-personal-agent`。`workspace/memory` 保存原始记录，SQLite 索引可以从记录重建。Dawn 在配置的 vault 内维护 `30_Resources/Dawn/`。Obsidian 无需一直打开。
- 微信收发会连接腾讯，聊天及后台整理会把本次需要的内容交给所配置的 Codex 服务。原话、附件、运行日志及认证材料保存在本机数据目录。查看配置、备份和常驻运行说明。[运行手册](docs/operation.md)
- 日报和周复盘都可先在本机生成。`bin/dawn digest` 和 `bin/dawn review` 生成文件，显式加 `--send` 才排入微信发送队列。定时提醒使用 UTC+8。长图渲染另需 Chromium 或 Chrome、Python 3 和 Pillow。
- `npm test` 运行离线测试，包含回环微信服务、模拟 Codex、陌生人过滤、重复消息、草稿版本冲突和提醒配置。测试不需要任何个人账号。

## 贡献与授权

代码采用 MIT，项目文档采用 CC BY 4.0。第三方组件保留各自许可。欢迎用虚构数据提交复现和改进。[贡献指南](CONTRIBUTING.md) · [安全报告](SECURITY.md) · [代码许可](LICENSE) · [文档许可](LICENSE-docs) · [第三方声明](THIRD_PARTY_NOTICES.md)
