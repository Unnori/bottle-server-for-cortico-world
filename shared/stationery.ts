/**
 * 信纸与装饰的唯一校验器。客户端寄出前、中央服务端收件时、客户端收信时都调用同一份代码。
 *
 * 自创 SVG 的处理原则是「解析 → 白名单 → 规范化输出」，不是「尽量删掉坏东西」：
 *   · 任何不在白名单里的元素、属性、实体、DOCTYPE、CDATA、处理指令都直接拒绝，不静默修补；
 *   · 输出是重新序列化的规范文本。预览、寄出、接收保存的都是这份文本，
 *     同一份输入永远得到同一份输出，确认后不会被悄悄改画。
 *   · 唯一允许的引用是本图内部的 `url(#id)`，只能用于 fill / stroke / clip-path。
 *     没有 href、style、class、事件属性，也没有任何外部 URL、图片或字体。
 *
 * 渲染端仍然只把它当图片（img）显示，不插入主文档；这里是第一道闸，不是唯一一道。
 */
import { STATIONERY_SVG_MAX_BYTES, STATIONERY_MAX_DECORATIONS, STATIONERY_SVG_TOTAL_MAX_BYTES, STATIONERY_MAX_BYTES, type Stationery, type StationeryDecoration } from './contract.ts';

export const STATIONERY_PAPERS = ['grid', 'line', 'plain'] as const;
export type StationeryPaper = typeof STATIONERY_PAPERS[number];
/** 原始输入的硬上限，防止在超大字符串上做无用功；规范化后另按 8 KiB 判定。 */
export const STATIONERY_SVG_RAW_MAX = 4 * STATIONERY_SVG_MAX_BYTES;
export const STATIONERY_SVG_MAX_ELEMENTS = 300;
export const STATIONERY_SVG_MAX_DEPTH = 16;
const DOODLE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const SVG_NS = 'http://www.w3.org/2000/svg';
const COLOR = /^#[0-9a-f]{6}$/i;
const PLACEMENTS = { 'top-left': [14, 14], 'top-right': [86, 14], 'bottom-left': [14, 86], 'bottom-right': [86, 86], center: [50, 50] } as const;
const SIZES = { small: 14, medium: 24, large: 48 } as const;

const ELEMENTS = new Set([
  'svg', 'g', 'defs',
  'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect',
  'text', 'tspan',
  'linearGradient', 'radialGradient', 'stop', 'clipPath',
]);
/** 只有这两种元素可以有文字内容；其他元素之间只允许空白。 */
const TEXT_ELEMENTS = new Set(['text', 'tspan']);

const ATTRIBUTES = new Set([
  'id', 'viewBox', 'preserveAspectRatio', 'width', 'height',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'dx', 'dy',
  'd', 'points', 'transform', 'offset',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit',
  'opacity', 'clip-path', 'clip-rule', 'clipPathUnits',
  'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod',
  'font-size', 'font-family', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing',
]);
/** 可以引用本图内部 id 的属性；值必须恰好是 `url(#id)`。 */
const REFERENCE_ATTRIBUTES = new Set(['fill', 'stroke', 'clip-path']);
const ID_VALUE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const LOCAL_REF = /^url\(#([A-Za-z][A-Za-z0-9_-]{0,63})\)$/;
/** 系统字体名而已：img 里的 SVG 不会下载字体，这里也不让写任何像地址的东西。 */
const FONT_FAMILY = /^[A-Za-z0-9 ,-]{1,64}$/;
const LONG_ATTRIBUTES = new Set(['d', 'points']);

export type SvgCheck = { ok: true; svg: string; bytes: number } | { ok: false; reason: string };

/** 校验并规范化一份自创 SVG。失败原因是给人和桌宠看的中文。 */
export function sanitizeSvg(input: unknown): SvgCheck {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, reason: '手账图是空的。' };
  if (input.length > STATIONERY_SVG_RAW_MAX) return { ok: false, reason: `手账图太大了，规范化后不能超过 ${STATIONERY_SVG_MAX_BYTES} 字节。` };
  try {
    const svg = serialize(parse(input));
    const bytes = new TextEncoder().encode(svg).length;
    if (bytes > STATIONERY_SVG_MAX_BYTES) return { ok: false, reason: `手账图规范化后有 ${bytes} 字节，上限是 ${STATIONERY_SVG_MAX_BYTES} 字节。可以简化线条，或改用内置图案。` };
    return { ok: true, svg, bytes };
  } catch (error) {
    return { ok: false, reason: error instanceof SvgRejected ? error.message : '手账图格式无法识别。' };
  }
}

export type StationeryCheck = { ok: true; value: Stationery | null } | { ok: false; reason: string };

/**
 * 校验整个 stationery 字段。`undefined`/`null` 表示不装饰（合法）。
 * 只有版本号、什么都没选，也按不装饰处理；未知字段直接丢弃，不转发。
 * `doodle` 只校验格式，不校验是否在本机目录里：收件端不认识的 ID 按普通信纸降级。
 */
export function checkStationery(input: unknown): StationeryCheck {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: '信纸设置格式不对。' };
  const raw = input as Record<string, unknown>;
  if (raw.v !== 1 && raw.v !== 2) return { ok: false, reason: '信纸设置版本不受支持。' };
  const layoutKeys = ['paperColor','decorations','color','x','y','width','rotation','opacity','layer','z','flipX','flipY','placement','size'];
  if (raw.v === 1 && layoutKeys.some(key => raw[key] !== undefined)) return { ok: false, reason: '颜色与排版参数需要使用信纸版本 v:2。' };
  const out: Stationery = { v: raw.v };
  if (raw.paper !== undefined) {
    if (!STATIONERY_PAPERS.includes(raw.paper as StationeryPaper)) return { ok: false, reason: '信纸只能是 grid、line 或 plain。' };
    out.paper = raw.paper as StationeryPaper;
  }
  if (raw.v === 2) {
    try {
      if (raw.paperColor !== undefined) {
        if (typeof raw.paperColor !== 'string' || !COLOR.test(raw.paperColor)) reject('纸色需要 #RRGGBB 格式。');
        out.paperColor = (raw.paperColor as string).toLowerCase();
      }
      let entries: unknown[] = [];
      const singleKeys = ['doodle','customSvg','color','x','y','width','rotation','opacity','layer','z','flipX','flipY','placement','size'];
      if (raw.decorations !== undefined) {
        if (!Array.isArray(raw.decorations) || raw.decorations.length > STATIONERY_MAX_DECORATIONS) reject(`一封信最多放 ${STATIONERY_MAX_DECORATIONS} 幅图案。`);
        if (singleKeys.some(key => raw[key] !== undefined)) reject('单图简写和 decorations 多图列表不能同时使用。');
        entries = raw.decorations as unknown[];
      } else if (singleKeys.some(key => raw[key] !== undefined)) entries = [raw];
      const decorations = Array.from(entries, checkDecoration);
      const total = decorations.reduce((n, d) => n + (d.customSvg ? new TextEncoder().encode(d.customSvg).length : 0), 0);
      if (total > STATIONERY_SVG_TOTAL_MAX_BYTES) reject(`整封信的自创图合计不能超过 ${STATIONERY_SVG_TOTAL_MAX_BYTES} 字节。`);
      if (decorations.length) out.decorations = decorations;
      if (new TextEncoder().encode(JSON.stringify(out)).length > STATIONERY_MAX_BYTES) reject('信纸排版数据太大，请简化图案。');
      return { ok: true, value: out.paper || out.paperColor || decorations.length ? out : null };
    } catch (error) {
      return { ok: false, reason: error instanceof SvgRejected ? error.message : '信纸排版格式不对。' };
    }
  }
  const hasDoodle = raw.doodle !== undefined, hasSvg = raw.customSvg !== undefined;
  if (hasDoodle && hasSvg) return { ok: false, reason: '内置图案和自创手账图只能二选一。' };
  if (hasDoodle) {
    if (typeof raw.doodle !== 'string' || !DOODLE_ID.test(raw.doodle)) return { ok: false, reason: '内置图案 ID 格式不对。' };
    out.doodle = raw.doodle;
  }
  if (hasSvg) {
    const svg = sanitizeSvg(raw.customSvg);
    if (!svg.ok) return svg;
    out.customSvg = svg.svg;
  }
  return { ok: true, value: out.paper || out.doodle || out.customSvg ? out : null };
}

function checkDecoration(input: unknown, index: number): StationeryDecoration {
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject('每幅图案都需要独立的设置。');
  const raw = input as Record<string, unknown>;
  if ((raw.doodle !== undefined) === (raw.customSvg !== undefined)) reject('每幅图案需要且只能选择一个 doodle 或 customSvg。');
  const out: StationeryDecoration = {};
  if (raw.doodle !== undefined) {
    if (typeof raw.doodle !== 'string' || !DOODLE_ID.test(raw.doodle)) reject('内置图案 ID 格式不对。');
    out.doodle = raw.doodle as string;
  }
  if (raw.color !== undefined) {
    if (typeof raw.color !== 'string' || !COLOR.test(raw.color)) reject('图案颜色需要 #RRGGBB 格式。');
    out.color = (raw.color as string).toLowerCase();
  }
  if (raw.customSvg !== undefined) {
    const svg = out.color ? recolorSvg(raw.customSvg, out.color) : sanitizeSvg(raw.customSvg);
    if (!svg.ok) reject(svg.reason);
    out.customSvg = (svg as Extract<SvgCheck, { ok: true }>).svg;
  }
  const placement = raw.placement === undefined ? 'bottom-right' : raw.placement;
  if (typeof placement !== 'string' || !Object.hasOwn(PLACEMENTS, placement)) reject('图案位置只支持四角或 center。');
  const size = raw.size === undefined ? 'medium' : raw.size;
  if (typeof size !== 'string' || !Object.hasOwn(SIZES, size)) reject('图案大小只支持 small、medium 或 large。');
  const [x, y] = PLACEMENTS[placement as keyof typeof PLACEMENTS];
  for (const [key, min, max, fallback] of [
    ['x',0,100,x], ['y',0,100,y], ['width',4,100,SIZES[size as keyof typeof SIZES]],
    ['rotation',-180,180,0], ['opacity',0,.65,.28], ['z',0,7,index],
  ] as const) {
    const value = raw[key] === undefined ? fallback : raw[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || key === 'z' && !Number.isInteger(value)) reject(`图案 ${key} 需要 ${min}—${max} 之间的${key === 'z' ? '整数' : '数值'}。`);
    out[key] = value as number;
  }
  if (raw.layer !== undefined && raw.layer !== 'behind' && raw.layer !== 'front') reject('图层只能是 behind 或 front。');
  out.layer = raw.layer === 'front' ? 'front' : 'behind';
  for (const key of ['flipX','flipY'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') reject(`${key} 需要布尔值。`);
    if (raw[key] !== undefined) out[key] = raw[key] as boolean;
  }
  return out;
}

/** 仅更换画笔颜色；留白、透明区域与内部渐变/裁剪引用保持原样。 */
export function recolorSvg(input: unknown, color: string): SvgCheck {
  if (!COLOR.test(color)) return { ok: false, reason: '图案颜色需要 #RRGGBB 格式。' };
  const checked = sanitizeSvg(input);
  if (!checked.ok) return checked;
  const root = parse(checked.svg);
  function visit(node: SvgNode): void {
    node.attrs = node.attrs.map(([key, value]) => {
      if (!['fill','stroke','stop-color'].includes(key) || /^(none|transparent|white|#fff|#ffffff|url\(#.+\))$/i.test(value)) return [key, value];
      return [key, color.toLowerCase()];
    });
    for (const child of node.children) if (typeof child !== 'string') visit(child);
  }
  visit(root);
  // SVG 的默认填充是黑色；显式补上，才能给省略 fill 的路径换色。
  if (!root.attrs.some(([key]) => key === 'fill')) root.attrs.push(['fill', color.toLowerCase()]);
  return sanitizeSvg(serialize(root));
}

/** 收件端：不合格的装饰丢掉，正文照常保存；`rejected` 让页面如实说明「图案没有显示」。 */
export function receivedStationery(input: unknown): { stationery?: Stationery; stationeryRejected?: true } {
  const checked = checkStationery(input);
  if (!checked.ok) return { stationeryRejected: true };
  return checked.value ? { stationery: checked.value } : {};
}

/** 本机读盘：已经校验过的旧数据也再过一遍，坏数据静默丢弃，不影响正文。 */
export function storedStationery(input: unknown): Stationery | undefined {
  const checked = checkStationery(input);
  return checked.ok && checked.value ? checked.value : undefined;
}

class SvgRejected extends Error {}
const reject = (message: string): never => { throw new SvgRejected(message); };

interface SvgNode { name: string; attrs: Array<[string, string]>; children: Array<SvgNode | string> }

function parse(input: string): SvgNode {
  let source = input.replace(/^﻿/, '').trim();
  const decl = /^<\?xml\b[^?]*\?>/.exec(source);
  if (decl) source = source.slice(decl[0].length);
  let pos = 0, elements = 0;
  const ids = new Set<string>(), refs = new Set<string>();
  const stack: SvgNode[] = [];
  let root: SvgNode | null = null;

  while (pos < source.length) {
    if (source.startsWith('<!--', pos)) {
      const end = source.indexOf('-->', pos + 4);
      if (end < 0) reject('手账图里有没有结束的注释。');
      pos = end + 3;
      continue;
    }
    if (source.startsWith('<!', pos) || source.startsWith('<?', pos)) reject('手账图不能包含 DOCTYPE、CDATA 或处理指令。');
    if (source.startsWith('</', pos)) {
      const match = /^<\/([A-Za-z][A-Za-z0-9]*)\s*>/.exec(source.slice(pos));
      if (!match) reject('手账图的结束标签格式不对。');
      const open = stack.pop();
      if (!open || open.name !== match![1]) reject('手账图的标签没有正确配对。');
      pos += match![0].length;
      continue;
    }
    if (source[pos] === '<') {
      const nameMatch = /^<([A-Za-z][A-Za-z0-9:]*)/.exec(source.slice(pos));
      if (!nameMatch) reject('手账图里有无法识别的 < 符号。');
      const name = nameMatch![1]!;
      if (!ELEMENTS.has(name)) reject(`手账图不支持 <${name}> 元素。`);
      if (root && stack.length === 0) reject('手账图只能有一个 <svg> 根元素。');
      if (!root && name !== 'svg') reject('手账图必须以 <svg> 开头。');
      if (++elements > STATIONERY_SVG_MAX_ELEMENTS) reject(`手账图的元素太多了（上限 ${STATIONERY_SVG_MAX_ELEMENTS} 个）。`);
      if (stack.length >= STATIONERY_SVG_MAX_DEPTH) reject('手账图嵌套太深了。');
      pos += nameMatch![0].length;
      const node: SvgNode = { name, attrs: [], children: [] };
      const seen = new Set<string>();
      let selfClosing = false;
      for (;;) {
        const space = /^\s*/.exec(source.slice(pos))![0];
        pos += space.length;
        if (source.startsWith('/>', pos)) { pos += 2; selfClosing = true; break; }
        if (source[pos] === '>') { pos += 1; break; }
        if (!space) reject('手账图的属性之间缺少空格。');
        const attr = /^([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(source.slice(pos));
        if (!attr) reject(`<${name}> 的属性必须写成 名称="值"。`);
        pos += attr![0].length;
        const key = attr![1]!, value = decodeText(attr![3] ?? attr![4] ?? '');
        if (seen.has(key)) reject(`<${name}> 有重复的 ${key} 属性。`);
        seen.add(key);
        if (key === 'xmlns') {
          if (name !== 'svg' || value !== SVG_NS) reject('手账图的 xmlns 只能是标准 SVG 命名空间。');
          continue; // 输出时统一补上
        }
        if (!ATTRIBUTES.has(key)) reject(`手账图不支持 ${key} 属性。`);
        node.attrs.push([key, checkValue(name, key, value, ids, refs)]);
      }
      if (stack.length) stack[stack.length - 1]!.children.push(node);
      else root = node;
      if (!selfClosing) stack.push(node);
      continue;
    }
    const next = source.indexOf('<', pos);
    const text = source.slice(pos, next < 0 ? source.length : next);
    pos = next < 0 ? source.length : next;
    if (!text.trim()) continue;
    const parent = stack[stack.length - 1];
    if (!parent || !TEXT_ELEMENTS.has(parent.name)) reject('手账图只能在 <text> 或 <tspan> 里写文字。');
    parent!.children.push(decodeText(text));
  }
  if (!root) reject('手账图必须有一个 <svg> 根元素。');
  if (stack.length) reject('手账图的标签没有闭合。');
  if (!root!.attrs.some(([key]) => key === 'viewBox')) reject('手账图的 <svg> 需要 viewBox，才能按信纸大小缩放。');
  for (const ref of refs) if (!ids.has(ref)) reject(`手账图引用了不存在的 #${ref}。`);
  return root!;
}

function checkValue(element: string, key: string, value: string, ids: Set<string>, refs: Set<string>): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) reject(`${key} 属性里有控制字符。`);
  if (value.length > (LONG_ATTRIBUTES.has(key) ? STATIONERY_SVG_MAX_BYTES : 256)) reject(`${key} 属性太长了。`);
  if (key === 'id') {
    if (!ID_VALUE.test(value)) reject('id 只能用字母开头的字母、数字、下划线或连字符。');
    if (ids.has(value)) reject(`id「${value}」重复了。`);
    ids.add(value);
    return value;
  }
  if (key === 'font-family' && !FONT_FAMILY.test(value)) reject('font-family 只能写系统字体名。');
  if (/url\s*\(/i.test(value)) {
    const ref = LOCAL_REF.exec(value);
    if (!ref || !REFERENCE_ATTRIBUTES.has(key)) reject(`<${element}> 的 ${key} 只能引用本图内部的 url(#id)，不能引用外部资源。`);
    refs.add(ref![1]!);
  }
  return value;
}

function decodeText(text: string): string {
  return text.replace(/&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z]+);|&/g, (whole, entity: string | undefined) => {
    if (!entity) return reject('手账图里有未转义的 & 符号。');
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    if (entity[0] === '#') {
      const code = entity[1] === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      if (code === 0x9 || code === 0xA || code === 0xD || code >= 0x20 && code <= 0xD7FF || code >= 0xE000 && code <= 0x10FFFF) return String.fromCodePoint(code);
    }
    return reject(`手账图不支持 ${whole} 这种实体。`);
  });
}

const escapeText = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (value: string): string => escapeText(value).replace(/"/g, '&quot;');

function serialize(node: SvgNode): string {
  const attrs = (node.name === 'svg' ? [['xmlns', SVG_NS] as [string, string], ...node.attrs] : node.attrs)
    .map(([key, value]) => ` ${key}="${escapeAttr(value.replace(/\s+/g, ' ').trim())}"`).join('');
  if (!node.children.length) return `<${node.name}${attrs}/>`;
  const inner = node.children.map(child => typeof child === 'string' ? escapeText(child) : serialize(child)).join('');
  return `<${node.name}${attrs}>${inner}</${node.name}>`;
}
