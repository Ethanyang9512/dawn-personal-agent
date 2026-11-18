#!/usr/bin/env node
import { readProjectContext } from '../bridge/lib/project-context.mjs';

const projectId = process.argv[2];
const indexPath = process.env.DAWN_PROJECT_SOURCES_PATH;
if (!indexPath || !projectId) {
  console.error('用法：DAWN_PROJECT_SOURCES_PATH=<明确索引路径> node project-context.mjs <projectId>');
  process.exit(1);
}
const result = readProjectContext({ indexPath, projectId });
console.log(JSON.stringify(result, null, 2));
if (result.status === 'blocked' || result.status === 'invalid') process.exitCode = 1;
