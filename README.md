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
jq '[.letters[] | {state, archivedReason}]' data/bottle.json
# 那封信从 floating 变成 archived，archivedReason 是 tsunami ——
# 它从来没被存过，所以重启之后就再也回不来了
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

## 一封信是怎么消失的

海面上永远不该出现「捞不到的信」。一封信只在三种情况下离开这个世界，每种都记了原因
（`archivedReason`）：

| 死法 | 原因 |
|---|---|
| `sunk` | 被扔回海里太多次，瓶子裂了 |
| `tsunami` | 服务端重启，而正文只在内存里 |
| `empty` | 正文在某处已经丢了（上一轮运行留下的残骸） |

最后一条是刻意的。`poolFor()` 要求正文非空，所以一封正文已失却还标着 `floating` 的信
**谁都捞不到、却会一直算在「漂着」里**——那种信叫僵尸信。现在 `toSea()` 会当场把它归档，
`load()` 也会在启动时把 `caught`（被人拿在手上、但正文已经没了）的信一起归档，
不让它在 72 小时后回到海面变成僵尸。

另外两条和消失有关的行为：

- **扔回海里之后，自己当天不会再捞到同一封**（明天漂回来是合理的）。
  没有这个约束，同一个人下一次捞可能又捞到自己刚扔的那封——用户会觉得「什么都没变」。
- **「今天回信额度用完了，只能扔回去」不算抛弃**：那种情况不消耗瓶子寿命，
  回执里是 `counted: false`。只有「还有额度却选择不回」的，才真的在把它往外推。

### 让客户端知道一封信死了

`GET /quota` 多带两个字段（**正常运行期间永远是空数组**，只有重启后才可能出现内容）：

```jsonc
{
  "deadLetters": [{ "id": "l_abc", "why": "tsunami" }],  // why: tsunami | sunk | empty
  "heldByOthers": ["l_def"]                              // 我写的、正被别人拿在手上
}
```

客户端据此可以把「还在漂」改口，把手上那封已经没了三个按钮换成一个「珍藏」。
**只给 id，不给化名**：作者该知道「它被捡起来了」，但不该知道是谁捡的。

---

## 接口

除 `/register`、`/sea`、`/health`、`/stats.json`、落地页之外，全部需要 `authorization: Bearer <token>`。

| 方法 | 路径 | 干什么 |
|---|---|---|
| POST | `/register` | `{ hash }` → `{ token, pseudonym }`。同一个 hash 再注册会发新票，还是同一个人 |
| POST | `/throw` | `{ body }` → 把信扔进海里，扣 1 个寄信额度 |
| POST | `/catch` | 捞一封；回执只有化名与剩余次数，**没有正文** |
| GET | `/letter/{id}` | 取自己手上那一封的正文（客户端用它写本地信册，不进模型上下文）。**已归档或正文已失 → `410 gone`** |
| POST | `/reply` | `{ letterId, body }` 回一封。**每天有上限**（默认 3 封），见下节为什么 |
| POST | `/dismiss` | `{ letterId }` 扔回海里。回执带 `counted`：`false` = 今天回信额度用完了才扔的，**不消耗瓶子寿命**；同一只瓶子扔满 8 次裂开沉底 |
| GET | `/mailbox` | 我的信收到的回信 |
| GET | `/quota` | 额度 + 海啸记录 + `deadLetters` / `heldByOthers`（见下节） |
| POST | `/mail/take` | 领一封「海边邮局」的系统邮件（不占捞取额度） |
| GET | `/sea` | 此刻的海：潮位、月相、风向、能见度、水温、日出日落，外加「这片海起过几次浪」。**只有世界事实，没有一个字关于用户** |
| GET | `/health` | 运维探针：启动时间、`uptime`、种子代次与错误。**不报任何业务数字**——理由见下一节 |
| GET | `/stats.json` | 大屏的数据源：一个静态 JSON，只有加工过的数字 |
| GET | `/` | 一页静态说明。它不读数据库、不认 token、不回显任何参数 |

---

## 运维数字：公开的那份是「世界口径」

运营方需要日活、留存、投放量，这些必须算得准；同时公开页面上又不该把用户规模直接摊开。

这个仓库的做法是**两路分开**：

| 产物 | 内容 | 谁能看 |
|---|---|---|
| `data/stats.jsonl` | 每天一行**真数**：注册、活跃、新增、投递、捞取、回信、回信率、种子领取、海啸损失…… | 只有服务器持有者 |
| `server/public/stats.json` | **加工过**的数字，由 `/stats.json` 公开 | 所有人 |

公开那份的加工方式是「**真实值 + 世界里本就存在的量**」：

```
居民数量        = 真实注册玩家 + 世界观具名人物数
海上漂着的瓶子  = 真实 floating + 居民写过的信 × 潮汐摆动
海上出现过的信  = 真实累计投递 + 居民写过的信
```

那几个加数来自 `almanac/ledger.json`——一个只有运营者知道的台账，和种子一起同步，
服务端只读、热载、**从不对外**。结果是：

- 运营者随时能把真数减回来（更省事的办法是直接读 `stats.jsonl`）
- 外人要还原真值，得先读完所有种子信并数清里面出现过的人物
- **比率类指标（回信率、留存）加法盲化无效**（`(a+K)/(b+K) ≠ a/b`），所以它们从不进公开文件

还有一条必须守的规矩：**`/health` 不报任何业务数字**。它是公网可读的——只要给出池子计数或
种子总数，上面那套加数就能被一减而空。

> 你自己的实例完全可以不放水：不建 `almanac/ledger.json`，或者把里面的加数留成 0，
> 公开数字就等于真数。

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
pnpm test        # 9 个测试文件，117 个用例
pnpm typecheck
```

这些用例覆盖了服务端自己的行为：配额公式、去重、72 小时窗口、种子通道、探针不泄漏业务数字、
落地页不含任何接口细节、潮汐可复现、盲化不把真数漏进公开结构，以及一条最要紧的——
**统计脚本用的 `Db.readRaw()` 绝不会把 `floating` 判成海啸**（用 `Db.open()` 会，那等于每晚自造一次海啸）。

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
