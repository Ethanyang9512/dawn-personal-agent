import { workspaceHome } from './locations.mjs';
import fs from 'node:fs';
import path from 'node:path';

export function voiceInstructions(workspace = workspaceHome()) {
  const file = path.join(workspace, '.agents', 'skills', 'dawn-voice', 'SKILL.md');
  try {
    return fs.readFileSync(file, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}
