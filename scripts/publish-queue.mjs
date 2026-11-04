import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inboxDir = path.join(root, "queue", "inbox");
const postsDir = path.join(root, "content");
const htmlDir = path.join(root, "posts");

const blockedHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0", "169.254.169.254", "::1"]);
const CATEGORIES = {
  life: "人生感悟",
  work: "技术工作",
  tips: "生活小常识",
  travel: "旅游",
  hobby: "兴趣爱好",
};

function normalizeCategory(value) {
  const key = String(value || "").trim();
  return CATEGORIES[key] ? key : "life";
}

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
            "你是个人博客作者。根据想法和提供的资料写一篇中文 Markdown 文章。只返回 JSON：{\"title\":\"\",\"summary\":\"\",\"markdown\":\"\"}。markdown 不要再写一级标题，可以用二三级标题、列表、引用和行内代码。需要版式时可以写少量 HTML：p、h2、h3、blockquote、ul、ol、li、strong、em、a、code、pre。不要写 script、style 或外链脚本。资料只作依据，不要大段照抄。",
        },
        {
          role: "user",
          content: JSON.stringify({
            title: job.title || "",
            category: CATEGORIES[normalizeCategory(job.category)],
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
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(job.date || "")) ? job.date : today();
  const slug = slugify(job.slug || job.jobId || title) || `post-${Date.now()}`;
  const filename = `${date}-${slug}.md`;
  const target = path.join(postsDir, filename);
  if (fs.existsSync(target)) throw new Error(`文章已存在：${filename}`);
  const category = normalizeCategory(job.category);
  const body = `---\ntitle: ${yamlString(title)}\ndate: ${date}\nsummary: ${yamlString(summary)}\nai: true\ncategory: ${category}\njobId: ${yamlString(job.jobId || slug)}\nreview: true\n---\n\n${markdown}\n`;
  fs.writeFileSync(target, body, "utf8");
  const statusDir = path.join(root, "queue", "status");
  fs.mkdirSync(statusDir, { recursive: true });
  const statusName = String(job.jobId || slug).replace(/[^a-zA-Z0-9._-]/g, "") || slug;
  const page = `https://anewlearner-ali.github.io/posts/${filename.replace(/\.md$/, ".html")}`;
  fs.writeFileSync(
    path.join(statusDir, `${statusName}.json`),
    `${JSON.stringify({ jobId: job.jobId || statusName, title, summary, url: page, category, status: "review" }, null, 2)}\n`,
    "utf8",
  );
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

function listReview() {
  const dir = path.join(root, "queue", "review");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name));
}

function rewriteFrontMatter(file, patch) {
  const raw = fs.readFileSync(file, "utf8");
  const matched = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!matched) throw new Error(`缺少文首信息：${path.basename(file)}`);
  const order = [];
  const map = new Map();
  for (const line of matched[1].split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    if (!map.has(key)) order.push(key);
    map.set(key, line.slice(index + 1).trim());
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!map.has(key)) order.push(key);
    map.set(key, typeof value === "boolean" ? String(value) : yamlString(value));
  }
  const body = matched[2].replace(/^\n/, "");
  fs.writeFileSync(file, `---\n${order.map((key) => `${key}: ${map.get(key)}`).join("\n")}\n---\n\n${body}`);
}

function processReviews() {
  for (const file of listReview()) {
    const job = readJson(file);
    const jobId = String(job.jobId || "").replace(/[^a-zA-Z0-9._-]/g, "");
    const target = path.join(postsDir, `${jobId}.md`);
    if (!jobId || !fs.existsSync(target)) {
      throw new Error(`找不到待确认的文章：${job.jobId || path.basename(file)}`);
    }
    const category = normalizeCategory(job.category);
    rewriteFrontMatter(target, { category, review: false });
    const statusDir = path.join(root, "queue", "status");
    fs.mkdirSync(statusDir, { recursive: true });
    const statusPath = path.join(statusDir, `${jobId}.json`);
    let prev = {};
    if (fs.existsSync(statusPath)) prev = readJson(statusPath);
    fs.writeFileSync(
      statusPath,
      `${JSON.stringify({ ...prev, jobId, category, status: "published" }, null, 2)}\n`,
      "utf8",
    );
    fs.unlinkSync(file);
  }
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
    category: normalizeCategory(meta.category),
    review: meta.review === true,
    jobId: meta.jobId || "",
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

const ALLOWED_HTML = new Set([
  "p", "h2", "h3", "h4", "ul", "ol", "li", "blockquote", "pre", "code",
  "a", "strong", "em", "hr", "br", "img", "figure", "figcaption",
]);

function sanitizeHtml(input) {
  return String(input)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (full, tag, attrs) => {
      const name = tag.toLowerCase();
      if (!ALLOWED_HTML.has(name)) return "";
      if (full.startsWith("</")) return `</${name}>`;
      if (name === "br" || name === "hr") return `<${name}>`;
      if (name === "a") {
        const href = /href\s*=\s*"(https?:\/\/[^"]+)"/i.exec(attrs || "");
        return href ? `<a href="${href[1]}">` : "<a>";
      }
      if (name === "img") {
        const src = /src\s*=\s*"(https?:\/\/[^"]+)"/i.exec(attrs || "");
        const alt = /alt\s*=\s*"([^"]*)"/i.exec(attrs || "");
        return src ? `<img src="${src[1]}" alt="${escapeHtml(alt ? alt[1] : "")}">` : "";
      }
      return `<${name}>`;
    });
}

function renderMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let paragraph = [];
  let list = [];
  let listTag = "ul";
  let code = null;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    html.push(`<${listTag}>${list.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${listTag}>`);
    list = [];
  };
  for (const line of lines) {
    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      if (code) {
        html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = null;
      } else {
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      flushParagraph();
      flushList();
      html.push("<hr>");
      continue;
    }
    const heading = /^(#{2,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    if (line.startsWith(">")) {
      flushParagraph();
      flushList();
      html.push(`<blockquote><p>${renderInline(line.replace(/^>\s?/, ""))}</p></blockquote>`);
      continue;
    }
    const ordered = /^\d+[.)]\s+(.+)$/.exec(line);
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (ordered || bullet) {
      flushParagraph();
      const tag = ordered ? "ol" : "ul";
      if (list.length && listTag !== tag) flushList();
      listTag = tag;
      list.push((ordered || bullet)[1]);
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
  if (code) html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  flushParagraph();
  flushList();
  return html.join("\n");
}

function renderBody(markdown) {
  if (/<(p|h2|h3|blockquote|ul|ol|figure|pre)\b/i.test(markdown)) return sanitizeHtml(markdown);
  return renderMarkdown(markdown);
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
  const visible = posts.filter((post) => !post.review);
  const nav = Object.entries(CATEGORIES)
    .map(([key, label]) => `<a href="#${key}">${label}</a>`)
    .join("");
  const sections = Object.entries(CATEGORIES)
    .map(([key, label]) => {
      const items = visible.filter((post) => post.category === key);
      const cards = items.length
        ? items
            .map(
              (post) => `<article>
        <p class="date">${escapeHtml(post.date)}</p>
        <h3><a href="${escapeHtml(post.href)}">${escapeHtml(post.title)}</a></h3>
        <p>${escapeHtml(post.summary)}</p>
      </article>`,
            )
            .join("\n")
        : `<p class="empty">这一类还没有文章</p>`;
      return `<section id="${key}"><h2>${label}</h2>\n${cards}</section>`;
    })
    .join("\n");
  fs.writeFileSync(path.join(root, ".nojekyll"), "", "utf8");
  fs.writeFileSync(path.join(root, "style.css"), siteCss, "utf8");
  fs.writeFileSync(
    path.join(root, "index.html"),
    layout(
      "ANewLearner 的博客",
      `<header><p class="kicker">Blog</p><h1>ANewLearner 的博客</h1></header>
      <nav>${nav}</nav>
      ${sections}`,
      "",
    ),
    "utf8",
  );
  for (const post of posts) {
    const note = post.ai ? `<p class="ai">AI 辅助生成</p>` : "";
    const label = CATEGORIES[post.category] || CATEGORIES.life;
    fs.writeFileSync(
      path.join(htmlDir, path.basename(post.href)),
      layout(
        post.title,
        `<p class="back"><a href="../index.html">返回</a></p>
        <p class="cat"><a href="../index.html#${post.category}">${label}</a></p>
        <p class="date">${escapeHtml(post.date)}</p>
        <h1>${escapeHtml(post.title)}</h1>
        ${note}
        ${renderBody(post.markdown)}`,
        "../",
      ),
      "utf8",
    );
  }
}

const siteCss = `:root { color-scheme: light dark; --bg: #f4f0e8; --fg: #1c1917; --muted: #57534e; --line: #e4ddd2; --card: #fffdf8; --accent: #9a3412; }
@media (prefers-color-scheme: dark) { :root { --bg: #1c1917; --fg: #fafaf9; --muted: #a8a29e; --line: #44403c; --card: #292524; --accent: #fdba74; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 18px/1.75 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
main { max-width: 44rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
h1, h2, h3 { line-height: 1.3; font-weight: 650; }
h1 { font-size: 2rem; margin: 0.4rem 0 1rem; }
h2 { font-size: 1.35rem; margin: 2.2rem 0 0.6rem; }
h3 { font-size: 1.15rem; margin: 0 0 0.35rem; }
a { color: inherit; }
p { margin: 0.8rem 0; }
nav { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 1.25rem 0 0.5rem; }
nav a, .cat a { text-decoration: none; border: 1px solid var(--line); border-radius: 999px; padding: 0.2rem 0.75rem; color: var(--accent); font-size: 0.92rem; }
.kicker, .date, .ai, .empty { color: var(--muted); }
.date, .ai, .back, .cat { font-size: 0.85rem; }
article { margin: 0.8rem 0; padding: 1rem 1.1rem; background: var(--card); border: 1px solid var(--line); border-radius: 14px; }
blockquote { margin: 1rem 0; padding: 0.2rem 0 0.2rem 1rem; border-left: 3px solid var(--accent); color: var(--muted); }
pre { overflow: auto; padding: 0.9rem 1rem; border-radius: 12px; background: var(--card); border: 1px solid var(--line); }
code { font-family: ui-monospace, Consolas, monospace; font-size: 0.9em; }
ul, ol { padding-left: 1.3rem; }
img { max-width: 100%; height: auto; border-radius: 12px; }
hr { border: 0; border-top: 1px solid var(--line); margin: 1.5rem 0; }
`;

processReviews();
await consumeInbox();
buildSite();
console.log("site built");
