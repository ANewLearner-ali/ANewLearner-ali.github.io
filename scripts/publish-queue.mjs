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

const headJs = `(function(){var r=document.documentElement;try{var t=localStorage.getItem("blog-theme")||"auto";var dark=t==="dark"||(t==="auto"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);r.setAttribute("data-theme",dark?"dark":"light");r.setAttribute("data-theme-choice",t);var look=localStorage.getItem("blog-look")||"";var q="";try{q=new URLSearchParams(location.search).get("look")||"";}catch(e2){}if(q==="sheet"||q==="index"||q==="pages")look=q;if(look!=="index"&&look!=="pages")look="sheet";r.setAttribute("data-look",look);}catch(e){r.setAttribute("data-theme","light");r.setAttribute("data-theme-choice","auto");r.setAttribute("data-look","sheet");}})();`;

const clientJs = `
(function () {
  var root = document.documentElement;
  var body = document.body;
  var page = body.getAttribute("data-page");
  var CATS = ${JSON.stringify(Object.keys(CATEGORIES))};
  var THEME_KEY = "blog-theme";
  var LOOK_KEY = "blog-look";
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function store(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }
  function mark(selector, attr, value) {
    var buttons = document.querySelectorAll(selector + " button");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", buttons[i].getAttribute(attr) === value ? "true" : "false");
    }
  }
  function applyTheme(value) {
    if (value !== "light" && value !== "dark") value = "auto";
    var dark = value === "dark" || (value === "auto" && mq && mq.matches);
    root.setAttribute("data-theme", dark ? "dark" : "light");
    root.setAttribute("data-theme-choice", value);
    mark(".theme", "data-theme-choice", value);
    store(THEME_KEY, value);
  }
  function applyLook(value) {
    if (value !== "index" && value !== "pages") value = "sheet";
    root.setAttribute("data-look", value);
    mark(".looks", "data-look", value);
    store(LOOK_KEY, value);
  }
  applyTheme(root.getAttribute("data-theme-choice") || "auto");
  applyLook(root.getAttribute("data-look") || "sheet");
  if (mq && mq.addEventListener) {
    mq.addEventListener("change", function () {
      if ((root.getAttribute("data-theme-choice") || "auto") === "auto") applyTheme("auto");
    });
  }

  var chips = document.querySelectorAll(".chips a");
  var input = document.getElementById("q");
  var result = document.getElementById("result");
  var writing = document.getElementById("writing");
  var shelves = writing ? Array.prototype.slice.call(writing.querySelectorAll(".shelf")) : [];
  var query = "";

  function hashKey(href) {
    var i = (href || "").indexOf("#");
    return i === -1 ? "all" : href.slice(i + 1) || "all";
  }
  function activeCat() {
    var key = location.hash ? location.hash.slice(1) : "all";
    return key === "all" || CATS.indexOf(key) !== -1 ? key : "all";
  }
  function setChips(cat) {
    for (var i = 0; i < chips.length; i++) {
      if (hashKey(chips[i].getAttribute("href")) === cat) chips[i].setAttribute("aria-current", "true");
      else chips[i].removeAttribute("aria-current");
    }
  }
  function applyView(cat) {
    if (page !== "home" || !writing) return;
    if (cat !== "all" && CATS.indexOf(cat) === -1) cat = "all";
    var q = query.trim().toLowerCase();
    var searching = q !== "";
    var total = 0;
    body.setAttribute("data-filter", searching ? "all" : cat);
    body.classList.toggle("is-searching", searching);
    setChips(searching ? "all" : cat);
    for (var i = 0; i < shelves.length; i++) {
      var shelf = shelves[i];
      var key = shelf.getAttribute("data-cat");
      var entries = shelf.querySelectorAll(".entry");
      var hits = 0;
      for (var j = 0; j < entries.length; j++) {
        var entry = entries[j];
        var match = searching ? String(entry.getAttribute("data-search")).indexOf(q) !== -1 : true;
        if (match) hits++;
        entry.hidden = !match;
      }
      shelf.classList.toggle("no-match", searching && hits === 0);
      if (searching) total += hits;
      else if (entries.length && (cat === "all" || cat === key)) total += entries.length;
    }
    if (result) {
      if (searching) result.textContent = total ? "找到 " + total + " 篇" : "没有匹配的文章";
      else if (cat === "all") result.textContent = "共 " + total + " 篇";
      else result.textContent = "这一类 " + total + " 篇";
    }
    document.title = searching
      ? "搜索：" + query.trim() + " · ANewLearner 的博客"
      : "ANewLearner 的博客";
  }

  if (page === "home" && writing) {
    if (input) {
      input.addEventListener("input", function () {
        query = input.value || "";
        if (query.trim() && activeCat() !== "all") {
          history.replaceState(null, "", location.pathname + location.search);
        }
        applyView(query.trim() ? "all" : activeCat());
      });
      input.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
          input.value = "";
          query = "";
          applyView(activeCat());
          input.blur();
        }
      });
    }
    document.addEventListener("keydown", function (event) {
      if (!input || event.key !== "/") return;
      var tag = (document.activeElement && document.activeElement.tagName) || "";
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
      event.preventDefault();
      input.focus();
      input.select();
    });
    window.addEventListener("hashchange", function () { applyView(activeCat()); });
    window.addEventListener("popstate", function () { applyView(activeCat()); });
    applyView(activeCat());
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target.closest) return;
    var lookButton = target.closest(".looks button");
    if (lookButton) {
      applyLook(lookButton.getAttribute("data-look"));
      return;
    }
    var themeButton = target.closest(".theme button");
    if (themeButton) {
      applyTheme(themeButton.getAttribute("data-theme-choice"));
      return;
    }
    var chip = target.closest(".chips a");
    if (chip && page === "home" && writing) {
      event.preventDefault();
      var next = hashKey(chip.getAttribute("href"));
      if (next === activeCat() && next !== "all") next = "all";
      if (input) {
        input.value = "";
        query = "";
      }
      var url = next === "all" ? location.pathname + location.search : "#" + next;
      history.pushState(null, "", url);
      applyView(next);
      if (input) input.blur();
      return;
    }
    var copyButton = target.closest("[data-copy]");
    if (copyButton) {
      var done = function () {
        copyButton.textContent = "已复制链接";
        copyButton.classList.add("is-done");
        setTimeout(function () {
          copyButton.textContent = "复制本文链接";
          copyButton.classList.remove("is-done");
        }, 2000);
      };
      var fallback = function () {
        var area = document.createElement("textarea");
        area.value = location.href;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.top = "-1000px";
        document.body.appendChild(area);
        area.select();
        try {
          document.execCommand("copy");
          done();
        } catch (e) {
          copyButton.textContent = "请手动复制地址栏链接";
        }
        document.body.removeChild(area);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(location.href).then(done, fallback);
      } else {
        fallback();
      }
      return;
    }
    var top = target.closest(".to-top");
    if (top) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  var toTop = document.querySelector(".to-top");
  if (toTop) {
    var onTopScroll = function () {
      toTop.classList.toggle("is-on", window.scrollY > 700);
    };
    window.addEventListener("scroll", onTopScroll, { passive: true });
    onTopScroll();
  }

  var readMark = document.querySelector(".read-mark");
  if (readMark && page === "essay") {
    var onProgress = function () {
      var height = document.documentElement.scrollHeight - window.innerHeight;
      var ratio = height > 0 ? window.scrollY / height : 0;
      readMark.style.height = Math.max(0, Math.min(1, ratio)) * 100 + "%";
    };
    window.addEventListener("scroll", onProgress, { passive: true });
    window.addEventListener("resize", onProgress);
    onProgress();
  }

  var tocLinks = document.querySelectorAll(".toc a[href^='#']");
  var tocSlot = document.querySelector(".toc-slot");
  var tocRail = document.querySelector(".toc-rail");
  var wide = window.matchMedia ? window.matchMedia("(min-width: 1120px)") : null;
  function placeToc() {
    if (!tocSlot || !tocRail) return;
    var toc = tocSlot.querySelector(".toc") || tocRail.querySelector(".toc");
    if (!toc) return;
    var target = wide && wide.matches ? tocRail : tocSlot;
    if (toc.parentNode !== target) target.appendChild(toc);
    if (wide && wide.matches) toc.setAttribute("open", "");
    else toc.removeAttribute("open");
  }
  placeToc();
  if (wide && wide.addEventListener) wide.addEventListener("change", placeToc);

  if (tocLinks.length && window.IntersectionObserver) {
    var byId = {};
    var headings = [];
    for (var i = 0; i < tocLinks.length; i++) {
      var anchor = tocLinks[i].getAttribute("href").slice(1);
      var heading = document.getElementById(anchor);
      if (!heading) continue;
      byId[anchor] = tocLinks[i];
      headings.push(heading);
    }
    var current = "";
    var setCurrent = function (id) {
      if (id === current) return;
      if (current && byId[current]) byId[current].classList.remove("is-reading");
      current = id;
      if (byId[id]) {
        byId[id].classList.add("is-reading");
        var rail = byId[id].closest ? byId[id].closest("ol") : null;
        var link = byId[id];
        if (rail && link.offsetTop !== undefined) {
          var top = link.offsetTop - rail.clientHeight / 2;
          if (top > 0) rail.scrollTo({ top: top, behavior: "smooth" });
        }
      }
    };
    var observer = new IntersectionObserver(
      function (records) {
        var visible = records.filter(function (r) {
          return r.isIntersecting;
        });
        if (!visible.length) return;
        visible.sort(function (a, b) {
          return a.boundingClientRect.top - b.boundingClientRect.top;
        });
        setCurrent(visible[0].target.id);
      },
      { rootMargin: "-15% 0px -70% 0px", threshold: [0, 1] },
    );
    for (var k = 0; k < headings.length; k++) observer.observe(headings[k]);
  }
})();
`;

const lookSwitch = `<div class="seg looks" role="group" aria-label="版式">
        <button type="button" data-look="sheet" aria-pressed="true">稿纸</button>
        <button type="button" data-look="index" aria-pressed="false">书架</button>
        <button type="button" data-look="pages" aria-pressed="false">散页</button>
      </div>`;

const themeSwitch = `<div class="seg theme" role="group" aria-label="配色">
        <button type="button" data-theme-choice="auto" aria-pressed="true">自动</button>
        <button type="button" data-theme-choice="light" aria-pressed="false">浅色</button>
        <button type="button" data-theme-choice="dark" aria-pressed="false">深色</button>
      </div>`;

function layout(title, body, assetPrefix, page) {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-look="sheet" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23f2f6fa'/%3E%3Crect x='7' y='6' width='2' height='20' fill='%23a8382f'/%3E%3Crect x='13' y='9' width='12' height='2' fill='%2317252f'/%3E%3Crect x='13' y='15' width='12' height='2' fill='%2317252f' opacity='.6'/%3E%3Crect x='13' y='21' width='8' height='2' fill='%2317252f' opacity='.45'/%3E%3C/svg%3E">
  <script>${headJs}</script>
  <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/lxgwwenkai-regular.css" media="print" onload="this.media='all'">
  <link rel="stylesheet" href="${assetPrefix}style.css">
  <noscript><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/lxgwwenkai-regular.css"><style>.toolbar,.to-top,.seg{display:none}</style></noscript>
</head>
<body data-page="${page}" data-filter="all">
  <a class="skip" href="#writing">跳到正文</a>
  ${body}
  <button class="to-top" type="button" tabindex="-1">回到顶部</button>
  <script>${clientJs}</script>
</body>
</html>
`;
}

function readingMinutes(markdown) {
  const text = String(markdown)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_`~-]/g, " ");
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const words = (text.replace(/[\u4e00-\u9fa5]/g, " ").match(/[A-Za-z0-9]+/g) || []).length;
  return Math.max(1, Math.round(cjk / 350 + words / 220));
}

function withToc(html) {
  const items = [];
  let index = 0;
  const body = String(html).replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (full, level, inner) => {
    const id = `h-${++index}`;
    const text = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    items.push({ level: Number(level), id, text });
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
  const toc = items.length >= 2
    ? `<details class="toc">
            <summary><span>目录</span><span class="toc-count">${items.length} 节</span></summary>
            <ol>${items
              .map((item) => `<li class="lvl-${item.level}"><a href="#${item.id}">${item.text}</a></li>`)
              .join("")}</ol>
          </details>`
    : "";
  return { html: body, toc };
}

function pagerHtml(newer, older) {
  const link = (post, cls, label) =>
    post
      ? `<a class="${cls}" href="${escapeHtml(path.basename(post.href))}"><span>${label}</span><strong>${escapeHtml(post.title)}</strong></a>`
      : "";
  const body = link(newer, "pager-prev", "上一篇") + link(older, "pager-next", "下一篇");
  return body ? `<nav class="pager" aria-label="相邻文章">${body}</nav>` : "";
}

function entryHtml(post, isLatest) {
  const heading = isLatest ? "h1" : "h3";
  const haystack = [post.title, post.summary, post.date, CATEGORIES[post.category] || ""]
    .join(" ")
    .toLowerCase();
  return `<article class="entry${isLatest ? " is-latest" : ""}" data-search="${escapeHtml(haystack)}">
          <a href="${escapeHtml(post.href)}">
            <time datetime="${escapeHtml(post.date)}">${escapeHtml(post.date)}</time>
            <${heading}>${escapeHtml(post.title)}</${heading}>
            <p>${escapeHtml(post.summary)}</p>
          </a>
        </article>`;
}

function buildSite() {
  const posts = fs
    .readdirSync(postsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => parsePost(path.join(postsDir, name)))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.href).localeCompare(String(b.href)));
  fs.mkdirSync(htmlDir, { recursive: true });
  for (const file of fs.readdirSync(htmlDir)) {
    if (file.endsWith(".html")) fs.unlinkSync(path.join(htmlDir, file));
  }
  const visible = posts.filter((post) => !post.review);
  const ordered = visible.slice();
  const latestHref = ordered[0] ? ordered[0].href : "";
  const chips = [`<a href="#all">全部<span class="count">${visible.length}</span></a>`]
    .concat(
      Object.entries(CATEGORIES).map(([key, label]) => {
        const count = visible.filter((post) => post.category === key).length;
        return `<a href="#${key}"${count ? "" : ' class="is-quiet"'}>${label}<span class="count">${count}</span></a>`;
      }),
    )
    .join("");
  const chipsFlat = Object.entries(CATEGORIES).map(([key, label]) => ({ key, label, count: visible.filter((post) => post.category === key).length }));
  const emptyState = (key, label) => {
    const others = chipsFlat.filter((item) => item.key !== key && item.count > 0);
    const hint = others.length
      ? `<p class="empty-hint">可以看看：${others
          .map((item) => `<a href="#${item.key}">${item.label}</a>`)
          .join("")}${visible.length ? `<a href="#all">全部文章</a>` : ""}</p>`
      : `<p class="empty-hint">还没有发布任何文章。</p>`;
    return `<section class="shelf is-empty" data-cat="${key}"><h2>${label}</h2><p class="empty">这一类还没有文章。</p>${hint}</section>`;
  };
  const sections = Object.entries(CATEGORIES)
    .map(([key, label]) => {
      const items = visible.filter((post) => post.category === key);
      if (!items.length) return emptyState(key, label);
      const cards = `<div class="entries">${items.map((post) => entryHtml(post, post.href === latestHref)).join("\n")}</div>`;
      return `<section class="shelf" data-cat="${key}"><h2>${label}</h2>\n          ${cards}\n        </section>`;
    })
    .join("\n        ");
  const emptyShelves = Object.entries(CATEGORIES).filter(([key]) => !visible.some((post) => post.category === key));
  const emptyHtml = emptyShelves.length
    ? `<p class="empty-shelves">${emptyShelves.map(([, label]) => label).join("、")}还没有文章。</p>`
    : "";

  fs.writeFileSync(path.join(root, ".nojekyll"), "", "utf8");
  fs.writeFileSync(path.join(root, "style.css"), siteCss, "utf8");
  fs.writeFileSync(
    path.join(root, "index.html"),
    layout(
      "ANewLearner 的博客",
      `<div class="frame">
      <div class="margin-line" aria-hidden="true"><span class="read-mark"></span></div>
      <div class="top">
        <header class="mast">
          <div class="mast-copy">
            <p class="site-name"><a href="index.html">ANewLearner 的博客</a></p>
            <p class="lede">写下想法，交给一条流水线，长成文章。</p>
          </div>
          <div class="toolbar">
            ${lookSwitch}
            ${themeSwitch}
          </div>
        </header>
        <div class="finder">
          <label class="search">
            <span class="visually-hidden">搜索文章</span>
            <input id="q" type="search" placeholder="搜索标题、摘要或分类，按 / 聚焦" autocomplete="off" spellcheck="false">
          </label>
          <p class="result" id="result" role="status" aria-live="polite">共 ${visible.length} 篇</p>
        </div>
        <nav class="chips" aria-label="分类">${chips}</nav>
      </div>
      <div id="writing" tabindex="-1">
        ${sections}
        ${emptyHtml}
      </div>
      <footer class="foot">
          <p class="foot-line">${visible.length} 篇 · 最近更新 ${ordered[0] ? escapeHtml(ordered[0].date) : "—"}</p>
          <p class="foot-note">文章由想法经流水线写成，发布前经过确认。</p>
        </footer>
    </div>`,
      "",
      "home",
    ),
    "utf8",
  );

  posts.forEach((post, index) => {
    const label = CATEGORIES[post.category] || CATEGORIES.life;
    const older = ordered.slice(index + 1).find((item) => item.date <= post.date && item.href !== post.href) || null;
    const newer = ordered.slice(0, index).filter((item) => item.date >= post.date).pop() || null;
    const { html, toc } = withToc(renderBody(post.markdown));
    const minutes = readingMinutes(post.markdown);
    const note = post.ai ? `<p class="ai">AI 辅助生成 · 发布前经人工确认</p>` : "";
    fs.writeFileSync(
      path.join(htmlDir, path.basename(post.href)),
      layout(
        post.title,
        `<div class="frame is-essay">
        <div class="margin-line" aria-hidden="true"><span class="read-mark"></span></div>
        <header class="mast">
          <p class="back"><a href="../index.html#${post.category}">← 回到${label}</a></p>
          <div class="toolbar">
            ${lookSwitch}
            ${themeSwitch}
          </div>
        </header>
        <div class="essay-layout">
          <article class="essay" id="writing" tabindex="-1">
            <p class="cat"><a href="../index.html#${post.category}">${label}</a></p>
            <h1>${escapeHtml(post.title)}</h1>
            <p class="byline">
              <time datetime="${escapeHtml(post.date)}">${escapeHtml(post.date)}</time>
              <span>约 ${minutes} 分钟读完</span>
            </p>
            ${note}
            <div class="toc-slot">${toc}</div>
            <div class="prose">${html}</div>
            <div class="essay-end">
              ${pagerHtml(newer, older)}
              <div class="essay-tools">
                <button type="button" class="copy" data-copy>复制本文链接</button>
                <a class="back-home" href="../index.html">全部文章</a>
              </div>
            </div>
          </article>
          <aside class="toc-rail" aria-label="文章目录"></aside>
        </div>
        </div>`,
        "../",
        "essay",
      ),
      "utf8",
    );
  });
}
const siteCss = `*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--font-body); font-size: var(--size); line-height: var(--leading); -webkit-font-smoothing: antialiased; }
a { color: inherit; }
button { font: inherit; color: inherit; }
[hidden] { display: none !important; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 2px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.skip { position: fixed; left: 0.75rem; top: 0.75rem; z-index: 20; padding: 0.4rem 0.7rem; background: var(--surface); color: var(--ink); border: 1px solid var(--line); transform: translateY(-200%); }
.skip:focus { transform: none; }

:root {
  --bg: #e7edf2; --ink: #17252f; --muted: #4c5b69; --line: rgba(23, 37, 47, 0.16);
  --surface: #f7fafc; --code: rgba(23, 37, 47, 0.06); --accent: #a8382f; --accent-soft: rgba(168, 56, 47, 0.1);
  --font-body: "LXGW WenKai", "Kaiti SC", "STKaiti", "KaiTi", "楷体", serif;
  --size: 18px; --leading: 1.78; --display: var(--font-body);
  --radius: 3px; --frame: 42rem; --gap: 0.5rem;
}
html[data-theme="dark"] {
  --bg: #131c24; --ink: #e6eef4; --muted: #a8b8c5; --line: rgba(230, 238, 244, 0.18);
  --surface: #1b2630; --code: rgba(230, 238, 244, 0.07); --accent: #f08b7f; --accent-soft: rgba(240, 139, 127, 0.14);
}

body { font-family: var(--font-body); }
h1, h2, h3 { font-family: var(--display); font-weight: 600; line-height: 1.3; overflow-wrap: break-word; }
p { margin: 0; }

.frame { position: relative; max-width: var(--frame); margin: 0 auto; padding: var(--frame-pad); min-height: 100vh; }
.margin-line { position: absolute; left: var(--rule-left); top: 0; bottom: 0; width: var(--rule-width); background: var(--rule-color); }
.read-mark { display: block; width: 100%; height: 0; background: var(--accent); }

.top { position: sticky; top: 0; z-index: 4; background: var(--bg); }
.mast { display: flex; align-items: flex-end; justify-content: space-between; gap: 0.75rem 1.25rem; flex-wrap: wrap; padding-bottom: 0.9rem; }
.mast-copy { min-width: 0; }
.site-name { font-family: var(--display); font-size: 1.06rem; letter-spacing: 0.01em; }
.site-name a { text-decoration: none; }
.lede { color: var(--muted); font-size: 0.86rem; margin-top: 0.15rem; }
.back { margin: 0; font-size: 0.86rem; }
.back a { text-decoration: none; color: var(--muted); }
.back a:hover { color: var(--ink); }

.toolbar { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; padding: 2px; background: var(--surface); }
.seg button { border: 0; background: none; cursor: pointer; padding: 0.16rem 0.62rem; border-radius: 999px; font-size: 0.76rem; color: var(--muted); line-height: 1.5; }
.seg button[aria-pressed="true"] { background: var(--accent-soft); color: var(--ink); box-shadow: inset 0 0 0 1px var(--line); }

.finder { display: flex; align-items: baseline; gap: 0.6rem 0.9rem; flex-wrap: wrap; padding: 0.15rem 0 0.55rem; }
.search { flex: 1 1 16rem; display: block; min-width: 0; }
.search input { width: 100%; font: inherit; font-size: 0.88rem; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 999px; padding: 0.34rem 0.9rem; }
.search input::placeholder { color: var(--muted); opacity: 0.9; }
.search input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.search input::-webkit-search-cancel-button { -webkit-appearance: none; }
.result { color: var(--muted); font-size: 0.78rem; white-space: nowrap; font-variant-numeric: tabular-nums; }

.chips { display: flex; flex-wrap: wrap; gap: 0.2rem 0.95rem; padding-bottom: 0.7rem; }
.chips a { text-decoration: none; font-size: 0.86rem; padding: 0.12rem 0; color: var(--muted); }
.chips a:hover { color: var(--ink); }
.chips a[aria-current="true"] { color: var(--ink); box-shadow: inset 0 -2px 0 var(--accent); }
.chips a.is-quiet .count { opacity: 0.55; }
.count { font-size: 0.72em; margin-left: 0.3em; color: var(--muted); font-variant-numeric: tabular-nums; }

#writing { padding-top: 0.4rem; }
#writing .shelf { display: block; }
body[data-filter="life"] #writing .shelf[data-cat]:not([data-cat="life"]),
body[data-filter="work"] #writing .shelf[data-cat]:not([data-cat="work"]),
body[data-filter="tips"] #writing .shelf[data-cat]:not([data-cat="tips"]),
body[data-filter="travel"] #writing .shelf[data-cat]:not([data-cat="travel"]),
body[data-filter="hobby"] #writing .shelf[data-cat]:not([data-cat="hobby"]) { display: none; }
body[data-filter="all"] #writing .shelf.is-empty { display: none; }
body.is-searching .empty-shelves,
body:not([data-filter="all"]) .empty-shelves { display: none; }
.shelf > h2 { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.shelf.is-empty > h2 { position: static; width: auto; height: auto; margin: 0 0 0.55rem; clip: auto; font-size: 1.9rem; white-space: normal; }
.shelf.is-empty .empty { color: var(--muted); }
.shelf.is-empty { padding: 0.9rem 0 3rem; }
.empty-shelves { color: var(--muted); font-size: 0.9rem; margin-top: 1.2rem; }
.empty-hint { color: var(--muted); font-size: 0.9rem; }
.empty-hint a { color: var(--ink); text-decoration: none; margin-left: 0.6rem; box-shadow: inset 0 -1px 0 var(--accent); }

.entry a { display: block; min-width: 0; text-decoration: none; }
.entry h1, .entry h3 { margin: 0; }
.entry p { color: var(--muted); }
.entry time { color: var(--muted); font-size: 0.78rem; font-variant-numeric: tabular-nums; }
.entry a:hover h1, .entry a:hover h3 { text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 0.14em; }

.foot { margin-top: 2.5rem; padding-top: 0.9rem; border-top: 1px solid var(--line); color: var(--muted); font-size: 0.8rem; display: flex; justify-content: space-between; gap: 0.4rem 1.2rem; flex-wrap: wrap; }
.foot-note { opacity: 0.85; }

/* ---------- essay ---------- */
.essay .cat { font-size: 0.82rem; color: var(--muted); }
.essay .cat a { text-decoration: none; }
.essay h1 { margin: 0.35rem 0 0.6rem; font-size: clamp(1.6rem, 4vw, 2.2rem); }
.byline { display: flex; align-items: baseline; gap: 0.85rem; flex-wrap: wrap; color: var(--muted); font-size: 0.82rem; }
.byline span::before { content: "·"; margin-right: 0.6rem; opacity: 0.6; }
.essay .ai { margin-top: 0.5rem; font-size: 0.8rem; color: var(--muted); }
.toc { margin: 1.4rem 0 0; padding: 0.7rem 0.95rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); font-size: 0.86rem; }
.toc summary { display: flex; justify-content: space-between; gap: 1rem; cursor: pointer; color: var(--muted); list-style: none; padding: 0.05rem 0; }
.toc summary::-webkit-details-marker { display: none; }
.toc summary::after { content: "展开"; font-size: 0.78rem; }
.toc[open] summary::after { content: "收起"; }
.toc-count { margin-left: auto; margin-right: 0.7rem; font-size: 0.78rem; opacity: 0.8; }
.toc ol { list-style: none; margin: 0.55rem 0 0.1rem; padding: 0; max-height: 17rem; overflow: auto; overscroll-behavior: contain; }
.toc li a { text-decoration: none; display: block; padding: 0.16rem 0; color: var(--muted); line-height: 1.5; }
.toc li a:hover { color: var(--accent); }
.toc .lvl-2 a { color: var(--ink); }
.toc .lvl-3 { padding-left: 1rem; }
.toc .lvl-3 a { font-size: 0.94em; }
.toc a.is-reading { color: var(--accent); box-shadow: inset 2px 0 0 var(--accent); padding-left: 0.5rem; }
.toc-rail { display: none; }
.essay-layout { display: block; }

@media (min-width: 1120px) {
  html[data-look="sheet"] .frame.is-essay,
  html[data-look="pages"] .frame.is-essay { max-width: 62rem; }
  html[data-look="index"] .frame.is-essay { max-width: 62rem; }
  .essay-layout { display: grid; grid-template-columns: minmax(0, 1fr) 15rem; column-gap: 2.5rem; align-items: start; }
  .toc-rail { display: block; position: sticky; top: 5.5rem; }
  .toc-rail .toc { margin-top: 0.4rem; padding: 0.75rem 0.9rem; }
  .toc-rail .toc ol { max-height: calc(100vh - 14rem); }
  .toc-rail .toc summary { pointer-events: none; }
  .toc-rail .toc summary::after { content: ""; }
  .toc-slot { display: none; }
  html[data-look="pages"] .toc-rail .toc { background: var(--surface); }
}

.prose { max-width: 68ch; margin-top: 1.6rem; }
.prose > *:first-child { margin-top: 0; }
.prose p, .prose li { line-height: 1.9; margin: 0.95rem 0; }
.prose h2 { font-size: 1.32rem; margin: 2.1rem 0 0.55rem; }
.prose h2::before { content: ""; display: block; width: 2.1rem; height: 2px; background: var(--accent); margin-bottom: 0.6rem; opacity: 0.55; }
.prose h3 { font-size: 1.1rem; margin: 1.5rem 0 0.35rem; }
.prose a { text-decoration: underline; text-underline-offset: 0.16em; text-decoration-color: var(--accent); }
.prose blockquote { margin: 1.2rem 0; padding: 0.15rem 0 0.15rem 1rem; border-left: 2px solid var(--accent); color: var(--muted); }
.prose blockquote p { margin: 0.3rem 0; }
.prose pre { overflow: auto; padding: 0.9rem 1rem; background: var(--code); border-radius: var(--radius); font-size: 0.86rem; }
.prose code { font-family: "Sarasa Mono SC", "Cascadia Code", Consolas, monospace; font-size: 0.9em; }
.prose ul, .prose ol { padding-left: 1.3rem; }
.prose img { max-width: 100%; height: auto; border-radius: var(--radius); }
.prose hr { border: 0; border-top: 1px solid var(--line); margin: 1.8rem 0; }
.prose strong { font-weight: 700; }

.essay-end { margin-top: 2.6rem; }
.pager { display: grid; gap: 0.6rem; grid-template-columns: 1fr 1fr; border-top: 1px solid var(--line); padding-top: 1rem; }
.pager a { display: block; text-decoration: none; padding: 0.7rem 0.85rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); min-width: 0; }
.pager a span { display: block; font-size: 0.74rem; color: var(--muted); margin-bottom: 0.2rem; }
.pager a strong { font-weight: 600; font-size: 0.94rem; line-height: 1.45; display: block; }
.pager a:hover { border-color: var(--accent); }
.pager-next { text-align: right; grid-column: 2; }
.essay-tools { display: flex; align-items: center; gap: 0.6rem 1rem; flex-wrap: wrap; margin-top: 1rem; font-size: 0.84rem; }
.copy { cursor: pointer; background: none; border: 1px solid var(--line); border-radius: 999px; padding: 0.28rem 0.8rem; color: var(--muted); }
.copy:hover { color: var(--ink); border-color: var(--accent); }
.copy.is-done { color: var(--ink); border-color: var(--accent); }
.back-home { text-decoration: none; color: var(--muted); }
.back-home:hover { color: var(--ink); }

.to-top { position: fixed; right: 1rem; bottom: 1.1rem; z-index: 6; border: 1px solid var(--line); background: var(--surface); color: var(--muted); border-radius: 999px; padding: 0.32rem 0.8rem; font-size: 0.78rem; cursor: pointer; opacity: 0; transform: translateY(8px); transition: opacity 160ms ease, transform 160ms ease; pointer-events: none; }
.to-top.is-on { opacity: 1; transform: none; pointer-events: auto; }

/* ---------- look: 稿纸 ---------- */
html[data-look="sheet"] {
  --bg: #e7edf2; --ink: #17252f; --muted: #4c5b69; --line: rgba(23, 37, 47, 0.16);
  --surface: #f4f8fb; --accent: #a8382f;
  --font-body: "LXGW WenKai", "Kaiti SC", "STKaiti", "KaiTi", "楷体", serif;
  --size: 18.5px; --leading: 1.8;
  --frame: 42rem; --frame-pad: 2.2rem 1.15rem 3.5rem 2.1rem; --rule-left: 0.7rem; --rule-width: 2px; --rule-color: rgba(168, 56, 47, 0.85);
}
html[data-look="sheet"][data-theme="dark"] {
  --bg: #131c24; --ink: #e6eef4; --muted: #a3b3c0; --line: rgba(230, 238, 244, 0.17);
  --surface: #1a252f; --accent: #ef8b7e; --rule-color: rgba(239, 139, 126, 0.8);
}
html[data-look="sheet"] .entry { border-top: 1px solid var(--line); padding: 1rem 0 1.1rem; }
html[data-look="sheet"] .entry:first-child { border-top: 0; }
html[data-look="sheet"] .entry time { display: block; margin-bottom: 0.2rem; }
html[data-look="sheet"] .entry h3 { font-size: 1.24rem; }
html[data-look="sheet"] .entry p { margin-top: 0.3rem; font-size: 0.96rem; }
html[data-look="sheet"] .is-latest h1 { font-size: clamp(1.7rem, 5vw, 2.35rem); }
html[data-look="sheet"] .is-latest p { font-size: 1rem; }
html[data-look="sheet"] .essay .cat { letter-spacing: 0.02em; }
html[data-look="sheet"] .prose { max-width: 33rem; }

/* ---------- look: 书架 ---------- */
html[data-look="index"] {
  --bg: #e9eee5; --ink: #18231a; --muted: #4b5a4a; --line: rgba(24, 35, 26, 0.16);
  --surface: #f4f8f1; --accent: #2f523b;
  --font-body: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  --display: "Iowan Old Style", "Palatino Linotype", Palatino, "Songti SC", "STSong", "SimSun", serif;
  --size: 17px; --leading: 1.68;
  --frame: 66rem; --frame-pad: 1.6rem 1.4rem 3.5rem; --rule-left: 0; --rule-width: 2px; --rule-color: transparent;
  --radius: 2px;
}
html[data-look="index"][data-theme="dark"] {
  --bg: #121814; --ink: #e6eee4; --muted: #adbcab; --line: rgba(230, 238, 228, 0.17);
  --surface: #1a211b; --accent: #a8cdb6;
}
html[data-look="index"] .top { border-bottom: 1px solid var(--line); margin-bottom: 1.2rem; }
html[data-look="index"] .mast { align-items: center; }
html[data-look="index"] .site-name { font-size: 1.16rem; }
html[data-look="index"] .chips { gap: 0.15rem 1.4rem; }
html[data-look="index"] .chips a[aria-current="true"] { box-shadow: inset 0 -2px 0 var(--accent); }
html[data-look="index"] .entry a { display: grid; grid-template-columns: 6.2rem minmax(0, 1fr); column-gap: 1.2rem; row-gap: 0.25rem; align-items: baseline; padding: 0.85rem 0.4rem 0.9rem; border-top: 1px solid var(--line); }
html[data-look="index"] .entry:first-child a { border-top: 0; }
html[data-look="index"] .entry a:hover { background: rgba(47, 82, 59, 0.06); }
html[data-look="index"][data-theme="dark"] .entry a:hover { background: rgba(168, 205, 182, 0.08); }
html[data-look="index"] .entry time { grid-column: 1; grid-row: 1; }
html[data-look="index"] .entry h1, html[data-look="index"] .entry h3 { grid-column: 2; grid-row: 1; margin: 0; font-size: 1.18rem; }
html[data-look="index"] .entry p { grid-column: 2; grid-row: 2; margin: 0; font-size: 0.94rem; max-width: 52ch; }
html[data-look="index"] .is-latest h1 { font-size: clamp(1.5rem, 3vw, 1.95rem); }
html[data-look="index"] .is-latest p { max-width: 58ch; }
html[data-look="index"] .essay,
html[data-look="index"] .foot { max-width: 42rem; }
html[data-look="index"] .prose { max-width: 36rem; }
html[data-look="index"] .prose p, html[data-look="index"] .prose li { line-height: 1.85; }

/* ---------- look: 散页 ---------- */
html[data-look="pages"] {
  --bg: #cdc4b6; --ink: #241c16; --muted: #5d5347; --line: rgba(36, 28, 22, 0.16);
  --surface: #fffdf7; --code: rgba(36, 28, 22, 0.05); --accent: #1f4f7e;
  --font-body: "LXGW WenKai", "Kaiti SC", "STKaiti", "KaiTi", "楷体", serif;
  --size: 17.5px; --leading: 1.72;
  --frame: 46rem; --frame-pad: 1.4rem 1rem 3.4rem; --rule-left: 0; --rule-width: 3px; --rule-color: transparent;
  --radius: 2px;
}
html[data-look="pages"][data-theme="dark"] {
  --bg: #2a251f; --ink: #f2ece2; --muted: #c2b7a7; --line: rgba(242, 236, 226, 0.18);
  --surface: #1e1a16; --code: rgba(242, 236, 226, 0.06); --accent: #9bc3e8;
}
html[data-look="pages"] .top { background: var(--bg); }
html[data-look="pages"] .chips a { background: var(--surface); padding: 0.24rem 0.68rem; box-shadow: 0 1px 0 rgba(36, 28, 22, 0.14); border-radius: 2px; }
html[data-look="pages"] .chips a[aria-current="true"] { box-shadow: inset 0 -2px 0 var(--accent), 0 1px 0 rgba(36, 28, 22, 0.14); }
html[data-look="pages"] .entry { background: var(--surface); margin-bottom: 0.65rem; border-radius: 2px; box-shadow: 0 1px 0 rgba(36, 28, 22, 0.14); }
html[data-look="pages"] .entry a { padding: 1rem 1.1rem 1.05rem; }
html[data-look="pages"] .entry time { display: block; }
html[data-look="pages"] .entry h3 { font-size: 1.2rem; margin-top: 0.15rem; }
html[data-look="pages"] .entry p { margin-top: 0.3rem; font-size: 0.94rem; }
html[data-look="pages"] .is-latest { box-shadow: inset 3px 0 0 var(--accent), 0 12px 24px rgba(36, 28, 22, 0.12); }
html[data-look="pages"] .is-latest h1 { font-size: clamp(1.6rem, 4vw, 2rem); }
html[data-look="pages"] .essay { background: var(--surface); padding: 1.2rem 1.15rem 1.5rem; border-radius: 2px; box-shadow: 0 12px 24px rgba(36, 28, 22, 0.12); }
html[data-look="pages"] .toc { background: transparent; }
html[data-look="pages"] .pager a { background: transparent; }
html[data-look="pages"] .prose { max-width: 34rem; }
html[data-look="pages"] .foot { border-top-color: rgba(36, 28, 22, 0.2); }

@media (min-width: 1080px) {
  html[data-look="sheet"] .frame { padding-right: 1.5rem; }
  html[data-look="index"] .frame { padding-left: 2rem; padding-right: 2rem; }
}
@media (max-width: 640px) {
  :root { --size: 17px; }
  html[data-look="sheet"] { --frame-pad: 1.5rem 0.95rem 3rem 1.5rem; --rule-left: 0.55rem; }
  html[data-look="index"] { --frame-pad: 1.1rem 0.95rem 3rem; }
  html[data-look="pages"] { --frame-pad: 1.1rem 0.8rem 3rem; }
  .mast { align-items: flex-start; }
  .toolbar { width: 100%; }
  .seg button { padding: 0.16rem 0.52rem; font-size: 0.72rem; }
  .chips { gap: 0.15rem 0.8rem; }
  html[data-look="index"] .entry a { grid-template-columns: 1fr; }
  html[data-look="index"] .entry time,
  html[data-look="index"] .entry h1,
  html[data-look="index"] .entry h3,
  html[data-look="index"] .entry p { grid-column: 1; grid-row: auto; }
  .pager { grid-template-columns: 1fr; }
  .pager-next { grid-column: 1; text-align: left; }
  .shelf.is-empty > h2 { font-size: 1.5rem; }
  .shelf.is-empty { padding-bottom: 2rem; }
  .to-top { right: 0.7rem; bottom: 0.7rem; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .to-top { transition: none; }
}
`;

processReviews();
await consumeInbox();
buildSite();
console.log("site built");
