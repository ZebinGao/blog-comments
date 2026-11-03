# blog-comments

博客的数据仓库（公开）。

- **Issues** —— 评论
- **poems/** —— 语料库（中/英/德 101 位作者 23776 首），结构与维护见 [poems/README.md](poems/README.md)
- **daily/** —— 月度预生成缓存（`{月}/{日期}.json` 存三语成品页），博客 CI 每日优先命中
- **tools/** —— 语料来源（搜韵 / sheepzh 诗库 / PoetryDB）与索引脚本

语料增删后在仓库根目录跑 `node tools/poem-index.mjs` 重建索引，再提交。
