import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode');
const Level = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

export function qrMatrix(text) {
  const q = new QRCode(-1, Level.M);
  q.addData(text);
  q.make();
  return q.modules;
}

export function qrSvg(text, cell = 8, margin = 4) {
  const m = qrMatrix(text);
  const n = m.length;
  const size = (n + margin * 2) * cell;
  let rects = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (m[r][c]) rects += `<rect x="${(c + margin) * cell}" y="${(r + margin) * cell}" width="${cell}" height="${cell}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}

// 终端里也打一份，方便在终端扫
export function qrTerminal(text) {
  const m = qrMatrix(text);
  const n = m.length;
  const W = '█', T = '▀', B = '▄', S = ' ';
  const at = (r, c) => (r >= 0 && r < n && c >= 0 && c < n ? m[r][c] : false);
  let out = '';
  for (let r = -2; r < n + 2; r += 2) {
    let line = '';
    for (let c = -2; c < n + 2; c++) {
      const top = at(r, c), bot = at(r + 1, c);
      // 深色模块画成空白、浅色画成实块（终端深色背景下好扫）
      line += !top && !bot ? W : !top && bot ? T : top && !bot ? B : S;
    }
    out += line + '\n';
  }
  return out;
}
