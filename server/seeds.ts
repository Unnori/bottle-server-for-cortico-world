/**
 * 种子瓶（§13）：海边邮局预先放进海里的信，真人信不够时补位。
 *
 * **内容与状态分离**：正文只从 `seeds/*.json` 读，谁见过谁只记在 `seeds_used` 表里。
 * 所以服务端重启（正文海啸）之后，正文从文件原样回来，去重一条也不会丢。
 *
 * **热载不重启**：目录变化时重新读一遍，逐文件校验；解析失败的文件保留上一版，
 * 坏的条目跳过并记日志。整个过程不抛异常——种子是兜底，绝不能把海搞挂。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { SEED_FROM } from '../shared/text.ts';

/** 种子信是作者手写的，可以比桌宠的 120 字长，但也不能是一篇文章。 */
export const SEED_BODY_MAX = 400;
/**
 * 固定的来源名。种子绝不伪装成某个用户。
 * 定义在 `shared/text.ts`，因为页面与卡片也要认它；这里转出去，免得两处各写一份。
 */
export { SEED_FROM };

export interface SeedLetter {
  id: string;
  body: string;
  /** 落款，可选。显示时附在正文后面，不替代「海边邮局」这个来源。 */
  signature?: string;
  /** 主题，可选。只当一行小标签用。 */
  topic?: string;
  /** 来自哪个文件；热载时按文件保留旧版。 */
  file: string;
}

export interface SeedStats {
  dir: string;
  count: number;
  /** 内容真的变了才 +1；验收时看它有没有热载成功。 */
  generation: number;
  /** 上一次内容变化的毫秒时间戳。 */
  loadedAt: number;
  errors: string[];
}

export interface SeedStoreOptions {
  /** null = 完全不用种子。 */
  dir: string | null;
  maxChars?: number;
  log?: (line: string) => void;
  /** fs.watch 漏事件时的兜底扫描间隔；默认 30 秒，远小于验收要求的 5 分钟。 */
  pollMs?: number;
}

export class SeedStore {
  private byFile = new Map<string, SeedLetter[]>();
  private seeds: SeedLetter[] = [];
  private errors: string[] = [];
  private generation = 0;
  private loadedAt = 0;
  private fingerprint = '';
  private watcher: FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;

  /** 普通字段赋值，不用参数属性：`node --experimental-strip-types` 不支持（见 `db.ts` 同一处注释）。 */
  private readonly opts: SeedStoreOptions;

  constructor(opts: SeedStoreOptions) {
    this.opts = opts;
  }

  /** 读一遍并挂上监听。失败也不会挡住服务端起来。 */
  start(): void {
    this.reload();
    if (!this.opts.dir) return;
    try {
      mkdirSync(this.opts.dir, { recursive: true });
    } catch {
      // 目录建不起来也只是没有种子
    }
    try {
      this.watcher = watch(this.opts.dir, { persistent: false }, () => this.schedule());
    } catch {
      // 有轮询兜底
    }
    this.poll = setInterval(() => this.reload(), this.opts.pollMs ?? 30_000);
    this.poll.unref?.();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.debounce) clearTimeout(this.debounce);
    if (this.poll) clearInterval(this.poll);
    this.debounce = null;
    this.poll = null;
  }

  /** 立即重读。返回是否顺利读完（不表示内容有没有变）。 */
  reload(): boolean {
    const dir = this.opts.dir;
    if (!dir) return false;
    if (!existsSync(dir)) {
      this.errors = [`种子目录不存在：${dir}`];
      this.log(`seeds: 目录不存在 ${dir}`);
      return false;
    }

    let names: string[];
    try {
      names = readdirSync(dir)
        .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
        .sort();
    } catch (error) {
      this.errors = ['种子目录读不了，保留上一版。'];
      this.log(`seeds: 读目录失败 ${error instanceof Error ? error.name : 'unknown'}`);
      return false;
    }

    const maxChars = this.opts.maxChars ?? SEED_BODY_MAX;
    const nextByFile = new Map<string, SeedLetter[]>();
    const errors: string[] = [];
    const seen = new Set<string>();

    for (const name of names) {
      const path = join(dir, name);
      let raw: string;
      try {
        raw = readFileSync(path, 'utf8');
      } catch {
        errors.push(`${name}：读不了，保留上一版`);
        const old = this.byFile.get(name);
        if (old) nextByFile.set(name, old);
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // git pull 拉到一半、手滑写坏 JSON，都不该让海里的种子凭空消失
        errors.push(`${name}：JSON 解析失败，保留上一版`);
        const old = this.byFile.get(name);
        if (old) nextByFile.set(name, old);
        continue;
      }

      const items = Array.isArray(parsed) ? parsed : [parsed];
      const list: SeedLetter[] = [];
      items.forEach((item, index) => {
        const seed = normalizeSeed(item, name, maxChars);
        if (!seed) {
          errors.push(`${name}：第 ${index + 1} 条不合格，跳过`);
          return;
        }
        if (seen.has(seed.id)) {
          errors.push(`${name}：id「${seed.id}」和前面的重复，跳过`);
          return;
        }
        seen.add(seed.id);
        list.push(seed);
      });
      nextByFile.set(name, list);
    }

    this.byFile = nextByFile;
    this.seeds = [...nextByFile.values()].flat();
    this.errors = errors;

    const fingerprint = JSON.stringify(this.seeds.map((s) => [s.id, s.body, s.signature ?? '', s.topic ?? '']));
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.generation += 1;
      this.loadedAt = Date.now();
      this.log(`seeds: 第 ${this.generation} 代，${this.seeds.length} 封`);
    }
    if (errors.length) this.log(`seeds: ${errors.join('；')}`);
    return true;
  }

  list(): SeedLetter[] {
    return this.seeds;
  }

  get(id: string): SeedLetter | undefined {
    return this.seeds.find((seed) => seed.id === id);
  }

  stats(): SeedStats {
    return {
      dir: this.opts.dir ?? '',
      count: this.seeds.length,
      generation: this.generation,
      loadedAt: this.loadedAt,
      errors: [...this.errors],
    };
  }

  private schedule(): void {
    if (this.debounce) clearTimeout(this.debounce);
    // 编辑器与 git 常常连续写好几下，合一次读就够
    this.debounce = setTimeout(() => this.reload(), 250);
    this.debounce.unref?.();
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }
}

function normalizeSeed(value: unknown, file: string, maxChars: number): SeedLetter | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;

  const id = typeof obj.id === 'string' ? obj.id.trim() : '';
  // id 要进 /letter/{id} 的路径，限死在安全字符里；改名等于一封新种子
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;

  const body = typeof obj.body === 'string' ? obj.body.replace(/\r\n/g, '\n').trim() : '';
  if (!body) return null;
  if ([...body].length > maxChars) return null;

  const signature = typeof obj.signature === 'string' ? obj.signature.trim() : '';
  const topic = typeof obj.topic === 'string' ? obj.topic.trim() : '';

  return {
    id,
    body,
    ...(signature ? { signature: [...signature].slice(0, 40).join('') } : {}),
    ...(topic ? { topic: [...topic].slice(0, 20).join('') } : {}),
    file,
  };
}
