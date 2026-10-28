/**
 * 独立进程的漂流瓶服务端。
 *
 *   pnpm server
 *   PORT=8787 HOST=0.0.0.0 BOTTLE_DATA=./data/bottle.json pnpm server
 *
 * 两台机器验收时，`HOST=0.0.0.0` 让别人连得进来；只在本机验证就留 127.0.0.1。
 *
 * 真正的装配在 `createBottleServer()` 里，`startBottleServer()` 才监听端口——
 * 这样端到端测试能拿到同一个装配，而不用复制一遍这里的接线。
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { seaStateAt } from '../shared/tide.ts';
import { createApi, type Api } from './app.ts';
import { Db } from './db.ts';
import { SeedStore } from './seeds.ts';
import { makeTuningReader, tuningPathFor } from './tuning.ts';

const MAX_BODY = 16 * 1024;

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(text));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/**
 * 落地页：根路径上那一页静态说明。
 *
 * 它和 API 完全隔离——不读数据库、不认 token、不回显任何请求参数。
 * 打开它的人不该能从这一页推出「这台机器上有什么」。
 */
let landingCache: string | null = null;

function landingHtml(): string {
  if (landingCache !== null) return landingCache;
  try {
    landingCache = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
  } catch {
    // 文件没打包进去也不该让服务挂掉：给一句最小的话
    landingCache =
      '<!doctype html><meta charset="utf-8"><title>漂流瓶</title>' +
      '<p style="font-family:sans-serif;padding:2rem">漂流瓶 · 中转服务。这里不提供网页界面。</p>';
  }
  return landingCache;
}

function sendHtml(res: ServerResponse, status: number, html: string, headOnly = false): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    // 一页几乎不会变的说明，让浏览器和 Caddy 缓存几分钟就够了
    'cache-control': 'public, max-age=300',
    // 它只显示文字，不需要执行任何东西
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  // HEAD 只回头，不返 body（但要带正确的 content-length）
  res.end(headOnly ? undefined : html);
}

/** 大屏读的那个文件，由 `snapshot` 脚本每天原子覆写。 */
const STATS_JSON = fileURLToPath(new URL('./public/stats.json', import.meta.url));

/**
 * 大屏的数据源：一个**静态文件**，里面只有盲化后的数字。
 *
 * 它不是接口——不读数据库、不认 token、不回显请求参数，和大屏要的「只给数字」正好对上。
 * 还没生成时给 503，别让大屏把「没有文件」误读成「海上真的空了」。
 */
function sendStatsJson(res: ServerResponse, headOnly = false): void {
  let text: string;
  try {
    text = readFileSync(STATS_JSON, 'utf8');
  } catch {
    send(res, 503, { error: 'not_ready', message: '还没有生成统计快照。' });
    return;
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'public, max-age=60',
    'x-content-type-options': 'nosniff',
  });
  res.end(headOnly ? undefined : text);
}

/**
 * 落地页里那一段「此刻的海」。
 *
 * 服务端在发页之前把数字**填进 HTML**，而不是让浏览器去 fetch：
 * 这样这一页仍然是纯静态文字，CSP 可以继续是 `default-src 'none'`，一行 JS 都不用。
 */
function renderSeaBlock(db: Db, at: number): string {
  const sea = seaStateAt(at);
  const t = db.tsunamiSummary();
  const tide = sea.tide.state === '平' ? '潮水很稳' : `${sea.tide.state}潮`;
  const waves =
    t.count === 0
      ? '这片海还没有起过浪。'
      : `这片海经历过 ${t.count} 次浪，最近一次在 ${Math.max(
          0,
          Math.floor((at - (t.lastAt ?? at)) / 86_400_000),
        )} 天前，一共拍碎了 ${t.totalLost} 个瓶子。`;
  return (
    '<div class="surprise"><b>栖潮海 · 第 ' +
    `${sea.day} 天</b><br>` +
    `此刻${tide}，潮位 ${sea.tide.level}；${sea.wind.dir}风 ${sea.wind.level} 级；` +
    `${sea.moon.name}；能见度${sea.visibility}；水温 ${sea.waterTempC}℃。<br>${waves}</div>`
  );
}

/** 把海况填进落地页模板。模板只读一次，填充是纯字符串替换。 */
function landingPage(db: Db, at: number): string {
  return landingHtml().replace('<!--SEA-->', renderSeaBlock(db, at));
}

export interface BottleServerOptions {
  /** 数据文件；`null` 是纯内存（测试用）。 */
  dataFile: string | null;
  /** 种子目录；`null` = 完全没有种子。 */
  seedsDir: string | null;
  log?: (line: string) => void;
}

export interface BottleServer {
  api: Api;
  db: Db;
  seeds: SeedStore;
  /** 还没 listen 的 http.Server，调用方自己决定端口。 */
  server: Server;
  close(): Promise<void>;
}

/**
 * 这次重启算「计划内」还是「意外」。
 *
 * 运维在重启前写下原因，两种写法都行：
 *   · 环境变量 `BOTTLE_TSUNAMI_REASON="上线 v0.2"`
 *   · 往数据目录丢一个 `next-tsunami-reason.txt`（启动时被读走并删除，只对这一次生效）
 *
 * 两个都没有，就记成 `unplanned` —— 那通常意味着崩溃、断电或 OOM，是唯一需要人
 * 事后看一眼的那一类。**没有这个字段，「计划发布」和「意外崩溃」在日志里长得一模一样。**
 */
function consumeTsunamiReason(dataFile: string | null): string | undefined {
  const fromEnv = process.env.BOTTLE_TSUNAMI_REASON?.trim();
  if (fromEnv) return fromEnv;
  if (!dataFile) return undefined;
  const path = resolve(dirname(dataFile), 'next-tsunami-reason.txt');
  try {
    if (!existsSync(path)) return undefined;
    const text = readFileSync(path, 'utf8').trim();
    unlinkSync(path);
    return text || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 装配一个服务端，但不监听端口。`startBottleServer()` 与端到端测试都用它，
 * 所以「测试跑的那一套」和「线上跑的那一套」是同一份代码。
 */
export function createBottleServer(opts: BottleServerOptions): BottleServer {
  const db = opts.dataFile
    ? Db.open(opts.dataFile, { tsunamiReason: consumeTsunamiReason(opts.dataFile) })
    : Db.open(null);
  const seeds = new SeedStore({ dir: opts.seedsDir, log: (line) => opts.log?.(line) });
  seeds.start();

  const api = createApi(db, {
    seeds,
    // 系统邮件走独立通道：不占捞取额度，也不再由 `/catch` 兜底
    seedChannel: 'mail',
    // 每天几封、全服去重开不开都在这个热载文件里：调参不用重启，因而不用海啸
    tuning: makeTuningReader(tuningPathFor(opts.dataFile)),
  });

  const server = createServer((req, res) => {
    void (async () => {
      const method = (req.method ?? 'GET').toUpperCase();
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      const auth = req.headers.authorization ?? '';
      const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : undefined;
      const ip = req.socket.remoteAddress ?? 'unknown';

      let body: unknown;
      if (method === 'POST') {
        try {
          body = await readJson(req);
        } catch (error) {
          send(res, 400, {
            error: 'bad_request',
            message:
              error instanceof Error && error.message === 'body too large' ? '请求太大了。' : '请求体不是 JSON。',
          });
          return;
        }
      }

      try {
        // 根路径是给「不小心点进来的人」看的：一页静态说明，不是 API。
        // 只认 GET /，且不碰任何鉴权与数据——它必须是这个服务里最安全的一跳。
        //
        // HEAD 也要认：`curl -I`、反代健康检查、部分浏览器预检都发 HEAD，
        // 落到 401 分支会让运维误判「服务挂了」。
        if ((method === 'GET' || method === 'HEAD') && (path === '/' || path === '/index.html')) {
          // 把「此刻的海」填进去：页面因此每天都不一样，但依然没有一行 JS
          sendHtml(res, 200, landingPage(db, Date.now()), method === 'HEAD');
          return;
        }
        // 大屏的数据源。和落地页一样是「纯静态一跳」：不认 token、不碰数据库。
        if ((method === 'GET' || method === 'HEAD') && path === '/stats.json') {
          sendStatsJson(res, method === 'HEAD');
          return;
        }
        // 浏览器顺手要的，给个空图省得日志里一堆 404
        if ((method === 'GET' || method === 'HEAD') && path === '/favicon.ico') {
          res.writeHead(204, { 'cache-control': 'public, max-age=86400' });
          res.end();
          return;
        }

        const result = api.handle({ method, path, token, ip, body });
        send(res, result.status, result.body);
      } catch (error) {
        opts.log?.(`请求处理失败 ${error instanceof Error ? error.name : 'unknown'}`);
        send(res, 500, { error: 'internal', message: '海边出了点问题。' });
      }
    })();
  });

  return {
    api,
    db,
    seeds,
    server,
    close: () =>
      new Promise<void>((done) => {
        seeds.stop();
        db.save();
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}

/** 监听端口。`port` 传 0 让系统分配，测试用。 */
export async function startBottleServer(
  opts: BottleServerOptions & { port: number; host: string },
): Promise<BottleServer & { port: number; host: string }> {
  const built = createBottleServer(opts);
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error): void => reject(error);
    built.server.once('error', onError);
    built.server.listen(opts.port, opts.host, () => {
      built.server.off('error', onError);
      resolvePromise();
    });
  });
  const address = built.server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  return { ...built, port, host: opts.host };
}

/** 被 `node server/main.ts` 直接跑时才执行；被 import 时不碰进程。 */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
}

async function cli(): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? '8787', 10);
  const host = process.env.HOST ?? '0.0.0.0';
  const dataFile = resolve(process.env.BOTTLE_DATA ?? resolve(process.cwd(), 'data', 'bottle.json'));
  /** 种子目录可以挂成 git clone，另由 cron / systemd timer 定时 pull（§13.5）。 */
  const seedsDir = resolve(process.env.BOTTLE_SEEDS_DIR ?? resolve(process.cwd(), 'seeds'));

  const running = await startBottleServer({
    dataFile,
    seedsDir,
    port,
    host,
    log: (line) => console.log(`[bottle] ${line}`),
  });

  const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
  console.log(`[bottle] 海边在 http://${shown}:${running.port}/ ，数据写在 ${dataFile}`);
  console.log('[bottle] 老信的字只在内存里：重启即丢，这是有意的。');
  const stats = running.seeds.stats();
  console.log(`[bottle] 种子 ${stats.count} 封（第 ${stats.generation} 代），目录 ${seedsDir}；改文件会热载，不用重启。`);
  console.log(`[bottle] 运维探针 http://${shown}:${running.port}/health （含 uptime 与种子代次）。`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void running.close().then(() => process.exit(0));
    });
  }
}

if (isMain()) void cli();
