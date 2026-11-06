/**
 * 落地页的活动位：一句话 + 一个链接，**必须能热载**。
 *
 * 背景：落地页模板（`public/index.html`）有永久缓存，只在进程启动时读一次。
 * 往模板里写死链接必须重启（=海啸）。所以活动位走 `tuning.json`：
 * `<!--SEA-->` 那把占位符每次请求都重新填，改配置 5 秒生效。
 *
 * 这个功能是「丢个空的在那儿，以后要用再填」，所以四件事必须成立：
 *   A. 空值 = 页面上一点痕迹都没有（不是显示一个空盒子）
 *   B. 填了就出现，而且链接能点
 *   C. 改配置立刻反映（热载）
 *   D. 恶意链接被拒绝（落地页是公网可读的）
 *
 * 注意：`tuningPathFor(dataFile)` = `dirname(dataFile)/tuning.json`，
 * 所以测试把 tuning.json 写在与 bottle.json 同一个目录里，就能被服务端读到。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBottleServer } from '../server/main.ts';
import { DEFAULT_TUNING, makeTuningReader } from '../server/tuning.ts';

interface Live {
  url: string;
  dir: string;
  stop(): Promise<void>;
}

const lives: Live[] = [];

/** 起一个真服务端。tuning.json 与 bottle.json 同目录，才能被热载读到。 */
async function boot(rawTuning: Record<string, unknown> = {}): Promise<Live> {
  const dir = mkdtempSync(join(tmpdir(), 'bottle-camp-'));
  const dataFile = join(dir, 'bottle.json');
  writeFileSync(join(dir, 'tuning.json'), JSON.stringify({ ...DEFAULT_TUNING, ...rawTuning }), 'utf8');

  const server = await startBottleServer({
    dataFile,
    seedsDir: null,
    port: 0,
    host: '127.0.0.1',
  });
  const live: Live = {
    url: `http://127.0.0.1:${server.port}`,
    dir,
    stop: async () => {
      await server.close();
    },
  };
  lives.push(live);
  return live;
}

/** 取落地页。并发跑全量时偶发 fetch 失败，重试一次避免假红。 */
async function land(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url + '/');
      expect(res.status).toBe(200);
      return await res.text();
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw lastError;
}

afterEach(async () => {
  while (lives.length) {
    const l = lives.pop()!;
    try {
      await l.stop();
    } catch {
      /* 已关 */
    }
  }
});

describe('A. 空值 = 页面上一点痕迹都没有', () => {
  it('两个字段都空时，不出现 campaign 块', async () => {
    const l = await boot({ campaignLink: '', campaignText: '' });
    const html = await land(l.url);
    expect(html).not.toContain('class="campaign"');
    expect(html).not.toContain('<a href=""');
  });

  it('只有链接没文案时也不渲染（不显示一个点了没反应的东西）', async () => {
    const l = await boot({ campaignLink: 'https://example.com/', campaignText: '' });
    const html = await land(l.url);
    expect(html).not.toContain('class="campaign"');
  });

  it('配置里缺这两个字段（老配置）也不崩', async () => {
    const { campaignLink: _a, campaignText: _b, ...rest } = DEFAULT_TUNING;
    const l = await boot(rest as unknown as Record<string, unknown>);
    const html = await land(l.url);
    expect(html).not.toContain('class="campaign"');
    expect(html).toContain('栖潮海');
  });
});

describe('B. 填了就出现，链接能点', () => {
  it('有文案有链接：出现一个可点的 <a>', async () => {
    const l = await boot({ campaignLink: 'https://example.com/event', campaignText: '千灯海图上线了' });
    const html = await land(l.url);
    expect(html).toContain('class="campaign"');
    expect(html).toContain('href="https://example.com/event"');
    expect(html).toContain('千灯海图上线了');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('只有文案没链接：只显示那句话，不是空链接', async () => {
    const l = await boot({ campaignLink: '', campaignText: '施工中，敬请期待' });
    const html = await land(l.url);
    expect(html).toContain('施工中，敬请期待');
    expect(html).not.toContain('<a href=""');
  });
});

describe('C. 改配置立刻反映（热载）', () => {
  it('同一个目录改 tuning.json，5 秒后落地页就变了', async () => {
    const l = await boot({ campaignLink: '', campaignText: '' });
    const before = await land(l.url);
    expect(before).not.toContain('class="campaign"');

    // 运维改配置（不重启进程）
    writeFileSync(
      join(l.dir, 'tuning.json'),
      JSON.stringify({
        ...DEFAULT_TUNING,
        campaignLink: 'https://example.com/new',
        campaignText: '新活动来了',
      }),
      'utf8',
    );
    // 热载缓存就是 5 秒；多留一点余量避免抖动
    await new Promise((r) => setTimeout(r, 6000));

    const after = await land(l.url);
    expect(after).toContain('class="campaign"');
    expect(after).toContain('新活动来了');
    expect(after).toContain('https://example.com/new');
  }, 30000);

  it('改回空值也能撤回（不用重启）', async () => {
    const l = await boot({ campaignLink: 'https://a.example/', campaignText: '第一版' });
    expect(await land(l.url)).toContain('第一版');

    writeFileSync(
      join(l.dir, 'tuning.json'),
      JSON.stringify({ ...DEFAULT_TUNING, campaignLink: '', campaignText: '' }),
      'utf8',
    );
    await new Promise((r) => setTimeout(r, 6000));

    expect(await land(l.url)).not.toContain('class="campaign"');
  }, 30000);
});

describe('D. 恶意链接被拒绝（落地页是公网可读的）', () => {
  it('javascript: 协议不渲染成链接', async () => {
    const l = await boot({ campaignLink: 'javascript:alert(1)', campaignText: '点我' });
    const html = await land(l.url);
    expect(html).not.toContain('javascript:');
    // 文案仍然显示，但不是一个可点的东西
    expect(html).toContain('点我');
  });

  it('data: 协议不渲染成链接', async () => {
    const l = await boot({ campaignLink: 'data:text/html,<script>x', campaignText: '点我' });
    const html = await land(l.url);
    expect(html).not.toContain('data:text/html');
  });

  it('带账号密码的 URL 被拒绝', async () => {
    const l = await boot({ campaignLink: 'https://user:pass@example.com/', campaignText: '点我' });
    const html = await land(l.url);
    expect(html).not.toContain('user:pass');
  });

  it('文案里的 HTML 被转义（不能注入标签）', async () => {
    const l = await boot({
      campaignLink: 'https://ok.example/',
      campaignText: '<img src=x onerror=alert(1)>',
    });
    const html = await land(l.url);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('超长文案被当成空（防止把首页撑坏）', async () => {
    const l = await boot({ campaignLink: 'https://ok.example/', campaignText: '长'.repeat(400) });
    const html = await land(l.url);
    expect(html).not.toContain('class="campaign"');
  });
});

describe('E. tuning 解析层单独验证', () => {
  it('默认空串', () => {
    expect(DEFAULT_TUNING.campaignLink).toBe('');
    expect(DEFAULT_TUNING.campaignText).toBe('');
  });

  it('非字符串被当成空', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bottle-t-'));
    const file = join(dir, 'tuning.json');
    writeFileSync(file, JSON.stringify({ campaignLink: 123, campaignText: { x: 1 } }), 'utf8');
    const t = makeTuningReader(file).current();
    expect(t.campaignLink).toBe('');
    expect(t.campaignText).toBe('');
  });

  it('超长（>300）被当成空', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bottle-t2-'));
    const file = join(dir, 'tuning.json');
    writeFileSync(file, JSON.stringify({ campaignText: 'x'.repeat(301) }), 'utf8');
    expect(makeTuningReader(file).current().campaignText).toBe('');
  });

  it('正常值原样保留（去掉首尾空白）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bottle-t3-'));
    const file = join(dir, 'tuning.json');
    writeFileSync(
      file,
      JSON.stringify({ campaignLink: 'https://a.example/x', campaignText: '  活动文案  ' }),
      'utf8',
    );
    const t = makeTuningReader(file).current();
    expect(t.campaignLink).toBe('https://a.example/x');
    expect(t.campaignText).toBe('活动文案');
  });
});
