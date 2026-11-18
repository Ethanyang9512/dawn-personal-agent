# Dawn Personal Agent

[中文](README.md) · [Operations](docs/operation.md) · [Changelog](CHANGELOG.md)

Dawn connects one person's WeChat to a self-hosted Codex bridge. It keeps dated, attributed conversation records, revisits decisions and turns ideas from several chats into editable, source-linked Obsidian drafts. Most built-in prompts, notebook headings and chat commands are in Chinese.

## Try the notebook

With Node.js 24 or later, run the example before pairing any accounts.

```sh
git clone https://github.com/Ethanyang9512/dawn-personal-agent.git
cd dawn-personal-agent
npm run demo
```

Two fictional bookbinding conversations already have topic annotations. The demo retrieves the source passages, writes a draft, revises it and prints the vault path. Open that directory in Obsidian or read the Markdown files directly.

## Run the bridge

On macOS or Linux install Node.js 24+, npm and the OpenAI Codex CLI with app-server and exec support. Pairing requires a WeChat account with access to iLink. [Codex CLI](https://github.com/openai/codex) · [iLink protocol](https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md)

```sh
npm ci
bin/dawn init
bin/dawn codex-login
bin/dawn login --no-open
bin/dawn start
```

Sign in to Codex, then scan the separate WeChat QR code. Send the first message from the paired account. Run `bin/dawn status` in another terminal to see when polling last succeeded. The repository ships an empty profile. Add your own notes or decisions before asking Dawn to recall them.

- **Recall a decision.** Ask why an opportunity was put on hold and whether a change would affect it. The decision record links to what you actually said. A hypothetical change can be compared without updating the stored decision.
- **Revise a draft.** Ask Dawn to combine thoughts from different dates. The notebook retains source identities, the previous revision and edits made in Obsidian. Overlapping topics may need a short clarification.
- **Keep working between chats.** The bridge can track tasks, run reminders, monitor public sources and generate digests or weekly reviews. `bin/dawn digest` and `bin/dawn review` write locally. Add `--send` to queue a report for WeChat. Scheduling currently uses UTC+8.

Private data defaults to `~/.dawn-personal-agent`, outside the checkout. Model calls send the relevant context to the configured Codex provider. WeChat transport uses Tencent's service. The bridge accepts direct messages from its paired owner. Optional image rendering uses Chrome or Chromium, Python 3 and Pillow. For configuration, backups and running the bridge as a user service, see the [operations guide](docs/operation.md).

`npm test` exercises installation, pairing against a loopback server, recovery, message deduplication, version conflicts and scheduled actions using synthetic fixtures. Code is available under MIT and project documentation under CC BY 4.0. [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)
