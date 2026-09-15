import { App, Notice, Setting, TFile, normalizePath, setIcon } from "obsidian";
import { formatRelativeTime, todayIso } from "../utils/date";
import { findCommandId, readJsonFile, readPluginData, resourceUrl, runCommand } from "../utils/plugins";
import { addNumberSetting, addPathSetting, addSectionHeading } from "../ui/settingHelpers";
import { renderEmpty, renderKpi } from "../ui/dom";
import { WidgetContext, WidgetDefinition, clampInt, normalizeWith } from "./types";
import { loadDoc, type DuoweiDoc, type DuoweiField } from "./duoweiCore";

/**
 * 微信收件：两种来源
 *   - duowei：多维表格插件内置的「个人微信收件箱」（一条消息一行的 .duowei 表，设置在其 data.json 的 weixinInbox）。
 *   - wechat2ob：WeChat2Ob 插件的私有同步日志（state/）。
 * auto 模式优先前者（其表存在时），否则后者。
 */

export interface WechatConfig extends Record<string, unknown> {
  source: "auto" | "duowei" | "wechat2ob";
  /** 多维表格插件 id；内置微信收件箱的表路径 / 字段映射从它的 data.json 读取。 */
  duoweiPluginId: string;
  /** 留空自动读多维表格设置里的 weixinInbox.tablePath。 */
  duoweiTablePath: string;
  /** WeChat2Ob 插件 id。 */
  pluginId: string;
  /** 留空自动使用 <configDir>/plugins/<pluginId>/state。 */
  stateFolder: string;
  showStats: boolean;
  showThumbs: boolean;
  /** 只显示最近 N 天（0 = 不限）。 */
  days: number;
  limit: number;
  /** 只显示这些类型（空 = 全部）：text / image / voice / video / file / mixed。 */
  kinds: string[];
  /** 多维表格来源：只显示待整理。 */
  pendingOnly: boolean;
}

const DEFAULTS: WechatConfig = {
  source: "auto",
  duoweiPluginId: "duowei-table-pro",
  duoweiTablePath: "",
  pluginId: "wechat2ob",
  stateFolder: "",
  showStats: true,
  showThumbs: true,
  days: 14,
  limit: 8,
  kinds: [],
  pendingOnly: false
};

const KIND_META: Record<string, { label: string; icon: string }> = {
  text: { label: "文字", icon: "message-square" },
  image: { label: "图片", icon: "image" },
  voice: { label: "语音", icon: "mic" },
  video: { label: "视频", icon: "video" },
  file: { label: "文件", icon: "paperclip" },
  mixed: { label: "混合", icon: "layers" },
  unknown: { label: "其他", icon: "message-circle" }
};

const KIND_BY_LABEL: Record<string, string> = { 文字: "text", 图片: "image", 语音: "voice", 文件: "file", 视频: "video", 混合: "mixed", 其他: "unknown" };
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"]);

export interface WechatItem {
  key: string;
  kind: string;
  text: string;
  receivedAt: number;
  notePath?: string;
  tablePath?: string;
  attachments: Array<{ path: string; kind: string; mimeType: string }>;
  image?: string;
  /** 多维表格收件箱：记录 id / 状态。 */
  recordId?: string;
  status?: string;
  pending?: boolean;
}

export interface WechatData {
  ready: boolean;
  source: "duowei" | "wechat2ob";
  items: WechatItem[];
  today: number;
  week: number;
  attachments: number;
  /** “待整理”条数；来源没有状态概念时为 null。 */
  pending: number | null;
  todayNotePath: string;
  tablePath: string;
  inboxRoot: string;
  /** 多维表格收件箱：状态字段与选项 id，供首页一键标记。 */
  duowei?: { file: TFile; statusFieldId: string; pendingOptionId: string; doneOptionId: string; kanbanViewId?: string };
}

export async function loadWechat(app: App, config: WechatConfig): Promise<WechatData> {
  if (config.source !== "wechat2ob") {
    const inbox = await loadDuoweiInbox(app, config);
    if (inbox.ready || config.source === "duowei") return inbox;
  }
  return loadWechat2ob(app, config);
}

// ---- 多维表格内置微信收件箱 --------------------------------------------------

interface InboxFields {
  title?: DuoweiField;
  content?: DuoweiField;
  type?: DuoweiField;
  attachment?: DuoweiField;
  transcript?: DuoweiField;
  receivedAt?: DuoweiField;
  status?: DuoweiField;
}

/** 优先用插件保存的 fieldMap，缺失时按约定字段名 / 类型识别（兼容 WeChat2Ob 生成的表）。 */
function resolveInboxFields(doc: DuoweiDoc, saved: Record<string, unknown> | undefined): InboxFields {
  const byId = (key: string): DuoweiField | undefined => {
    const id = saved?.[key];
    return typeof id === "string" ? doc.fields.find((field) => field.id === id) : undefined;
  };
  const byName = (names: string[], types: string[]): DuoweiField | undefined =>
    doc.fields.find((field) => names.includes(field.name.trim()) && types.includes(field.type))
    ?? doc.fields.find((field) => types.includes(field.type) && names.some((name) => field.name.includes(name)));
  return {
    title: byId("titleFieldId") ?? byName(["标题"], ["text"]) ?? doc.fields.find((field) => field.id === doc.titleFieldId),
    content: byId("contentFieldId") ?? byName(["内容", "正文"], ["longText", "text"]),
    type: byId("typeFieldId") ?? byName(["类型", "消息类型"], ["singleSelect", "text"]),
    attachment: byId("attachmentFieldId") ?? byName(["附件"], ["attachment"]),
    transcript: byId("transcriptFieldId") ?? byName(["语音转写", "转写"], ["longText", "text"]),
    receivedAt: byId("receivedAtFieldId") ?? byName(["接收时间", "时间"], ["dateTime", "date", "createdTime"]),
    status: byId("statusFieldId") ?? byName(["状态"], ["singleSelect"])
  };
}

function optionText(value: unknown, field: DuoweiField | undefined): string {
  if (!field || value === undefined || value === null || value === "") return "";
  if (field.options?.length) {
    const option = field.options.find((item) => item.id === value || item.name === value);
    return option?.name ?? String(value);
  }
  return Array.isArray(value) ? value.map((item) => String(item)).join(" ") : String(value);
}

function stripLink(value: unknown): string {
  const text = String(value ?? "").trim();
  const inner = text.startsWith("![[") ? text.slice(3) : text.startsWith("[[") ? text.slice(2) : text;
  return inner.replace(/\]\]$/, "").split("|")[0].split("#")[0];
}

export async function loadDuoweiInbox(app: App, config: WechatConfig): Promise<WechatData> {
  const empty: WechatData = { ready: false, source: "duowei", items: [], today: 0, week: 0, attachments: 0, pending: null, todayNotePath: "", tablePath: "", inboxRoot: "" };
  const raw = await readPluginData(app, config.duoweiPluginId);
  const settings = (raw?.weixinInbox && typeof raw.weixinInbox === "object" ? raw.weixinInbox : {}) as Record<string, unknown>;
  const savedMap = settings.fieldMap && typeof settings.fieldMap === "object" ? (settings.fieldMap as Record<string, unknown>) : undefined;
  const tablePath = normalizePath(config.duoweiTablePath.trim() || (typeof settings.tablePath === "string" && settings.tablePath ? settings.tablePath : "多维表格/微信收件箱.duowei"));
  const file = app.vault.getAbstractFileByPath(tablePath);
  if (!(file instanceof TFile)) return { ...empty, tablePath };
  const doc = await loadDoc(app, file.path);
  if (!doc) return { ...empty, tablePath };
  const fields = resolveInboxFields(doc, savedMap);
  if (!fields.receivedAt) return { ...empty, tablePath };
  const pendingOptionId = (typeof savedMap?.pendingStatusOptionId === "string" ? savedMap.pendingStatusOptionId : "")
    || fields.status?.options?.find((option) => option.name === "待整理")?.id
    || "";
  const doneOptionId = fields.status?.options?.find((option) => option.name === "已整理")?.id ?? "";

  const since = config.days > 0 ? Date.now() - config.days * 86400000 : 0;
  const weekSince = Date.now() - 7 * 86400000;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  let todayCount = 0;
  let weekCount = 0;
  let attachmentCount = 0;
  let pending = 0;
  const items: WechatItem[] = [];
  for (const record of doc.records) {
    const receivedAt = Date.parse(String(record.values[fields.receivedAt.id] ?? "")) || Date.parse(record.updatedAt ?? "") || 0;
    if (!receivedAt) continue;
    if (receivedAt >= todayStart.getTime()) todayCount += 1;
    if (receivedAt >= weekSince) weekCount += 1;
    const attachmentsRaw = fields.attachment ? record.values[fields.attachment.id] : undefined;
    const attachmentPaths = (Array.isArray(attachmentsRaw) ? attachmentsRaw : attachmentsRaw ? [attachmentsRaw] : []).map(stripLink).filter(Boolean);
    attachmentCount += attachmentPaths.length;
    const statusValue = fields.status ? record.values[fields.status.id] : undefined;
    const isPending = Boolean(pendingOptionId) && statusValue === pendingOptionId;
    if (isPending) pending += 1;
    if (since && receivedAt < since) continue;
    if (config.pendingOnly && fields.status && !isPending) continue;
    const typeLabel = optionText(fields.type ? record.values[fields.type.id] : undefined, fields.type);
    const kind = KIND_BY_LABEL[typeLabel] ?? (typeLabel in KIND_META ? typeLabel : "unknown");
    if (config.kinds.length > 0 && !config.kinds.includes(kind)) continue;
    const attachments = attachmentPaths.map((path) => {
      const extension = path.split(".").pop()?.toLowerCase() ?? "";
      const mimeType = IMAGE_EXTENSIONS.has(extension) ? `image/${extension}` : "";
      return { path, kind: mimeType ? "image" : "file", mimeType };
    });
    const text = (optionText(fields.content ? record.values[fields.content.id] : undefined, fields.content)
      || optionText(fields.transcript ? record.values[fields.transcript.id] : undefined, fields.transcript)
      || optionText(fields.title ? record.values[fields.title.id] : undefined, fields.title)
      || (attachments.length > 0 ? `[${KIND_META[kind]?.label ?? "附件"}]` : "（空消息）")).replace(/\s+/g, " ").slice(0, 200);
    items.push({
      key: record.id,
      kind,
      text,
      receivedAt,
      tablePath: file.path,
      notePath: record.notePath ?? undefined,
      attachments,
      image: attachments.find((attachment) => attachment.mimeType)?.path,
      recordId: record.id,
      status: optionText(statusValue, fields.status),
      pending: isPending
    });
  }
  items.sort((a, b) => b.receivedAt - a.receivedAt);
  return {
    ready: true,
    source: "duowei",
    items: items.slice(0, config.limit),
    today: todayCount,
    week: weekCount,
    attachments: attachmentCount,
    pending: fields.status ? pending : null,
    todayNotePath: "",
    tablePath: file.path,
    inboxRoot: file.parent?.path ?? "",
    duowei: fields.status
      ? { file, statusFieldId: fields.status.id, pendingOptionId, doneOptionId, kanbanViewId: doc.views?.find((view) => view.type === "kanban")?.id }
      : undefined
  };
}

/** 多维表格公开 api（≥ 1.4.0）：有则可定位记录 / 标记已整理；没有则退化为打开表格文件。 */
interface DuoweiApiLike {
  openView(file: TFile, viewId?: string, recordId?: string): Promise<void>;
  commit(file: TFile, operations: Array<{ type: "set_value"; recordId: string; fieldId: string; value: unknown }>, source?: unknown): Promise<{ changed: boolean }>;
  canEdit(): boolean;
}

function duoweiApi(app: App, pluginId: string): DuoweiApiLike | null {
  const plugins = (app as App & { plugins?: { plugins?: Record<string, { api?: unknown }> } }).plugins?.plugins;
  const api = plugins?.[pluginId]?.api as Partial<DuoweiApiLike> | undefined;
  return api && typeof api.openView === "function" && typeof api.commit === "function" ? (api as DuoweiApiLike) : null;
}

// ---- WeChat2Ob 同步日志 ------------------------------------------------------

interface Journal {
  format?: number;
  key?: string;
  message?: { kind?: string; title?: string; content?: string; transcript?: string; receivedAt?: string; senderId?: string };
  attachments?: Array<{ id?: string; path?: string; kind?: string; mimeType?: string }>;
  receipts?: Record<string, { path?: string; at?: string }>;
}

const journalCache = new Map<string, { mtime: number; journal: Journal | null }>();

interface Wechat2obSettings {
  root: string;
  duowei: boolean;
  noteMode: "daily" | "file";
  dailyFolder: string;
  fixedNotePath: string;
  duoweiPath: string;
  duoweiMode: "managed" | "mapped";
  duoweiFieldMap: Record<string, string>;
}

function wechat2obSettings(raw: Record<string, unknown> | null): Wechat2obSettings {
  const str = (key: string, fallback: string): string => (typeof raw?.[key] === "string" ? String(raw?.[key]).trim() : fallback);
  const map = raw?.duoweiFieldMap;
  return {
    root: str("root", "WeChat2Ob"),
    duowei: raw?.duowei === true,
    noteMode: raw?.noteMode === "file" ? "file" : "daily",
    dailyFolder: str("dailyFolder", "日记"),
    fixedNotePath: str("fixedNotePath", "微信收件箱.md"),
    duoweiPath: str("duoweiPath", ""),
    duoweiMode: raw?.duoweiMode === "mapped" ? "mapped" : "managed",
    duoweiFieldMap: map && typeof map === "object" ? (map as Record<string, string>) : {}
  };
}

async function readJournals(app: App, stateFolder: string): Promise<Journal[]> {
  const adapter = app.vault.adapter;
  if (!(await adapter.exists(stateFolder))) return [];
  const streams = (await adapter.list(stateFolder)).folders.filter((folder) => /\/[a-f\d]{64}$/i.test(folder));
  const journals: Journal[] = [];
  for (const stream of streams) {
    const files = (await adapter.list(stream)).files.filter((file) => /\/[a-f\d]{64}\.json$/i.test(file));
    for (const file of files) {
      let mtime = 0;
      try {
        mtime = (await adapter.stat(file))?.mtime ?? 0;
      } catch {
        mtime = 0;
      }
      const cached = journalCache.get(file);
      if (cached && cached.mtime === mtime && mtime > 0) {
        if (cached.journal) journals.push(cached.journal);
        continue;
      }
      const journal = await readJsonFile<Journal>(app, file);
      const valid = journal && journal.format === 1 && journal.message && typeof journal.message.receivedAt === "string" ? journal : null;
      journalCache.set(file, { mtime, journal: valid });
      if (valid) journals.push(valid);
    }
  }
  return journals;
}

function summarize(journal: Journal): string {
  const message = journal.message ?? {};
  const text = (message.content ?? "").trim() || (message.transcript ?? "").trim() || (message.title ?? "").trim();
  if (text) return text.replace(/\s+/g, " ").slice(0, 200);
  const kinds = (journal.attachments ?? []).map((attachment) => KIND_META[attachment.kind ?? ""]?.label ?? attachment.kind ?? "附件");
  return kinds.length > 0 ? `[${kinds.join(" / ")}]` : "（空消息）";
}

async function countWechat2obPending(app: App, settings: Wechat2obSettings): Promise<{ pending: number | null; tablePath: string }> {
  const tablePath = settings.duoweiPath || `${settings.root}/微信收件箱.duowei`;
  if (!settings.duowei) return { pending: null, tablePath };
  const doc = await loadDoc(app, normalizePath(tablePath));
  if (!doc) return { pending: null, tablePath };
  const statusId = settings.duoweiMode === "mapped" ? settings.duoweiFieldMap.status : "fld_w2o_status";
  if (!statusId) return { pending: null, tablePath };
  const field = doc.fields.find((item) => item.id === statusId);
  if (!field) return { pending: null, tablePath };
  const pendingOption = field.options?.find((option) => option.name === "待整理")?.id;
  let pending = 0;
  for (const record of doc.records) {
    const value = record.values[statusId];
    const values = Array.isArray(value) ? value : [value];
    if (values.some((item) => item === "待整理" || (pendingOption && item === pendingOption))) pending += 1;
  }
  return { pending, tablePath };
}

export async function loadWechat2ob(app: App, config: WechatConfig): Promise<WechatData> {
  const raw = await readPluginData(app, config.pluginId);
  const settings = wechat2obSettings(raw);
  const stateFolder = normalizePath(config.stateFolder.trim() || `${app.vault.configDir}/plugins/${config.pluginId}/state`);
  const journals = await readJournals(app, stateFolder);
  const today = todayIso();
  const todayNotePath = settings.noteMode === "file"
    ? settings.fixedNotePath
    : `${settings.dailyFolder ? `${settings.dailyFolder}/` : ""}${today}.md`;
  const empty: WechatData = { ready: false, source: "wechat2ob", items: [], today: 0, week: 0, attachments: 0, pending: null, todayNotePath, tablePath: "", inboxRoot: settings.root };
  if (!raw && journals.length === 0) return empty;

  const since = config.days > 0 ? Date.now() - config.days * 86400000 : 0;
  const weekSince = Date.now() - 7 * 86400000;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  let todayCount = 0;
  let weekCount = 0;
  let attachmentCount = 0;
  const items: WechatItem[] = [];
  for (const journal of journals) {
    const receivedAt = Date.parse(journal.message?.receivedAt ?? "");
    if (!Number.isFinite(receivedAt)) continue;
    if (receivedAt >= todayStart.getTime()) todayCount += 1;
    if (receivedAt >= weekSince) weekCount += 1;
    attachmentCount += journal.attachments?.length ?? 0;
    if (since && receivedAt < since) continue;
    const kind = journal.message?.kind ?? "unknown";
    if (config.kinds.length > 0 && !config.kinds.includes(kind)) continue;
    const receipts = Object.entries(journal.receipts ?? {});
    const notePath = receipts.find(([key, receipt]) => key.startsWith("notes:") && receipt.path?.endsWith(".md"))?.[1].path;
    const tablePath = receipts.find(([key, receipt]) => key.startsWith("duowei:") && receipt.path?.endsWith(".duowei"))?.[1].path;
    const attachments = (journal.attachments ?? [])
      .filter((attachment) => typeof attachment.path === "string")
      .map((attachment) => ({ path: attachment.path as string, kind: attachment.kind ?? "", mimeType: attachment.mimeType ?? "" }));
    const image = attachments.find((attachment) => attachment.mimeType.startsWith("image/"))?.path;
    items.push({ key: journal.key ?? String(receivedAt), kind, text: summarize(journal), receivedAt, notePath, tablePath, attachments, image });
  }
  items.sort((a, b) => b.receivedAt - a.receivedAt);
  const { pending, tablePath } = await countWechat2obPending(app, settings);
  return {
    ready: true,
    source: "wechat2ob",
    items: items.slice(0, config.limit),
    today: todayCount,
    week: weekCount,
    attachments: attachmentCount,
    pending,
    todayNotePath,
    tablePath,
    inboxRoot: settings.root
  };
}

// ---- 动作 ------------------------------------------------------------------

function runWechat2obCommand(ctx: WidgetContext<WechatConfig>, suffix: string, names: string[]): void {
  if (runCommand(ctx.app, `${ctx.config.pluginId}:${suffix}`)) return;
  const id = findCommandId(ctx.app, { pluginId: ctx.config.pluginId, nameIncludes: names });
  if (!id || !runCommand(ctx.app, id)) new Notice("未找到 WeChat2Ob 的命令，请确认插件已启用");
}

function runDuoweiCommand(ctx: WidgetContext<WechatConfig>, suffix: string, names: string[]): void {
  if (runCommand(ctx.app, `${ctx.config.duoweiPluginId}:${suffix}`)) return;
  const id = findCommandId(ctx.app, { pluginId: ctx.config.duoweiPluginId, nameIncludes: names });
  if (!id || !runCommand(ctx.app, id)) new Notice("未找到多维表格的微信收件箱命令，请确认插件已启用");
}

function sync(ctx: WidgetContext<WechatConfig>, data: WechatData): void {
  if (data.source === "duowei") runDuoweiCommand(ctx, "sync-weixin-inbox", ["同步个人微信收件箱", "微信收件箱"]);
  else runWechat2obCommand(ctx, "sync", ["同步微信", "sync"]);
}

async function openItem(ctx: WidgetContext<WechatConfig>, data: WechatData, item: WechatItem, event: MouseEvent): Promise<void> {
  if (item.notePath) {
    await ctx.openPath(item.notePath, { event });
    return;
  }
  if (data.source === "duowei" && data.duowei && item.recordId) {
    const api = duoweiApi(ctx.app, ctx.config.duoweiPluginId);
    if (api) {
      await api.openView(data.duowei.file, data.duowei.kanbanViewId, item.recordId);
      return;
    }
    await ctx.openPath(data.tablePath, { event });
    return;
  }
  if (item.attachments[0]) {
    await ctx.openPath(item.attachments[0].path, { event });
    return;
  }
  runWechat2obCommand(ctx, "open-inbox", ["打开收件箱", "inbox"]);
}

/** 多维表格收件箱：把一条消息标为“已整理”（走多维表格的 MutationService）。 */
async function markDone(ctx: WidgetContext<WechatConfig>, data: WechatData, item: WechatItem): Promise<void> {
  const api = duoweiApi(ctx.app, ctx.config.duoweiPluginId);
  if (!api || !data.duowei || !item.recordId || !data.duowei.doneOptionId) return;
  try {
    await api.commit(data.duowei.file, [{ type: "set_value", recordId: item.recordId, fieldId: data.duowei.statusFieldId, value: data.duowei.doneOptionId }], { type: "user", surface: "command" });
    ctx.rerender();
  } catch (error) {
    new Notice(error instanceof Error ? error.message : "标记失败", 4000);
  }
}

// ---- 组件 ------------------------------------------------------------------

export const wechatWidget: WidgetDefinition<WechatConfig> = {
  kind: "wechat",
  name: "微信收件",
  description: "微信消息收件箱：今日 / 本周条数、待整理数、最近消息（文字 / 语音转写 / 图片缩略图）。自动识别多维表格内置的个人微信收件箱或 WeChat2Ob，可一键同步、标记已整理。",
  icon: "message-circle",
  accent: "#16a34a",
  defaultSize: { w: 6, h: 7 },
  defaultConfig: () => ({ ...DEFAULTS, kinds: [] }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    config.source = config.source === "duowei" || config.source === "wechat2ob" ? config.source : "auto";
    config.duoweiPluginId = config.duoweiPluginId.trim() || DEFAULTS.duoweiPluginId;
    config.pluginId = config.pluginId.trim() || DEFAULTS.pluginId;
    config.days = clampInt(config.days, 0, 365, DEFAULTS.days);
    config.limit = clampInt(config.limit, 1, 50, DEFAULTS.limit);
    config.kinds = (Array.isArray(config.kinds) ? config.kinds : []).map((kind) => String(kind)).filter((kind) => kind in KIND_META);
    return config;
  },

  async render(body, ctx) {
    const { app, config } = ctx;
    const data = await loadWechat(app, config);
    if (!ctx.isAlive()) return;
    // WeChat2Ob 的日志在 .obsidian 下没有库事件；定时刷新兜底（表格来源靠 .duowei 变更事件即时刷新）。
    ctx.registerInterval(() => ctx.rerender(), 3 * 60 * 1000);
    if (!data.ready) {
      ctx.setSubtitle("未找到数据");
      renderEmpty(body, {
        icon: "message-circle",
        text: config.source === "wechat2ob"
          ? "未读取到 WeChat2Ob 数据：请确认已安装并同步过消息，或在设置中指定 state 目录。"
          : "未找到微信收件箱：请在多维表格里运行「创建个人微信收件箱表格」并同步，或安装 WeChat2Ob。",
        action: config.source === "wechat2ob"
          ? { label: "立即同步", onClick: () => runWechat2obCommand(ctx, "sync", ["同步微信", "sync"]) }
          : { label: "创建微信收件箱表格", onClick: () => runDuoweiCommand(ctx, "create-weixin-inbox-table", ["创建个人微信收件箱"]) }
      });
      return;
    }
    const api = data.source === "duowei" ? duoweiApi(app, config.duoweiPluginId) : null;
    ctx.setSubtitle(`今日 ${data.today} · 本周 ${data.week}${data.pending !== null ? ` · 待整理 ${data.pending}` : ""}`);
    if (data.source === "wechat2ob") {
      const noteFile = app.vault.getAbstractFileByPath(normalizePath(data.todayNotePath));
      if (noteFile instanceof TFile) ctx.addHeaderAction("calendar-days", `打开今日收件笔记（${data.todayNotePath}）`, (event) => void ctx.openPath(data.todayNotePath, { event }));
      ctx.addHeaderAction("inbox", "打开收件箱", () => runWechat2obCommand(ctx, "open-inbox", ["打开收件箱", "inbox"]));
    }
    if (data.tablePath && app.vault.getAbstractFileByPath(normalizePath(data.tablePath)) instanceof TFile) {
      ctx.addHeaderAction("table-2", `打开收件箱表格（${data.tablePath}）`, (event) => {
        if (api && data.duowei) void api.openView(data.duowei.file, data.duowei.kanbanViewId);
        else void ctx.openPath(data.tablePath, { event });
      });
    }
    ctx.addHeaderAction("refresh-cw", "立即同步微信消息", () => sync(ctx, data));
    const wrap = body.createDiv({ cls: "hp-wechat" });

    if (config.showStats) {
      const stats = wrap.createDiv({ cls: "hp-kpis" });
      renderKpi(stats, { value: data.today, label: "今日消息", tone: 1, icon: "message-square" });
      renderKpi(stats, { value: data.week, label: "本周消息", tone: 0, icon: "calendar-range" });
      if (data.pending !== null) {
        renderKpi(stats, {
          value: data.pending,
          label: "待整理",
          tone: 2,
          icon: "list-todo",
          onClick: data.source === "duowei" ? () => void ctx.saveConfig({ pendingOnly: !config.pendingOnly }).then(() => ctx.rerender()) : undefined,
          title: data.source === "duowei" ? (config.pendingOnly ? "当前只显示待整理，点击显示全部" : "点击只看待整理") : undefined
        });
      }
      renderKpi(stats, { value: data.attachments, label: "附件", tone: 3, icon: "paperclip" });
    }

    const list = wrap.createDiv({ cls: "hp-wechat-list" });
    if (data.items.length === 0) {
      renderEmpty(list, {
        icon: "message-circle-off",
        text: config.pendingOnly && data.source === "duowei" ? "没有待整理的消息，收件箱已清空" : config.days > 0 ? `最近 ${config.days} 天没有微信消息` : "还没有微信消息"
      });
      return;
    }
    const canMark = Boolean(api && api.canEdit() && data.duowei?.doneOptionId);
    for (const item of data.items) {
      const meta = KIND_META[item.kind] ?? KIND_META.unknown;
      const row = list.createDiv({ cls: `hp-wechat-item is-clickable${item.pending === false && data.source === "duowei" ? " is-done" : ""}`, attr: { title: item.notePath ?? item.status ?? "" } });
      const icon = row.createDiv({ cls: "hp-wechat-icon" });
      if (config.showThumbs && item.image) {
        icon.addClass("has-image");
        icon.createEl("img", { attr: { src: resourceUrl(app, item.image), alt: "" } });
      } else {
        setIcon(icon, meta.icon);
      }
      const content = row.createDiv({ cls: "hp-wechat-content" });
      content.createDiv({ cls: "hp-wechat-text", text: item.text });
      const line = content.createDiv({ cls: "hp-wechat-meta" });
      line.createSpan({ cls: "hp-wechat-kind", text: meta.label });
      if (item.attachments.length > 0) line.createSpan({ text: `${item.attachments.length} 个附件` });
      if (item.status) line.createSpan({ cls: `hp-wechat-status${item.pending ? " is-pending" : ""}`, text: item.status });
      if (item.notePath) line.createSpan({ cls: "hp-wechat-note", text: item.notePath.replace(/\.md$/i, "").split("/").pop() ?? "" });
      line.createSpan({ cls: "hp-wechat-time", text: formatRelativeTime(item.receivedAt) });
      if (canMark && item.pending) {
        const done = row.createEl("button", { cls: "hp-wechat-done clickable-icon", attr: { type: "button", "aria-label": "标记为已整理", title: "标记为已整理" } });
        setIcon(done, "check");
        done.addEventListener("click", (event) => {
          event.stopPropagation();
          void markDone(ctx, data, item);
        });
      }
      row.addEventListener("click", (event) => void openItem(ctx, data, item, event));
    }
  },

  renderSettings(container, ctx) {
    const { config } = ctx;
    new Setting(container).setName("消息来源")
      .setDesc("自动：多维表格内置的个人微信收件箱（表存在时）优先，否则 WeChat2Ob。")
      .addDropdown((dropdown) => dropdown
        .addOptions({ auto: "自动识别", duowei: "多维表格 · 个人微信收件箱", wechat2ob: "WeChat2Ob" })
        .setValue(config.source)
        .onChange((value) => {
          ctx.update({ source: value === "duowei" || value === "wechat2ob" ? value : "auto" });
          ctx.refresh();
        }));
    new Setting(container).setName("显示统计磁贴")
      .addToggle((toggle) => toggle.setValue(config.showStats).onChange((value) => ctx.update({ showStats: value })));
    new Setting(container).setName("图片消息显示缩略图")
      .addToggle((toggle) => toggle.setValue(config.showThumbs).onChange((value) => ctx.update({ showThumbs: value })));
    if (config.source !== "wechat2ob") {
      new Setting(container).setName("只显示待整理").setDesc("多维表格来源：状态为“待整理”的消息；点击「待整理」磁贴也可切换。")
        .addToggle((toggle) => toggle.setValue(config.pendingOnly).onChange((value) => ctx.update({ pendingOnly: value })));
    }
    addNumberSetting(container, { name: "只显示最近几天", desc: "0 表示不限。", value: config.days, min: 0, max: 365, onChange: (value) => ctx.update({ days: value }) });
    addNumberSetting(container, { name: "最多条数", value: config.limit, min: 1, max: 50, onChange: (value) => ctx.update({ limit: value }) });
    addSectionHeading(container, "消息类型（全不选 = 全部）");
    for (const [kind, meta] of Object.entries(KIND_META)) {
      if (kind === "unknown") continue;
      new Setting(container).setName(meta.label)
        .addToggle((toggle) => toggle.setValue(config.kinds.includes(kind)).onChange((value) => {
          const next = config.kinds.filter((item) => item !== kind);
          if (value) next.push(kind);
          ctx.update({ kinds: next });
        }));
    }
    if (config.source !== "wechat2ob") {
      addSectionHeading(container, "多维表格 · 个人微信收件箱");
      new Setting(container).setName("多维表格插件 id").setDesc("默认 duowei-table-pro；表路径与字段映射从它的设置读取。")
        .addText((text) => text.setValue(config.duoweiPluginId).onChange((value) => ctx.update({ duoweiPluginId: value.trim() })));
      addPathSetting(container, ctx.app, {
        name: "收件箱表格",
        desc: "留空自动读多维表格设置（默认 多维表格/微信收件箱.duowei）。",
        value: config.duoweiTablePath,
        suggest: { files: true, extensions: ["duowei"] },
        onChange: (value) => ctx.update({ duoweiTablePath: value })
      });
    }
    if (config.source !== "duowei") {
      addSectionHeading(container, "WeChat2Ob");
      new Setting(container).setName("插件 id").setDesc("默认 wechat2ob；会读取该插件 data.json 里的收件目录、日记目录与表格设置。")
        .addText((text) => text.setValue(config.pluginId).onChange((value) => ctx.update({ pluginId: value.trim() })));
      addPathSetting(container, ctx.app, {
        name: "同步日志目录",
        desc: "留空自动使用插件目录下的 state。",
        value: config.stateFolder,
        suggest: { files: false, folders: true },
        onChange: (value) => ctx.update({ stateFolder: value })
      });
    }
  }
};
