import os from 'node:os';
import path from 'node:path';

export const dataHome = () => path.resolve(process.env.DAWN_HOME || path.join(os.homedir(), '.dawn-personal-agent'));
export const workspaceHome = () => process.env.DAWN_WORKSPACE || path.join(dataHome(), 'workspace');
export const codexHome = () => path.join(dataHome(), 'codex');
