// Inspect the Git index, including staged contents that differ from the working tree.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const git = (...args) => execFileSync('git', args, { cwd: path.resolve(import.meta.dirname, '..'), maxBuffer: 16 * 1024 * 1024 });
const privatePath = /(?:^|\/)(?:auth\.json|account(?:\..+)?\.json|bridge-state\.json|conversations\.sqlite.*|login-qr\.html|verify-code\.txt|\.env(?:\..+)?|id_rsa|id_ed25519|deny_terms\.txt)$|^(?:state|logs|memory|vault|workspace|outgoing|codex|_build[^/]*)\/|\.(?:pem|p12|pfx)$/i;
const credential = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:github_pat_[a-z\d_]{32,}|gh[pousr]_[a-z\d]{30,}|sk-(?:proj-)?[a-z\d_-]{24,}|AKIA[A-Z\d]{16})\b/i;
const personalPath = /(?:\/Users\/|\/home\/)[^/\s"'$<>{}]+\/|[A-Z]:\\Users\\[^\\\s"'$<>{}]+\\/;
const recipient = /(?:^|[^a-z\d])(?:ou_|oc_|wxid_)[a-z\d_-]{12,}/i;
const problems = [];
const entries = git('ls-files', '--stage', '-z').toString().split('\0').filter(Boolean);
for (const entry of entries) {
  const tab = entry.indexOf('\t');
  const [mode, hash, stage] = entry.slice(0, tab).split(' ');
  const file = entry.slice(tab + 1);
  if (!['100644', '100755'].includes(mode) || stage !== '0' || privatePath.test(file) || file === 'config.json') {
    problems.push(file + ' (private path or unsupported Git entry)');
    continue;
  }
  const body = git('cat-file', 'blob', hash);
  if (body.includes(0)) {
    problems.push(file + ' (binary file requires review)');
    continue;
  }
  const lines = body.toString('utf8').split('\n');
  for (const [i, line] of lines.entries()) {
    if ([credential, personalPath, recipient].some(pattern => pattern.test(line))) problems.push(file + ':' + (i+1));
  }
}
if (!entries.length || problems.length) {
  console.error('Public tree check failed.', ...problems);
  process.exitCode = 1;
} else console.log('Checked ' + entries.length + ' staged text files.');
