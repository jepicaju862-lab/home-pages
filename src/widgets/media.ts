import { App, Notice, Setting, TFile, normalizePath, requestUrl, setIcon } from "obsidian";
import { formatRelativeTime, todayIso } from "../utils/date";
import { ensureFolder } from "../utils/vault";
import { addNumberSetting, addPathSetting, addSectionHeading } from "../ui/settingHelpers";
import { renderEmpty } from "../ui/dom";
import { WidgetDefinition, clampInt, normalizeWith } from "./types";

export interface CustomFeed {
  name: string;
  url: string;
}

export type NavStyle = "dropdown" | "tabs";

export interface MediaConfig extends Record<string, unknown> {
  channel: string;
  navStyle: NavStyle;
  limit: number;
  qiushiUrl: string;
  zjxcUrl: string;
  showQiushi: boolean;
  showZjxc: boolean;
  customFeeds: CustomFeed[];
  clipFolder: string;
  showClipper: boolean;
}

const DEFAULTS: MediaConfig = {
  channel: "all",
  navStyle: "dropdown",
  limit: 20,
  qiushiUrl: "https://www.qstheory.cn/20251231/2d916da295774130ac2fb223fd208895/c.html",
  zjxcUrl: "https://zjnews.zjol.com.cn/zjxc/",
  showQiushi: true,
  showZjxc: true,
  customFeeds: [],
  clipFolder: "主流媒体",
  showClipper: true
};

export interface MediaItem {
  id: string;
  sourceKey: "qiushi" | "zjxc" | "custom";
  sourceName: string;
  title: string;
  author?: string;
  column?: string;
  issue?: string;
  date?: string;
  timestamp: number;
  url: string;
  summary?: string;
}

export interface MediaData {
  ready: boolean;
  items: MediaItem[];
  qiushiIssue?: string;
  fetchedAt: number;
  error?: string;
}

// In-memory cache to ensure instant rendering across tab switches
const cacheStore = new Map<string, MediaData>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes

/** 抓取网络文本，配置桌面浏览器 UA */
async function fetchText(url: string): Promise<string> {
  const response = await requestUrl({
    url,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
    }
  });
  return response.text;
}

// ---- 求是杂志解析 ------------------------------------------------------------

export interface QiushiIssueRef {
  title: string;
  url: string;
  issueNumber: number;
}

/** 解析求是年度目录页中的所有期号链接 */
export function parseQiushiCatalog(html: string, baseUrl = "https://www.qstheory.cn"): QiushiIssueRef[] {
  const issues: QiushiIssueRef[] = [];
  const regex = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    let url = match[1].trim();
    if (!url) continue;
    if (url.startsWith("//")) url = "https:" + url;
    else if (url.startsWith("/")) url = baseUrl + url;

    const rawText = match[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const issueMatch = rawText.match(/《?求是》?\s*(\d{4}年第(\d+)期)/);
    if (issueMatch) {
      issues.push({
        title: `《求是》${issueMatch[1]}`,
        url,
        issueNumber: parseInt(issueMatch[2], 10)
      });
    }
  }

  issues.sort((a, b) => b.issueNumber - a.issueNumber);
  return issues;
}

/** 解析求是单期页面中的文章列表 */
export function parseQiushiIssueArticles(html: string, issueTitle = "求是杂志", baseUrl = "https://www.qstheory.cn"): MediaItem[] {
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  const articles: MediaItem[] = [];
  let pMatch: RegExpExecArray | null;
  let index = 0;

  while ((pMatch = pRegex.exec(html)) !== null) {
    const pContent = pMatch[1];
    const linkMatch = pContent.match(/<a[^>]+href="([^"]*\/c\.html)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    let url = linkMatch[1].trim();
    if (url.startsWith("//")) url = "https:" + url;
    else if (url.startsWith("/")) url = baseUrl + url;
    const rawTitle = linkMatch[2];

    // 提取专栏（如深度调研、求是专访、文化中国、学习问答、党员来信等）
    let column = "";
    const spanColMatch = rawTitle.match(/<span[^>]*>([\s\S]*?)<\/span>/i);
    if (spanColMatch) {
      const candidate = spanColMatch[1].replace(/<[^>]+>/g, "").replace(/[/／\s]/g, "").trim();
      if (candidate.length >= 2 && candidate.length <= 10) column = candidate;
    }
    if (!column) {
      const parenColMatch = pContent.match(/（(党员来信|党刊精选|干部谈体会|思想纵横|思想理论)）/i);
      if (parenColMatch) column = parenColMatch[1];
    }

    // 提取作者：先剥离链接以避免匹配 href 中的斜杠
    const afterLinks = pContent.replace(/<a[\s\S]*?<\/a>/gi, "");
    let author = "";
    const authorMatch = afterLinks.match(/[/／]\s*([^<>\n\r]+)/);
    if (authorMatch) {
      author = authorMatch[1].replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, " ").trim();
      if (author.length > 40) author = author.slice(0, 40) + "…";
    }

    // 清理主标题
    let title = rawTitle.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
    if (column) {
      title = title.replace(new RegExp(`^${column}\\s*[/／]?\\s*`, "i"), "");
    }
    title = title.replace(/^(深度调研|求是专访|文化中国|学习问答|统计图表)\s*[/／]\s*/, "").trim();

    if (!title || title === "扫描二维码分享到手机" || title === "【网站声明】") continue;

    // 解析日期，例如 URL 中 /20260915/...
    const dateMatch = url.match(/\/(\d{4})(\d{2})(\d{2})\//);
    const date = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : "";
    const timestamp = dateMatch ? new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`).getTime() : Date.now() - index * 60000;

    index += 1;
    articles.push({
      id: `qiushi:${url}`,
      sourceKey: "qiushi",
      sourceName: "求是杂志",
      title,
      author: author || undefined,
      column: column || undefined,
      issue: issueTitle,
      date,
      timestamp,
      url
    });
  }

  return articles;
}

// ---- 浙江宣传解析 ------------------------------------------------------------

/** 解析浙江宣传专栏文章列表 */
export function parseZjxcArticles(html: string, baseUrl = "https://zjnews.zjol.com.cn"): MediaItem[] {
  const items: MediaItem[] = [];
  const regex = /<li class="listLi">[\s\S]*?<span class="listSpan">([\s\S]*?)<\/span>[\s\S]*?<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/li>/gi;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = regex.exec(html)) !== null) {
    const rawDate = match[1].replace(/\s+/g, " ").trim();
    let url = match[2].trim();
    if (url.startsWith("//")) url = "https:" + url;
    else if (url.startsWith("/")) url = baseUrl + url;

    let title = match[3].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    title = title.replace(/^浙江宣传\s*[|｜]\s*/, "").trim();
    if (!title) continue;

    // 解析日期如 "2026年09月14日11时" -> timestamp
    let timestamp = Date.now() - index * 60000;
    const dateMatch = rawDate.match(/(\d{4})年(\d{2})月(\d{2})日(?:(\d{2})时)?/);
    let dateStr = rawDate;
    if (dateMatch) {
      dateStr = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` + (dateMatch[4] ? ` ${dateMatch[4]}:00` : "");
      timestamp = new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T${dateMatch[4] || "00"}:00:00`).getTime();
    }

    index += 1;
    items.push({
      id: `zjxc:${url}`,
      sourceKey: "zjxc",
      sourceName: "浙江宣传",
      title,
      column: "时评",
      date: dateStr,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now() - index * 60000,
      url
    });
  }

  return items;
}

// ---- 通用 RSS / Atom 解析 ---------------------------------------------------

/** 解析通用 RSS 2.0 / Atom 订阅源 */
export function parseRssArticles(xmlText: string, feedName: string): MediaItem[] {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, "text/xml");
  const items: MediaItem[] = [];

  // 1. RSS 2.0 (<item>)
  const rssItems = Array.from(xml.querySelectorAll("item"));
  if (rssItems.length > 0) {
    for (const el of rssItems) {
      let title = el.querySelector("title")?.textContent?.trim() ?? "";
      title = title.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/g, "$1").trim();
      title = title.replace(/<[^>]+>/g, "").trim();

      const link = el.querySelector("link")?.textContent?.trim() ?? "";
      const pubDate = el.querySelector("pubDate")?.textContent?.trim() ?? "";
      const author = el.querySelector("author, creator")?.textContent?.trim() ?? "";
      const desc = el.querySelector("description")?.textContent?.replace(/<[^>]+>/g, "").slice(0, 150) ?? "";

      if (!title || !link) continue;
      const timestamp = pubDate ? Date.parse(pubDate) : Date.now();
      const dateStr = Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : "";

      items.push({
        id: `custom:${link}`,
        sourceKey: "custom",
        sourceName: feedName,
        title,
        author: author || undefined,
        date: dateStr,
        timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
        url: link,
        summary: desc || undefined
      });
    }
    return items;
  }

  // 2. Atom (<entry>)
  const atomEntries = Array.from(xml.querySelectorAll("entry"));
  for (const el of atomEntries) {
    let title = el.querySelector("title")?.textContent?.trim() ?? "";
    title = title.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/g, "$1").trim();
    title = title.replace(/<[^>]+>/g, "").trim();

    const linkEl = el.querySelector("link");
    const link = linkEl?.getAttribute("href") || linkEl?.textContent?.trim() || "";
    const published = el.querySelector("published, updated")?.textContent?.trim() ?? "";
    const author = el.querySelector("author name")?.textContent?.trim() ?? "";
    const summary = el.querySelector("summary, content")?.textContent?.replace(/<[^>]+>/g, "").slice(0, 150) ?? "";

    if (!title || !link) continue;
    const timestamp = published ? Date.parse(published) : Date.now();
    const dateStr = Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : "";

    items.push({
      id: `custom:${link}`,
      sourceKey: "custom",
      sourceName: feedName,
      title,
      author: author || undefined,
      date: dateStr,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
      url: link,
      summary: summary || undefined
    });
  }

  return items;
}

// ---- 数据加载与综合调度 ----------------------------------------------------

export async function loadMediaData(config: MediaConfig, forceRefresh = false): Promise<MediaData> {
  const cacheKey = JSON.stringify({ qiushiUrl: config.qiushiUrl, zjxcUrl: config.zjxcUrl, customFeeds: config.customFeeds });
  if (!forceRefresh) {
    const cached = cacheStore.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached;
    }
  }

  const allItems: MediaItem[] = [];
  let qiushiIssueName = "";

  // 1. 求是杂志抓取
  if (config.showQiushi && config.qiushiUrl.trim()) {
    try {
      const catalogHtml = await fetchText(config.qiushiUrl.trim());
      const issues = parseQiushiCatalog(catalogHtml);
      if (issues.length > 0) {
        const latest = issues[0];
        qiushiIssueName = latest.title;
        const issueHtml = await fetchText(latest.url);
        const qiushiArticles = parseQiushiIssueArticles(issueHtml, latest.title);
        allItems.push(...qiushiArticles);
      } else {
        const directArticles = parseQiushiIssueArticles(catalogHtml, "求是杂志");
        if (directArticles.length > 0) {
          qiushiIssueName = directArticles[0].issue || "求是杂志";
          allItems.push(...directArticles);
        }
      }
    } catch (err) {
      console.warn("Home Pages: 加载《求是》杂志失败", err);
    }
  }

  // 2. 浙江宣传抓取
  if (config.showZjxc && config.zjxcUrl.trim()) {
    try {
      const zjxcHtml = await fetchText(config.zjxcUrl.trim());
      const zjxcArticles = parseZjxcArticles(zjxcHtml);
      allItems.push(...zjxcArticles);
    } catch (err) {
      console.warn("Home Pages: 加载浙江宣传失败", err);
    }
  }

  // 3. 自定义订阅源抓取
  if (Array.isArray(config.customFeeds)) {
    for (const feed of config.customFeeds) {
      if (!feed.url?.trim()) continue;
      try {
        const xml = await fetchText(feed.url.trim());
        const feedArticles = parseRssArticles(xml, feed.name || "自定义源");
        allItems.push(...feedArticles);
      } catch (err) {
        console.warn(`Home Pages: 加载自定义源 ${feed.name} 失败`, err);
      }
    }
  }

  // 排序：默认最新发表在前
  allItems.sort((a, b) => b.timestamp - a.timestamp);

  const result: MediaData = {
    ready: allItems.length > 0,
    items: allItems,
    qiushiIssue: qiushiIssueName,
    fetchedAt: Date.now()
  };

  cacheStore.set(cacheKey, result);
  return result;
}

// ---- 一键剪藏到 Obsidian 笔记 ------------------------------------------------

/** 把 HTML 简单转为清晰可读的 Markdown 正文 */
export function htmlToMarkdown(html: string): string {
  let containerHtml = html;
  const detailMatch = html.match(/<div[^>]+id=["']detailContent["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)
    || html.match(/<div[^>]+class=["'](?:doc-html-content|news_content|content)["'][^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<div[^>]+id=["']detail["'][^>]*>([\s\S]*?)<\/div>/i);
  if (detailMatch) {
    containerHtml = detailMatch[1];
  }

  containerHtml = containerHtml
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, "")
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "")
    .replace(/<div class=["'](?:xl_ewm|sharebox|wp_top)["'][\\s\\S]*?<\/div>/gi, "");

  let md = containerHtml
    .replace(/<p[^>]*>/gi, "\n\n")
    .replace(/<\/p>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**")
    .replace(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi, "\n\n![]($1)\n\n")
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, "\n> $1\n")
    .replace(/<[^>]+>/g, "");

  md = md
    .replace(/&emsp;/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

  return md.split("\n").map((line) => line.trim()).filter(Boolean).join("\n\n");
}

/** 剪藏单篇文章到库内 */
export async function clipArticleToVault(app: App, item: MediaItem, folderName: string): Promise<string> {
  const folder = folderName.trim() || "主流媒体";
  await ensureFolder(app, folder);

  const safeTitle = item.title.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 60);
  const targetPath = normalizePath(`${folder}/${safeTitle}.md`);

  let bodyMd = "";
  try {
    const rawHtml = await fetchText(item.url);
    bodyMd = htmlToMarkdown(rawHtml);
  } catch (err) {
    console.warn("Home Pages: 获取文章正文失败，使用摘要兜底", err);
    bodyMd = item.summary || `> （未能自动拉取全文，请点击下方链接阅读原文）\n\n[阅读原文](${item.url})`;
  }

  const frontmatter = [
    "---",
    `title: "${item.title.replace(/"/g, '\\"')}"`,
    `source: "${item.sourceName}"`,
    item.column ? `column: "${item.column}"` : null,
    item.issue ? `issue: "${item.issue}"` : null,
    item.author ? `author: "${item.author.replace(/"/g, '\\"')}"` : null,
    `url: "${item.url}"`,
    item.date ? `published: "${item.date}"` : null,
    `clipped_at: "${todayIso()}"`,
    "tags:",
    "  - 主流媒体",
    `  - ${item.sourceName}`,
    "---",
    "",
    `# ${item.title}`,
    "",
    `> **来源**：${item.sourceName}${item.issue ? ` · ${item.issue}` : ""}${item.column ? ` · 【${item.column}】` : ""}${item.author ? ` · **作者**：${item.author}` : ""}`,
    `> **发布时间**：${item.date || "未知"}`,
    `> **原文链接**：[${item.url}](${item.url})`,
    "",
    "---",
    "",
    bodyMd
  ].filter((line) => line !== null).join("\n");

  const existing = app.vault.getAbstractFileByPath(targetPath);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, frontmatter);
  } else {
    await app.vault.create(targetPath, frontmatter);
  }

  return targetPath;
}

// ---- 组件定义 ----------------------------------------------------------------

export const mediaWidget: WidgetDefinition<MediaConfig> = {
  kind: "media",
  name: "主流媒体",
  description: "汇聚《求是》杂志、浙江宣传等主流权威媒体最新文章与重磅理论评论，支持在线阅读与一键剪藏到本地笔记。",
  icon: "newspaper",
  accent: "#dc2626",
  defaultSize: { w: 6, h: 7 },
  defaultConfig: () => ({ ...DEFAULTS, customFeeds: [] }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    config.limit = clampInt(config.limit, 5, 200, DEFAULTS.limit);
    config.navStyle = config.navStyle === "tabs" ? "tabs" : "dropdown";
    config.channel = typeof config.channel === "string" && config.channel ? config.channel : "all";
    config.clipFolder = config.clipFolder?.trim() || DEFAULTS.clipFolder;
    config.qiushiUrl = config.qiushiUrl?.trim() || DEFAULTS.qiushiUrl;
    config.zjxcUrl = config.zjxcUrl?.trim() || DEFAULTS.zjxcUrl;
    config.customFeeds = (Array.isArray(config.customFeeds) ? config.customFeeds : []).map((feed) => ({
      name: String(feed?.name ?? "").trim(),
      url: String(feed?.url ?? "").trim()
    })).filter((feed) => feed.url);
    return config;
  },

  async render(body, ctx) {
    const { app, config } = ctx;
    const data = await loadMediaData(config);
    if (!ctx.isAlive()) return;

    ctx.addHeaderAction("refresh-cw", "刷新文章", () => {
      new Notice("正在刷新主流媒体最新文章…", 2000);
      void loadMediaData(config, true).then(() => ctx.rerender());
    });

    if (config.showClipper && config.clipFolder.trim()) {
      ctx.addHeaderAction("folder", `打开剪藏文件夹（${config.clipFolder}）`, (event) => {
        void ctx.openPath(config.clipFolder, { event });
      });
    }

    const activeIssue = data.qiushiIssue ? ` · ${data.qiushiIssue}` : "";
    const updateTime = data.fetchedAt ? formatRelativeTime(data.fetchedAt) : "刚刚";
    ctx.setSubtitle(`${updateTime}更新${activeIssue}`);

    ctx.registerInterval(() => {
      void loadMediaData(config, true).then(() => ctx.rerender());
    }, 60 * 60 * 1000);

    const wrap = body.createDiv({ cls: "hp-media" });

    // 构建各频道数据统计
    const channelOptions: Array<{ key: string; label: string; count: number }> = [
      { key: "all", label: "全部媒体", count: data.items.length }
    ];
    if (config.showQiushi) {
      const qCount = data.items.filter((item) => item.sourceKey === "qiushi").length;
      channelOptions.push({
        key: "qiushi",
        label: data.qiushiIssue ? `求是（${data.qiushiIssue.replace(/《?求是》?/, "")}）` : "《求是》杂志",
        count: qCount
      });
    }
    if (config.showZjxc) {
      const zCount = data.items.filter((item) => item.sourceKey === "zjxc").length;
      channelOptions.push({ key: "zjxc", label: "浙江宣传", count: zCount });
    }

    // 为每个自定义订阅源分别提供独立选项
    const customFeedNames = Array.from(new Set(data.items.filter((i) => i.sourceKey === "custom").map((i) => i.sourceName)));
    if (customFeedNames.length > 1) {
      const cTotal = data.items.filter((item) => item.sourceKey === "custom").length;
      channelOptions.push({ key: "custom", label: "全部其他订阅", count: cTotal });
    }
    for (const name of customFeedNames) {
      const count = data.items.filter((item) => item.sourceKey === "custom" && item.sourceName === name).length;
      channelOptions.push({ key: `custom:${name}`, label: name, count });
    }

    let searchKeyword = "";
    const batchSize = Math.max(config.limit || 20, 20);
    let visibleCount = batchSize;

    // 渲染工具栏（紧凑单行：下拉选择框 + 实时搜索框）
    const toolbar = wrap.createDiv({ cls: "hp-media-toolbar" });

    if (config.navStyle === "dropdown") {
      const selectWrap = toolbar.createDiv({ cls: "hp-media-select-wrap" });
      const select = selectWrap.createEl("select", { cls: "dropdown hp-media-channel-select" });

      for (const opt of channelOptions) {
        const optionEl = select.createEl("option", {
          value: opt.key,
          text: `${opt.label} (${opt.count})`
        });
        if (config.channel === opt.key) {
          optionEl.selected = true;
        }
      }

      select.addEventListener("change", () => {
        visibleCount = batchSize;
        void ctx.saveConfig({ channel: select.value }).then(() => ctx.rerender());
      });
    } else {
      // 备用：单行不折行横向滚动 Tabs
      const tabs = toolbar.createDiv({ cls: "hp-media-tabs" });
      for (const opt of channelOptions) {
        const pill = tabs.createEl("button", {
          cls: `hp-media-pill${config.channel === opt.key ? " is-active" : ""}`,
          text: opt.label.replace(/《?求是》?/, "求是"),
          attr: { type: "button" }
        });
        if (opt.count > 0) {
          pill.createSpan({ cls: "hp-media-pill-count", text: String(opt.count) });
        }
        pill.addEventListener("click", () => {
          visibleCount = batchSize;
          void ctx.saveConfig({ channel: opt.key }).then(() => ctx.rerender());
        });
      }
    }

    // 搜索框（紧凑嵌入在工具栏右侧）
    const searchWrap = toolbar.createDiv({ cls: "hp-media-search-wrap" });
    const searchInput = searchWrap.createEl("input", {
      cls: "hp-media-search",
      attr: { type: "search", placeholder: "搜索文章 / 作者...", value: searchKeyword }
    });

    // 列表容器
    const list = wrap.createDiv({ cls: "hp-media-list" });

    const renderListItems = (): void => {
      list.empty();

      let items = data.items;
      // 频道筛选
      if (config.channel !== "all") {
        if (config.channel === "custom") {
          items = items.filter((item) => item.sourceKey === "custom");
        } else if (config.channel.startsWith("custom:")) {
          const feedName = config.channel.slice("custom:".length);
          items = items.filter((item) => item.sourceKey === "custom" && item.sourceName === feedName);
        } else {
          items = items.filter((item) => item.sourceKey === config.channel);
        }
      }

      // 关键词筛选
      const q = searchKeyword.trim().toLowerCase();
      if (q) {
        items = items.filter((item) =>
          item.title.toLowerCase().includes(q)
          || (item.author && item.author.toLowerCase().includes(q))
          || (item.column && item.column.toLowerCase().includes(q))
          || item.sourceName.toLowerCase().includes(q)
        );
      }

      const totalItemsCount = items.length;
      const displayedItems = items.slice(0, visibleCount);

      if (!data.ready || totalItemsCount === 0) {
        renderEmpty(list, {
          icon: "newspaper",
          text: q ? `未找到与“${q}”相关的文章` : "未加载到文章，请检查网络或点击刷新。",
          action: q ? undefined : {
            label: "立即刷新",
            onClick: () => {
              void loadMediaData(config, true).then(() => ctx.rerender());
            }
          }
        });
        return;
      }

      for (const item of displayedItems) {
        const row = list.createDiv({ cls: `hp-media-item hp-media-source-${item.sourceKey}` });

        row.addEventListener("click", (e) => {
          const target = e.target as HTMLElement;
          if (target.closest(".hp-media-btn")) return;
          window.open(item.url, "_blank");
        });

        const content = row.createDiv({ cls: "hp-media-content" });

        const titleRow = content.createDiv({ cls: "hp-media-title-row" });
        const badge = titleRow.createSpan({
          cls: `hp-media-badge hp-media-badge-${item.sourceKey}`,
          text: item.sourceKey === "qiushi" ? "求是" : item.sourceKey === "zjxc" ? "浙江宣传" : (item.sourceName || "订阅")
        });
        if (item.sourceKey === "qiushi") badge.title = item.issue || "《求是》杂志";

        if (item.column) {
          titleRow.createSpan({ cls: "hp-media-column", text: item.column });
        }

        const cleanDisplayTitle = item.title.trim() || "（无标题）";
        titleRow.createSpan({ cls: "hp-media-title", text: cleanDisplayTitle, attr: { title: cleanDisplayTitle } });

        const metaRow = content.createDiv({ cls: "hp-media-meta" });
        if (item.author) {
          metaRow.createSpan({ cls: "hp-media-author", text: `作者：${item.author}` });
        }
        if (item.issue && item.sourceKey === "qiushi") {
          metaRow.createSpan({ cls: "hp-media-issue", text: item.issue.replace(/《?求是》?/, "") });
        }
        if (item.date) {
          metaRow.createSpan({ cls: "hp-media-time", text: item.date });
        }

        const actions = row.createDiv({ cls: "hp-media-actions" });

        const openBtn = actions.createEl("button", {
          cls: "hp-media-btn clickable-icon",
          attr: { "aria-label": "在新窗口打开原文", title: "打开原文" }
        });
        setIcon(openBtn, "external-link");
        openBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          window.open(item.url, "_blank");
        });

        if (config.showClipper) {
          const safeTitle = item.title.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 60);
          const expectedPath = normalizePath(`${config.clipFolder}/${safeTitle}.md`);
          const alreadyClipped = Boolean(app.vault.getAbstractFileByPath(expectedPath));

          const clipBtn = actions.createEl("button", {
            cls: `hp-media-btn clickable-icon hp-media-clip-btn${alreadyClipped ? " is-clipped" : ""}`,
            attr: {
              "aria-label": alreadyClipped ? "已剪藏到笔记（点击打开）" : "一键剪藏到笔记",
              title: alreadyClipped ? `已剪藏：${expectedPath}（点击打开）` : "一键剪藏到笔记"
            }
          });
          setIcon(clipBtn, alreadyClipped ? "check" : "bookmark-plus");

          clipBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            void (async () => {
              if (alreadyClipped) {
                await ctx.openPath(expectedPath, { event: e });
                return;
              }

              clipBtn.addClass("is-loading");
              try {
                const savedPath = await clipArticleToVault(app, item, config.clipFolder);
                clipBtn.removeClass("is-loading");
                clipBtn.addClass("is-clipped");
                setIcon(clipBtn, "check");
                clipBtn.setAttribute("title", `已剪藏：${savedPath}（点击打开）`);
                new Notice(`已剪藏文章：《${item.title}》`, 4000);
              } catch (err) {
                clipBtn.removeClass("is-loading");
                new Notice(`剪藏失败：${err instanceof Error ? err.message : String(err)}`);
              }
            })();
          });
        }
      }

      // 列表底部提示与加载更多
      const footer = list.createDiv({ cls: "hp-media-footer" });
      if (displayedItems.length < totalItemsCount) {
        const loadMoreBtn = footer.createEl("button", {
          cls: "hp-media-load-more",
          text: `下滑自动加载 · 或点击加载更多（已显 ${displayedItems.length} / 共 ${totalItemsCount} 篇）`,
          attr: { type: "button" }
        });
        loadMoreBtn.addEventListener("click", () => {
          visibleCount += batchSize;
          renderListItems();
        });
      } else {
        footer.createSpan({
          cls: "hp-media-footer-end",
          text: `— 已显示全部 ${totalItemsCount} 篇文章 —`
        });
      }
    };

    // 滚动到底部自动加载更多
    let isAutoLoading = false;
    list.addEventListener("scroll", () => {
      if (isAutoLoading) return;
      const { scrollTop, scrollHeight, clientHeight } = list;
      if (scrollTop + clientHeight >= scrollHeight - 60) {
        let totalCount = data.items.length;
        if (config.channel !== "all") {
          if (config.channel === "custom") {
            totalCount = data.items.filter((i) => i.sourceKey === "custom").length;
          } else if (config.channel.startsWith("custom:")) {
            const feedName = config.channel.slice("custom:".length);
            totalCount = data.items.filter((i) => i.sourceKey === "custom" && i.sourceName === feedName).length;
          } else {
            totalCount = data.items.filter((i) => i.sourceKey === config.channel).length;
          }
        }
        if (visibleCount < totalCount) {
          isAutoLoading = true;
          visibleCount += batchSize;
          renderListItems();
          window.setTimeout(() => { isAutoLoading = false; }, 120);
        }
      }
    });

    searchInput.addEventListener("input", () => {
      searchKeyword = searchInput.value;
      visibleCount = batchSize;
      renderListItems();
    });

    renderListItems();
  },

  renderSettings(container, ctx) {
    const { config } = ctx;

    addSectionHeading(container, "内容频道与布局");

    new Setting(container).setName("频道选择方式")
      .setDesc("下拉菜单最省空间且永不换行折叠；滚动胶囊以单行滑动展示。")
      .addDropdown((dropdown) => dropdown
        .addOptions({ dropdown: "下拉菜单（推荐，紧凑不换行）", tabs: "横向滚动胶囊（单行）" })
        .setValue(config.navStyle)
        .onChange((value) => ctx.update({ navStyle: value as NavStyle })));

    new Setting(container).setName("默认显示频道")
      .addDropdown((dropdown) => dropdown
        .addOptions({ all: "全部聚合", qiushi: "《求是》杂志", zjxc: "浙江宣传", custom: "其他订阅" })
        .setValue(config.channel.startsWith("custom:") ? "custom" : config.channel)
        .onChange((value) => ctx.update({ channel: value })));

    addNumberSetting(container, {
      name: "每批加载条数",
      desc: "下滑到底部会自动平滑加载下一批，直至浏览完全部文章。",
      value: config.limit,
      min: 5,
      max: 100,
      onChange: (value) => ctx.update({ limit: value })
    });

    new Setting(container).setName("启用《求是》杂志")
      .addToggle((toggle) => toggle.setValue(config.showQiushi).onChange((val) => ctx.update({ showQiushi: val })));

    new Setting(container).setName("《求是》杂志目录 URL")
      .setDesc("默认 2026 年目录；也可填写指定期号链接。")
      .addText((text) => text.setValue(config.qiushiUrl).onChange((val) => ctx.update({ qiushiUrl: val.trim() })));

    new Setting(container).setName("启用浙江宣传")
      .addToggle((toggle) => toggle.setValue(config.showZjxc).onChange((val) => ctx.update({ showZjxc: val })));

    new Setting(container).setName("浙江宣传专栏 URL")
      .addText((text) => text.setValue(config.zjxcUrl).onChange((val) => ctx.update({ zjxcUrl: val.trim() })));

    addSectionHeading(container, "一键剪藏到本地笔记");
    new Setting(container).setName("启用一键剪藏")
      .setDesc("在文章右侧显示剪藏按钮，一键抓取正文并在库内生成 Markdown 笔记。")
      .addToggle((toggle) => toggle.setValue(config.showClipper).onChange((val) => ctx.update({ showClipper: val })));

    addPathSetting(container, ctx.app, {
      name: "剪藏目标文件夹",
      desc: "剪藏的文章将自动保存到该文件夹内，自动生成 Frontmatter 元数据。",
      value: config.clipFolder,
      placeholder: "主流媒体",
      suggest: { files: false, folders: true },
      onChange: (val) => ctx.update({ clipFolder: val })
    });

    addSectionHeading(container, "自定义 RSS / 订阅源");
    const feeds = (config.customFeeds || []).map((f) => ({ ...f }));
    const commitFeeds = (): void => ctx.update({ customFeeds: feeds.map((f) => ({ ...f })) });

    feeds.forEach((feed, index) => {
      const row = container.createDiv({ cls: "hp-setting-row" });
      new Setting(row)
        .setName(`订阅源 #${index + 1}`)
        .addText((t) => t.setPlaceholder("媒体名称，如：人民网观点").setValue(feed.name).onChange((v) => {
          feed.name = v.trim();
          commitFeeds();
        }))
        .addText((t) => t.setPlaceholder("RSS / Atom 地址").setValue(feed.url).onChange((v) => {
          feed.url = v.trim();
          commitFeeds();
        }))
        .addExtraButton((btn) => btn.setIcon("trash-2").setTooltip("删除此订阅源").onClick(() => {
          feeds.splice(index, 1);
          commitFeeds();
          ctx.refresh();
        }));
    });

    new Setting(container).addButton((btn) => btn.setButtonText("＋ 添加自定义订阅源").onClick(() => {
      feeds.push({ name: "", url: "" });
      commitFeeds();
      ctx.refresh();
    }));
  }
};
