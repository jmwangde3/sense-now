import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBilibiliComments,
  parseBilibiliTarget,
  signWbiQuery,
  wbiMixinKey,
  normalizeComment,
} from '../src/video-index/adapters/bilibili-comments.js';

const IMG_KEY = 'a'.repeat(32);
const SUB_KEY = 'b'.repeat(32);
const BV = 'BV17x411w7KC';

function navDoc({ isLogin = false, imgKey = IMG_KEY, subKey = SUB_KEY } = {}) {
  return {
    status: 200,
    doc: {
      // 匿名 nav 就是 -101，但 wbi_img 仍然存在 —— 这是匿名可签名的前提
      code: isLogin ? 0 : -101,
      data: {
        isLogin,
        uname: isLogin ? 'tester' : '',
        mid: isLogin ? 42 : 0,
        wbi_img: {
          img_url: `https://i0.hdslb.com/bfs/wbi/${imgKey}.png`,
          sub_url: `https://i0.hdslb.com/bfs/wbi/${subKey}.png`,
        },
      },
    },
  };
}

function viewDoc() {
  return {
    status: 200,
    doc: {
      code: 0,
      data: {
        aid: 170001,
        bvid: BV,
        title: '测试视频',
        owner: { mid: 9, name: 'UP主' },
      },
    },
  };
}

function rawComment(id, { rcount = 0, uname = `user${id}` } = {}) {
  return {
    rpid: 1000 + id,
    root: 0,
    parent: 0,
    like: 100 - id,
    ctime: 1_700_000_000 + id * 60,
    rcount,
    member: { mid: 500 + id, uname, level_info: { current_level: 3 } },
    content: { message: `评论 ${id}` },
    reply_control: { location: '上海' },
  };
}

function mainDoc({ replies, total, next = '', end = false }) {
  return {
    status: 200,
    doc: {
      code: 0,
      data: {
        cursor: {
          all_count: total,
          is_end: end,
          pagination_reply: { next_offset: next },
        },
        replies,
      },
    },
  };
}

function subDoc(replies) {
  return { status: 200, doc: { code: 0, data: { replies, page: { count: replies.length } } } };
}

function makeHttp(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers || {} });
    for (const route of routes) {
      if (route.match(url)) {
        const out = typeof route.reply === 'function' ? route.reply(url, opts) : route.reply;
        if (out instanceof Error) throw out;
        return out;
      }
    }
    throw new Error(`unexpected url: ${url}`);
  };
  fn.calls = calls;
  fn.count = (needle) => calls.filter((c) => c.url.includes(needle)).length;
  fn.lastHeaders = () => calls[calls.length - 1]?.headers || {};
  return fn;
}

function adapterWith(http, extra = {}) {
  return createBilibiliComments({
    httpGetJson: http,
    env: {},
    delayMs: 0,
    jitterMs: 0,
    sleep: async () => {},
    clock: () => 1_700_000_000_000,
    ...extra,
  });
}

test('WBI 签名：排序、去特殊字符、wts 只出现一次', () => {
  assert.equal(wbiMixinKey(IMG_KEY, SUB_KEY), 'bbaabaababaababbababbabaaaababba');

  const params = {
    type: 1,
    oid: 170001,
    mode: 3,
    pagination_str: JSON.stringify({ offset: '' }),
    plat: 1,
    web_location: 1315875,
  };
  const query = signWbiQuery(params, { imgKey: IMG_KEY, subKey: SUB_KEY, wts: 1_700_000_000 });

  // 基准向量由独立 Python 实现算出，避免自我印证
  assert.equal(
    query,
    'mode=3&oid=170001&pagination_str=%7B%22offset%22%3A%22%22%7D&plat=1&type=1'
      + '&web_location=1315875&wts=1700000000&w_rid=ba73c86425c825304d96ba16da3e74c0',
  );
  assert.equal(query.match(/wts=/g).length, 1, 'wts 只能出现一次，重复会导致 -403');
  assert.ok(query.indexOf('w_rid=') > query.indexOf('wts='));
});

test('匿名分页：两页主评论 + 楼中楼，去重后 incomplete=false', async () => {
  let mainCalls = 0;
  const http = makeHttp([
    { match: (u) => u.includes('/x/web-interface/nav'), reply: navDoc() },
    { match: (u) => u.includes('/x/web-interface/view'), reply: viewDoc() },
    {
      match: (u) => u.includes('/x/v2/reply/wbi/main'),
      reply: (url) => {
        mainCalls += 1;
        const pagination = JSON.parse(new URL(url).searchParams.get('pagination_str'));
        if (!pagination.offset) {
          return mainDoc({
            replies: [rawComment(1, { rcount: 1 }), rawComment(2)],
            total: 3,
            next: 'OFF1',
          });
        }
        return mainDoc({ replies: [rawComment(3)], total: 3, end: true });
      },
    },
    { match: (u) => u.includes('/x/v2/reply/reply'), reply: subDoc([rawComment(9)]) },
  ]);

  const result = await adapterWith(http).fetchComments({ url: `https://www.bilibili.com/video/${BV}`, limit: 10 });

  assert.equal(result.status, 'ok');
  assert.equal(result.ok, true);
  assert.equal(mainCalls, 2);
  assert.equal(result.total, 3);
  assert.equal(result.rootsFetched, 3);
  assert.equal(result.subsFetched, 1);
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.meta.aid, 170001);
  assert.equal(result.meta.backend, 'x/v2/reply/wbi/main');
  assert.equal(result.meta.login.loggedIn, false);
  assert.equal(result.roots[0].isUp, false);
  assert.equal(result.roots[0].time.length, 16);
  assert.ok(!JSON.stringify(result).includes('SESSDATA'));
});

test('WBI 返回 -101 时退回旧接口：明确 LOGIN_REQUIRED，仍保留 3 条与楼中楼', async () => {
  const http = makeHttp([
    { match: (u) => u.includes('/x/web-interface/nav'), reply: navDoc() },
    { match: (u) => u.includes('/x/web-interface/view'), reply: viewDoc() },
    {
      match: (u) => u.includes('/x/v2/reply/wbi/main'),
      reply: { status: 200, doc: { code: -101, message: '账号未登录' } },
    },
    {
      match: (u) => u.includes('/x/v2/reply?'),
      reply: (url) => {
        const pn = Number(new URL(url).searchParams.get('pn'));
        if (pn === 1) {
          return { status: 200, doc: { code: 0, data: { page: { count: 100 }, replies: [rawComment(1), rawComment(2), rawComment(3)] } } };
        }
        return { status: 200, doc: { code: 0, data: { page: { count: 100 }, replies: [] } } };
      },
    },
    { match: (u) => u.includes('/x/v2/reply/reply'), reply: subDoc([]) },
  ]);

  const result = await adapterWith(http).fetchComments({ url: BV, limit: 10 });

  assert.equal(result.status, 'LOGIN_REQUIRED');
  assert.equal(result.ok, false);
  assert.equal(result.rootsFetched, 3);
  assert.equal(result.total, 100);
  assert.equal(result.incomplete, true);
  assert.equal(result.meta.backend, 'x/v2/reply');
  assert.ok(result.reasons.includes('wbi_fallback'));
  assert.ok(result.warnings.some((w) => w.includes('权限不足')));
});

test('风控 -352：立即停止，不重试、不退回旧接口', async () => {
  const http = makeHttp([
    { match: (u) => u.includes('/x/web-interface/nav'), reply: navDoc() },
    { match: (u) => u.includes('/x/web-interface/view'), reply: viewDoc() },
    {
      match: (u) => u.includes('/x/v2/reply/wbi/main'),
      reply: { status: 200, doc: { code: -352, message: '风控校验失败' } },
    },
    {
      match: (u) => u.includes('/x/v2/reply?'),
      reply: { status: 200, doc: { code: 0, data: { page: { count: 0 }, replies: [] } } },
    },
    { match: (u) => u.includes('/x/v2/reply/reply'), reply: subDoc([]) },
  ]);

  const result = await adapterWith(http).fetchComments({ url: BV, limit: 10 });

  assert.equal(result.status, 'RISK_CONTROL');
  assert.equal(result.rootsFetched, 0);
  assert.equal(http.count('/x/v2/reply?'), 0);
  assert.ok(result.reasons.includes('risk_control'));
  assert.ok(result.warnings.some((w) => w.includes('风控')));
});

test('楼中楼遇到风控：立刻停手，不再请求后续 root', async () => {
  const http = makeHttp([
    { match: (u) => u.includes('/x/web-interface/nav'), reply: navDoc() },
    { match: (u) => u.includes('/x/web-interface/view'), reply: viewDoc() },
    {
      match: (u) => u.includes('/x/v2/reply/wbi/main'),
      reply: mainDoc({
        replies: [rawComment(1, { rcount: 1 }), rawComment(2, { rcount: 1 })],
        total: 2,
        end: true,
      }),
    },
    {
      match: (u) => u.includes('/x/v2/reply/reply'),
      reply: { status: 200, doc: { code: -352, message: '风控校验失败' } },
    },
  ]);

  const result = await adapterWith(http).fetchComments({ url: BV, limit: 10 });

  assert.equal(result.status, 'RISK_CONTROL');
  assert.equal(http.count('/x/v2/reply/reply'), 1, '第一条楼中楼风控后不应继续第二条');
  assert.ok(result.warnings.some((w) => w.includes('风控')));
});

test('-403 时刷新 WBI key 只重试一次', async () => {
  let mainCalls = 0;
  let navCalls = 0;
  const http = makeHttp([
    {
      match: (u) => u.includes('/x/web-interface/nav'),
      reply: () => {
        navCalls += 1;
        return navDoc();
      },
    },
    { match: (u) => u.includes('/x/web-interface/view'), reply: viewDoc() },
    {
      match: (u) => u.includes('/x/v2/reply/wbi/main'),
      reply: () => {
        mainCalls += 1;
        if (mainCalls === 1) return { status: 200, doc: { code: -403, message: '访问权限不足' } };
        return mainDoc({ replies: [rawComment(1)], total: 1, end: true });
      },
    },
    { match: (u) => u.includes('/x/v2/reply/reply'), reply: subDoc([]) },
  ]);

  const result = await adapterWith(http).fetchComments({ url: BV, limit: 10 });

  assert.equal(mainCalls, 2);
  assert.equal(navCalls, 2, '首次 nav + refresh 各一次');
  assert.equal(result.status, 'ok');
  assert.equal(result.rootsFetched, 1);
});

test('maxSub / maxSubTotal 截断：incomplete 与原因可解释', async () => {
  const http = makeHttp([
    { match: (u) => u.includes('/x/web-interface/nav'), reply: navDoc() },
    { match: (u) => u.includes('/x/web-interface/view'), reply: viewDoc() },
    {
      match: (u) => u.includes('/x/v2/reply/wbi/main'),
      reply: mainDoc({ replies: [rawComment(1, { rcount: 10 })], total: 1, end: true }),
    },
    {
      match: (u) => u.includes('/x/v2/reply/reply'),
      reply: subDoc([rawComment(2), rawComment(3), rawComment(4), rawComment(5)]),
    },
  ]);

  const result = await adapterWith(http).fetchComments({ url: BV, limit: 10, maxSub: 3, maxSubTotal: 3 });

  assert.equal(result.subsFetched, 3);
  assert.equal(result.subsTotalInFetchedRoots, 10);
  assert.equal(result.roots[0].subsComplete, false);
  assert.equal(result.roots[0].subsTruncated, true);
  assert.equal(result.incomplete, true);
  assert.ok(result.reasons.includes('subs_partial'));
});

test('目标解析：BV/av/链接可用，b23 与非 B 站域名拒绝', () => {
  assert.deepEqual(
    { bvid: parseBilibiliTarget(`https://www.bilibili.com/video/${BV}?p=3`).bvid, page: 3 },
    { bvid: BV, page: 3 },
  );
  assert.equal(parseBilibiliTarget('av170001').aid, 170001);
  assert.equal(parseBilibiliTarget('170001').aid, 170001);
  assert.throws(() => parseBilibiliTarget('https://b23.tv/abc'), /bilibili\.com/);
  assert.throws(() => parseBilibiliTarget('https://evil.example/video/BV17x411w7KC'), /bilibili\.com/);
  assert.throws(() => parseBilibiliTarget(''), /缺少/);
});

test('cookie 只用于请求头，不进入返回值', async () => {
  const http = makeHttp([
    { match: (u) => u.includes('/x/web-interface/nav'), reply: navDoc({ isLogin: true }) },
    { match: (u) => u.includes('/x/web-interface/view'), reply: viewDoc() },
    {
      match: (u) => u.includes('/x/v2/reply/wbi/main'),
      reply: mainDoc({ replies: [rawComment(1)], total: 1, end: true }),
    },
    { match: (u) => u.includes('/x/v2/reply/reply'), reply: subDoc([]) },
  ]);

  const result = await adapterWith(http, { cookies: 'SESSDATA=super-secret-value' })
    .fetchComments({ url: BV, limit: 10 });
  const mainCall = http.calls.find((c) => c.url.includes('/x/v2/reply/wbi/main'));

  assert.match(mainCall.headers.Cookie, /SESSDATA=super-secret-value/);
  assert.ok(!JSON.stringify(result).includes('super-secret-value'));
  assert.equal(result.meta.login.hasSessData, true);
  assert.equal(result.meta.login.loggedIn, true);
});

test('normalizeComment：去 HTML、识别 UP 主/置顶/图片', () => {
  const item = normalizeComment({
    rpid: 7,
    like: 3,
    ctime: 1_700_000_000,
    rcount: 2,
    member: { mid: 9, uname: 'UP主', level_info: { current_level: 6 } },
    content: { message: '<a href="#">@某人</a> 看这个 &amp; 那个', picture: [{ img_src: 'x' }] },
    reply_control: { location: '北京', is_pinned: true },
  }, { upMid: 9 });

  assert.equal(item.rpid, '7');
  assert.equal(item.isUp, true);
  assert.equal(item.isPinned, true);
  assert.equal(item.hasImage, true);
  assert.equal(item.message, '@某人 看这个 & 那个');
  assert.equal(item.time.length, 16);
});
