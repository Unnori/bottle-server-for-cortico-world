import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi, sha256, type Api, type ApiResponse } from '../server/app.ts';
import { Db } from '../server/db.ts';
import { DEFAULT_RULES, type QuotaRules } from '../server/quota.ts';
import type { CatchRes, MailboxItem, Quota, RegisterRes } from '../shared/contract.ts';

interface Harness {
  api: Api;
  db: Db;
  clock: { t: number };
  call(method: 'GET' | 'POST', path: string, token?: string, body?: unknown, ip?: string): ApiResponse;
  register(seed: string, ip?: string): RegisterRes;
}

/** 给大部分用例一份宽额度，别让测试在次数上绊倒；额度公式另有专门的用例。 */
const WIDE: QuotaRules = { sendBase: 50, sendCap: 50, catchBase: 50, catchCap: 50, poolDivisor: 5 };

function setup(opts: { file?: string | null; rules?: QuotaRules; ipLimit?: number } = {}): Harness {
  const db = Db.open(opts.file ?? null);
  const clock = { t: Date.parse('2026-10-27T00:10:00+08:00') };
  let tokens = 0;
  let seed = 7;
  const random = (): number => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const api = createApi(db, {
    now: () => clock.t,
    timeZone: 'Asia/Shanghai',
    random,
    newToken: () => `tok_${++tokens}`,
    rules: opts.rules ?? WIDE,
    ipLimit: opts.ipLimit ?? 20,
  });

  const call: Harness['call'] = (method, path, token, body, ip = '1.1.1.1') =>
    api.handle({ method, path, token, ip, body });

  const register: Harness['register'] = (seedText, ip = '1.1.1.1') => {
    const res = call('POST', '/register', undefined, { hash: sha256(seedText) }, ip);
    expect(res.status).toBe(200);
    return res.body as RegisterRes;
  };

  return { api, db, clock, call, register };
}

function catchOf(res: ApiResponse): CatchRes {
  expect(res.status).toBe(200);
  return res.body as CatchRes;
}

describe('服务端 · 注册与身份', () => {
  it('第一次注册就签发 token 与化名，不用申请', () => {
    const h = setup();
    const res = h.register('machine-a');
    expect(res.token).toMatch(/^tok_/);
    expect(res.pseudonym).toMatch(/#\d{4}$/);
    expect(h.db.bots).toHaveLength(1);
  });

  it('同一台机器再注册：还是那个人，换一张船票，旧 token 立刻失效', () => {
    const h = setup();
    const first = h.register('machine-a');
    const second = h.register('machine-a');

    expect(second.pseudonym).toBe(first.pseudonym);
    expect(second.token).not.toBe(first.token);
    expect(h.call('GET', '/quota', first.token).status).toBe(401);
    expect(h.call('GET', '/quota', second.token).status).toBe(200);
  });

  it('同 IP 每小时最多开 3 个新号', () => {
    const h = setup({ ipLimit: 3 });
    h.register('a', '2.2.2.2');
    h.register('b', '2.2.2.2');
    h.register('c', '2.2.2.2');
    const fourth = h.call('POST', '/register', undefined, { hash: sha256('d') }, '2.2.2.2');
    expect(fourth.status).toBe(429);
    expect((fourth.body as { error: string }).error).toBe('rate_limited');
  });
});

describe('服务端 · 寄与捞', () => {
  it('寄出的信浮在池子里，捞不到自己写的', () => {
    const h = setup();
    const a = h.register('a');
    const letterId = h.call('POST', '/throw', a.token, { body: '今天风很大。' }).body as { letterId: string };
    expect(letterId.letterId).toMatch(/^l_/);

    const own = catchOf(h.call('POST', '/catch', a.token));
    expect(own.empty).toBe(true);
    expect(own.empty === true && own.reason).toBe('quiet');
  });

  it('捞到的回执里没有正文，只有化名和额度', () => {
    const h = setup();
    const a = h.register('a');
    const b = h.register('b');
    h.call('POST', '/throw', a.token, { body: '捡到一只很白的贝壳。' });

    const res = h.call('POST', '/catch', b.token);
    const caught = catchOf(res);
    expect(caught.empty).toBe(false);
    if (caught.empty) return;
    expect(caught.from).toBe(a.pseudonym);
    expect(caught.quota.catches_left).toBe(49);
    expect(JSON.stringify(caught)).not.toContain('贝壳');
    expect((caught as unknown as { body?: string }).body).toBeUndefined();
  });

  it('正文只能从 /letter 取，而且只给捞到的人', () => {
    const h = setup();
    const a = h.register('a');
    const b = h.register('b');
    const c = h.register('c');
    h.call('POST', '/throw', a.token, { body: '写信的时候窗外的云很低。' });
    const caught = catchOf(h.call('POST', '/catch', b.token));
    if (caught.empty) throw new Error('应该捞到');

    const mine = h.call('GET', `/letter/${caught.letterId}`, b.token);
    expect(mine.status).toBe(200);
    expect((mine.body as { body: string }).body).toContain('云很低');

    expect(h.call('GET', `/letter/${caught.letterId}`, c.token).status).toBe(404);
    expect(h.call('GET', `/letter/${caught.letterId}`, a.token).status).toBe(404);
  });

  it('手里压着一封时不能再捞', () => {
    const h = setup();
    const a = h.register('a');
    const b = h.register('b');
    const c = h.register('c');
    h.call('POST', '/throw', a.token, { body: '第一封' });
    h.call('POST', '/throw', c.token, { body: '第二封' });
    catchOf(h.call('POST', '/catch', b.token));

    const again = catchOf(h.call('POST', '/catch', b.token));
    expect(again.empty).toBe(true);
    expect(again.empty === true && again.reason).toBe('holding');
  });
});

describe('服务端 · 回信与信箱', () => {
  it('一封信只能回一次，回信落进作者的信箱', () => {
    const h = setup();
    const a = h.register('a');
    const b = h.register('b');
    h.call('POST', '/throw', a.token, { body: '你那边也下雨吗' });
    const caught = catchOf(h.call('POST', '/catch', b.token));
    if (caught.empty) throw new Error('应该捞到');

    const first = h.call('POST', '/reply', b.token, { letterId: caught.letterId, body: '下了，很小。' });
    expect(first.status).toBe(200);
    const second = h.call('POST', '/reply', b.token, { letterId: caught.letterId, body: '再回一句' });
    expect(second.status).toBe(409);

    const mailbox = h.call('GET', '/mailbox', a.token).body as MailboxItem[];
    expect(mailbox).toHaveLength(1);
    expect(mailbox[0]!.body).toBe('下了，很小。');
    expect(mailbox[0]!.from).toBe(b.pseudonym);

    // 回过就不再出现在池子里
    const again = catchOf(h.call('POST', '/catch', h.register('c').token));
    expect(again.empty).toBe(true);
  });

  it('扔回海里：瓶子回海，可以再被捞到，并记一次', () => {
    const h = setup();
    const a = h.register('a');
    const b = h.register('b');
    h.call('POST', '/throw', a.token, { body: '海水是凉的。' });
    const caught = catchOf(h.call('POST', '/catch', b.token));
    if (caught.empty) throw new Error('应该捞到');

    const res = h.call('POST', '/dismiss', b.token, { letterId: caught.letterId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, throws: 1, sank: false });

    const again = catchOf(h.call('POST', '/catch', b.token));
    expect(again.empty).toBe(false);
  });

  it('72 小时没处理就自己回海，不算扔回海里', () => {
    const h = setup();
    const a = h.register('a');
    const b = h.register('b');
    h.call('POST', '/throw', a.token, { body: '慢慢漂。' });
    const caught = catchOf(h.call('POST', '/catch', b.token));
    if (caught.empty) throw new Error('应该捞到');

    h.clock.t += 73 * 3_600_000;
    const again = catchOf(h.call('POST', '/catch', h.register('c').token));
    expect(again.empty).toBe(false);
    if (again.empty) return;
    expect(again.letterId).toBe(caught.letterId);
    expect(h.db.letters[0]!.throws).toBe(0);
  });

  it('扔回海里五次就裂开沉底，不再出现', () => {
    const h = setup();
    const a = h.register('a');
    const b = h.register('b');
    h.call('POST', '/throw', a.token, { body: '第五次之后就别再出现了。' });

    for (let round = 1; round <= 5; round++) {
      const caught = catchOf(h.call('POST', '/catch', b.token));
      expect(caught.empty).toBe(false);
      if (caught.empty) return;

      const res = h.call('POST', '/dismiss', b.token, { letterId: caught.letterId });
      expect(res.body).toMatchObject({ throws: round, sank: round === 5 });
    }

    const after = catchOf(h.call('POST', '/catch', b.token));
    expect(after.empty).toBe(true);
    expect(h.db.letters[0]!.state).toBe('archived');
    expect(h.db.letters[0]!.throws).toBe(5);
    expect(h.db.letters[0]!.deliveredCount).toBe(5);
  });
});

describe('服务端 · 配额', () => {
  it('默认公式：新用户 2 封可寄，池子 1 封时 2 次可捞', () => {
    const h = setup({ rules: DEFAULT_RULES });
    const a = h.register('a');
    const b = h.register('b');
    h.call('POST', '/throw', a.token, { body: '一封' });

    const quota = h.call('GET', '/quota', b.token).body as Quota;
    expect(quota.bottles_left).toBe(2);
    expect(quota.catches_left).toBe(2);
  });

  it('回别人的信，才多一个寄信额度', () => {
    const h = setup({ rules: { ...DEFAULT_RULES, catchBase: 20, catchCap: 20 } });
    const a = h.register('a');
    const b = h.register('b');
    h.call('POST', '/throw', a.token, { body: '第一封' });
    h.call('POST', '/throw', a.token, { body: '第二封' });

    let quota = h.call('GET', '/quota', a.token).body as Quota;
    expect(quota.bottles_left).toBe(0);

    // 别人写了一封，a 捞起来回了 —— 回信换寄信
    h.call('POST', '/throw', b.token, { body: '你那边也下雨吗' });
    const caught = catchOf(h.call('POST', '/catch', a.token));
    if (caught.empty) throw new Error('应该捞到');
    h.call('POST', '/reply', a.token, { letterId: caught.letterId, body: '下了，很小。' });

    quota = h.call('GET', '/quota', a.token).body as Quota;
    expect(quota.bottles_left).toBe(1);
  });

  it('寄满 5 封之后，第 6 封被拒（no_bottle）', () => {
    const h = setup({ rules: { ...DEFAULT_RULES, catchBase: 20, catchCap: 20 } });
    const a = h.register('a');
    h.call('POST', '/throw', a.token, { body: '第一封' });
    h.call('POST', '/throw', a.token, { body: '第二封' });

    // 每回一封别人的信，寄信上限 +1，直到 5
    for (let round = 0; round < 3; round++) {
      const peer = h.register(`peer-${round}`);
      h.call('POST', '/throw', peer.token, { body: `别人的第 ${round} 封` });

      const caught = catchOf(h.call('POST', '/catch', a.token));
      if (caught.empty) throw new Error(`第 ${round + 1} 次应该捞到`);
      h.call('POST', '/reply', a.token, { letterId: caught.letterId, body: '收到了。' });

      const thrown = h.call('POST', '/throw', a.token, { body: `又写了一封 ${round}` });
      expect(thrown.status).toBe(200);
    }

    const quota = h.call('GET', '/quota', a.token).body as Quota;
    expect(quota.bottles_left).toBe(0);

    const sixth = h.call('POST', '/throw', a.token, { body: '第六封' });
    expect(sixth.status).toBe(429);
    expect((sixth.body as { error: string }).error).toBe('no_bottle');
  });
});

describe('服务端 · 海啸', () => {
  it('重启之后旧信消失，但不用重新注册', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bottle-server-'));
    const file = join(dir, 'bottle.json');
    try {
      const first = setup({ file });
      const a = first.register('machine-a');
      first.call('POST', '/throw', a.token, { body: '这一封活不过重启。' });
      expect(first.db.letters).toHaveLength(1);

      // 新进程：同一个数据文件
      const second = setup({ file });
      expect(second.db.bots).toHaveLength(1);
      expect(second.db.letters[0]!.body).toBe('');
      expect(second.db.letters[0]!.state).toBe('archived');

      // token 还在，身份没丢
      const quota = second.call('GET', '/quota', a.token);
      expect(quota.status).toBe(200);
      expect(second.call('POST', '/catch', a.token).status).toBe(200);

      const b = second.register('machine-b');
      const caught = catchOf(second.call('POST', '/catch', b.token));
      expect(caught.empty).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
