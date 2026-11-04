# 个人博客

站点地址：<https://anewlearner-ali.github.io>

这个仓库名是用户主页站点，GitHub 会固定发布 `main` 分支。流水线把生成的页面提交回分支，并用 `.nojekyll` 避免 Jekyll 改写文章。

小程序只负责把一篇想法交给这个仓库。耗时的检索、写作和发布都在 GitHub Actions 里完成。

## 怎么发一篇

在 `queue/inbox/` 放一个 JSON 文件并推送到 `main`：

```json
{
  "jobId": "2026-11-04-001",
  "idea": "想写成文章的想法",
  "links": ["https://example.com/source"],
  "slug": "optional-english-slug",
  "title": "可选标题"
}
```

`jobId` 和 `idea` 必填。`links` 最多 3 个，只抓取 http 或 https 页面上的正文片段。流水线会写成 `posts/` 下的 Markdown，生成静态页，并部署到 GitHub Pages。模型写成的文章带有 AI 辅助标记。

流水线提交的文件不会再次打开写作，避免循环触发。

## 密钥

DeepSeek 的 Key 只放在仓库的 Actions 密钥里，名字是 `DEEPSEEK_API_KEY`。不要写进文件，也不要发到对话里。在本机执行后按提示粘贴：

```bash
gh secret set DEEPSEEK_API_KEY --repo ANewLearner-ali/ANewLearner-ali.github.io
```

没有这篇密钥时，空队列仍会发布现有文章；收件箱里有新想法时，流水线会失败并停在写作之前。
