/**
 * 世界台账与盲化。
 *
 * **台账**（`almanac/ledger.json`）只有运营者知道：世界观里有几个具名居民、居民一共写过
 * 多少封信、几座岛、几盏灯……它跟着种子仓库一起同步到服务器，服务端**只读、热载、从不对外**。
 *
 * **盲化**：公开给大屏的数字 = 真实值 + 台账里的世界量。
 * 运营者能减回去，外人不能——前提是台账本身永远不出现在任何对外文件里。
 * 所以这个模块只被 `stats` 与 `/sea` 用，输出里的台账量一律不落地到 `public/`。
 */
import { readFileSync, statSync } from 'node:fs';

export interface Ledger {
  /** 世界观里出现过的具名人物（去重）。用于把「注册玩家」放水成「居民」。 */
  npcCount: number;
  /** 居民写过的信总数（= 种子信总数，或者按“每人几封”另算一个更大的数）。 */
  residentLettersTotal: number;
  /** 群岛岛数。 */
  islands: number;
  /** 港口数。 */
  harbors: number;
  /** 灯塔数。 */
  lighthouses: number;
  /** 邮局分信员数。 */
  postmen: number;
  /** 海岸线长度（公里），纯虚构，用来撑大屏。 */
  coastlineKm: number;
  /**
   * 潮汐系数 0–1：0 = 海上的信数不随潮汐起伏；0.3 = 起伏 ±30%。
   * 让公开数字像一片真的海在呼吸，而不是一条骗人的死线。
   */
  tideLetterFactor: number;
}

export const EMPTY_LEDGER: Ledger = {
  npcCount: 0,
  residentLettersTotal: 0,
  islands: 0,
  harbors: 0,
  lighthouses: 0,
  postmen: 0,
  coastlineKm: 0,
  tideLetterFactor: 0,
};

export interface LedgerReader {
  current(): Ledger;
}

const MTIME_CACHE_MS = 5_000;

function pickInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function pickFloat(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 把任意 JSON 收敛成合法台账：缺字段补 0，越界值夹回范围内，绝不抛错。 */
export function normalizeLedger(raw: unknown): Ledger {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    npcCount: pickInt(o.npcCount, EMPTY_LEDGER.npcCount),
    residentLettersTotal: pickInt(o.residentLettersTotal, EMPTY_LEDGER.residentLettersTotal),
    islands: pickInt(o.islands, EMPTY_LEDGER.islands),
    harbors: pickInt(o.harbors, EMPTY_LEDGER.harbors),
    lighthouses: pickInt(o.lighthouses, EMPTY_LEDGER.lighthouses),
    postmen: pickInt(o.postmen, EMPTY_LEDGER.postmen),
    coastlineKm: pickInt(o.coastlineKm, EMPTY_LEDGER.coastlineKm),
    tideLetterFactor: pickFloat(o.tideLetterFactor, EMPTY_LEDGER.tideLetterFactor, 0, 1),
  };
}

export function readLedgerFile(path: string | null): Ledger {
  if (!path) return { ...EMPTY_LEDGER };
  try {
    return normalizeLedger(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    // 文件不在或写坏了：当作「没有世界量」，也就是完全不放水。
    // 宁可数字难看，也不能算出个假数。
    return { ...EMPTY_LEDGER };
  }
}

/** 带 mtime 缓存的热载读取器：改台账不用重启。 */
export function makeLedgerReader(path: string | null): LedgerReader {
  let cached = readLedgerFile(path);
  let stamp = -1;
  let checkedAt = 0;
  return {
    current(): Ledger {
      if (!path) return cached;
      const wall = Date.now();
      if (wall - checkedAt < MTIME_CACHE_MS) return cached;
      checkedAt = wall;
      try {
        const mtime = statSync(path).mtimeMs;
        if (mtime !== stamp) {
          stamp = mtime;
          cached = readLedgerFile(path);
        }
      } catch {
        // 文件被删掉了：沿用上一次的值，避免数字突然跳变
      }
      return cached;
    },
  };
}

/**
 * 居民数量 = 真实注册玩家 + 世界观具名人物。
 * 外人要还原真实玩家数，得先读完所有种子信并数出人物——那已经是深度用户了。
 */
export function blindResidents(realPlayers: number, ledger: Ledger): number {
  return Math.max(0, realPlayers) + ledger.npcCount;
}

/**
 * 海上漂着的瓶子 = 真实 floating + 居民写过的信 × 潮汐摆动。
 * `tideLevel` 是 0–100 的潮位：退潮时露出更多，涨潮时少一些。
 */
export function blindAtSea(realFloating: number, ledger: Ledger, tideLevel: number): number {
  const base = ledger.residentLettersTotal;
  if (base <= 0) return Math.max(0, realFloating);
  const factor = ledger.tideLetterFactor;
  const sway = 1 + factor * ((50 - tideLevel) / 50); // tideLevel 50 → 1；0 → 1+factor；100 → 1-factor
  return Math.max(0, realFloating) + Math.round(base * Math.max(0, sway));
}

/** 海上出现过的信（累计）= 真实累计投递 + 居民写过的信。 */
export function blindEverSeen(realThrown: number, ledger: Ledger): number {
  return Math.max(0, realThrown) + ledger.residentLettersTotal;
}

/**
 * 把精确条数压成区间。比率类与单点值用加法盲化无效，只能降精度。
 * 这是我们唯一允许公开"回音"类信息的方式。
 */
export function bucketCount(n: number): string {
  if (n <= 0) return '还没有';
  if (n <= 3) return '几封';
  if (n <= 15) return '十来封';
  if (n <= 60) return '几十封';
  if (n <= 200) return '上百封';
  return '很多';
}
