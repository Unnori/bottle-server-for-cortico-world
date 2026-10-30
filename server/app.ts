/**
 * 服务端的路由。全部是纯函数式的请求/响应，HTTP 适配在 `main.ts` 里，
 * 所以测试不用起 socket。
 *
 * 一条贯穿全文件的规矩：**请求体里的 time / count 一律不看**，所有判定都读服务端的时钟与计数。
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  MAX_THROWS,
  REPLY_WINDOW_HOURS,
  type CatchRes,
  type DeadLetter,
  type DismissRes,
  type ErrorCode,
  type MailboxItem,
  type Quota,
} from '../shared/contract.ts';
import { checkBody } from '../shared/text.ts';
import { seaStateAt } from '../shared/tide.ts';
import { type Db, type BotRow, type LetterRow } from './db.ts';
import { computeQuota, resetDaily, rulesFromEnv, DEFAULT_RULES, type QuotaRules } from './quota.ts';
import { SEED_FROM, type SeedLetter, type SeedStore } from './seeds.ts';
import { makeTuningReader, type Tuning, type TuningReader } from './tuning.ts';

const HOUR = 3_600_000;

export interface ApiRequest {
  method: string;
  /** 只有路径，不含查询串。 */
  path: string;
  token?: string;
  ip: string;
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface ApiOptions {
  rules?: QuotaRules;
  /** 服务器时区；`lastResetDate` 按它算。 */
  timeZone?: string;
  now?: () => number;
  random?: () => number;
  newToken?: () => string;
  newId?: (prefix: string) => string;
  newPseudonym?: () => string;
  /** 同一个 IP 每小时最多新建几个号（§2 的替代闸门）。 */
  ipLimit?: number;
  ipWindowMs?: number;
  /** 海边邮局的种子库；不传就是完全没有种子，行为与旧版一致。 */
  seeds?: SeedStore;
  /** 每人一辈子最多捞到几封种子（§13.4，默认 2）。只在 `seedChannel: 'catch'` 时生效。 */
  seedsPerUserMax?: number;
  /**
   * 种子走哪条通道：
   *   · `mail`（现行）：独立系统邮件，**不占捞取额度**，每天限几封
   *   · `catch`（旧）：捞瓶子时兜底补位，占额度
   */
  seedChannel?: 'mail' | 'catch';
  /** 可热载的运行参数（每天几封、全服去重开不开）；不传就读环境变量/内置默认值。 */
  tuning?: TuningReader;
  /** `/health` 要报 uptime；缺省取创建这一刻。 */
  startedAt?: number;
}

export interface Api {
  handle(req: ApiRequest): ApiResponse;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 服务器时区里的 YYYY-MM-DD。`en-CA` 正好是这个形状。 */
export function dayIn(timeZone: string, at: number): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

/**
 * 化名词库（栖潮海世界观）。
 *
 * 命名格式：`形容词 + 名词 + #四位数字`，例如 `漏雨试航员#4857`、`千灯旅人#7218`。
 *
 * 四条约定：
 *   1. **词性要对**：前面是修饰（地名 / 天气 / 材质 / 状态），后面是身份或物件。
 *      任意两两组合都要能读通——这是随机组合的硬约束，不能只挑好看的搭配。
 *   2. **只加不改**：已有玩家已经顶着某个化名了，删词不会改他们的名字，
 *      但会让「新玩家」的词感漂移。所以扩充时只往后加，不动前面的。
 *   3. **不碰身份**：AI 不冒充真人，所以这里只取地名、天气、物件、职业，
 *      **不取角色名**（简伯、阿衡、小满…）——那是具体的居民，不能被随机分配。
 *   4. **两库不重词**：同一个词同时出现在两边会拼出「潮签潮签」这种。
 *      `tests/pseudonym.test.ts` 会守这一条。
 *
 * 数量：60 × 60 × 9000 = 3240 万种组合。
 */
const ADJECTIVES = [
  // ── 第一批（0.1.0 就有，保留原样）──
  '海盐', '青柠', '北岛', '白鲸', '远山', '潮汐', '雾灯', '沙丘', '松针', '冷杉',
  '橘子', '薄荷', '星野', '铁锚', '礁石', '木棉', '琥珀', '云杉', '灯塔', '雨棚',
  // ── 栖潮海地名 ──
  // 注意：`岸讯` 不放这里。它是即时网络的名字（像品牌），
  // 塞进人名会拼出「岸讯邮差」这种像在打广告的东西。
  '灯芯', '北岬', '雨锈', '南汀', '回声', '晚市', '西岸', '外海', '千灯',
  // ── 潮与天气 ──
  '退潮', '涨潮', '半潮', '晚潮', '小潮', '深水', '浅滩', '碎浪', '风口', '雾中', '白雾', '退雾',
  // ── 材质与旧物 ──
  '渡口', '旧码头', '盐霜', '铁锈', '湿柴', '漏雨', '空瓶', '锚地', '夜航',
  // ── 状态（v2.0 新增：不够体面但真实的状态）──
  '补丁', '旧漆', '晚渡', '未寄', '初霜', '潮签', '长明', '值更', '背风', '换灯',
];

const NOUNS = [
  // ── 第一批（0.1.0 就有，保留原样）──
  '大福', '汽水', '邮差', '水手', '旅人', '风筝', '盐粒', '陶罐', '信使', '候鸟',
  '船票', '贝壳', '气泡', '柠檬', '布丁', '纸鹤', '风铃', '麦芽', '月亮', '回形针',
  // ── 邮局与海图 ──
  '分信员', '海图', '瓶中信', '旧船票', '值夜人', '守钟人', '记账员', '留门人', '灯守', '雾号',
  // ── 岛上职业 ──
  '检修师', '学徒', '渡船', '摆渡人', '看灯人', '看潮人', '补网人', '拾荒者', '试航员', '漆工',
  // ── 具体物件 ──
  '螺壳', '面店', '浮田', '钟声', '缆绳', '零件商', '雨衣', '手电', '罐头', '浮标',
  // ── v2.0 新增：船上、码头、市集上真有的东西 ──
  '灯油', '铜铃', '仓单', '旧信', '糖水', '缆桩', '桅灯', '鱼干', '修伞铺', '礁民',
];

/**
 * 不许拼出来的组合。
 *
 * 这些词两两相加**正好等于**世界观里的专有名词：
 *   千灯 + 海图 = 《千灯海图》（长期主线那座公共海图）
 *   南汀 + 浮田 = 南汀浮田（第八节的内容区域）
 *
 * 随机化名如果生成「千灯海图#1234」，读起来就像那个工程被降格成了一个人的名字。
 * 所以撞上就重摇——比起删词，这样既保住了词汇，也不会漏掉以后新加的。
 */
const RESERVED_COMBOS = new Set(['千灯海图', '南汀浮田']);

function pick<T>(list: readonly T[], random: () => number): T {
  return list[Math.floor(random() * list.length) % list.length]!;
}

export function makePseudonym(random: () => number = Math.random): string {
  const digits = () => 1000 + Math.floor(random() * 9000);
  // 撞专名的概率是 2/3600，摇 8 次还撞上基本不可能；
  // 真撞了就接受，不为了极端情况卡死调用方。
  for (let attempt = 0; attempt < 8; attempt++) {
    const a = pick(ADJECTIVES, random);
    const n = pick(NOUNS, random);
    if (RESERVED_COMBOS.has(a + n)) continue;
    return `${a}${n}#${digits()}`;
  }
  return `${pick(ADJECTIVES, random)}${pick(NOUNS, random)}#${digits()}`;
}

const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const fail = (status: number, error: ErrorCode, message: string): ApiResponse => ({
  status,
  body: { error, message },
});

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function createApi(db: Db, options: ApiOptions = {}): Api {
  let rules = options.rules ?? rulesFromEnv();
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const timeZone = options.timeZone ?? process.env.BOTTLE_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const newToken = options.newToken ?? (() => randomBytes(24).toString('base64url'));
  const newId = options.newId ?? ((prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`);
  const newPseudonym = options.newPseudonym ?? (() => makePseudonym(random));
  // 限流参数（每 IP 几个号 / 窗口多长）现在是热载的，见 noteRegistration()。
  // 不再写成常量：这个数以前写死 3，配合「反代后所有请求都来自 127.0.0.1」，
  // 等于把全服新用户挡在每小时 3 个——调它不该再付一次重启。
  const seeds = options.seeds;
  const seedsPerUserMax = options.seedsPerUserMax ?? envInt('BOTTLE_SEEDS_PER_USER_MAX', 2);
  const seedChannel = options.seedChannel ?? 'catch';
  const tuning = options.tuning ?? makeTuningReader(null);
  const currentTuning = (): Tuning => tuning.current();

  /**
   * 把配额参数也接上热载。
   *
   * 以前这五个数只能靠环境变量，改一次要 `daemon-reload` + 重启 = 一次海啸。
   * 调一个数字的代价不该是「把海面上还漂着的信全拍碎」。现在改 `tuning.json` 就生效。
   * 调用方（测试）显式传了 `rules` 就不覆盖。
   */
  function refreshRules(): void {
    if (options.rules) return;
    const t = currentTuning();
    rules = {
      sendBase: t.sendBase,
      sendCap: t.sendCap,
      catchBase: t.catchBase,
      catchCap: t.catchCap,
      poolDivisor: t.poolDivisor,
      replyCap: t.replyCap,
      maxThrows: t.maxThrows,
    };
  }
  const startedAt = options.startedAt ?? now();

  /** 只活在内存里：重启即清，和正文同一条叙事。 */
  const registrations = new Map<string, number[]>();

  /** 当前生效的注册限流（热载）。 */
  function ipLimitNow(): { limit: number; windowMin: number } {
    const t = currentTuning();
    return {
      limit: options.ipLimit ?? t.ipLimit,
      windowMin: options.ipWindowMs ? Math.round(options.ipWindowMs / 60_000) : t.ipWindowMin,
    };
  }

  function noteRegistration(ip: string, at: number): boolean {
    // 每次读热载参数：改 tuning.json 5 秒后生效，不用重启
    const { limit, windowMin } = ipLimitNow();
    const windowMs = windowMin * 60_000;
    const recent = (registrations.get(ip) ?? []).filter((ts) => at - ts < windowMs);
    if (recent.length >= limit) {
      registrations.set(ip, recent);
      return false;
    }
    recent.push(at);
    registrations.set(ip, recent);
    return true;
  }

  function pseudonymOf(clientHash: string | null): string {
    if (!clientHash) return '一位陌生人';
    return db.botByClientHash(clientHash)?.pseudonym ?? '一位陌生人';
  }

  /** 池子里此刻真能捞的信：不是我写的、浮着、正文还在、今天没被我扔回去过。 */
  function poolFor(bot: BotRow): LetterRow[] {
    const dismissed = bot.dismissedToday ?? [];
    return db.letters.filter(
      (letter) =>
        letter.state === 'floating' &&
        letter.authorHash !== bot.clientHash &&
        letter.body !== '' &&
        !dismissed.includes(letter.id),
    );
  }

  function quotaFor(bot: BotRow): Quota {
    return computeQuota(bot, poolFor(bot).length, rules);
  }

  /** 让一封捞起来的信回海。扔回海里算一次；72 小时超时不算。 */
  function toSea(letter: LetterRow): void {
    // 正文没了的信不能回海：`poolFor` 要求 body 非空，所以它谁都捞不到，
    // 却会一直算在「漂着」里，把那个数字撑得虚高——这就是僵尸信。收掉它。
    if (!letter.body) {
      letter.state = 'archived';
      letter.archivedReason = 'empty';
      letter.catcherHash = null;
      letter.caughtAt = null;
      letter.replyWindowUntil = null;
      return;
    }
    letter.state = 'floating';
    letter.catcherHash = null;
    letter.caughtAt = null;
    letter.replyWindowUntil = null;
    // 回海了就不再是「已归档」：死法标记要清掉，否则统计会把回海的信算成沉底
    letter.archivedReason = undefined;
  }

  /** 裂开沉底：不再出现在任何人的海里。 */
  function sink(letter: LetterRow): void {
    letter.state = 'archived';
    letter.archivedReason = 'sunk';
    letter.catcherHash = null;
    letter.caughtAt = null;
    letter.replyWindowUntil = null;
  }

  /** 72 小时到点的信回海。惰性执行：每次请求顺手扫一遍，不另起定时器。 */
  function sweep(at: number): boolean {
    let changed = false;
    for (const letter of db.letters) {
      if (letter.state === 'caught' && letter.replyWindowUntil !== null && letter.replyWindowUntil <= at) {
        toSea(letter);
        changed = true;
      }
    }
    return changed;
  }

  function authenticate(token: string | undefined): BotRow | null {
    if (!token) return null;
    return db.botByTokenHash(sha256(token)) ?? null;
  }

  function handleRegister(req: ApiRequest): ApiResponse {
    const body = asObject(req.body);
    const hash = typeof body?.hash === 'string' ? body.hash.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return fail(400, 'bad_request', 'register 需要 hash(clientId) 的 sha256 十六进制。');
    }

    const existing = db.botByClientHash(hash);
    if (existing) {
      // 换一张船票，不换人：化名与计数都还在，旧 token 立刻失效
      const token = newToken();
      existing.tokenHash = sha256(token);
      db.save();
      return ok({ token, pseudonym: existing.pseudonym });
    }

    if (!noteRegistration(req.ip, now())) {
      const cap = ipLimitNow();
      return fail(
        429,
        'rate_limited',
        `同一个地址 ${cap.windowMin} 分钟内最多新开 ${cap.limit} 个号。`,
      );
    }

    const token = newToken();
    const today = dayIn(timeZone, now());
    const bot: BotRow = {
      tokenHash: sha256(token),
      clientHash: hash,
      pseudonym: newPseudonym(),
      createdAt: now(),
      lastResetDate: today,
      bottlesUsed: 0,
      catchesUsed: 0,
      repliesMade: 0,
      mailTaken: 0,
    };
    db.bots.push(bot);
    db.save();
    return ok({ token, pseudonym: bot.pseudonym });
  }

  function handleThrow(req: ApiRequest, bot: BotRow): ApiResponse {
    const at = now();
    resetDaily(bot, dayIn(timeZone, at));
    if (sweep(at)) db.save();

    if (quotaFor(bot).bottles_left <= 0) {
      return fail(429, 'no_bottle', '今天的瓶子用完了。');
    }

    const parsed = checkBody(asObject(req.body)?.body);
    if (!parsed.ok) return fail(400, 'bad_request', bodyProblem(parsed.reason, parsed.chars));

    const letter: LetterRow = {
      id: newId('l'),
      authorHash: bot.clientHash,
      body: parsed.body,
      createdAt: at,
      state: 'floating',
      catcherHash: null,
      caughtAt: null,
      replyWindowUntil: null,
      deliveredCount: 0,
      throws: 0,
    };
    db.letters.push(letter);
    bot.bottlesUsed += 1;
    db.save();
    return ok({ ok: true, quota: quotaFor(bot), letterId: letter.id });
  }

  function handleCatch(req: ApiRequest, bot: BotRow): ApiResponse {
    const at = now();
    resetDaily(bot, dayIn(timeZone, at));
    if (sweep(at)) db.save();

    const quota = quotaFor(bot);
    const held = db.letters.find(
      (letter) => letter.state === 'caught' && letter.catcherHash === bot.clientHash,
    );
    if (held) {
      const res: CatchRes = { empty: true, reason: 'holding', quota };
      return ok(res);
    }
    if (quota.catches_left <= 0) {
      const res: CatchRes = { empty: true, reason: 'quota', quota };
      return ok(res);
    }

    const pool = poolFor(bot);
    if (pool.length > 0) {
      const letter = pick(pool, random);
      letter.state = 'caught';
      letter.catcherHash = bot.clientHash;
      letter.caughtAt = at;
      letter.replyWindowUntil = at + REPLY_WINDOW_HOURS * HOUR;
      letter.deliveredCount += 1;
      bot.catchesUsed += 1;
      db.save();

      const res: CatchRes = {
        empty: false,
        letterId: letter.id,
        from: pseudonymOf(letter.authorHash),
        windowUntil: new Date(letter.replyWindowUntil).toISOString(),
        quota: quotaFor(bot),
      };
      return ok(res);
    }

    // ② 真人信一封都没有。`catch` 通道（旧行为）由海边邮局补位；
    //    现行是独立的系统邮件通道（`/mail/take`），捞瓶子这里直接空手。
    const seed = seedChannel === 'catch' ? pickSeed(bot) : null;
    if (seed) {
      db.recordSeedUse(seed.id, bot.clientHash, at);
      bot.catchesUsed += 1;
      db.save();
      const res: CatchRes = {
        empty: false,
        letterId: seed.id,
        from: SEED_FROM,
        windowUntil: new Date(at + REPLY_WINDOW_HOURS * HOUR).toISOString(),
        quota: quotaFor(bot),
        seed: true,
      };
      return ok(res);
    }

    const res: CatchRes = { empty: true, reason: 'quiet', quota };
    return ok(res);
  }

  /** 只从这个客户端还没见过的种子里挑；超过每人上限就当他已经见过邮局了。 */
  function pickSeed(bot: BotRow): SeedLetter | null {
    if (!seeds) return null;
    const used = db.seedUsesFor(bot.clientHash);
    if (used.length >= seedsPerUserMax) return null;
    const seen = new Set(used.map((use) => use.seedId));
    const candidates = seeds.list().filter((seed) => !seen.has(seed.id));
    if (candidates.length === 0) return null;
    return pick(candidates, random);
  }

  /**
   * 挑一封**系统邮件**（海边邮局）。
   *
   * **纯随机，不按序号**：这些信的故事彼此独立、不连载，按序号会让所有人先看到同一封，
   * 随机才像「漂到你这儿的一封」。
   *
   * 两层去重：
   *   · 我领过的不再给我（`seedUsesFor`）
   *   · `seedsGlobalOnce` 时，**任何人**领过的也不再给（`seedTakenAnywhere`）
   *     —— 这才是「一封信只属于一个人」；关掉就退回「同一封每人都能领一次」。
   */
  function pickSystemMail(bot: BotRow): SeedLetter | null {
    if (!seeds) return null;
    const t = currentTuning();
    const mine = new Set(db.seedUsesFor(bot.clientHash).map((use) => use.seedId));
    const candidates = seeds.list().filter((seed) => {
      if (mine.has(seed.id)) return false;
      if (t.seedsGlobalOnce && db.seedTakenAnywhere(seed.id)) return false;
      return true;
    });
    if (candidates.length === 0) return null;
    return pick(candidates, random);
  }

  /**
   * 系统邮件通道：**不走捞瓶子，也不占捞取额度**。
   *
   * 只回元信息；正文仍然要 `GET /letter/{id}` 才拿得到，所以「正文不经过模型」
   * 这条规矩在两条通道上完全一致。
   */
  function handleMailTake(_req: ApiRequest, bot: BotRow): ApiResponse {
    // 这条通道只在种子走 `mail` 时存在。走 `catch` 时它就是关着的——
    // 否则客户端会为了「系统邮件」把种子池从兜底通道里提前领走，
    // 于是 `bottle_catch` 那边就再也兜不到种子了。
    if (seedChannel !== 'mail') {
      return ok({ empty: true, reason: 'disabled', remainingToday: 0 });
    }
    const at = now();
    resetDaily(bot, dayIn(timeZone, at));
    const t = currentTuning();
    const perDay = Math.max(0, Math.floor(t.seedsPerDay));
    const taken = bot.mailTaken ?? 0;

    if (!t.seedsEnabled || perDay === 0) {
      return ok({ empty: true, reason: 'disabled', remainingToday: 0 });
    }
    if (taken >= perDay) {
      return ok({ empty: true, reason: 'quota', remainingToday: 0 });
    }

    const seed = pickSystemMail(bot);
    if (!seed) {
      // 库被领空了。全服去重时枯得比按人去重快得多，所以这个分支要能被客户端看见
      return ok({ empty: true, reason: 'exhausted', remainingToday: Math.max(0, perDay - taken) });
    }

    db.recordSeedUse(seed.id, bot.clientHash, at);
    bot.mailTaken = taken + 1;
    db.save();
    return ok({
      empty: false,
      letterId: seed.id,
      from: SEED_FROM,
      at: new Date(at).toISOString(),
      remainingToday: Math.max(0, perDay - taken - 1),
    });
  }

  function handleLetter(req: ApiRequest, bot: BotRow, letterId: string): ApiResponse {
    const letter = db.letterById(letterId);
    if (!letter) {
      const seed = seeds?.get(letterId);
      if (seed) return handleSeedLetter(bot, seed);
      return fail(404, 'not_found', '没有这一封。');
    }
    if (letter.catcherHash !== bot.clientHash) {
      return fail(404, 'not_found', '没有这一封。');
    }
    // 先判「还在不在」再判「是什么状态」：已归档或正文已失的，对拿着它的人来说
    // 都是同一件事——这封信没了。返回 410 而不是 404，客户端才能说「字被海带走了」。
    if (letter.state === 'archived' || !letter.body) {
      return fail(410, 'gone', '这一封的字已经被海啸带走了。');
    }
    if (letter.state !== 'caught' && letter.state !== 'replied') {
      return fail(404, 'not_found', '这一封已经不在你手上了。');
    }
    return ok({ body: letter.body, from: pseudonymOf(letter.authorHash) });
  }

  /** 种子的正文在文件里，海啸淹不掉；但只有捞到过它的人能取。 */
  function handleSeedLetter(bot: BotRow, seed: SeedLetter): ApiResponse {
    if (!db.hasSeedUse(seed.id, bot.clientHash)) {
      return fail(404, 'not_found', '你还没捞到这一封。');
    }
    return ok({
      body: seed.body,
      from: SEED_FROM,
      seed: true,
      ...(seed.signature ? { signature: seed.signature } : {}),
      ...(seed.topic ? { topic: seed.topic } : {}),
    });
  }

  function handleReply(req: ApiRequest, bot: BotRow): ApiResponse {
    const at = now();
    resetDaily(bot, dayIn(timeZone, at));
    if (sweep(at)) db.save();

    const payload = asObject(req.body);
    const letterId = typeof payload?.letterId === 'string' ? payload.letterId : '';
    // 回信是信**永久离开海面**的唯一大额出口，所以它必须有闸（§6 收支平衡）。
    // 不设的话每人每天能消灭 10 封、只补 5 封，海会一直很薄，漂流就退化成即时通讯。
    if (bot.repliesMade >= (rules.replyCap ?? DEFAULT_RULES.replyCap ?? 3)) {
      return fail(
        429,
        'no_reply',
        `今天的回信额度用完了（${rules.replyCap ?? DEFAULT_RULES.replyCap} 封）。明天再来。`,
      );
    }
    // 海边邮局不回信（§13.7）：不做一条「回了也没人看」的假状态机
    if (seeds?.get(letterId)) {
      return fail(409, 'seed_no_reply', '这一封来自海边邮局，它不会回信。');
    }
    const letter = db.letterById(letterId);
    if (!letter || letter.catcherHash !== bot.clientHash) return fail(404, 'not_found', '没有这一封。');
    if (letter.state === 'replied' || db.replyFor(letter.id)) {
      return fail(409, 'conflict', '一封信只能回一次。');
    }
    if (letter.state !== 'caught') return fail(404, 'not_found', '这一封已经不在你手上了。');

    const parsed = checkBody(payload?.body);
    if (!parsed.ok) return fail(400, 'bad_request', bodyProblem(parsed.reason, parsed.chars));

    db.replies.push({ id: newId('r'), letterId: letter.id, body: parsed.body, createdAt: at });
    letter.state = 'replied';
    bot.repliesMade += 1;
    db.save();
    return ok({ ok: true, quota: quotaFor(bot) });
  }

  function handleDismiss(req: ApiRequest, bot: BotRow): ApiResponse {
    const at = now();
    resetDaily(bot, dayIn(timeZone, at));
    if (sweep(at)) db.save();

    const letterId = asObject(req.body)?.letterId;
    const seed = typeof letterId === 'string' ? seeds?.get(letterId) : undefined;
    if (seed) {
      // 种子是文件里的信，不会裂也不会沉；「收好」只是本地把手里的那封放下
      if (!db.hasSeedUse(seed.id, bot.clientHash)) return fail(404, 'not_found', '你还没捞到这一封。');
      const res: DismissRes = { ok: true, quota: quotaFor(bot), throws: 0, sank: false, seed: true };
      return ok(res);
    }
    const letter = typeof letterId === 'string' ? db.letterById(letterId) : undefined;
    if (!letter || letter.state !== 'caught' || letter.catcherHash !== bot.clientHash) {
      return fail(404, 'not_found', '没有这一封。');
    }

    // 「今天回信额度用完了，只能扔回去」不是不想回，所以**不消耗瓶子的寿命**。
    // 只有那种「还有额度却选择不回」的，才算它被抛弃了一次。
    const replyCap = rules.replyCap ?? DEFAULT_RULES.replyCap ?? 3;
    const counted = bot.repliesMade < replyCap;
    if (counted) letter.throws += 1;

    // 记进「今天扔过的」：否则下一次捞可能又捞到自己刚扔掉的那一封，用户会觉得没变化
    bot.dismissedToday = [...(bot.dismissedToday ?? []), letter.id].slice(-50);

    const maxThrows = rules.maxThrows ?? DEFAULT_RULES.maxThrows ?? MAX_THROWS;
    const sank = letter.throws >= maxThrows;
    if (sank) sink(letter);
    else toSea(letter);

    db.save();
    const res: DismissRes = { ok: true, quota: quotaFor(bot), throws: letter.throws, sank, counted };
    return ok(res);
  }

  function handleMailbox(_req: ApiRequest, bot: BotRow): ApiResponse {
    const items: MailboxItem[] = [];
    for (const letter of db.letters) {
      if (letter.authorHash !== bot.clientHash || letter.state !== 'replied') continue;
      const reply = db.replyFor(letter.id);
      // 正文没了（服务端重启过）就不给页面看了，改天再收到一封
      if (!reply || !reply.body) continue;
      items.push({
        letterId: letter.id,
        from: pseudonymOf(letter.catcherHash),
        body: reply.body,
        at: new Date(reply.createdAt).toISOString(),
      });
    }
    items.sort((a, b) => (a.at < b.at ? 1 : -1));
    return ok(items);
  }

  /**
   * 运维探针，不需要 token。
   *
   * **只报「进程活着」和「种子热载」，一个业务数字都不报。**
   * 它是公网可读的：只要给出池子计数或种子总数，任何人都能把大屏上那些
   * 经过盲化的数字减回真值。业务数字走两条路——
   *   · `data/stats.jsonl`：真数，只在服务器上，运维自己看
   *   · `public/stats.json`：盲化后的数，给大屏看
   */
  function handleHealth(): ApiResponse {
    const stats = seeds?.stats();
    return ok({
      ok: true,
      startedAt: new Date(startedAt).toISOString(),
      uptimeMs: Math.max(0, now() - startedAt),
      seeds: {
        generation: stats?.generation ?? 0,
        loadedAt: stats?.loadedAt ? new Date(stats.loadedAt).toISOString() : null,
        errors: stats?.errors ?? [],
      },
    });
  }

  function handleQuota(_req: ApiRequest, bot: BotRow): ApiResponse {
    const at = now();
    const changed = resetDaily(bot, dayIn(timeZone, at));
    if (sweep(at) || changed) db.save();

    // 「与我有关、但已经不能用」的信：客户端据此把「还在漂」「还有 72 小时回海」改口。
    // 正常运行期间这两组永远是空的——正文都在进程内存里，只有重启后才会出现空的。
    // 用这个而不是让客户端逐个去查 `/letter/{id}`：一次请求就够，而且绝对准确。
    const deadLetters: DeadLetter[] = [];
    const heldByOthers: string[] = [];
    for (const letter of db.letters) {
      const mine = letter.authorHash === bot.clientHash;
      const heldByMe = letter.catcherHash === bot.clientHash;
      if (!mine && !heldByMe) continue;
      // 已经回过信的算成功收场，不是死
      if (letter.state === 'replied') continue;
      if (letter.state === 'archived') {
        const why = letter.archivedReason;
        if (why === 'tsunami' || why === 'sunk' || why === 'empty') {
          deadLetters.push({ id: letter.id, why });
        }
        continue;
      }
      if (!letter.body) {
        deadLetters.push({ id: letter.id, why: 'empty' });
        continue;
      }
      // 我写的、正被别人拿在手上——让作者知道「它被捡起来了」，但不透露是谁
      if (mine && letter.state === 'caught' && letter.catcherHash !== bot.clientHash) {
        heldByOthers.push(letter.id);
      }
    }

    // 顺路带上海啸记录：客户端每 5 分钟取一次额度，正好在这里发现「该告诉人类了」
    const t = db.tsunamiSummary();
    return ok({
      ...quotaFor(bot),
      deadLetters: deadLetters.slice(-50),
      heldByOthers: heldByOthers.slice(-50),
      tsunami: {
        count: t.count,
        lastAt: t.lastAt === null ? null : new Date(t.lastAt).toISOString(),
        lost: t.lost,
        reason: t.reason,
      },
    });
  }

  /**
   * 此刻的海。**公开、无需鉴权**——因为它只有世界事实，没有一条关于用户的信息。
   *
   * 落地页和将来的大屏都从这里取，所以它必须稳定、可缓存、可测试。
   * 注意只给「一共拍碎了多少」，不给每次海啸的原因（那是运维自己的话）。
   */
  function handleSea(): ApiResponse {
    const at = now();
    const t = db.tsunamiSummary();
    return ok({
      ...seaStateAt(at),
      waves: {
        count: t.count,
        lastDaysAgo: t.lastAt === null ? null : Math.max(0, Math.floor((at - t.lastAt) / 86_400_000)),
        shattered: t.totalLost,
      },
    });
  }

  return {
    handle(req: ApiRequest): ApiResponse {
      const path = req.path.replace(/\/+$/, '') || '/';
      // 每次请求前刷一下参数（内部有 5 秒 mtime 缓存，不会真去 stat 每个请求）
      refreshRules();

      if (req.method === 'POST' && path === '/register') return handleRegister(req);
      if (req.method === 'GET' && path === '/health') return handleHealth();
      if (req.method === 'GET' && path === '/sea') return handleSea();

      const bot = authenticate(req.token);
      if (!bot) return fail(401, 'unauthorized', '先注册，或者带上有效的 token。');
      // 「这个人今天来过」。只在跨天时随 resetDaily 一起落盘，所以精度是天级，不是秒级。
      bot.lastSeenAt = now();

      if (req.method === 'POST' && path === '/throw') return handleThrow(req, bot);
      if (req.method === 'POST' && path === '/catch') return handleCatch(req, bot);
      if (req.method === 'POST' && path === '/reply') return handleReply(req, bot);
      if (req.method === 'POST' && path === '/dismiss') return handleDismiss(req, bot);
      if (req.method === 'POST' && path === '/mail/take') return handleMailTake(req, bot);
      if (req.method === 'GET' && path === '/mailbox') return handleMailbox(req, bot);
      if (req.method === 'GET' && path === '/quota') return handleQuota(req, bot);
      if (req.method === 'GET') {
        const found = /^\/letter\/([A-Za-z0-9_-]{1,64})$/.exec(path);
        if (found) return handleLetter(req, bot, found[1]!);
      }
      return fail(404, 'not_found', '这里没有这个接口。');
    },
  };
}

function envInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function bodyProblem(reason: string | undefined, chars: number): string {
  if (reason === 'empty') return '正文是空的。';
  if (reason === 'too_long') return `最多 120 字，这一封有 ${chars} 字。`;
  if (reason === 'not_string') return '正文要是文字。';
  return '正文不合格。';
}
