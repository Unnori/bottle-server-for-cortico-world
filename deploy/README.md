# 部署

一台小 VPS 就够。下面的例子按 Debian/Ubuntu + systemd + Caddy 写。
路径统一用 `/srv/bottle`，你可以换，但记得同步改 unit 文件。

> 一条贯穿全过程的约束：**正文只在内存，重启即丢（我们叫它「海啸」）**。
> 所以能热载的都做成了热载，能不停机的都不要停机。

---

## 0. 一次性准备

```bash
sudo useradd --system --create-home --home-dir /srv/bottle --shell /usr/sbin/nologin bottle
sudo mkdir -p /srv/bottle/{app,data,seeds,backups}
sudo chown -R bottle:bottle /srv/bottle
```

需要 **Node 22.13+**。服务端直接跑 TypeScript 源码，靠 `--experimental-strip-types`，
不需要 tsx、不需要编译步骤。

`backups/` 必须存在：它是备份服务唯一被允许写的地方。

## 1. 放代码

```bash
sudo -u bottle git clone https://github.com/Unnori/bottle-server-for-cortico-world.git /srv/bottle/app
```

运行时只需要 `server/` 和 `shared/`。

## 2. 种子目录（可选）

只有 `seeds/*.json` 会加载，格式见 [`../seeds/README.md`](../seeds/README.md)。

建议把种子单独做成一个**私有** git 仓库：种子是给用户看的内容，提前公开等于剧透。

```bash
sudo -u bottle git clone <你的种子仓库> /srv/bottle/seeds
```

`git pull --ff-only` 要求历史是线性的——本机 push、服务器只 pull，天然满足。

## 3. 装 unit

```bash
sudo cp deploy/bottle-server.service /etc/systemd/system/
sudo cp deploy/bottle-seeds-pull.{service,timer} /etc/systemd/system/
sudo cp deploy/bottle-backup.{service,timer} /etc/systemd/system/
sudo install -o root -g root -m 755 deploy/bottle-backup.sh /usr/local/bin/

sudo systemctl daemon-reload
sudo systemctl enable --now bottle-server
sudo systemctl enable --now bottle-seeds-pull.timer     # 用了种子仓才需要
sudo systemctl enable --now bottle-backup.timer
```

## 4. 验

```bash
curl -s http://127.0.0.1:8787/health | jq
curl -s http://127.0.0.1:8787/health | jq -r .startedAt    # 记下这次启动的时刻

# 备份能跑（手动催一次）
sudo systemctl start bottle-backup.service
sudo systemctl status bottle-backup.service --no-pager
ls -lh /srv/bottle/backups/
systemctl list-timers bottle-backup.timer --no-pager
```

**种子热载的验收**（改完种子仓库之后）：

```bash
sudo systemctl start bottle-seeds-pull.service
curl -s http://127.0.0.1:8787/health | jq '.seeds | {count, generation, loadedAt, errors}'
```

- `generation` 变大 → 热载成功
- `startedAt` **没变** → 进程没重启，也就是没有海啸
- `errors` 非空 → 有文件没通过校验，被跳过，旧版本仍在用

> `/health` 不需要 token，所以它只报种子目录的**名字**，不报绝对路径。

## 5. 反代（Caddy）

服务端只讲 HTTP，TLS 交给反代：

```caddy
bottle.example.com {
    reverse_proxy 127.0.0.1:8787
    log {
        output file /var/log/caddy/bottle.log
    }
}
```

`HOST=0.0.0.0` 只在有反代、或需要两台机器直连时用；本机验证留 `127.0.0.1`（默认）。

## 6. 热载参数：`tuning.json`

**改数值不该重启。** 重启就是海啸，而海啸会把还漂在海面上的信全拍碎。

`/srv/bottle/data/tuning.json`（5 秒内生效，不用重启）：

```json
{
  "seedsPerDay": 2,
  "seedsGlobalOnce": true,
  "seedsEnabled": true
}
```

| 键 | 含义 |
|---|---|
| `seedsPerDay` | 系统邮件每人每天最多几封，`0` 停发 |
| `seedsGlobalOnce` | `true` = 同一封种子全服只能被领一次；`false` = 只按人去重 |
| `seedsEnabled` | 总开关 |

文件不在或写坏了 → 沿用上一次读到的值，不会把海搞挂。
环境变量 `BOTTLE_SEEDS_PER_DAY` / `BOTTLE_SEEDS_GLOBAL_ONCE` / `BOTTLE_SEEDS_ENABLED` 可作兜底。

配额公式的参数走环境变量：`BOTTLE_SEND_BASE`、`BOTTLE_SEND_CAP`、`BOTTLE_CATCH_BASE`、
`BOTTLE_CATCH_CAP`、`BOTTLE_POOL_DIVISOR`（写在 unit 的 `Environment=` 里，改了要
`daemon-reload` + 重启，所以能放进 `tuning.json` 的优先放那里）。

## 7. 海啸记账：这次重启是计划内还是意外

服务端每次启动都会检查磁盘上有没有「还漂着」的信。有，就判定为一次海啸，
记下**时间 / 原因 / 丢了几封**，并通过 `/quota` 告诉客户端。

**重启前写一句原因**，两种写法都行：

```bash
# 只对下一次重启生效，读完即删
echo "上线 v0.2：加了系统邮件通道" | sudo -u bottle tee /srv/bottle/data/next-tsunami-reason.txt

# 或者走环境变量
sudo systemctl set-environment BOTTLE_TSUNAMI_REASON="上线 v0.2"
```

不写就记成 `unplanned` —— 那通常意味着崩溃、断电或 OOM，是唯一需要人事后看一眼的那一类。
没有这个字段，「计划发布」和「意外崩溃」在日志里长得一模一样。

看记录：

```bash
sudo -u bottle cat /srv/bottle/data/bottle.json | jq .tsunami
```

## 8. 从备份恢复

备份每 8 小时一份（`:05` 跑，即 00:05 / 08:05 / 16:05），保留 30 天，每份都过了 JSON 解析校验。

```bash
# 1. 停服务（这一步必然海啸，先写好原因）
echo "从备份恢复" | sudo -u bottle tee /srv/bottle/data/next-tsunami-reason.txt
sudo systemctl stop bottle-server

# 2. 挑一份好的
ls -lh /srv/bottle/backups/

# 3. 换回来（先把坏文件留个痕）
sudo -u bottle mv /srv/bottle/data/bottle.json /srv/bottle/data/bottle.json.broken
sudo -u bottle cp /srv/bottle/backups/bottle-<时间戳>.json /srv/bottle/data/bottle.json

# 4. 起来
sudo systemctl start bottle-server
curl -s http://127.0.0.1:8787/health | jq
```

**为什么备份是必需的**：`Db.load()` 解析失败时会**当空库处理**，那会清空 `bots` 表——
所有人的 token 都认不出来，客户端收到 401 会重新注册，于是**所有人变成新人**。
海啸只丢「还漂着的信」，文件损坏丢的是「你是谁」。

## 9. 不要做的事

| 别做 | 为什么 |
|---|---|
| `systemctl restart` 来让新种子或新参数生效 | 种子和 `tuning.json` **都是热载的**；重启会海啸 |
| `rsync --delete` 同步种子 | 手滑一次服务器上就没了；git 有历史 |
| `Restart=always` | 崩了要人看一眼，而不是悄悄冲掉海里的信 |
| 把正文写进日志 | 日志只该有 id 和数量 |
| 把种子仓库设成公开 | 等于剧透 |
| 删掉 `/srv/bottle/backups` | 那是文件损坏时唯一的退路 |

### 出问题时先看这三个地方

| 症状 | 查什么 |
|---|---|
| 种子没更新 | `curl /health \| jq .seeds`：`errors` 有没有、`generation` 变没变 |
| 备份没产出 | `systemctl status bottle-backup.service`、`journalctl -t bottle-backup -n 50` |
| 参数改了没反应 | `tuning.json` 的 mtime 变了没、JSON 有没有写坏（5 秒不生效多半是写坏了） |
