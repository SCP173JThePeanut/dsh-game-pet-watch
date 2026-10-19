/**
 * 梗鲸图库检索自检（`node tests/memes.test.mjs`）——**不联网**，用固定索引。
 *
 * 覆盖"错了会静默坏掉"的地方：
 *   ① 拍平：分类要带出来（分类参与打分）；
 *   ② 打分：台词权重高于场合说明，且"同分"不能随机、要稳定；
 *   ③ 命名：从 URL 里取编号（下载复用判据也靠它，错了就会重复下载/覆盖）；
 *   ④ 缺字段的条目要跳过，不能让整次检索崩掉（索引是外部数据）。
 */
import { flattenGallery, searchGallery, memeNameOf } from '../src/memes.js';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed += 1;
};

const index = {
  gallery: {
    DeepSeek娘: {
      images: [
        {
          alt: '加班到深夜的鲸鱼',
          story: { zh: '适合主人熬夜写代码、深夜还在忙的时候发' },
          preview: 'https://img.example/0_preview/meme/101.webp',
          original: 'https://img.example/meme/101.webp',
        },
        {
          alt: '吃白饭的大肥鱼',
          story: { zh: '适合被说白吃白喝、伸手要东西的时候' },
          preview: 'https://img.example/0_preview/meme/102.webp',
          original: 'https://img.example/meme/102.webp',
        },
      ],
    },
    Claude娘: {
      images: [
        { alt: 'claude 上班摸鱼', story: { zh: '适合偷懒摸鱼' }, preview: 'https://img.example/0_preview/meme/201.webp' },
        { alt: '缺字段的条目' }, // 没有 preview → 应被跳过
      ],
    },
  },
};

console.log('=== 拍平 ===');
const entries = flattenGallery(index);
check('跳过失字段的条目', entries.length === 3, `共 ${entries.length} 条`);
check('带出分类', entries.find((e) => e.alt === 'claude 上班摸鱼')?.category === 'Claude娘');

console.log('=== 名字与编号 ===');
check('从 preview 取编号', memeNameOf({ preview: 'https://x/0_preview/meme/101.webp' }) === '梗鲸101');
check('从 original 取编号', memeNameOf({ original: 'https://x/meme/2077.webp' }) === '梗鲸2077');
check('取不到编号返回空', memeNameOf({ preview: 'https://x/nope' }) === '');

console.log('=== 检索 ===');
const byAlt = searchGallery(entries, '加班');
check('台词命中排第一', byAlt[0]?.item.alt === '加班到深夜的鲸鱼', byAlt.map((h) => h.item.alt).join(' / '));
const byStory = searchGallery(entries, '摸鱼');
check('场合说明也能命中', byStory[0]?.item.alt === 'claude 上班摸鱼');
check('无关词不返回', searchGallery(entries, '量子力学').length === 0);
const stable = searchGallery(entries, '大鱼');
check('同分结果稳定（不随机）', JSON.stringify(stable) === JSON.stringify(searchGallery(entries, '大鱼')));

console.log('');
console.log(failed ? `❌ ${failed} 项失败` : '✅ 全部通过');
process.exit(failed ? 1 : 0);
