/**
 * 回信窗口（replyWindowHours）必须是热载的。
 *
 * 为什么单独测：这个数直接决定「海面上有多少信」。
 * 信被捞走就不在海上，要等回信（永久消失）或超时（回海）——
 * 窗口越长，卡在手上的越多、海面越薄。实测曾出现 91 封同时在 91 个人手上，
 * 而海面只剩 17 封，那时它是硬编码 72 小时的常量，改一次要重启（=海啸）。
 *
 * 所以现在改成 tuning 里的热载值。这里验证三件事：
 *   A. 改参数立刻影响**新捞到的**信
 *   B. 已经捞走的信不被追溯修改（窗口早已写死在数据里）
 *   C. 写坏了（0 / 负数 / 非数字）要退回默认，不能把海搞挂
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createApi, sha256, type Api } from '../server/app.ts';
import { Db } from '../server/db.ts';
import { DEFAULT_TUNING, makeTuningReader, type Tuning } from '../server/tuning.ts';
import type { CatchRes } from '../shared/contract.ts';

const HOUR = 3_600_000;

interface Rig {
  api: Api;
  db: Db;
  clock: { t: number };
  tuning: Tuning;
  token(who: string): string;
  catchAs(token: string): CatchRes;
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
  const catchAs = (t: string): CatchRes => {
    const res = api.handle({ method: 'POST', path: '/catch', token: t, ip: '1.1.1.1', body: {} });
    expect(res.status).toBe(200);
    return res.body as CatchRes;
  };
  return { api, db, clock, tuning, token, catchAs };
}

function seedLetter(h: Rig, author = 'someone'): string {
  const id = `l_${Math.random().toString(36).slice(2, 10)}`;
  h.db.letters.push({
    id,
    authorHash: author,
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

describe('A. 改参数立刻影响新捞到的信', () => {
  it('默认 72 小时', () => {
    const h = rig();
    const me = h.token('me');
    seedLetter(h);
    const res = h.catchAs(me);
    if (res.empty) throw new Error('应该捞到');
    const span = Date.parse(res.windowUntil!) - h.clock.t;
    expect(span).toBe(72 * HOUR);
  });

  it('调到 24 小时后，新捞到的信窗口就是 24 小时', () => {
    const h = rig({ replyWindowHours: 24 });
    const me = h.token('me');
    seedLetter(h);
    const res = h.catchAs(me);
    if (res.empty) throw new Error('应该捞到');
    const span = Date.parse(res.windowUntil!) - h.clock.t;
    expect(span).toBe(24 * HOUR);
  });

  it('调到 1 小时也生效（边界）', () => {
    const h = rig({ replyWindowHours: 1 });
    const me = h.token('me');
    seedLetter(h);
    const res = h.catchAs(me);
    if (res.empty) throw new Error('应该捞到');
    expect(Date.parse(res.windowUntil!) - h.clock.t).toBe(1 * HOUR);
  });
});

describe('B. 不追溯修改已经捞走的信', () => {
  it('改参数后，之前捞到的那封窗口不变', () => {
    const h = rig({ replyWindowHours: 72 });
    const me = h.token('me');
    seedLetter(h);
    const first = h.catchAs(me);
    if (first.empty) throw new Error('应该捞到');
    const originalWindow = first.windowUntil;

    // 运维改参数
    h.tuning.replyWindowHours = 24;

    // 已经捞走的那封，数据里的窗口不该变
    const row = h.db.letters.find((l) => l.id === first.letterId)!;
    expect(new Date(row.replyWindowUntil!).toISOString()).toBe(originalWindow);
  });

  it('窗口到点后，sweep 会把它放回海里（用短窗口验证）', () => {
    const h = rig({ replyWindowHours: 1 });
    const me = h.token('me');
    const id = seedLetter(h);
    const res = h.catchAs(me);
    if (res.empty) throw new Error('应该捞到');

    // 刚捞到：还在手上
    expect(h.db.letters.find((l) => l.id === id)!.state).toBe('caught');

    // 2 小时后发一个请求触发 sweep
    h.clock.t += 2 * HOUR;
    h.api.handle({ method: 'GET', path: '/quota', token: me, ip: '1.1.1.1' });

    const row = h.db.letters.find((l) => l.id === id)!;
    expect(row.state).toBe('floating');
    expect(row.catcherHash).toBeNull();
  });
});

describe('C. 写坏了要退回默认，不能把海搞挂', () => {
  it('写 0 → 夹到最小 1 小时（不能是 0，否则刚捞到就回海）', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'bottle-window-'));
    const file = join(dir, 'tuning.json');

    writeFileSync(file, JSON.stringify({ replyWindowHours: 0 }), 'utf8');
    expect(makeTuningReader(file).current().replyWindowHours).toBe(1);

    writeFileSync(file, JSON.stringify({ replyWindowHours: -5 }), 'utf8');
    expect(makeTuningReader(file).current().replyWindowHours).toBe(1);

    writeFileSync(file, JSON.stringify({ replyWindowHours: 'abc' }), 'utf8');
    expect(makeTuningReader(file).current().replyWindowHours).toBe(DEFAULT_TUNING.replyWindowHours);

    writeFileSync(file, JSON.stringify({ replyWindowHours: 24 }), 'utf8');
    expect(makeTuningReader(file).current().replyWindowHours).toBe(24);
  });

  it('缺省时用默认值 72', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'bottle-window-'));
    const file = join(dir, 'tuning.json');

    writeFileSync(file, JSON.stringify({}), 'utf8');
    expect(makeTuningReader(file).current().replyWindowHours).toBe(72);
  });
});
