import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi, sha256, type Api } from '../server/app.ts';
import { Db } from '../server/db.ts';
import { STATIONERY_SVG_MAX_BYTES, type CatchRes, type LetterRes, type MailboxItem, type Quota, type RegisterRes } from '../shared/contract.ts';
import { checkStationery, sanitizeSvg } from '../shared/stationery.ts';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><defs><linearGradient id="sea"><stop offset="0" stop-color="#38566b"/></linearGradient></defs><path d="M10 40 L60 70 L110 40 Z" fill="url(#sea)" stroke="#38566b"/><text x="10" y="20" font-size="8">潮 &amp; 风</text></svg>';

describe('信纸校验器（两端共用）', () => {
  it('合法 SVG 规范化后稳定：同一份输入得到同一份输出，再校验一次不变', () => {
    const first = sanitizeSvg(SVG);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80">')).toBe(true);
    expect(first.svg).toContain('潮 &amp; 风');
    const second = sanitizeSvg(first.svg);
    expect(second).toEqual(first);
  });

  it.each([
    ['脚本', '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>'],
    ['foreignObject', '<svg viewBox="0 0 1 1"><foreignObject/></svg>'],
    ['事件属性（不加引号也不行）', '<svg viewBox="0 0 1 1" onload=alert(1)></svg>'],
    ['事件属性', '<svg viewBox="0 0 1 1"><rect onclick="x()"/></svg>'],
    ['href', '<svg viewBox="0 0 1 1"><use href="#a"/></svg>'],
    ['xlink:href', '<svg viewBox="0 0 1 1"><rect xlink:href="javascript:alert(1)"/></svg>'],
    ['image 外链', '<svg viewBox="0 0 1 1"><image href="https://example.com/a.png"/></svg>'],
    ['style 属性', '<svg viewBox="0 0 1 1"><rect style="fill:url(https://x)"/></svg>'],
    ['style 元素', '<svg viewBox="0 0 1 1"><style>@import url(https://x)</style></svg>'],
    ['外部 url()', '<svg viewBox="0 0 1 1"><rect fill="url(https://x/#a)"/></svg>'],
    ['引用不存在的 id', '<svg viewBox="0 0 1 1"><rect fill="url(#nope)"/></svg>'],
    ['data: 图片', '<svg viewBox="0 0 1 1"><image href="data:image/png;base64,AAAA"/></svg>'],
    ['动画', '<svg viewBox="0 0 1 1"><rect><animate attributeName="x"/></rect></svg>'],
    ['DOCTYPE 实体', '<!DOCTYPE svg [<!ENTITY a "b">]><svg viewBox="0 0 1 1"/>'],
    ['CDATA', '<svg viewBox="0 0 1 1"><text><![CDATA[x]]></text></svg>'],
    ['自定义实体', '<svg viewBox="0 0 1 1"><text>&nbsp;</text></svg>'],
    ['缺 viewBox', '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'],
    ['非 svg 根', '<g/>'],
    ['两个根', '<svg viewBox="0 0 1 1"/><svg viewBox="0 0 1 1"/>'],
    ['标签不配对', '<svg viewBox="0 0 1 1"><g></svg>'],
    ['裸文字', '<svg viewBox="0 0 1 1">hello</svg>'],
    ['错误命名空间', '<svg xmlns="http://www.w3.org/1999/xhtml" viewBox="0 0 1 1"/>'],
    ['外部字体', '<svg viewBox="0 0 1 1"><text font-family="url(https://x/f.woff)">a</text></svg>'],
  ])('拒绝：%s', (_label, svg) => {
    expect(sanitizeSvg(svg).ok).toBe(false);
  });

  it('规范化后超过 8 KiB 拒绝，并说明字节数', () => {
    const rects = Array.from({ length: 200 }, (_, i) => `<rect x="${i}" y="${i}" width="10" height="10" fill="#38566b"/>`).join('');
    const result = sanitizeSvg(`<svg viewBox="0 0 300 300">${rects}</svg>`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(String(STATIONERY_SVG_MAX_BYTES));
    const tooMany = Array.from({ length: 301 }, () => '<g/>').join('');
    expect(sanitizeSvg(`<svg viewBox="0 0 1 1">${tooMany}</svg>`).ok).toBe(false);
  });

  it('stationery 字段：缺席即不装饰；内置与自创互斥；未知字段丢弃；纸张枚举', () => {
    expect(checkStationery(undefined)).toEqual({ ok: true, value: null });
    expect(checkStationery({ v: 1 })).toEqual({ ok: true, value: null });
    expect(checkStationery({ v: 1, paper: 'grid', extra: 'x' })).toEqual({ ok: true, value: { v: 1, paper: 'grid' } });
    expect(checkStationery({ v: 1, doodle: 'wave-line', customSvg: SVG }).ok).toBe(false);
    expect(checkStationery({ v: 3, paper: 'grid' }).ok).toBe(false);
    expect(checkStationery({ v: 1, paper: 'parchment' }).ok).toBe(false);
    expect(checkStationery({ v: 1, doodle: '../etc/passwd' }).ok).toBe(false);
    expect(checkStationery('grid').ok).toBe(false);
  });
});

function setup(file: string | null = null): { api: Api; db: Db; call: (m: 'GET' | 'POST', p: string, t?: string, b?: unknown) => { status: number; body: unknown }; register: (s: string) => RegisterRes } {
  const db = Db.open(file);
  let n = 0, seed = 7;
  const api = createApi(db, {
    now: () => Date.parse('2026-11-13T00:10:00+08:00'), timeZone: 'Asia/Shanghai',
    random: () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; },
    newToken: () => `tok_${++n}`,
    rules: { sendBase: 50, sendCap: 50, catchBase: 50, catchCap: 50, poolDivisor: 5 }, ipLimit: 20,
  });
  const call = (method: 'GET' | 'POST', path: string, token?: string, body?: unknown) => api.handle({ method, path, token, ip: '1.1.1.1', body });
  const register = (s: string) => call('POST', '/register', undefined, { hash: sha256(s) }).body as RegisterRes;
  return { api, db, call, register };
}

describe('服务端 · 信纸往返', () => {
  it('/quota 声明信纸能力', () => {
    const h = setup(); const a = h.register('a');
    expect((h.call('GET', '/quota', a.token).body as Quota).stationery).toBe(1);
  });

  it('新信的自创图与回信的内置图各自往返，不互相覆盖；收到的是规范化文本', () => {
    const h = setup(); const a = h.register('a'), b = h.register('b');
    const thrown = h.call('POST', '/throw', a.token, { body: '海风很大。', stationery: { v: 1, paper: 'grid', customSvg: SVG } });
    expect(thrown.status).toBe(200);
    const caught = h.call('POST', '/catch', b.token).body as CatchRes;
    expect(caught.empty).toBe(false);
    if (caught.empty) return;
    const letter = h.call('GET', `/letter/${caught.letterId}`, b.token).body as LetterRes;
    const canonical = sanitizeSvg(SVG);
    expect(letter.stationery).toEqual({ v: 1, paper: 'grid', customSvg: canonical.ok ? canonical.svg : '' });

    expect(h.call('POST', '/reply', b.token, { letterId: caught.letterId, body: '收到了。', stationery: { v: 1, doodle: 'wave-line' } }).status).toBe(200);
    const box = h.call('GET', '/mailbox', a.token).body as MailboxItem[];
    expect(box[0]?.stationery).toEqual({ v: 1, doodle: 'wave-line' });
    expect((h.call('GET', `/letter/${caught.letterId}`, b.token).body as LetterRes).stationery?.customSvg).toBeTruthy();
  });

  it('不合格装饰整封拒收，不扣瓶子；旧客户端不带字段照常寄', () => {
    const h = setup(); const a = h.register('a');
    const before = (h.call('GET', '/quota', a.token).body as Quota).bottles_left;
    const bad = h.call('POST', '/throw', a.token, { body: '你好', stationery: { v: 1, customSvg: '<svg viewBox="0 0 1 1"><script/></svg>' } });
    expect(bad.status).toBe(400);
    expect((h.call('GET', '/quota', a.token).body as Quota).bottles_left).toBe(before);
    expect(h.call('POST', '/throw', a.token, { body: '你好' }).status).toBe(200);
    expect(h.db.letters.at(-1)?.stationery).toBeUndefined();
  });

  it('装饰与正文一样不落盘：数据文件里没有 SVG、纸张或图案 ID', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bottle-stationery-'));
    try {
      const file = join(dir, 'bottle.json');
      const h = setup(file); const a = h.register('a');
      h.call('POST', '/throw', a.token, { body: '海风很大。', stationery: { v: 1, paper: 'line', customSvg: SVG } });
      h.call('POST', '/throw', a.token, { body: '第二封。', stationery: { v: 1, doodle: 'corner-flower' } });
      const disk = readFileSync(file, 'utf8');
      expect(disk).not.toContain('stationery');
      expect(disk).not.toContain('<svg');
      expect(disk).not.toContain('corner-flower');
      expect(h.db.letters.some(letter => letter.stationery)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


describe('v2 多图排版的中央服务端链路', () => {
  const layout = {v:2,paper:'grid',paperColor:'#fff7e8',decorations:[
    {doodle:'rain-cloud',color:'#456789',x:15,y:20,width:25,rotation:30,opacity:.3,layer:'behind',z:1},
    {customSvg:SVG,color:'#995566',x:80,y:85,width:15,rotation:-10,opacity:.25,layer:'front',z:0,flipX:true},
  ]};
  it('声明两代能力，新信、回信和重投都保留完整排版', () => {
    const h=setup();const a=h.register('layout-a'),b=h.register('layout-b');
    expect(h.call('GET','/quota',a.token).body).toMatchObject({stationery:1,stationery_layout:2});
    const canonical=checkStationery(layout);expect(canonical.ok).toBe(true);if(!canonical.ok)return;
    const sent=h.call('POST','/throw',a.token,{body:'落在纸上的风。',stationery:layout});expect(sent.status).toBe(200);
    const id=(sent.body as {letterId:string}).letterId;
    expect(h.db.letters.find(l=>l.id===id)?.stationery).toEqual(canonical.value);
    const caught=h.call('POST','/catch',b.token).body as CatchRes;expect(caught.empty).toBe(false);if(caught.empty)return;
    expect((h.call('GET','/letter/'+id,b.token).body as LetterRes).stationery).toEqual(canonical.value);
    const reply={v:2,decorations:[{doodle:'paper-plane',color:'#997755',placement:'center',size:'large'}]};
    expect(h.call('POST','/reply',b.token,{letterId:id,body:'风里有回音。',stationery:reply}).status).toBe(200);
    expect((h.call('GET','/mailbox',a.token).body as MailboxItem[])[0].stationery).toEqual((checkStationery(reply) as {value:unknown}).value);
    // 失效信重投走同一个校验器，新 ID 不继承旧信的占用。
    const old=h.db.letters.find(l=>l.id===id)!;old.state='archived';old.archivedReason='tsunami';
    expect(h.call('POST','/repost',a.token,{letterId:id,body:'落在纸上的风。',stationery:layout}).status).toBe(200);
    expect(h.db.letters.at(-1)?.stationery).toEqual(canonical.value);
  });
  it('非法子图整封拒收且不扣额度；多图和纸色都不落盘', () => {
    const dir=mkdtempSync(join(tmpdir(),'bottle-layout-'));
    try {
      const file=join(dir,'bottle.json');const h=setup(file);const a=h.register('layout-a'),b=h.register('layout-b');
      const before=(h.call('GET','/quota',a.token).body as Quota).bottles_left;
      expect(h.call('POST','/throw',a.token,{body:'正文',stationery:{...layout,decorations:[...layout.decorations,{doodle:'rain-cloud',x:101}]}}).status).toBe(400);
      expect((h.call('GET','/quota',a.token).body as Quota).bottles_left).toBe(before);
      expect(h.call('POST','/throw',a.token,{body:'正文',stationery:layout}).status).toBe(200);
      const caught=h.call('POST','/catch',b.token).body as CatchRes;if(caught.empty)throw Error('no letter');
      expect(h.call('POST','/reply',b.token,{letterId:caught.letterId,body:'回音',stationery:layout}).status).toBe(200);
      const disk=readFileSync(file,'utf8');
      for(const text of ['stationery','decorations','rain-cloud','<svg','#fff7e8','#995566'])expect(disk).not.toContain(text);
      expect(h.db.letters[0].stationery).toBeTruthy();expect(h.db.replies[0].stationery).toBeTruthy();
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
});
