import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inboxDir = path.join(root, "queue", "inbox");
const postsDir = path.join(root, "content");
const htmlDir = path.join(root, "posts");

const blockedHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0", "169.254.169.254", "::1"]);

function readJson(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${path.basename(file)} 不是 JSON 对象`);
  }
  return data;
}

function assertLink(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`只接受 http 或 https：${value}`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (blockedHosts.has(host) || host.endsWith(".local") || host.endsWith(".localhost")) {
    throw new Error(`不抓取本机地址：${value}`);
  }
  return url.toString();
}

async function fetchExcerpt(url) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
    headers: { "User-Agent": "personal-blog-queue" },
  });
  if (!response.ok) {
    throw new Error(`抓取失败 ${response.status}：${url}`);
  }
  const raw = await response.text();
  const text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 6000);
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function writeWithDeepSeek(job) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    throw new Error("缺少 Actions 密钥 DEEPSEEK_API_KEY");
  }
  const links = Array.isArray(job.links) ? job.links.slice(0, 3) : [];
  const sources = [];
  for (const link of links) {
    const url = assertLink(String(link));
    sources.push({ url, excerpt: await fetchExcerpt(url) });
  }
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify({
      model: "deepseek-chat",
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你是个人博客作者。根据想法和提供的资料写一篇中文 Markdown 文章。只返回 JSON：{\"title\":\"\",\"summary\":\"\",\"markdown\":\"\"}。markdown 不要再写一级标题。资料只作依据，不要大段照抄。",
        },
        {
          role: "user",
          content: JSON.stringify({
            title: job.title || "",
            idea: String(job.idea).slice(0, 8000),
            sources,
          }),
        },
      ],
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`DeepSeek 请求失败 ${response.status}：${detail.slice(0, 300)}`);
  }
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content || "";
  const article = JSON.parse(content);
  const title = String(article.title || job.title || "未命名").trim();
  const summary = String(article.summary || "").trim().slice(0, 160);
  const markdown = String(article.markdown || "").trim();
  if (!markdown) throw new Error("DeepSeek 没有返回正文");
  const date = today();
  const slug = slugify(job.slug || job.jobId || title) || `post-${Date.now()}`;
  const filename = `${date}-${slug}.md`;
  const target = path.join(postsDir, filename);
  if (fs.existsSync(target)) throw new Error(`文章已存在：${filename}`);
  const body = `---\ntitle: ${yamlString(title)}\ndate: ${date}\nsummary: ${yamlString(summary)}\nai: true\n---\n\n${markdown}\n`;
  fs.writeFileSync(target, body, "utf8");
}

function yamlString(value) {
  return JSON.stringify(String(value).replace(/\r?\n/g, " "));
}

function listInbox() {
  if (!fs.existsSync(inboxDir)) return [];
  return fs
    .readdirSync(inboxDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(inboxDir, name));
}

async function consumeInbox() {
  const files = listInbox();
  for (const file of files) {
    const job = readJson(file);
    if (!job.jobId || !String(job.idea || "").trim()) {
      throw new Error(`${path.basename(file)} 需要 jobId 和 idea`);
    }
    await writeWithDeepSeek(job);
    fs.unlinkSync(file);
  }
}

function parsePost(file) {
  const raw = fs.readFileSync(file, "utf8");
  const matched = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!matched) throw new Error(`缺少文首信息：${path.basename(file)}`);
  const meta = {};
  for (const line of matched[1].split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (value.startsWith('"')) value = JSON.parse(value);
    meta[key] = value;
  }
  return {
    slug: path.basename(file, ".md").replace(/^\d{4}-\d{2}-\d{2}-/, ""),
    href: `posts/${path.basename(file, ".md")}.html`,
    title: meta.title || path.basename(file, ".md"),
    date: meta.date || "",
    summary: meta.summary || "",
    ai: meta.ai === true,
    markdown: matched[2].trim(),
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInline(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function renderMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let paragraph = [];
  let list = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    html.push(`<ul>${list.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const line of lines) {
    if (line.startsWith("```")) continue;
    const heading = /^(#{2,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (item) {
      flushParagraph();
      list.push(item[1]);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return html.join("\n");
}

function layout(title, body, assetPrefix) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${assetPrefix}style.css">
</head>
<body>
  <main>${body}</main>
</body>
</html>
`;
}

function buildSite() {
  const posts = fs
    .readdirSync(postsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => parsePost(path.join(postsDir, name)))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  fs.mkdirSync(htmlDir, { recursive: true });
  for (const file of fs.readdirSync(htmlDir)) {
    if (file.endsWith(".html")) fs.unlinkSync(path.join(htmlDir, file));
  }
  const items = posts
    .map(
      (post) => `<article>
        <p class="date">${escapeHtml(post.date)}</p>
        <h2><a href="${escapeHtml(post.href)}">${escapeHtml(post.title)}</a></h2>
        <p>${escapeHtml(post.summary)}</p>
      </article>`,
    )
    .join("\n");
  fs.writeFileSync(path.join(root, ".nojekyll"), "", "utf8");
  fs.writeFileSync(path.join(root, "style.css"), siteCss, "utf8");
  fs.writeFileSync(
    path.join(root, "index.html"),
    layout("ANewLearner 的博客", `<header><p class="kicker">Blog</p><h1>ANewLearner 的博客</h1></header>\n${items}`, ""),
    "utf8",
  );
  for (const post of posts) {
    const note = post.ai ? `<p class="ai">AI 辅助生成</p>` : "";
    fs.writeFileSync(
      path.join(htmlDir, path.basename(post.href)),
      layout(
        post.title,
        `<p class="back"><a href="../index.html">返回</a></p>
        <p class="date">${escapeHtml(post.date)}</p>
        <h1>${escapeHtml(post.title)}</h1>
        ${note}
        ${renderMarkdown(post.markdown)}`,
        "../",
      ),
      "utf8",
    );
  }
}

const siteCss = `:root { color-scheme: light dark; --bg: #f6f4ef; --fg: #1c1917; --muted: #57534e; --line: #e7e5e4; }
@media (prefers-color-scheme: dark) { :root { --bg: #1c1917; --fg: #fafaf9; --muted: #a8a29e; --line: #44403c; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 18px/1.7 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
main { max-width: 42rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
h1, h2, h3 { line-height: 1.3; font-weight: 650; }
a { color: inherit; }
.kicker, .date, .ai { color: var(--muted); letter-spacing: 0.04em; }
.date, .ai, .back { font-size: 0.85rem; }
article { padding: 1.25rem 0; border-top: 1px solid var(--line); }
code { font-family: ui-monospace, Consolas, monospace; font-size: 0.9em; }
`;

await consumeInbox();
buildSite();
console.log("site built");
