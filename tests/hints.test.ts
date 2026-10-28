import { describe, expect, it } from 'vitest';
import { defaultLocalEnv, scanHints } from '../shared/hints.ts';
import type { LocalEnv } from '../shared/hints.ts';

const env: LocalEnv = { hostname: 'DESKTOP-TEST-PC', username: 'alice', home: 'C:\\Users\\alice' };

describe('软提示', () => {
  it('手机号和邮箱算联系方式', () => {
    expect(scanHints('想聊就打 13800138000', env).map((hint) => hint.kind)).toEqual(['contact']);
    expect(scanHints('写信给我 a.b@example.com', env).map((hint) => hint.kind)).toEqual(['contact']);
    expect(scanHints('微信：seasalt_2026', env).map((hint) => hint.kind)).toEqual(['contact']);
  });

  it('路径、计算机名、用户名算本机信息', () => {
    expect(scanHints('我把文件放在 C:\\Users\\alice\\Desktop 了', env).map((hint) => hint.kind)).toEqual(['local']);
    expect(scanHints('这台机器叫 DESKTOP-TEST-PC', env).map((hint) => hint.kind)).toEqual(['local']);
    expect(scanHints('用户名是 alice', env).map((hint) => hint.kind)).toEqual(['local']);
  });

  it('两类可以同时命中', () => {
    const kinds = scanHints('我在 DESKTOP-TEST-PC 上，电话 13800138000', env).map((hint) => hint.kind);
    expect(kinds).toContain('contact');
    expect(kinds).toContain('local');
  });

  it('干净的信一条都不提示', () => {
    expect(scanHints('今天的海很平，风从北边来。', env)).toEqual([]);
    expect(scanHints('   ', env)).toEqual([]);
  });

  it('提示文案就是设计稿那两句', () => {
    expect(scanHints('13800138000', env)[0]!.text).toBe('这封信里有联系方式');
    expect(scanHints('C:\\Users\\alice', env)[0]!.text).toBe('这封信里有本机信息，可能是无意带出来的');
  });

  it('本机环境在真机上取得到（不抛错）', () => {
    const real = defaultLocalEnv();
    expect(typeof real.hostname).toBe('string');
  });
});
