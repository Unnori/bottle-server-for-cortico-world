/**
 * 潮汐：这片海自己的时间。
 *
 * 纯函数，所以每一条都能被钉死：同一个时刻永远给出同一片海，
 * 大屏和落地页因此不会两天算出两个互相矛盾的数字。
 */
import { describe, expect, it } from 'vitest';
import { seaDay, seaStateAt, SEA_EPOCH } from '../shared/tide.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** 2026-10-29 12:00 +08:00 */
const NOON = Date.UTC(2026, 9, 29, 4, 0, 0);

describe('潮汐 · 可复现', () => {
  it('同一个时间戳永远算出同一片海', () => {
    expect(seaStateAt(NOON)).toEqual(seaStateAt(NOON));
  });

  it('相隔一天的同一时刻，海况不一样（风/潮/月都会动）', () => {
    const a = seaStateAt(NOON);
    const b = seaStateAt(NOON + DAY);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});

describe('潮汐 · 天数', () => {
  it('纪元当天是第 1 天', () => {
    expect(seaDay(SEA_EPOCH)).toBe(1);
    expect(seaDay(SEA_EPOCH + DAY - 1)).toBe(1);
    expect(seaDay(SEA_EPOCH + DAY)).toBe(2);
  });

  it('纪元之前也不会算成 0 或负', () => {
    expect(seaDay(SEA_EPOCH - 100 * DAY)).toBe(1);
  });
});

describe('潮汐 · 取值范围', () => {
  it('所有数字都落在该在的区间里（连采 48 小时）', () => {
    for (let i = 0; i < 96; i++) {
      const s = seaStateAt(SEA_EPOCH + i * 30 * 60_000);
      expect(s.tide.level).toBeGreaterThanOrEqual(0);
      expect(s.tide.level).toBeLessThanOrEqual(100);
      expect(['涨', '退', '平']).toContain(s.tide.state);
      expect(s.tide.nextHighInMin).toBeGreaterThanOrEqual(0);
      expect(s.tide.nextHighInMin).toBeLessThanOrEqual(720);
      expect(s.tide.nextLowInMin).toBeGreaterThanOrEqual(0);
      expect(s.tide.nextLowInMin).toBeLessThanOrEqual(720);
      expect(s.moon.phase).toBeGreaterThanOrEqual(0);
      expect(s.moon.phase).toBeLessThan(1);
      expect(s.moon.illum).toBeGreaterThanOrEqual(0);
      expect(s.moon.illum).toBeLessThanOrEqual(100);
      expect(s.wind.level).toBeGreaterThanOrEqual(0);
      expect(s.wind.level).toBeLessThanOrEqual(6);
      expect(s.waterTempC).toBeGreaterThan(5);
      expect(s.waterTempC).toBeLessThan(30);
      expect(s.day).toBeGreaterThanOrEqual(1);
    }
  });

  it('半日潮：12 小时后潮位回到同一个值', () => {
    expect(seaStateAt(NOON + 12 * HOUR).tide.level).toBe(seaStateAt(NOON).tide.level);
  });

  it('日出永远早于日落', () => {
    for (let i = 0; i < 24; i++) {
      const s = seaStateAt(SEA_EPOCH + i * 15 * DAY);
      expect(s.sunrise < s.sunset).toBe(true);
    }
  });
});

describe('潮汐 · 月相', () => {
  it('过了朔望月一轮，相位回到原处', () => {
    const SYNODIC = 29.530588 * DAY;
    const a = seaStateAt(NOON).moon.phase;
    const b = seaStateAt(NOON + SYNODIC).moon.phase;
    expect(Math.abs(a - b)).toBeLessThan(0.02);
  });

  it('相位 0 附近是新月，0.5 附近是满月', () => {
    const newMoon = seaStateAt(SEA_EPOCH + DAY);
    expect(newMoon.moon.name).toBe('新月');
    const fullMoon = seaStateAt(SEA_EPOCH + Math.round(14.76 * DAY));
    expect(fullMoon.moon.name).toBe('满月');
  });
});
