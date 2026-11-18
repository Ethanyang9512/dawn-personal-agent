#!/usr/bin/env python3
"""把一段 Markdown 渲染成飞书卡片样式的 PNG（手机竖屏宽度），给微信发图用。
用法：card.py 输入.md 输出.png [--title 标题] [--tone blue|green|orange|red|grey]
"""
import argparse, html, re, subprocess, sys, tempfile, os
from PIL import Image, ImageChops

import shutil

CHROME = (os.environ.get('CHROME_BIN') or shutil.which('chromium') or shutil.which('google-chrome')
          or '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
VIEW_W, VIEW_H = 1100, 6000  # 截图视口（CSS 像素）；卡片按内容宽度排，超出就判失败
TONES = {'blue': '#3370ff', 'green': '#2ea121', 'orange': '#ff7d00', 'red': '#f54a45', 'grey': '#646a73'}

def inline(s):
    s = html.escape(s)
    s = re.sub(r'`([^`]+)`', r'<code>\1</code>', s)
    s = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', s)
    return s

def md_to_html(md):
    out, lines, i = [], md.strip('\n').split('\n'), 0
    while i < len(lines):
        l = lines[i]
        if l.startswith('```'):
            j = i + 1; buf = []
            while j < len(lines) and not lines[j].startswith('```'): buf.append(lines[j]); j += 1
            out.append('<pre>' + html.escape('\n'.join(buf)) + '</pre>'); i = j + 1; continue
        if re.match(r'^\s*\|', l):
            rows = []
            while i < len(lines) and re.match(r'^\s*\|', lines[i]):
                cells = [c.strip() for c in lines[i].strip().strip('|').split('|')]
                if not all(re.fullmatch(r':?-{2,}:?', c) for c in cells): rows.append(cells)
                i += 1
            if not rows: continue
            isnum = lambda c: bool(re.fullmatch(r'[-+]?[\d,.]+%?|—|-', c.strip()))
            ncol = max(len(r) for r in rows)
            numcol = [all(isnum(r[j]) for r in rows[1:] if j < len(r)) and len(rows) > 1 for j in range(ncol)]
            cell = lambda k, j, c: f'<{"th" if k == 0 else "td"}{" class=n" if numcol[j] else ""}>{inline(c)}</{"th" if k == 0 else "td"}>'
            t = '<table>' + ''.join('<tr>' + ''.join(cell(k, j, c) for j, c in enumerate(r)) + '</tr>' for k, r in enumerate(rows)) + '</table>'
            out.append(t); continue
        m = re.match(r'^(#{1,4})\s+(.*)', l)
        if m: out.append(f'<h{len(m.group(1)) + 1}>{inline(m.group(2))}</h{len(m.group(1)) + 1}>'); i += 1; continue
        if re.match(r'^\s*[-*•]\s+', l):
            items = []
            while i < len(lines) and re.match(r'^\s*[-*•]\s+', lines[i]): items.append(inline(re.sub(r'^\s*[-*•]\s+', '', lines[i]))); i += 1
            out.append('<ul>' + ''.join(f'<li>{x}</li>' for x in items) + '</ul>'); continue
        if re.match(r'^\s*-{3,}\s*$', l): out.append('<hr>'); i += 1; continue
        if l.strip(): out.append(f'<p>{inline(l)}</p>')
        i += 1
    return '\n'.join(out)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('dst')
    ap.add_argument('--title', default=''); ap.add_argument('--tone', default='blue', choices=TONES)
    a = ap.parse_args()
    body = md_to_html(open(a.src, encoding='utf-8').read())
    color = TONES[a.tone]
    page = f'''<!doctype html><html><head><meta charset="utf-8"><style>
    body{{margin:0;background:#f2f3f5;font-family:-apple-system,"PingFang SC","Hiragino Sans GB",sans-serif;color:#1f2329}}
    .card{{display:inline-block;min-width:388px;margin:16px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)}}
    p,li,h2,h3,h4,h5,pre{{max-width:520px;overflow-wrap:anywhere}} .head{{overflow-wrap:anywhere}}
    .head{{background:{color};color:#fff;padding:14px 18px;font-size:19px;font-weight:600}}
    .body{{padding:6px 18px 16px;font-size:16px;line-height:1.65}}
    h2{{font-size:18px;margin:14px 0 6px}} h3{{font-size:17px;margin:12px 0 4px}} h4,h5{{font-size:16px;margin:10px 0 4px}}
    p{{margin:8px 0}} ul{{margin:6px 0;padding-left:20px}} li{{margin:3px 0}} b{{color:{color}}}
    code{{background:#f2f3f5;border-radius:4px;padding:1px 5px;font-family:Menlo,monospace;font-size:14px}}
    pre{{background:#f5f6f7;border-radius:8px;padding:10px 12px;font-family:Menlo,monospace;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-all}}
    table{{border-collapse:collapse;margin:10px 0;font-size:15px}} td,th{{max-width:260px;overflow-wrap:anywhere}} th{{background:#f5f6f7;font-weight:600}}
    th,td{{border:1px solid #dee0e3;padding:7px 8px;text-align:left}} td.n,th.n{{text-align:right;font-variant-numeric:tabular-nums}} hr{{border:none;border-top:1px solid #dee0e3;margin:12px 0}}
    </style></head><body><div class="card">{f'<div class="head">{html.escape(a.title)}</div>' if a.title else ''}<div class="body">{body}</div></div></body></html>'''
    with tempfile.TemporaryDirectory() as d:
        f = os.path.join(d, 'c.html'); open(f, 'w', encoding='utf-8').write(page)
        raw = os.path.join(d, 'raw.png')
        # 单独的临时用户目录：不和正在用的 Chrome 抢配置
        subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
                        f'--user-data-dir={os.path.join(d, "profile")}', '--no-first-run', '--no-default-browser-check',
                        f'--window-size={VIEW_W},{VIEW_H}', f'--screenshot={raw}', 'file://' + f], check=True, capture_output=True, timeout=60)
        im = Image.open(raw).convert('RGB')
        bg = Image.new('RGB', im.size, (242, 243, 245))
        box = ImageChops.difference(im, bg).getbbox()
        if not box:
            sys.exit('卡片是空的')
        # 内容顶到截图的右边或下边，说明有东西被截掉了：宁可失败让桥改发文字，也不发缺列缺行的图
        if box[2] >= im.width - 2 or box[3] >= im.height - 2:
            sys.exit(3)
        im = im.crop((0, 0, min(im.width, box[2] + 32), min(im.height, box[3] + 32)))
        im.save(a.dst, optimize=True)
    print(a.dst)

if __name__ == '__main__':
    main()
