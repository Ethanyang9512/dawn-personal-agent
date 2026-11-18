#!/usr/bin/env python3
"""Dawn 日报渲染：digest 数据 JSON -> 两张长图（报头+AI 前沿 / 政经+科技+历史上的今天）
用法：render.py 数据.json 输出目录；输出 page1.png / page2.png
"""
import json, sys, os, html, subprocess, tempfile
from datetime import datetime, timezone, timedelta
from PIL import Image, ImageChops

import shutil

CHROME = (os.environ.get('CHROME_BIN') or shutil.which('chromium') or shutil.which('google-chrome')
          or '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
W, H = 840, 12000
PAPER = (245, 241, 232)
ACCENT = {key: '#2e6b4f' for key in ('ai', 'world', 'tech', 'history')}
SECTION = {'ai': ('AI 前沿', 'AI FRONTIER'), 'world': ('政经', 'WORLD & ECONOMY'),
           'tech': ('科技与开源', 'TECH & OPEN SOURCE'), 'history': ('历史上的今天', 'ON THIS DAY')}
BJ = timezone(timedelta(hours=8))

def esc(s):
    return html.escape(str(s or ''), quote=False)

def rel_time(iso):
    if not iso:
        return ''
    try:
        t = datetime.fromisoformat(iso.replace('Z', '+00:00'))
        mins = int((datetime.now(timezone.utc) - t).total_seconds() / 60)
        if mins < 0:
            return ''
        if mins < 60:
            return f'{max(1, mins)} 分钟前'
        if mins < 60 * 24:
            return f'{mins // 60} 小时前'
        return f'{mins // (60 * 24)} 天前'
    except Exception:
        return ''

def src_line(it):
    parts = []
    for s in it.get('sources', []):
        t = rel_time(s.get('time'))
        parts.append(esc(s.get('name')) + (f' · {t}' if t else ''))
    return ' / '.join(parts)

def item_html(it, idx):
    color = ACCENT[it['section']]
    why = f'<div class="why" style="color:{color}"><span>为什么值得看</span>{esc(it.get("why"))}</div>' if it.get('why') else ''
    return f'''<div class="item">
      <div class="num" style="color:{color}">{idx:02d}</div>
      <div class="ibody"><div class="title">{esc(it.get('title'))}</div>
      <div class="summary">{esc(it.get('summary'))}</div>{why}
      <div class="src"><span class="dot" style="background:{color}"></span>{src_line(it)}</div></div></div>'''

def section_html(key, items, start=1):
    if not items:
        return ''
    zh, en = SECTION[key]
    color = ACCENT[key]
    body = ''.join(item_html(it, start + i) for i, it in enumerate(items))
    return f'''<div class="sec"><div class="sechead" style="color:{color}">
      <span class="secname">{zh}</span><span class="secen">{en}</span>
      <span class="seccount">{len(items)} 条</span></div>{body}</div>'''

def history_html(rows):
    if not rows:
        return ''
    zh, en = SECTION['history']
    color = ACCENT['history']
    body = ''.join(f'<div class="hitem"><span class="hyear" style="color:{color}">{esc(r.get("year"))}</span><span class="htext">{esc(r.get("text"))}</span></div>' for r in rows)
    return f'''<div class="sec"><div class="sechead" style="color:{color}">
      <span class="secname">{zh}</span><span class="secen">{en}</span></div>
      <div class="item"><div class="hbody">{body}</div></div></div>'''

CSS = '''
*{box-sizing:border-box} body{margin:0;width:840px;background:#f5f1e8;font-family:"PingFang SC","Hiragino Sans GB",sans-serif;color:#16251b;-webkit-font-smoothing:antialiased}
.main{padding:42px 46px 24px}
.mast{border-top:5px solid #16251b;border-bottom:1px solid #16251b;padding:24px 0 22px}
.masttop{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}
.brand{font-family:"Baskerville","Songti SC",serif;font-size:66px;font-weight:500;letter-spacing:1px;line-height:1.12}.brand small{display:block;font-family:"Helvetica Neue",sans-serif;font-size:15px;font-weight:500;letter-spacing:6px;margin:14px 0 0 3px;color:#5d665d}
.issue{font-size:20px;color:#5d665d;padding-top:10px;white-space:nowrap}
.mastdate{display:flex;justify-content:space-between;align-items:flex-end;margin-top:30px;gap:15px}
.bigdate{font-size:26px;font-weight:500}.bigdate span{font-size:21px;font-weight:400;color:#5d665d;margin-left:14px}
.count{font-size:18px;color:#5d665d;white-space:nowrap}
.guide{margin:26px 0 0;padding:22px 24px;background:#e8dfcf;font-family:"Songti SC",serif;font-size:29px;line-height:1.65}
.guide b{display:block;color:#2e6b4f;margin-bottom:10px;font-family:"PingFang SC",sans-serif;font-size:18px;font-weight:500;letter-spacing:3px}
.sec{margin-top:38px}.sechead{display:flex;align-items:baseline;gap:16px;border-bottom:2px solid #2e6b4f;padding-bottom:14px}
.secname{font-size:32px;font-weight:600;letter-spacing:1px}.secen{font-size:14px;letter-spacing:2px;color:#5d665d}
.seccount{margin-left:auto;font-size:18px;color:#5d665d;white-space:nowrap}
.item{display:flex;gap:18px;padding:28px 0 30px;border-bottom:1px solid #d1d4c9}
.item:last-child{border-bottom:0;padding-bottom:0}
.num{flex:none;width:38px;font-family:"Baskerville",serif;font-size:30px;font-weight:400;font-variant-numeric:tabular-nums;margin-top:3px}
.ibody{flex:1;min-width:0}.title{font-family:"Songti SC",serif;font-size:36px;font-weight:600;line-height:1.5;letter-spacing:.3px;margin-bottom:14px;text-wrap:pretty;overflow-wrap:anywhere}
.summary{font-size:29px;line-height:1.8;color:#26372e;overflow-wrap:anywhere;text-wrap:pretty}
.why{margin-top:18px;font-size:24px;line-height:1.65;overflow-wrap:anywhere}
.why span{font-size:20px;font-weight:600;margin-right:14px}
.src{margin-top:16px;font-size:19px;line-height:1.6;color:#5d665d;overflow-wrap:anywhere}
.dot{display:none}
.hbody{flex:1}.hitem{display:flex;gap:22px;align-items:flex-start;margin:18px 0}
.hyear{flex:none;width:65px;font-family:"Baskerville",serif;font-size:27px;font-variant-numeric:tabular-nums}
.htext{font-size:29px;line-height:1.8;color:#26372e}
.foot{margin:38px 0 6px;border-top:2px solid #16251b;padding-top:20px;font-size:18px;color:#5d665d;line-height:1.9;overflow-wrap:anywhere}
.waiting{margin:24px 0;padding:18px 22px;background:#e8ecdf;border-left:3px solid #46624b;font-size:20px;line-height:1.65}.waiting>b{display:block;font-size:17px;letter-spacing:2px;color:#46624b;margin-bottom:8px}.waiting>div+div{margin-top:10px}.waiting strong{font-weight:600}.waiting small{display:block;font-size:15px;color:#687367}.slim{display:flex;justify-content:space-between;align-items:baseline;gap:20px;color:#5d665d;font-size:18px;border-top:5px solid #16251b;border-bottom:1px solid #16251b;padding:22px 0}
.slim b{font-family:"Baskerville","Songti SC",serif;color:#16251b;font-size:30px;font-weight:500;white-space:nowrap}
'''


def page(d, inner, slim=False):
    n_items = len(d.get('items', []))
    mast = '' if slim else f'''<div class="mast"><div class="masttop"><div class="brand">Dawn 日报<small>DAWN DAILY</small></div><div class="issue">第 {d.get('issue', 1)} 期</div></div>
      <div class="mastdate"><div class="bigdate">{esc(d['dateLabel'])}<span>{esc(d['weekday'])}</span></div><div class="count">{n_items} 条精选 · 每天 08:30</div></div></div>'''
    guide = '' if slim or not d.get('overview') else f'<div class="guide"><b>今日导读</b>{esc(d["overview"])}</div>'
    waits = d.get('waiting', [])[:3] if not slim else []
    waiting = '<div class="waiting"><b>今天惦记的事</b>' + ''.join(f'<div><strong>{esc(it["who"])}</strong> · {esc(it["what"])}<small>复查 {esc(it["reviewOn"])} · Dawn 安排</small></div>' for it in waits) + '</div>' if waits else ''
    slimhead = f'<div class="slim"><b>Dawn 日报</b><span>{esc(d["dateLabel"])} {esc(d["weekday"])} · 第 {d.get("issue", 1)} 期 · 续</span></div>' if slim else ''
    return f'<!doctype html><html><head><meta charset="utf-8"><style>{CSS}</style></head><body><div class="main">{mast}{slimhead}{waiting}{guide}{inner}</div></body></html>'

def shoot(d, html_text, out):
    f = os.path.join(d, 'p.html')
    open(f, 'w', encoding='utf-8').write(html_text)
    raw = os.path.join(d, 'raw.png')
    subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
                    f'--user-data-dir={os.path.join(d, "profile")}', '--no-first-run', '--no-default-browser-check',
                    f'--window-size={W},{H}', f'--screenshot={raw}', 'file://' + f], check=True, capture_output=True, timeout=90)
    im = Image.open(raw).convert('RGB')
    bg = Image.new('RGB', im.size, PAPER)
    box = ImageChops.difference(im, bg).getbbox()
    if not box:
        raise RuntimeError('渲染出空白页')
    if box[3] >= im.size[1] - 80:
        raise RuntimeError('日报超过渲染画布高度，未输出截断图片')
    bottom = min(im.size[1], box[3] + 48)
    im.crop((0, 0, im.size[0], bottom)).save(out)

def main():
    data = json.load(open(sys.argv[1], encoding='utf-8'))
    outdir = sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    items = data.get('items', [])
    by = {k: [it for it in items if it.get('section') == k] for k in ('ai', 'world', 'tech')}
    src_names = sorted({s.get('name', '') for it in items for s in it.get('sources', [])})
    now = datetime.now(BJ).strftime('%H:%M')
    foot1 = '<div class="foot">下页：政经 / 科技与开源' + (' / 历史上的今天' if data.get('onthisday', []) else '') + '</div>'
    foot2 = f'<div class="foot">信源：{esc("、".join(src_names))}<br>由 Dawn 编辑整理，仅供个人参考 · 链接版回复「日报链接」 · 今天 {now} 生成 · 第 {data.get("issue", 1)} 期</div>'
    with tempfile.TemporaryDirectory() as tmp:
        shoot(tmp, page(data, section_html('ai', by['ai']) + foot1), os.path.join(outdir, 'page1.png'))
        n = len(by['ai'])
        inner = section_html('world', by['world'], n + 1) + section_html('tech', by['tech'], n + len(by['world']) + 1) + history_html(data.get('onthisday', [])) + foot2
        shoot(tmp, page(data, inner, slim=True), os.path.join(outdir, 'page2.png'))
    print('rendered page1.png page2.png')

if __name__ == '__main__':
    main()
