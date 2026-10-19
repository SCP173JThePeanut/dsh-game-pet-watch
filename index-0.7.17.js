/**
 * 版本化入口（当前代：0.7.17）。实现见 ./index.js —— 只有一份实现，本文件只做转发。
 *
 * 改代码后：node scripts/bump-entry.mjs <新版本> [--patch <profile 的 cordis.patch.yml>]
 * 加载器按模块 URL 缓存，所以必须换文件名才能让宿主重新求值。
 */
export * from './index.js';
