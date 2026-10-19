# dsh-pet-gpw 🐟

**dsh-pet 的独立副本**：单独一只桌面宠物，带「鼠标扫过就冒出来的输入框」和「右键打开的观察面板」。
原版 dsh-pet 一个字不改、照旧日常使用；两只宠物可以同时挂在桌面上。

```
   鼠标扫过宠物 ──► 输入框浮出（Enter 发送）
                        │
                        ▼
        dsh-game-pet-watch（DSH 插件）──► 截游戏画面 + 模型裁决
                        │
                        ▼
             副本 /gpw/say ──► pets.<id>.say ──► 🐟 气泡（+ 语音动作）
                        ▲
        右键宠物 ──► 观察面板（状态 / 记录 / 提示词）
```

## 从 GitHub 装

```sh
git clone https://github.com/SCP173JThePeanut/dsh-pet-gpw
cd dsh-pet-gpw
npm pack                                    # 生成 dsh-pet-gpw-<版本>.tgz（约 59MB，含动画素材）
```

本目录是插件仓库内的 `pet/`（单包发布的一部分）：插件装上后会自动用它启动桌宠，
不需要单独安装。

开发时也可以单独跑（宠物本体 + 菜单 + 记录网页），此时没有观察与台词。

## 它能干什么

| 交互 | 行为 |
| --- | --- |
| **鼠标扫过宠物** | 宠物下方浮出一条输入框；移开 1.4 秒后自动收起。回车 = 把这句话发给插件，答案仍走宠物气泡 |
| **右键宠物** | 打开观察面板（无边框窗）：状态 / 记录 / 提示词三页签 |
| **状态胶囊** | 宠物右上角常驻一颗小胶囊：`观察中 · 52` / `已暂停` / `插件离线`，点它也能开面板 |
| **宠物本体** | 完全复用原版渲染器（106 段动画、点击 Q 弹、拖拽、右键菜单都在）——它只是被摆成"定点陪伴" |

## 怎么启动 / 停

```bash
node scripts/gpw-start.mjs          # 启动（默认端口 7341，Electron 取 ~/.dsh/electron/electron.exe）
node scripts/gpw-start.mjs --stop   # 停掉
node scripts/gpw-start.mjs --port 7342 --plugin http://127.0.0.1:19387
```

排障（自检，不靠猜）：

```bash
# 带调试端口启动，然后：
node scripts/gpw-inspect.mjs                 # 打印宠物/浮层/视频的真实状态
node scripts/gpw-inspect.mjs --say "你好"     # 推一句话，验证气泡链路
node scripts/gpw-inspect.mjs --raw "<js>"     # 在页面里求值
```

## 它和原版的关系（隔离清单）

| 面 | 副本 | 原版 |
| --- | --- | --- |
| 进程 | 自己的 Electron 进程 | 宿主拉起的 helper |
| userData | `%APPDATA%\dsh-pet-gpw-helper`（`app.setName` 换过） | `%APPDATA%\dsh-pet-electron-helper` |
| HTTP 端口 | 7341（自己的宠物服务） | DSH WebServer 的 `/dsh-pet-7340` |
| 配置 | `~/.dsh/dsh-pet-gpw/pet-config.json` | `~/.dsh/dsh-pet/main-config.jsonc` |
| 动画素材 | **只读**原版包的 `assets/`（不复制 61MB） | 自己的 |
| 动画池定义 | **只读**原版包的 `assets/config.jsonc`（106 段动画的权重都在那） | 自己的 |
| 代码 | `runtime/electron-helper-copy/`（原版逐字节拷贝 + 两处改动） | 不受影响 |

拷贝里只改了三处，其余文件 `md5` 与原版一致：
1. `app.setName('dsh-pet-gpw-helper')` —— 换 userData 目录，两个助手不互踩
2. `loadFile('electron-helper-copy/index-gpw.html')` —— 加载带浮层的页面
3. `query` 里多一个 `plugin=` 参数 —— 告诉浮层去哪找插件

`index-gpw.html` = 原版 `index.html` + 浮层样式 + 一行 `<script src="./gpw-overlay.js">`。
`preload.js` = 原版 preload + `gpwHost`（开面板 / 外链 / 自检）。

## 宠物配置

`~/.dsh/dsh-pet-gpw/pet-config.json`（改完重启副本生效）：

```jsonc
{
  "main": {
    "pets": [{
      "id": "gpw", "name": "大肥鱼（副本）", "size": 320,
      "display": "desktop",        // 副本只在桌面上（网页里那块面板已拆掉）
      "fixedEnabled": true,        // 定点陪伴，不漫游
      "position": { "corner": "bottom-right", "marginX": 16, "marginY": 16 },
      "balanceEnabled": false, "whisperEnabled": false, "workStatusEnabled": false
    }],
    "animations": {}               // 空 = 用原版完整动画池（随机动作链，宠物才活）
  }
}
```

## 踩过的坑（留个记录，别再踩）

1. **`"type": "module"` 会让 Electron 主进程报 `require is not defined`** —— 主进程文件必须叫 `.cjs`。
2. **透明窗 + 视频在 Windows 上可能完全不上屏**：我第一版自己写的 `BrowserWindow` 就是这种（DOM 一切正常、
   `isVisible()` 为真、截图里却什么都没有）。最后改成复用原版助手的窗口代码（它对 DWM/合成做了实测取舍）。
3. **窗口几何别自己算**：原版助手按 DPI 补偿把窗口算到了屏幕外（x=1817 > 屏宽 1707）。
   现在由主进程按**页面报告的屏幕尺寸 ÷ 缩放**纠一次——**只在启动时、且只在窗口真的越界时**。
4. **千万别把位置纠正写成定时循环**（我自己踩过）：拖拽是渲染端逐帧上报、主进程跟着移动窗口，
   一个每 2 秒的"归位"必然在拖拽中途把窗口按回角落——症状就是"拖着拖着隔一会儿自己弹回去"。
   证据：日志里连续 6 条 `宠物窗校正到 747,246`。现在的实现只在启动时判一次越界，之后再不插手。
5. **悬停不能让渲染端自己听 `mousemove`**：整窗点击穿透时 Electron 的 forward 鼠标事件在 Windows 上不可靠。
   现在由主进程每 60ms 推光标坐标。
6. **坐标系有三套**（页面 CSS / `win.getBounds()` 的 DIP / `screen` 的物理像素）：
   实测本机 `dpr = 1.5`、`win.getBounds().width = 960`、`innerWidth = 640`，
   页面的 `screenX/screenY` **已经是 CSS 系**。屏幕→页面的换算就是 `x / devicePixelRatio - bounds.x`，多乘一次就全错。
7. **Windows PowerShell 5.1 按 ANSI 码页读 `.ps1`**：脚本里有非 ASCII 字节会在第一条语句前就解析失败（截图脚本因此保持纯 ASCII）。
8. **`"type": "module"` 的包里，Electron 主进程文件必须叫 `.cjs`**，否则 `require` 直接报错。
9. **patch 里给行写 `name:` 要小心**：写 `dsh-game-pet-watch/index-x.y.z.js` 这种子路径时，
   包的 `exports` 必须显式导出该模式（否则解析失败、整行静默不加载）。现在改回走包默认入口，不再依赖这个技巧。
