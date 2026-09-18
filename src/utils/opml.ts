export interface OpmlFeed {
  name: string;
  url: string;
  category?: string;
  htmlUrl?: string;
  type?: string;
}

export interface OpmlCategorySummary {
  category: string;
  count: number;
}

/**
 * 规范化分类名称：
 * - 如果多层分类以 Follow 默认的 "Articles" 开头（如 Articles / 科技），则简化为 "科技"
 * - 如果是 "Videos / 时政"，则映射为更易读的 "视频 / 时政"
 * - 如果是 "Audios"，则映射为 "播客音频"
 */
export function normalizeCategoryName(rawCategory: string): string {
  const trimmed = rawCategory.trim();
  if (!trimmed) return "未分类";

  let parts = trimmed.split("/").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return "未分类";

  if (parts.length > 1 && parts[0].toLowerCase() === "articles") {
    parts = parts.slice(1);
  } else if (parts.length === 1 && parts[0].toLowerCase() === "articles") {
    return "精选文章";
  }

  if (parts[0].toLowerCase() === "videos") {
    parts[0] = "视频";
  } else if (parts[0].toLowerCase() === "audios") {
    parts[0] = "播客音频";
  } else if (parts[0].toLowerCase() === "notifications") {
    parts[0] = "通知动态";
  }

  return parts.join(" / ");
}

/** 反转义 XML 基础实体 */
function unescapeXml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/** 转义 XML 基础实体 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 正则栈引擎解析 OPML（Node 环境、测试环境或特殊 XML 格式下的兜底） */
export function parseOpmlWithRegex(xmlText: string): OpmlFeed[] {
  const feeds: OpmlFeed[] = [];
  const regex = /<(\/)?outline\b([^>]*?)(\/)?>/gi;
  let match: RegExpExecArray | null;
  const stack: Array<{ type: "folder" | "feed"; name: string }> = [];

  while ((match = regex.exec(xmlText)) !== null) {
    const isClose = Boolean(match[1]);
    const rawAttrs = match[2] || "";
    const isSelfClose = Boolean(match[3]);

    if (isClose) {
      stack.pop();
      continue;
    }

    const attrs: Record<string, string> = {};
    const attrRegex = /([a-zA-Z0-9_:]+)="([^"]*)"/g;
    let am: RegExpExecArray | null;
    while ((am = attrRegex.exec(rawAttrs)) !== null) {
      attrs[am[1].toLowerCase()] = unescapeXml(am[2]);
    }

    const xmlUrl = attrs.xmlurl || attrs.url;
    const title = attrs.title || attrs.text || "未命名源";

    if (xmlUrl) {
      const folders = stack.filter((s) => s.type === "folder").map((s) => s.name);
      const rawCat = folders.join("/");
      feeds.push({
        name: title.trim(),
        url: xmlUrl.trim(),
        category: normalizeCategoryName(rawCat),
        htmlUrl: attrs.htmlurl?.trim(),
        type: attrs.type?.trim() || "rss"
      });
      if (!isSelfClose) {
        stack.push({ type: "feed", name: title });
      }
    } else {
      if (!isSelfClose) {
        stack.push({ type: "folder", name: title.trim() });
      }
    }
  }

  return feeds;
}

/**
 * 解析 OPML 1.0 / 2.0 文件
 * 在浏览器环境下优先使用 DOMParser 保持与平台一致的 XML 处理能力，在 Node.js 或 DOMParser 失败时自动回退到正则栈引擎。
 */
export function parseOpml(xmlText: string): OpmlFeed[] {
  const cleanXml = xmlText.replace(/^\uFEFF/, "").trim(); // 去除 UTF-8 BOM
  if (!cleanXml) return [];

  if (typeof DOMParser !== "undefined") {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(cleanXml, "text/xml");
      if (!doc.querySelector("parsererror")) {
        const feeds: OpmlFeed[] = [];
        const walk = (node: Element, folderStack: string[]): void => {
          for (const child of Array.from(node.children)) {
            if (child.tagName.toLowerCase() !== "outline") continue;

            const xmlUrl = child.getAttribute("xmlUrl") || child.getAttribute("xmlurl") || child.getAttribute("url");
            const text = child.getAttribute("text") || child.getAttribute("title") || "未命名源";
            const htmlUrl = child.getAttribute("htmlUrl") || child.getAttribute("htmlurl") || undefined;
            const type = child.getAttribute("type") || "rss";

            if (xmlUrl) {
              feeds.push({
                name: text.trim(),
                url: xmlUrl.trim(),
                category: normalizeCategoryName(folderStack.join("/")),
                htmlUrl: htmlUrl?.trim(),
                type: type.trim()
              });
            } else {
              walk(child, [...folderStack, text.trim()]);
            }
          }
        };

        const body = doc.querySelector("body") || doc.documentElement;
        if (body) {
          walk(body, []);
        }

        if (feeds.length > 0) return feeds;
      }
    } catch {
      // 回退至正则引擎
    }
  }

  return parseOpmlWithRegex(cleanXml);
}

/**
 * 把当前订阅列表导出为标准 OPML 2.0 XML 文本
 */
export function exportOpml(
  feeds: Array<{ name: string; url: string; category?: string; htmlUrl?: string; type?: string }>,
  title = "Home Pages Subscriptions"
): string {
  const now = new Date().toUTCString();

  // 按分类分组
  const groups = new Map<string, typeof feeds>();
  for (const feed of feeds) {
    const cat = feed.category?.trim() || "未分类";
    const list = groups.get(cat) ?? [];
    list.push(feed);
    groups.set(cat, list);
  }

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    "  <head>",
    `    <title>${escapeXml(title)}</title>`,
    `    <dateCreated>${now}</dateCreated>`,
    "  </head>",
    "  <body>"
  ];

  for (const [category, items] of groups.entries()) {
    lines.push(`    <outline text="${escapeXml(category)}" title="${escapeXml(category)}">`);
    for (const item of items) {
      const escapedName = escapeXml(item.name || "未命名源");
      const escapedUrl = escapeXml(item.url);
      const htmlAttr = item.htmlUrl ? ` htmlUrl="${escapeXml(item.htmlUrl)}"` : "";
      const typeAttr = ` type="${escapeXml(item.type || "rss")}"`;
      lines.push(`      <outline text="${escapedName}" title="${escapedName}" xmlUrl="${escapedUrl}"${htmlAttr}${typeAttr} />`);
    }
    lines.push("    </outline>");
  }

  lines.push("  </body>");
  lines.push("</opml>");
  return lines.join("\n");
}
