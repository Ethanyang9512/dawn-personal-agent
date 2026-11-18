import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureConversation, conversationPaths, refreshConversationSources } from './conversation-memory.mjs';
import { writeDurableJson } from './durable-json.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');

// 只导入既有 Dawn 流水。Obsidian 派生笔记、草稿、模板均不回灌成新证据。
export function importConversationLogs(options = {}) {
  const p = conversationPaths(options), directory = path.join(p.memoryDir, 'log');
  if (!fs.existsSync(directory)) return { imported: 0, changed: 0 };
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('流水目录不能是软链');
  const stateFile = path.join(path.dirname(p.indexPath), 'conversation-import.json');
  if (fs.existsSync(stateFile) && fs.lstatSync(stateFile).isSymbolicLink()) throw new Error('导入状态不能是软链');
  const previous = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  const next = {}; let imported = 0;
  for (const name of fs.readdirSync(directory).filter(n => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort()) {
    const file = path.join(directory, name); if (!fs.lstatSync(file).isFile()) continue;
    const raw = fs.readFileSync(file, 'utf8'), digest = hash(raw); next[name] = digest;
    if (previous[name] === digest) continue;
    // 一条流水本身可能是转述或推测，始终保持 legacy 身份。
    for (const text of raw.split(/\r?\n/).filter(line => /^-\s+\S/.test(line))) {
      const time = /^-\s+(\d{2}:\d{2})\b/.exec(text)?.[1] || '12:00';
      const at = `${name.slice(0,10)}T${time}:00+08:00`, sha256 = hash(text);
      captureConversation({ sourceId: `${file}:${sha256}`, role: 'legacy', text, at,
        source: { kind: 'legacy_log', key: `${file}:${sha256}`, path: file, sha256, fragment: true } }, p);
      imported++;
    }
  }
  const { changed } = refreshConversationSources(p);
  if (JSON.stringify(next) !== JSON.stringify(previous)) writeDurableJson(stateFile, next);
  return { imported, changed };
}
