# Security

Report security issues and unintended disclosure privately through GitHub's repository advisory form. Describe the affected version, environment and how to observe the behavior with synthetic input. Avoid attaching an account file, session log, login QR code or private notebook. [Report a vulnerability](https://github.com/Ethanyang9512/dawn-personal-agent/security/advisories/new)

Dawn is intended for one trusted operator and the paired WeChat account. The host can hold plaintext messages, files, session tokens and model context. Restrict OS access to its data directory. Codex and WeChat use their respective services when the bridge is connected. [Data flow and storage](docs/operation.md)
