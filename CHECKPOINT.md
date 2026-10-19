# 检查点：碰撞功能（未完成，交接用）2026-10-17

## 这是什么
插件 dsh-game-pet-watch @ **0.9.2** 的完整快照 + 副本周期的改动记录。
**已知缺陷：宠物之间不会互相弹开**（检测能报、台词能出、本体不动）。

## 已查清的正确路径（下一轮照这个做）
1. 渲染端：把 sprite 的 body 盒 `{x,y,size,bottomPad}` 经 `toScreen()` 缩放后，
   随 `sendBounds()` 一起上报（`sprite.js` 的 `sendBounds` 已经在上报 boxX/boxY/size/bottomPad ✓
   —— 缺的是**对家**的那一份）。
2. 主进程：把对家的 body 盒按原版消息名 `pet:flight-states` 广播给宠物窗
   （`gpw-main.cjs` 已通 ✓，payload `{petId: {x,y,vx,vy,size,bottomPad}}`）。
3. 渲染端自己的 `collidePet()`（`shared-core.js:1225`）就会**每帧**真判：
   - 法线 = 质心连线；`vrel <= 0` 直接不撞（这是"不卡住"的关键）；
   - 质量 = size²；恢复系数 `PET_BOUNCE_E`；只改法向分量；
   - 飞行方写回自己的 vx/vy；被撞方 `reportCollide(pid, hvx, hvy)`
     → 主进程 `pet:collide-result` → 目标窗 `startThrow(x,y,vx,vy)`（真的被抛出去）。
4. 插件侧：碰撞台词改成由 `pet:collide-result` 事件驱动，
   **删掉**自己那条 HTTP 轮询判定（现在加了">30px/s 才触发"的补丁，是权宜之计）。
5. 前提：`pet-config.json` 的 `physics.petCollision = true`（本检查点已开 ✓），
   且**必须甩出去**（原版只在飞行中判定，静止不撞）。

## 今天的弯路（别重走）
- ✗ 用"窗口右下角 180 方框"猜包围盒 → 坐标全错；
- ✗ 插件每 500ms 发 `/gpw/hit` 外部冲量 → 把宠物推进抛掷态 → 重力接管 → 两只互推往下滑；
- ✗ 在 gpw-main.cjs 里 `require('./electron-helper/main.js')` 调它的内部函数
  → **该模块被重新执行一遍**（报错 `app.disableHardwareAcceleration() can only be called before app is ready`）
  → 注入进的是另一份 petStates，真正的站场永远是空的 = "完全没有判定"的真正原因。
- ✗ 判定和台词的频率/口径与"每帧物理"不匹配 → 只能报重叠，不可能弹开。

## 当前可用的部分（已实测）
- 两只鱼独立记忆/图库描述/QQ 绑定/连接池（fish-board/2）✓
- 静止时不动、不弹回原位、不报假碰撞、台词不刷屏 ✓
- 碰撞盒监视页 `http://127.0.0.1:19387/game-pet-watch/boxes` ✓（可看 /rects 的实时坐标）
- 副本 `GET /gpw/collide-debug`、`POST /gpw/hit`、`POST /gpw/nudge` ✓
