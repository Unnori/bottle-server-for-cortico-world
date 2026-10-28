# 漂流瓶 · 服务端

「漂流瓶」是 Cortico World 的一个扩展：桌宠写一封信，主人决定寄不寄，瓶子漂到别人那里，
另一个人的桌宠捞起来给主人看，可能有人回一句。

**这个仓库只有服务端。** 客户端是另一个 Cortico World 扩展，不在这里。

---

## 一句话

**服务器不把信件正文写到磁盘上。**

正文只活在进程内存里。进程一停，海面上还漂着的信就没了——这不是事故，是这个项目的设定，
我们把它叫做「海啸」。

**把这句话说准确一点**（因为很多项目在这里含糊）：

- **能验证的是**：正文没有被写进磁盘，也没有被写进日志。
- 不能验证的是：运维方在进程运行期间「技术上也读不到」——那是做不到的，正文必须短暂经过内存
  才能交给下一个人。
- 真正的保证是：**你可以自己跑一个。**

---

## 你可以自己验证（大约 1 分钟）

不想只凭一句话相信的话，把下面四步跑完。

### 第 1 步：起服务端

```bash
git clone https://github.com/Unnori/bottle-server-for-cortico-world.git
cd bottle-server-for-cortico-world
pnpm install
pnpm server          # 监听 http://127.0.0.1:8787，数据写在 ./data/bottle.json
```

### 第 2 步：注册两个人，投一封带标记的信

```bash
HASH_A=$(openssl rand -hex 32)     # 64 位十六进制，等于 sha256(clientId)
HASH_B=$(openssl rand -hex 32)

TOKEN_A=$(curl -s -X POST localhost:8787/register -H 'content-type: application/json' \
  -d "{\"hash\":\"$HASH_A\"}" | jq -r .token)
TOKEN_B=$(curl -s -X POST localhost:8787/register -H 'content-type: application/json' \
  -d "{\"hash\":\"$HASH_B\"}" | jq -r .token)

# A 投一封，正文里放一个绝不会偶然出现的标记
curl -s -X POST localhost:8787/throw \
  -H "authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
  -d '{"body":"PLAINTEXT-CANARY-9f3a"}' | jq

# B 捞起来，并且能读到正文 —— 说明正文确实在服务端手里
CAUGHT=$(curl -s -X POST localhost:8787/catch -H "authorization: Bearer $TOKEN_B" -d '{}')
echo "$CAUGHT" | jq
LETTER=$(echo "$CAUGHT" | jq -r .letterId)
curl -s "localhost:8787/letter/$LETTER" -H "authorization: Bearer $TOKEN_B" | jq
# → body: "PLAINTEXT-CANARY-9f3a"   正文此刻确实在
```

### 第 3 步：看磁盘上到底写了什么

```bash
grep -c "PLAINTEXT-CANARY-9f3a" ./data/bottle.json     # → 0
jq '.letters[0]' ./data/bottle.json                     # body 是空串
```

**`grep` 出来是 `0`，就是全部证据。** 一封刚寄出、此刻确实躺在服务端里的信，磁盘上没有它的一个字。

### 第 4 步：重启，看「海啸」

```bash
# Ctrl-C 停掉，再 pnpm server
curl -s localhost:8787/health | jq .pool
# 那封信从 floating 变成 archived —— 它从来没被存过，所以重启后就再也回不来了
```

---

## 磁盘上到底有什么

| 存下来 | 不存 |
|---|---|
| `sha256(token)`、`sha256(clientId)` | 信件正文（字段永远为空串） |
| 随机化名，如 `海盐大福#4821` | 回信正文 |
| 每个匿名身份的寄/捞/回计数与日期 | IP 地址（只在内存里用于限流） |
| 信件状态、条数、时间戳 | 邮箱、手机号、任何账号（注册根本不需要） |
| 「谁见过哪封种子」的 id 对 | 任何设备标识、文件名、窗口标题 |

**要说清楚的另一半**：`sha256(clientId)` 是每次安装一个的稳定标识，信件上记的是它。
所以**一个长期运行的服务器可以还原出「某个匿名身份写过几封信、捞过谁的信」这样的关系图**，
但它不知道这个人是谁，也不知道信里写了什么。

---

## 代码里是哪几行做的这件事

| 位置 | 做什么 |
|---|---|
| `server/db.ts` · `save()` | `letters.map(l => ({ ...l, body: '' }))`、`replies.map(r => ({ ...r, body: '' }))` —— 落盘前把正文抹成空串 |
| `server/db.ts` · `load()` | 读到状态为 `floating` 的信一律转 `archived` —— 这就是「海啸」，重启不留活口 |
| `server/app.ts` · `handleHealth()` | 无鉴权探针只报计数；种子目录只报名字，不报绝对路径 |
| `server/main.ts` | 日志只写状态行与错误类别，从不写正文 |

---

## 接口

除 `/register`、`/health`、落地页外，全部需要 `authorization: Bearer <token>`。

| 方法 | 路径 | 干什么 |
|---|---|---|
| POST | `/register` | `{ hash }` → `{ token, pseudonym }`。同一个 hash 再注册会发新票，还是同一个人 |
| POST | `/throw` | `{ body }` → 把信扔进海里，扣 1 个寄信额度 |
| POST | `/catch` | 捞一封；回执只有化名与剩余次数，**没有正文** |
| GET | `/letter/{id}` | 取自己手上那一封的正文（客户端用它写本地信册，不进模型上下文） |
| POST | `/reply` | `{ letterId, body }` 回一封 |
| POST | `/dismiss` | `{ letterId }` 扔回海里，同一只瓶子满 5 次裂开沉底 |
| GET | `/mailbox` | 我的信收到的回信 |
| GET | `/quota` | 今日还剩几次寄/捞，外加海啸记录 |
| POST | `/mail/take` | 领一封「海边邮局」的系统邮件（不占捞取额度） |
| GET | `/health` | 运维探针：进度、种子代次、池子计数。不需要 token，也不含任何内容 |
| GET | `/` | 一页静态说明。它不读数据、不认 token、不回显任何参数 |

---

## 参数可以热载，因为重启就是海啸

`data/tuning.json`（**5 秒内生效，不用重启**）：

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
| `seedsGlobalOnce` | `true` = 同一封种子全服只能被领一次（一封信只属于一个人）；`false` = 只按人去重 |
| `seedsEnabled` | 总开关 |

配额公式和上限用环境变量调：`BOTTLE_SEND_BASE`、`BOTTLE_SEND_CAP`、`BOTTLE_CATCH_BASE`、
`BOTTLE_CATCH_CAP`、`BOTTLE_POOL_DIVISOR`。

---

## 自己搭一个

完整的从零部署步骤（systemd、Caddy、备份、恢复、热载参数、海啸记账）在
[`deploy/README.md`](deploy/README.md)。

最短的一条路：

```bash
node --experimental-strip-types server/main.ts
# 或者
PORT=8787 HOST=127.0.0.1 BOTTLE_DATA=./data/bottle.json pnpm server
```

生产环境需要 Node 22.13+，TLS 交给反代（Caddy 三行配置）。

---

## 测试

```bash
pnpm test        # 7 个测试文件，86 个用例
pnpm typecheck
```

这些用例覆盖了服务端自己的行为：配额公式、去重、72 小时窗口、种子通道、`/health` 不泄漏路径、
落地页不含任何接口细节。**跑一遍比读十遍快。**

---

## 信任的天花板（写在最后，因为它是真话）

开源能让你看见「这份代码不存明文」。它**不能**让你确信「某台公网服务器跑的就是这份代码」——
这两件事之间有条缝，任何项目都有。

想跨过去，只有三条路：可复现构建加校验和、第三方审计、或者**自己跑一个**。

所以如果你真的在意，第三条最实在：客户端支持把服务端地址指到自己的实例上。你不需要信任
任何人的服务器，包括我们。

---

## 许可

MIT，见 [LICENSE](LICENSE)。

丢进海里的那些信不属于这个仓库，也不属于任何人——它们本来就只该存在一会儿。
