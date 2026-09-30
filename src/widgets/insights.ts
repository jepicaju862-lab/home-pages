import { App, Notice, Setting, TFile, setIcon } from "obsidian";
import { formatRelativeTime } from "../utils/date";
import { findCommandId, runCommand } from "../utils/plugins";
import { addNumberSetting, addPathSetting, addSectionHeading, addTextareaSetting } from "../ui/settingHelpers";
import { AnnotationsConfig, loadAnnotations } from "./annotations";
import { SECTION_META, buildDigest, type DigestSection } from "./duoweiDigest";
import { loadWechat } from "./wechat";
import { WidgetContext, WidgetDefinition, clampInt, normalizeWith, toStringList } from "./types";

type SourceKey = "all" | "duowei" | "annotations" | "wechat";
type ItemSource = Exclude<SourceKey, "all">;

export interface InsightsConfig extends Record<string, unknown> {
  source: SourceKey;
  showDuowei: boolean;
  showAnnotations: boolean;
  showWechat: boolean;
  duoweiPath: string;
  duoweiTitleField: string;
  duoweiStatusField: string;
  duoweiDateField: string;
  duoweiSummaryFields: string[];
  duoweiDoneValues: string[];
  annotationPluginId: string;
  annotationCenterFolder: string;
  annotationMdSourceFolder: string;
  annotationCardsFolder: string;
  wechatPath: string;
  limit: number;
  showCompleted: boolean;
}

const DEFAULTS: InsightsConfig = {
  source: "all",
  showDuowei: true,
  showAnnotations: true,
  showWechat: true,
  duoweiPath: "",
  duoweiTitleField: "",
  duoweiStatusField: "",
  duoweiDateField: "",
  duoweiSummaryFields: [],
  duoweiDoneValues: ["完成", "已完成", "已归档", "归档", "取消", "done", "closed", "archived", "cancelled"],
  annotationPluginId: "mobile-ink-annotation-pro",
  annotationCenterFolder: "",
  annotationMdSourceFolder: "",
  annotationCardsFolder: "",
  wechatPath: "WeChat2Ob/微信收件箱.duowei",
  limit: 12,
  showCompleted: false
};

interface DuoweiOption {
  id: string;
  name: string;
}

interface DuoweiField {
  id: string;
  name: string;
  type: string;
  options?: DuoweiOption[];
}

interface DuoweiRecord {
  id: string;
  values: Record<string, unknown>;
  notePath?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface DuoweiDoc {
  titleFieldId?: string;
  fields: DuoweiField[];
  records: DuoweiRecord[];
}

interface InsightItem {
  id: string;
  source: ItemSource;
  title: string;
  summary: string;
  labels: string[];
  time: number;
  rank: number;
  sortValue: number;
  open: (event: MouseEvent) => void;
}

interface SourceResult {
  ready: boolean;
  total: number;
  items: InsightItem[];
  due?: number;
}

const SOURCE_META: Record<ItemSource, { label: string; icon: string; tone: string }> = {
  duowei: { label: "多维", icon: "list-checks", tone: "blue" },
  annotations: { label: "批注", icon: "highlighter", tone: "amber" },
  wechat: { label: "微信", icon: "message-circle", tone: "green" }
};

async function loadDuowei(app: App, path: string): Promise<DuoweiDoc | null> {
  const file = app.vault.getAbstractFileByPath(path.trim());
  if (!(file instanceof TFile)) return null;
  try {
    const parsed = JSON.parse(await app.vault.cachedRead(file)) as Partial<DuoweiDoc>;
    return Array.isArray(parsed.fields) && Array.isArray(parsed.records) ? parsed as DuoweiDoc : null;
  } catch (error) {
    console.error("Home Pages: failed to read insight source", path, error);
    return null;
  }
}

function findField(doc: DuoweiDoc, configured: string, candidates: string[]): DuoweiField | undefined {
  const wanted = configured.trim().toLowerCase();
  if (wanted) return doc.fields.find((field) => field.id.toLowerCase() === wanted || field.name.toLowerCase() === wanted);
  const names = candidates.map((value) => value.toLowerCase());
  return doc.fields.find((field) => names.includes(field.name.toLowerCase()) || names.includes(field.id.toLowerCase()));
}

function valueText(field: DuoweiField | undefined, value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const one = (item: unknown): string => {
    const option = field?.options?.find((entry) => entry.id === item || entry.name === item);
    if (option) return option.name;
    if (typeof item === "object") return JSON.stringify(item);
    return String(item).replace(/^\[\[|\]\]$/g, "");
  };
  return (Array.isArray(value) ? value : [value]).map(one).filter(Boolean).join("、");
}

function parseTime(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanLink(value: string): string {
  return value.trim().replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0];
}

function sourceEnabled(config: InsightsConfig, source: ItemSource): boolean {
  if (source === "duowei") return config.showDuowei;
  if (source === "annotations") return config.showAnnotations;
  return config.showWechat;
}

const DIGEST_RANK: Record<DigestSection, number> = { overdue: 0, today: 1, upcoming: 2, active: 3, recent: 4 };

/** 跨表格情报：库内全部 .duowei（或 duoweiPath 指定的单表 / 文件夹）里的逾期、今天、即将到期、进行中、最近更新记录。 */
async function loadDigestInsights(ctx: WidgetContext<InsightsConfig>): Promise<SourceResult> {
  const { config } = ctx;
  const digest = await buildDigest(ctx.app, {
    folder: config.duoweiPath.trim(),
    excludeTables: [],
    dateFieldNames: config.duoweiDateField.trim() ? [config.duoweiDateField.trim()] : [],
    upcomingDays: 7,
    overdueDays: 30,
    recentDays: 3,
    sectionLimit: Math.max(3, Math.ceil(config.limit / 2)),
    sections: ["overdue", "today", "upcoming", "active", "recent"],
    doneValues: config.showCompleted ? [] : config.duoweiDoneValues
  });
  if (digest.scanned === 0) return { ready: false, total: 0, items: [] };
  const items = digest.items.map<InsightItem>((item) => ({
    id: "duowei:" + item.tablePath + ":" + item.title,
    source: "duowei",
    title: item.title,
    summary: item.tableName,
    labels: [SECTION_META[item.section].label, item.dateText ?? "", item.status?.text ?? ""].filter(Boolean),
    time: item.date ? Date.parse(item.date) : item.updatedAt,
    rank: DIGEST_RANK[item.section],
    sortValue: item.section === "overdue" ? -(Date.parse(item.date ?? "") || 0) : (Date.parse(item.date ?? "") || -item.updatedAt),
    open: (event) => void ctx.openPath(item.notePath ?? item.tablePath, { event })
  }));
  const total = Object.values(digest.totals).reduce((sum, count) => sum + count, 0);
  return { ready: true, total, items };
}

/** 优先读 WeChat2Ob 的同步日志（不依赖是否开启表格输出）；没有日志时回退到收件箱表格。 */
async function loadWechatJournalInsights(ctx: WidgetContext<InsightsConfig>): Promise<SourceResult | null> {
  const data = await loadWechat(ctx.app, { source: "auto", duoweiPluginId: "duowei-table-pro", duoweiTablePath: "", pluginId: "wechat2ob", stateFolder: "", showStats: false, showThumbs: false, days: 14, limit: 50, kinds: [], pendingOnly: false });
  if (!data.ready) return null;
  const items = data.items.map<InsightItem>((item) => ({
    id: "wechat:" + item.key,
    source: "wechat",
    title: item.text,
    summary: item.notePath ? item.notePath.replace(/\.md$/i, "") : "",
    labels: [item.attachments.length > 0 ? item.attachments.length + " 个附件" : ""].filter(Boolean),
    time: item.receivedAt,
    rank: 2,
    sortValue: -item.receivedAt,
    open: (event) => {
      if (item.notePath) void ctx.openPath(item.notePath, { event });
      else if (item.attachments[0]) void ctx.openPath(item.attachments[0].path, { event });
      else runWechatCommand(ctx, "open-inbox");
    }
  }));
  return { ready: true, total: data.pending ?? data.week, items };
}

function annotationConfig(config: InsightsConfig): AnnotationsConfig {
  return {
    pluginId: config.annotationPluginId,
    centerFolder: config.annotationCenterFolder,
    mdSourceFolder: config.annotationMdSourceFolder,
    cardsFolder: config.annotationCardsFolder,
    showStats: true,
    showList: true,
    showPreview: false,
    status: "inbox",
    collection: "",
    sortBy: "updatedAt",
    limit: 50,
    panel: "annotations"
  };
}

function openAnnotationCenter(ctx: WidgetContext<InsightsConfig>): void {
  const options = { pluginId: ctx.config.annotationPluginId, nameIncludes: ["annotation center", "批注中心"] };
  const id = findCommandId(ctx.app, options) ?? findCommandId(ctx.app, { nameIncludes: options.nameIncludes });
  if (!id || !runCommand(ctx.app, id)) new Notice("未找到批注中心命令，请确认手写批注插件已启用");
}

async function loadAnnotationInsights(ctx: WidgetContext<InsightsConfig>): Promise<SourceResult> {
  const data = await loadAnnotations(ctx.app, annotationConfig(ctx.config));
  if (!data.ready) return { ready: false, total: 0, items: [], due: 0 };
  const items = data.items.filter((item) => ctx.config.showCompleted || item.status !== "archived").map<InsightItem>((item) => ({
    id: "annotations:" + item.key,
    source: "annotations",
    title: item.text || "批注",
    summary: [item.sourceLabel, ...item.collections.slice(0, 2)].filter(Boolean).join(" · "),
    labels: [...item.tags.slice(0, 2).map((tag) => "#" + tag), ...(item.hasAi ? ["AI"] : [])],
    time: item.time,
    rank: 2,
    sortValue: -item.time,
    open: (event) => {
      if (item.openTarget && "link" in item.openTarget) void ctx.app.workspace.openLinkText(item.openTarget.link, "", false);
      else if (item.openTarget) void ctx.openPath(item.openTarget.path, { line: item.openTarget.line, event });
      else if (item.cardPath) void ctx.openPath(item.cardPath, { event });
      else openAnnotationCenter(ctx);
    }
  }));
  return { ready: true, total: ctx.config.showCompleted ? data.inbox + data.archived : data.inbox, items, due: data.due };
}

function loadWechatInsights(ctx: WidgetContext<InsightsConfig>, doc: DuoweiDoc | null): SourceResult {
  if (!doc) return { ready: false, total: 0, items: [] };
  const fields = {
    title: findField(doc, "fld_w2o_title", ["标题"]),
    content: findField(doc, "fld_w2o_content", ["内容"]),
    transcript: findField(doc, "fld_w2o_transcript", ["语音转写"]),
    type: findField(doc, "fld_w2o_type", ["消息类型"]),
    received: findField(doc, "fld_w2o_received", ["接收时间"]),
    sender: findField(doc, "fld_w2o_sender", ["发送者"]),
    status: findField(doc, "fld_w2o_status", ["状态"]),
    note: findField(doc, "fld_w2o_note", ["笔记"])
  };
  const done = new Set(["已整理", "已完成", "完成", "已归档", "归档", "done", "archived"]);
  const items: InsightItem[] = [];
  for (const record of doc.records) {
    const status = fields.status ? valueText(fields.status, record.values[fields.status.id]) : "";
    if (!ctx.config.showCompleted && done.has(status.toLowerCase())) continue;
    const content = fields.content ? valueText(fields.content, record.values[fields.content.id]) : "";
    const transcript = fields.transcript ? valueText(fields.transcript, record.values[fields.transcript.id]) : "";
    const received = fields.received ? parseTime(record.values[fields.received.id]) : 0;
    const note = fields.note ? cleanLink(valueText(fields.note, record.values[fields.note.id])) : "";
    items.push({
      id: "wechat:" + record.id,
      source: "wechat",
      title: (fields.title ? valueText(fields.title, record.values[fields.title.id]) : "") || content || "微信消息",
      summary: transcript || content,
      labels: [
        fields.type ? valueText(fields.type, record.values[fields.type.id]) : "",
        fields.sender ? valueText(fields.sender, record.values[fields.sender.id]) : "",
        status
      ].filter(Boolean),
      time: received || parseTime(record.updatedAt),
      rank: 2,
      sortValue: -(received || parseTime(record.updatedAt)),
      open: () => {
        if (note) void ctx.app.workspace.openLinkText(note, "", false);
        else void ctx.openPath(ctx.config.wechatPath);
      }
    });
  }
  items.sort((a, b) => a.sortValue - b.sortValue);
  return { ready: true, total: items.length, items };
}

function runWechatCommand(ctx: WidgetContext<InsightsConfig>, command: "sync" | "open-inbox"): void {
  if (runCommand(ctx.app, "wechat2ob:" + command)) return;
  const names = command === "sync" ? ["立即同步微信消息", "同步微信"] : ["打开收件箱", "open inbox"];
  const id = findCommandId(ctx.app, { pluginId: "wechat2ob", nameIncludes: names });
  if (!id || !runCommand(ctx.app, id)) new Notice("未找到 WeChat2Ob 命令，请确认插件已启用");
}

function renderStat(container: HTMLElement, source: ItemSource, value: number, suffix = ""): HTMLElement {
  const meta = SOURCE_META[source];
  const tile = container.createDiv({ cls: "hp-insight-stat hp-insight-" + meta.tone });
  const top = tile.createDiv({ cls: "hp-insight-stat-top" });
  setIcon(top.createSpan(), meta.icon);
  top.createSpan({ text: meta.label });
  tile.createDiv({ cls: "hp-insight-stat-value", text: String(value) + suffix });
  return tile;
}

export const insightsWidget: WidgetDefinition<InsightsConfig> = {
  kind: "insights",
  name: "聚合信息流（可选）",
  description: "把待办与日程、批注与复习、微信收件三个来源合成一条信息流；只想要一张卡片时用它，否则用上面三个独立组件。",
  icon: "inbox",
  accent: "#7c3aed",
  defaultSize: { w: 12, h: 7 },
  defaultConfig: () => ({ ...DEFAULTS, duoweiSummaryFields: [], duoweiDoneValues: [...DEFAULTS.duoweiDoneValues] }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    config.source = (["all", "duowei", "annotations", "wechat"] as SourceKey[]).includes(config.source) ? config.source : "all";
    config.duoweiSummaryFields = toStringList(config.duoweiSummaryFields, 6);
    config.duoweiDoneValues = toStringList(config.duoweiDoneValues, 30);
    config.limit = clampInt(config.limit, 3, 50, DEFAULTS.limit);
    return config;
  },

  async render(body, ctx) {
    const { config } = ctx;
    const notReady: SourceResult = { ready: false, total: 0, items: [] };
    const [duoweiResult, annotationData, wechatJournal, wechatDoc] = await Promise.all([
      config.showDuowei ? loadDigestInsights(ctx) : Promise.resolve(notReady),
      config.showAnnotations ? loadAnnotationInsights(ctx) : Promise.resolve({ ...notReady, due: 0 }),
      config.showWechat ? loadWechatJournalInsights(ctx) : Promise.resolve(null),
      config.showWechat && config.wechatPath.trim() ? loadDuowei(ctx.app, config.wechatPath) : Promise.resolve(null)
    ]);
    if (!ctx.isAlive()) return;
    const results: Record<ItemSource, SourceResult> = {
      duowei: duoweiResult,
      annotations: annotationData,
      wechat: config.showWechat ? (wechatJournal ?? loadWechatInsights(ctx, wechatDoc)) : notReady
    };
    const enabled = (["duowei", "annotations", "wechat"] as ItemSource[]).filter((source) => sourceEnabled(config, source));
    const ready = enabled.filter((source) => results[source].ready).length;
    ctx.setSubtitle(ready + "/" + enabled.length + " 个来源就绪");
    ctx.registerInterval(() => ctx.rerender(), 5 * 60 * 1000);

    const wrap = body.createDiv({ cls: "hp-insights" });
    const stats = wrap.createDiv({ cls: "hp-insight-stats" });
    for (const source of enabled) {
      const suffix = source === "annotations" && results.annotations.due ? " · " + results.annotations.due + " 待复习" : "";
      const tile = renderStat(stats, source, results[source].total, suffix);
      tile.toggleClass("is-active", config.source === source);
      tile.addEventListener("click", () => void ctx.saveConfig({ source: config.source === source ? "all" : source }).then(() => ctx.rerender()));
    }

    const toolbar = wrap.createDiv({ cls: "hp-insight-toolbar" });
    const all = toolbar.createEl("button", { cls: "hp-pill" + (config.source === "all" ? " is-active" : ""), text: "全部重点", attr: { type: "button" } });
    all.addEventListener("click", () => void ctx.saveConfig({ source: "all" }).then(() => ctx.rerender()));
    if (config.showWechat) {
      const sync = toolbar.createEl("button", { cls: "hp-pill", text: "同步微信", attr: { type: "button" } });
      sync.addEventListener("click", () => runWechatCommand(ctx, "sync"));
    }
    if (config.showAnnotations) {
      const center = toolbar.createEl("button", { cls: "hp-pill", text: "批注中心", attr: { type: "button" } });
      center.addEventListener("click", () => openAnnotationCenter(ctx));
    }

    let items = enabled.flatMap((source) => results[source].items);
    if (config.source !== "all") items = items.filter((item) => item.source === config.source);
    items.sort((a, b) => a.rank - b.rank || a.sortValue - b.sortValue);
    items = items.slice(0, config.limit);
    const list = wrap.createDiv({ cls: "hp-insight-list" });
    if (items.length === 0) {
      const missing = enabled.filter((source) => !results[source].ready).map((source) => SOURCE_META[source].label);
      list.createDiv({ cls: "hp-empty", text: missing.length ? "暂无信息；未就绪：" + missing.join("、") : "当前没有需要关注的信息" });
      return;
    }
    for (const item of items) {
      const meta = SOURCE_META[item.source];
      const row = list.createDiv({ cls: "hp-insight-item hp-insight-" + meta.tone + " is-clickable" });
      const icon = row.createDiv({ cls: "hp-insight-icon", attr: { title: meta.label } });
      setIcon(icon, meta.icon);
      const content = row.createDiv({ cls: "hp-insight-content" });
      const heading = content.createDiv({ cls: "hp-insight-heading" });
      heading.createSpan({ cls: "hp-insight-source", text: meta.label });
      heading.createSpan({ cls: "hp-insight-title", text: item.title });
      if (item.summary && item.summary !== item.title) content.createDiv({ cls: "hp-insight-summary", text: item.summary });
      const foot = content.createDiv({ cls: "hp-insight-meta" });
      for (const label of item.labels.slice(0, 4)) foot.createSpan({ text: label });
      if (item.time) foot.createSpan({ cls: "hp-insight-time", text: formatRelativeTime(item.time) });
      row.addEventListener("click", (event) => item.open(event));
    }
  },

  renderSettings(container, ctx) {
    const { config } = ctx;
    addSectionHeading(container, "显示来源");
    new Setting(container).setName("多维表格信息").setDesc("只提取有效记录，不嵌入表格界面。")
      .addToggle((toggle) => toggle.setValue(config.showDuowei).onChange((value) => ctx.update({ showDuowei: value })));
    new Setting(container).setName("批注中心信息")
      .addToggle((toggle) => toggle.setValue(config.showAnnotations).onChange((value) => ctx.update({ showAnnotations: value })));
    new Setting(container).setName("WeChat2Ob 信息")
      .addToggle((toggle) => toggle.setValue(config.showWechat).onChange((value) => ctx.update({ showWechat: value })));
    new Setting(container).setName("显示已完成 / 已归档")
      .addToggle((toggle) => toggle.setValue(config.showCompleted).onChange((value) => ctx.update({ showCompleted: value })));
    addNumberSetting(container, { name: "信息条数", value: config.limit, min: 3, max: 50, onChange: (value) => ctx.update({ limit: value }) });

    addSectionHeading(container, "多维表格 · 有效信息");
    addPathSetting(container, ctx.app, {
      name: "表格范围",
      desc: "留空扫描库内全部 .duowei（自动跳过备份表和微信收件箱表）；也可指定一张表或一个文件夹。提取逾期 / 今天 / 即将到期 / 进行中 / 最近更新的记录。",
      value: config.duoweiPath,
      placeholder: "留空 = 全库",
      suggest: { files: true, folders: true, extensions: ["duowei"] },
      onChange: (value) => ctx.update({ duoweiPath: value })
    });
    addTextareaSetting(container, {
      name: "完成状态",
      desc: "命中这些状态的记录默认不在首页出现。",
      value: config.duoweiDoneValues.join("\n"),
      rows: 4,
      onChange: (value) => ctx.update({ duoweiDoneValues: toStringList(value, 30) })
    });

    addSectionHeading(container, "批注中心");
    new Setting(container).setName("批注插件 id")
      .addText((text) => text.setValue(config.annotationPluginId).onChange((value) => ctx.update({ annotationPluginId: value.trim() })));
    addPathSetting(container, ctx.app, { name: "批注中心数据目录", value: config.annotationCenterFolder, suggest: { folders: true }, onChange: (value) => ctx.update({ annotationCenterFolder: value }) });
    addPathSetting(container, ctx.app, { name: "原文批注目录", value: config.annotationMdSourceFolder, suggest: { folders: true }, onChange: (value) => ctx.update({ annotationMdSourceFolder: value }) });
    addPathSetting(container, ctx.app, { name: "收藏卡片目录", value: config.annotationCardsFolder, suggest: { folders: true }, onChange: (value) => ctx.update({ annotationCardsFolder: value }) });

    addSectionHeading(container, "WeChat2Ob");
    addPathSetting(container, ctx.app, {
      name: "微信信息源",
      desc: "优先读取 WeChat2Ob 的同步日志（含语音转写、附件、所在日记）；读不到时才从这张收件箱表格提取。",
      value: config.wechatPath,
      placeholder: "WeChat2Ob/微信收件箱.duowei",
      suggest: { files: true, extensions: ["duowei"] },
      onChange: (value) => ctx.update({ wechatPath: value })
    });
  }
};
