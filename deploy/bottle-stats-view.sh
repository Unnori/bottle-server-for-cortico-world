#!/bin/sh
# 漂流瓶 · 运营养护看板
#
# 把 data/stats.jsonl 打成人看得懂的一张表。不联网、不读数据库、不改任何东西。
#
#   bottle-stats-view          # 最新一天 + 近 14 天
#   bottle-stats-view 30       # 最新一天 + 近 30 天
set -eu

FILE=${BOTTLE_STATS_JSONL:-/srv/bottle/data/stats.jsonl}
NODE=${BOTTLE_NODE:-/usr/local/bin/node}
DAYS=${1:-14}

if [ ! -f "$FILE" ]; then
  echo "读不到统计快照：$FILE"
  echo ""
  echo "两种可能："
  echo "  · 还没生成过 —— 先跑一次：sudo systemctl start bottle-stats.service"
  echo "  · 文件在但你读不到（数据目录是 750 bottle:bottle）—— 用 sudo 再跑一次：sudo $0"
  exit 0
fi

"$NODE" -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean);
const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
if (!rows.length) { console.log("快照文件是空的。"); process.exit(0); }

const n = Number(process.argv[2]) || 14;
const tail = rows.slice(-n);
const last = rows[rows.length - 1];

const pad = (s, w) => String(s).padEnd(w);
const padl = (s, w) => String(s).padStart(w);
const pct = (x) => (x * 100).toFixed(1) + "%";

console.log("");
console.log("=== 漂流瓶 · 运营日报 ===");
console.log("最新快照：" + last.date + "（" + last.at + "）");
console.log("");
const kv = (k, v) => console.log("  " + pad(k, 14) + v);
kv("注册玩家", last.botsTotal);
kv("今日活跃", last.botsActive);
kv("今日新增", last.botsNew);
kv("写过信的人", last.botsWhoWrote);
console.log("");
kv("海上漂着", last.floating);
kv("被捞在手上", last.caught);
kv("已回信", last.replied);
kv("沉底", last.sunk);
kv("海啸损失", last.tsunamiLost + "（海啸 " + last.tsunamiCount + " 次）");
console.log("");
kv("累计投递", last.lettersTotal);
kv("累计被捞次数", last.catchCountTotal);
kv("累计回信", last.repliesTotal);
kv("回信率", pct(last.replyRate));
kv("最久还在漂", last.oldestAtSeaDays + " 天");
console.log("");
kv("种子已领", last.seedsClaimed + " / " + last.seedsTotal + "（还没人领 " + last.seedsUnclaimed + "）");
kv("今日领种子", last.seedsClaimedToday);
console.log("");
console.log("=== 近 " + tail.length + " 天 ===");
console.log("");
console.log(
  pad("日期", 12) + padl("活跃", 6) + padl("注册", 6) + padl("新增", 6) +
  padl("投递", 6) + padl("回信", 6) + padl("漂浮", 6) + padl("种子", 8),
);
for (const r of tail) {
  console.log(
    pad(r.date, 12) + padl(r.botsActive, 6) + padl(r.botsTotal, 6) + padl(r.botsNew, 6) +
    padl(r.thrownToday, 6) + padl(r.repliesToday, 6) + padl(r.floating, 6) +
    padl(r.seedsClaimed + "/" + r.seedsTotal, 8),
  );
}
console.log("");
' "$FILE" "$DAYS"
