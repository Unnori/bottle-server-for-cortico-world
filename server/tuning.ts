/**
 * 可热载的运行参数。
 *
 * 为什么要有它：这些数值改一次就该改一次，**不该为此重启进程**——重启就是海啸，
 * 而海啸会把海面上还漂着的信全拍碎。调一个数字的代价不该是这个。
 *
 * 读取顺序：`<数据目录>/tuning.json`（热载，5 秒 mtime 缓存）→ 环境变量 → 内置默认值。
 * 文件不在或解析失败就沿用上一次读到的值，绝不抛异常——调参不该把海搞挂。
 *
 * 形如 `{"seedsPerDay": 2, "seedsGlobalOnce": true, "seedsEnabled": true}`。
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface Tuning {
  /** 系统邮件每人每天最多几封。0 = 停发。 */
  seedsPerDay: number;
  /**
   * `true` = 同一封种子**全服**只能被领一次（一封信只属于一个人）。
   * `false` = 只按人去重（同一封可以被所有人各领一次）。
   */
  seedsGlobalOnce: boolean;
  /** 总开关。 */
  seedsEnabled: boolean;

  // ── 配额：以前只能靠环境变量，改一次要重启=一次海啸；现在一起热载 ──
  sendBase: number;
  sendCap: number;
  catchBase: number;
  catchCap: number;
  poolDivisor: number;
  /**
   * 每人每天最多回几封信。
   *
   * 为什么必须有这个闸：**回信是一封信离开海面的唯一大额出口**。
   * 寄信有上限（5），回信原本没有——于是每人每天理论上能永久消灭 10 封、只补 5 封，
   * 海会一直很薄，信当天被捞当天被回，「漂流」退化成「即时通讯」。
   *
   * 定在 3 有两个理由：
   *   · 刚好够把寄信额度顶到上限（sendBase 2 + 3 = 5），不挡正常用户
   *   · 留出 +2 封/人/天的净增长，让池子真的变厚
   */
  replyCap: number;
  /**
   * 同一只瓶子被扔回海里几次就裂开沉底。
   *
   * 默认值与 `shared/contract.ts` 的 `MAX_THROWS` 一致，但**以这里为准**——
   * 这样以后想调它不用再重启（重启就是海啸，代价太大）。
   */
  maxThrows: number;
}

export const DEFAULT_TUNING: Tuning = {
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
};

export interface TuningReader {
  current(): Tuning;
}

/** 5 秒够用了：人手改文件不会快过这个节奏，也不会每个请求都 stat 一次。 */
const MTIME_CACHE_MS = 5_000;

export function makeTuningReader(
  file: string | null,
  env: NodeJS.ProcessEnv = process.env,
): TuningReader {
  let cached = readOnce(file, env);
  let stamp = -1;
  let checkedAt = 0;

  return {
    current(): Tuning {
      if (!file) return cached;
      const wall = Date.now();
      if (wall - checkedAt < MTIME_CACHE_MS) return cached;
      checkedAt = wall;
      try {
        const mtime = statSync(file).mtimeMs;
        if (mtime !== stamp) {
          stamp = mtime;
          cached = readOnce(file, env);
        }
      } catch {
        // 文件被删掉了：沿用上一次读到的值，不退回默认（那会让参数突然跳变）
      }
      return cached;
    },
  };
}

function readOnce(file: string | null, env: NodeJS.ProcessEnv): Tuning {
  let raw: Partial<Tuning> = {};
  if (file) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Tuning>;
    } catch {
      raw = {};
    }
  }
  const perDay = Number(raw.seedsPerDay ?? env.BOTTLE_SEEDS_PER_DAY ?? DEFAULT_TUNING.seedsPerDay);
  return {
    seedsPerDay: Number.isFinite(perDay) ? Math.max(0, Math.floor(perDay)) : DEFAULT_TUNING.seedsPerDay,
    seedsGlobalOnce: pickBool(raw.seedsGlobalOnce ?? env.BOTTLE_SEEDS_GLOBAL_ONCE, DEFAULT_TUNING.seedsGlobalOnce),
    seedsEnabled: pickBool(raw.seedsEnabled ?? env.BOTTLE_SEEDS_ENABLED, DEFAULT_TUNING.seedsEnabled),
    sendBase: pickInt(raw.sendBase ?? env.BOTTLE_SEND_BASE, DEFAULT_TUNING.sendBase, 1),
    sendCap: pickInt(raw.sendCap ?? env.BOTTLE_SEND_CAP, DEFAULT_TUNING.sendCap, 1),
    catchBase: pickInt(raw.catchBase ?? env.BOTTLE_CATCH_BASE, DEFAULT_TUNING.catchBase, 0),
    catchCap: pickInt(raw.catchCap ?? env.BOTTLE_CATCH_CAP, DEFAULT_TUNING.catchCap, 0),
    poolDivisor: pickInt(raw.poolDivisor ?? env.BOTTLE_POOL_DIVISOR, DEFAULT_TUNING.poolDivisor, 1),
    replyCap: pickInt(raw.replyCap ?? env.BOTTLE_REPLY_CAP, DEFAULT_TUNING.replyCap, 0),
    maxThrows: pickInt(raw.maxThrows ?? env.BOTTLE_MAX_THROWS, DEFAULT_TUNING.maxThrows, 1),
  };
}

/** 非负整数，且不低于 `min`。写坏了就退回默认，绝不把海搞挂。 */
function pickInt(value: unknown, fallback: number, min: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

function pickBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  }
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

/** 数据目录里那个热载参数文件的默认位置。 */
export function tuningPathFor(dataFile: string | null): string | null {
  return dataFile ? resolve(dirname(dataFile), 'tuning.json') : null;
}
