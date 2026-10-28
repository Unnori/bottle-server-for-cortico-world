/**
 * 根路径那一页静态说明（落地页）。
 *
 * 它存在的理由：有人会直接把域名打开。
 * 之前那里返回 401 JSON（`{"error":"unauthorized"}`），看着像坏了。
 *
 * 但它必须**只是一页纸**：不读数据、不认 token、不回显请求参数。
 * 下面每一条都在钉这个边界。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startBottleServer, type BottleServer } from '../server/main.ts';

let root = '';
let srv: (BottleServer & { port: number; host: string }) | null = null;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'bottle-landing-'));
  const seedsDir = join(root, 'seeds');
  mkdirSync(seedsDir, { recursive: true });
  srv = await startBottleServer({
    dataFile: join(root, 'bottle.json'),
    seedsDir,
    port: 0,
    host: '127.0.0.1',
  });
});

afterEach(async () => {
  await srv?.close().catch(() => undefined);
  srv = null;
  rmSync(root, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${srv!.port}`;

describe('落地页 · 根路径给一页纸', () => {
  it('GET / 返回 HTML，不是 401 JSON', async () => {
    const res = await fetch(`${base()}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('漂流瓶');
    expect(html).toContain('中转服务');
    // 不该是那串让人以为坏了的 JSON
    expect(html).not.toContain('unauthorized');
  });

  it('HEAD / 也是 200（反代健康检查、curl -I 都发 HEAD）', async () => {
    // 之前只认 GET，HEAD 落到 401 分支，运维会误判服务挂了
    const res = await fetch(`${base()}/`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    // HEAD 不返 body，但 content-length 要对
    expect(Number(res.headers.get('content-length'))).toBeGreaterThan(500);
    expect(await res.text()).toBe('');
  });

  it('/index.html 同样给这一页', async () => {
    const res = await fetch(`${base()}/index.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('漂流瓶');
  });

  it('页面上写着「以后可能会有惊喜」', async () => {
    const html = await (await fetch(`${base()}/`)).text();
    expect(html).toContain('惊喜');
  });

  it('favicon 给 204，不在日志里刷 404', async () => {
    const res = await fetch(`${base()}/favicon.ico`);
    expect(res.status).toBe(204);
  });
});

describe('落地页 · 不泄露任何内部信息', () => {
  it('页面里没有 IP、端口、路径、版本、token 字样', async () => {
    const html = await (await fetch(`${base()}/`)).text();
    for (const leak of ['8787', '8788', '/srv/', 'bottle.json', 'token', 'sqlite', 'uptime']) {
      expect(html.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it('带安全响应头（只显示文字，不许执行任何东西）', async () => {
    const res = await fetch(`${base()}/`);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('落地页不依赖鉴权：不带 token 也是 200', async () => {
    const res = await fetch(`${base()}/`);
    expect(res.status).toBe(200);
  });
});

describe('落地页 · 没把 API 弄坏', () => {
  it('/health 仍是 JSON 且免鉴权', async () => {
    const res = await fetch(`${base()}/health`);
    expect(res.status).toBe(200);
    // fetch 的 .json() 返回 unknown，这里显式收窄，别用 any 掩盖
    const body = (await res.json()) as { ok: boolean; seeds: unknown };
    expect(body.ok).toBe(true);
    expect(body.seeds).toBeTruthy();
  });

  it('未知路径仍是 JSON 401（没被落地页吞掉）', async () => {
    const res = await fetch(`${base()}/nonexistent`);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('POST / 不会被当成落地页', async () => {
    const res = await fetch(`${base()}/`, { method: 'POST' });
    // 走到 API 上：没 token → 401，而不是回 HTML
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('注册与寄信照常工作', async () => {
    const reg = await fetch(`${base()}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash: 'a'.repeat(64) }),
    });
    expect(reg.status).toBe(200);
    const { token } = (await reg.json()) as { token: string };
    expect(token).toBeTruthy();

    const thrown = await fetch(`${base()}/throw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: '落地页加完之后，寄信还得能用。' }),
    });
    expect(thrown.status).toBe(200);
  });
});
