/**
 * 把一段「多久以前」说成人话。
 *
 * 规则（和人类看时间的感觉对齐，而不是和 `Math.floor` 对齐）：
 *   · 不到 1 分钟  → 刚刚
 *   · 不到 1 小时  → N 分钟前
 *   · 不到 1 天    → N 小时前
 *   · 一天以上     → N 天前
 *
 * 为什么不在各处自己算：以前落地页只按天取整，于是「刚刚起过一场浪」会显示成
 * 「最近一次在 0 天前」；客户端那边则是 59 分钟一律说「刚刚」。
 * 同一个概念散在多处，就会各自烂成不同的样子。
 */
export function agoText(diffMs: number): string {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  // 时钟回拨或时区抖动时 diff 可能是负的：按"刚刚"处理，不显示"-3 分钟前"
  const diff = Math.max(0, Math.floor(diffMs));

  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  return `${Math.floor(diff / DAY)} 天前`;
}
