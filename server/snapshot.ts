/**
 * 每日快照。由 systemd timer 每天跑一次。
 *
 * 做两件事，**但不能做第三件**：
 *   1. 真数追加到 `data/stats.jsonl`（只留在服务器上）
 *   2. 盲化后的数原子写进 `server/public/stats.json`（给大屏读）
 *   3. ❌ 绝不改动 `bottle.json`
 *
 * 第 3 条靠 `Db.readRaw()` 保证：它只解析、不做海啸巡查、不写盘。
 * 用 `Db.open()` 的话，这个脚本每天夜里都会亲手制造一次海啸。
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readLedgerFile } from './blind.ts';
import { Db } from './db.ts';
import { SeedStore } from './seeds.ts';
import { appendStatsLine, applyBlinding, collectRealStats, writePublicStats } from './stats.ts';
import { dayIn } from './app.ts';

function main(): void {
  const dataFile = resolve(process.env.BOTTLE_DATA ?? 'data/bottle.json');
  const seedsDir = resolve(process.env.BOTTLE_SEEDS_DIR ?? 'seeds');
  const ledgerPath = resolve(
    process.env.BOTTLE_LEDGER ?? `${seedsDir}/almanac/ledger.json`,
  );
  const statsFile = resolve(process.env.BOTTLE_STATS_JSONL ?? `${dirname(dataFile)}/stats.jsonl`);
  const publicFile = resolve(process.env.BOTTLE_PUBLIC_STATS ?? 'server/public/stats.json');
  const timeZone = process.env.BOTTLE_TZ ?? 'Asia/Hong_Kong';

  const at = Date.now();

  // 只读：看一眼盘上的真实状态，不碰它
  const db = Db.readRaw(existsSync(dataFile) ? dataFile : null);

  // 种子只用来读计数，所以不启动 fs.watch —— 一个 CLI 不该留下监听器
  const seeds = new SeedStore({ dir: existsSync(seedsDir) ? seedsDir : null });
  seeds.reload();
  const seedStats = seeds.stats();

  const real = collectRealStats(db, seedStats, { timeZone, today: dayIn(timeZone, at), at });
  const ledger = readLedgerFile(existsSync(ledgerPath) ? ledgerPath : null);
  const pub = applyBlinding(real, ledger, at);

  appendStatsLine(statsFile, real);
  writePublicStats(publicFile, pub);
  seeds.stop();

  // 输出一行结果，方便在 journalctl 里对账
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      date: real.date,
      bots: real.botsTotal,
      active: real.botsActive,
      floating: real.floating,
      seeds: `${real.seedsClaimed}/${real.seedsTotal}`,
      residentsPublic: pub.people.residents,
      atSeaPublic: pub.letters.atSea,
      ledgerFound: existsSync(ledgerPath),
      statsFile,
      publicFile,
    })}\n`,
  );
}

main();
