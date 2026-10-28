/**
 * 两条公式，都是参数（§6）。池子变大以后只调上限和除数，不动代码结构。
 *
 *   今日可寄 = min(sendCap, sendBase + 今日已回信数) - 今日已寄
 *   今日可捞 = min(catchCap, catchBase + floor(池中可捞信数 / poolDivisor) + 今日已寄) - 今日已捞
 *
 * 三条设计意图写在设计稿里：池子越空捞得越少（诚实，不是惩罚）；回信换寄信、寄信换捞取
 * （活跃者靠贡献拿额度）；两个上限防单人在小池子里刷屏。
 */
import type { BotRow } from './db.ts';
import type { Quota } from '../shared/contract.ts';

export interface QuotaRules {
  sendBase: number;
  sendCap: number;
  catchBase: number;
  catchCap: number;
  poolDivisor: number;
}

export const DEFAULT_RULES: QuotaRules = {
  sendBase: 2,
  sendCap: 5,
  catchBase: 2,
  catchCap: 10,
  poolDivisor: 5,
};

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** 服务端部署时可以用环境变量调参，不改包。 */
export function rulesFromEnv(env: NodeJS.ProcessEnv = process.env): QuotaRules {
  return {
    sendBase: positiveInt(env.BOTTLE_SEND_BASE, DEFAULT_RULES.sendBase),
    sendCap: positiveInt(env.BOTTLE_SEND_CAP, DEFAULT_RULES.sendCap),
    catchBase: positiveInt(env.BOTTLE_CATCH_BASE, DEFAULT_RULES.catchBase),
    catchCap: positiveInt(env.BOTTLE_CATCH_CAP, DEFAULT_RULES.catchCap),
    poolDivisor: Math.max(1, positiveInt(env.BOTTLE_POOL_DIVISOR, DEFAULT_RULES.poolDivisor)),
  };
}

/** 每日 0 点（服务器时区）惰性重置：下一次请求时发现日期变了就把三个计数清零。 */
export function resetDaily(bot: BotRow, today: string): boolean {
  if (bot.lastResetDate === today) return false;
  bot.lastResetDate = today;
  bot.bottlesUsed = 0;
  bot.catchesUsed = 0;
  bot.repliesMade = 0;
  // 系统邮件是独立通道，但它自己也有每日上限
  bot.mailTaken = 0;
  return true;
}

export function computeQuota(bot: BotRow, poolSize: number, rules: QuotaRules = DEFAULT_RULES): Quota {
  const sendCap = Math.min(rules.sendCap, rules.sendBase + bot.repliesMade);
  const catchCap = Math.min(rules.catchCap, rules.catchBase + Math.floor(poolSize / rules.poolDivisor) + bot.bottlesUsed);
  return {
    bottles_left: Math.max(0, sendCap - bot.bottlesUsed),
    catches_left: Math.max(0, catchCap - bot.catchesUsed),
  };
}
