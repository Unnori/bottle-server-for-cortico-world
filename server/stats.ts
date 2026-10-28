/**
 * 统计：从磁盘算出运营要看的数，然后分两路输出。
 *
 *   · `data/stats.jsonl`   —— **真数**，每天一行，只留在服务器上，运维自己看
 *   · `public/stats.json`  —— **盲化后**的数，给大屏看：真实值 + 世界台账里的量
 *
 * 两路必须分开写、分开存。公开文件里只要漏一个真数，整套盲化就白做了。
 *
 * 还有一条铁律：**统计只能看见，不能动手。** 所以调用方必须用 `Db.readRaw()`，
 * 绝不能用 `Db.open()` —— 后者会把还漂着的信判定成海啸并写盘。
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { blindAtSea, blindEverSeen, blindResidents, bucketCount, type Ledger } from './blind.ts';
import type { Db } from './db.ts';
import type { SeedStats } from './seeds.ts';
import { seaStateAt, type SeaState } from '../shared/tide.ts';

const DAY = 86_400_000;

/** 只留在服务器上的真实数字。口径对齐设计稿 §14.3。 */
export interface RealStats {
  /** YYYY-MM-DD（服务器时区）。 */
  date: string;
  at: string;

  // ── 人 ──
  botsTotal: number;
  botsActive: number;
  botsNew: number;
  botsWhoWrote: number;

  // ── 信 ──
  lettersTotal: number;
  floating: number;
  caught: number;
  replied: number;
  sunk: number;
  tsunamiLost: number;
  /** 说不上死法的 archived（老数据没有 archivedReason）。 */
  archivedUnknown: number;
  thrownToday: number;
  caughtToday: number;
  repliesToday: number;
  catchCountTotal: number;
  repliesTotal: number;
  /** 回信 / 投入，0–1。**比率类，永不公开。** */
  replyRate: number;
  oldestAtSeaDays: number;

  // ── 种子 ──
  seedsTotal: number;
  seedsClaimed: number;
  seedsUnclaimed: number;
  seedsClaimedToday: number;

  // ── 世界 ──
  tsunamiCount: number;
  tsunamiLastAt: number | null;
  tsunamiShatteredTotal: number;
}

/** 允许出现在 `public/` 里的那一份。 */
export interface PublicStats {
  asOf: string;
  sea: SeaState;
  world: {
    islands: number;
    harbors: number;
    lighthouses: number;
    postmen: number;
    coastlineKm: number;
  };
  /** 「居民」= 真实玩家 + 世界观具名人物。外人要还原真值得先数完所有种子信里的人物。 */
  people: { residents: number };
  letters: {
    /** 海上漂着的瓶子 = 真实 floating + 居民写过的信 × 潮汐摆动。 */
    atSea: number;
    /** 海上出现过的信（累计）= 真实投递 + 居民写过的信。 */
    everSeen: number;
    /** 有回音的信：只给模糊区间 —— 单点值用加法盲化无效，只能降精度。 */
    withEcho: string;
    oldestAtSeaDays: number;
  };
  waves: { count: number; lastDaysAgo: number | null; shattered: number };
}

export interface CollectOptions {
  /** 服务器时区，用来判断「今天」。 */
  timeZone: string;
  /** 今天的日期字符串（YYYY-MM-DD）。 */
  today: string;
  at: number;
}

/** 从磁盘状态算出真实数字。纯读取，不改任何东西。 */
export function collectRealStats(db: Db, seeds: SeedStats | null, opts: CollectOptions): RealStats {
  const { at, today } = opts;

  let dayFormat: Intl.DateTimeFormat | null = null;
  try {
    dayFormat = new Intl.DateTimeFormat('en-CA', {
      timeZone: opts.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    dayFormat = null;
  }
  const dayStart = (ts: number): string =>
    dayFormat ? dayFormat.format(new Date(ts)) : new Date(ts).toISOString().slice(0, 10);

  const bots = db.bots;
  const letters = db.letters;
  const byState = (state: string): number => letters.filter((letter) => letter.state === state).length;

  const sunk = letters.filter((letter) => letter.archivedReason === 'sunk').length;
  const tsunamiLost = letters.filter((letter) => letter.archivedReason === 'tsunami').length;
  const repliesTotal = db.replies.length;
  const catchCountTotal = letters.reduce((sum, letter) => sum + (letter.deliveredCount || 0), 0);

  const floatingLetters = letters.filter((letter) => letter.state === 'floating');
  const oldestAtSeaDays = floatingLetters.length
    ? Math.max(...floatingLetters.map((letter) => Math.floor((at - letter.createdAt) / DAY)))
    : 0;

  const claimedSeeds = new Set(db.seedUses.map((use) => use.seedId));
  const seedsTotal = seeds?.count ?? claimedSeeds.size;

  return {
    date: today,
    at: new Date(at).toISOString(),

    botsTotal: bots.length,
    // 老数据没有 lastSeenAt：退回用 lastResetDate 估，口径略窄（只查信箱的人不算）
    botsActive: bots.filter((bot) =>
      typeof bot.lastSeenAt === 'number'
        ? dayStart(bot.lastSeenAt) === today
        : bot.lastResetDate === today,
    ).length,
    botsNew: bots.filter((bot) => dayStart(bot.createdAt) === today).length,
    botsWhoWrote: new Set(letters.map((letter) => letter.authorHash)).size,

    lettersTotal: letters.length,
    floating: byState('floating'),
    caught: byState('caught'),
    replied: byState('replied'),
    sunk,
    tsunamiLost,
    archivedUnknown: Math.max(0, byState('archived') - sunk - tsunamiLost),
    thrownToday: letters.filter((letter) => dayStart(letter.createdAt) === today).length,
    caughtToday: letters.filter(
      (letter) => letter.caughtAt !== null && dayStart(letter.caughtAt) === today,
    ).length,
    repliesToday: db.replies.filter((reply) => dayStart(reply.createdAt) === today).length,
    catchCountTotal,
    repliesTotal,
    replyRate: letters.length ? Math.round((repliesTotal / letters.length) * 1000) / 1000 : 0,
    oldestAtSeaDays,

    seedsTotal,
    seedsClaimed: claimedSeeds.size,
    seedsUnclaimed: Math.max(0, seedsTotal - claimedSeeds.size),
    seedsClaimedToday: db.seedUses.filter((use) => dayStart(use.usedAt) === today).length,

    tsunamiCount: db.tsunami.count,
    tsunamiLastAt: db.tsunami.lastAt,
    tsunamiShatteredTotal: db.tsunami.totalLost ?? 0,
  };
}

/**
 * 把真数加工成可以公开的那份。
 * **这个函数的返回值是唯一允许写进 `public/` 的东西。**
 */
export function applyBlinding(real: RealStats, ledger: Ledger, at: number): PublicStats {
  const sea = seaStateAt(at);
  return {
    asOf: new Date(at).toISOString(),
    sea,
    world: {
      islands: ledger.islands,
      harbors: ledger.harbors,
      lighthouses: ledger.lighthouses,
      postmen: ledger.postmen,
      coastlineKm: ledger.coastlineKm,
    },
    people: { residents: blindResidents(real.botsTotal, ledger) },
    letters: {
      atSea: blindAtSea(real.floating, ledger, sea.tide.level),
      everSeen: blindEverSeen(real.lettersTotal, ledger),
      withEcho: bucketCount(real.repliesTotal),
      oldestAtSeaDays: real.oldestAtSeaDays,
    },
    waves: {
      count: real.tsunamiCount,
      lastDaysAgo:
        real.tsunamiLastAt === null
          ? null
          : Math.max(0, Math.floor((at - real.tsunamiLastAt) / DAY)),
      shattered: real.tsunamiShatteredTotal,
    },
  };
}

/** 追加一行真数到 JSONL。写不进去只报警，不影响服务。 */
export function appendStatsLine(file: string, stat: RealStats): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(stat)}\n`, { encoding: 'utf8', flag: 'a' });
  } catch (error) {
    process.stderr.write(
      `stats.jsonl 写入失败：${error instanceof Error ? error.message : 'unknown'}\n`,
    );
  }
}

/** 原子写公开数字（tmp + rename），避免大屏读到半截 JSON。 */
export function writePublicStats(file: string, pub: PublicStats): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pub, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}
