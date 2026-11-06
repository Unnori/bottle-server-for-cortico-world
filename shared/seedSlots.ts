/**
 * 种子信的「当天随机时刻」。
 *
 * 为什么需要它：原来的实现是「额度一归零，每 10 分钟试一次」，于是每到午夜
 * 所有人的额度同时清零、全都在半小时内把当天几封一次领完——实测 00:00–00:37
 * 集中了 161 次领取。那是「每日任务刷新」，不是「信在漂」。
 *
 * 这里的做法：**每个玩家、每一天，用 hash 摇出 3~4 个互不相同的时刻**，
 * 只有到了那个时刻才允许领那一封。于是
 *
 *   · 不需要任何新字段（纯派生，重启/多端/刷新都一致）
 *   · 不可作弊（本机改时间没用，服务端用的是自己的时钟）
 *   · 每天重摇，所以谁也别想摸清"自己几点必来信"
 *
 * 分桶而不是直接摇随机数：直接把 N 个随机点撒在一天里会撞堆（两封挤在同一
 * 分钟）。切成 N 段、每段里取一个点，天然保证彼此拉开。
 */
import { createHash } from 'node:crypto';

const DAY_MS = 86_400_000;

/**
 * 某时区在当地时间那一天 00:00 的**绝对时刻**（毫秒）。
 *
 * 拿不到 Iana 时区信息时退化成 UTC 当天，宁可偏一小时也别抛异常。
 */
export function dayStartMs(timeZone: string, at: number): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(at));
    const pick = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
    // 把「当地墙钟」当成 UTC 读出来，与真实时刻相减就是那一刻的时区偏移
    const wallClockAsUtc = Date.UTC(
      pick('year'),
      pick('month') - 1,
      pick('day'),
      pick('hour'),
      pick('minute'),
      pick('second'),
    );
    const offset = wallClockAsUtc - at;
    const local = at + offset;
    const localMidnight = Math.floor(local / DAY_MS) * DAY_MS;
    return localMidnight - offset;
  } catch {
    return Math.floor(at / DAY_MS) * DAY_MS;
  }
}

export interface SeedDayPlan {
  /** 当天的日期键（YYYY-MM-DD），摇点用的种子之一。 */
  dateKey: string;
  /** 当天 00:00 的绝对时刻。 */
  dayStart: number;
  /** 当天内的偏移（毫秒），已按时间排序。空数组 = 今天不发（dailyChance 没摇中）。 */
  slots: number[];
}

/**
 * 从 sha256 摘要里取第 n 个 **32 位**随机数。
 *
 * ⚠ 这里是踩过的坑：一开始只用 4 个十六进制字符（16 位，上限 65535），
 * 然后拿它 `% 一天内的桶宽`（约 21600000 毫秒）。
 * 因为 65535 < 21600000，**取模根本不会生效**，偏移永远是 0–65 秒——
 * 结果所有人的种子都挤在整点上（08:00 / 16:00），分散完全没做到。
 *
 * 现在把相邻两个 16 位字拼成 32 位（0–4294967295），取模才真正有效，
 * 偏移能覆盖整个桶。摘要有 32 个字，`word32Of` 用 n 和 n+8 两个，
 * 所以 i 最多用到 7 时仍在安全范围内（8 与 0 会撞，但那已经在循环里了）。
 */
function word32Of(digest: string, n: number): number {
  const a = Number.parseInt(digest.slice((n % 16) * 4, ((n % 16) * 4) + 4), 16) || 0;
  const b = Number.parseInt(digest.slice(((n + 8) % 16) * 4, (((n + 8) % 16) * 4) + 4), 16) || 0;
  // 拼成无符号 32 位：高 16 位来自 a，低 16 位来自 b
  return ((a << 16) | b) >>> 0;
}

/**
 * 摇出「这一天」的种子时刻表。
 *
 * @param clientHash 服务端只认得的那个 hash（不是 clientId 本身）
 * @param dateKey    当地日期，形如 `2026-10-31`
 * @param slotMin    当天至少几个时刻
 * @param slotMax    当天至多几个时刻
 * @param dailyChance 1.0 = 每天都发；0.5 = 隔天发（应急刹车，热载）
 */
export function seedDayPlan(
  clientHash: string,
  dateKey: string,
  dayStart: number,
  slotMin: number,
  slotMax: number,
  dailyChance = 1,
): SeedDayPlan {
  const digest = createHash('sha256').update(`${clientHash}:${dateKey}:seed-slots`).digest('hex');

  const lo = Math.max(0, Math.min(slotMin, slotMax));
  const hi = Math.max(lo, slotMax);
  const span = hi - lo + 1;
  const count = lo + (word32Of(digest, 0) % span);

  const chance = Math.max(0, Math.min(1, dailyChance));
  if (count === 0 || chance <= 0) return { dateKey, dayStart, slots: [] };
  // 用同一个摘要再摇一次，决定今天到底发不发
  if (chance < 1 && (word32Of(digest, 7) % 1000) / 1000 >= chance) {
    return { dateKey, dayStart, slots: [] };
  }

  const bucket = DAY_MS / count;
  const slots = Array.from({ length: count }, (_, i) => {
    // 32 位随机数取模才有意义（16 位会小于桶宽，取模失效，见 word32Of 的注释）
    const offsetInBucket = word32Of(digest, i + 1) % Math.floor(bucket);
    return Math.floor(i * bucket) + offsetInBucket;
  }).sort((a, b) => a - b);

  return { dateKey, dayStart, slots };
}

/** 今天到此刻为止，已经到点了几个时刻。 */
export function slotsArrived(plan: SeedDayPlan, at: number): number {
  return plan.slots.filter((offset) => at >= plan.dayStart + offset).length;
}
