/**
 * 系统邮件通道（海边邮局，独立于捞瓶子）。
 *
 * 要钉住的四条：
 *   1. **不占捞取额度** —— 领系统邮件不该减少 `catches_left`
 *   2. **每天限 N 封**，过夜重置
 *   3. **两层去重**：我领过的不再给我；全服去重时谁领过都不再给
 *   4. **正文仍然走 `/letter/{id}`** —— 「正文不经过模型」在两条通道上一致
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApi, sha256, type Api } from '../server/app.ts';
import { Db } from '../server/db.ts';
import { SeedStore } from '../server/seeds.ts';
import type { Tuning, TuningReader } from '../server/tuning.ts';
import { SEED_FROM } from '../shared/text.ts';
import type { CatchRes, LetterRes, MailTakeRes, Quota } from '../shared/contract.ts';

const WIDE = { sendBase: 50, sendCap: 50, catchBase: 50, catchCap: 50, poolDivisor: 5 };
const HOUR = 3_600_000;

interface Rig {
  api: Api;
  db: Db;
  clock: { t: number };
  tuning: Tuning;
  token(who: string, ip?: string): string;
  take(t: string): MailTakeRes;
  catchAs(t: string): CatchRes;
  quota(t: string): Quota;
  stop(): void;
}

function rig(opts: { seedChannel?: 'mail' | 'catch'; tuning?: Partial<Tuning>; seedCount?: number } = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), 'bottle-mail-'));
  const dir = join(root, 'seeds');
  mkdirSync(dir, { recursive: true });

  const count = opts.seedCount ?? 5;
  for (let i = 1; i <= count; i++) {
    const id = `seed-${i}`;
    writeFileSync(
      join(dir, `${String(i).padStart(3, '0')}.json`),
      JSON.stringify({ id, topic: `题 ${i}`, signature: `署 ${i}`, body: `这是第 ${i} 封。` }),
      'utf8',
    );
  }

  const seeds = new SeedStore({ dir });
  seeds.start();

  const tuning: Tuning = {
    seedsPerDay: 2,
    seedsGlobalOnce: true,
    seedsEnabled: true,
    sendBase: 2,
    sendCap: 5,
    catchBase: 2,
    catchCap: 10,
    poolDivisor: 5,
    replyCap: 3,
    maxThrows: 8,
    ipLimit: 5,
    ipWindowMin: 60,
    ...opts.tuning,
  };
  const reader: TuningReader = { current: () => tuning };

  const db = Db.open(null);
  const clock = { t: Date.parse('2026-10-27T10:00:00+08:00') };
  let tokens = 0;
  const api = createApi(db, {
    seeds,
    seedChannel: opts.seedChannel ?? 'mail',
    tuning: reader,
    now: () => clock.t,
    timeZone: 'Asia/Shanghai',
    random: () => 0.42,
    newToken: () => `tok_${++tokens}`,
    ipLimit: 500,
    rules: WIDE,
    startedAt: clock.t,
  });

  const token = (who: string, ip = '1.1.1.1'): string => {
    const res = api.handle({ method: 'POST', path: '/register', ip, body: { hash: sha256(who) } });
    expect(res.status).toBe(200);
    return (res.body as { token: string }).token;
  };

  const take = (t: string): MailTakeRes => {
    const res = api.handle({ method: 'POST', path: '/mail/take', token: t, ip: '1.1.1.1', body: {} });
    expect(res.status).toBe(200);
    return res.body as MailTakeRes;
  };

  const catchAs = (t: string): CatchRes => {
    const res = api.handle({ method: 'POST', path: '/catch', token: t, ip: '1.1.1.1', body: {} });
    expect(res.status).toBe(200);
    return res.body as CatchRes;
  };

  const quota = (t: string): Quota => {
    const res = api.handle({ method: 'GET', path: '/quota', token: t, ip: '1.1.1.1' });
    return res.body as Quota;
  };

  return {
    api,
    db,
    clock,
    tuning,
    token,
    take,
    catchAs,
    quota,
    stop() {
      seeds.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('系统邮件：不占捞取额度', () => {
  it('领一封系统邮件，catches_left 一动不动', () => {
    const h = rig();
    try {
      const me = h.token('me');
      const before = h.quota(me).catches_left;
      const res = h.take(me);
      expect(res.empty).toBe(false);
      const after = h.quota(me).catches_left;
      expect(after).toBe(before);
    } finally {
      h.stop();
    }
  });

  it('连领三封（含超限那次），额度仍然不变', () => {
    const h = rig({ tuning: { seedsPerDay: 5 } });
    try {
      const me = h.token('me');
      const before = h.quota(me).catches_left;
      for (let i = 0; i < 3; i++) h.take(me);
      expect(h.quota(me).catches_left).toBe(before);
    } finally {
      h.stop();
    }
  });
});

describe('系统邮件：每天上限与过夜重置', () => {
  it('每天最多 N 封，第 N+1 次回 quota', () => {
    const h = rig({ tuning: { seedsPerDay: 2 }, seedCount: 10 });
    try {
      const me = h.token('me');
      expect(h.take(me).empty).toBe(false);
      expect(h.take(me).empty).toBe(false);
      const third = h.take(me);
      expect(third.empty).toBe(true);
      if (third.empty) expect(third.reason).toBe('quota');
    } finally {
      h.stop();
    }
  });

  it('过了午夜就重新有额度', () => {
    const h = rig({ tuning: { seedsPerDay: 1 }, seedCount: 10 });
    try {
      const me = h.token('me');
      expect(h.take(me).empty).toBe(false);
      expect(h.take(me).empty).toBe(true);

      h.clock.t += 24 * HOUR;
      expect(h.take(me).empty).toBe(false);
    } finally {
      h.stop();
    }
  });
});

describe('系统邮件：两层去重', () => {
  it('同一个人不会两次领到同一封', () => {
    const h = rig({ tuning: { seedsPerDay: 20 }, seedCount: 6 });
    try {
      const me = h.token('me');
      const got: string[] = [];
      for (let i = 0; i < 6; i++) {
        const res = h.take(me);
        if (res.empty) break;
        got.push(res.letterId);
      }
      expect(got).toHaveLength(6);
      expect(new Set(got).size).toBe(6);
    } finally {
      h.stop();
    }
  });

  it('全服去重开着：同一封只能被一个人领到', () => {
    const h = rig({ tuning: { seedsPerDay: 5, seedsGlobalOnce: true }, seedCount: 1 });
    try {
      const a = h.token('a', '1.1.1.1');
      const b = h.token('b', '2.2.2.2');
      expect(h.take(a).empty).toBe(false);
      const second = h.take(b);
      expect(second.empty).toBe(true);
      if (second.empty) expect(second.reason).toBe('exhausted');
    } finally {
      h.stop();
    }
  });

  it('全服去重关掉：每个人都能领到同一封', () => {
    const h = rig({ tuning: { seedsPerDay: 5, seedsGlobalOnce: false }, seedCount: 1 });
    try {
      const a = h.token('a', '1.1.1.1');
      const b = h.token('b', '2.2.2.2');
      const one = h.take(a);
      const two = h.take(b);
      expect(one.empty).toBe(false);
      expect(two.empty).toBe(false);
      if (!one.empty && !two.empty) expect(one.letterId).toBe(two.letterId);
    } finally {
      h.stop();
    }
  });

  it('两个客户端互不重叠：4 封被两个人各领 2 封，全是不同的信', () => {
    const h = rig({ tuning: { seedsPerDay: 2, seedsGlobalOnce: true }, seedCount: 10 });
    try {
      const a = h.token('a', '1.1.1.1');
      const b = h.token('b', '2.2.2.2');
      const ids: string[] = [];
      for (const who of [a, b]) {
        for (let i = 0; i < 2; i++) {
          const res = h.take(who);
          if (!res.empty) ids.push(res.letterId);
        }
      }
      expect(ids).toHaveLength(4);
      expect(new Set(ids).size).toBe(4);
    } finally {
      h.stop();
    }
  });
});

describe('系统邮件：边界', () => {
  it('库领光了回 exhausted', () => {
    const h = rig({ tuning: { seedsPerDay: 5 }, seedCount: 1 });
    try {
      const me = h.token('me');
      expect(h.take(me).empty).toBe(false);
      const second = h.take(me);
      expect(second.empty).toBe(true);
      if (second.empty) expect(second.reason).toBe('exhausted');
    } finally {
      h.stop();
    }
  });

  it('总开关关掉就回 disabled', () => {
    const h = rig({ tuning: { seedsEnabled: false }, seedCount: 5 });
    try {
      const me = h.token('me');
      const res = h.take(me);
      expect(res.empty).toBe(true);
      if (res.empty) expect(res.reason).toBe('disabled');
    } finally {
      h.stop();
    }
  });

  it('没有 token 就是 401，不是系统邮件', () => {
    const h = rig();
    try {
      const res = h.api.handle({ method: 'POST', path: '/mail/take', ip: '1.1.1.1', body: {} });
      expect(res.status).toBe(401);
    } finally {
      h.stop();
    }
  });

  it('正文仍然只在 /letter/{id}：先领后取，来源固定是海边邮局', () => {
    const h = rig({ tuning: { seedsPerDay: 5 }, seedCount: 2 });
    try {
      const me = h.token('me');
      const res = h.take(me);
      expect(res.empty).toBe(false);
      if (res.empty) return;

      // 领到的回执里没有正文
      expect(JSON.stringify(res)).not.toContain('这是第');
      expect(res.from).toBe(SEED_FROM);

      const letter = h.api.handle({ method: 'GET', path: `/letter/${res.letterId}`, token: me, ip: '1.1.1.1' });
      expect(letter.status).toBe(200);
      const body = letter.body as LetterRes;
      expect(body.body).toContain('这是第');
      expect(body.from).toBe(SEED_FROM);
      expect(body.seed).toBe(true);
    } finally {
      h.stop();
    }
  });

  it('没领过的种子取不到正文（防止猜 id）', () => {
    const h = rig({ tuning: { seedsPerDay: 5 }, seedCount: 2 });
    try {
      const me = h.token('me');
      const res = h.api.handle({ method: 'GET', path: '/letter/seed-1', token: me, ip: '1.1.1.1' });
      expect(res.status).toBe(404);
    } finally {
      h.stop();
    }
  });
});

describe('系统邮件：与捞瓶子分开', () => {
  it('mail 通道下，池子空了 /catch 直接空手，不再发种子', () => {
    const h = rig({ seedChannel: 'mail', seedCount: 5 });
    try {
      const me = h.token('me');
      const res = h.catchAs(me);
      expect(res.empty).toBe(true);
      if (res.empty) expect(res.reason).toBe('quiet');
    } finally {
      h.stop();
    }
  });

  it('catch 通道（旧行为）仍然由种子兜底', () => {
    const h = rig({ seedChannel: 'catch', seedCount: 5 });
    try {
      const me = h.token('me');
      const res = h.catchAs(me);
      expect(res.empty).toBe(false);
      if (!res.empty) expect(res.seed).toBe(true);
    } finally {
      h.stop();
    }
  });
});
