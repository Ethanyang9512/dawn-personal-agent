#!/usr/bin/env node
import { readSelfStatus } from '../bridge/lib/self-status.mjs';

const file = process.env.DAWN_SELF_STATUS_PATH;
if (!file) {
  console.error('用法：DAWN_SELF_STATUS_PATH=<明确快照路径> node self-status.mjs');
  process.exit(1);
}
const result = readSelfStatus(file);
console.log(JSON.stringify(result, null, 2));
if (result.error) process.exitCode = 1;
