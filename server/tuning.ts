/**
 * 可热载的运行参数。
 *
 * 为什么要有它：这些数值改一次就该改一次，**不该为此重启进程**——重启就是海啸，
 * 而海啸会把海面上还漂着的信全拍碎。调一个数字的代价不该是这个。
 *
 * 读取顺序：`<数据目录>/tuning.json`（热载，5 秒 mtime 缓存）→ 环境变量 → 内置默认值。
 * 文件不在或解析失败就沿用上一次读到的值，绝不抛异常——调参不该把海搞挂。
 *
 * 形如 `{"seedsPerDay": 2, "seedsGlobalOnce": true, "seedsEnabled": true}`。
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface Tuning {
  /** 系统邮件每人每天最多几封。0 = 停发。 */
  seedsPerDay: number;
  /**
   * `true` = 同一封种子**全服**只能被领一次（一封信只属于一个人）。
   * `false` = 只按人去重（同一封可以被所有人各领一次）。
   */
  seedsGlobalOnce: boolean;
  /** 总开关。 */
  seedsEnabled: boolean;

  // ── 配额：以前只能靠环境变量，改一次要重启=一次海啸；现在一起热载 ──
  sendBase: number;
  sendCap: number;
  catchBase: number;
  catchCap: number;
  poolDivisor: number;
  /**
   * 每人每天最多回几封信。
   *
   * 为什么必须有这个闸：**回信是一封信离开海面的唯一大额出口**。
   * 寄信有上限（5），回信原本没有——于是每人每天理论上能永久消灭 10 封、只补 5 封，
   * 海会一直很薄，信当天被捞当天被回，「漂流」退化成「即时通讯」。
   *
   * 定在 3 有两个理由：
   *   · 刚好够把寄信额度顶到上限（sendBase 2 + 3 = 5），不挡正常用户
   *   · 留出 +2 封/人/天的净增长，让池子真的变厚
   */
  replyCap: number;
  /**
   * 同一只瓶子被扔回海里几次就裂开沉底。
   *
   * 默认值与 `shared/contract.ts` 的 `MAX_THROWS` 一致，但**以这里为准**——
   * 这样以后想调它不用再重启（重启就是海啸，代价太大）。
   */
  maxThrows: number;
  /**
   * 同一个 IP 在 `ipWindowMin` 分钟内最多能开几个号。
   *
   * 注意：这里的「IP」是**真实客户端 IP**（服务端会从 `X-Forwarded-For` 取）。
   * 早先版本读的是 `socket.remoteAddress`，在反代后面那永远是 127.0.0.1，
   * 于是这个限流变成了全服共用——群里一次发几十个人，第 4 个起全部被挡，
   * 而且客户端把它显示成「连不上海边」，看起来像网络故障。
   */
  ipLimit: number;
  /** 限流窗口，分钟。 */
  ipWindowMin: number;

  /**
   * 一封被捞起来的信，在手上最多待几小时；到点自动回海面。
   *
   * 为什么要有这个数：它直接决定「海面上有多少信」。信被捞走后就不在海上，
   * 要等回信（永久消失）或超时（回海）。窗口越长，卡在手上的信越多、海面越薄。
   *
   * 72 小时原本是给"人类真的会认真回一封信"留的余量，但实测中位回信只要
   * **1 分钟**——那 72 小时几乎全是"捞到就没再管"的僵尸时间。实测曾有 91 封
   * 信同时在 91 个人手上挂着，而海面只剩 17 封。
   *
   * 现在做成热载：想收紧就调小（比如 24），不用再重启（重启=海啸）。
   * 注意它只影响**新捞到的信**——已经捞走的信，`replyWindowUntil` 早已写死在
   * 数据里，改这个数不会追溯修改它们。
   */
  replyWindowHours: number;

  // ── 种子信的「当天随机时刻」（见 shared/seedSlots.ts）──

  /**
   * 每天摇几个时刻，以及摇出来的范围。
   *
   * 原来的实现是「额度归零后每 10 分钟试一次」，于是所有人的额度在午夜同时清零、
   * 半小时内集中领完（实测 00:00–00:37 堆了 161 次）。改成每天给每人摇几个
   * **不同的**时刻，全天摊开，也不会被摸清"我几点必来信"。
   *
   * `slotMax` 不会超过 `seedsPerDay`——上限仍然由它兜着。
   */
  seedSlotsMin: number;
  seedSlotsMax: number;
  /**
   * 当天发不发。1.0 = 每天发；0.5 = 隔天发。
   *
   * 这是留给自己的一颗**应急刹车**：如果种子库消耗得比预期快，把它调到 0.5
   * 就能立刻减半，改的是 tuning.json、5 秒生效、**不用重启**。
   */
  seedDailyChance: number;

  // ── 退潮：给重启用的运维开关 ──

  /**
   * 退潮期间禁止投递。
   *
   * 用途只有一个：**在准备重启服务器之前，把海面清空**。
   * 重启会把所有还漂着的信拍碎（一次海啸），所以先用这条闸停止注入，
   * 再等现有的信被捞走/回掉，然后重启——损失从"海面上有多少"降到"接近 0"。
   *
   * 三件事必须一起成立，否则它就是一颗地雷：
   *   1. **必须带 `until`**：到点自动失效。热载开关没有失效时间，等于给自己埋坑。
   *   2. 拒绝时返回的是「退潮」而不是错误码——它是世界里发生的事，不是 429。
   *   3. 只挡投递，**不挡捞取和回信**：回信才是让信永久离开海面的那个动作。
   */
  tideOut: TideOutSettings;

  /** 一句话公告。复用海啸那条通道（比对 id 只播一次）。 */
  announcement: Announcement | null;

  /**
   * 落地页的活动位：一句话 + 一个链接。
   *
   * **空字符串 = 什么都不渲染**（页面和没有这个功能时一模一样）。
   * 因为落地页模板有永久缓存（landingHtml() 只在启动时读一次），
   * 往模板里写死链接必须重启；放进 tuning 就能 5 秒热载。
   *
   * 安全：只接受 http/https、且不能带账号密码；文本会 HTML 转义。
   * 链接无效时**整块不渲染**，宁可少一个入口，也不要在公网页上放坏链接。
   */
  campaignLink: string;
  campaignText: string;
}

export interface TideOutSettings {
  /** 到点自动失效。ISO 时间字符串；空或写坏 = 立即视为未开启。 */
  until: string;
  /** 挡投递。 */
  blockThrow: boolean;
  /** 挡回信（一般不要开：回信是排空海面的主要手段）。 */
  blockReply: boolean;
  /** 说给玩家听的那句话。 */
  text: string;
}

export interface Announcement {
  /** 去重用的稳定 id。客户端只播一次。 */
  id: string;
  text: string;
  /** 只在这个时刻之前显示。 */
  showUntil: string;
  /** `notice` = 普通公告；`alarm` = 出事了的公告。 */
  level: 'notice' | 'alarm';
}

export const DEFAULT_TUNING: Tuning = {
  seedsPerDay: 2,
  seedsGlobalOnce: true,
  seedsEnabled: true,
  sendBase: 2,
  sendCap: 5,
  catchBase: 2,
  catchCap: 10,
  poolDivisor: 5,
  replyCap: 3,
  maxThrows: 8,
  ipLimit: 5,
  ipWindowMin: 60,
  // 与 shared/contract.ts 的 REPLY_WINDOW_HOURS 保持一致；以这里为准（可热载）
  replyWindowHours: 72,
  seedSlotsMin: 3,
  seedSlotsMax: 4,
  seedDailyChance: 1,
  tideOut: { until: '', blockThrow: false, blockReply: false, text: '' },
  announcement: null,
  campaignLink: '',
  campaignText: '',
};

export interface TuningReader {
  current(): Tuning;
}

/** 5 秒够用了：人手改文件不会快过这个节奏，也不会每个请求都 stat 一次。 */
const MTIME_CACHE_MS = 5_000;

export function makeTuningReader(
  file: string | null,
  env: NodeJS.ProcessEnv = process.env,
): TuningReader {
  let cached = readOnce(file, env);
  let stamp = -1;
  let checkedAt = 0;

  return {
    current(): Tuning {
      if (!file) return cached;
      const wall = Date.now();
      if (wall - checkedAt < MTIME_CACHE_MS) return cached;
      checkedAt = wall;
      try {
        const mtime = statSync(file).mtimeMs;
        if (mtime !== stamp) {
          stamp = mtime;
          cached = readOnce(file, env);
        }
      } catch {
        // 文件被删掉了：沿用上一次读到的值，不退回默认（那会让参数突然跳变）
      }
      return cached;
    },
  };
}

function readOnce(file: string | null, env: NodeJS.ProcessEnv): Tuning {
  let raw: Partial<Tuning> = {};
  if (file) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Tuning>;
    } catch {
      raw = {};
    }
  }
  const perDay = Number(raw.seedsPerDay ?? env.BOTTLE_SEEDS_PER_DAY ?? DEFAULT_TUNING.seedsPerDay);
  return {
    seedsPerDay: Number.isFinite(perDay) ? Math.max(0, Math.floor(perDay)) : DEFAULT_TUNING.seedsPerDay,
    seedsGlobalOnce: pickBool(raw.seedsGlobalOnce ?? env.BOTTLE_SEEDS_GLOBAL_ONCE, DEFAULT_TUNING.seedsGlobalOnce),
    seedsEnabled: pickBool(raw.seedsEnabled ?? env.BOTTLE_SEEDS_ENABLED, DEFAULT_TUNING.seedsEnabled),
    sendBase: pickInt(raw.sendBase ?? env.BOTTLE_SEND_BASE, DEFAULT_TUNING.sendBase, 0),
    sendCap: pickInt(raw.sendCap ?? env.BOTTLE_SEND_CAP, DEFAULT_TUNING.sendCap, 0),
    catchBase: pickInt(raw.catchBase ?? env.BOTTLE_CATCH_BASE, DEFAULT_TUNING.catchBase, 0),
    catchCap: pickInt(raw.catchCap ?? env.BOTTLE_CATCH_CAP, DEFAULT_TUNING.catchCap, 0),
    poolDivisor: pickInt(raw.poolDivisor ?? env.BOTTLE_POOL_DIVISOR, DEFAULT_TUNING.poolDivisor, 1),
    replyCap: pickInt(raw.replyCap ?? env.BOTTLE_REPLY_CAP, DEFAULT_TUNING.replyCap, 0),
    maxThrows: pickInt(raw.maxThrows ?? env.BOTTLE_MAX_THROWS, DEFAULT_TUNING.maxThrows, 1),
    ipLimit: pickInt(raw.ipLimit ?? env.BOTTLE_IP_LIMIT, DEFAULT_TUNING.ipLimit, 1),
    ipWindowMin: pickInt(
      raw.ipWindowMin ?? env.BOTTLE_IP_WINDOW_MIN,
      DEFAULT_TUNING.ipWindowMin,
      1,
    ),
    // 至少 1 小时：写 0 会让刚捞到的信立刻回海，等于捞了个空
    replyWindowHours: pickInt(
      raw.replyWindowHours ?? env.BOTTLE_REPLY_WINDOW_HOURS,
      DEFAULT_TUNING.replyWindowHours,
      1,
    ),
    seedSlotsMin: pickInt(raw.seedSlotsMin, DEFAULT_TUNING.seedSlotsMin, 0),
    seedSlotsMax: pickInt(raw.seedSlotsMax, DEFAULT_TUNING.seedSlotsMax, 0),
    seedDailyChance: pickChance(raw.seedDailyChance, DEFAULT_TUNING.seedDailyChance),
    tideOut: readTideOut(raw.tideOut),
    announcement: readAnnouncement(raw.announcement),
    campaignLink: pickText(raw.campaignLink),
    campaignText: pickText(raw.campaignText),
  };
}

/** 0~1 之间的小数；写坏了退回默认。 */
function pickChance(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

/**
 * 退潮开关。
 *
 * **`until` 写坏或已经过期，一律当成「没开」。**
 * 这一条是刻意做保守的：热载开关如果默认是"开"，一次笔误就能让全服寄不出信，
 * 而且没人知道为什么。宁可"该开的时候没开"，也不要"该关的时候关不掉"。
 */
function readTideOut(value: unknown): TideOutSettings {
  const raw = (value ?? {}) as Partial<TideOutSettings>;
  const until = typeof raw.until === 'string' ? raw.until.trim() : '';
  const expires = until ? Date.parse(until) : Number.NaN;
  const live = Number.isFinite(expires) && expires > Date.now();
  return {
    until,
    blockThrow: live && raw.blockThrow === true,
    blockReply: live && raw.blockReply === true,
    text: typeof raw.text === 'string' ? raw.text : '',
  };
}

/** 公告：`showUntil` 过期就当没有。同样保守。 */
function readAnnouncement(value: unknown): Announcement | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<Announcement>;
  if (typeof raw.id !== 'string' || !raw.id.trim()) return null;
  if (typeof raw.text !== 'string' || !raw.text.trim()) return null;
  const showUntil = typeof raw.showUntil === 'string' ? raw.showUntil.trim() : '';
  const expires = showUntil ? Date.parse(showUntil) : Number.NaN;
  if (!Number.isFinite(expires) || expires <= Date.now()) return null;
  return {
    id: raw.id.trim(),
    text: raw.text.trim(),
    showUntil,
    level: raw.level === 'alarm' ? 'alarm' : 'notice',
  };
}

/**
 * 取一个可选的短文本。非字符串、或超长（>300）都当成空。
 *
 * 为什么限长：这两个字段会直接出现在**公网可读**的落地页上，
 * 一个几万字的字符串会把首页撑坏，而且它多半是写错了。
 */
function pickText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > 300 ? '' : trimmed;
}

/** 非负整数，且不低于 `min`。写坏了就退回默认，绝不把海搞挂。 */
function pickInt(value: unknown, fallback: number, min: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

function pickBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  }
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

/** 数据目录里那个热载参数文件的默认位置。 */
export function tuningPathFor(dataFile: string | null): string | null {
  return dataFile ? resolve(dirname(dataFile), 'tuning.json') : null;
}
