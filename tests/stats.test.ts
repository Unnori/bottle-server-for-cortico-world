/**
 * 统计与盲化。
 *
 * 这里最重要的两条不是算术，而是**边界**：
 *   1. `Db.readRaw()` 绝不能像 `Db.open()` 那样把 floating 判成海啸并写盘
 *   2. 给大屏的那份公开数字里，不能出现任何真数
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  blindAtSea,
  blindEverSeen,
  blindResidents,
  bucketCount,
  EMPTY_LEDGER,
  normalizeLedger,
  readLedgerFile,
  type Ledger,
} from '../server/blind.ts';
import { createApi, sha256 } from '../server/app.ts';
import { Db, type BotRow, type LetterRow } from '../server/db.ts';
import { applyBlinding, collectRealStats } from '../server/stats.ts';

const AT = Date.UTC(2026, 9, 29, 4, 0, 0);
const TODAY = '2026-10-29';

const LEDGER: Ledger = {
  npcCount: 100,
  residentLettersTotal: 1000,
  islands: 6,
  harbors: 3,
  lighthouses: 5,
  postmen: 4,
  coastlineKm: 212,
  tideLetterFactor: 0.3,
};

function bot(patch: Partial<BotRow> = {}): BotRow {
  return {
    tokenHash: Math.random().toString(16).slice(2),
    clientHash: Math.random().toString(16).slice(2),
    pseudonym: '海盐大福#4821',
    createdAt: AT,
    lastResetDate: TODAY,
    bottlesUsed: 0,
    catchesUsed: 0,
    repliesMade: 0,
    mailTaken: 0,
    ...patch,
  };
}

function letter(patch: Partial<LetterRow> = {}): LetterRow {
  return {
    id: Math.random().toString(16).slice(2),
    authorHash: 'author',
    body: '',
    createdAt: AT,
    state: 'floating',
    catcherHash: null,
    caughtAt: null,
    replyWindowUntil: null,
    deliveredCount: 0,
    throws: 0,
    ...patch,
  };
}

describe('台账', () => {
  it('缺字段补 0，越界夹回范围，不抛错', () => {
    expect(normalizeLedger(null)).toEqual(EMPTY_LEDGER);
    expect(normalizeLedger({ npcCount: -5, tideLetterFactor: 9 }).npcCount).toBe(0);
    expect(normalizeLedger({ tideLetterFactor: 9 }).tideLetterFactor).toBe(1);
    expect(normalizeLedger({ islands: '6' }).islands).toBe(6);
  });

  it('文件不存在或写坏了，就当没有世界量（完全不放水）', () => {
    expect(readLedgerFile(null)).toEqual(EMPTY_LEDGER);
    expect(readLedgerFile('/nope/never/here.json')).toEqual(EMPTY_LEDGER);
  });
});

describe('盲化', () => {
  it('居民 = 真实玩家 + 具名人物', () => {
    expect(blindResidents(7, LEDGER)).toBe(107);
  });

  it('海上漂着 = 真实 floating + 居民写过的信，并随潮汐摆动', () => {
    const high = blindAtSea(3, LEDGER, 100); // 满潮
    const low = blindAtSea(3, LEDGER, 0); // 干潮
    expect(low).toBeGreaterThan(high);
    // 潮位 50 时摆动系数正好是 1
    expect(blindAtSea(3, LEDGER, 50)).toBe(1003);
  });

  it('台账里没有居民信件时完全不放水', () => {
    const empty = { ...EMPTY_LEDGER, npcCount: 0, residentLettersTotal: 0 };
    expect(blindResidents(7, empty)).toBe(7);
    expect(blindAtSea(3, empty, 50)).toBe(3);
    expect(blindEverSeen(5, empty)).toBe(5);
  });

  it('条数压成区间，不给精确值', () => {
    expect(bucketCount(0)).toBe('还没有');
    expect(bucketCount(2)).toBe('几封');
    expect(bucketCount(10)).toBe('十来封');
    expect(bucketCount(500)).toBe('很多');
  });
});

describe('真实统计', () => {
  it('按状态与死法分别计数', () => {
    const db = Db.open(null);
    db.bots.push(bot({ lastSeenAt: AT }), bot({ lastSeenAt: AT - 86_400_000 * 3, lastResetDate: '2026-10-26' }));
    db.letters.push(
      letter({ state: 'floating', deliveredCount: 2 }),
      letter({ state: 'caught' }),
      letter({ state: 'replied' }),
      letter({ state: 'archived', archivedReason: 'sunk' }),
      letter({ state: 'archived', archivedReason: 'tsunami' }),
      letter({ state: 'archived' }), // 老数据，没有死法
    );
    db.replies.push({ id: 'r1', letterId: 'x', body: '', createdAt: AT });
    db.tsunami = { count: 1, lastAt: AT, totalLost: 4, log: [] };

    const real = collectRealStats(db, { dir: 'seeds', count: 90, generation: 1, loadedAt: AT, errors: [] }, {
      timeZone: 'Asia/Hong_Kong',
      today: TODAY,
      at: AT,
    });

    expect(real.botsTotal).toBe(2);
    expect(real.botsActive).toBe(1);
    expect(real.lettersTotal).toBe(6);
    expect(real.floating).toBe(1);
    expect(real.caught).toBe(1);
    expect(real.replied).toBe(1);
    expect(real.sunk).toBe(1);
    expect(real.tsunamiLost).toBe(1);
    expect(real.archivedUnknown).toBe(1);
    expect(real.catchCountTotal).toBe(2);
    expect(real.repliesTotal).toBe(1);
    expect(real.seedsUnclaimed).toBe(90);
    expect(real.tsunamiShatteredTotal).toBe(4);
  });

  it('回信率是个比率，算得出来但永不公开', () => {
    const db = Db.open(null);
    db.letters.push(letter(), letter(), letter(), letter());
    db.replies.push({ id: 'r1', letterId: 'x', body: '', createdAt: AT });
    const real = collectRealStats(db, null, { timeZone: 'Asia/Hong_Kong', today: TODAY, at: AT });
    expect(real.replyRate).toBe(0.25);
  });
});

describe('公开那份里不能有真数', () => {
  it('居民 / 海上漂着 / 出现过的信，全都被台账顶开了', () => {
    const db = Db.open(null);
    for (let i = 0; i < 7; i++) db.bots.push(bot());
    for (let i = 0; i < 5; i++) db.letters.push(letter());
    db.replies.push({ id: 'r1', letterId: 'x', body: '', createdAt: AT });

    const real = collectRealStats(db, null, { timeZone: 'Asia/Hong_Kong', today: TODAY, at: AT });
    const pub = applyBlinding(real, LEDGER, AT);

    expect(real.botsTotal).toBe(7);
    expect(real.floating).toBe(5);
    expect(real.lettersTotal).toBe(5);

    expect(pub.people.residents).toBe(107);
    expect(pub.people.residents).not.toBe(real.botsTotal);
    expect(pub.letters.everSeen).toBe(1005);
    expect(pub.letters.atSea).toBeGreaterThan(1000);
    // 单点值只能给区间
    expect(pub.letters.withEcho).toBe('几封');
    // 台账里的世界量本身绝不出现在公开结构里
    expect(JSON.stringify(pub)).not.toContain('npcCount');
    expect(JSON.stringify(pub)).not.toContain('residentLettersTotal');
  });

  it('公开结构里不含比率与种子明细', () => {
    const real = collectRealStats(Db.open(null), null, {
      timeZone: 'Asia/Hong_Kong',
      today: TODAY,
      at: AT,
    });
    const pub = applyBlinding(real, LEDGER, AT) as unknown as Record<string, unknown>;
    const keys = Object.keys(pub);
    expect(keys).toEqual(['asOf', 'sea', 'world', 'people', 'letters', 'waves']);
    const body = JSON.stringify(pub);
    expect(body).not.toContain('replyRate');
    expect(body).not.toContain('seedsUnclaimed');
    expect(body).not.toContain('botsActive');
  });
});

describe('只读打开：统计绝不能动手', () => {
  it('readRaw 不会把 floating 判成海啸，也不会改文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bottle-raw-'));
    const file = join(dir, 'bottle.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        bots: [bot()],
        letters: [letter({ state: 'floating' }), letter({ state: 'caught' })],
        replies: [],
        seedsUsed: [],
      }),
      'utf8',
    );
    const before = readFileSync(file, 'utf8');

    const db = Db.readRaw(file);

    expect(db.letters.map((l) => l.state)).toEqual(['floating', 'caught']);
    expect(db.tsunami.count).toBe(0);
    // 文件一个字节都不该变
    expect(readFileSync(file, 'utf8')).toBe(before);

    rmSync(dir, { recursive: true, force: true });
  });

  it('对照：Db.open 会把 floating 归档并立刻写盘（这就是统计不能走它的原因）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bottle-open-'));
    const file = join(dir, 'bottle.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        bots: [],
        letters: [letter({ state: 'floating' })],
        replies: [],
        seedsUsed: [],
      }),
      'utf8',
    );

    const db = Db.open(file);

    expect(db.letters[0]!.state).toBe('archived');
    expect(db.letters[0]!.archivedReason).toBe('tsunami');
    expect(db.tsunami.count).toBe(1);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { letters: Array<{ state: string }> };
    expect(onDisk.letters[0]!.state).toBe('archived');

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('探针与海况这两条公开路线', () => {
  it('/health 不再报种子条数和池子计数', () => {
    const api = createApi(Db.open(null));
    const body = api.handle({ method: 'GET', path: '/health', ip: '1.1.1.1' }).body as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.pool).toBeUndefined();
    const seeds = body.seeds as Record<string, unknown>;
    expect(seeds.count).toBeUndefined();
    expect(seeds.dir).toBeUndefined();
    expect(typeof seeds.generation).toBe('number');
  });

  it('/sea 是公开的，只给世界事实', () => {
    const api = createApi(Db.open(null));
    const res = api.handle({ method: 'GET', path: '/sea', ip: '1.1.1.1' });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body.day).toBeGreaterThanOrEqual(1);
    expect(body.tide.level).toBeGreaterThanOrEqual(0);
    expect(body.waves).toEqual({ count: 0, lastDaysAgo: null, shattered: 0 });
    // 一个和用户有关的字段都没有
    expect(JSON.stringify(body)).not.toContain('resident');
    expect(JSON.stringify(body)).not.toContain('bot');
  });

  it('/sea 里的年轮只给次数、时间与总量，不给运维写的原因', () => {
    const db = Db.open(null);
    db.tsunami = {
      count: 2,
      lastAt: AT,
      totalLost: 9,
      log: [{ at: AT, reason: '上线 v0.2', lost: 9 }],
    };
    // 用固定时钟，别让这条用例随真实时间漂
    const api = createApi(db, { now: () => AT + 5 * 86_400_000 });
    const body = api.handle({ method: 'GET', path: '/sea', ip: '1.1.1.1' }).body as Record<string, any>;
    expect(body.waves.count).toBe(2);
    expect(body.waves.shattered).toBe(9);
    expect(body.waves.lastDaysAgo).toBe(5);
    // 运维自己的话不能漏到公开接口上
    expect(JSON.stringify(body)).not.toContain('上线');
  });

  it('记活跃：鉴权请求会写 lastSeenAt', () => {
    const db = Db.open(null);
    const api = createApi(db, { now: () => AT, timeZone: 'Asia/Hong_Kong' });
    const reg = api.handle({
      method: 'POST',
      path: '/register',
      ip: '1.1.1.1',
      body: { hash: sha256('someone') },
    }).body as { token: string };

    api.handle({ method: 'GET', path: '/quota', token: reg.token, ip: '1.1.1.1' });
    expect(db.bots[0]!.lastSeenAt).toBe(AT);
  });
});
