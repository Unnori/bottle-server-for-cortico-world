/**
 * 服务端与外发页面共用的线格式。
 *
 * 一条约定写在类型里：`catch` 的回执**没有正文**。正文只能从 `GET /letter/{id}` 取，
 * 而那个接口只给页面用（World 侧调用，不进模型上下文）。
 */

/** 一封信、一封回信的长度上限；按码点算，不是 UTF-16 长度。 */
export const BODY_MAX = 120;
/** 新信标题独立于正文计数，按码点算。 */
export const TITLE_MAX = 20;
/** 自创 SVG 的 UTF-8 字节上限（净化后）。 */
export const STATIONERY_SVG_MAX_BYTES = 8 * 1024;
/** 整封信最多八幅图；自创图合计最多 16 KiB，线格式最多 32 KiB。 */
export const STATIONERY_MAX_DECORATIONS = 8;
export const STATIONERY_SVG_TOTAL_MAX_BYTES = 16 * 1024;
export const STATIONERY_MAX_BYTES = 32 * 1024;

export interface StationeryDecoration {
  doodle?: string;
  customSvg?: string;
  /** 不透明六位十六进制颜色；省略时自创图保持原色。 */
  color?: string;
  /** 图框中心在纸上的百分比坐标，0—100。 */
  x?: number;
  y?: number;
  /** 正方形图框宽度，占纸宽的百分比（4—100）；图形等比缩放。 */
  width?: number;
  rotation?: number;
  opacity?: number;
  layer?: 'behind' | 'front';
  z?: number;
  flipX?: boolean;
  flipY?: boolean;
  /** 简单写法；校验时展开为坐标和宽度。 */
  placement?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
  size?: 'small' | 'medium' | 'large';
}

/**
 * 信纸与装饰（可选）。
 *
 * - 内置素材：传稳定 ID，图案文件留在客户端
 * - 自创 SVG：传实际内容，净化后不超过 8 KiB UTF-8 字节
 * - 两者互斥；只选信纸或完全不带此字段均有效
 */
export interface Stationery extends StationeryDecoration {
  /** 1 保留旧显示；2 为多图排版，单图简写规范化为 decorations。 */
  v: 1 | 2;
  /** 信纸样式：grid（方格纸）、line（横线纸）、plain（白纸）等。 */
  paper?: 'grid' | 'line' | 'plain';
  /** 内置图案的稳定 ID（与 customSvg 互斥）。 */
  doodle?: string;
  /** 自创 SVG 内容（与 doodle 互斥），必须自包含、静态、不引用外部资源。 */
  customSvg?: string;
  paperColor?: string;
  decorations?: StationeryDecoration[];
}

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
  /**
   * 一封被捞起来的信，在手上最多待几小时（服务端热载，运维随时可调）。
   *
   * 为什么要在协议里传：客户端有三处需要自己算窗口——
   *   · 从本机历史恢复一封「服务端占着但本机没记下」的信时
   *   · 服务端没给 `windowUntil` 时的兜底
   *   · 显示「还剩几小时回海」的倒计时
   * 如果客户端继续用自己写死的常量，运维把服务端调成 24 小时之后，
   * 客户端还会显示「还剩 72 小时」——用户以为有时间，信其实已经回海了。
   *
   * 可选的：老服务端不返回，客户端退回自己的默认常量。
   * 仅用于缺少截止时间时的推算；已有信件的 windowUntil 不随热载追溯修改。
   */
  reply_window_hours?: number;
  /** Supports body-free pending drafts and reply priority over automatic return. */
  reply_draft_hold?: boolean;
  /**
   * 服务端能接收并转发的信纸协议版本。缺席表示旧服务端：新客户端只寄正文，并如实说明图案没有随信。
   */
  stationery?: 1;
  /** 在保留 v1 能力声明的同时，明确支持 v2 多图排版。 */
  stationery_layout?: 2;
  /**
   * 一句话公告（热载）。
   *
   * 复用海啸那条通道的做法：客户端按 `id` 去重，只播一次。
   * 没有公告时这个字段不出现，老客户端忽略即可。
   */
  announcement?: AnnouncementSummary;
}

export interface AnnouncementSummary {
  id: string;
  text: string;
  level: 'notice' | 'alarm';
  /** 到点自然消失（ISO），客户端拿它做"过期就不显示"。 */
  showUntil: string;
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
  /** 还没收到回信就写纸条（小纸条只能接在「信 → 回信」之后）。 */
  | 'no_reply_yet'
  /** 这封信已经留过纸条了。一封只能留一张，对方也不能再回。 */
  | 'note_exists'
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
  /** 可选以兼容旧客户端。 */
  topic?: string;
  body: string;
  /** 可选的信纸与装饰。 */
  stationery?: Stationery;
}

export interface ThrowRes {
  ok: true;
  quota: Quota;
  letterId: string;
}

/**
 * 退潮时的投递回执。
 *
 * **它不是错误。** 这是世界里发生的事（海上退潮、风暴将至），不是一个 `429`。
 * 客户端该把它当成一句公告播给人类，而不是弹错误提示。
 * 它同样**不消耗瓶子**——没寄出去就不该扣额度。
 */
export interface TideOutRes {
  ok: false;
  /** 固定是它，客户端据此识别「这是退潮，不是失败」。 */
  reason: 'tide_out';
  /** 服务端给的那句话，客户端可以直接念给人类听。 */
  text: string;
  quota: Quota;
  /** 预计什么时候回潮（ISO）。服务端没给就是 `null`。 */
  until: string | null;
}

export type ThrowResult = ThrowRes | TideOutRes;

export type CatchEmptyReason = 'holding' | 'quota' | 'quiet';

export type CatchRes =
  | {
      empty: false;
      letterId: string;
      from: string;
      /** null after an explicit read: keep holding until the human chooses an action. */
      windowUntil: string | null;
      caughtAt?: string;
      quota: Quota;
      /** 池子没有真人信时补位的种子瓶；来源固定是「海边邮局」。 */
      seed?: boolean;
    }
  | { empty: true; reason: CatchEmptyReason; quota: Quota;
      /** Recover an already-held letter without spending another catch. Never includes its body. */
      held?: { letterId: string; from: string; windowUntil: string | null; caughtAt?: string };
    };

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
  /** 种子信的落款。 */
  signature?: string;
  /** 信件标题；旧信可能没有。 */
  topic?: string;
  /** 可选的信纸与装饰。 */
  stationery?: Stationery;
}

export interface ReplyReq {
  letterId: string;
  body: string;
  draftKey?: string;
  /** 可选的信纸与装饰。 */
  stationery?: Stationery;
}
export const REPLY_AUTO_SEND_MS = 2 * 3_600_000;
/** 寄送时点后最多再保护 24 小时，供断网/回执丢失补寄；到期不能继续占住原信。 */
export const REPLY_DRAFT_RETRY_GRACE_MS = 24 * 3_600_000;
export interface ReplyDraftRes extends OkRes { sendAt: string | null }

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
  /** 可选的信纸与装饰。 */
  stationery?: Stationery;
}

/** `GET /mailbox` 直接回数组，和设计稿一致。 */
export type MailboxRes = MailboxItem[];

/** A 收到 B 的回信后，由 A 的 Coo 起草纸条，再由人确认寄给 B；收下或七天到期删。 */
export const NOTE_BODY_MAX = 40;
export const NOTE_TTL_HOURS = 168;
export const NOTE_TTL_MS = NOTE_TTL_HOURS * 3_600_000;
export interface NoteReq { letterId: string; body: string }
export interface NoteRes { ok: true; quota: Quota; repeated?: boolean }
export interface ReceivedNote { id: string; letterId: string; from: string; body: string; at: string; expiresAt: string }
export type NotesRes = ReceivedNote[];
export interface RepostReq { letterId: string; body?: string; topic?: string; stationery?: Stationery }
export interface RepostRes { ok: true; letterId: string; quota: Quota; repeated?: boolean }
/** 明文本机备份，不含令牌、配对数据、纸条或模型授权。 */
export interface LetterbookArchive { schemaVersion: 1; exportedAt: string; entries: Array<{ kind: 'sent' | 'received' | 'reply' | 'star'; value: Record<string, unknown> }> }

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
