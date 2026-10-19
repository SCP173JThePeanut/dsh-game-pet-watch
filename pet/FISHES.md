# 多鱼：同时养好几只桌宠（当前实现）

一只鱼 = **一个独立的 Electron 进程** + **一个端口** + **一个自己的用户目录** + **自己的一份记忆/描述/人设**。

"大脑"（截屏 + 模型裁决 + 记忆 + QQ）由 DSH 插件 `dsh-game-pet-watch` 提供 ✓ —— 现在它支持**一个大脑按鱼分发** ✓：
同一张截图 ✓，但每条鱼**各自决定、各自记忆、各自人设、各自端口** ✓。

---

## 一、现在这台机器上的两只鱼

| | 7341「之前那只」 | 7342「现在这只」 |
| --- | --- | --- |
| 进程 | 独立 Electron ✓ | 独立 Electron ✓ |
| 用户目录 | `~/.dsh/dsh-pet-gpw` | `~/.dsh/dsh-pet-gpw-second` |
| 名字 | 鱼板妹妹7341 | 鱼板妹妹7342 |
| 鱼表 id | `legacy` | `current` |
| 记忆文件 | `memory-legacy.json`（400 条 + 799 字长期记忆 ✓） | `memory-current.json` |
| 描述目录 | `image-catalog-legacy.json` | `image-catalog-current.json` |
| 图库 | **共享**（`memes/0001.png`… 数字名 ✓） | 同左 ✓ |
| 接 QQ | 否（`qq: false`） | **是**（`qq: true` ✓ QQ 回复走它 ✓） |
| 由谁拉起 | 插件**保活脚本**（`launchFork` ✓ 只管这一只 ✓） | **手动**：`--profile second --port 7342` ✓ |

---

## 二、端口的两条"规矩"（踩过两次坑 ✓）

插件里有两个**必须分开**的地址概念 ✗ —— 混用就会抢端口：

```
defaultGpwOrigin()   保活脚本用的"我的鱼在哪"   = config.gpwOrigin（固定 7341 ✓）
primaryGpwOrigin()   业务/QQ 用的"主鱼在哪"      = 鱼表里 qq:true 的那只（7342 ✓）
```

**事故记录**（两次都是同一个坑 ✗）：
1. 把 `gpwOrigin` 改成 7342 想让它接 QQ ✗ → 保活脚本把**默认那只鱼也拉到 7342** ✗ → 和第二只抢端口 ✓
2. 把 `defaultGpwOrigin()` 改成"优先取 QQ 那条" ✗ → 保活**又来一次** ✓
   → 表现：桌面上只剩一只、名字串了、pid 一直变 ✓。

**结论**：`defaultGpwOrigin()` **只能**看 `gpwOrigin`（= 默认鱼 = 7341）✓；
要给某只鱼派业务（QQ 等）请改**鱼表**里的 `qq: true` ✓。

---

## 三、插件侧的鱼表与接口

插件配置（自管 `~/.dsh/game-pet-watch/config.json`）里的鱼表：

```json
"pets": [
  { "id": "legacy",  "name": "鱼板妹妹7341", "origin": "http://127.0.0.1:7341", "enabled": true,  "scope": "legacy",  "qq": false },
  { "id": "current", "name": "鱼板妹妹7342", "origin": "http://127.0.0.1:7342", "enabled": true,  "scope": "current", "qq": true  }
]
```

每条鱼可选 `personality` / `rules` 覆盖全局人设 ✓；留空 = 用全局那份 ✓。
**鱼表为空**时行为与"单鱼时代"完全一样 ✓（向后兼容 ✓）。

| 接口 | 作用 |
| --- | --- |
| `GET /game-pet-watch/pets` | 看鱼表（含各自记忆条数/长期记忆长度 ✓） |
| `POST /game-pet-watch/pets` `{"action":"toggle","id":"legacy","enabled":false}` | **开关某条鱼**（改内存 → **立即生效** ✓ 不用重启 ✓） |
| `POST /game-pet-watch/pets` `{"action":"set","pets":[…]}` | 整表替换（加鱼/改端口 ✓） |
| `POST /game-pet-watch/ask` `{"text":"…","fish":"legacy"}` | 单独问某条鱼（用它自己的记忆与人设 ✓） |
| `POST /game-pet-watch/memory` `{"action":"compact","fish":"legacy"}` | 单独压某条鱼的长期记忆（**在它自己的上下文里压** ✓ 不会趋同 ✓） |
| `POST /game-pet-watch/memory` `{"action":"wipe"}` | 清空所有会话记忆（短/长/备注 ✓ 带备份 ✓） |

排障：`~/.dsh/game-pet-watch/last-request-<鱼的id>.json` = **这条鱼上一次真实收到的请求** ✓
（`system` / `messages` / `tools` 全在里面 ✓；中文用 VS Code 打开 ✓）。

---

## 四、桌宠进程怎么管

```powershell
cd "G:\goh agent\dsh-pet-gpw"

# 看有哪几只（端口/pid/活着没 ✓；中文名字写进 fish-list.txt ✓ 控制台只打英文 ✓）
node scripts\gpw-start.mjs --list

# 起/停/重启**指定**的那一只（不加 --profile 就是默认那只 7341 ✓）
node scripts\gpw-start.mjs --profile second --port 7342      # 起第二只
node scripts\gpw-start.mjs --profile second --stop           # 只停第二只 ✓
node scripts\gpw-start.mjs --profile second --restart        # 只重启第二只 ✓
node scripts\gpw-start.mjs --port 7341                       # 默认那只（也可 --stop / --restart）
```

- 每只鱼的用户目录：`~/.dsh/dsh-pet-gpw`（默认）/ `~/.dsh/dsh-pet-gpw-<profile>`（多鱼）✓
- 各自目录里存：`prefs.json`（名字/外观/位置/端口 ✓）、`state.json`（动作与对话记录 ✓）、`helper.pid`（✓ `--stop` 不会杀错 ✓）
- 素材（动画、表情包底图）**共用**上游包 `dsh-pet` 的 assets ✓

---

## 五、加一条新鱼（完整流程）

```powershell
cd "G:\goh agent\dsh-pet-gpw"
node scripts\gpw-start.mjs --profile third --port 7343 --name 鱼板妹妹7343

cd "G:\goh agent\dsh-game-pet-watch"
# 把它写进插件鱼表（立即生效 ✓ 不用重启 ✓）
curl.exe -s -X POST -H "content-type: application/json" -d "{\"action\":\"set\",\"pets\":[{\"id\":\"legacy\",\"name\":\"鱼板妹妹7341\",\"origin\":\"http://127.0.0.1:7341\",\"enabled\":true,\"scope\":\"legacy\",\"qq\":false},{\"id\":\"current\",\"name\":\"鱼板妹妹7342\",\"origin\":\"http://127.0.0.1:7342\",\"enabled\":true,\"scope\":\"current\",\"qq\":true},{\"id\":\"third\",\"name\":\"鱼板妹妹7343\",\"origin\":\"http://127.0.0.1:7343\",\"enabled\":true,\"scope\":\"third\",\"qq\":false}]}" http://127.0.0.1:19387/game-pet-watch/pets
```

它的记忆/描述会自动分开成 `memory-third.json` / `image-catalog-third.json` ✓（第一次用到时创建 ✓）。

---

## 六、注意事项

- **端口不要撞** ✓（撞了那只会起不来，日志里会说端口占用 ✓）。
- 两只鱼默认会出现在**同一个屏幕位置** ✓ → 拖开一只即可 ✓（位置存在各自 `prefs.json` ✓）。
- **改代码或改配置 → 只能完整重启 DSH** ✗ 别用"禁用→启用"那种重载 ✓（实测既不换代码也不重读配置 ✓）。
- 图库同步现在有**每次最多补 3 张描述**的上限 ✓（防一次性烧掉几百次视觉调用 ✓）。
- 手写状态文件（记忆等）必须和插件结构一致 ✓：`longTerm` 是 **`{at, text}` 对象** ✓，写成字符串会被静默丢弃 ✓。

---

## 七、插件的登记与灾难恢复（2026-10-17 实战）

### 插件是怎么被 DSH 加载的

```
profile/package.json     ← 依赖里必须有它（file:/link: 指向本仓库 ✓）
profile/cordis.yml       ← **DSH 每次启动都会重建** ✓（插件行在这里 ✓ 手改没用 ✗）
profile/cordis.patch.yml ← **覆盖层**（只能改已有行的 config ✓，**加不了新行** ✗）
```

### 那次事故的链条（很值得记）

```
① 盲改客户端插件 client.js ✗（import 阶段用 hooks ✗）→ DSH 启动失败 ✓
② 回滚 client.js ✓ → DSH 恢复 ✓
③ 点对话框的"禁用第三方插件、备份 profile patch 并重启" ✗
   → DSH 把该插件从 cordis.yml + cordis.patch.yml **双双移除** ✓
④ 只补 patch ✗ → 不够（覆盖层加不了行 ✗）
⑤ 补 cordis.yml ✓ → 又被 DSH 启动时重建覆盖 ✗
⑥ **正解**：走官方接口重新登记 ✓
     plugin_manager(install_bundle, "file:G:/goh agent/dsh-game-pet-watch")
   → 它跑 pnpm（本地 link ✓）、把行写回 cordis.yml ✓ → 重启即可 ✓
```

### 恢复三步（照这个顺序 ✓）

1. **先让自己能启动** ✓：回滚出问题的代码（`git checkout` 或手工还原 ✓）。
2. **再用官方接口重新登记插件** ✓：`plugin_manager` 的 `install_bundle`（spec 用 `file:` ✓）。
3. **最后才动配置** ✓：`cordis.patch.yml` / 插件的自管 `config.json` ✓。

### 两条硬规矩

- **不要手改 `cordis.yml`** ✗ —— 它每次启动都会被 DSH 重建 ✓。
- **客户端插件（`client.js`）没有验证手段就不要改** ✗ —— 它坏在 import 阶段会让整个 DSH 起不来 ✓。
