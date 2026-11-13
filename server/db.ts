/**
 * 一个 JSON 文件保存元数据与限期小纸条。
 *
 * **信与回信正文只在内存**：`body` 落盘时置空，重启即丢（叙事是海啸）。小纸条例外。
 * 磁盘上留着「谁寄过、
 * 谁捞过、投递过几次」，所以重启之后旧信不会再浮上来，而两边的身份和额度不会被清空。
 *
 * **海啸是要记账的**：重启时把还漂着的信判定为 `archived` 的那一刻，顺手写一条
 * `tsunami` 记录（时间 + 原因 + 丢了几封）。没有这条记录，运维只能靠「怎么没人写信了」
 * 去猜，客户端也没法把「海上起了一场海啸」讲给人类听。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { NOTE_BODY_MAX, NOTE_TTL_MS } from '../shared/contract.ts';
export { NOTE_BODY_MAX, NOTE_TTL_HOURS } from '../shared/contract.ts';

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
  /**
   * 今天被我扔回海里的信。
   *
   * 为什么要有：扔回去之后 `catcherHash` 会被清空，如果没有这个名单，
   * 同一个人下一次捞可能又捞到**自己刚扔掉的那一封**——用户会觉得"根本没变化"。
   * 只去重「今天」：明天它漂回来是合理的，那是它又漂回来了。
   */
  dismissedToday?: string[];
}

import type { Stationery } from '../shared/contract.ts';

export interface LetterRow {
  /** 与正文一样只活在内存里，不写进账本。 */
  topic?: string;
  /** 信纸与装饰，只活在内存里；`save()` 时剔除。 */
  stationery?: Stationery;
  id: string;
  authorHash: string;
  /** 只活在内存里；`save()` 时写成空串。 */
  body: string;
  createdAt: number;
  state: LetterState;
  catcherHash: string | null;
  caughtAt: number | null;
  replyWindowUntil: number | null;
  /** Removed on reply, explicit return/cancel or archive; never includes draft text. */
  replyDraftKey?: string;
  replyDraftDueAt?: number;
  /** 被捞起来的次数，只作统计。 */
  deliveredCount: number;
  /** 被扔回海里的次数；满 5 次裂开沉底。 */
  throws: number;
  /**
   * 进 `archived` 是哪种死法：
   *   · `sunk`    —— 被扔回海里太多次，瓶子裂开沉底
   *   · `tsunami` —— 服务端重启，正文只在内存里，于是没了
   *   · `empty`   —— 正文在某处已经丢了，这封信谁也捞不到，收掉别再占着海面
   * 没有这个字段，「下沉」和「海啸损失」会混成一个数，两个指标都失真。
   */
  archivedReason?: 'sunk' | 'tsunami' | 'empty' | 'kept';
}

export interface ReplyRow {
  id: string;
  letterId: string;
  /** 同样只活在内存里。 */
  body: string;
  /** 回信装饰，只活在内存里；`save()` 时剔除。 */
  stationery?: Stationery;
  createdAt: number;
}

/** 正文唯一落盘的表；ack 后整行删除，或创建七天后由 sweep/load 删除。 */
export interface NoteRow {
  id: string; letterId: string; fromHash: string; toHash: string;
  body: string; createdAt: number; deliverAt: number | null; expiresAt: number;
}
/** 纯元数据幂等凭据，创建七天后删除；同一往来在这七天内重试不重复扣费。 */
export interface NoteReceipt { id: string; letterId: string; fromHash: string; expiresAt: number }

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
/** 每人每天最多记多少封「今天扔回去的」——够挡住重复捞同一封，又不会无限长。 */
const DISMISSED_KEEP = 50;

interface DbFile {
  version: 3;
  bots: BotRow[];
  letters: Array<Omit<LetterRow, 'body' | 'topic'> & { body: '' }>;
  replies: Array<Omit<ReplyRow, 'body'> & { body: '' }>;
  seedsUsed: SeedUseRow[];
  /** 小纸条。**唯一带正文落盘的表**（见 NoteRow 的注释）。 */
  notes?: NoteRow[];
  noteReceipts?: NoteReceipt[];
  tsunami?: TsunamiState;
}

export interface DbOpenOptions {
  /**
   * 运维在重启前写下的那句话。给了就用它当这次海啸的原因；
   * 没给就是 `unplanned`。
   */
  tsunamiReason?: string;
  now?: () => number;
}

export class Db {
  bots: BotRow[] = [];
  letters: LetterRow[] = [];
  replies: ReplyRow[] = [];
  seedUses: SeedUseRow[] = [];
  /** 待投递的小纸条。取走即删，见 NoteRow 的注释。 */
  notes: NoteRow[] = [];
  noteReceipts: NoteReceipt[] = [];
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
    // Discard only our own interrupted atomic-write file, which may contain expired paper text.
    if (this.file) { try { rmSync(`${this.file}.tmp`, { force: true }); } catch { /* save will report failure */ } }
    if (!this.file || !existsSync(this.file)) return;
    let lost = 0;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<DbFile>;
      this.bots = (Array.isArray(parsed.bots) ? parsed.bots.filter(isBot) : []).map((bot) => ({
        ...bot,
        dismissedToday: Array.isArray(bot.dismissedToday)
          ? bot.dismissedToday.filter((id): id is string => typeof id === 'string').slice(-DISMISSED_KEEP)
          : undefined,
      }));
      this.letters = (Array.isArray(parsed.letters) ? parsed.letters.filter(isLetter) : []).map((row) => {
        const letter: LetterRow = { ...row, body: '', throws: Number(row.throws ?? 0) };
        // 正文只在内存里，所以重启之后「还活着的信」全都已经废了：
        //   · floating → 归档，并计入这次海啸丢掉的封数（它本来漂在海面上）
        //   · caught   → 也归档，但**不计入 lost**：海啸那句话只说「海面上的」，
        //                说满了反而骗人；运营侧靠 archivedReason 看得到它
        //
        // 不归档 caught 的话，它会在 72 小时后被 sweep 放回海里，而正文已经没了——
        // 变成一封谁都捞不到、却一直算在「漂着」里的僵尸信。
        if (letter.state === 'floating') {
          letter.state = 'archived';
          letter.archivedReason = 'tsunami';
          lost += 1;
        } else if (letter.state === 'caught' && !(typeof letter.replyDraftKey === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(letter.replyDraftKey) && typeof letter.replyDraftDueAt === 'number' && Number.isFinite(letter.replyDraftDueAt) && letter.replyDraftDueAt > 0)) {
          letter.state = 'archived';
          letter.archivedReason = 'tsunami';
        }
        if(letter.state!=='caught'){delete letter.replyDraftKey;delete letter.replyDraftDueAt;}
        return letter;
      });
      this.replies = (Array.isArray(parsed.replies) ? parsed.replies.filter(isReply) : []).map((row) => ({
        ...row,
        body: '',
      }));
      // 旧版文件没有这一张表：读过即空，种子会再发一次，不会崩
      this.seedUses = Array.isArray(parsed.seedsUsed) ? parsed.seedsUsed.filter(isSeedUse) : [];
      // 旧版文件没有 notes：当成空，不认任何纸条（不会崩）
      const at = opts.now?.() ?? Date.now();
      this.notes = Array.isArray(parsed.notes) ? parsed.notes.filter(isNote).filter(n => n.expiresAt > at) : [];
      this.noteReceipts = Array.isArray(parsed.noteReceipts) ? parsed.noteReceipts.filter(isReceipt).filter(n => n.expiresAt > at) : [];
      this.tsunami = normalizeTsunami(parsed.tsunami);
    } catch {
      // 文件坏了就当空库；这里没有不可重建的东西
      this.bots = [];
      this.letters = [];
      this.replies = [];
      this.seedUses = [];
      this.notes = [];
      this.tsunami = { count: 0, lastAt: null, totalLost: 0, log: [] };
      return;
    }

    // 确实有信被浪拍碎了，才记一次海啸；没有漂着的信的重启不算
    if (lost > 0) {
      this.recordTsunami(lost, opts.tsunamiReason ?? 'unplanned');
    }
    // Also purge expired notes/migrate old files even when no letters were lost.
    this.save();
  }

  private recordTsunami(lost: number, reason: string): void {
    const at = Date.now();
    const event: TsunamiEvent = { at, reason: reason.trim() || 'unplanned', lost };
    this.tsunami.count += 1;
    this.tsunami.lastAt = at;
    this.tsunami.totalLost = (this.tsunami.totalLost ?? 0) + lost;
    this.tsunami.log = [event, ...this.tsunami.log].slice(0, TSUNAMI_LOG_MAX);
  }

  save(): boolean {
    if (!this.file) return true;
    const payload: DbFile = {
      version: 3,
      bots: this.bots,
      letters: this.letters.map(({ topic: _topic, stationery: _stationery, ...letter }) => ({ ...letter, body: '' })),
      replies: this.replies.map(({ stationery: _stationery, ...reply }) => ({ ...reply, body: '' })),
      seedsUsed: this.seedUses,
      // 注意：notes **不**清空 body。这是全库唯一的例外——
      // 它要等对方上线才送达，清空等于让那句告别永远消失（见 NoteRow 注释）。
      notes: this.notes,
      noteReceipts: this.noteReceipts,
      tsunami: this.tsunami,
    };
    const tmp = `${this.file}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.file);
      return true;
    } catch {
      try { rmSync(tmp, { force: true }); } catch { /* removed again on next open */ }
      return false;
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

  noteForLetter(letterId: string): NoteRow | undefined { return this.notes.find(n => n.letterId === letterId); }
  notesFor(toHash: string): NoteRow[] { return this.notes.filter(n => n.toHash === toHash); }
  pruneNotes(at: number): boolean {
    const size = this.notes.length + this.noteReceipts.length;
    this.notes = this.notes.filter(n => n.expiresAt > at);
    this.noteReceipts = this.noteReceipts.filter(n => n.expiresAt > at);
    return size !== this.notes.length + this.noteReceipts.length;
  }

}

function isBot(value: unknown): value is BotRow {
  const row = value as Partial<BotRow>;
  // `createdAt` 必须是个能用的时间戳。
  //
  // 不校验会怎样：数据库里已经出现过一条 `createdAt` 坏掉的记录，于是
  // 「上线前 11 个 + 上线后 14 个 = 24」，但总数是 25——那个 bot 既不算前也不算后。
  // 按人数分组的统计会静默偏小，而且没人知道为什么。
  //
  // 坏数据直接丢弃：少一个来路不明的账号，好过让所有分组统计都不可信。
  return (
    typeof row?.tokenHash === 'string' &&
    typeof row.pseudonym === 'string' &&
    typeof row.clientHash === 'string' &&
    Number.isFinite(Number(row.createdAt))
  );
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

/**
 * 纸条的字段校验。
 *
 * **正文必须非空且不超过上限**：这条不只是防御坏数据，它是「磁盘上唯一有正文的表」
 * 的最后一道闸——一条写坏的记录不该被当成可投递内容留在盘上。
 */
function isReceipt(value: unknown): value is NoteReceipt {
  const r = value as Partial<NoteReceipt>;
  return typeof r?.id === 'string' && typeof r.letterId === 'string' && typeof r.fromHash === 'string' &&
    typeof r.expiresAt === 'number' && Number.isFinite(r.expiresAt);
}
function isNote(value: unknown): value is NoteRow {
  const r = value as Partial<NoteRow>;
  return isReceipt(value) && typeof r.toHash === 'string' && typeof r.body === 'string' &&
    !!r.body.trim() && [...r.body].length <= NOTE_BODY_MAX && typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) &&
    r.expiresAt === r.createdAt + NOTE_TTL_MS && (r.deliverAt === null || typeof r.deliverAt === 'number' && Number.isFinite(r.deliverAt));
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
