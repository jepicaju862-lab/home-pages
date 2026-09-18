import { App, Notice, Setting, TFile, normalizePath, requestUrl, setIcon } from "obsidian";
import { formatRelativeTime, todayIso } from "../utils/date";
import { ensureFolder } from "../utils/vault";
import { addNumberSetting, addPathSetting, addSectionHeading } from "../ui/settingHelpers";
import { renderEmpty } from "../ui/dom";
import { ConfirmModal, PromptModal } from "../ui/modals";
import { parseOpml, exportOpml } from "../utils/opml";
import { WidgetDefinition, clampInt, normalizeWith } from "./types";

export interface CustomFeed {
  name: string;
  url: string;
  category?: string;
  enabled?: boolean;
  htmlUrl?: string;
  type?: string;
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
  category?: string;
  title: string;
  author?: string;
  column?: string;
  issue?: string;
  date?: string;
  timestamp: number;
  url: string;
  summary?: string;
  fullHtml?: string;
  thumbnail?: string;
  mediaType?: "article" | "audio" | "video";
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

export interface ParseRssOptions {
  category?: string;
}

/** 正则兜底解析 RSS / Atom（在缺少 DOMParser 的测试环境或格式有瑕疵的 XML 下保障鲁棒性） */
export function parseRssWithRegex(xmlText: string, feedName: string, options?: ParseRssOptions): MediaItem[] {
  const items: MediaItem[] = [];
  const category = options?.category;

  // 1. RSS 2.0 items
  const itemMatches = xmlText.match(/<item[\s>][\s\S]*?<\/item>/gi);
  if (itemMatches && itemMatches.length > 0) {
    for (const rawItem of itemMatches) {
      const titleMatch = rawItem.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      let title = titleMatch ? titleMatch[1].trim() : "";
      title = title.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/g, "$1").trim();
      title = title.replace(/<[^>]+>/g, "").trim();

      const linkMatch = rawItem.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
      let link = linkMatch ? linkMatch[1].trim() : "";
      link = link.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/g, "$1").trim();

      if (!title || !link) continue;

      const pubDateMatch = rawItem.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
      const pubDate = pubDateMatch ? pubDateMatch[1].trim() : "";

      const authorMatch = rawItem.match(/<(?:author|dc:creator|creator)[^>]*>([\s\S]*?)<\/(?:author|dc:creator|creator)>/i);
      let author = authorMatch ? authorMatch[1].trim() : "";
      author = author.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/g, "$1").trim();

      const descMatch = rawItem.match(/<description[^>]*>([\s\S]*?)<\/description>/i);
      let desc = descMatch ? descMatch[1].trim() : "";
      desc = desc.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/g, "$1").replace(/<[^>]+>/g, "").slice(0, 150).trim();

      const encodedMatch = rawItem.match(/<(?:content:encoded|content)[^>]*>([\s\S]*?)<\/(?:content:encoded|content)>/i);
      let fullHtml = encodedMatch ? encodedMatch[1].trim() : "";
      fullHtml = fullHtml.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/g, "$1").trim();

      const timestamp = pubDate ? Date.parse(pubDate) : Date.now();
      const dateStr = Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : "";

      // 提取 enclosure 音频/视频与缩略图
      const encMatch = rawItem.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']([^"']+)["']/i)
        || rawItem.match(/<enclosure[^>]+type=["']([^"']+)["'][^>]*url=["']([^"']+)["']/i);
      const encUrl = encMatch ? (encMatch[1].startsWith("http") ? encMatch[1] : encMatch[2]) : "";
      const encType = encMatch ? (encMatch[1].startsWith("http") ? encMatch[2] : encMatch[1]) : "";

      let mediaType: "article" | "audio" | "video" = "article";
      if (encType.startsWith("audio/") || encUrl.match(/\.(mp3|m4a|aac|ogg)(\?.*)?$/i) || category?.includes("播客") || category?.includes("音频") || feedName.includes("播客")) {
        mediaType = "audio";
      } else if (encType.startsWith("video/") || encUrl.match(/\.(mp4|mkv|webm)(\?.*)?$/i) || link.includes("bilibili.com") || link.includes("youtube.com") || category?.includes("视频")) {
        mediaType = "video";
      }

      let thumbnail: string | undefined;
      const thumbMatch = rawItem.match(/<(?:media:thumbnail|itunes:image)[^>]+(?:url|href)=["']([^"']+)["']/i);
      if (thumbMatch) {
        thumbnail = thumbMatch[1];
      } else if (encType.startsWith("image/") && encUrl) {
        thumbnail = encUrl;
      } else {
        const imgMatch = (fullHtml || desc).match(/<img[^>]+(?:data-src|src)=["']([^"']+)["']/i);
        if (imgMatch && !imgMatch[1].includes("emoji") && !imgMatch[1].includes("avatar") && !imgMatch[1].includes(".gif")) {
          thumbnail = imgMatch[1];
        }
      }

      items.push({
        id: `custom:${link}`,
        sourceKey: "custom",
        sourceName: feedName,
        category,
        title,
        author: author || undefined,
        date: dateStr,
        timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
        url: link,
        summary: desc || undefined,
        fullHtml: fullHtml || undefined,
        thumbnail,
        mediaType
      });
    }
    return items;
  }

  // 2. Atom entries
  const entryMatches = xmlText.match(/<entry[\s>][\s\S]*?<\/entry>/gi);
  if (entryMatches && entryMatches.length > 0) {
    for (const rawEntry of entryMatches) {
      const titleMatch = rawEntry.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      let title = titleMatch ? titleMatch[1].trim() : "";
      title = title.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/g, "$1").trim();
      title = title.replace(/<[^>]+>/g, "").trim();

      const linkMatch = rawEntry.match(/<link[^>]+href=["']([^"']+)["']/i) || rawEntry.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
      const link = linkMatch ? linkMatch[1].trim() : "";

      if (!title || !link) continue;

      const pubMatch = rawEntry.match(/<(?:published|updated)[^>]*>([\s\S]*?)<\/(?:published|updated)>/i);
      const published = pubMatch ? pubMatch[1].trim() : "";

      const authorMatch = rawEntry.match(/<name[^>]*>([\s\S]*?)<\/name>/i) || rawEntry.match(/<author[^>]*>([\s\S]*?)<\/author>/i);
      let author = authorMatch ? authorMatch[1].trim() : "";
      author = author.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/g, "$1").trim();

      const contentMatch = rawEntry.match(/<content[^>]*>([\s\S]*?)<\/content>/i);
      let fullHtml = contentMatch ? contentMatch[1].trim() : "";
      fullHtml = fullHtml.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/g, "$1").trim();

      const summaryMatch = rawEntry.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
      let summary = summaryMatch ? summaryMatch[1].trim() : "";
      summary = summary.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/g, "$1").replace(/<[^>]+>/g, "").slice(0, 150).trim();
      if (!summary && fullHtml) {
        summary = fullHtml.replace(/<[^>]+>/g, "").slice(0, 150).trim();
      }

      const timestamp = published ? Date.parse(published) : Date.now();
      const dateStr = Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : "";

      let mediaType: "article" | "audio" | "video" = "article";
      if (category?.includes("播客") || category?.includes("音频") || feedName.includes("播客")) {
        mediaType = "audio";
      } else if (link.includes("bilibili.com") || link.includes("youtube.com") || category?.includes("视频")) {
        mediaType = "video";
      }

      let thumbnail: string | undefined;
      const imgMatch = (fullHtml || summary).match(/<img[^>]+(?:data-src|src)=["']([^"']+)["']/i);
      if (imgMatch && !imgMatch[1].includes("emoji") && !imgMatch[1].includes("avatar") && !imgMatch[1].includes(".gif")) {
        thumbnail = imgMatch[1];
      }

      items.push({
        id: `custom:${link}`,
        sourceKey: "custom",
        sourceName: feedName,
        category,
        title,
        author: author || undefined,
        date: dateStr,
        timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
        url: link,
        summary: summary || undefined,
        fullHtml: fullHtml || undefined,
        thumbnail,
        mediaType
      });
    }
  }

  return items;
}

/** 解析通用 RSS 2.0 / Atom 订阅源 */
export function parseRssArticles(xmlText: string, feedName: string, options?: ParseRssOptions): MediaItem[] {
  const category = options?.category;
  if (typeof DOMParser !== "undefined") {
    try {
      const parser = new DOMParser();
      const xml = parser.parseFromString(xmlText, "text/xml");
      if (!xml.querySelector("parsererror")) {
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
            const author = el.querySelector("author, creator")?.textContent?.trim()
              || Array.from(el.children).find((c) => c.localName === "creator")?.textContent?.trim()
              || "";
            const desc = el.querySelector("description")?.textContent?.replace(/<[^>]+>/g, "").slice(0, 150) ?? "";

            // 提取 RSS 中的全文（如 WeWe RSS / Feeddd 的 content:encoded 或 content）
            const encodedNode = Array.from(el.children).find((c) => c.localName === "encoded" || c.tagName.toLowerCase().endsWith(":encoded") || c.tagName.toLowerCase() === "content");
            const fullHtml = encodedNode?.textContent?.trim() || "";

            if (!title || !link) continue;
            const timestamp = pubDate ? Date.parse(pubDate) : Date.now();
            const dateStr = Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : "";

            const enclosure = el.querySelector("enclosure");
            const encType = enclosure?.getAttribute("type") || "";
            const encUrl = enclosure?.getAttribute("url") || "";

            let mediaType: "article" | "audio" | "video" = "article";
            if (encType.startsWith("audio/") || encUrl.match(/\.(mp3|m4a|aac|ogg)(\?.*)?$/i) || category?.includes("播客") || category?.includes("音频") || feedName.includes("播客")) {
              mediaType = "audio";
            } else if (encType.startsWith("video/") || encUrl.match(/\.(mp4|mkv|webm)(\?.*)?$/i) || link.includes("bilibili.com") || link.includes("youtube.com") || category?.includes("视频")) {
              mediaType = "video";
            }

            let thumbnail: string | undefined;
            const mediaThumb = el.querySelector("media\\:thumbnail, thumbnail")?.getAttribute("url")
              || el.querySelector("media\\:content[medium='image']")?.getAttribute("url")
              || el.querySelector("itunes\\:image")?.getAttribute("href");
            if (mediaThumb) {
              thumbnail = mediaThumb;
            } else if (encType.startsWith("image/") && encUrl) {
              thumbnail = encUrl;
            } else {
              const imgMatch = (fullHtml || desc).match(/<img[^>]+(?:data-src|src)=["']([^"']+)["']/i);
              if (imgMatch && !imgMatch[1].includes("emoji") && !imgMatch[1].includes("avatar") && !imgMatch[1].includes(".gif")) {
                thumbnail = imgMatch[1];
              }
            }

            items.push({
              id: `custom:${link}`,
              sourceKey: "custom",
              sourceName: feedName,
              category,
              title,
              author: author || undefined,
              date: dateStr,
              timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
              url: link,
              summary: desc || undefined,
              fullHtml: fullHtml || undefined,
              thumbnail,
              mediaType
            });
          }
          if (items.length > 0) return items;
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
          const author = el.querySelector("author name, author")?.textContent?.trim() ?? "";
          const contentEl = el.querySelector("content");
          const fullHtml = contentEl?.textContent?.trim() || "";
          const summary = el.querySelector("summary")?.textContent?.replace(/<[^>]+>/g, "").slice(0, 150)
            || fullHtml.replace(/<[^>]+>/g, "").slice(0, 150)
            || "";

          if (!title || !link) continue;
          const timestamp = published ? Date.parse(published) : Date.now();
          const dateStr = Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : "";

          let mediaType: "article" | "audio" | "video" = "article";
          if (category?.includes("播客") || category?.includes("音频") || feedName.includes("播客")) {
            mediaType = "audio";
          } else if (link.includes("bilibili.com") || link.includes("youtube.com") || category?.includes("视频")) {
            mediaType = "video";
          }

          let thumbnail: string | undefined;
          const imgMatch = (fullHtml || summary).match(/<img[^>]+(?:data-src|src)=["']([^"']+)["']/i);
          if (imgMatch && !imgMatch[1].includes("emoji") && !imgMatch[1].includes("avatar") && !imgMatch[1].includes(".gif")) {
            thumbnail = imgMatch[1];
          }

          items.push({
            id: `custom:${link}`,
            sourceKey: "custom",
            sourceName: feedName,
            category,
            title,
            author: author || undefined,
            date: dateStr,
            timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
            url: link,
            summary: summary || undefined,
            fullHtml: fullHtml || undefined,
            thumbnail,
            mediaType
          });
        }

        if (items.length > 0) return items;
      }
    } catch {
      // DOMParser failed, fallback to regex
    }
  }

  return parseRssWithRegex(xmlText, feedName, options);
}

// ---- 数据加载与综合调度 ----------------------------------------------------

// 单订阅源独立内存缓存
interface FeedCacheEntry {
  items: MediaItem[];
  fetchedAt: number;
}
const feedCacheStore = new Map<string, FeedCacheEntry>();
const FEED_CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟独立源缓存

const DISK_CACHE_FILE = "media-cache.json";
const qiushiIssueStore = new Map<string, string>();
let isDiskCacheLoaded = false;
let diskSaveTimer: number | null = null;

function stripItemForCache(item: MediaItem): MediaItem {
  return {
    id: item.id,
    sourceKey: item.sourceKey,
    sourceName: item.sourceName,
    category: item.category,
    title: item.title,
    author: item.author,
    column: item.column,
    issue: item.issue,
    date: item.date,
    timestamp: item.timestamp,
    url: item.url,
    summary: item.summary ? item.summary.slice(0, 300) : undefined,
    thumbnail: item.thumbnail,
    mediaType: item.mediaType
  };
}

/** 从 .obsidian/plugins/home-pages/media-cache.json 加载持久化磁盘缓存，恢复 0ms 本地冷启动体验 */
export async function loadDiskCache(app: App): Promise<void> {
  try {
    if (!app?.vault?.adapter) return;
    const configDir = app.vault.configDir;
    if (!configDir) return;
    const cachePath = normalizePath(`${configDir}/plugins/home-pages/${DISK_CACHE_FILE}`);
    if (!(await app.vault.adapter.exists(cachePath))) return;

    const text = await app.vault.adapter.read(cachePath);
    const parsed = JSON.parse(text) as {
      feedCache?: Array<[string, FeedCacheEntry]>;
      qiushiIssues?: Array<[string, string]>;
      lastMediaData?: Record<string, MediaData>;
    };

    if (Array.isArray(parsed.feedCache)) {
      for (const [url, entry] of parsed.feedCache) {
        if (url && entry?.items && !feedCacheStore.has(url)) {
          feedCacheStore.set(url, entry);
        }
      }
    }
    if (Array.isArray(parsed.qiushiIssues)) {
      for (const [key, issue] of parsed.qiushiIssues) {
        if (key && issue && !qiushiIssueStore.has(key)) {
          qiushiIssueStore.set(key, issue);
        }
      }
    }
    if (parsed.lastMediaData && typeof parsed.lastMediaData === "object") {
      for (const [key, data] of Object.entries(parsed.lastMediaData)) {
        if (!cacheStore.has(key) && data?.items) {
          cacheStore.set(key, data);
        }
      }
    }
  } catch (err) {
    console.warn("Home Pages: 加载媒体磁盘缓存失败", err);
  }
}

/** 立即写入持久化磁盘缓存 */
export async function saveDiskCacheNow(app: App): Promise<void> {
  try {
    if (!app?.vault?.adapter) return;
    const configDir = app.vault.configDir;
    if (!configDir) return;
    const cacheFolder = normalizePath(`${configDir}/plugins/home-pages`);
    const cachePath = normalizePath(`${cacheFolder}/${DISK_CACHE_FILE}`);

    const feedEntries: Array<[string, FeedCacheEntry]> = [];
    for (const [url, entry] of Array.from(feedCacheStore.entries()).slice(-100)) {
      feedEntries.push([
        url,
        {
          fetchedAt: entry.fetchedAt,
          items: entry.items.slice(0, 30).map(stripItemForCache)
        }
      ]);
    }

    const lastMediaMap: Record<string, MediaData> = {};
    for (const [key, data] of Array.from(cacheStore.entries()).slice(-5)) {
      lastMediaMap[key] = {
        ready: data.ready,
        fetchedAt: data.fetchedAt,
        qiushiIssue: data.qiushiIssue,
        items: data.items.slice(0, 100).map(stripItemForCache)
      };
    }

    const payload = JSON.stringify({
      feedCache: feedEntries,
      qiushiIssues: Array.from(qiushiIssueStore.entries()),
      lastMediaData: lastMediaMap
    });

    await app.vault.adapter.write(cachePath, payload);
  } catch (err) {
    console.warn("Home Pages: 保存媒体磁盘缓存失败", err);
  }
}

/** 防抖延迟写入磁盘缓存 */
export function scheduleSaveDiskCache(app: App): void {
  if (diskSaveTimer !== null) {
    window.clearTimeout(diskSaveTimer);
  }
  diskSaveTimer = window.setTimeout(() => {
    diskSaveTimer = null;
    void saveDiskCacheNow(app);
  }, 2000);
}

/** 同步获取内存/磁盘缓存数据，供 0ms 瞬间渲染 */
export function getCachedMediaData(config: MediaConfig): MediaData | null {
  const cacheKey = JSON.stringify({ qiushiUrl: config.qiushiUrl, zjxcUrl: config.zjxcUrl, customFeeds: config.customFeeds });
  const cached = cacheStore.get(cacheKey);
  if (cached && cached.items && cached.items.length > 0) {
    return cached;
  }

  // 回退：从已缓存的单源组装
  const items: MediaItem[] = [];
  let found = false;
  if (config.showQiushi && config.qiushiUrl.trim()) {
    const q = feedCacheStore.get(`internal:qiushi:${config.qiushiUrl.trim()}`);
    if (q?.items?.length) {
      items.push(...q.items);
      found = true;
    }
  }
  if (config.showZjxc && config.zjxcUrl.trim()) {
    const z = feedCacheStore.get(`internal:zjxc:${config.zjxcUrl.trim()}`);
    if (z?.items?.length) {
      items.push(...z.items);
      found = true;
    }
  }
  const enabledFeeds = (Array.isArray(config.customFeeds) ? config.customFeeds : [])
    .filter((feed) => feed.enabled !== false && feed.url?.trim());
  for (const feed of enabledFeeds) {
    const f = feedCacheStore.get(feed.url.trim());
    if (f?.items?.length) {
      items.push(...f.items);
      found = true;
    }
  }

  if (found && items.length > 0) {
    items.sort((a, b) => b.timestamp - a.timestamp);
    const qiushiIssue = qiushiIssueStore.get(`internal:qiushi:${config.qiushiUrl.trim()}`) || "";
    const assembled: MediaData = {
      ready: true,
      items,
      qiushiIssue,
      fetchedAt: Date.now()
    };
    cacheStore.set(cacheKey, assembled);
    return assembled;
  }

  return null;
}

/** 单源超时熔断请求，4s 超时防止慢速源阻塞，带超时清理 */
async function fetchWithTimeout(url: string, timeoutMs = 4000): Promise<string> {
  let timerId: number | undefined;
  try {
    return await Promise.race([
      fetchText(url),
      new Promise<string>((_, reject) => {
        timerId = window.setTimeout(() => reject(new Error(`请求超时（>${timeoutMs}ms）: ${url}`)), timeoutMs);
      })
    ]);
  } finally {
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
    }
  }
}

export interface SyncProgressCallback {
  (completed: number, total: number, currentItems: MediaItem[], isComplete: boolean): void;
}

export interface SyncOptions {
  forceRefresh?: boolean;
  activeChannel?: string;
  onProgress?: SyncProgressCallback;
}

/** 高并发、通道优先级调度、支持渐进式首屏回调的综合数据同步器 */
export async function syncMediaData(config: MediaConfig, options: SyncOptions = {}): Promise<MediaData> {
  const { forceRefresh = false, activeChannel = "all", onProgress } = options;
  const cacheKey = JSON.stringify({ qiushiUrl: config.qiushiUrl, zjxcUrl: config.zjxcUrl, customFeeds: config.customFeeds });

  const tasks: Array<{
    id: string;
    sourceKey: "qiushi" | "zjxc" | "custom";
    priority: number;
    run: () => Promise<MediaItem[]>;
  }> = [];

  let qiushiIssueName = "";

  // 1. 求是杂志抓取任务
  if (config.showQiushi && config.qiushiUrl.trim()) {
    const qUrl = config.qiushiUrl.trim();
    const isPriority = activeChannel === "qiushi";
    tasks.push({
      id: "qiushi",
      sourceKey: "qiushi",
      priority: isPriority ? 0 : 1,
      run: async () => {
        const cacheId = `internal:qiushi:${qUrl}`;
        const cached = feedCacheStore.get(cacheId);
        if (!forceRefresh && cached && Date.now() - cached.fetchedAt < FEED_CACHE_TTL_MS) {
          qiushiIssueName = qiushiIssueStore.get(cacheId) || "";
          return cached.items;
        }
        try {
          const catalogHtml = await fetchWithTimeout(qUrl, 4000);
          const issues = parseQiushiCatalog(catalogHtml);
          let articles: MediaItem[] = [];
          if (issues.length > 0) {
            const latest = issues[0];
            qiushiIssueName = latest.title;
            const issueHtml = await fetchWithTimeout(latest.url, 4000);
            articles = parseQiushiIssueArticles(issueHtml, latest.title);
          } else {
            articles = parseQiushiIssueArticles(catalogHtml, "求是杂志");
            qiushiIssueName = articles[0]?.issue || "求是杂志";
          }
          if (articles.length > 0) {
            feedCacheStore.set(cacheId, { items: articles, fetchedAt: Date.now() });
            qiushiIssueStore.set(cacheId, qiushiIssueName);
          }
          return articles;
        } catch (err) {
          console.warn("Home Pages: 加载《求是》杂志失败", err);
          if (cached?.items?.length) {
            qiushiIssueName = qiushiIssueStore.get(cacheId) || "";
            return cached.items;
          }
          return [];
        }
      }
    });
  }

  // 2. 浙江宣传抓取任务
  if (config.showZjxc && config.zjxcUrl.trim()) {
    const zUrl = config.zjxcUrl.trim();
    const isPriority = activeChannel === "zjxc";
    tasks.push({
      id: "zjxc",
      sourceKey: "zjxc",
      priority: isPriority ? 0 : 1,
      run: async () => {
        const cacheId = `internal:zjxc:${zUrl}`;
        const cached = feedCacheStore.get(cacheId);
        if (!forceRefresh && cached && Date.now() - cached.fetchedAt < FEED_CACHE_TTL_MS) {
          return cached.items;
        }
        try {
          const zjxcHtml = await fetchWithTimeout(zUrl, 4000);
          const articles = parseZjxcArticles(zjxcHtml);
          if (articles.length > 0) {
            feedCacheStore.set(cacheId, { items: articles, fetchedAt: Date.now() });
          }
          return articles;
        } catch (err) {
          console.warn("Home Pages: 加载浙江宣传失败", err);
          if (cached?.items?.length) return cached.items;
          return [];
        }
      }
    });
  }

  // 3. 自定义订阅源任务（通道优先级调度）
  const enabledFeeds = (Array.isArray(config.customFeeds) ? config.customFeeds : [])
    .filter((feed) => feed.enabled !== false && feed.url?.trim());

  for (const feed of enabledFeeds) {
    let priority = 1;
    if (activeChannel === "custom") {
      priority = 0;
    } else if (activeChannel.startsWith("cat:") && feed.category === activeChannel.slice(4)) {
      priority = 0;
    } else if (activeChannel.startsWith("custom:") && feed.name === activeChannel.slice(7)) {
      priority = 0;
    }

    tasks.push({
      id: `custom:${feed.url.trim()}`,
      sourceKey: "custom",
      priority,
      run: async () => {
        const feedUrl = feed.url.trim();
        const cached = feedCacheStore.get(feedUrl);
        if (!forceRefresh && cached && Date.now() - cached.fetchedAt < FEED_CACHE_TTL_MS) {
          return cached.items;
        }
        try {
          const xml = await fetchWithTimeout(feedUrl, 4000);
          const feedArticles = parseRssArticles(xml, feed.name || "自定义源", { category: feed.category });
          if (feedArticles.length > 0) {
            feedCacheStore.set(feedUrl, { items: feedArticles, fetchedAt: Date.now() });
          }
          return feedArticles;
        } catch (err) {
          console.warn(`Home Pages: 加载自定义订阅源 [${feed.name}] 失败`, err);
          if (cached?.items?.length) return cached.items;
          return [];
        }
      }
    });
  }

  const total = tasks.length;
  if (total === 0) {
    const emptyResult: MediaData = { ready: false, items: [], fetchedAt: Date.now() };
    cacheStore.set(cacheKey, emptyResult);
    onProgress?.(0, 0, [], true);
    return emptyResult;
  }

  // 排序：优先执行当前激活频道的任务
  tasks.sort((a, b) => a.priority - b.priority);

  const itemsMap = new Map<string, MediaItem>();
  const existingCache = cacheStore.get(cacheKey);
  if (existingCache?.items) {
    for (const it of existingCache.items) {
      itemsMap.set(it.id, it);
    }
  }

  let completed = 0;
  const CONCURRENCY = 10;
  let taskIndex = 0;

  const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, async () => {
    while (taskIndex < total) {
      const currentTask = tasks[taskIndex++];
      try {
        const newItems = await currentTask.run();
        for (const item of newItems) {
          itemsMap.set(item.id, item);
        }
      } catch {
        // Safe worker catch
      } finally {
        completed++;
        const currentSorted = Array.from(itemsMap.values()).sort((a, b) => b.timestamp - a.timestamp);
        onProgress?.(completed, total, currentSorted, completed === total);
      }
    }
  });

  await Promise.all(workers);

  const finalItems = Array.from(itemsMap.values()).sort((a, b) => b.timestamp - a.timestamp);
  const result: MediaData = {
    ready: finalItems.length > 0,
    items: finalItems,
    qiushiIssue: qiushiIssueName,
    fetchedAt: Date.now()
  };

  cacheStore.set(cacheKey, result);
  return result;
}

export async function loadMediaData(config: MediaConfig, forceRefresh = false): Promise<MediaData> {
  const cacheKey = JSON.stringify({ qiushiUrl: config.qiushiUrl, zjxcUrl: config.zjxcUrl, customFeeds: config.customFeeds });
  if (!forceRefresh) {
    const cached = cacheStore.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached;
    }
  }
  return await syncMediaData(config, { forceRefresh });
}

function renderSkeleton(container: HTMLElement, count = 4): HTMLElement {
  const skeletonWrap = container.createDiv({ cls: "hp-media-skeleton" });
  for (let i = 0; i < count; i++) {
    const item = skeletonWrap.createDiv({ cls: "hp-media-skeleton-item" });
    const content = item.createDiv({ cls: "hp-media-skeleton-content" });
    content.createDiv({ cls: "hp-media-skeleton-line" });
    content.createDiv({ cls: "hp-media-skeleton-line is-short" });
    if (i % 2 === 0) {
      item.createDiv({ cls: "hp-media-skeleton-thumb" });
    }
  }
  return skeletonWrap;
}

// ---- 一键剪藏到 Obsidian 笔记 ------------------------------------------------

/** 把 HTML 简单转为清晰可读的 Markdown 正文 */
export function htmlToMarkdown(html: string): string {
  let containerHtml = html;
  const detailMatch = html.match(/<div[^>]+id=["']detailContent["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)
    || html.match(/<div[^>]+(?:id=["']js_content["']|class=["'][^"']*rich_media_content[^"']*["'])[^>]*>([\s\S]*?)<\/div>/i)
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
    // 支持标准 src 与微信公众号 data-src 懒加载图片属性
    .replace(/<img[^>]+(?:data-src|src)=["']([^"']+)["'][^>]*>/gi, "\n\n![]($1)\n\n")
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
  // 1. 如果 RSS 源自带了完整的 fullHtml（如 WeWe RSS / Feeddd 的 content:encoded），优先离线转换，避免抓取失败
  if (item.fullHtml && item.fullHtml.trim().length > 100) {
    bodyMd = htmlToMarkdown(item.fullHtml);
  } else {
    try {
      const rawHtml = await fetchText(item.url);
      bodyMd = htmlToMarkdown(rawHtml);
    } catch (err) {
      console.warn("Home Pages: 获取文章正文失败，使用摘要兜底", err);
      bodyMd = item.summary || `> （未能自动拉取全文，请点击下方链接阅读原文）\n\n[阅读原文](${item.url})`;
    }
  }

  const isWechat = item.url.includes("mp.weixin.qq.com") || item.sourceName.includes("微信") || item.sourceName.includes("公众号");
  const tags = ["主流媒体", item.sourceName];
  if (isWechat && !tags.includes("微信公众号")) {
    tags.push("微信公众号");
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
    ...tags.map((t) => `  - ${t}`),
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
      url: String(feed?.url ?? "").trim(),
      category: String(feed?.category ?? "").trim() || undefined,
      enabled: feed?.enabled !== false,
      htmlUrl: typeof feed?.htmlUrl === "string" ? feed.htmlUrl.trim() : undefined,
      type: typeof feed?.type === "string" ? feed.type.trim() : undefined
    })).filter((feed) => feed.url);
    return config;
  },

  async render(body, ctx) {
    const { app, config } = ctx;

    // 1. 确保首次加载时恢复本地磁盘缓存
    if (!isDiskCacheLoaded) {
      isDiskCacheLoaded = true;
      await loadDiskCache(app);
    }
    if (!ctx.isAlive()) return;

    // 2. 检查内存缓存：如有缓存立即 0ms 首屏直出
    const initialCached = getCachedMediaData(config);
    let currentItems: MediaItem[] = initialCached?.items ? [...initialCached.items] : [];
    let currentIssue = initialCached?.qiushiIssue || "";
    let isInitialLoad = currentItems.length === 0;

    const updateSubtitle = (time: number, issue?: string): void => {
      const issueStr = issue ? ` · ${issue}` : "";
      const timeStr = time ? formatRelativeTime(time) : "刚刚";
      ctx.setSubtitle(`${timeStr}更新${issueStr}`);
    };

    if (currentItems.length > 0) {
      updateSubtitle(initialCached?.fetchedAt || Date.now(), currentIssue);
    } else {
      ctx.setSubtitle("正在获取最新文章…");
    }

    // 3. 头部动作：刷新按钮（支持旋转动效）与剪藏文件夹快捷跳转
    let refreshBtnEl: HTMLElement | null = null;
    refreshBtnEl = ctx.addHeaderAction("refresh-cw", "刷新文章", () => {
      new Notice("正在刷新最新订阅与主流媒体…", 2000);
      startSync(true);
    });

    if (config.showClipper && config.clipFolder.trim()) {
      ctx.addHeaderAction("folder", `打开剪藏文件夹（${config.clipFolder}）`, (event) => {
        void ctx.openPath(config.clipFolder, { event });
      });
    }

    ctx.registerInterval(() => {
      startSync(true);
    }, 60 * 60 * 1000);

    const wrap = body.createDiv({ cls: "hp-media" });

    // 顶部极细渐变加载进度光轨
    const progressTrack = wrap.createDiv({ cls: `hp-media-progress-track${isInitialLoad ? "" : " is-done"}` });
    const progressFill = progressTrack.createDiv({ cls: "hp-media-progress-fill" });

    let searchKeyword = "";
    const batchSize = Math.max(config.limit || 20, 20);
    let visibleCount = batchSize;

    // 工具栏容器（频道选择 + 实时搜索）
    const toolbar = wrap.createDiv({ cls: "hp-media-toolbar" });
    let selectEl: HTMLSelectElement | null = null;
    let tabsEl: HTMLElement | null = null;

    if (config.navStyle === "dropdown") {
      const selectWrap = toolbar.createDiv({ cls: "hp-media-select-wrap" });
      selectEl = selectWrap.createEl("select", { cls: "dropdown hp-media-channel-select" });
      selectEl.addEventListener("change", () => {
        if (selectEl) {
          visibleCount = batchSize;
          config.channel = selectEl.value;
          void ctx.saveConfig({ channel: selectEl.value });
          renderListItems();
        }
      });
    } else {
      tabsEl = toolbar.createDiv({ cls: "hp-media-tabs" });
    }

    const searchWrap = toolbar.createDiv({ cls: "hp-media-search-wrap" });
    const searchInput = searchWrap.createEl("input", {
      cls: "hp-media-search",
      attr: { type: "search", placeholder: "搜索文章 / 作者 / 分类...", value: searchKeyword }
    });

    // 列表容器
    const list = wrap.createDiv({ cls: "hp-media-list" });

    // 计算频道和分类选项
    const computeChannelOptions = (items: MediaItem[]): Array<{ key: string; label: string; count: number }> => {
      const options: Array<{ key: string; label: string; count: number }> = [
        { key: "all", label: "全部聚合", count: items.length }
      ];
      if (config.showQiushi) {
        const qCount = items.filter((item) => item.sourceKey === "qiushi").length;
        options.push({
          key: "qiushi",
          label: currentIssue ? `求是（${currentIssue.replace(/《?求是》?/, "")}）` : "《求是》杂志",
          count: qCount
        });
      }
      if (config.showZjxc) {
        const zCount = items.filter((item) => item.sourceKey === "zjxc").length;
        options.push({ key: "zjxc", label: "浙江宣传", count: zCount });
      }

      const customItems = items.filter((i) => i.sourceKey === "custom");
      const catCounts = new Map<string, number>();
      for (const item of customItems) {
        const cat = item.category || "未分类";
        catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
      }

      if (catCounts.size >= 2) {
        options.push({ key: "custom", label: "全部其他订阅", count: customItems.length });
        for (const [catName, count] of catCounts.entries()) {
          options.push({ key: `cat:${catName}`, label: `📁 ${catName}`, count });
        }
      } else if (customItems.length > 0) {
        options.push({ key: "custom", label: "全部其他订阅", count: customItems.length });
      }

      const customFeedNames = Array.from(new Set(customItems.map((i) => i.sourceName)));
      if (customFeedNames.length > 0 && customFeedNames.length <= 25) {
        for (const name of customFeedNames) {
          const count = customItems.filter((i) => i.sourceName === name).length;
          options.push({ key: `custom:${name}`, label: `↳ ${name}`, count });
        }
      }

      return options;
    };

    const renderToolbarOptions = (): void => {
      const options = computeChannelOptions(currentItems);

      if (selectEl) {
        selectEl.empty();
        for (const opt of options) {
          const optionEl = selectEl.createEl("option", {
            value: opt.key,
            text: `${opt.label} (${opt.count})`
          });
          if (config.channel === opt.key) {
            optionEl.selected = true;
          }
        }
      } else if (tabsEl) {
        tabsEl.empty();
        for (const opt of options) {
          const pill = tabsEl.createEl("button", {
            cls: `hp-media-pill${config.channel === opt.key ? " is-active" : ""}`,
            text: opt.label.replace(/《?求是》?/, "求是"),
            attr: { type: "button" }
          });
          if (opt.count > 0) {
            pill.createSpan({ cls: "hp-media-pill-count", text: String(opt.count) });
          }
          pill.addEventListener("click", () => {
            config.channel = opt.key;
            visibleCount = batchSize;
            void ctx.saveConfig({ channel: opt.key });
            renderToolbarOptions();
            renderListItems();
          });
        }
      }
    };

    const renderListItems = (): void => {
      list.empty();

      let items = currentItems;
      // 频道筛选
      if (config.channel !== "all") {
        if (config.channel === "custom") {
          items = items.filter((item) => item.sourceKey === "custom");
        } else if (config.channel.startsWith("cat:")) {
          const targetCat = config.channel.slice("cat:".length);
          items = items.filter((item) => (item.category || "未分类") === targetCat);
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
          || (item.category && item.category.toLowerCase().includes(q))
        );
      }

      const totalItemsCount = items.length;
      const displayedItems = items.slice(0, visibleCount);

      if (totalItemsCount === 0) {
        if (isInitialLoad) {
          renderSkeleton(list, 4);
          return;
        }
        renderEmpty(list, {
          icon: "newspaper",
          text: q ? `未找到与“${q}”相关的订阅文章` : "未加载到文章，请检查网络或点击刷新。",
          action: q ? undefined : {
            label: "立即刷新",
            onClick: () => {
              startSync(true);
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

        if (item.category && item.category !== "未分类") {
          titleRow.createSpan({ cls: "hp-media-badge hp-media-badge-cat", text: item.category });
        }
        if (item.mediaType === "audio") {
          titleRow.createSpan({ cls: "hp-media-badge hp-media-badge-audio", text: "🎙️ 播客" });
        } else if (item.mediaType === "video") {
          titleRow.createSpan({ cls: "hp-media-badge hp-media-badge-video", text: "🎬 视频" });
        }

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

        // 缩略图（若有封面）
        if (item.thumbnail) {
          const thumb = row.createEl("img", {
            cls: "hp-media-thumb",
            attr: { src: item.thumbnail, alt: "封面", loading: "lazy" }
          });
          thumb.addEventListener("error", () => {
            thumb.remove();
          });
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
        let totalCount = currentItems.length;
        if (config.channel !== "all") {
          if (config.channel === "custom") {
            totalCount = currentItems.filter((i) => i.sourceKey === "custom").length;
          } else if (config.channel.startsWith("cat:")) {
            const targetCat = config.channel.slice("cat:".length);
            totalCount = currentItems.filter((i) => (i.category || "未分类") === targetCat).length;
          } else if (config.channel.startsWith("custom:")) {
            const feedName = config.channel.slice("custom:".length);
            totalCount = currentItems.filter((i) => i.sourceKey === "custom" && i.sourceName === feedName).length;
          } else {
            totalCount = currentItems.filter((i) => i.sourceKey === config.channel).length;
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

    // 初始首屏装载
    renderToolbarOptions();
    if (isInitialLoad) {
      renderSkeleton(list, 4);
    } else {
      renderListItems();
    }

    // 后台平滑同步机制 (Stale-While-Revalidate + 流式渐进上屏)
    let isSyncing = false;
    let syncThrottleTimer: number | null = null;

    const startSync = (forceRefresh = false): void => {
      if (isSyncing) return;
      isSyncing = true;
      refreshBtnEl?.addClass("is-spinning");
      progressTrack.removeClass("is-done");
      progressFill.setCssProps({ "--hp-media-progress": "4%" });

      void syncMediaData(config, {
        forceRefresh,
        activeChannel: config.channel,
        onProgress: (completed, total, latestItems, isComplete) => {
          if (!ctx.isAlive()) return;
          const pct = Math.min(100, Math.round((completed / Math.max(1, total)) * 100));
          progressFill.setCssProps({ "--hp-media-progress": `${pct}%` });

          // 骨架屏状态下：第一批数据到达时立即流式呈现首屏
          if (isInitialLoad && latestItems.length > 0) {
            isInitialLoad = false;
            currentItems = latestItems;
            renderToolbarOptions();
            renderListItems();
          } else if (!isInitialLoad && !isComplete && latestItems.length > currentItems.length) {
            if (syncThrottleTimer === null) {
              syncThrottleTimer = window.setTimeout(() => {
                syncThrottleTimer = null;
                if (!ctx.isAlive()) return;
                currentItems = latestItems;
                renderToolbarOptions();
                renderListItems();
              }, 600);
            }
          }

          if (isComplete) {
            if (syncThrottleTimer !== null) {
              window.clearTimeout(syncThrottleTimer);
              syncThrottleTimer = null;
            }
            isSyncing = false;
            refreshBtnEl?.removeClass("is-spinning");
            progressFill.setCssProps({ "--hp-media-progress": "100%" });
            window.setTimeout(() => {
              if (ctx.isAlive()) {
                progressTrack.addClass("is-done");
              }
            }, 400);

            currentItems = latestItems;
            const updatedQiushi = qiushiIssueStore.get(`internal:qiushi:${config.qiushiUrl.trim()}`);
            if (updatedQiushi) currentIssue = updatedQiushi;
            renderToolbarOptions();
            renderListItems();
            updateSubtitle(Date.now(), currentIssue);
            scheduleSaveDiskCache(app);
          }
        }
      });
    };

    // 触发后台静默同步
    startSync(false);
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
        .setValue(config.channel.startsWith("custom:") || config.channel.startsWith("cat:") ? "custom" : config.channel)
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

    addSectionHeading(container, "自定义 RSS / OPML 订阅管理");

    const feeds = (config.customFeeds || []).map((f) => ({ ...f }));
    const commitFeeds = (): void => ctx.update({ customFeeds: feeds.map((f) => ({ ...f })) });

    // OPML 导入导出快捷工具栏
    const opmlBar = container.createDiv({ cls: "hp-media-opml-toolbar" });

    // 辅助：弹窗选择导入行为（追加还是替换）
    const handleImportedFeeds = (incoming: CustomFeed[]): void => {
      const catCounts = new Map<string, number>();
      for (const item of incoming) {
        const cat = item.category || "未分类";
        catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
      }
      const summary = Array.from(catCounts.entries()).map(([c, n]) => `${c} (${n})`).join("、");

      new ConfirmModal(ctx.app, {
        title: `解析成功：发现 ${incoming.length} 个订阅源`,
        message: `包含分类：${summary}。\n\n选择“追加导入”将新增至现有列表；选择“覆盖导入”将替换现有列表。`,
        confirmText: "追加导入全部"
      }, () => {
        // 去重合并（按 URL）
        const existingUrls = new Set(feeds.map((f) => f.url));
        let addedCount = 0;
        for (const item of incoming) {
          if (!existingUrls.has(item.url)) {
            feeds.push({ ...item, enabled: true });
            existingUrls.add(item.url);
            addedCount++;
          }
        }
        commitFeeds();
        ctx.refresh();
        new Notice(`已成功导入 ${addedCount} 个新订阅源！`);
      }).open();
    };

    // 1. 本地 OPML 文件导入
    const fileInput = opmlBar.createEl("input", {
      attr: { type: "file", accept: ".opml,.xml", style: "display: none;" }
    });
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = typeof reader.result === "string" ? reader.result : "";
        const parsed = parseOpml(text);
        if (parsed.length === 0) {
          new Notice("未能从该文件中解析出有效的 OPML 订阅源。");
          return;
        }
        handleImportedFeeds(parsed);
      };
      reader.readAsText(file);
    });

    const importFileBtn = opmlBar.createEl("button", {
      cls: "mod-cta hp-opml-btn",
      text: "📥 导入 OPML 文件",
      attr: { type: "button" }
    });
    importFileBtn.addEventListener("click", () => fileInput.click());

    // 2. ⚡ 从桌面快速载入 follow.opml
    const loadDesktopBtn = opmlBar.createEl("button", {
      cls: "hp-opml-btn",
      text: "⚡ 载入桌面 follow.opml",
      attr: { type: "button", title: "读取桌面上的 follow.opml 并快速导入" }
    });
    loadDesktopBtn.addEventListener("click", () => {
      let content = "";
      try {
        interface ElectronFs {
          existsSync: (p: string) => boolean;
          readFileSync: (p: string, enc: string) => string;
        }
        const electronRequire = (window as unknown as { require?: (mod: string) => ElectronFs }).require;
        if (typeof electronRequire === "function") {
          const fs = electronRequire("fs");
          const desktopPath = "C:\\Users\\加加\\Desktop\\follow.opml";
          if (fs && fs.existsSync(desktopPath)) {
            content = fs.readFileSync(desktopPath, "utf8");
          }
        }
      } catch {
        // fallback
      }

      if (!content) {
        new Notice("桌面暂未检测到 follow.opml，请使用「导入 OPML 文件」手动选择。");
        return;
      }

      const parsed = parseOpml(content);
      handleImportedFeeds(parsed);
    });

    // 3. 📋 粘贴 OPML 代码
    const pasteBtn = opmlBar.createEl("button", {
      cls: "hp-opml-btn",
      text: "📋 粘贴代码导入",
      attr: { type: "button" }
    });
    pasteBtn.addEventListener("click", () => {
      new PromptModal(ctx.app, {
        title: "粘贴 OPML XML 代码",
        placeholder: "<?xml version=\"1.0\"?>\n<opml version=\"2.0\">...",
        confirmText: "解析并导入"
      }, (val) => {
        const parsed = parseOpml(val);
        if (parsed.length === 0) {
          new Notice("未能解析出有效的 OPML 订阅源。");
          return;
        }
        handleImportedFeeds(parsed);
      }).open();
    });

    // 4. 📤 导出 OPML
    const exportBtn = opmlBar.createEl("button", {
      cls: "hp-opml-btn",
      text: "📤 导出 OPML 文件",
      attr: { type: "button" }
    });
    exportBtn.addEventListener("click", () => {
      if (feeds.length === 0) {
        new Notice("当前没有任何自定义订阅源可导出。");
        return;
      }
      const opmlXml = exportOpml(feeds, "Home Pages 订阅源备份");
      const blob = new Blob([opmlXml], { type: "application/xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = createEl("a", { attr: { href: url, download: `home-pages-subscriptions-${todayIso()}.opml` } });
      a.click();
      URL.revokeObjectURL(url);
      new Notice(`已成功导出 ${feeds.length} 个订阅源至 OPML 文件`);
    });

    // 按分类组织折叠管理面板
    const catGroups = new Map<string, Array<{ feed: CustomFeed; originalIndex: number }>>();
    feeds.forEach((feed, originalIndex) => {
      const cat = feed.category?.trim() || "未分类";
      const list = catGroups.get(cat) ?? [];
      list.push({ feed, originalIndex });
      catGroups.set(cat, list);
    });

    if (feeds.length === 0) {
      container.createEl("p", {
        cls: "hp-setting-tip",
        text: "当前暂无自定义订阅源。可点击上方按钮导入 OPML 文件，或点击下方「＋ 添加自定义源」手动添加。"
      });
    }

    for (const [catName, groupItems] of catGroups.entries()) {
      const groupEl = container.createDiv({ cls: "hp-media-cat-group" });
      const headerEl = groupEl.createDiv({ cls: "hp-media-cat-header" });
      const titleWrap = headerEl.createDiv({ cls: "hp-media-cat-title" });
      titleWrap.createSpan({ text: `📁 ${catName}` });
      titleWrap.createSpan({ cls: "hp-media-cat-badge", text: `${groupItems.length} 个源` });

      const actionsEl = headerEl.createDiv({ cls: "hp-media-cat-actions" });

      // 批量停用/启用按钮
      const allEnabled = groupItems.every((item) => item.feed.enabled !== false);
      const toggleCatBtn = actionsEl.createEl("button", {
        cls: "hp-opml-btn",
        text: allEnabled ? "全部暂停" : "全部启用",
        attr: { type: "button" }
      });
      toggleCatBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const nextState = !allEnabled;
        for (const item of groupItems) {
          item.feed.enabled = nextState;
        }
        commitFeeds();
        ctx.refresh();
      });

      // 删除整组分类
      const delCatBtn = actionsEl.createEl("button", {
        cls: "hp-opml-btn mod-warning",
        text: "删除分类",
        attr: { type: "button" }
      });
      delCatBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        new ConfirmModal(ctx.app, {
          title: `删除分类「${catName}」？`,
          message: `此操作将移除该分类下的全部 ${groupItems.length} 个订阅源。`,
          confirmText: "确认删除",
          danger: true
        }, () => {
          const toRemove = new Set(groupItems.map((item) => item.originalIndex));
          const next = feeds.filter((_, idx) => !toRemove.has(idx));
          feeds.length = 0;
          feeds.push(...next);
          commitFeeds();
          ctx.refresh();
        }).open();
      });

      const bodyEl = groupEl.createDiv({ cls: "hp-media-cat-body" });
      headerEl.addEventListener("click", () => {
        bodyEl.toggleClass("is-collapsed", !bodyEl.hasClass("is-collapsed"));
      });

      // 逐个渲染源
      for (const item of groupItems) {
        const row = bodyEl.createDiv({ cls: "hp-setting-row" });
        const setting = new Setting(row);

        setting.addToggle((toggle) => {
          toggle.setTooltip("启用/停用此源")
            .setValue(item.feed.enabled !== false)
            .onChange((val) => {
              item.feed.enabled = val;
              commitFeeds();
            });
        });

        setting.addText((t) => t.setPlaceholder("媒体名称").setValue(item.feed.name).onChange((v) => {
          item.feed.name = v.trim();
          commitFeeds();
        }));

        setting.addText((t) => t.setPlaceholder("RSS 地址").setValue(item.feed.url).onChange((v) => {
          item.feed.url = v.trim();
          commitFeeds();
        }));

        setting.addExtraButton((btn) => btn.setIcon("trash-2").setTooltip("删除此订阅源").onClick(() => {
          feeds.splice(item.originalIndex, 1);
          commitFeeds();
          ctx.refresh();
        }));
      }
    }

    const footerBar = container.createDiv({ cls: "hp-media-footer-actions", attr: { style: "display: flex; gap: 8px; margin-top: 12px;" } });
    new Setting(footerBar).addButton((btn) => btn.setButtonText("＋ 添加自定义订阅源").onClick(() => {
      feeds.push({ name: "", url: "", category: "未分类", enabled: true });
      commitFeeds();
      ctx.refresh();
    }));

    if (feeds.length > 0) {
      new Setting(footerBar).addButton((btn) => btn.setButtonText("清空全部源").setWarning().onClick(() => {
        new ConfirmModal(ctx.app, {
          title: "清空全部自定义订阅源？",
          message: `确定要彻底删除现有的 ${feeds.length} 个自定义订阅源吗？此操作无法撤销。`,
          confirmText: "清空全部",
          danger: true
        }, () => {
          feeds.length = 0;
          commitFeeds();
          ctx.refresh();
        }).open();
      }));
    }
  }
};
