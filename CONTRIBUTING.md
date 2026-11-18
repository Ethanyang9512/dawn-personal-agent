# Contributing

Use Node.js 24 or later. Install the locked npm dependency and run the tests and notebook demo.

```sh
npm ci
node scripts/check-public.mjs
npm test
npm run demo
```

For a change to the bridge, exercise the message through the loopback integration test. For a change to recall, include a synthetic positive example, a similar competing topic and an unrelated query. For notebook writes, cover a manual edit or stale revision. Keep tests independent of live accounts and network services.

A pull request should describe the observed behavior, what changed and how you checked it. Write examples from scratch. Remove account identifiers, conversation excerpts, authentication files, QR codes and absolute machine paths from reports. Use the private security channel for confidential findings. [Security policy](SECURITY.md)
