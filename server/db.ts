/**
 * 三张表，一个 JSON 文件。
 *
 * **正文只在内存**：`body` 落盘时置空，重启即丢（叙事是海啸）。磁盘上留着「谁寄过、
 * 谁捞过、投递过几次」，所以重启之后旧信不会再浮上来，而两边的身份和额度不会被清空。
 *
 * **海啸是要记账的**：重启时把还漂着的信判定为 `archived` 的那一刻，顺手写一条
 * `tsunami` 记录（时间 + 原因 + 丢了几封）。没有这条记录，运维只能靠「怎么没人写信了」
 * 去猜，客户端也没法把「海上起了一场海啸」讲给人类听。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type LetterState = 'floating' | 'caught' | 'replied' | 'archived';

export interface BotRow {
  /** sha256(token) 的十六进制；主键。 */
  tokenHash: string;
  /** sha256(clientId)；`/register` 用它认出「还是这台机器」。 */
  clientHash: string;
  pseudonym: string;
  createdAt: number;
  /** 上次重置额度的日期（服务器时区，YYYY-MM-DD）。 */
  lastResetDate: string;
  bottlesUsed: number;
  catchesUsed: number;
  repliesMade: number;
  /** 今天领过几封系统邮件（海边邮局通道）。老数据没有这个字段，读时按 0 算。 */
  mailTaken?: number;
  /**
   * 最后一次有请求的时刻。DAU 与留存全靠它。
   *
   * 只在**跨天**时顺手落盘（避免每个请求都写文件），所以精度是天级、不是秒级。
   * 老数据没有这个字段，统计时退回用 `lastResetDate` 估。
   */
  lastSeenAt?: number;
}

export interface LetterRow {
  id: string;
  authorHash: string;
  /** 只活在内存里；`save()` 时写成空串。 */
  body: string;
  createdAt: number;
  state: LetterState;
  catcherHash: string | null;
  caughtAt: number | null;
  replyWindowUntil: number | null;
  /** 被捞起来的次数，只作统计。 */
  deliveredCount: number;
  /** 被扔回海里的次数；满 5 次裂开沉底。 */
  throws: number;
  /**
   * 进 `archived` 是哪种死法：
   *   · `sunk`    —— 被扔回海里满 5 次，瓶子裂开沉底
   *   · `tsunami` —— 服务端重启，还漂在海面上的信被浪拍碎
   * 没有这个字段，「下沉率」和「海啸损失」两个数会混成一个，都失真。
   */
  archivedReason?: 'sunk' | 'tsunami';
}

export interface ReplyRow {
  id: string;
  letterId: string;
  /** 同样只活在内存里。 */
  body: string;
  createdAt: number;
}

/**
 * 谁见过哪一封种子（§13.2）。正文不在这里，只记 `seed_id + token_hash`，
 * 所以「同一封种子可以被所有人捞到，但同一个人最多见一次」。
 */
export interface SeedUseRow {
  seedId: string;
  /** 用的是 bot.clientHash（= sha256(clientId)），换 token 不换人。 */
  tokenHash: string;
  usedAt: number;
}

/** 一次海啸。 */
export interface TsunamiEvent {
  /** 发现这次海啸的时刻（≈ 进程启动时刻）。 */
  at: number;
  /**
   * 为什么重启。
   *
   * 运维在重启前把一句话写进 `data/next-tsunami-reason.txt`（或设 `BOTTLE_TSUNAMI_REASON`），
   * 启动时被读走并删除；没有就是 `unplanned`（崩溃、断电、OOM）。
   * **这条字段是分清「计划发布」和「意外崩溃」的唯一依据。**
   */
  reason: string;
  /** 这次拍碎了几封还漂在海面上的信。 */
  lost: number;
}

export interface TsunamiState {
  count: number;
  lastAt: number | null;
  /**
   * 历次海啸一共拍碎了多少封。`log` 只留最近 20 条，所以不能靠它求和——
   * 大屏要「累计被拍碎几封」就得单独存这个只增不减的数。
   */
  totalLost: number;
  /** 最近若干次，新的在前；只留 20 条，够运维回溯就行。 */
  log: TsunamiEvent[];
}

const TSUNAMI_LOG_MAX = 20;

interface DbFile {
  version: 2;
  bots: BotRow[];
  letters: Array<Omit<LetterRow, 'body'> & { body: '' }>;
  replies: Array<Omit<ReplyRow, 'body'> & { body: '' }>;
  seedsUsed: SeedUseRow[];
  tsunami?: TsunamiState;
}

export interface DbOpenOptions {
  /**
   * 运维在重启前写下的那句话。给了就用它当这次海啸的原因；
   * 没给就是 `unplanned`。
   */
  tsunamiReason?: string;
}

export class Db {
  bots: BotRow[] = [];
  letters: LetterRow[] = [];
  replies: ReplyRow[] = [];
  seedUses: SeedUseRow[] = [];
  tsunami: TsunamiState = { count: 0, lastAt: null, totalLost: 0, log: [] };

  /**
   * `file` 为 null 时纯内存，测试用。
   *
   * 写成普通字段赋值而不是参数属性：`node --experimental-strip-types` 只擦类型、
   * 不做代码生成，参数属性会直接报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。线上服务端
   * 就是用它跑的，所以这里不能图省事。
   */
  private readonly file: string | null;

  private constructor(file: string | null) {
    this.file = file;
  }

  static open(file: string | null, opts: DbOpenOptions = {}): Db {
    const db = new Db(file);
    db.load(opts);
    return db;
  }

  /**
   * **只读打开**：不改任何状态、不巡查海啸、不写盘。
   *
   * 给统计脚本用。它绝对不能走 `open()` —— 那个一旦发现磁盘上有 `floating` 的信，
   * 就会判定为海啸、把信全部归档**并立刻 `save()`**，
   * 等于每天夜里亲手制造一次海啸。统计必须只看得见，不动手。
   */
  static readRaw(file: string | null): Db {
    const db = new Db(file);
    if (!file || !existsSync(file)) return db;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DbFile>;
      db.bots = Array.isArray(parsed.bots) ? parsed.bots.filter(isBot) : [];
      // 注意：这里**不做** floating → archived 的转换，统计要看到盘上真实的样子
      db.letters = (Array.isArray(parsed.letters) ? parsed.letters.filter(isLetter) : []).map((row) => ({
        ...row,
        body: '',
        throws: Number(row.throws ?? 0),
      }));
      db.replies = (Array.isArray(parsed.replies) ? parsed.replies.filter(isReply) : []).map((row) => ({
        ...row,
        body: '',
      }));
      db.seedUses = Array.isArray(parsed.seedsUsed) ? parsed.seedsUsed.filter(isSeedUse) : [];
      db.tsunami = normalizeTsunami(parsed.tsunami);
    } catch {
      // 坏文件就是空库：统计失败也不该把运维挡在门外
    }
    return db;
  }

  private load(opts: DbOpenOptions = {}): void {
    if (!this.file || !existsSync(this.file)) return;
    let lost = 0;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<DbFile>;
      this.bots = Array.isArray(parsed.bots) ? parsed.bots.filter(isBot) : [];
      this.letters = (Array.isArray(parsed.letters) ? parsed.letters.filter(isLetter) : []).map((row) => {
        const letter: LetterRow = { ...row, body: '', throws: Number(row.throws ?? 0) };
        // 正文已经没了：浮着的信捞不起来，等于被海啸带走了
        if (letter.state === 'floating') {
          letter.state = 'archived';
          letter.archivedReason = 'tsunami';
          lost += 1;
        }
        return letter;
      });
      this.replies = (Array.isArray(parsed.replies) ? parsed.replies.filter(isReply) : []).map((row) => ({
        ...row,
        body: '',
      }));
      // 旧版文件没有这一张表：读过即空，种子会再发一次，不会崩
      this.seedUses = Array.isArray(parsed.seedsUsed) ? parsed.seedsUsed.filter(isSeedUse) : [];
      this.tsunami = normalizeTsunami(parsed.tsunami);
    } catch {
      // 文件坏了就当空库；这里没有不可重建的东西
      this.bots = [];
      this.letters = [];
      this.replies = [];
      this.seedUses = [];
      this.tsunami = { count: 0, lastAt: null, totalLost: 0, log: [] };
      return;
    }

    // 确实有信被浪拍碎了，才记一次海啸；没有漂着的信的重启不算
    if (lost > 0) {
      this.recordTsunami(lost, opts.tsunamiReason ?? 'unplanned');
      this.save();
    }
  }

  private recordTsunami(lost: number, reason: string): void {
    const at = Date.now();
    const event: TsunamiEvent = { at, reason: reason.trim() || 'unplanned', lost };
    this.tsunami.count += 1;
    this.tsunami.lastAt = at;
    this.tsunami.totalLost = (this.tsunami.totalLost ?? 0) + lost;
    this.tsunami.log = [event, ...this.tsunami.log].slice(0, TSUNAMI_LOG_MAX);
  }

  save(): void {
    if (!this.file) return;
    const payload: DbFile = {
      version: 2,
      bots: this.bots,
      letters: this.letters.map((letter) => ({ ...letter, body: '' })),
      replies: this.replies.map((reply) => ({ ...reply, body: '' })),
      seedsUsed: this.seedUses,
      tsunami: this.tsunami,
    };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      renameSync(tmp, this.file);
    } catch {
      // 写不进去不影响这一次请求；下一次仍会尝试
    }
  }

  /** 给 `/quota` 与 `/sea` 用。 */
  tsunamiSummary(): { count: number; lastAt: number | null; lost: number; totalLost: number; reason: string } {
    const last = this.tsunami.log[0];
    return {
      count: this.tsunami.count,
      lastAt: this.tsunami.lastAt,
      lost: last?.lost ?? 0,
      totalLost: this.tsunami.totalLost ?? 0,
      reason: last?.reason ?? '',
    };
  }

  botByTokenHash(hash: string): BotRow | undefined {
    return this.bots.find((bot) => bot.tokenHash === hash);
  }

  botByClientHash(hash: string): BotRow | undefined {
    return this.bots.find((bot) => bot.clientHash === hash);
  }

  letterById(id: string): LetterRow | undefined {
    return this.letters.find((letter) => letter.id === id);
  }

  replyFor(letterId: string): ReplyRow | undefined {
    return this.replies.find((reply) => reply.letterId === letterId);
  }

  /** 这个人见过的所有种子（去重与上限都靠它）。 */
  seedUsesFor(tokenHash: string): SeedUseRow[] {
    return this.seedUses.filter((use) => use.tokenHash === tokenHash);
  }

  hasSeedUse(seedId: string, tokenHash: string): boolean {
    return this.seedUses.some((use) => use.seedId === seedId && use.tokenHash === tokenHash);
  }

  /** 这封种子有没有被**任何人**领过（全服去重靠它）。 */
  seedTakenAnywhere(seedId: string): boolean {
    return this.seedUses.some((use) => use.seedId === seedId);
  }

  /** 幂等：同一个 (seedId, tokenHash) 只留一条，相当于表上的主键。 */
  recordSeedUse(seedId: string, tokenHash: string, at: number): void {
    if (this.hasSeedUse(seedId, tokenHash)) return;
    this.seedUses.push({ seedId, tokenHash, usedAt: at });
  }
}

function isBot(value: unknown): value is BotRow {
  const row = value as Partial<BotRow>;
  return typeof row?.tokenHash === 'string' && typeof row.pseudonym === 'string';
}

function isLetter(value: unknown): value is DbFile['letters'][number] {
  const row = value as Partial<LetterRow>;
  return typeof row?.id === 'string' && typeof row.authorHash === 'string' && typeof row.state === 'string';
}

function isReply(value: unknown): value is DbFile['replies'][number] {
  const row = value as Partial<ReplyRow>;
  return typeof row?.id === 'string' && typeof row.letterId === 'string';
}

function isSeedUse(value: unknown): value is SeedUseRow {
  const row = value as Partial<SeedUseRow>;
  return typeof row?.seedId === 'string' && typeof row.tokenHash === 'string';
}

/** 旧文件没有这一段：读成「从没发生过海啸」，而不是丢掉整个库。 */
function normalizeTsunami(value: unknown): TsunamiState {
  const raw = value as Partial<TsunamiState> | undefined;
  const log = Array.isArray(raw?.log)
    ? raw.log.filter((item): item is TsunamiEvent =>
        typeof item?.at === 'number' && typeof item.reason === 'string' && typeof item.lost === 'number',
      ).slice(0, TSUNAMI_LOG_MAX)
    : [];
  return {
    count: typeof raw?.count === 'number' && raw.count >= 0 ? raw.count : 0,
    lastAt: typeof raw?.lastAt === 'number' ? raw.lastAt : null,
    totalLost: typeof raw?.totalLost === 'number' && raw.totalLost >= 0 ? raw.totalLost : 0,
    log,
  };
}
