/**
 * 种子瓶（§13）。
 *
 * 验收对应关系：
 *   · §13.6 #11 池子没有真人信时捞到种子，来源写「海边邮局」
 *   · §13.6 #12 同一个人不会第二次捞到同一封；捞满 2 封后不再给种子
 *   · §13.6 #13 改 seeds/ 之后热载生效且进程没重启（用 generation 与 startedAt 钉）
 *   · §13.7 种子不回信、不会裂
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, sha256, type Api } from '../server/app.ts';
import { Db } from '../server/db.ts';
import { SeedStore } from '../server/seeds.ts';
import { SEED_FROM } from '../shared/text.ts';
import type { CatchRes, LetterRes } from '../shared/contract.ts';

interface Rig {
  api: Api;
  db: Db;
  seeds: SeedStore;
  /** 种子目录本身。 */
  dir: string;
  clock: { t: number };
  /** 写一封种子并立刻热载（省掉等 fs.watch 的时间）。 */
  addSeed(name: string, value: unknown): void;
  token(seed: string, ip?: string): string;
  catchAs(token: string): CatchRes;
  stop(): void;
}

const WIDE = { sendBase: 50, sendCap: 50, catchBase: 50, catchCap: 50, poolDivisor: 5 };

function writeSeed(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
}

function rig(opts: { seedsPerUserMax?: number } = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), 'bottle-seeds-'));
  const dir = join(root, 'seeds');
  mkdirSync(dir, { recursive: true });

  const seeds = new SeedStore({ dir });
  seeds.start();

  const db = Db.open(null);
  const clock = { t: Date.parse('2026-10-27T10:00:00+08:00') };
  let tokens = 0;
  const api = createApi(db, {
    seeds,
    seedsPerUserMax: opts.seedsPerUserMax ?? 2,
    now: () => clock.t,
    timeZone: 'Asia/Shanghai',
    random: () => 0.42,
    newToken: () => `tok_${++tokens}`,
    ipLimit: 200,
    rules: WIDE,
    startedAt: clock.t,
  });

  const token = (seed: string, ip = '1.1.1.1'): string => {
    const res = api.handle({ method: 'POST', path: '/register', ip, body: { hash: sha256(seed) } });
    expect(res.status).toBe(200);
    return (res.body as { token: string }).token;
  };

  const catchAs = (t: string): CatchRes => {
    const res = api.handle({ method: 'POST', path: '/catch', token: t, ip: '1.1.1.1', body: {} });
    expect(res.status).toBe(200);
    return res.body as CatchRes;
  };

  return {
    api,
    db,
    seeds,
    dir,
    clock,
    addSeed(name, value) {
      writeSeed(dir, name, value);
      seeds.reload();
    },
    token,
    catchAs,
    stop() {
      seeds.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

let h: Rig;

beforeEach(() => {
  h = rig();
});

afterEach(() => {
  h.stop();
});

describe('种子瓶 · 取信顺序', () => {
  it('池子空着的时候捞到种子，来源如实写「海边邮局」', () => {
    h.addSeed('a.json', { id: 'seed_a', body: '海边邮局的第一封信。' });

    const me = h.token('me');
    const caught = h.catchAs(me);
    expect(caught.empty).toBe(false);
    if (caught.empty) return;

    // §13.6 #11：来源必须写明，不能伪装成某个人类，也不能被化成「一位陌生人」
    expect(caught.from).toBe('海边邮局');
    expect(caught.seed).toBe(true);

    const letter = h.api.handle({ method: 'GET', path: `/letter/${caught.letterId}`, token: me, ip: '1.1.1.1' });
    expect(letter.status).toBe(200);
    expect((letter.body as LetterRes).body).toContain('第一封信');
  });

  it('有真人信时永远先给真人信，种子不挤掉它', () => {
    h.addSeed('a.json', { id: 'seed_a', body: '海边邮局的信。' });
    const author = h.token('author');
    h.api.handle({ method: 'POST', path: '/throw', token: author, ip: '9.9.9.9', body: { body: '真人写的信。' } });

    const caught = h.catchAs(h.token('reader'));
    expect(caught.empty).toBe(false);
    if (caught.empty) return;
    expect(caught.seed).toBeUndefined();
    expect(caught.from).not.toBe(SEED_FROM);
  });

  it('真人信和种子都没有，才说海上很安静', () => {
    const caught = h.catchAs(h.token('me'));
    expect(caught.empty).toBe(true);
    expect(caught.empty === true && caught.reason).toBe('quiet');
  });
});

describe('种子瓶 · 去重与上限', () => {
  it('同一个人不会第二次捞到同一封', () => {
    h.addSeed('a.json', { id: 'seed_a', body: '只有这一封。' });
    h.addSeed('b.json', { id: 'seed_b', body: '还有这一封。' });

    const me = h.token('me');
    const first = h.catchAs(me);
    expect(first.empty).toBe(false);
    if (first.empty) return;
    const firstId = first.letterId;

    // 放回海里再捞：只能是另一封
    h.api.handle({ method: 'POST', path: '/dismiss', token: me, ip: '1.1.1.1', body: { letterId: firstId } });
    const second = h.catchAs(me);
    expect(second.empty).toBe(false);
    if (second.empty) return;
    expect(second.letterId).not.toBe(firstId);
  });

  it('捞满 2 封之后不再给种子', () => {
    h.addSeed('a.json', { id: 'seed_a', body: '第一封。' });
    h.addSeed('b.json', { id: 'seed_b', body: '第二封。' });
    h.addSeed('c.json', { id: 'seed_c', body: '第三封。' });

    const me = h.token('me');
    for (let round = 0; round < 2; round++) {
      const caught = h.catchAs(me);
      expect(caught.empty).toBe(false);
      if (caught.empty) return;
      expect(caught.seed).toBe(true);
      h.api.handle({ method: 'POST', path: '/dismiss', token: me, ip: '1.1.1.1', body: { letterId: caught.letterId } });
    }

    // 第三封还在库里，但这个人已经到上限了
    const third = h.catchAs(me);
    expect(third.empty).toBe(true);
    expect(third.empty === true && third.reason).toBe('quiet');
  });

  it('同一封种子可以被不同的人捞到（不是全局一次性）', () => {
    h.addSeed('a.json', { id: 'seed_a', body: '所有人都能捡到这一封。' });

    const first = h.catchAs(h.token('one', '1.1.1.1'));
    const second = h.catchAs(h.token('two', '2.2.2.2'));
    expect(first.empty).toBe(false);
    expect(second.empty).toBe(false);
    if (first.empty || second.empty) return;
    expect(first.letterId).toBe('seed_a');
    expect(second.letterId).toBe('seed_a');
  });

  it('种子消耗捞取配额，不做特例', () => {
    h.addSeed('a.json', { id: 'seed_a', body: '第一封。' });
    const me = h.token('me');

    const before = h.api.handle({ method: 'GET', path: '/quota', token: me, ip: '1.1.1.1' });
    const caught = h.catchAs(me);
    expect(caught.empty).toBe(false);
    if (caught.empty) return;

    expect(caught.quota.catches_left).toBe((before.body as { catches_left: number }).catches_left - 1);
  });
});

describe('种子瓶 · 不回信', () => {
  it('回信被拒，并且说得清为什么', () => {
    h.addSeed('a.json', { id: 'seed_a', body: '我们不收信。' });
    const me = h.token('me');
    const caught = h.catchAs(me);
    if (caught.empty) throw new Error('应该捞到种子');

    const res = h.api.handle({
      method: 'POST',
      path: '/reply',
      token: me,
      ip: '1.1.1.1',
      body: { letterId: caught.letterId, body: '我还是想回一句。' },
    });
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toBe('seed_no_reply');
  });

  it('收好不会裂也不会沉：throws 恒为 0', () => {
    h.addSeed('a.json', { id: 'seed_a', body: '这封信没有裂缝。' });

    // 每人对每封只能捞一次，所以用六个人轮流捞同一封——它被「收好」六次也不该裂
    for (let round = 1; round <= 6; round++) {
      const me = h.token(`reader-${round}`, `10.0.0.${round}`);
      const caught = h.catchAs(me);
      if (caught.empty) throw new Error(`第 ${round} 次应该捞到`);
      expect(caught.letterId).toBe('seed_a');

      const res = h.api.handle({
        method: 'POST',
        path: '/dismiss',
        token: me,
        ip: '1.1.1.1',
        body: { letterId: caught.letterId },
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, throws: 0, sank: false, seed: true });
    }

    // 第七个人照样能捞到：它没有沉底，也没有被消耗掉
    const last = h.catchAs(h.token('reader-7', '10.0.0.7'));
    expect(last.empty).toBe(false);
  });
});

describe('种子瓶 · 热载（§13.6 #13）', () => {
  it('改文件就热载：generation 变了，startedAt 没变（进程没重启）', () => {
    h.addSeed('a.json', { id: 'seed_a', body: '第一版。' });

    const before = h.api.handle({ method: 'GET', path: '/health', ip: '1.1.1.1' }).body as {
      startedAt: string;
      seeds: { generation: number };
    };
    // `/health` 公网可读，所以它不再报种子条数——那会把大屏的盲化拆掉。
    // 条数去问 SeedStore 自己。
    expect(h.seeds.stats().count).toBe(1);
    const generation = before.seeds.generation;

    h.addSeed('b.json', { id: 'seed_b', body: '第二版加的一封。' });

    const after = h.api.handle({ method: 'GET', path: '/health', ip: '1.1.1.1' }).body as typeof before;
    expect(h.seeds.stats().count).toBe(2);
    expect(after.seeds.generation).toBeGreaterThan(generation);
    // 进程没重启：uptime 的起点没动
    expect(after.startedAt).toBe(before.startedAt);
  });

  it('坏文件跳过并保留上一版，不阻塞其余', () => {
    h.addSeed('good.json', { id: 'seed_good', body: '这一封是好的。' });
    expect(h.seeds.stats().count).toBe(1);

    h.addSeed('bad.json', '{ 这不是 JSON');

    const stats = h.seeds.stats();
    expect(stats.count).toBe(1);
    expect(stats.errors.join(' ')).toContain('JSON 解析失败');
    expect(h.seeds.get('seed_good')).toBeTruthy();
  });

  it('写坏一封已有的种子：旧的那封仍然在，不会凭空消失', () => {
    h.addSeed('a.json', { id: 'seed_a', body: '原来的正文。' });
    expect(h.seeds.get('seed_a')?.body).toBe('原来的正文。');

    h.addSeed('a.json', '{ 写坏了');

    expect(h.seeds.get('seed_a')?.body).toBe('原来的正文。');
  });

  it('没有种子目录也只是没有种子，服务照常起', () => {
    const bare = new SeedStore({ dir: null });
    bare.start();
    expect(bare.stats().count).toBe(0);
    bare.stop();
  });
});

describe('种子瓶 · 格式校验', () => {
  it('id 不合规、正文为空、正文过长，逐条跳过并记日志', () => {
    h.addSeed('x.json', [
      { id: 'ok_one', body: '合格的一封。' },
      { id: '有中文', body: 'id 只能用安全字符。' },
      { id: 'ok_two', body: '   ' },
      { id: 'ok_three', body: '海'.repeat(401) },
    ]);

    expect(h.seeds.list().map((seed) => seed.id)).toEqual(['ok_one']);
    expect(h.seeds.stats().errors.length).toBe(3);
  });

  it('落款与主题截断到上限，不因为长一点就整封丢掉', () => {
    h.addSeed('y.json', {
      id: 'seed_long_meta',
      body: '正文正常。',
      signature: '签'.repeat(60),
      topic: '题'.repeat(40),
    });

    const seed = h.seeds.get('seed_long_meta');
    expect(seed).toBeTruthy();
    expect([...(seed?.signature ?? '')].length).toBe(40);
    expect([...(seed?.topic ?? '')].length).toBe(20);
  });

  it('重复 id 只留第一条', () => {
    h.addSeed('a.json', { id: 'same', body: '先来的。' });
    h.addSeed('b.json', { id: 'same', body: '后来的。' });

    expect(h.seeds.list()).toHaveLength(1);
    expect(h.seeds.get('same')?.body).toBe('先来的。');
  });
});

describe('种子瓶 · 海啸之后', () => {
  it('重启后正文从文件回来，但见过的人不会再见到（状态在表里）', () => {
    h.addSeed('a.json', { id: 'seed_a', body: '海啸也淹不掉这一封。' });

    const dataFile = join(h.dir, '..', 'bottle.json');

    // 第一个进程：见过这一封
    const api1 = createApi(Db.open(dataFile), {
      seeds: h.seeds,
      now: () => h.clock.t,
      timeZone: 'Asia/Shanghai',
      random: () => 0.42,
      ipLimit: 200,
      rules: WIDE,
    });
    const reg1 = api1.handle({ method: 'POST', path: '/register', ip: '1.1.1.1', body: { hash: sha256('me') } });
    const token1 = (reg1.body as { token: string }).token;
    const caught1 = api1.handle({ method: 'POST', path: '/catch', token: token1, ip: '1.1.1.1', body: {} });
    expect((caught1.body as CatchRes).empty).toBe(false);

    // 第二个进程：同一个数据文件，同一个种子目录
    const api2 = createApi(Db.open(dataFile), {
      seeds: h.seeds,
      now: () => h.clock.t,
      timeZone: 'Asia/Shanghai',
      random: () => 0.42,
      ipLimit: 200,
      rules: WIDE,
    });
    const caught2 = api2.handle({ method: 'POST', path: '/catch', token: token1, ip: '1.1.1.1', body: {} });
    expect((caught2.body as CatchRes).empty).toBe(true);
    // 正文还在文件里（海啸淹不掉）
    expect(h.seeds.get('seed_a')?.body).toContain('海啸');
  });
});
