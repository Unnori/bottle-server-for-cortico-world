/**
 * 服务端与外发页面共用的线格式。
 *
 * 一条约定写在类型里：`catch` 的回执**没有正文**。正文只能从 `GET /letter/{id}` 取，
 * 而那个接口只给页面用（World 侧调用，不进模型上下文）。
 */

/** 一封信、一封回信的长度上限；按码点算，不是 UTF-16 长度。 */
export const BODY_MAX = 120;

/**
 * 海啸记录。客户端拿它判断「该让人类知道一场海啸了」。
 *
 * 只有 `/quota` 的回执会带这一段——客户端本来就每 5 分钟取一次额度，
 * 正好顺路问一句，不用多开一个接口、多一次轮询。
 */
export interface TsunamiSummary {
  /** 一共起过几次海啸。客户端拿它和自己的记录比，变大了才推事件。 */
  count: number;
  lastAt: string | null;
  /** 最近一次拍碎了几封还漂在海面上的信。 */
  lost: number;
  /** 运维在重启前写下的原因；没有就是 `unplanned`。 */
  reason: string;
}

/** 一封「与我有关、但已经不能用」的信，以及它为什么没了。 */
export interface DeadLetter {
  id: string;
  /**
   * · `tsunami` —— 服务端重启，正文只在内存里，于是没了
   * · `sunk`    —— 漂太久没人愿意回，瓶子裂开沉底
   * · `empty`   —— 正文在某处已经丢失（僵尸信清理）
   */
  why: 'tsunami' | 'sunk' | 'empty';
}

export interface Quota {
  bottles_left: number;
  catches_left: number;
  /**
   * 今天还能回几封信。
   *
   * 可选的：老服务端不返回这个字段，客户端别硬依赖。
   * 它的存在是为了让客户端能提前说「今天回信额度用完了」，而不是等第 4 次回信被 429。
   */
  replies_left?: number;
  /**
   * 与我有关、已经彻底不能用的信 id（我写的 + 我捞到的都算）。
   *
   * 客户端据此把「还在漂」改成「迷失在海啸中」、把手上那封的三个按钮换成「珍藏」。
   * 正常运行期间这里永远是空数组——正文都在进程内存里，只有重启后才可能出现空的。
   * 用这个而不是让客户端逐个去查：一次 `/quota` 就够，而且绝对准确。
   */
  deadLetters?: DeadLetter[];
  /**
   * 我写的信里，正被别人拿在手上的。
   *
   * 只给 id、不给化名：作者该知道「它被捡起来了」，但不该知道是谁捡的。
   */
  heldByOthers?: string[];
  tsunami?: TsunamiSummary;
}

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'no_bottle'
  | 'no_catch'
  /** 今天回信额度用完了（回信是信永久离开海面的出口，必须设闸）。 */
  | 'no_reply'
  | 'holding'
  | 'gone'
  | 'conflict'
  | 'rate_limited'
  | 'not_found'
  /** 海边邮局的种子信不回信（§13.7）。 */
  | 'seed_no_reply'
  | 'internal';

export interface ErrorRes {
  error: ErrorCode;
  message: string;
}

export interface RegisterReq {
  /** sha256(clientId) 的十六进制。服务端只拿它认人，认不出这台机器以外的东西。 */
  hash: string;
}

export interface RegisterRes {
  token: string;
  pseudonym: string;
}

export interface ThrowReq {
  body: string;
}

export interface ThrowRes {
  ok: true;
  quota: Quota;
  letterId: string;
}

export type CatchEmptyReason = 'holding' | 'quota' | 'quiet';

export type CatchRes =
  | {
      empty: false;
      letterId: string;
      from: string;
      windowUntil: string;
      quota: Quota;
      /** 池子没有真人信时补位的种子瓶；来源固定是「海边邮局」。 */
      seed?: boolean;
    }
  | { empty: true; reason: CatchEmptyReason; quota: Quota };

/**
 * 系统邮件通道（海边邮局）：**独立于捞瓶子**，不占捞取额度。
 *
 * 只回元信息，正文仍然走 `GET /letter/{id}`——「正文不经过模型」这条规矩不变。
 */
export type MailTakeRes =
  | {
      empty: false;
      letterId: string;
      from: string;
      at: string;
      /** 今天还能领几封。 */
      remainingToday: number;
    }
  | {
      empty: true;
      reason: 'disabled' | 'quota' | 'exhausted';
      remainingToday: number;
    };

export interface LetterRes {
  body: string;
  from: string;
  seed?: boolean;
  /** 种子信的落款与主题（可选），只用于显示。 */
  signature?: string;
  topic?: string;
}

export interface ReplyReq {
  letterId: string;
  body: string;
}

export interface DismissReq {
  letterId: string;
}

/** 扔回海里：同一只瓶子被扔回来满 5 次就裂开沉底。 */
export interface DismissRes {
  ok: true;
  quota: Quota;
  /** 这是它第几次被扔回海里（含这一次）。 */
  throws: number;
  /** 这一次之后它裂开沉底了，不会再出现在海里。 */
  sank: boolean;
  /** 种子瓶没有裂缝这回事：throws 恒为 0，只表示人类收好了。 */
  seed?: boolean;
  /**
   * 这一次**算不算**扔（记进裂缝）。
   *
   * `false` = 人类只是「今天回信额度用完了」才扔回去的，不是不想回，
   * 所以不该消耗瓶子的寿命。客户端可以据此说「明天还能回」而不是「它快裂了」。
   */
  counted?: boolean;
}

export interface OkRes {
  ok: true;
  quota: Quota;
}

export interface MailboxItem {
  letterId: string;
  from: string;
  body: string;
  at: string;
}

/** `GET /mailbox` 直接回数组，和设计稿一致。 */
export type MailboxRes = MailboxItem[];

export const REPLY_WINDOW_HOURS = 72;
/**
 * 同一只瓶子被扔回海里这么多次，就裂开沉底，不再出现。
 *
 * 5 → 8 的理由：现在「回信额度用完了，只能扔回去」是正常操作，不该算作抛弃。
 * 服务端已经不再给这种情况计数（见 `handleDismiss` 的 `outOfReplies`），
 * 这个上限是给「真的没人愿意回」的信留的余地。**改它请改 `tuning.json` 的 `maxThrows`**，
 * 这里只是兜底默认值。
 */
export const MAX_THROWS = 8;
