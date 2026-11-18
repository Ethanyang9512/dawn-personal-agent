import { codexHome, dataHome, workspaceHome } from './locations.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { runCodex } from './codex.mjs';
import { runCodexAppServer } from './codex-app-server.mjs';

export function readBackendConfig() {
  const home = dataHome();
  try { return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export function backendOptions(cfg = {}, { pipeline = false, env = process.env } = {}) {
  const backend = cfg.backend || 'codex';
  if (backend !== 'codex' || (cfg.pipelineBackend && cfg.pipelineBackend !== 'codex')) throw new Error('Dawn 只使用 Codex；请移除旧后端配置');
  // Pass the runtime settings the model client needs, including an optional API login.
  const keys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'TERM',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'OPENAI_API_KEY', 'CODEX_API_KEY'];
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
    keys.includes(key) || key.startsWith('LC_') || key.startsWith('DAWN_')));
  childEnv.DAWN_WECHAT = '1';
  if (pipeline) childEnv.DAWN_GUARD_MODE = 'pipeline';
  if (cfg.proxy) Object.assign(childEnv, { HTTPS_PROXY: cfg.proxy, HTTP_PROXY: cfg.proxy, https_proxy: cfg.proxy, http_proxy: cfg.proxy });
  childEnv.CODEX_HOME = cfg.codexHome || codexHome();
  return {
    backend,
    runner: pipeline ? runCodex : runCodexAppServer,
    approvedComputerApps: cfg.approvedComputerApps || [],
    voiceWorkspace: cfg.workspace || workspaceHome(),
    bin: cfg.codexBin || 'codex',
    model: cfg.model || null,
    effort: cfg.effort || 'high',
    env: childEnv,
  };
}
