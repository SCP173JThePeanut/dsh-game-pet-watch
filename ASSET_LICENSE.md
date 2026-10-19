# 素材与授权说明（Asset notice）

本仓库的**代码**与**素材**适用不同授权，请分别阅读：

| 范围 | 授权 | 说明 |
| --- | --- | --- |
| 本仓库的插件代码（`index.js` / `src/` / `web/` / `client.js` / `scripts/`） | **MIT**，见 [LICENSE](./LICENSE) | © 2026 SCP173JThePeanut |
| `pet/` —— 原版 dsh-pet 的运行时副本 | **MIT**，见 [pet/LICENSE](./pet/LICENSE) | © 2026 PC2005-cloud，来自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) |
| `pet/assets/webm/` —— 106 段透明动画 | 随上游 **MIT** | 由 dsh-pet 的 AI 生成素材链产出，本仓库未改动编码 |
| `pet/assets/fonts/上首软糖体.ttf` | **归字体作者所有** | 仅供本地演示，**不要商用或再分发**；如需发行请换成可商用字体或删除 |
| `pet/assets/memes/` —— 梗图表情包 | **归各原作者所有** | 图源为网络表情包站（如 [爱梗图](https://aigengtu.com/)），仅作演示；再分发前请自行确认授权或替换 |
| `pet/assets/pic/` —— 光标 / 通知小图 | 本仓库自制 | 随代码 MIT |

## 上游项目

`pet/` 是 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的副本，
用于让插件**自带桌宠运行时**（免去单独安装第二个包）。它的动画素材由上游的
「提示词 → 源视频 → 透明动画」链路生成，上游以 MIT 分发，版权声明保留在 [pet/LICENSE](./pet/LICENSE)。

本仓库对 `pet/` 的改动只有两类，都能在提交历史里逐条看到：

1. **新增**：状态胶囊、观察面板、「记录网页」菜单、真身盒上报、跨进程碰撞接入、多实例端口自愈；
2. **调整**：去掉「打开网站」菜单项、按 DSH 插件方式读取配置、启动参数支持多鱼。

动画渲染、拖拽甩抛、屏幕漫游、pet pack 等原版功能**没有改动**。

## 不随包分发的东西

- 记忆、日志、截图、表情包图库都在运行时写到 `~/.dsh/`，不入仓库；
- 游戏事件文件、游戏机制库、QQ 账号凭证都由使用者自己提供，仓库内不含任何游戏内容。
