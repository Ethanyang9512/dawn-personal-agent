import { workspaceHome } from './locations.mjs';
import fs from 'node:fs';
import path from 'node:path';

const realpath = (file) => {
  const absolute = path.resolve(file);
  try { return fs.realpathSync(absolute); } catch {
    const suffix = [];
    let ancestor = absolute;
    while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) {
      suffix.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
    try { return path.join(fs.realpathSync(ancestor), ...suffix); } catch { return absolute; }
  }
};
const inside = (file, dir) => {
  const p = realpath(file);
  const d = realpath(dir);
  return p === d || p.startsWith(`${d}${path.sep}`);
};
const allowedIndex = file => inside(file, path.join(workspaceHome(), 'memory'));
const allowedStatus = file => inside(file, path.join(workspaceHome(), 'projects'));

function loadIndex(indexPath) {
  if (!indexPath || !allowedIndex(indexPath)) {
    const error = new Error('项目索引路径不可用');
    error.code = 'blocked';
    throw error;
  }
  const realIndex = realpath(indexPath);
  if (!allowedIndex(realIndex) || path.basename(realIndex) !== 'project-sources.json') {
    const error = new Error('项目索引路径不可用');
    error.code = 'blocked';
    throw error;
  }
  const parsed = JSON.parse(fs.readFileSync(realIndex, 'utf8'));
  if (parsed?.version !== 1 || !Array.isArray(parsed.projects)) {
    const error = new Error('项目索引格式不支持');
    error.code = 'invalid';
    throw error;
  }
  for (const project of parsed.projects) {
    if (!project || typeof project.id !== 'string' || !project.id || typeof project.name !== 'string' || !project.name || typeof project.statusPath !== 'string') {
      const error = new Error('项目索引条目无效');
      error.code = 'invalid';
      throw error;
    }
  }
  return parsed;
}

const empty = (projectId, status, checkedAt) => ({
  id: projectId, name: projectId, statusPath: '', sourceMtime: null, checkedAt, status, excerpt: '', truncated: false,
});

export function readProjectContext({ indexPath, projectId, maxChars = 4000 } = {}) {
  const checkedAt = new Date().toISOString();
  let index;
  try { index = loadIndex(indexPath); } catch (error) {
    return empty(projectId, error.code === 'ENOENT' ? 'missing' : (error.code || 'invalid'), checkedAt);
  }
  const project = index.projects.find((item) => item.id === projectId);
  if (!project) return empty(projectId, 'blocked', checkedAt);
  if (!path.isAbsolute(project.statusPath) || path.basename(project.statusPath) !== '_status.md' || !allowedStatus(project.statusPath)) {
    return empty(projectId, 'blocked', checkedAt);
  }
  const statusPath = realpath(project.statusPath);
  if (!allowedStatus(statusPath) || path.basename(statusPath) !== '_status.md') return empty(projectId, 'blocked', checkedAt);
  try {
    const source = fs.readFileSync(statusPath, 'utf8');
    const startMarker = '<!-- 现状摘要:开始 -->';
    const endMarker = '<!-- 现状摘要:结束 -->';
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker);
    const excerptSource = start >= 0 && end > start
      ? source.slice(start + startMarker.length, end).trim()
      : source;
    const cap = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : 4000;
    return {
      id: project.id,
      name: project.name,
      statusPath,
      sourceMtime: fs.statSync(statusPath).mtime.toISOString(),
      checkedAt,
      status: 'ok',
      excerpt: excerptSource.slice(0, cap),
      truncated: excerptSource.length > cap,
    };
  } catch (error) {
    return empty(projectId, error.code === 'ENOENT' ? 'missing' : 'invalid', checkedAt);
  }
}

export function readProjectContexts({ indexPath, maxTotalChars = 8000 } = {}) {
  let index;
  try { index = loadIndex(indexPath); } catch (error) {
    return [empty('project-sources', error.code === 'ENOENT' ? 'missing' : (error.code || 'invalid'), new Date().toISOString())];
  }
  let used = 0;
  return index.projects.map((project) => {
    const result = readProjectContext({ indexPath, projectId: project.id });
    const remaining = Math.max(0, maxTotalChars - used);
    if (result.excerpt.length > remaining) {
      result.excerpt = result.excerpt.slice(0, remaining);
      result.truncated = true;
    }
    used += result.excerpt.length;
    return result;
  });
}
