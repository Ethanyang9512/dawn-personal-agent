import fs from 'node:fs';
import path from 'node:path';

export function imageInputs(prompts, workspace, maxAgeMinutes = 10) {
  const images = [];
  for (const p of prompts) for (const a of p.attachments || []) {
    if (a.type !== 2 || !a.path || p.imageAt - p.receivedAt > maxAgeMinutes * 60000) continue;
    try {
      const file = fs.realpathSync(a.path), root = fs.realpathSync(path.join(workspace, '收件')) + path.sep;
      if (file.startsWith(root) && fs.statSync(file).isFile() && /\.(png|jpe?g|gif|webp)$/i.test(file) && !images.includes(file) && images.length < 6) images.push(file);
    } catch { /* 缺失或不支持的附件仍保留文字路径。 */ }
  }
  return images;
}

export function imageNotes(prompts, images) {
  const inline=file=>{try{return images.includes(fs.realpathSync(file));}catch{return false;}};
  const lines=prompts.flatMap(p=>(p.attachments||[]).filter(a=>a.type===2&&a.path).map(a=>`- ${a.path}（${inline(a.path)?'已随消息附上':'未附上，需要时按路径查看'}）`));
  return lines.length?'\n[本轮收件图片]\n'+lines.join('\n'):'';
}
