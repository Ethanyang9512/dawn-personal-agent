// 微信 ClawBot（iLink Bot API）客户端。协议依据腾讯官方插件 Tencent/openclaw-weixin 的 docs/protocol.md 与源码。
// 注意：Node 自带 fetch 默认不读 HTTP(S)_PROXY，所以这里天然直连；微信连接与模型代理分别配置。
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

export const FIXED_BASE = 'https://ilinkai.weixin.qq.com';
export const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
const CHANNEL_VERSION = '2.4.10';
const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 10);
const BOT_AGENT = 'DawnPersonalAgent/0.1';

export const STALE_TOKEN = -14;

function uin() {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf-8').toString('base64');
}

// message_id 等是 uint64，超出 JS 安全整数，解析前改成字符串
const BIG_ID_KEYS = /"(message_id|msg_id|svr_id|seq)"\s*:\s*(-?\d+)/g;
export function parseJson(text) {
  if (!text) return {};
  return JSON.parse(text.replace(BIG_ID_KEYS, '"$1":"$2"'));
}

function joinUrl(base, path) {
  return (base.endsWith('/') ? base : base + '/') + path.replace(/^\//, '');
}

export class ILink {
  // fixedBase、cdnBase 只在本机模拟测试时改，正式运行用默认值
  constructor({ token, baseUrl, fixedBase, cdnBase }) {
    this.token = (token || '').trim();
    this.fixedBase = fixedBase || FIXED_BASE;
    this.baseUrl = baseUrl || this.fixedBase;
    this.cdnBase = cdnBase || CDN_BASE;
  }

  headers(withAuth = true) {
    const h = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': uin(),
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': CLIENT_VERSION,
    };
    if (withAuth && this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async post(path, body, timeoutMs, { base, withAuth = true, withBaseInfo = true } = {}) {
    const payload = withBaseInfo ? { ...body, base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT } } : body;
    const res = await fetch(joinUrl(base || this.baseUrl, path), {
      method: 'POST',
      headers: this.headers(withAuth),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${path}`);
      err.httpStatus = res.status;
      throw err;
    }
    return parseJson(text);
  }

  // ---------- 登录 ----------
  async getQrcode(localTokens = []) {
    return this.post('ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: localTokens.slice(0, 10) }, 30000, {
      base: this.fixedBase, withAuth: false, withBaseInfo: false,
    });
  }

  async qrcodeStatus(base, qrcode, verifyCode) {
    let url = joinUrl(base, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`);
    if (verifyCode) url += `&verify_code=${encodeURIComponent(verifyCode)}`;
    try {
      const res = await fetch(url, {
        headers: { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': CLIENT_VERSION },
        signal: AbortSignal.timeout(35000),
      });
      if (!res.ok) return { status: 'wait' };
      return parseJson(await res.text());
    } catch {
      return { status: 'wait' };
    }
  }

  // ---------- 收消息 ----------
  async getUpdates(buf, timeoutMs) {
    try {
      return await this.post('ilink/bot/getupdates', { get_updates_buf: buf || '' }, timeoutMs);
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') return { ret: 0, msgs: [], get_updates_buf: buf, timedOut: true };
      throw e;
    }
  }

  // ---------- 发消息 ----------
  // 返回 {ok, status, ret, errcode, errmsg, messageId}
  // status: delivered | suspect-dropped | rate-limited | prepare-failed | stale-token | network | failed
  // clientId 由调用方固定：同一条内容重试时不换，避免网络超时后重发变成两条
  async sendItem(toUserId, contextToken, item, runId, clientId) {
    const msg = {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId || newClientId(),
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [item],
    };
    if (runId) msg.run_id = runId;
    let r;
    try {
      r = await this.post('ilink/bot/sendmessage', { msg }, 15000);
    } catch (e) {
      // 断网、超时、5xx 都是"结果不确定"，保留重试；只有 4xx 算明确失败
      const st = e.httpStatus === 429 ? 'rate-limited' : e.httpStatus && e.httpStatus < 500 ? 'failed' : 'network';
      return { ok: false, status: st, errmsg: e.message };
    }
    const ret = r.ret ?? 0, errcode = r.errcode ?? 0, errmsg = r.errmsg || '';
    if (ret === STALE_TOKEN || errcode === STALE_TOKEN) return { ok: false, status: 'stale-token', ret, errcode, errmsg };
    if (ret === -2 || errcode === -2) {
      return { ok: false, status: /rate\s*limit/i.test(errmsg) ? 'rate-limited' : 'prepare-failed', ret, errcode, errmsg };
    }
    if (ret !== 0 || errcode !== 0) return { ok: false, status: 'failed', ret, errcode, errmsg };
    if (!r.message_id) return { ok: false, status: 'suspect-dropped', ret, errcode, errmsg };
    return { ok: true, status: 'delivered', messageId: String(r.message_id) };
  }

  sendText(toUserId, contextToken, text, runId, clientId) {
    return this.sendItem(toUserId, contextToken, { type: 1, text_item: { text } }, runId, clientId);
  }

  // ---------- 输入状态 ----------
  async getTypingTicket(userId, contextToken) {
    try {
      const r = await this.post('ilink/bot/getconfig', { ilink_user_id: userId, context_token: contextToken }, 10000);
      return r.ret === 0 ? r.typing_ticket || null : null;
    } catch { return null; }
  }

  async sendTyping(userId, ticket, status) {
    if (!ticket) return false;
    try {
      await this.post('ilink/bot/sendtyping', { ilink_user_id: userId, typing_ticket: ticket, status }, 10000);
      return true;
    } catch { return false; }
  }

  async notify(kind) {
    try { return await this.post(`ilink/bot/msg/notify${kind}`, {}, 10000); } catch (e) { return { error: e.message }; }
  }

  // ---------- 媒体 ----------
  static parseAesKey(b64) {
    const raw = Buffer.from(b64, 'base64');
    if (raw.length === 16) return raw;
    const s = raw.toString('ascii');
    if (/^[0-9a-fA-F]{32}$/.test(s)) return Buffer.from(s, 'hex');
    throw new Error(`bad aes key length ${raw.length}`);
  }

  async downloadMedia(media, hexKey) {
    const url = media.full_url || `${this.cdnBase}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`CDN HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    let key = null;
    if (hexKey && /^[0-9a-fA-F]{32}$/.test(hexKey)) key = Buffer.from(hexKey, 'hex');
    else if (media.aes_key) key = ILink.parseAesKey(media.aes_key);
    if (!key) return data;
    const d = createDecipheriv('aes-128-ecb', key, null);
    return Buffer.concat([d.update(data), d.final()]);
  }

  // mediaType: 1 图片 2 视频 3 文件
  async uploadMedia(toUserId, buf, mediaType) {
    const aes = randomBytes(16);
    const filekey = randomBytes(16).toString('hex');
    const c = createCipheriv('aes-128-ecb', aes, null);
    const enc = Buffer.concat([c.update(buf), c.final()]);
    const up = await this.post('ilink/bot/getuploadurl', {
      filekey, media_type: mediaType, to_user_id: toUserId,
      rawsize: buf.length, rawfilemd5: createHash('md5').update(buf).digest('hex'),
      filesize: enc.length, no_need_thumb: true, aeskey: aes.toString('hex'),
    }, 15000);
    const url = up.upload_full_url || (up.upload_param
      ? `${this.cdnBase}/upload?encrypted_query_param=${encodeURIComponent(up.upload_param)}&filekey=${filekey}`
      : null);
    if (!url) throw new Error('getuploadurl 没给上传地址');
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: enc, signal: AbortSignal.timeout(120000) });
        const param = res.headers.get('x-encrypted-param');
        if (res.status >= 400 && res.status < 500) throw Object.assign(new Error(`CDN 上传 HTTP ${res.status}`), { fatal: true });
        if (res.ok && param) {
          return { encrypt_query_param: param, aes_key: Buffer.from(aes.toString('hex'), 'ascii').toString('base64'), encrypt_type: 1, cipherSize: enc.length, rawSize: buf.length };
        }
        lastErr = new Error(`CDN 上传 HTTP ${res.status}，没有 x-encrypted-param`);
      } catch (e) {
        lastErr = e;
        if (e.fatal) break;
      }
    }
    throw lastErr;
  }
}

export function newRunId() { return randomUUID(); }
export function newClientId() { return `dawn:${Date.now()}-${randomBytes(4).toString('hex')}`; }
