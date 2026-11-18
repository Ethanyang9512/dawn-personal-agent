// Emit a user service definition for this checkout. The operator installs it locally.
import { dataHome } from '../bridge/lib/locations.mjs';
import fs from 'node:fs';
import path from 'node:path';

const type = process.argv[2];
const home = dataHome();
const cli = path.resolve(import.meta.dirname, '../bin/dawn');
const searchPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
if (!fs.existsSync(path.join(home, 'config.json'))) throw Error('Run bin/dawn init first.');
const args = [process.execPath, cli, 'start'];
const env = { DAWN_HOME: home, PATH: searchPath };
for (const value of [...args, ...Object.values(env)]) {
  if (/[\r\n\0]/.test(value)) throw Error('A service path contains a line break or NUL.');
}
if (type === 'launchd') {
  const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  console.log(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>org.dawn-personal-agent</string>
  <key>ProgramArguments</key><array>${args.map(arg => '<string>' + xml(arg) + '</string>').join('')}</array>
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => '<key>' + key + '</key><string>' + xml(value) + '</string>').join('')}</dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
</dict></plist>`);
} else if (type === 'systemd') {
  const quote = value => '"' + value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%') + '"';
  const lines = ['[Unit]', 'Description=Dawn personal WeChat agent', 'After=network-online.target', '',
    '[Service]', 'Type=simple', ...Object.entries(env).map(([key, value]) => 'Environment=' + quote(key + '=' + value)),
    'ExecStart=' + args.map(arg => quote(arg.replaceAll('$', () => '$$'))).join(' '),
    'Restart=on-failure', 'RestartSec=10', 'UMask=0077', '', '[Install]', 'WantedBy=default.target'];
  console.log(lines.join('\n'));
} else {
  throw Error('Usage: node deploy/service.mjs launchd|systemd');
}
