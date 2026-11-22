/**
 * bilibili-comments.js — 只读 B 站评论区适配器。
 *
 * 能力：
 * - 主评论：`/x/v2/reply/wbi/main`（WBI 签名，offset 游标分页，**匿名可用**）。
 * - 楼中楼：`/x/v2/reply/reply`（按 root rpid 分页，匿名可用）。
 * - 降级：WBI 不可用时退回 `/x/v2/reply`（匿名只返回 3 条热评，必须显式标注）。
 *
 * 边界（硬约束）：
 * - 只读：不发评论、不点赞、不投币、不关注。
 * - 不伪造登录态：`cookies` 只接受调用方显式传入（或 `BILIBILI_SESSDATA` / `BILIBILI_COOKIE`），
 *   不生成假 SESSDATA；cookie 不进入返回值、日志、错误信息。
 * - 命中 `-352` / HTTP 412 视为风控：立即停手，不换 IP、不重试刷页。
 * - 网络只允许 `https://api.bilibili.com`，不跟随重定向。
 *
 * 返回：`total / rootsFetched / subsFetched / incomplete` 四个字段是稳定契约，
 * 供上层判断"抓到多少 / 还差多少"，不要用 `is_end` 推断完整性。
 *
 * 注意 WBI 签名：`wts` 只能出现一次（在待签 query 里），`w_rid` 追加在其后。
 * 早期实现把 `wts` 同时写进 query 和尾部，服务端会返回 `-403 访问权限不足`
 * （看起来像"未登录"，实际是签名错误）。
 */

import { createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';

const API_ORIGIN = 'https://api.bilibili.com';
const API_HOST = 'api.bilibili.com';
const NAV_URL = `${API_ORIGIN}/x/web-interface/nav`;
const VIEW_URL = `${API_ORIGIN}/x/web-interface/view`;
const WBI_VIEW_URL = `${API_ORIGIN}/x/web-interface/wbi/view`;
const MAIN_URL = `${API_ORIGIN}/x/v2/reply/wbi/main`;
const REPLY_URL = `${API_ORIGIN}/x/v2/reply`;
const SUB_URL = `${API_ORIGIN}/x/v2/reply/reply`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

/** WBI mixin 索引表（64 项，B 站前端固定常量）。 */
const MIXIN_TAB = Object.freeze([
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]);

const WBI_TTL_MS = 10 * 60_000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 100;

/** 已知业务码 → 统一状态。 */
const CODE_STATUS = Object.freeze({
  '-101': 'LOGIN_REQUIRED',
  '-403': 'LOGIN_REQUIRED',
  '-352': 'RISK_CONTROL',
  '-412': 'RISK_CONTROL',
  12002: 'COMMENTS_CLOSED',
  12009: 'BAD_TARGET',
});

const RISK_CODES = new Set([-352, -412]);
const LOGIN_CODES = new Set([-101, -403]);

const SORT_MODE = Object.freeze({ hot: 3, time: 2 });
const SORT_LABEL = Object.freeze({ hot: '按热度', time: '按时间' });

function errWithCode(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function sleepDefault(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function randomInt(max) {
  return Math.floor(Math.random() * Math.max(0, max));
}

/**
 * 默认 HTTP：仅 api.bilibili.com，HTTPS，不跟随重定向，限字节。
 * @returns {Promise<{status:number, doc:object}>}
 */
export function defaultHttpGetJson(url, { headers = {}, timeoutMs = 20_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(String(url));
    } catch {
      reject(errWithCode('BAD_URL', 'invalid bilibili api url'));
      return;
    }
    if (u.protocol !== 'https:' || u.hostname !== API_HOST) {
      reject(errWithCode('BAD_URL', `bilibili api host not allowed: ${u.hostname}`));
      return;
    }

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };

    const req = httpsRequest({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400) {
        res.resume();
        finish(reject, errWithCode('REDIRECT', `unexpected redirect http ${status}`));
        return;
      }
      const chunks = [];
      let size = 0;
      let over = false;
      res.on('data', (chunk) => {
        if (over || settled) return;
        size += chunk.length;
        if (size > MAX_BYTES) {
          over = true;
          req.destroy();
          finish(reject, errWithCode('LIMIT', 'bilibili api response over byte limit'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        if (over) return;
        const text = Buffer.concat(chunks).toString('utf8');
        let doc;
        try {
          doc = JSON.parse(text);
        } catch {
          finish(reject, errWithCode('INVALID_JSON', 'bilibili api returned non-json'));
          return;
        }
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
          finish(reject, errWithCode('INVALID_JSON', 'bilibili api returned unexpected json'));
          return;
        }
        finish(resolve, { status, doc });
      });
    });

    const onAbort = () => {
      req.destroy();
      finish(reject, Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    req.on('timeout', () => {
      req.destroy();
      finish(reject, errWithCode('TIMEOUT', 'bilibili api timeout'));
    });
    req.on('error', (e) => {
      finish(reject, errWithCode(e.code || 'NETWORK', `bilibili api failed: ${e.message}`));
    });
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    req.end();
  });
}

/** 解析 target：BV / av / bilibili 链接；拒绝 b23 短链。 */
export function parseBilibiliTarget(target) {
  const raw = String(target || '').trim();
  if (!raw) throw errWithCode('BAD_TARGET', '缺少视频地址/BV 号');
  let page = 1;
  let text = raw;

  if (/^https?:\/\//i.test(raw)) {
    const u = new URL(raw);
    if (!/^https:$/i.test(u.protocol) || !/(^|\.)bilibili\.com$/i.test(u.hostname)) {
      throw errWithCode('BAD_TARGET', `只接受 https://*.bilibili.com 链接：${u.hostname}`);
    }
    const p = Number(u.searchParams.get('p'));
    if (Number.isFinite(p) && p > 0) page = Math.floor(p);
    text = raw;
  }

  const bv = text.match(/BV[0-9A-Za-z]{10}/);
  if (bv) {
    return { bvid: bv[0], aid: null, page, url: `https://www.bilibili.com/video/${bv[0]}` };
  }
  const av = text.match(/(?:^|\/|av)(\d+)(?:\/|$|\?)/i);
  if (av) {
    const aid = Number(av[1]);
    if (Number.isFinite(aid) && aid > 0) {
      return { bvid: null, aid, page, url: `https://www.bilibili.com/video/av${aid}` };
    }
  }
  if (/^\d+$/.test(text)) {
    return { bvid: null, aid: Number(text), page, url: `https://www.bilibili.com/video/av${text}` };
  }
  throw errWithCode('BAD_TARGET', '无法识别：请给 BV 号、av 号或 https://www.bilibili.com/video/... 链接');
}

/** WBI mixin_key：`(img_key+sub_key)` 按固定表重排后取前 32 位。 */
export function wbiMixinKey(imgKey, subKey) {
  const raw = `${imgKey || ''}${subKey || ''}`;
  if (raw.length < 64) throw errWithCode('WBI', 'WBI key 长度不足');
  let out = '';
  for (const index of MIXIN_TAB) out += raw[index];
  return out.slice(0, 32);
}

/**
 * 纯函数 WBI 签名，便于用固定 wts 做确定性测试。
 * @returns {string} 完整 query（含 wts，`w_rid` 在最后）
 */
export function signWbiQuery(params, { imgKey, subKey, wts }) {
  const values = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    values[key] = String(value);
  }
  if (wts !== undefined) values.wts = String(wts);
  const keys = Object.keys(values).sort();
  const search = new URLSearchParams();
  for (const key of keys) {
    // B 站要求 value 去掉 !'()*
    search.append(key, values[key].replace(/[!'()*]/g, ''));
  }
  const query = search.toString();
  const wRid = createHash('md5').update(query + wbiMixinKey(imgKey, subKey)).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

function stripTags(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function asList(value) {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
  if (value && typeof value === 'object') {
    if (value.rpid) return [value];
    return Object.values(value).filter((item) => item && typeof item === 'object');
  }
  return [];
}

/** 本地时间（分钟精度），用于人读；机器字段用 ctime/iso。 */
export function formatCommentTime(ctime) {
  const seconds = Number(ctime);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const d = new Date(seconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 统一评论对象；`replies` 只装楼中楼，不递归。 */
export function normalizeComment(raw, { upMid = null } = {}) {
  const member = raw?.member || {};
  const content = raw?.content || {};
  const control = raw?.reply_control || {};
  const mid = String(member.mid ?? '');
  const ctime = Number(raw?.ctime) || 0;
  const pictures = content.picture
    || content.pictures
    || content.image_urls
    || null;
  const hasImage = Array.isArray(pictures) ? pictures.length > 0 : Boolean(pictures);
  return {
    rpid: String(raw?.rpid ?? ''),
    root: String(raw?.root ?? '0'),
    parent: String(raw?.parent ?? '0'),
    mid,
    uname: String(member.uname ?? ''),
    level: member?.level_info?.current_level ?? null,
    isUp: upMid != null && mid !== '' && mid === String(upMid),
    likes: Number(raw?.like) || 0,
    ctime,
    time: formatCommentTime(ctime),
    iso: ctime ? new Date(ctime * 1000).toISOString() : '',
    message: stripTags(content.message),
    hasImage,
    rcount: Number(raw?.rcount) || 0,
    location: String(control.location ?? ''),
    isPinned: control.is_pinned === true,
    replies: [],
    subsFetched: 0,
    subsComplete: false,
    subsTruncated: false,
  };
}

function resolveCookieHeader(explicit, env) {
  // 去掉控制字符/换行，避免 header 注入
  const clean = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (explicit && typeof explicit === 'object') {
    return Object.entries(explicit)
      .filter(([key, value]) => key && value)
      .map(([key, value]) => `${clean(key)}=${clean(value)}`)
      .join('; ');
  }
  if (typeof explicit === 'string' && explicit.trim()) return clean(explicit);
  const full = clean(env?.BILIBILI_COOKIE);
  if (full) return full;
  const sess = clean(env?.BILIBILI_SESSDATA);
  return sess ? `SESSDATA=${sess}` : '';
}

function statusOfCode(code, status) {
  if (status === 412) return 'RISK_CONTROL';
  if (status === 403) return 'LOGIN_REQUIRED';
  const mapped = CODE_STATUS[String(code)];
  return mapped || null;
}

/**
 * @param {{
 *   httpGetJson?: Function,
 *   cookies?: string|object|null,
 *   env?: object,
 *   sleep?: (ms:number)=>Promise<void>,
 *   clock?: () => number,
 *   delayMs?: number,
 *   jitterMs?: number,
 *   timeoutMs?: number,
 *   maxPages?: number,
 *   log?: Function,
 * }} opts
 */
export function createBilibiliComments({
  httpGetJson = defaultHttpGetJson,
  cookies = null,
  env = process.env,
  sleep = sleepDefault,
  clock = () => Date.now(),
  delayMs = 1200,
  jitterMs = 300,
  timeoutMs = 20_000,
  maxPages = MAX_PAGES,
  log = () => {},
} = {}) {
  const cookieHeader = resolveCookieHeader(cookies, env);
  const hasSessData = /(?:^|;\s*)SESSDATA=/i.test(cookieHeader);
  // 每个实例独立缓存，避免测试之间串味
  let cachedWbi = { keysAt: 0, imgKey: '', subKey: '' };
  // nav 同时提供 WBI key 和登录态：一次抓取内复用，避免重复请求
  let cachedNav = { at: -Infinity, nav: null };
  const NAV_TTL_MS = 5_000;

  function headersFor(referer) {
    const headers = { Referer: referer || 'https://www.bilibili.com/' };
    if (cookieHeader) headers.Cookie = cookieHeader;
    return headers;
  }

  async function get(url, { referer, signal } = {}) {
    return httpGetJson(url, { headers: headersFor(referer), timeoutMs, signal });
  }

  async function pause(pageIndex) {
    if (pageIndex <= 1) return;
    await sleep(delayMs + randomInt(jitterMs));
  }

  function assertNotAborted(signal) {
    if (signal?.aborted) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
  }

  /**
   * 读取 nav：**即使 code=-101（未登录）也要拿 wbi_img**。
   * 这是匿名可签名的关键，不能因为 code!==0 就抛错。
   */
  async function readNav({ signal, force = false } = {}) {
    const now = clock();
    if (!force && cachedNav.nav && now - cachedNav.at < NAV_TTL_MS) return cachedNav.nav;
    const { doc } = await get(NAV_URL, { signal });
    const data = doc?.data || {};
    const wbi = data.wbi_img || {};
    const imgUrl = String(wbi.img_url || '');
    const subUrl = String(wbi.sub_url || '');
    const imgKey = imgUrl ? imgUrl.split('/').pop().split('.')[0] : '';
    const subKey = subUrl ? subUrl.split('/').pop().split('.')[0] : '';
    const nav = {
      code: Number(doc?.code) || 0,
      isLogin: data.isLogin === true,
      uname: String(data.uname || ''),
      mid: String(data.mid || ''),
      imgKey,
      subKey,
      hasKeys: Boolean(imgKey && subKey),
    };
    cachedNav = { at: now, nav };
    return nav;
  }

  async function ensureWbiKeys({ force = false, signal } = {}) {
    const now = clock();
    if (!force && cachedWbi.imgKey && now - cachedWbi.keysAt < WBI_TTL_MS) {
      return cachedWbi;
    }
    const nav = await readNav({ signal, force });
    if (!nav.hasKeys) throw errWithCode('WBI', '无法获取 WBI 签名密钥');
    cachedWbi = { keysAt: now, imgKey: nav.imgKey, subKey: nav.subKey };
    return cachedWbi;
  }

  function signed(params, keys) {
    return signWbiQuery(params, {
      imgKey: keys.imgKey,
      subKey: keys.subKey,
      wts: Math.floor(clock() / 1000),
    });
  }

  /** 解析视频信息：BV ↔ aid、标题、UP。 */
  async function resolveVideo(target, { signal } = {}) {
    const params = target.bvid ? `bvid=${encodeURIComponent(target.bvid)}` : `aid=${target.aid}`;
    const referer = target.url || 'https://www.bilibili.com/';
    let doc = null;
    let status = 200;
    try {
      const r = await get(`${VIEW_URL}?${params}`, { referer, signal });
      doc = r.doc;
      status = r.status;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      doc = null;
    }

    // 旧接口被风控/权限拦截时才用 WBI 版本再试一次（只读）；其它错误重试无意义
    const retryable = !doc
      || [-352, -412, -403, -404].includes(Number(doc.code));
    if (retryable) {
      try {
        const keys = await ensureWbiKeys({ signal });
        const r = await get(`${WBI_VIEW_URL}?${signed(target.bvid ? { bvid: target.bvid } : { aid: target.aid }, keys)}`, {
          referer,
          signal,
        });
        if (r.doc?.code === 0) {
          doc = r.doc;
          status = r.status;
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
    }

    if (!doc || doc.code !== 0) {
      const mapped = statusOfCode(doc?.code, status);
      const code = mapped || 'VIEW_FAILED';
      throw errWithCode(code, `读取视频信息失败：${doc?.message || '无响应'}`);
    }

    const data = doc.data || {};
    const bvid = String(data.bvid || target.bvid || '');
    const aid = Number(data.aid || target.aid) || null;
    const page = target.page || 1;
    if (!aid) throw errWithCode('BAD_TARGET', '视频信息里没有 aid，无法读取评论');
    return {
      bvid: bvid || null,
      aid,
      title: String(data.title || ''),
      up: String(data?.owner?.name || ''),
      upMid: data?.owner?.mid ?? null,
      page,
      url: bvid
        ? `https://www.bilibili.com/video/${bvid}/${page > 1 ? `?p=${page}` : ''}`
        : target.url,
    };
  }

  async function mainPage({ aid, mode, offset, referer, keys, signal }) {
    const params = {
      type: 1,
      oid: aid,
      mode,
      pagination_str: JSON.stringify({ offset: offset || '' }),
      plat: 1,
      web_location: 1315875,
    };
    const url = `${MAIN_URL}?${signed(params, keys)}`;
    let r = await get(url, { referer, signal });
    // -403：可能是 WBI key 过期/签名被拒，刷新一次再试；仍失败按登录/权限处理
    if (r.doc?.code === -403) {
      const fresh = await ensureWbiKeys({ force: true, signal });
      r = await get(`${MAIN_URL}?${signed(params, fresh)}`, { referer, signal });
    }
    return r;
  }

  /**
   * 主评论分页。匿名同样可用（WBI 接口不受"3 条热评"限制）。
   * @returns {{roots:Map, pinned:Map, total:number, pages:number, status:string, reason:string}}
   */
  async function collectMain({
    aid, referer, limit, sort, signal, keys,
  }) {
    const mode = SORT_MODE[sort] || SORT_MODE.hot;
    const roots = new Map();
    const pinned = new Map();
    let total = 0;
    let pages = 0;
    let offset = '';
    let status = 'ok';
    let reason = 'end';
    let lastCode = 0;

    for (let page = 1; page <= maxPages; page += 1) {
      await pause(page);
      assertNotAborted(signal);
      const { status: httpStatus, doc } = await mainPage({
        aid, mode, offset, referer, keys, signal,
      });
      if (doc?.code !== 0) {
        lastCode = Number(doc?.code) || 0;
        status = statusOfCode(lastCode, httpStatus) || 'API_ERROR';
        reason = status === 'RISK_CONTROL' ? 'risk_control'
          : status === 'LOGIN_REQUIRED' ? 'login_required'
            : status === 'COMMENTS_CLOSED' ? 'comments_closed'
              : 'api_error';
        break;
      }
      const data = doc.data || {};
      const cursor = data.cursor || {};
      total = Math.max(total, Number(cursor.all_count) || 0);
      for (const item of asList(data.top_replies)) {
        const rpid = String(item.rpid || '');
        if (rpid) pinned.set(rpid, item);
      }
      for (const item of asList(data.hots)) {
        const rpid = String(item.rpid || '');
        if (rpid && !roots.has(rpid)) roots.set(rpid, item);
      }
      const replies = asList(data.replies);
      for (const item of replies) {
        const rpid = String(item.rpid || '');
        if (rpid && !roots.has(rpid)) roots.set(rpid, item);
      }
      pages = page;
      log(`[bilibili-comments] 主评论第 ${page} 页：累计 ${roots.size} / 总数 ${total || '?'}`);

      if (!replies.length && page > 1) {
        reason = 'end';
        break;
      }
      if (roots.size >= limit) {
        reason = 'main_limit';
        break;
      }
      const next = String(cursor?.pagination_reply?.next_offset || '');
      if (cursor.is_end || !next || next === offset) {
        reason = 'end';
        break;
      }
      offset = next;
      if (page === maxPages) reason = 'page_cap';
    }

    return { roots, pinned, total: Math.max(total, roots.size), pages, status, reason, lastCode };
  }

  /** 降级：旧接口匿名只返回 3 条热评，用于 WBI 不可用时保底。 */
  async function collectLegacy({ aid, referer, limit, sort, signal }) {
    const roots = new Map();
    const pinned = new Map();
    let total = 0;
    let pages = 0;
    let status = 'ok';
    let reason = 'end';
    let lastCode = 0;
    const sortCode = sort === 'time' ? 0 : sort === 'reply' ? 2 : 1;
    for (let pn = 1; pn <= 3; pn += 1) {
      await pause(pn);
      assertNotAborted(signal);
      const { status: httpStatus, doc } = await get(
        `${REPLY_URL}?type=1&oid=${aid}&pn=${pn}&ps=20&sort=${sortCode}&nohot=0`,
        { referer, signal },
      );
      if (doc?.code !== 0) {
        lastCode = Number(doc?.code) || 0;
        status = statusOfCode(lastCode, httpStatus) || 'API_ERROR';
        reason = status === 'RISK_CONTROL' ? 'risk_control' : 'api_error';
        break;
      }
      const data = doc.data || {};
      total = Math.max(total, Number(data?.page?.count) || 0);
      const list = asList(data.replies);
      for (const item of asList(data.top_replies)) {
        const rpid = String(item.rpid || '');
        if (rpid) pinned.set(rpid, item);
      }
      for (const item of list) {
        const rpid = String(item.rpid || '');
        if (rpid && !roots.has(rpid)) roots.set(rpid, item);
      }
      pages = pn;
      if (!list.length) break;
      if (roots.size >= limit) break;
    }
    if (status === 'ok' && total > roots.size && roots.size <= 3) {
      status = 'LOGIN_REQUIRED';
      reason = 'anonymous_partial';
    }
    return {
      roots, pinned, total: Math.max(total, roots.size), pages, status, reason, lastCode,
    };
  }

  /**
   * 楼中楼分页：只有两层，回复的回复也平铺在同一 root 下。
   * @returns {{replies:object[], complete:boolean, truncated:boolean, status:string}}
   */
  async function collectSubs({
    aid, referer, rootRpid, rcount, maxSub, budget, signal,
  }) {
    const target = Math.max(0, Math.min(rcount, maxSub, budget));
    const out = new Map();
    let pn = 1;
    let status = 'ok';
    while (out.size < target && pn <= 50) {
      await pause(pn);
      assertNotAborted(signal);
      let doc;
      let httpStatus;
      try {
        const r = await get(
          `${SUB_URL}?type=1&oid=${aid}&root=${encodeURIComponent(rootRpid)}&pn=${pn}&ps=20`,
          { referer, signal },
        );
        doc = r.doc;
        httpStatus = r.status;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        status = 'UNAVAILABLE';
        break;
      }
      if (doc?.code !== 0) {
        status = statusOfCode(Number(doc?.code), httpStatus) || 'API_ERROR';
        break;
      }
      const list = asList(doc?.data?.replies);
      for (const item of list) {
        const rpid = String(item.rpid || '');
        if (rpid && !out.has(rpid)) out.set(rpid, item);
      }
      if (!list.length) break;
      pn += 1;
    }
    const replies = [...out.values()].slice(0, target);
    return {
      replies,
      complete: out.size >= rcount,
      truncated: target < rcount,
      status,
    };
  }

  /**
   * 抓评论区（只读）。
   * @returns {Promise<object>} 稳定字段：total / rootsFetched / subsFetched / incomplete
   */
  async function fetchComments({
    url = null,
    bvid = null,
    aid = null,
    limit = 50,
    maxSub = 20,
    maxSubTotal = 200,
    includeSubs = true,
    sort = 'hot',
    signal = null,
    onProgress = null,
  } = {}) {
    const startedAt = clock();
    const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 50));
    const safeMaxSub = Math.max(0, Math.min(1000, Number(maxSub) || 0));
    const safeBudget = Math.max(0, Math.min(5000, Number(maxSubTotal) || 0));
    const safeSort = SORT_MODE[sort] ? sort : 'hot';

    const base = {
      ok: false,
      status: 'UNAVAILABLE',
      error: null,
      meta: null,
      total: 0,
      rootsFetched: 0,
      subsFetched: 0,
      subsTotalInFetchedRoots: 0,
      incomplete: true,
      reasons: [],
      warnings: [],
      pinned: [],
      roots: [],
    };

    let target;
    try {
      target = parseBilibiliTarget(url || bvid || (aid != null ? String(aid) : ''));
    } catch (e) {
      return { ...base, status: 'BAD_TARGET', error: e.message, reasons: ['bad_target'] };
    }

    let nav = null;
    try {
      nav = await readNav({ signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // nav 失败不致命：拿不到 WBI key 就走旧接口
      log(`[bilibili-comments] nav 失败：${e.message}`);
    }

    let video;
    try {
      video = await resolveVideo(target, { signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      const status = ['RISK_CONTROL', 'LOGIN_REQUIRED', 'COMMENTS_CLOSED'].includes(e.code)
        ? e.code
        : 'UNAVAILABLE';
      return {
        ...base,
        status,
        error: e.message,
        reasons: [status === 'RISK_CONTROL' ? 'risk_control' : 'video_unavailable'],
      };
    }

    const referer = video.url;
    let keys = null;
    try {
      keys = await ensureWbiKeys({ signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      log(`[bilibili-comments] WBI key 不可用：${e.message}`);
    }

    onProgress?.(`读取评论区：${video.bvid || video.aid}，sort=${safeSort}`);
    let collected;
    let backend = 'x/v2/reply/wbi/main';
    let usedLegacy = false;

    const emptyLegacy = () => ({
      roots: new Map(),
      pinned: new Map(),
      total: 0,
      pages: 0,
      status: 'UNAVAILABLE',
      reason: 'network_error',
      lastCode: 0,
    });

    const runLegacy = async () => {
      usedLegacy = true;
      try {
        return await collectLegacy({
          aid: video.aid, referer, limit: safeLimit, sort: safeSort, signal,
        });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        log(`[bilibili-comments] 旧接口失败：${e.message}`);
        return emptyLegacy();
      }
    };

    if (keys) {
      try {
        collected = await collectMain({
          aid: video.aid, referer, limit: safeLimit, sort: safeSort, signal, keys,
        });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        log(`[bilibili-comments] WBI 主评论失败：${e.message}`);
        collected = await runLegacy();
        backend = 'x/v2/reply';
      }
    } else {
      collected = await runLegacy();
      backend = 'x/v2/reply';
    }

    const reasons = [];
    let status = collected.status;
    const reasonMap = {
      main_limit: 'main_limit',
      page_cap: 'page_cap',
      risk_control: 'risk_control',
      anonymous_partial: 'anonymous_partial',
      api_error: 'api_error',
      network_error: 'network_error',
    };
    if (reasonMap[collected.reason]) reasons.push(reasonMap[collected.reason]);

    // WBI 不可用（登录/权限）时，用旧接口兜底拿 3 条热评；风控则不再发请求
    if (!usedLegacy && status !== 'ok' && status !== 'RISK_CONTROL' && status !== 'COMMENTS_CLOSED') {
      const fallback = await runLegacy();
      if (fallback.roots.size > 0) {
        collected = {
          ...fallback,
          status: fallback.status === 'ok' ? status : fallback.status,
        };
        backend = 'x/v2/reply';
        reasons.push('wbi_fallback');
      }
    }

    const normalizedRoots = [];
    let subsFetched = 0;
    let subsTotal = 0;
    let truncatedRoots = 0;
    let subsStatus = 'ok';
    // 主评论已触发风控时，楼中楼一条都不再请求
    let stopSubs = status === 'RISK_CONTROL';
    const rootItems = [...collected.roots.values()].slice(0, safeLimit);
    let budget = safeBudget;

    for (const raw of rootItems) {
      const root = normalizeComment(raw, { upMid: video.upMid });
      if (includeSubs) {
        subsTotal += root.rcount;
        if (root.rcount > 0 && budget > 0 && !stopSubs) {
          const subs = await collectSubs({
            aid: video.aid,
            referer,
            rootRpid: root.rpid,
            rcount: root.rcount,
            maxSub: safeMaxSub,
            budget,
            signal,
          });
          if (subs.status !== 'ok' && subsStatus === 'ok') subsStatus = subs.status;
          // 楼中楼接口一出现非正常状态就停手，避免对同一后端连续失败重试
          if (subs.status !== 'ok') stopSubs = true;
          const normalized = subs.replies.map((item) => normalizeComment(item, { upMid: video.upMid }));
          normalized.sort((a, b) => a.ctime - b.ctime);
          root.replies = normalized;
          root.subsFetched = normalized.length;
          root.subsComplete = subs.complete;
          root.subsTruncated = !subs.complete;
          subsFetched += normalized.length;
          budget -= normalized.length;
          if (!subs.complete) truncatedRoots += 1;
        } else if (root.rcount > 0) {
          root.subsTruncated = true;
          truncatedRoots += 1;
        }
      } else {
        root.subsTruncated = root.rcount > 0;
        if (root.rcount > 0) truncatedRoots += 1;
      }
      normalizedRoots.push(root);
    }

    const pinned = [];
    const pinnedIds = new Set();
    for (const raw of collected.pinned.values()) {
      const item = normalizeComment(raw, { upMid: video.upMid });
      if (!item.rpid || pinnedIds.has(item.rpid)) continue;
      pinned.push(item);
      pinnedIds.add(item.rpid);
    }

    if (includeSubs && subsStatus !== 'ok') {
      status = subsStatus;
      reasons.push(subsStatus === 'RISK_CONTROL' ? 'risk_control' : 'subs_unavailable');
    }

    const total = Math.max(collected.total, normalizedRoots.length);
    const rootsIncomplete = normalizedRoots.length < total;
    const subsIncomplete = subsFetched < subsTotal;
    const incomplete = status !== 'ok' || rootsIncomplete || subsIncomplete;

    if (rootsIncomplete && !reasons.includes('main_limit')) reasons.push('main_partial');
    if (subsIncomplete && includeSubs) {
      reasons.push(safeBudget === 0 ? 'subs_disabled' : 'subs_partial');
    }

    const warnings = [];
    if (status === 'LOGIN_REQUIRED') {
      warnings.push(
        '主评论接口权限不足（未登录 / 登录态失效 / 该视频评论区限制）：已退回旧接口，匿名通常只能拿到 3 条热评。'
        + '楼中楼仍可按 rpid 翻页。需要完整主评论时配置 BILIBILI_SESSDATA 后重试。',
      );
    }
    if (status === 'RISK_CONTROL') {
      warnings.push('触发 B 站风控：已停止抓取，没有重试或绕过。稍后再试，不要连续重跑。');
    }
    if (status === 'COMMENTS_CLOSED') warnings.push('该视频评论区已关闭（12002）。');
    if (status === 'API_ERROR' || status === 'UNAVAILABLE') {
      warnings.push(
        `评论接口不可用（${status}${collected.lastCode ? `, code=${collected.lastCode}` : ''}）；`
        + '没有继续重试，避免触发风控。',
      );
    }
    if (rootsIncomplete && status !== 'LOGIN_REQUIRED' && status !== 'RISK_CONTROL') {
      warnings.push(`主评论未抓全：本次 ${normalizedRoots.length} / 总数 ${total}，可调大 limit。`);
    }
    if (subsIncomplete && includeSubs) {
      if (safeBudget === 0 || safeMaxSub === 0) {
        warnings.push('已按需跳过楼中楼（maxSub 或 maxSubTotal 为 0），主评论不受影响。');
      } else {
        warnings.push(
          `楼中楼未抓全：本次 ${subsFetched} / 已抓主评论下的 ${subsTotal}，可调大 maxSub / maxSubTotal。`,
        );
      }
    }
    if (!includeSubs) warnings.push('已按 includeSubs=false 跳过楼中楼。');

    return {
      ok: status === 'ok',
      status,
      error: null,
      meta: {
        bvid: video.bvid,
        aid: video.aid,
        title: video.title,
        up: video.up,
        upMid: video.upMid != null ? String(video.upMid) : '',
        url: video.url,
        page: video.page,
        sort: safeSort,
        sortLabel: SORT_LABEL[safeSort],
        backend,
        fetchedAt: new Date(clock()).toISOString(),
        elapsedMs: Math.max(0, clock() - startedAt),
        login: {
          loggedIn: Boolean(nav?.isLogin),
          hasSessData,
          uname: nav?.uname || '',
          mid: nav?.mid || '',
        },
      },
      total,
      rootsFetched: normalizedRoots.length,
      subsFetched,
      subsTotalInFetchedRoots: subsTotal,
      truncatedRoots,
      incomplete,
      reasons: [...new Set(reasons)],
      warnings,
      pinned,
      roots: normalizedRoots,
    };
  }

  return {
    name: 'bilibili-comments',
    version: '1',
    /** 只读能力自检：不联网也能说明边界。 */
    async available() {
      return {
        ok: true,
        readOnly: true,
        anonymous: true,
        hasSessData,
      };
    },
    parseTarget: parseBilibiliTarget,
    resolveVideo,
    fetchComments,
    /** 单测/上层复用：暴露签名与分页原语，不暴露 cookie。 */
    internals: {
      signWbiQuery,
      wbiMixinKey,
      ensureWbiKeys,
    },
  };
}
