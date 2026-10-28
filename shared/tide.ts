/**
 * 这片海自己的时间。
 *
 * **纯函数**：同一个时间戳永远算出同一个海况，不存任何状态、不读数据库。
 * 所以它可以给落地页展示、可以被测试钉死，也不会因为服务端重启而跳变。
 *
 * 海的时钟固定按 +08:00 走（栖潮海的本地时间），不跟随服务器的 `BOTTLE_TZ`——
 * 否则同一时刻在两台机器上会算出两片不一样的海。
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** 海的纪元：栖潮海「第 1 天」的午夜，即 2026-10-27 00:00 +08:00。 */
export const SEA_EPOCH = Date.UTC(2026, 9, 26, 16, 0, 0);
/** 半日潮：12 小时一次涨落。真实海洋是 12.42 小时，这里取整更干净。 */
const TIDE_PERIOD = 12 * HOUR;
/** 朔望月长度。 */
const SYNODIC = 29.530588 * DAY;
/** 海的本地时区偏移。 */
const SEA_TZ_OFFSET = 8 * HOUR;

export type TideState = '涨' | '退' | '平';

export interface SeaState {
  /** 栖潮海的第几天，从 1 开始。 */
  day: number;
  tide: {
    /** 潮位 0–100。 */
    level: number;
    state: TideState;
    /** 距下一次满潮还有几分钟。 */
    nextHighInMin: number;
    /** 距下一次干潮还有几分钟。 */
    nextLowInMin: number;
  };
  moon: {
    /** 新月 / 娥眉月 / 上弦 / 盈凸 / 满月 / 亏凸 / 下弦 / 残月 */
    name: string;
    /** 0–1 的相位，0 = 朔。 */
    phase: number;
    /** 照亮比例，0–100。 */
    illum: number;
  };
  wind: { dir: string; level: number };
  visibility: string;
  waterTempC: number;
  /** HH:MM（+08）。 */
  sunrise: string;
  /** HH:MM（+08）。 */
  sunset: string;
}

const MOON_NAMES = ['新月', '娥眉月', '上弦', '盈凸', '满月', '亏凸', '下弦', '残月'] as const;
const WIND_DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'] as const;
const VISIBILITY = ['清明', '清明', '尚可', '尚可', '轻雾', '起雾'] as const;

/** 32 位小哈希，用来让“同一天的风”稳定又不重复。 */
function hash32(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

function mod(value: number, n: number): number {
  return ((value % n) + n) % n;
}

/** 栖潮海的第几天（从 1 开始；纪元之前也算第 1 天）。 */
export function seaDay(at: number): number {
  return Math.max(1, Math.floor((at - SEA_EPOCH) / DAY) + 1);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 把「当天第几小时（可带小数）」格式化成 HH:MM。 */
function hourToClock(hours: number): string {
  const h = Math.floor(mod(hours, 24));
  const m = Math.round((mod(hours, 24) - h) * 60);
  return `${pad2(m === 60 ? (h + 1) % 24 : h)}:${pad2(m === 60 ? 0 : m)}`;
}

/** 一年中的第几天（按 +08 本地日期算）。 */
function dayOfYear(at: number): number {
  const local = new Date(at + SEA_TZ_OFFSET);
  const start = Date.UTC(local.getUTCFullYear(), 0, 1);
  return Math.floor((local.getTime() - start) / DAY) + 1;
}

/**
 * 此刻的海。同一个 `at` 永远得到同一个结果。
 */
export function seaStateAt(at: number): SeaState {
  const day = seaDay(at);

  // ── 潮汐：12 小时一个正弦 ──
  const phaseOfTide = mod(at - SEA_EPOCH, TIDE_PERIOD) / TIDE_PERIOD;
  const sine = Math.sin(2 * Math.PI * phaseOfTide);
  const cosine = Math.cos(2 * Math.PI * phaseOfTide);
  // 2..98，避免出现 0 / 100 这种一看就是公式的端点
  const level = Math.round(50 + 48 * sine);
  const state: TideState = cosine > 0.15 ? '涨' : cosine < -0.15 ? '退' : '平';
  const nextHighInMin = Math.round(mod(0.25 - phaseOfTide, 1) * TIDE_PERIOD / 60_000);
  const nextLowInMin = Math.round(mod(0.75 - phaseOfTide, 1) * TIDE_PERIOD / 60_000);

  // ── 月相 ──
  const moonPhase = mod(at - SEA_EPOCH, SYNODIC) / SYNODIC;
  const moonName = MOON_NAMES[Math.floor(moonPhase * 8 + 0.5) % 8]!;
  const illum = Math.round(((1 - Math.cos(2 * Math.PI * moonPhase)) / 2) * 100);

  // ── 风与能见度：同一天稳定，换天就换 ──
  const dayIndex = Math.floor((at - SEA_EPOCH) / DAY);
  const hWind = hash32(dayIndex);
  const dir = WIND_DIRS[hWind % WIND_DIRS.length]!;
  const windLevel = hWind % 7; // 0–6 级
  const hVis = hash32(dayIndex * 31 + 7);
  const visibility = VISIBILITY[hVis % VISIBILITY.length]!;

  // ── 水温：季节正弦，14–26℃ 之间 ──
  const doy = dayOfYear(at);
  const waterTempC = Math.round((20 + 6 * Math.sin((2 * Math.PI * (doy - 105)) / 365.2425)) * 10) / 10;

  // ── 日出日落：昼长随季节摆动 ──
  const swing = Math.sin((2 * Math.PI * (doy - 80)) / 365.2425);
  const sunrise = hourToClock(6.2 - 1.2 * swing);
  const sunset = hourToClock(17.8 + 1.2 * swing);

  return {
    day,
    tide: { level, state, nextHighInMin, nextLowInMin },
    moon: { name: moonName, phase: Math.round(moonPhase * 1000) / 1000, illum },
    wind: { dir, level: windLevel },
    visibility,
    waterTempC,
    sunrise,
    sunset,
  };
}
