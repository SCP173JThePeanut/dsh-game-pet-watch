# 交接说明 · dsh-game-pet-watch / dsh-pet-gpw（2026-10-17）

> 写给 opencode：今天这一大轮改动的**全部内容**、**为什么**、**坑在哪**、**还剩什么**。
> 版本：插件 **0.7.99**（`index-0.7.99.js` → `index.js`）。一共 5 个仓库/目录参与，见 §1。
> 一句话概括：**一个大脑驱动多条鱼**，图库文件共用一份、描述与记忆各存各的、QQ 连接与账号按鱼独立，
> 并且所有"端口/认鱼"逻辑收口到了一个新模块 `src/fish.js`（带单测）。

---

## 1. 现场（进程 / 端口 / 路径）

| 东西 | 路径 | 端口 | 说明 |
| --- | --- | --- | --- |
| 大脑插件（ESM） | `G:\goh agent\dsh-game-pet-watch` | 挂在 DSH 的 19387 下，前缀 `/game-pet-watch` | 截屏 / 模型 / 记忆 / QQ / 图库 |
| 桌宠本体（Electron fork） | `G:\goh agent\dsh-pet-gpw` | 7341（默认 profile）、7342（`--profile second`） | 窗口 + 气泡 + 观察面板 + 输入框 |
| DSH profile | `C:\Users\Kishin\.dsh\profiles\desktop\` | — | `cordis.yml`(DSH 每次重建) / `cordis.patch.yml`(覆盖层) |
| 插件自管数据 | `C:\Users\Kishin\.dsh\game-pet-watch\` | — | `config.json` + 记忆/图库/账本/日志 |
| 鱼的用户目录 | `~\.dsh\dsh-pet-gpw[-<profile>]` | — | 各自的 `memes/`、`state.json`、`helper.pid` |

**当前两条鱼**（`config.json` → `pets`）：

```jsonc
[
  { "id": "legacy",  "name": "鱼板妹妹7341", "origin": "http://127.0.0.1:7341",
    "scope": "legacy", "profile": "",       "qq": false, "enabled": true },
  { "id": "current", "name": "鱼板妹妹7342", "origin": "http://127.0.0.1:7342",
    "scope": "current","profile": "second", "qq": true,  "enabled": true }
]
```

**铁律**：`defaultFish`（7341，profile 为空）≠ `primaryFish`（`qq:true` 那条 = 7342）。
`defaultGpwOrigin()` 管启动器/保活；`primaryGpwOrigin()` 管回话/群操作。混用会把端口搞错（踩过两次）。

---

## 2. 新模块 `src/fish.js`（今天最重要的结构性改动）

以前端口解析与"认鱼"散在 `index.js` 各处（`origin.split(':').pop()`、`fishFromQuery()`、
`fishOfScope()`、内联 `.find(f => …)` 至少四份）。现在**只有一处**：

| 函数 | 用途 |
| --- | --- |
| `portOf(origin)` / `originOfPort(port)` / `normalizeOrigin(raw)` | 端口 ↔ origin（取不到返回 0，绝不返回垃圾） |
| `scopeOf(fish)` | 记忆/图库目录后缀（`memory-<scope>.json`、`image-catalog-<scope>.json`） |
| `profileOf(fish)` | 副本用户目录后缀（`''` = `~/.dsh/dsh-pet-gpw`；其它 = `-<profile>`） |
| `findFish(pets, {id,scope,port,origin})` | **认鱼唯一入口**，优先级 id > scope > port > origin |
| `primaryFish` / `defaultFish` / `enabledFish` | 业务主鱼 / 默认鱼 / 启用集 |
| `freePort(pets)` / `uniqueFishId(pets)` | 下一个可用端口（7341–7399）/ 不撞的 id |
| `makeFish({pets,name,port,qq,qqAccount,…})` | **造一只新鱼**（端口/id/scope/profile 自动） |
| `qqOf(fish, config)` | 这条鱼用哪个 QQ 号 / 哪个 OneBot 端点（没绑 → 回落全局） |
| `maskSecret(token)` | 只回显 `abcd****mnop`（接口/日志永不回显完整 token） |
| `summarize(fish)` | 日志里的一行摘要 |

单测：`tests/fish.test.mjs`（**57 项全过**，纯函数、秒级）。改这个模块**先跑它**。

```powershell
cd "G:\goh agent\dsh-game-pet-watch"
node tests\fish.test.mjs
```

---

## 3. 接口变更一览

### 新增路由

| 路由 | 说明 |
| --- | --- |
| `GET/POST /config` | 设置页通用读写。白名单键（见 §4），改**内存**（立即生效）+ 落盘 |
| `GET /owners` | 图库归属账本：`{counts, backlog, items}`，`items["0001"].legacy = {at,model}` |
| `GET /history` / `GET /qq` | 两个网页（`web/history.html`、`web/qq.html`，**用绝对路径**，见 §6） |

### 已有路由的**按鱼**改动（都认 `?port=7341` 或 `?fish=legacy`）

| 路由 | 变化 |
| --- | --- |
| `GET /state` | 一直就按鱼（状态胶囊用它） |
| `GET /memory` | **新**：按鱼取记忆，返回带 `fish` 标识；POST 的 `note/remove-note/clear` 也作用到那条鱼 |
| `GET /history.json` | **新**：`collectHistory({fish})` → 记忆用那条鱼的、副本日志拉**它自己的** origin、鱼板/日志按 `who` 过滤 |
| `POST /ask` | **新**：认鱼支持 `{fish}`/`{fishId}`/`{port}`/`{scope}` 与 `?port=`；**回话目标**透传到 `pushToPet(…, originOverride)`（7341 问就 7341 答） |
| `GET /images` | **新**：整库 + `mine`/`by` 标记 + `mineCount` + `fish`；**不再按 `by` 过滤**（页面要全库，挑图才过滤，见 §5） |
| `GET /onebot` | **新**：`connections: [{fish,url,account,source,configured,connected,selfId,events}]`；`status` 仍保留 = 业务主鱼那条 |
| `GET /state` | 新增 `onebotConnections`（同上） |

### `/pets` 的动作（多鱼管理）

| action | 说明 |
| --- | --- |
| `master` | 多鱼总闸 `{enabled}` |
| `toggle` | 单鱼开关 `{id, enabled}` —— **关掉会立刻停掉它的副本进程**，开回来会立刻 `ensureFork` 拉起 |
| `set` | 整表替换 `{pets:[...]}` |
| **`create`** | **新建桌宠** `{name?, port?, qq?, qqAccount?}` → 自动挑端口/id/scope/profile，并立刻拉起 |
| **`bind-qq`** | **QQ 号绑定** `{id, qqAccount, onebotUrl, onebotToken?}`（留空 = 用全局；不传某字段 = 保持原值） |

`GET /pets` 现在每条鱼多两个字段：`qqBinding {account,url,tokenMasked,bound,source,usable}`、以及 `nextPort`。

### `/images` 的动作

| action | 说明 |
| --- | --- |
| `redescribe` | `{fish, limit}` 按鱼批量重写描述（**显式调用一定用该鱼口吻**，每张一次视觉调用） |
| **`adopt`** | `{fish}` 把该鱼目录里 `by` 为空的老描述**认领为它自己的**（老数据要它才对得上账） |
| `set-cap` / `set-evict` / `set-collect` / `open` | 原有 |

---

## 4. 配置键（`config.json` / `/config` 白名单 / DSH 设置页 schema）

今天新增：

```jsonc
{
  "modelSource": "session|custom",   // 模型路由来源；custom 时用下面两个
  "modelProvider": "deepseek-account",
  "model": "deepseek-flash",
  "apiKey": "",                      // 留空 = 用 DSH 已有凭证/登录账户
  "describePerFishVoice": true,      // 描述是否按各自鱼的口吻生成
  "describeBacklogPerSync": 5,       // 每次同步每鱼最多补几张自己的描述（0 = 关；每张一次视觉调用）
  "adoptUnownedFor": "legacy",       // 启动时把"无归属老描述"自动认给哪条鱼（空 = 不认领）
  "pets[].personality" / "pets[].rules"     // 按鱼人设覆盖（现在两条都空 = 用全局）
  "pets[].qqAccount" / "pets[].onebotUrl" / "pets[].onebotToken"   // QQ 号绑定（按鱼）
}
```

### ⚠️ 最大的坑：`normalizeConfig` 是**白名单式重建**

`out = {...DEFAULTS}` + 逐键 `if (typeof src.x …)`。**新加的键只要忘了在这里列出来，值就会在进入内存前被丢掉**，
而写文件的路径是另一条（`writeLocalConfig` 原样落盘）→ 结果"文件里有、内存里没有"，界面全显示正常，只有行为不对。

今天因此踩了两次：`modelSource`（导致模型路由永远回落默认 → 撞失效 key）、`by`（老描述凭空"消失一百多张"）。
现在已经加了**兜底搬运**（写在显式校验之前：`DEFAULTS` 里存在且类型对得上的键一律照抄），
但**新增键仍必须同步三处**：`DEFAULTS` → `normalizeConfig`（或依赖兜底）→ `/config` 的 `CONFIG_KEYS`。

---

## 5. 图库归属（今天的产品规则）

```
图片文件：**只有一份**（数字编号 0001.png…，在 ~/.dsh/dsh-pet-gpw/memes，两条鱼共用）
描述：**按鱼各一份**（image-catalog-<scope>.json，同一个 file 路径、各自的 text）
挑图：**只用自己名下的**（提示词里只放 item.by === fish.id 的；一条都没有时退回整库兜底）
页面：/images 返回**整库** + mine 标记 + mineCount（页面是浏览，不是挑选）
账本：image-owners.json（counts / backlog / items）+ GET /owners
```

- 目录条目新字段 `by`（谁生成的）——`src/catalog.js` 的 `describeOne({... by})`
- 老条目没有 `by` → 靠 `adopt` 或 `adoptUnownedFor` 认领（**不认领就会"老描述消失"**）
- 后台补描述：`refreshImageOwners({describe:true})`，**每鱼每轮上限 `describeBacklogPerSync`**，
  且**有 10 分钟时间闸**（`BACKLOG_MIN_MS`）——同步也会被"群里来一张图"触发，没有闸一张群图会烧 2×5 次视觉调用

---

## 6. 前端

### DSH 设置页（`client.js`）

- 挂在 slot **`settings.section`**，`id: game-pet-watch`、`order: 50`、`label: () => '桌宠'`
- 写法与 **dsh-pet 的 `lib/client.js`** 完全一致：`ctx.slots.inject('settings.section', function* () { yield ctx.slots.register({…}, PetSettings) })`
- **CSS 照抄 dsh-pet 的 settings.ts**（卡片/网格/字段/复选行/`?` 提示气泡），类名前缀换成 `gpw-cfg`
- 卡片：总开关 / **每条鱼独立开关（含 QQ 号绑定两行输入）** / 模型 / 多鱼与 QQ / 图像与图库 / 节奏 / 人设
- **规矩**：hooks 只能在组件函数体顶层；绝不能写在导入期执行的代码里（2026-10-17 因此把 DSH 弄崩过一次）
- 注册整段包 try/catch

### 网页（`web/`）

- `web/history.html`、`web/qq.html`（都是今天重写的）
- **必须用绝对路径** `/game-pet-watch/...` —— 页面地址是 `/game-pet-watch/history`（无尾斜杠），`../x` 会跑到根目录 → 空响应 → "Unexpected end of JSON input"
- history 支持 `?port=` / `?fish=`，出错会把原因**显示在页面上**
- 两个页面都只依赖 `/pets`、`/history.json`、`/qq.json`，路由每次请求重读文件 → **改完刷新即生效，不用重启**

### 副本面板（`dsh-pet-gpw/runtime/electron-helper/gpw-panel.js`）

`api()` 全部经 `withPort()`，用自己的 `?port=` —— 所以**插件侧每个接口都必须认这个参数**，
今天 `/memory`、`/history.json`、`/images` 都因为忽略它而"两个面板显示同一条鱼"。

---

## 7. 副本（Electron fork）侧改动

| 文件 | 改动 |
| --- | --- |
| `runtime/gpw-main.cjs` | `/chat` 转发插件时带 **`port`/`fishId`/`scope`**（否则插件认不出是谁在问 → 7341 问、7342 答）；`memeDirs` 增加 **`GPW_SHARED_MEMES`**（共享图库目录，不复制文件） |
| `runtime/gpw-server.cjs` | `/gpw/brand` → **`fish-board/2`**，新增 `scope` / `fishId`（来自 env `GPW_FISH_SCOPE` / `GPW_FISH_ID`） |
| `scripts/gpw-start.mjs` | 手动启动也注入 `GPW_FISH_SCOPE` / `GPW_FISH_ID` / `GPW_SHARED_MEMES`（否则脚本起的副本取图 404、握手无身份） |
| 协议文档 | `G:\goh agent\FISH-BOARD.md` 新增 §6 变更记录 |

**取图 404 的根因**：副本只从**自己的** `USER_ROOT/memes` 取图；共享库在默认鱼的目录里 →
第二只鱼取任何图都 404。修法是目录链里加一环共享目录（**不要复制文件**，主人明确要求"只存一份"）。

---

## 8. 今天修掉的 bug（根因 → 修法，方便你复看）

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| 两个面板显示同一条鱼的记忆/历史 | `/memory`、`/history.json` 不认 `?port=` | 加 `fishFromQuery()` + 按鱼取 store / `collectHistory({fish})` |
| 7341 问、7342 答 | 副本转发不带身份 + `pushToPet` 没带 origin（默认落主鱼） | 转发带 port/fishId/scope；`/ask` 认鱼；origin 透传到 `pushToPet` |
| `/ask` 丢"按鱼人设"、图库用错目录 | `consultModel(..., scope, **fish**)` 第 7 个参数没传 | 两条路径（`/ask`、game-event）都传 fish |
| 关了鱼不立即生效 | `enabled=false` 只停驱动、不停进程 | toggle 时 `stopFork(profile)`；开启时 `ensureFork()` |
| 7342 取图 404 | 副本只从自己的用户目录取图 | `GPW_SHARED_MEMES` 加进 `memeDirs` |
| 表情包页没有独立表示 | `/images` 忽略端口 | 按鱼返回（**整库 + mine 标记**，别再按 by 过滤，会"藏掉一百多张"） |
| 配图整体失效 | `imageInPrompt=false` | 打开（请求里能看到 `<meme_library>`） |
| 日志被刷爆 | "对家文件"每 4 秒一条且带条数（条数总在变） | 按**名字集合**节流，10 分钟最多一条 |
| 老描述"凭空少一百多张" | `by` 是后加字段，老条目无归属 | `adopt` 动作 + `adoptUnownedFor` 启动自动认领 |
| 7341 只回一句 / 两条鱼轮流不回 | 鱼表 `enabled` 被面板/设置页关掉 → 保活不管它 → 推给它的 `fetch failed` | 打开即可（`POST /pets {"action":"toggle",…}`）；判断口诀：先看 `/pets` 的 `enabled` 与 `gpw-start.mjs --list` |
| DSH 自己"无法响应" | 默认模型 `deepseek-official` 的 App-managed API key 失效 | `cordis.patch.yml` 覆盖 `agent-default-model` → `deepseek-account` / `deepseek-flash`；或在 设置→模型 里切到账号那条 |

---

## 9. 踩坑与规矩（请务必沿用）

1. **不要手改 `cordis.yml`**（DSH 每次启动重建）；只改 `cordis.patch.yml`（**只能覆盖已有 id**）或插件自管 `config.json`。
2. **重启才会加载新代码/新配置**；插件侧禁用→启用那种重载**不重新读 config.json**，也不重新求值模块。
3. **改插件代码后必须跑** `node scripts\preflight.mjs`：它真的 `import` 插件并**真跑一次 `apply()`**。
   今天它抓到过 `onebot is not defined`（连接池化后的裸变量）——**那种错会让 DSH 整个起不来**。
4. **出包**：`node scripts\bump-entry.mjs <新版本> --patch "C:/Users/Kishin/.dsh/profiles/desktop/cordis.patch.yml"`
   （加载器按 URL 缓存，必须换入口文件名）。
5. **改前先备份**：`node scripts\backup-repo.mjs --label 改啥之前`（保留最近 10 份）。
6. **`normalizeConfig` 白名单**：新增配置键必须同步 `DEFAULTS` / `normalizeConfig` / `/config` 的 `CONFIG_KEYS`（见 §4）。
7. **认鱼只用 `findFish()`**，别再手写 `split(':')` 或内联 `.find()`。
8. **多鱼三件套**：`scope`（记忆/图库目录）、`profile`（副本用户目录）、`origin`（端口）——三者一一对应，别混。
9. **视觉调用要封顶**：任何"批量描述/识别"都必须有 `limit` + 时间闸（每张一次视觉调用，真实花钱）。
10. **Windows 控制台是 GBK**：诊断脚本只打 ASCII，中文写 UTF-8 文件；给鱼发中文测试文本要走 UTF-8 文件（否则它收到的是乱码）。
11. **junction 事故**：这个插件在 profile 里是 `link:`（junction 到仓库）。曾用 `file:` 形式的 pnpm 安装 →
    清理旧链接时**顺着 junction 把仓库清空**。`package.json` 里必须保持 `link:G:/goh agent/dsh-game-pet-watch`。
12. **客户端插件（`client.js`）没有验证手段就别大改**：它坏在导入期会让 DSH 起不来。

---

## 10. 还没做完 / 可以接着做

1. **创建新桌宠的界面**：数据层已经齐了（`makeFish` + `POST /pets {"action":"create"}` + `nextPort`），
   面板/设置页加个按钮 + 端口预填即可。
2. **16 个丢失的测试套件**：仓库曾被 junction 事故清空，从 pnpm 副本救回运行时，
   但 `tests/` 只剩 Oct15 那 4 个（`config-store / images / memes / multiline`）+ 今天的 `fish`。
   丢掉的：`idents / prompt-guard / historyexport / board / collector / catalog / journal / peerfiles / memory / onebot / attachment-gc / launcher / goh / mechanics / config-defaults / entry-forwarder`。
3. **几个丢失的小工具**：`set-config-keys / wire-onebot / verify-onebot / normalize-memes / e2e-check / audit-descriptions / show-last-request / tail-log / audit-images`（后三个今天重写过，在 `scripts/`）。
4. **QQ 连接按鱼独立**：已经做了（连接池按端点、事件带鱼、`onebotSay` 走对应连接、`/onebot` 按鱼列状态），
   但**只有一条真号**在跑，多号的真实链路还没被验证过——第一次给第二条鱼绑号时请重点观察。
5. **DuckDuckGo 搜索**：这台机器 DNS 被污染（`duckduckgo.com` → Facebook 段），**必须走代理**；
   模型 API 直连/走代理都行。要"模型直连 + 搜索走代理"，请在 **Clash 里加 DIRECT 规则**，不要关系统代理
   （关掉系统代理，DSH 的搜索就废；而且 DSH 的网络栈对开关的反应不稳定）。

---

## 11. 验收命令（重启后照着跑）

```powershell
$B = "http://127.0.0.1:19387/game-pet-watch"

# 鱼表：两条都在、都 enabled、各自 QQ 绑定
curl.exe -s "$B/pets"

# 两条鱼各问一句（回话要落在自己的窗口里）
curl.exe -s -X POST -H "content-type: application/json" -d "{\"text\":\"ping A\",\"push\":\"gpw\",\"pet\":\"gpw\",\"port\":7341}" "$B/ask"
curl.exe -s -X POST -H "content-type: application/json" -d "{\"text\":\"ping B\",\"push\":\"gpw\",\"pet\":\"gpw\",\"port\":7342}" "$B/ask"

# 记忆/历史按鱼分开
curl.exe -s "$B/memory?port=7341" | findstr total
curl.exe -s "$B/memory?port=7342" | findstr total
curl.exe -s "$B/history.json?port=7341" | findstr count
curl.exe -s "$B/history.json?port=7342" | findstr count

# 图库归属
curl.exe -s "$B/owners" | findstr /C:"counts" /C:"backlog"
curl.exe -s "$B/images?port=7341" | findstr /C:"items" /C:"mineCount" /C:"fish"

# 副本进程 + 协议
& "G:\goh agent\dsh-pet-gpw\scripts\gpw-start.mjs" --list
curl.exe -s http://127.0.0.1:7341/gpw/brand     # protocol=fish-board/2, scope=legacy
curl.exe -s http://127.0.0.1:7342/gpw/brand     # protocol=fish-board/2, scope=second

# 真实发出去的模型路由（排障第一现场）
node -e "const fs=require('fs');for(const f of ['legacy','current']){const d=JSON.parse(fs.readFileSync('C:/Users/Kishin/.dsh/game-pet-watch/last-request-'+f+'.json','utf8'));console.log(f,(d.route||{}).provider,(d.route||{}).model,String(d.system||'').includes('<meme_library>')?'有表情包清单':'无清单');}"
```

---

*文档由「家里那只负责写代码的」在 2026-10-17 生成。所有结论都有实测依据（日志/抓包/接口返回值），
文中标注的"踩过/报过"都是真实事故，别当经验主义删掉。*

---

## 12. 回执（对 opencode 2026-10-17 的回执·§八）✅

你提的三条**全部采纳并已修**，另外自查时多补了一处（你自己的客户端 `pickPeers` 也不判协议）。

| # | 你的意见 | 我这边的处理 | 验证 |
| --- | --- | --- | --- |
| ① | `FISH-BOARD.md` §2.2（第 57 行）还写 `protocol === 'fish-board/1'`，§5 也是"字段对不对"，与 §1 示例的 v2 自相矛盾 | §2.2 改成 **`String(protocol).startsWith('fish-board/')`**，并写明"**字段缺失也认**"；§5 的排查项同步改成"是不是以 `fish-board/` 开头（**别要求等于某个具体版本**）"；你那条原始意见我**保留成历史记录**了（标了"已处理"） | 文档已改 ✓ |
| ② | `dsh-pet-gpw/scripts/gpw-smoke.mjs:46` 仍断言 `fish-board/1` | 改为 `String(j.protocol \|\| '').startsWith('fish-board/')` | **跑过**：`node scripts/gpw-smoke.mjs` → `✅ 全部通过` ✓ |
| ③ | 建议版本判定定成**前缀判断** | 文档已按此写死；理由也写进正文（同机两套 fork 不可能同时升级；v1→v2 纯加法；严格比对只会"对方莫名消失"） | ✓ |
| **④（我自查新增）** | — | 插件侧 `src/fishboard.js` 的 `pickPeers()` **原来根本不判协议** ✗ → 补上同样的前缀判断（缺字段也认），并把 v2 的 `scope`/`fishId` 一起带出来 | 语法 ✓ + `tests/fish.test.mjs` 57 项 ✓ |

### 两点说明

1. **关于"谁该严格、谁该宽松"**：两边现在**都是前缀判断** ✓ —— 这个方向上不可能再出现"一方升级把另一方藏掉"。
   我建议把它当成**协议规矩**固化：**主版本号只做前缀，小版本纯加法**；真要破坏性变更时，另起义项字段
   （例如 `protocol: 'fish-board/3'` + `breaking: true`），让消费方显式选择，而不是靠版本号相等来判断。
2. **冒烟脚本退出时有一行 libuv 噪音**：`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` ——
   出现在 `✅ 全部通过` **之后**、进程退出阶段 ✓（Node 在 Windows 上的已知收尾竞态），不影响结果 ✓。
   如果你也想消掉它，把脚本末尾的 `process.exit(0)` 换成自然结束（或 `setTimeout(()=>process.exit(0),50)`）即可。

### 我这边的版本

插件 **0.8.0**（`index-0.8.0.js`），preflight 全绿、`tests/fish.test.mjs` 57 项全过。
另外补充一件你可能关心的：`GET /gpw/brand` 的 v2 字段我这边**已经在用**了 ——
`pickPeers()` 现在把 `scope`/`fishId` 一起收下（面板/排障里能看到对等体是哪条鱼），
但**不依赖**它们（缺了照常工作 ✓）。
