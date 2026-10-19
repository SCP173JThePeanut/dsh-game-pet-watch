/**
 * 一次性：把公共登记簿写出来（让 opencode 那侧立刻能读到，不用等我们重启 DSH）。
 *
 * 正常运行时由插件自己写（`publishRegistry()`）；这个脚本只是"还没重启时先把文件铺好"，
 * 内容和插件写的一模一样（同一个 `buildFishBoardRegistry`）。
 *
 *   node scripts\publish-registry.mjs [pluginOrigin]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildFishBoardRegistry } from '../index.js';

const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
const configPath = join(home, 'game-pet-watch', 'config.json');

let config = {};
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch {
  /* 没有自管配置就按空鱼表写（插件启动后会自己覆盖） */
}

const origin = String(process.argv[2] || '').trim();
const doc = buildFishBoardRegistry({ config: { pets: config.pets || [] }, origin });

const dir = join(home, 'fish-board');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'registry.json'), JSON.stringify(doc, null, 2), 'utf8');
console.log('已写入 ' + join(dir, 'registry.json'));
console.log(JSON.stringify(doc, null, 2));
