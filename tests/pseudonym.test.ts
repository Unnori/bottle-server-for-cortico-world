/**
 * 化名生成（栖潮海世界观词库）。
 *
 * 这一组测试守的不是「好看」，是**不坏的边界**：
 *   1. 生成的每个化名都必须过客户端 `isPseudonym` 的形状检查。
 *      不过的话 `safePseudonym` 会把它换成「一位陌生人」，玩家就丢了身份显示。
 *   2. 词库不能有重复词（重复只浪费命名空间，不加任何多样性）。
 *   3. 命名空间不能悄悄变小。
 *   4. 词必须是纯粹的「修饰 + 身份/物件」，不含角色名——§4.1 身份公开，
 *      AI 不冒充真人，随机化名更不能借用具体居民的名字。
 */
import { describe, expect, it } from 'vitest';
import { makePseudonym } from '../server/app.ts';
import { isPseudonym, safePseudonym } from '../shared/text.ts';

/** 固定种子的伪随机，便于复现。 */
function seeded(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

/** 把 makePseudonym 的词库偷出来看（靠同种子枚举反推不现实，直接读源码常量更稳）。 */
async function readWordLists(): Promise<{ adjectives: string[]; nouns: string[] }> {
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../server/app.ts', import.meta.url), 'utf8'),
  );
  const grab = (name: string): string[] => {
    const m = src.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
    if (!m) throw new Error(`没找到 ${name}`);
    return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  };
  return { adjectives: grab('ADJECTIVES'), nouns: grab('NOUNS') };
}

describe('化名 · 形状必须过客户端校验', () => {
  it('2000 个生成的化名全部通过 isPseudonym', () => {
    const bad: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const p = makePseudonym();
      if (!isPseudonym(p)) bad.push(p);
    }
    expect(bad).toEqual([]);
  });

  it('safePseudonym 不会把生成的化名换成「一位陌生人」', () => {
    for (let i = 0; i < 500; i++) {
      const p = makePseudonym();
      expect(safePseudonym(p)).toBe(p);
    }
  });

  it('格式固定：词 + #四位数，且 # 前不超过 12 个字', () => {
    for (let i = 0; i < 500; i++) {
      const p = makePseudonym();
      expect(p).toMatch(/#\d{4}$/);
      const body = p.slice(0, p.lastIndexOf('#'));
      expect([...body].length).toBeGreaterThanOrEqual(2);
      expect([...body].length).toBeLessThanOrEqual(12);
    }
  });
});

describe('化名 · 词库本身要干净', () => {
  it('没有重复词（重复只浪费命名空间）', async () => {
    const { adjectives, nouns } = await readWordLists();
    expect(new Set(adjectives).size).toBe(adjectives.length);
    expect(new Set(nouns).size).toBe(nouns.length);
  });

  it('不许出现角色名（§4.1 身份公开，AI 不冒充真人）', async () => {
    // 世界观总纲第六节里的居民名。随机化名借用它们等于凭空造出一个「简伯」。
    const residents = ['简伯', '阿衡', '小满', '洛环', '梁姐', '七厘', '小陶', '阿舵'];
    const { adjectives, nouns } = await readWordLists();
    const all = [...adjectives, ...nouns];
    for (const r of residents) {
      expect(all.some((w) => w.includes(r))).toBe(false);
    }
  });

  it('命名空间足够大：不少于 100 万种组合', async () => {
    const { adjectives, nouns } = await readWordLists();
    // 9000 个四位数字（1000–9999）
    const space = adjectives.length * nouns.length * 9000;
    expect(space).toBeGreaterThanOrEqual(1_000_000);
  });

  it('两个词库都不少于 50 个词（v2.0 扩充后的底线）', async () => {
    const { adjectives, nouns } = await readWordLists();
    expect(adjectives.length).toBeGreaterThanOrEqual(50);
    expect(nouns.length).toBeGreaterThanOrEqual(50);
  });

  it('两个词库不共用任何词（否则会拼出「潮签潮签」）', async () => {
    const { adjectives, nouns } = await readWordLists();
    const shared = adjectives.filter((a) => nouns.includes(a));
    expect(shared).toEqual([]);
  });

  it('不含服务名「岸讯」（像品牌，塞进人名像打广告）', async () => {
    const { adjectives, nouns } = await readWordLists();
    expect([...adjectives, ...nouns]).not.toContain('岸讯');
  });
});

describe('化名 · 不许拼出专有名词', () => {
  it('不会生成《千灯海图》或「南汀浮田」', () => {
    // 千灯 + 海图 = 千灯海图（长期主线那座公共海图）
    // 南汀 + 浮田 = 南汀浮田（内容区域名）
    // 随机化名如果精确拼出它们，读起来就像那个东西被降格成了人名。
    const reserved = ['千灯海图', '南汀浮田'];
    const leaked: string[] = [];
    for (let i = 0; i < 30000; i++) {
      const p = makePseudonym();
      const body = p.slice(0, p.lastIndexOf('#'));
      if (reserved.includes(body)) leaked.push(p);
    }
    expect(leaked).toEqual([]);
  });

  it('词库确实会拼出这些组合（否则守卫没有意义）', async () => {
    // 反向确认：这两个组合在词库里是可拼的，所以守卫不是摆设
    const { adjectives, nouns } = await readWordLists();
    expect(adjectives).toContain('千灯');
    expect(nouns).toContain('海图');
    expect(adjectives).toContain('南汀');
    expect(nouns).toContain('浮田');
  });
});

describe('化名 · 随机性', () => {
  it('固定种子可复现（便于排查）', () => {
    expect(makePseudonym(seeded(42))).toBe(makePseudonym(seeded(42)));
  });

  it('200 次生成基本不重样', () => {
    const rnd = seeded(99);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(makePseudonym(rnd));
    // 命名空间够大时，200 次几乎不该有碰撞
    expect(seen.size).toBeGreaterThan(195);
  });
});
