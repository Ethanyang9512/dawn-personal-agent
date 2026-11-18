#!/usr/bin/env node
// Offline stdio peer for the production Codex transport.
import { createInterface } from 'node:readline';

const send = message => process.stdout.write(JSON.stringify(message) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === 'initialize') send({ id, result: { userAgent: 'dawn-fixture' } });
  else if (method === 'thread/start' || method === 'thread/resume') {
    send({ id, result: { thread: { id: 'fixture-thread' } } });
  } else if (method === 'turn/start') {
    const prompt = params.input[0].text;
    const text = prompt.includes('纸样') ? '纸样收到了。' : '这是第二轮。';
    send({ id, result: { turn: { id: 'fixture-turn' } } });
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', text } } });
    send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  } else send({ id, error: { code: -32601, message: 'Unsupported fixture method' } });
}
