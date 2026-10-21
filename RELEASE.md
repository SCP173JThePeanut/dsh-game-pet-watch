# 更新要求（发版清单）

一句话：**仓库里只放"当前这一版"的东西，旧版本的文件在本地和远程都要删掉。**

每次新增版本（补丁/功能都算）都必须走完下面这几步，缺一步就等于给仓库留垃圾。

---

## 1. 改版本号

```powershell
cd "G:\goh agent\dsh-game-pet-watch"

# 插件版本
node -e "const fs=require('node:fs');const p='package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version='1.6.0';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n','utf8')"

# 桌宠副本版本（改了 pet/ 才需要）
node -e "const fs=require('node:fs');const p='pet/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version='0.1.18';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n','utf8')"
```

## 2. 换入口（会自动删旧入口）

加载器按模块 URL 缓存，改 `index.js` 不生效，必须换文件名：

```powershell
node scripts\bump-entry.mjs 1.6.0 --patch "C:/Users/Kishin/.dsh/profiles/desktop/cordis.patch.yml"
```

这一步会：

- 生成 `index-1.6.0.js`（只 re-export `./index.js`）
- **删掉除当前版本以外的 `index-<x.y.z>.js`**（规则：仓库只留当前版本）
- 把 `package.json` 的 `files` 里的入口名换成新的（漏了它新入口就不会被打进 tgz）

## 3. 跑测试

```powershell
npm test
node scripts\preflight.mjs
```

要求：`first-install` / `exports` / `fish` / `collide` 全绿，`preflight` 通过。

## 4. 提交前检查（这几样绝不能进 git）

- ❌ `*.tgz` / `*.zip`（构建产物，只放 `dist/`，`dist/` 不在仓库里）
- ❌ `node_modules/`
- ❌ 旧版本入口 `index-<旧版本>.js`
- ❌ 任何日志 / 记忆 / 截图

```powershell
git status --short
git ls-files "index-*.js"     # 应该只有一行：当前版本
```

## 5. 打包 + 提交 + 推送

```powershell
npm pack --silent                       # 产物在仓库根目录，用完必须移走
Move-Item dsh-game-pet-watch-1.6.0.tgz "G:\goh agent\dist\" -Force

git add -A
git commit -m "feat: ..."
git push
```

## 6. 建 Release（资产挂 tgz）

```powershell
gh release create v1.6.0 "G:\goh agent\dist\dsh-game-pet-watch-1.6.0.tgz" --title "v1.6.0 — 一句话说明" --notes "..."
```

Release 说明里写清楚：改了什么、怎么验证的、有没有迁移动作。

## 7. 删旧版本（远程也要删）

这一步就是主人的要求：**新版本上线后，旧的版本化文件不能在远程仓库里留着**。

```powershell
# 旧入口文件（如果有残留，本地删 + git rm 让远程一起删）
git rm --cached "index-1.5.3.js" 2>$null
Remove-Item "index-1.5.3.js" -ErrorAction SilentlyContinue
git commit -m "chore: 删掉旧版本入口 index-1.5.3.js"
git push

# 确认远程也没有了
git ls-tree --name-only origin/master | Select-String "^index-"
```

Release 侧（可选，按需要）：只保留最近几个版本的自定义资产，旧的可以删

```powershell
gh release delete-asset v1.4.0 dsh-game-pet-watch-1.4.0.tgz -y   # 删资产
gh release delete v1.4.0 -y --cleanup-tag                        # 连 tag 一起删（谨慎）
```

---

## 常见坑（都是真踩过的）

| 坑 | 表现 | 处理 |
| --- | --- | --- |
| 忘了 `bump-entry` | 改完代码没反应 | 换入口文件名，宿主才会重新求值 |
| 新入口没进 `files` | 装完报「缺 index-x.y.z.js」 | `bump-entry` 现在会同步 `files` |
| 旧入口留在仓库 | 远程越积越多、克隆变慢 | 第 7 步，`git rm` 后推送 |
| tgz 留在仓库 | `npm pack` 打成递归、仓库暴涨 791MB | 打包后立刻 `Move-Item` 到 `dist/` |
| 配置项加了却存不住 | 设置页保存被静默丢弃 | 除了 `CONFIG_KEYS` 还要加 `src/config-store.js` 的 `EDITABLE_KEYS` |
| 改了 `pet/` 不改 pet 版本 | 安装后还是旧桌宠 | 同时 bump `pet/package.json` |
