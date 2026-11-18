import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const PRIVATE_ERROR_CODES = new Set(['PRIVATE_ORIGIN', 'PRIVATE_ADDRESS']);
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul']);
const ENTITY = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ensp: ' ', emsp: ' ', thinsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

function safeOrigin(value) {
  if (!value) return null;
  try {
    const origin = value instanceof URL ? value.origin : new URL(String(value)).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

export class SourceError extends Error {
  constructor(code, origin = null, extra = {}) {
    const cleanOrigin = safeOrigin(origin);
    super(cleanOrigin ? `${code} ${cleanOrigin}` : code);
    this.name = 'SourceError';
    this.code = code;
    this.origin = cleanOrigin;
    if (typeof extra.retryable === 'boolean') this.retryable = extra.retryable;
    if (Number.isInteger(extra.status)) this.status = extra.status;
    if (Number.isInteger(extra.retryAfterMs)) this.retryAfterMs = extra.retryAfterMs;
    if (typeof extra.hint === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(extra.hint)) this.hint = extra.hint;
  }

  toJSON() { return serializeSourceError(this); }
}

export function serializeSourceError(error) {
  const rawCode = typeof error?.code === 'string' ? error.code : 'SOURCE_ERROR';
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode) ? rawCode : 'SOURCE_ERROR';
  const result = { code, origin: safeOrigin(error?.origin) };
  if (typeof error?.retryable === 'boolean') result.retryable = error.retryable;
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) result.status = error.status;
  if (Number.isInteger(error?.retryAfterMs) && error.retryAfterMs >= 0) result.retryAfterMs = error.retryAfterMs;
  if (typeof error?.hint === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error.hint)) result.hint = error.hint;
  return result;
}

function decodeEntities(value) {
  return String(value).replace(/&(?:#([0-9]+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, decimal, hex, named) => {
    if (decimal || hex) {
      const codePoint = Number.parseInt(decimal || hex, decimal ? 10 : 16);
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return whole;
      try { return String.fromCodePoint(codePoint); } catch { return whole; }
    }
    return Object.hasOwn(ENTITY, named?.toLowerCase()) ? ENTITY[named.toLowerCase()] : whole;
  });
}

function normalizePlain(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeObservationText(value) {
  return normalizePlain(decodeEntities(String(value ?? '')));
}

function htmlToText(value) {
  const decoded = decodeEntities(String(value ?? ''))
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  return normalizePlain(decoded);
}

function getPath(value, path) {
  if (path == null || path === '') return value;
  if (Array.isArray(path)) return path.reduce((current, key) => current?.[key], value);
  const text = String(path);
  const parts = text.startsWith('/')
    ? text.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    : text.replace(/\[([0-9]+)\]/g, '.$1').split('.').filter(Boolean);
  return parts.reduce((current, key) => current == null ? undefined : current[key], value);
}

export function evaluateMatcher(matcher, observation) {
  if (!matcher || typeof matcher !== 'object' || Array.isArray(matcher) || !observation) return false;
  if (Object.hasOwn(matcher, 'contains')) {
    if (typeof matcher.contains !== 'string' || !matcher.contains) return false;
    const needle = normalizeObservationText(matcher.contains);
    return !!needle && normalizeObservationText(observation.text).includes(needle);
  }
  if (Object.hasOwn(matcher, 'all')) {
    return Array.isArray(matcher.all) && matcher.all.length > 0 && matcher.all.every((item) => evaluateMatcher(item, observation));
  }
  if (Object.hasOwn(matcher, 'none')) {
    return Array.isArray(matcher.none) && matcher.none.length > 0 && matcher.none.every((item) => !evaluateMatcher(item, observation));
  }
  const operators = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'].filter((key) => Object.hasOwn(matcher, key));
  if (!operators.length) return false;
  const actual = getPath(observation, matcher.path || 'text');
  if (typeof actual !== 'number' || !Number.isFinite(actual)) return false;
  return operators.every((operator) => {
    const expected = matcher[operator];
    if (typeof expected !== 'number' || !Number.isFinite(expected)) return false;
    if (operator === 'eq') return actual === expected;
    if (operator === 'ne') return actual !== expected;
    if (operator === 'gt') return actual > expected;
    if (operator === 'gte') return actual >= expected;
    if (operator === 'lt') return actual < expected;
    return actual <= expected;
  });
}

function normalizeOrigins(value) {
  if (value == null) return [];
  const list = value instanceof Set ? [...value] : Array.isArray(value) ? value : [value];
  return list.map((entry) => {
    const origin = safeOrigin(entry);
    if (!origin) throw new SourceError('INVALID_ALLOWLIST');
    return origin;
  });
}

function createContext(source, options) {
  if ((source.allowedOrigins !== undefined && !Array.isArray(source.allowedOrigins))
    || (source.allowOrigins !== undefined && !Array.isArray(source.allowOrigins))) {
    throw new SourceError('INVALID_ALLOWLIST', source.url);
  }
  const hasAllowedOrigins = Array.isArray(source.allowedOrigins) || Array.isArray(source.allowOrigins);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(maxBytes) || maxBytes <= 0) throw new SourceError('INVALID_OPTIONS', source.url);
  return {
    dnsLookup: options.dnsLookup || dns.lookup,
    privateOrigins: new Set(normalizeOrigins(options.allowPrivateOrigins)),
    allowedOrigins: hasAllowedOrigins ? new Set(normalizeOrigins(source.allowedOrigins || source.allowOrigins)) : null,
    timeoutMs: Math.floor(timeoutMs),
    deadline: Date.now() + Math.floor(timeoutMs),
    signal: options.signal,
    maxBytes: Math.floor(maxBytes),
    maxRedirects: Number.isInteger(options.maxRedirects) ? Math.max(0, options.maxRedirects) : 5,
  };
}

function throwIfAborted(context, origin) {
  if (context.signal?.aborted) throw new SourceError('ABORTED', origin);
}

function stripBrackets(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function ipv4Number(address) {
  return address.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function inIpv4Range(number, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (number & mask) === (ipv4Number(base) & mask);
}

function isPublicIpv4(address) {
  const number = ipv4Number(address);
  const denied = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ];
  return !denied.some(([base, bits]) => inIpv4Range(number, base, bits));
}

function ipv6Words(address) {
  if (address.includes('%')) return null;
  const [head, tail] = address.toLowerCase().split('::');
  if (address.split('::').length > 2) return null;
  const parsePart = (part) => {
    if (!part) return [];
    const pieces = part.split(':');
    const last = pieces.at(-1);
    if (net.isIPv4(last)) {
      const number = ipv4Number(last);
      pieces.splice(-1, 1, ((number >>> 16) & 0xffff).toString(16), (number & 0xffff).toString(16));
    }
    return pieces.map((piece) => Number.parseInt(piece || '0', 16));
  };
  const left = parsePart(head);
  const right = parsePart(tail);
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (!address.includes('::') && missing !== 0)) return null;
  const words = [...left, ...Array(missing).fill(0), ...right];
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : null;
}

function isPublicAddress(address) {
  if (net.isIPv4(address)) return isPublicIpv4(address);
  if (!net.isIPv6(address)) return false;
  const words = ipv6Words(address);
  if (!words || (words[0] & 0xe000) !== 0x2000) return false; // 同时拒绝 mapped、loopback、ULA、link-local、multicast 等
  if (words[0] === 0x2001 && (words[1] & 0xfe00) === 0) return false; // 2001::/23 特殊用途
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false; // 文档地址
  if (words[0] === 0x2002) return false; // 6to4 嵌入地址不做首版确认源
  if (words[0] === 0x3fff && (words[1] & 0xfff0) === 0) return false; // 3fff::/20 文档地址
  return true;
}

function validateUrl(value, context) {
  let url;
  try { url = value instanceof URL ? new URL(value.href) : new URL(String(value)); } catch { throw new SourceError('INVALID_URL'); }
  const origin = safeOrigin(url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SourceError('UNSUPPORTED_PROTOCOL', origin);
  if (url.username || url.password) throw new SourceError('CREDENTIALS_NOT_ALLOWED', origin);
  if (context.allowedOrigins && !context.allowedOrigins.has(url.origin)) throw new SourceError('ORIGIN_NOT_ALLOWED', origin);
  const allowPrivate = context.privateOrigins.has(url.origin);
  const hostname = stripBrackets(url.hostname);
  if (!allowPrivate && (hostname === 'localhost' || hostname.endsWith('.localhost'))) throw new SourceError('PRIVATE_ORIGIN', origin);
  if (net.isIP(hostname) && !allowPrivate && !isPublicAddress(hostname)) throw new SourceError('PRIVATE_ORIGIN', origin);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!allowPrivate && port !== (url.protocol === 'https:' ? 443 : 80)) throw new SourceError('INVALID_PORT', origin);
  return { url, origin, allowPrivate, hostname, port };
}

function resolveValidated(validated, context) {
  const { hostname, allowPrivate, origin } = validated;
  const validateRecords = (records) => {
    const normalized = (Array.isArray(records) ? records : [records]).map((record) => {
      const address = typeof record === 'string' ? record : record?.address;
      const family = Number(typeof record === 'object' ? record?.family : 0) || net.isIP(address);
      return { address, family };
    });
    if (!normalized.length || normalized.some((record) => !net.isIP(record.address) || record.family !== net.isIP(record.address))) throw new SourceError('DNS_FAILED', origin);
    if (!allowPrivate && normalized.some((record) => !isPublicAddress(record.address))) throw new SourceError('PRIVATE_ADDRESS', origin);
    return normalized;
  };
  if (net.isIP(hostname)) return Promise.resolve(validateRecords([{ address: hostname, family: net.isIP(hostname) }]));
  return new Promise((resolve, reject) => {
    const callback = (error, records) => {
      if (error) return reject(new SourceError('DNS_FAILED', origin, { retryable: true }));
      try { resolve(validateRecords(records)); } catch (caught) { reject(caught); }
    };
    try { context.dnsLookup(hostname, { all: true, verbatim: true }, callback); } catch { reject(new SourceError('DNS_FAILED', origin, { retryable: true })); }
  });
}

function normalizeRemoteAddress(address) {
  if (typeof address !== 'string') return '';
  return address.startsWith('::ffff:') && net.isIPv4(address.slice(7)) ? address.slice(7) : address;
}

function retryAfterMs(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return undefined;
  const seconds = Number(value.trim());
  return Number.isSafeInteger(seconds) && seconds <= 86400 ? seconds * 1000 : undefined;
}

function statusError(status, origin, headers) {
  if (status === 429) return new SourceError('RATE_LIMITED', origin, { status, retryable: true, retryAfterMs: retryAfterMs(headers['retry-after']) });
  if (status === 403) return new SourceError('HTTP_FORBIDDEN', origin, { status });
  if (status === 404) return new SourceError('HTTP_NOT_FOUND', origin, { status });
  if (status >= 500) return new SourceError('UPSTREAM_UNAVAILABLE', origin, { status, retryable: true });
  return new SourceError('HTTP_STATUS', origin, { status });
}

function decodeBody(chunks, size, contentType, origin) {
  const charset = /;\s*charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType || '')?.[1] || 'utf-8';
  try {
    return new TextDecoder(charset).decode(Buffer.concat(chunks, size));
  } catch {
    throw new SourceError('UNSUPPORTED_CHARSET', origin);
  }
}

function requestOnce(value, context, remainingMs) {
  return new Promise((resolve, reject) => {
    const validated = validateUrl(value, context);
    const { url, origin, hostname, port } = validated;
    let request = null;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let socketMismatch = false;
    let compressed = false;
    const timer = setTimeout(() => {
      timedOut = true;
      request?.destroy();
      finishReject('TIMEOUT', { retryable: true });
    }, Math.max(1, remainingMs));
    const finishResolve = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const finishReject = (error, extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
      reject(error instanceof SourceError ? error : new SourceError(error, origin, extra));
    };
    const onAbort = () => {
      aborted = true;
      request?.destroy();
      finishReject('ABORTED');
    };
    if (context.signal) {
      if (context.signal.aborted) return finishReject('ABORTED');
      context.signal.addEventListener('abort', onAbort, { once: true });
    }
    const failResponse = (error) => {
      request?.destroy();
      finishReject(error);
    };

    resolveValidated(validated, context).then((records) => {
      if (settled) return;
      const allowedRemote = new Set(records.map((record) => normalizeRemoteAddress(record.address)));
      const lookup = (_host, options, callback) => queueMicrotask(() => {
        if (options.all) callback(null, records);
        else callback(null, records[0].address, records[0].family);
      });
      const transport = url.protocol === 'https:' ? https : http;
      const headers = {
        Host: url.host,
        Accept: 'application/rss+xml, application/atom+xml, application/json, text/html, application/xhtml+xml, */*;q=0.1',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': 'DawnAutomation/1.0',
      };
      const requestOptions = {
        protocol: url.protocol, hostname, port, path: `${url.pathname}${url.search}`, method: 'GET',
        headers, lookup, agent: false,
      };
      if (url.protocol === 'https:' && !net.isIP(hostname)) requestOptions.servername = hostname;
      try {
        request = transport.request(requestOptions);
      } catch {
        return finishReject('NETWORK_ERROR', { retryable: true });
      }
      request.once('socket', (socket) => {
        const verifyRemote = () => {
          if (settled || socketMismatch) return;
          const remote = normalizeRemoteAddress(socket.remoteAddress);
          if (!remote || !allowedRemote.has(remote)) {
            socketMismatch = true;
            socket.destroy();
            finishReject('SOCKET_ADDRESS_MISMATCH');
          }
        };
        socket.once('connect', verifyRemote);
        if (url.protocol === 'https:') socket.once('secureConnect', verifyRemote);
      });
      request.once('error', () => finishReject(aborted ? 'ABORTED' : timedOut ? 'TIMEOUT' : socketMismatch ? 'SOCKET_ADDRESS_MISMATCH' : 'NETWORK_ERROR', { retryable: !aborted }));
      request.once('response', (response) => {
        const status = response.statusCode || 0;
        if (REDIRECT_STATUS.has(status)) {
          const location = response.headers.location || null;
          response.destroy();
          return finishResolve({ redirect: location });
        }
        if (status !== 200) {
          response.destroy();
          return finishReject(statusError(status, origin, response.headers));
        }
        const encoding = String(response.headers['content-encoding'] || 'identity').trim().toLowerCase();
        let stream = response;
        compressed = encoding !== 'identity' && encoding !== '';
        if (encoding === 'gzip' || encoding === 'x-gzip') stream = createGunzip();
        else if (encoding === 'deflate') stream = createInflate();
        else if (encoding === 'br') stream = createBrotliDecompress();
        else if (compressed) {
          response.destroy();
          return finishReject('UNSUPPORTED_CONTENT_ENCODING');
        }
        const chunks = [];
        let size = 0;
        stream.on('data', (chunk) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > context.maxBytes) {
            stream.destroy();
            response.destroy();
            return finishReject('RESPONSE_TOO_LARGE');
          }
          chunks.push(buffer);
        });
        stream.once('end', () => {
          if (settled) return;
          try {
            finishResolve({ body: decodeBody(chunks, size, response.headers['content-type'], origin) });
          } catch (error) { finishReject(error); }
        });
        stream.once('error', () => failResponse(compressed ? 'DECOMPRESSION_FAILED' : 'NETWORK_ERROR'));
        response.once('aborted', () => failResponse('NETWORK_ERROR'));
        if (stream !== response) response.pipe(stream);
      });
      request.end();
    }).catch((error) => finishReject(error));
  });
}

async function fetchText(url, context) {
  const deadline = context.deadline;
  let current = String(url);
  for (let redirectCount = 0; ; redirectCount += 1) {
    throwIfAborted(context, current);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SourceError('TIMEOUT', current, { retryable: true });
    const response = await requestOnce(current, context, remaining);
    throwIfAborted(context, current);
    if (!Object.hasOwn(response, 'redirect')) return { ...response, url: current };
    if (redirectCount >= context.maxRedirects) throw new SourceError('TOO_MANY_REDIRECTS', current);
    if (!response.redirect) throw new SourceError('INVALID_REDIRECT', current);
    try { current = new URL(response.redirect, current).href; } catch { throw new SourceError('INVALID_REDIRECT', current); }
  }
}

function parseAttributes(value) {
  const attrs = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of value.matchAll(pattern)) attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  return attrs;
}

function parseMarkup(input, { xml = false } = {}) {
  const source = xml ? String(input) : String(input).replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const root = { tag: null, attrs: {}, children: [], parent: null };
  const stack = [root];
  const tokens = source.match(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<\/?[A-Za-z][^>]*>|[^<]+|</g) || [];
  for (const token of tokens) {
    const parent = stack.at(-1);
    if (token.startsWith('<![CDATA[')) {
      parent.children.push({ text: token.slice(9, -3), parent });
      continue;
    }
    if (!token.startsWith('<') || token === '<') {
      parent.children.push({ text: token, parent });
      continue;
    }
    if (token.startsWith('<!--') || token.startsWith('<?') || /^<![^[]/.test(token)) continue;
    const closing = token.match(/^<\/([A-Za-z][^\s>]*)/);
    if (closing) {
      const tag = xml ? closing[1] : closing[1].toLowerCase();
      const index = stack.map((node) => node.tag).lastIndexOf(tag);
      if (index > 0) stack.length = index;
      continue;
    }
    const opening = token.match(/^<([A-Za-z][^\s/>]*)/);
    if (!opening) {
      parent.children.push({ text: token, parent });
      continue;
    }
    const tag = xml ? opening[1] : opening[1].toLowerCase();
    const attrs = parseAttributes(token.slice(opening[0].length, -1).replace(/\/\s*$/, ''));
    const node = { tag, attrs, children: [], parent };
    parent.children.push(node);
    const selfClosing = /\/\s*>$/.test(token) || (!xml && VOID_TAGS.has(tag));
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function localName(tag) {
  const lower = String(tag || '').toLowerCase();
  return lower.includes(':') ? lower.slice(lower.lastIndexOf(':') + 1) : lower;
}

function descendants(root) {
  const result = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (child.tag) result.push(child);
      walk(child);
    }
  };
  walk(root);
  return result;
}

function rawText(node, output = []) {
  if (Object.hasOwn(node, 'text')) {
    output.push(node.text);
    return output;
  }
  for (const child of node.children || []) rawText(child, output);
  if (BLOCK_TAGS.has(localName(node.tag))) output.push(' ');
  return output;
}

function textOf(node) { return htmlToText(rawText(node).join('')); }

function matchesSimple(node, selector) {
  const match = selector.match(/^([a-zA-Z][\w-]*|\*)?((?:[.#][\w-]+)*)$/);
  if (!match) return false;
  if (match[1] && match[1] !== '*' && localName(node.tag) !== match[1].toLowerCase()) return false;
  const classes = String(node.attrs.class || '').split(/\s+/).filter(Boolean);
  for (const part of selector.matchAll(/([.#])([\w-]+)/g)) {
    if (part[1] === '.' && !classes.includes(part[2])) return false;
    if (part[1] === '#' && node.attrs.id !== part[2]) return false;
  }
  return true;
}

function queryAll(root, selector) {
  const parts = String(selector || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  return descendants(root).filter((node) => {
    if (!matchesSimple(node, parts.at(-1))) return false;
    let ancestor = node.parent;
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      while (ancestor && ancestor.tag && !matchesSimple(ancestor, parts[index])) ancestor = ancestor.parent;
      if (!ancestor?.tag) return false;
      ancestor = ancestor.parent;
    }
    return true;
  });
}

function queryWithin(node, selector) {
  const inside = queryAll(node, selector);
  return matchesSimple(node, String(selector || '').trim()) ? [node, ...inside] : inside;
}

function canonicalItemUrl(value, base, context, allowExternal = false) {
  try {
    const url = new URL(String(value), base);
    url.hash = '';
    const external = allowExternal && (context.allowedOrigins
      ? !context.allowedOrigins.has(url.origin)
      : url.origin !== safeOrigin(base));
    validateUrl(url, external ? { ...context, allowedOrigins: null } : context);
    return url.href;
  } catch (error) {
    if (error instanceof SourceError && (PRIVATE_ERROR_CODES.has(error.code) || ['INVALID_URL', 'INVALID_PORT', 'UNSUPPORTED_PROTOCOL', 'CREDENTIALS_NOT_ALLOWED', 'ORIGIN_NOT_ALLOWED'].includes(error.code))) return null;
    return null;
  }
}

function observation(sourceId, itemId, canonicalUrl, text, links = [], fields) {
  const normalized = normalizePlain(text);
  if (!sourceId || itemId == null || !canonicalUrl || !normalized) return null;
  const uniqueLinks = [...new Set(links.filter((link) => link && link !== canonicalUrl))];
  const fieldEntries = fields && typeof fields === 'object' ? Object.entries(fields)
    .filter(([key, value]) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)
      && (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0) : [];
  const safeFields = Object.fromEntries(fieldEntries);
  const versionMaterial = normalized + (fieldEntries.length ? `\nfields:${JSON.stringify(safeFields)}` : '');
  return {
    sourceId,
    itemId: String(itemId),
    canonicalUrl,
    text: normalized,
    versionHash: createHash('sha256').update(versionMaterial, 'utf8').digest('hex'),
    ...(uniqueLinks.length ? { links: uniqueLinks } : {}),
    ...(fieldEntries.length ? { fields: safeFields } : {}),
  };
}

function dedupe(rows) {
  const result = new Map();
  for (const row of rows) if (row && !result.has(row.itemId)) result.set(row.itemId, row);
  return [...result.values()];
}

function linksWithin(node, base, context) {
  return queryWithin(node, 'a').map((anchor) => anchor.attrs.href ? canonicalItemUrl(anchor.attrs.href, base, context) : null).filter(Boolean);
}

function parseJsonObservations(body, responseUrl, source, context) {
  let data;
  try { data = JSON.parse(body); } catch { throw new SourceError('INVALID_JSON', responseUrl); }
  const fields = source.fields || source.mapping || {};
  const itemsPath = source.itemsPath ?? source.itemPath ?? fields.items;
  const items = itemsPath != null ? getPath(data, itemsPath) : Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(items)) throw new SourceError('INVALID_JSON_SHAPE', responseUrl);
  const idPath = fields.id ?? source.itemIdPath;
  const textPath = fields.text ?? source.textPath;
  const urlPath = fields.url ?? source.itemUrlPath;
  const declaredFields = new Map();
  for (const [key, path] of Object.entries(fields)) {
    if (!['items', 'id', 'text', 'url'].includes(key)) declaredFields.set(key, path);
  }
  if (Array.isArray(source.numericFields)) {
    for (const key of source.numericFields) {
      if (typeof key === 'string') declaredFields.set(key, declaredFields.get(key) ?? key);
    }
  } else if (source.numericFields && typeof source.numericFields === 'object') {
    for (const [key, path] of Object.entries(source.numericFields)) declaredFields.set(key, path);
  }
  const textValue = (item) => {
    if (textPath != null) {
      const paths = Array.isArray(textPath) ? textPath : [textPath];
      return paths.map((path) => getPath(item, path));
    }
    return [item?.title, item?.text ?? item?.content ?? item?.body];
  };
  const flattenText = (value) => {
    if (value == null) return [];
    if (Array.isArray(value)) return value.flatMap(flattenText);
    return ['string', 'number', 'boolean'].includes(typeof value) ? [String(value)] : [];
  };
  const rows = items.map((item) => {
    const rawUrl = urlPath != null ? getPath(item, urlPath) : item?.url ?? item?.link;
    const canonicalUrl = rawUrl ? canonicalItemUrl(rawUrl, responseUrl, context) : canonicalItemUrl(responseUrl, responseUrl, context);
    if (!canonicalUrl) return null;
    const rawId = idPath != null ? getPath(item, idPath) : item?.id ?? item?.key;
    const text = flattenText(textValue(item)).map(htmlToText).filter(Boolean).join(' ');
    const values = Object.create(null);
    for (const [key, path] of declaredFields) values[key] = getPath(item, path);
    return observation(source.sourceId, rawId ?? canonicalUrl, canonicalUrl, text, [], values);
  });
  if (items.length && !rows.some(Boolean)) throw new SourceError('EXTRACTION_FAILED', responseUrl);
  return dedupe(rows);
}

function childNamed(node, names) {
  return (node.children || []).find((child) => child.tag && names.some((name) => child.tag.toLowerCase() === name || localName(child.tag) === name));
}

function parseFeedObservations(body, responseUrl, source, context) {
  const root = parseMarkup(body, { xml: true });
  const all = descendants(root);
  if (!all.some((node) => ['rss', 'feed', 'rdf'].includes(localName(node.tag)))) throw new SourceError('INVALID_FEED', responseUrl);
  const entries = all.filter((node) => ['item', 'entry'].includes(localName(node.tag)));
  const rows = entries.map((entry) => {
    const titleNode = childNamed(entry, ['title']);
    const bodyNode = childNamed(entry, ['content:encoded', 'encoded', 'content', 'description', 'summary']);
    const idNode = childNamed(entry, ['guid', 'id']);
    const linkNodes = (entry.children || []).filter((node) => node.tag && localName(node.tag) === 'link');
    const alternate = linkNodes.find((node) => !node.attrs.rel || node.attrs.rel === 'alternate') || linkNodes[0];
    const rawLink = alternate?.attrs.href || (alternate ? rawText(alternate).join('') : '');
    const id = idNode ? normalizePlain(rawText(idNode).join('')) : null;
    const canonicalUrl = canonicalItemUrl(rawLink || (id && /^https?:\/\//i.test(id) ? id : responseUrl), responseUrl, context);
    if (!canonicalUrl) return null;
    const text = [titleNode, bodyNode].filter(Boolean).map(textOf).filter(Boolean).join(' ');
    return observation(source.sourceId, id || canonicalUrl, canonicalUrl, text);
  });
  if (entries.length && !rows.some(Boolean)) throw new SourceError('EXTRACTION_FAILED', responseUrl);
  return dedupe(rows);
}

function parseHtmlObservations(body, responseUrl, source, context, list) {
  const root = parseMarkup(body);
  const finalUrl = canonicalItemUrl(responseUrl, responseUrl, context);
  if (!finalUrl) throw new SourceError('INVALID_URL', responseUrl);
  if (list) {
    const itemSelector = source.itemSelector || source.selectors?.item;
    if (!itemSelector) throw new SourceError('INVALID_SOURCE', responseUrl);
    const nodes = queryAll(root, itemSelector);
    if (!nodes.length) throw new SourceError('EXTRACTION_FAILED', responseUrl);
    const rows = nodes.map((node) => {
      const linkNodes = source.linkSelector ? queryWithin(node, source.linkSelector) : queryWithin(node, 'a');
      const linkNode = linkNodes.find((candidate) => candidate.attrs.href);
      const allowExternal = source.allowExternalLinks === true;
      const canonicalUrl = linkNode ? canonicalItemUrl(linkNode.attrs.href, responseUrl, context, allowExternal) : null;
      if (!canonicalUrl) return null;
      const textNodes = source.textSelector ? queryWithin(node, source.textSelector) : [node];
      const text = textNodes.map(textOf).filter(Boolean).join(' ');
      const row = observation(source.sourceId, canonicalUrl, canonicalUrl, text, linksWithin(node, responseUrl, context));
      if (row && allowExternal && (context.allowedOrigins
        ? !context.allowedOrigins.has(safeOrigin(canonicalUrl))
        : safeOrigin(canonicalUrl) !== safeOrigin(responseUrl))) row.external = true;
      return row;
    });
    if (!rows.some(Boolean)) throw new SourceError('EXTRACTION_FAILED', responseUrl);
    return dedupe(rows);
  }
  const selector = source.selector || source.selectors?.document;
  const nodes = selector ? queryAll(root, selector) : [allBody(root) || root];
  if (!nodes.length) throw new SourceError('EXTRACTION_FAILED', responseUrl);
  const text = nodes.map(textOf).filter(Boolean).join(' ');
  const links = nodes.flatMap((node) => linksWithin(node, responseUrl, context));
  const row = observation(source.sourceId, finalUrl, finalUrl, text, links);
  if (!row) throw new SourceError('EXTRACTION_FAILED', responseUrl);
  return [row];
}

function allBody(root) {
  return descendants(root).find((node) => localName(node.tag) === 'body');
}

function assignedJson(html, marker) {
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const equal = html.indexOf('=', start + marker.length);
  if (equal < 0) return null;
  const first = html.slice(equal + 1).search(/[{[]/);
  if (first < 0) return null;
  const begin = equal + 1 + first;
  const open = html[begin];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = begin; index < html.length; index += 1) {
    const char = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(html.slice(begin, index + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function statusesIn(value) {
  const statuses = [];
  const stack = [value];
  let visited = 0;
  while (stack.length && visited < 20_000) {
    const current = stack.pop();
    visited += 1;
    if (!current || typeof current !== 'object') continue;
    const id = current.id ?? current.mid ?? current.bid;
    if (id != null && typeof current.text === 'string') {
      statuses.push(current);
      continue;
    }
    const values = Array.isArray(current) ? current : Object.values(current);
    for (let index = values.length - 1; index >= 0; index -= 1) stack.push(values[index]);
  }
  return statuses;
}

function parseWeibo(body, responseUrl, source, context) {
  let data = null;
  if (/^\s*[{[]/.test(body)) {
    try { data = JSON.parse(body); } catch { throw new SourceError('INVALID_JSON', responseUrl); }
  } else {
    data = assignedJson(body, '$render_data') || assignedJson(body, '__INITIAL_STATE__');
  }
  if (data?.ok === 0 || data?.data?.ok === 0) throw new SourceError('SOURCE_REJECTED', responseUrl);
  const statuses = data ? statusesIn(data) : [];
  if (statuses.length) {
    const rows = statuses.map((status) => {
      const id = String(status.id ?? status.mid ?? status.bid);
      const canonicalUrl = canonicalItemUrl(`/status/${encodeURIComponent(id)}`, responseUrl, context);
      if (!canonicalUrl) return null;
      const text = htmlToText(status.longTextContent || status.text);
      return observation(source.sourceId, id, canonicalUrl, text);
    });
    const isList = statuses.length > 1 || /\/u\/|\/api\/container\//.test(new URL(responseUrl).pathname);
    return { rows: dedupe(rows), isList };
  }
  if (!data) {
    const rows = parseHtmlObservations(body, responseUrl, { ...source, itemSelector: source.itemSelector || 'article' }, context, true);
    return { rows, isList: rows.length > 1 || /\/u\//.test(new URL(responseUrl).pathname) };
  }
  throw new SourceError('EXTRACTION_FAILED', responseUrl);
}

function adapterName(source) {
  return String(source.adapter || source.type || '').toLowerCase().replaceAll('-', '_');
}

const SUPPORTED_ADAPTERS = new Set([
  'json', 'rss', 'atom', 'feed', 'rss_atom', 'html', 'html_document', 'document',
  'html_list', 'htmllist', 'list', 'weibo', 'weibo_status', 'weibo_public',
]);

export async function fetchObservations(source, options = {}) {
  const origin = safeOrigin(source?.url);
  try {
    if (!source || typeof source !== 'object' || !source.url) throw new SourceError('INVALID_SOURCE', origin);
    const sourceId = source.sourceId || source.id;
    if (typeof sourceId !== 'string' || !sourceId) throw new SourceError('INVALID_SOURCE', origin);
    const adapter = adapterName(source);
    if (!SUPPORTED_ADAPTERS.has(adapter)) throw new SourceError('UNSUPPORTED_ADAPTER', origin);
    const htmlList = ['html_list', 'htmllist', 'list'].includes(adapter);
    const maxDetailItems = source.maxDetailItems ?? 10;
    if (htmlList && source.fetchDetails === true) {
      if (typeof source.detailSelector !== 'string' || !source.detailSelector.trim()) throw new SourceError('INVALID_SOURCE', origin);
      if (!Number.isInteger(maxDetailItems) || maxDetailItems < 1) throw new SourceError('INVALID_SOURCE', origin);
    }
    const normalizedSource = { ...source, sourceId };
    const context = createContext(normalizedSource, options);
    const response = await fetchText(source.url, context);
    if (adapter === 'json') return parseJsonObservations(response.body, response.url, normalizedSource, context);
    if (['rss', 'atom', 'feed', 'rss_atom'].includes(adapter)) return parseFeedObservations(response.body, response.url, normalizedSource, context);
    if (['html', 'html_document', 'document'].includes(adapter)) return parseHtmlObservations(response.body, response.url, normalizedSource, context, false);
    if (htmlList) {
      const rows = parseHtmlObservations(response.body, response.url, normalizedSource, context, true);
      if (source.fetchDetails !== true) return rows;
      const rawWords = source.candidateWords || source.candidateKeywords || [];
      const words = (Array.isArray(rawWords) ? rawWords : [rawWords]).filter((word) => typeof word === 'string' && word.trim()).map(normalizeObservationText);
      // 未配置候选词时全部条目都是候选，成本为列表 + N 篇详情；每轮默认最多 10 篇。
      const candidates = rows.filter((row) => !words.length || words.some((word) => row.text.includes(word)));
      if (candidates.length > maxDetailItems) throw new SourceError('SOURCE_LIMIT', response.url, { hint: 'narrow_candidates' });
      const candidateSet = new Set(candidates);
      const detailedRows = [];
      for (const row of rows) {
        if (!candidateSet.has(row) || row.external) {
          detailedRows.push(row);
          continue;
        }
        try {
          const detailContext = { ...context, deadline: Date.now() + context.timeoutMs };
          const detailResponse = await fetchText(row.canonicalUrl, detailContext);
          const detail = parseHtmlObservations(
            detailResponse.body,
            detailResponse.url,
            { ...normalizedSource, selector: source.detailSelector },
            detailContext,
            false,
          );
          detailedRows.push(observation(sourceId, row.itemId, row.canonicalUrl, `${row.text} ${detail[0].text}`, row.links));
        } catch (error) {
          if (['ABORTED', 'PRIVATE_ORIGIN', 'PRIVATE_ADDRESS', 'ORIGIN_NOT_ALLOWED', 'SOCKET_ADDRESS_MISMATCH', 'INVALID_URL', 'CREDENTIALS_NOT_ALLOWED', 'UNSUPPORTED_PROTOCOL'].includes(error?.code)) throw error;
          detailedRows.push({ ...row, detailError: serializeSourceError(error) });
        }
      }
      return dedupe(detailedRows);
    }
    if (['weibo', 'weibo_status', 'weibo_public'].includes(adapter)) {
      const parsed = parseWeibo(response.body, response.url, normalizedSource, context);
      if (!parsed.isList) return parsed.rows;
      const rawWords = source.candidateWords || source.candidateKeywords || source.candidates || [];
      const words = (Array.isArray(rawWords) ? rawWords : [rawWords]).filter((word) => typeof word === 'string' && word.trim()).map(normalizeObservationText);
      const rows = [];
      for (const row of parsed.rows) {
        if (!words.some((word) => row.text.includes(word))) {
          rows.push(row);
          continue;
        }
        const detailResponse = await fetchText(row.canonicalUrl, context);
        const detail = parseWeibo(detailResponse.body, detailResponse.url, normalizedSource, context);
        const match = detail.rows.find((candidate) => candidate.itemId === row.itemId);
        if (!match) throw new SourceError('ITEM_ID_MISMATCH', row.canonicalUrl);
        rows.push({ ...match, canonicalUrl: row.canonicalUrl });
      }
      return dedupe(rows);
    }
    throw new SourceError('UNSUPPORTED_ADAPTER', origin);
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError('EXTRACTION_FAILED', origin);
  }
}
