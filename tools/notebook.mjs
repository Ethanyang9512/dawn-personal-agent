#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { memoryPaths } from '../bridge/lib/memory.mjs';
import { listNotebook, notebookBrief, readNotebook, saveDraft } from '../bridge/lib/dawn-notebook.mjs';
export function main(args) {
  const options = { ...memoryPaths(), indexPath: process.env.DAWN_CONVERSATIONS_INDEX, vaultDir: process.env.DAWN_VAULT_DIR };
  const [command, value] = args;
  if (command === 'list') return listNotebook(options);
  if (command === 'topics') return notebookBrief({mode:'topics',after:value},options);
  if (command === 'brief' || command === 'clues') {
    const query = value?.startsWith('@') ? JSON.parse(fs.readFileSync(value.slice(1),'utf8'))
      : value?.startsWith('{') ? JSON.parse(value) : args.slice(1).join(' ');
    if (command === 'clues') {
      const selection = typeof query === 'string' ? {topic:query || undefined} : query;
      return notebookBrief({...selection,mode:'clues'},options);
    }
    return notebookBrief(query,options);
  }
  if (command === 'show') return readNotebook(value, { ...options, history: args.includes('--history') });
  if (command === 'draft') return saveDraft(JSON.parse(value?.startsWith('@') ? fs.readFileSync(value.slice(1), 'utf8') : value || '{}'), options);
  throw new Error('用法：notebook.mjs brief 关键词或JSON / clues [话题或分页JSON] / topics [上一页末项] / list / show ID / draft @JSON文件');
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); } catch (e) { console.error(JSON.stringify({ error: e.code || 'NOTEBOOK', message: e.message })); process.exitCode = 1; }
}
