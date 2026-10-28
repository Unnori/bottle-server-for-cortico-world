/**
 * 页面上的软提示。**只提示，不拦截、不改字**。
 *
 * 服务端完全不扫正文（§8）：内容已经过主人一遍，联系方式在漂流瓶语境里可能只是想交个朋友。
 * 这里唯一多做一点的是「本机信息」——那一类不是主人的选择，是模型无意带出来的事故，
 * 而主人审 120 字时很容易漏。
 */
import { hostname, userInfo } from 'node:os';

export type HintKind = 'contact' | 'local';

export interface SoftHint {
  kind: HintKind;
  text: string;
}

export const HINT_TEXT: Record<HintKind, string> = {
  contact: '这封信里有联系方式',
  local: '这封信里有本机信息，可能是无意带出来的',
};

/** 判断本机信息要用到的东西；测试里可以自己给一份。 */
export interface LocalEnv {
  hostname: string;
  username: string;
  home: string;
}

export function defaultLocalEnv(): LocalEnv {
  let username = '';
  let home = '';
  try {
    const info = userInfo();
    username = info.username ?? '';
    home = info.homedir ?? '';
  } catch {
    // 取不到就少一条判据，不影响其余
  }
  return { hostname: hostname(), username, home };
}

const CONTACT_PATTERNS: ReadonlyArray<RegExp> = [
  // 大陆手机号；前后不能紧贴数字，避免把长串订单号算进来
  /(?<!\d)1[3-9]\d{9}(?!\d)/u,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u,
  /(?:微信|wechat|weixin|vx|wx|威信)\s*[:：]?\s*[A-Za-z][-_A-Za-z0-9]{5,19}/iu,
  /(?:QQ|扣扣)\s*[:：]?\s*\d{5,12}/iu,
];

const LOCAL_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|[\s（(])[A-Za-z]:[\\/]/u,
  /\\\\[A-Za-z0-9_.-]+[\\/]/u,
  /(?:\/Users\/|\/home\/)[^\s，。；、]+/u,
  /%[A-Za-z_][A-Za-z0-9_]*%/u,
];

/** 正文里出现过的、长度够长的本机标识。太短的名字（如 `pc`）会误伤，直接跳过。 */
function hitsLocalName(body: string, env: LocalEnv): boolean {
  const lower = body.toLowerCase();
  const names = [env.hostname, env.username, env.home]
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length >= 4);
  return names.some((name) => lower.includes(name));
}

/**
 * 扫一遍草稿。返回至多两条：一条联系方式、一条本机信息。
 * 命中不等于不能寄——页面上只是把按钮改成「仍然寄出」。
 */
export function scanHints(body: string, env: LocalEnv = defaultLocalEnv()): SoftHint[] {
  if (!body.trim()) return [];
  const hints: SoftHint[] = [];
  if (CONTACT_PATTERNS.some((pattern) => pattern.test(body))) {
    hints.push({ kind: 'contact', text: HINT_TEXT.contact });
  }
  if (LOCAL_PATTERNS.some((pattern) => pattern.test(body)) || hitsLocalName(body, env)) {
    hints.push({ kind: 'local', text: HINT_TEXT.local });
  }
  return hints;
}
