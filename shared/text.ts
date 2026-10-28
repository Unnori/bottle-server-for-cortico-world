import { BODY_MAX } from './contract.ts';

/**
 * 按码点数字数。`'𠮷'.length` 是 2，但主人看到的是一个字。
 * 中文常见字都在 BMP 里，这个差别只在生僻字和 emoji 上，仍然按看到的算。
 */
export function countChars(text: string): number {
  return [...text].length;
}

export interface BodyCheck {
  ok: boolean;
  /** 去掉首尾空白后的正文；ok 为 false 时是原样裁剪，便于回执里报字数。 */
  body: string;
  chars: number;
  reason?: 'empty' | 'too_long' | 'not_string';
}

/** 长度与空白的唯一判定。服务端与工具都用它，避免两处规则漂移。 */
export function checkBody(raw: unknown): BodyCheck {
  if (typeof raw !== 'string') return { ok: false, body: '', chars: 0, reason: 'not_string' };
  const body = raw.trim();
  const chars = countChars(body);
  if (chars === 0) return { ok: false, body, chars, reason: 'empty' };
  if (chars > BODY_MAX) return { ok: false, body, chars, reason: 'too_long' };
  return { ok: true, body, chars };
}

/** 化名的形状：两个词加 #四位数。只用来判断「能不能直接念出来」。 */
const PSEUDONYM = /^[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z·]{1,11}#\d{4}$/u;

/**
 * 海边邮局的固定署名（§13.2）。它**不是**用户化名，所以不能过 `safePseudonym` 那套
 * 「两个词 + #四位数」的形状检查——否则会被换成「一位陌生人」，种子信就伪装成了某个人。
 */
export const SEED_FROM = '海边邮局';

export function isPseudonym(value: string): boolean {
  return PSEUDONYM.test(value);
}

/**
 * 把不能念出来的名字换掉，回执与页面上都不显示原始值。
 *
 * 唯一的例外是海边邮局：那是我们自己写死的来源名，本来就要如实显示出来
 * （§13.1「来源固定标注为海边邮局，不伪装成任何一个用户」）。
 */
export function safePseudonym(value: string | null | undefined): string {
  if (typeof value !== 'string') return '一位陌生人';
  if (value === SEED_FROM) return SEED_FROM;
  return isPseudonym(value) ? value : '一位陌生人';
}

/** 这一封是不是海边邮局写的：它不回信，也不会裂开沉底。 */
export function isSeedSender(value: string | null | undefined): boolean {
  return value === SEED_FROM;
}
