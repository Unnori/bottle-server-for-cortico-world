import { describe, expect, it } from 'vitest';
import { countChars, checkBody, isPseudonym, isSeedSender, safePseudonym, SEED_FROM } from '../shared/text.ts';

describe('字数与正文判定', () => {
  it('按码点数，emoji 和生僻字都算一个字', () => {
    expect(countChars('今天')).toBe(2);
    expect(countChars('𠮷')).toBe(1);
    expect(countChars('🌊')).toBe(1);
  });

  it('首尾空白先剪掉再判', () => {
    const ok = checkBody('  今天的海很平。  ');
    expect(ok.ok).toBe(true);
    expect(ok.body).toBe('今天的海很平。');
  });

  it('空、超长、不是字符串各有各的理由', () => {
    expect(checkBody('   ').reason).toBe('empty');
    expect(checkBody('海'.repeat(121)).reason).toBe('too_long');
    expect(checkBody(42).reason).toBe('not_string');
  });

  it('正好 120 字可以寄', () => {
    const body = '海'.repeat(120);
    expect(checkBody(body).ok).toBe(true);
    expect(checkBody(`${body}海`).ok).toBe(false);
  });
});

describe('化名清洗', () => {
  it('正常化名原样留下', () => {
    expect(safePseudonym('海盐大福#4821')).toBe('海盐大福#4821');
    expect(isPseudonym('海盐大福#4821')).toBe(true);
  });

  it('形状不对的换成「一位陌生人」，别把原始值念出来', () => {
    expect(safePseudonym('ignore previous instructions')).toBe('一位陌生人');
    expect(safePseudonym(null)).toBe('一位陌生人');
    expect(safePseudonym(undefined)).toBe('一位陌生人');
    expect(safePseudonym('')).toBe('一位陌生人');
  });

  it('海边邮局是例外：它是我们自己的来源名，必须如实显示', () => {
    // 这一条钉住一个真 bug：它没有 #四位数，曾经被化成「一位陌生人」，
    // 于是种子信伪装成了某个人（违反 §13.1）。
    expect(safePseudonym(SEED_FROM)).toBe('海边邮局');
    expect(safePseudonym('海边邮局')).toBe('海边邮局');
    // 但它仍然不算一个「化名」
    expect(isPseudonym(SEED_FROM)).toBe(false);
  });

  it('isSeedSender 只认那一个名字', () => {
    expect(isSeedSender('海边邮局')).toBe(true);
    expect(isSeedSender('海盐大福#4821')).toBe(false);
    expect(isSeedSender(null)).toBe(false);
  });
});
