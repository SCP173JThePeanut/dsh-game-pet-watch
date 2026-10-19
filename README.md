# dsh-game-pet-watch 🎮🐟

**简介.** DSH 的桌宠"大脑"：定时截一张游戏画面，交给多模态模型判断要不要说话；
要说，就把台词打在桌面宠物（`dsh-pet-gpw` 副本）的气泡上。支持**多只鱼各自隔离**
（记忆 / 人设 / 图库描述 / QQ / 端口各自一份）、长期记忆自动压缩、表情包图库、
游戏事件解读、QQ 群聊，以及两只鱼**跨进程真撞**（物理仍在渲染端，插件只出台词）。

一句话数据流：

```
定时器 ──截屏──► 模型裁决 ──► 气泡 / QQ
   │                 └──► 记忆（短期→压缩成长期）
   └──► 鱼板网络：其它鱼说的话
```

---

## 从 GitHub 装

```sh
git clone https://github.com/SCP173JThePeanut/dsh-game-pet-watch
cd dsh-game-pet-watch
npm pack                                    # 生成 dsh-game-pet-watch-<版本>.tgz
dsh plugin --profile desktop add ./dsh-game-pet-watch-<版本>.tgz
```

桌宠本体（运行时 + 动画素材）在姊妹仓库：**https://github.com/SCP173JThePeanut/dsh-pet-gpw**

两个包都要装：插件负责"看画面 + 说话"，桌宠负责"显示气泡 + 碰撞 + 右键菜单"。

## 安装

DSH 的插件就是普通 npm 包 + 一个 patch 声明。装进某个 profile：

```sh
dsh plugin --profile desktop add "G:\goh agent\dsh-game-pet-watch"   # 本地目录
dsh plugin --profile desktop remove dsh-game-pet-watch               # 卸载
```

做到这一步，profile 里会多两样东西（这是 DSH 的规则，手工装也一样）：

1. `package.json` 的 `dsh.profile.bundles` 里有 `dsh-game-pet-watch`；
2. 该包的 `cordis.patch.yml`（`dsh.bundle.patch`）被当成"插入一行"的声明；
   你自己的 `profiles/<名>/cordis.patch.yml` 里的 `game-pet-watch` 那行用来覆盖配置。

**版本入口**：`index-<版本>.js` 只是转发到 `index.js`（加载器按模块 URL 缓存，
换文件名才会重新求值）。当前是 `index-1.0.0.js`；历史入口只增不改，方便回滚。

## 使用

- **开箱即用**：装好重启 DSH 就会自己拉起桌面宠物（保活每 15 秒探一次，没起来就拉）。
- **设置页**：DSH → 设置 → 桌宠（`game-pet-watch`）。常用项：
  `intervalSec` 看画面间隔、`cooldownSec` 开口冷却、`maxChars` 单句字数、
  `pluginPort` 插件端口（0 = 自动）、以及人设 / 开口规则 / 长期记忆压缩提示词。
- **面板**：右键桌面宠物 → 观察面板；`/game-pet-watch/history` 是历史页，
  `/game-pet-watch/boxes` 是碰撞盒监视页，`/game-pet-watch/qq` 是群聊记录。
- **多只鱼**：设置页可增删鱼（id / 名字 / 端口 / 是否接 QQ），每条鱼独立的
  记忆、图库描述、人设、`jitterSec`（观察间隔的随机波动）、压缩说明。
- **碰撞**：两只鱼撞上时各冒一句台词；谁撞谁、弹开多少由宠物进程自己的物理决定，
  插件只负责台词与跨进程转发。

## 端口与地址（会变的东西都别写死）

宿主 DSH 的 web 端口是随机的（实测走过 19387 → 60010 → …）。所以：

- 插件地址由 `ownOriginNow()` 解析：设置里的 `pluginPort` → `DSH_WEB_ORIGIN/PORT` → 请求里的 `req.socket.localPort`；
- **不猜端口**：不扫描本机监听口、不往陌生端口发请求（这条踩过坑，把别的程序打坏过）；
- 插件把"插件地址 + 鱼表"写到公共位置 `~/.dsh/fish-board/registry.json`
  （`protocol: fish-board/3`，60 秒刷新；副本优先读它，失败即失效缓存）。

## 开发 / 发布流程（源码是唯一事实源）

现在的安装是**从发布包装的**（`node_modules/dsh-game-pet-watch` 是实体副本，不是链接到仓库），
所以改仓库不会自动生效。固定流程：

```
改仓库 → npm run install-local → 重启 DSH
```

```powershell
cd "G:\goh agent\dsh-game-pet-watch"
npm test             # 单测（第一次安装 / 导出面 / 鱼表 / 配置 / 图库 / 表情包 / 多行）
npm run preflight    # 必跑：会真跑一次 apply()，抓初始化期错误
npm run install-local  # 打包两个仓库 → 装进 profile/node_modules 与 app-install → 更新 profile/patch
npm run sandbox      # 可选：全新 HOME 里起一个真宠物，验证发布包能独立跑
npm run backup -- --label 改啥之前   # 动代码前的仓库快照（落到 archive/backups/）
```

`install-local` 具体做：`npm pack` 插件与桌宠两个仓库 → 整份替换安装目录 →
把 profile 依赖写成 `file:<dist 里的 tgz>`、bundles 补回本插件 →
把 patch 那行的 `name` 指到当前入口、`gpwRoot` 指到装出来的桌宠目录。

> ⚠️ **路径类设置必须写进 schema**（`gpwRoot` / `upstreamPetRoot` / `upstreamRoot` 已声明）：
> 宿主只把 schema 认识的配置键传给插件，未声明的键即使写在 patch 里也会被**静默丢掉**。
> 症状：patch 里明明有 `gpwRoot`，插件 `config.gpwRoot` 却是空 → 保活去找"插件旁边的兄弟仓库" →
> 报"缺副本入口"。这条是 2026-10-18 真踩出来的。

卸载 / 备份 / 还原：`scripts/uninstall-all.mjs`（默认 dry-run，`--yes` 才动）、
`scripts/backup-all.mjs`、`scripts/restore-all.mjs`。

## 依赖

- 运行时不依赖别的 npm 包（`@deepseek-ai/schemastery` 是宿主给的，缺了就降级成无 schema）；
- **动画素材自带**（2026-10-18 起）：`dsh-pet-gpw/assets/` 里有一份完整素材
  （144 个文件 / 60.7 MB：106 个 webm + 字体 + 内置表情 + `config.jsonc`），
  解析顺序是 配置 `upstreamPetRoot` → **副本仓库自带的 `assets/`** → profile 里的 `dsh-pet`。
  也就是说 `dsh-pet` 包已经不是必需依赖了（保留它只当旧环境的兜底）。
- 桌面宠物本体在另一个仓库 `dsh-pet-gpw`（`runtime/gpw-main.cjs` 是入口）。

## 沙盒（模拟第一次安装）

```powershell
npm run sandbox          # 跑完自动清理
npm run sandbox -- --keep   # 保留临时目录（看宠物日志）
```

它会：开一个全新 `DSH_HOME`（没有任何配置/记忆/鱼表）→ 加载插件并自己起 HTTP 服务 →
**真的拉起一个 Electron 宠物**（临时用户目录、**不传 `GPW_UPSTREAM_ROOT`**，逼它用仓库自带素材）→
断言：只有一只默认宠物、默认提示词、登记簿里正好那一只、宠物自报地址、`/rects` 收到坐标。

