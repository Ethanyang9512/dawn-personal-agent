#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { memoryPaths, readMemory, correctMemory, rememberMemory, searchMemory, memoryHistory, currentProject } from '../bridge/lib/memory.mjs';
import { readNow, updateNow, searchArchive, readArchive, maintenanceStatus } from '../bridge/lib/memory-maintenance.mjs';
import { searchConversations, readConversation, conversationStatus } from '../bridge/lib/conversation-memory.mjs';

const jsonInput = value => JSON.parse(value === '-' ? fs.readFileSync(0, 'utf8') : value?.startsWith('@') ? fs.readFileSync(value.slice(1), 'utf8') : value || '{}');

export function main(args) {
  const paths = memoryPaths();
  const [action, value] = args;
  if (action === 'remember') return rememberMemory(jsonInput(value), paths);
  if (action === 'list') return readMemory(paths).records;
  if (action === 'show') return readMemory(paths).records.find(r => r.id === value) || { status: 'missing', id: value };
  if (action === 'search') return { ...searchMemory(args.slice(1).join(' '), paths), archives: searchArchive(args.slice(1).join(' '), paths) };
  if (action === 'history') return memoryHistory(value, paths);
  if (action === 'project') return currentProject(value, paths);
  if (action === 'state') return readNow(paths);
  if (action === 'update-state') return updateNow(jsonInput(value), paths);
  if (action === 'archive') return readArchive(value, { ...paths, history: args.includes('--history') });
  if (action === 'maintenance-status') return maintenanceStatus(paths);
  if (action === 'recall') return searchConversations(value?.startsWith('@') ? jsonInput(value) : { query: args.slice(1).join(' ') }, { ...paths, factsRevision: readMemory(paths).revision });
  if (action === 'episode') return readConversation(value, { ...paths, history: args.includes('--history'), factsRevision: readMemory(paths).revision });
  if (action === 'conversation-status') return conversationStatus(paths);
  if (action === 'correct') {
    return correctMemory(jsonInput(value), paths);
  }
  throw Object.assign(new Error('用法：memory.mjs remember JSON或@文件/list/show ID/search 词/history ID/project ID/correct @JSON文件/state/update-state @JSON文件/archive ID [--history]/maintenance-status/recall 词或@JSON/episode ID [--history]/conversation-status'), { code: 'USAGE' });
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); } catch (e) { console.error(JSON.stringify({ error: e.code || 'MEMORY_ERROR', message: e.message })); process.exitCode = 1; }
}
