# blog-comments

博客的数据仓库（公开）。

- **Issues** —— 「此刻」与评论，博客每日构建时拉取
- **poems/** —— 「朝华章」语料库（中/英/德 76 位作者 20363 首，均公版），结构与维护见 [poems/README.md](poems/README.md)
- **daily/** —— 「朝华章」月度预生成缓存（`{月}/{日期}.json` 存三语成品页），博客 CI 每日优先命中
- **tools/** —— 语料收割与索引脚本

语料增删后在仓库根目录跑 `node tools/poem-index.mjs` 重建索引，再提交。
