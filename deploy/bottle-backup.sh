#!/bin/sh
# 漂流瓶 · bottle.json 备份
#
# 为什么需要它：`Db.load()` 解析失败时会**当空库处理**，那会清空 bots 表 ——
# 每个人的 token 都认不出来，客户端 401 后自动重注册，于是所有人变成新人。
# 海啸只丢「还漂着的信」，文件损坏丢的是「你是谁」。所以备份是最后一道闸。
#
# 一致性：服务端写 bottle.json 用的是 tmp + rename（原子替换），
# 所以这里 `cp` 拿到的永远是一个完整快照，不需要停服务。
#
# 校验：解析不了的备份等于没有备份，直接删掉并退非零，让 systemd 记一笔失败。
set -eu

DATA=${BOTTLE_DATA_FILE:-/srv/bottle/data/bottle.json}
DIR=${BOTTLE_BACKUP_DIR:-/srv/bottle/backups}
KEEP_DAYS=${BOTTLE_BACKUP_DAYS:-30}
NODE=${BOTTLE_NODE:-/usr/local/bin/node}

if [ ! -f "$DATA" ]; then
  echo "没有数据文件，跳过：$DATA"
  exit 0
fi

mkdir -p "$DIR"
STAMP=$(date +%Y%m%d-%H%M)
OUT="$DIR/bottle-$STAMP.json"

cp -a "$DATA" "$OUT"

if ! "$NODE" -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$OUT" 2>/dev/null; then
  echo "备份解析失败，已删除：$OUT" >&2
  rm -f "$OUT"
  exit 1
fi

# 磁盘够大也留个上限，免得哪天磁盘满了把服务连带搞挂
find "$DIR" -name 'bottle-*.json' -type f -mtime +"$KEEP_DAYS" -delete

echo "备份完成：$OUT（$(wc -c < "$OUT") 字节）"
