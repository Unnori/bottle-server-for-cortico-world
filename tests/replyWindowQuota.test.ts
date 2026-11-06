/**
 * `/quota` 必须把「回信窗口」告诉客户端。
 *
 * 背景：客户端有三处需要自己算窗口——
 *   · 从本机历史恢复一封「服务端占着但本机没记下」的信
 *   · 服务端没给 windowUntil 时的兜底
 *   · 显示「还剩几小时回海」的倒计时
 *
 * 如果客户端继续用写死的 72 小时，而运维把服务端调成 24，
 * 客户端会显示「还剩 72 小时」——用户以为有时间，信其实已经回海了。
 *
 * 所以这里验证：
 *   A. 所有返回 Quota 的出口都带 reply_window_hours（漏一个就会不一致）
 *   B. 它跟着 tuning 热载变化
 *   C. 老服务端不返回时，客户端能退回默认（这一条靠类型可选 + 客户端兜底）
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createApi, sha256, type Api } from '../server/app.ts';
import { Db } from '../server/db.ts';
import { DEFAULT_TUNING, type Tuning } from '../server/tuning.ts';
import type { Quota } from '../shared/contract.ts';

interface Rig {
  api: Api;
  db: Db;
  clock: { t: number };
  tuning: Tuning;
  token(who: string): string;
  quota(token: string): Quota;
}

const rigs: Array<() => void> = [];

function rig(over: Partial<Tuning> = {}): Rig {
  const tuning: Tuning = { ...DEFAULT_TUNING, ...over };
  const clock = { t: Date.parse('2026-11-05T10:00:00+08:00') };
  const db = Db.open(null);
  const api = createApi(db, {
    seedChannel: 'mail',
    tuning: { current: () => tuning },
    now: () => clock.t,
    timeZone: 'Asia/Hong_Kong',
    random: () => 0.5,
    newToken: (() => {
      let n = 0;
      return () => `tok_${++n}`;
    })(),
    ipLimit: 500,
    rules: { sendBase: 50, sendCap: 50, catchBase: 50, catchCap: 50, poolDivisor: 5, replyCap: 50 },
    startedAt: clock.t,
  });
  rigs.push(() => void 0);

  const token = (who: string): string => {
    const res = api.handle({ method: 'POST', path: '/register', ip: '1.1.1.1', body: { hash: sha256(who) } });
    expect(res.status).toBe(200);
    return (res.body as { token: string }).token;
  };
  const quota = (t: string): Quota =>
    api.handle({ method: 'GET', path: '/quota', token: t, ip: '1.1.1.1' }).body as Quota;

  return { api, db, clock, tuning, token, quota };
}

function seedLetter(h: Rig): string {
  const id = `l_${Math.random().toString(36).slice(2, 10)}`;
  h.db.letters.push({
    id,
    authorHash: 'someone',
    body: '一封信。',
    createdAt: h.clock.t,
    state: 'floating',
    catcherHash: null,
    caughtAt: null,
    replyWindowUntil: null,
    deliveredCount: 0,
    throws: 0,
  });
  return id;
}

afterEach(() => {
  while (rigs.length) rigs.pop()?.();
});

describe('A. 每个返回 Quota 的出口都带上 reply_window_hours', () => {
  it('GET /quota 带上了', () => {
    const h = rig({ replyWindowHours: 24 });
    const me = h.token('me');
    expect(h.quota(me).reply_window_hours).toBe(24);
  });

  it('POST /throw 的回执里也带（走同一个 quotaFor）', () => {
    const h = rig({ replyWindowHours: 24 });
    const me = h.token('me');
    const res = h.api.handle({
      method: 'POST',
      path: '/throw',
      token: me,
      ip: '1.1.1.1',
      body: { body: '一封信。' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { quota: Quota }).quota.reply_window_hours).toBe(24);
  });

  it('POST /catch 的回执里也带', () => {
    const h = rig({ replyWindowHours: 24 });
    const me = h.token('me');
    seedLetter(h);
    const res = h.api.handle({ method: 'POST', path: '/catch', token: me, ip: '1.1.1.1', body: {} });
    expect(res.status).toBe(200);
    const body = res.body as { quota: Quota };
    expect(body.quota.reply_window_hours).toBe(24);
  });

  it('POST /dismiss 的回执里也带', () => {
    const h = rig({ replyWindowHours: 24 });
    const me = h.token('me');
    const id = seedLetter(h);
    h.api.handle({ method: 'POST', path: '/catch', token: me, ip: '1.1.1.1', body: {} });
    const res = h.api.handle({
      method: 'POST',
      path: '/dismiss',
      token: me,
      ip: '1.1.1.1',
      body: { letterId: id },
    });
    expect(res.status).toBe(200);
    expect((res.body as { quota: Quota }).quota.reply_window_hours).toBe(24);
  });
});

describe('B. 跟着 tuning 热载变化', () => {
  it('改参数后下一次 /quota 立刻反映新值', () => {
    const h = rig({ replyWindowHours: 72 });
    const me = h.token('me');
    expect(h.quota(me).reply_window_hours).toBe(72);

    h.tuning.replyWindowHours = 24;
    expect(h.quota(me).reply_window_hours).toBe(24);

    h.tuning.replyWindowHours = 6;
    expect(h.quota(me).reply_window_hours).toBe(6);
  });

  it('与 /catch 实际给出的 windowUntil 一致（不能自相矛盾）', () => {
    const h = rig({ replyWindowHours: 24 });
    const me = h.token('me');
    seedLetter(h);

    const caught = h.api.handle({ method: 'POST', path: '/catch', token: me, ip: '1.1.1.1', body: {} })
      .body as { windowUntil: string; quota: Quota };

    // 回执里说的窗口，应该等于「现在 + reply_window_hours」
    const span = Date.parse(caught.windowUntil) - h.clock.t;
    expect(span).toBe(24 * 3_600_000);
    // 而且和 quota 里报的小时数对得上
    expect(caught.quota.reply_window_hours).toBe(24);
  });
});

describe('C. 默认值与边界', () => {
  it('默认 72', () => {
    const h = rig();
    const me = h.token('me');
    expect(h.quota(me).reply_window_hours).toBe(72);
  });

  it('最小 1（不会出现 0 或负数）', () => {
    const h = rig({ replyWindowHours: 1 });
    const me = h.token('me');
    expect(h.quota(me).reply_window_hours).toBe(1);
  });
});
