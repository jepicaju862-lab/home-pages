import { App, Notice, Setting, normalizePath, setIcon } from "obsidian";
import { formatRelativeTime } from "../utils/date";
import { basenameOf } from "../utils/vault";
import { findCommandId, readJsonFile, readPluginData, resourceUrl, runCommand } from "../utils/plugins";
import { addNumberSetting, addPathSetting, addSectionHeading } from "../ui/settingHelpers";
import { renderEmpty, renderKpi } from "../ui/dom";
import { WidgetContext, WidgetDefinition, clampInt, normalizeWith } from "./types";

export interface AnnotationsConfig extends Record<string, unknown> {
  pluginId: string;
  /** 留空时自动读取插件设置里的目录；否则按这里的路径读取。 */
  centerFolder: string;
  mdSourceFolder: string;
  cardsFolder: string;
  showStats: boolean;
  showList: boolean;
  showPreview: boolean;
  status: "all" | "inbox" | "archived";
  collection: string;
  sortBy: "updatedAt" | "createdAt";
  limit: number;
  /** 当前显示的面板：批注列表或题库复习（点击切换时记住）。 */
  panel: "annotations" | "review";
}

const DEFAULTS: AnnotationsConfig = {
  pluginId: "mobile-ink-annotation-pro",
  centerFolder: "",
  mdSourceFolder: "",
  cardsFolder: "",
  showStats: true,
  showList: true,
  showPreview: true,
  status: "inbox",
  collection: "",
  sortBy: "updatedAt",
  limit: 8,
  panel: "annotations"
};

// ---- Mobile Ink Annotation 的数据结构（只声明首页用到的字段） --------------------

interface CenterRecord {
  status?: string;
  tags?: string[];
  collectionIds?: string[];
  previewAssetPath?: string;
  cardPath?: string;
  cardPaths?: Record<string, string>;
  ocrText?: string;
  userNote?: string;
  aiSummary?: string;
  aiAnswers?: unknown[];
  linkedNotes?: string[];
  questionIds?: string[];
  savedExcerpts?: Array<{ title?: string; sourcePath?: string; originalText?: string; backlink?: string }>;
  createdAt?: number;
  updatedAt?: number;
}

interface CenterIndex {
  records?: Record<string, CenterRecord>;
  collections?: Array<{ id: string; name: string; icon?: string; color?: string }>;
}

interface MdSourceFile {
  sourcePath?: string;
  annotations?: Array<{ id: string; selectedText?: string; note?: string; kind?: string; color?: string; startLine?: number; semanticTag?: string }>;
}

interface QuestionBank {
  questions?: Record<string, QuestionRecord>;
}

interface QuestionRecord {
  id?: string; stem?: string; questionType?: string; subject?: string; tags?: string[]; difficulty?: number; verified?: boolean; answer?: string; gaps?: string[]; errorReason?: string; createdAt?: number; updatedAt?: number;
  review?: { dueAt?: number; mastered?: boolean; state?: string; lapses?: number; history?: Array<{ at?: number; undoneAt?: number }> };
  sources?: Array<{ sourceName?: string; path?: string }>;
}

interface CardsFile {
  cards?: unknown[];
}

type RecordType = "handwriting" | "text" | "md-source" | "standalone" | "collected" | "other";

const TYPE_META: Record<RecordType, { label: string; icon: string }> = {
  handwriting: { label: "手写", icon: "pen-tool" },
  text: { label: "文本", icon: "highlighter" },
  "md-source": { label: "原文", icon: "file-text" },
  standalone: { label: "手写笔记", icon: "notebook-pen" },
  collected: { label: "收藏", icon: "bookmark" },
  other: { label: "批注", icon: "sticky-note" }
};

export interface AnnotationItem {
  key: string;
  type: RecordType;
  text: string;
  sourceLabel?: string;
  /** 点击时打开的目标：库内路径或 wiki 链接内容。 */
  openTarget?: { path: string; line?: number } | { link: string };
  cardPath?: string;
  preview?: string;
  tags: string[];
  collections: string[];
  status: string;
  hasAi: boolean;
  time: number;
}

export interface AnnotationData {
  items: AnnotationItem[];
  inbox: number;
  archived: number;
  collections: Array<{ id: string; name: string; color?: string; icon?: string; count: number }>;
  questions: number;
  due: number;
  cards: number;
  /** 今天新建的批注数。 */
  todayNew: number;
  questionItems: QuestionItem[];
  newQuestions: number;
  hardQuestions: number;
  masteredQuestions: number;
  reviewedToday: number;
  ready: boolean;
}

export interface QuestionItem {
  id: string; stem: string; questionType: string; subject: string; difficulty: number; lapses: number; state: string; dueAt: number; mastered: boolean; verified: boolean; sourceLabel?: string; createdAt: number; updatedAt: number;
}

function resolveFolders(app: App, config: AnnotationsConfig, data: Record<string, unknown> | null): { center: string; mdSource: string; cards: string } {
  const base = `${app.vault.configDir}/plugins/${config.pluginId}`;
  const pick = (override: string, key: string, fallback: string): string => {
    if (override.trim()) return normalizePath(override.trim());
    const value = data?.[key];
    return normalizePath(typeof value === "string" && value.trim() ? value.trim() : `${base}/${fallback}`);
  };
  return {
    center: pick(config.centerFolder, "dataAnnotationCenterFolder", "annotation-center"),
    mdSource: pick(config.mdSourceFolder, "dataMdSourceAnnotationsFolder", "md-source-annotations"),
    cards: pick(config.cardsFolder, "dataCardFavoritesFolder", "card-favorites")
  };
}

export async function loadAnnotations(app: App, config: AnnotationsConfig): Promise<AnnotationData> {
  const pluginData = await readPluginData(app, config.pluginId);
  const folders = resolveFolders(app, config, pluginData);
  const index = await readJsonFile<CenterIndex>(app, `${folders.center}/index.json`);
  const empty: AnnotationData = { items: [], inbox: 0, archived: 0, collections: [], questions: 0, due: 0, cards: 0, todayNew: 0, questionItems: [], newQuestions: 0, hardQuestions: 0, masteredQuestions: 0, reviewedToday: 0, ready: false };
  if (!index?.records) return empty;

  // 原文批注：批注 id → 来源笔记与选中文字（文件很小，全部读取）。
  const mdSource = new Map<string, { sourcePath: string; text: string; note: string; line?: number }>();
  try {
    if (await app.vault.adapter.exists(folders.mdSource)) {
      const listing = await app.vault.adapter.list(folders.mdSource);
      for (const file of listing.files.filter((path) => path.endsWith(".md-source.json"))) {
        const parsed = await readJsonFile<MdSourceFile>(app, file);
        for (const annotation of parsed?.annotations ?? []) {
          mdSource.set(annotation.id, {
            sourcePath: parsed?.sourcePath ?? "",
            text: annotation.selectedText ?? "",
            note: annotation.note ?? "",
            line: annotation.startLine
          });
        }
      }
    }
  } catch (error) {
    console.error("Home Pages: failed to read md-source annotations", error);
  }

  const collectionsById = new Map((index.collections ?? []).map((collection) => [collection.id, collection]));
  const counts = new Map<string, number>();
  let inbox = 0;
  let archived = 0;
  let todayNew = 0;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const items: AnnotationItem[] = [];
  for (const [key, record] of Object.entries(index.records)) {
    const status = record.status ?? "inbox";
    if (status === "archived") archived += 1;
    else inbox += 1;
    if ((record.createdAt ?? 0) >= todayStart.getTime()) todayNew += 1;
    for (const id of record.collectionIds ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);

    const [prefix, ...rest] = key.split(":");
    const id = rest.join(":");
    const type: RecordType = (["handwriting", "text", "md-source", "standalone", "collected"] as RecordType[]).includes(prefix as RecordType) ? (prefix as RecordType) : "other";
    const cardPath = record.cardPath ?? Object.values(record.cardPaths ?? {}).find((path) => typeof path === "string" && path.endsWith(".md"));
    let text = (record.ocrText ?? record.userNote ?? record.aiSummary ?? "").trim();
    let sourceLabel: string | undefined;
    let openTarget: AnnotationItem["openTarget"];
    if (type === "md-source") {
      const source = mdSource.get(id);
      if (source) {
        text = text || source.text || source.note;
        sourceLabel = basenameOf(source.sourcePath);
        if (source.sourcePath) openTarget = { path: source.sourcePath, line: source.line };
      }
    } else if (type === "collected") {
      const excerpt = record.savedExcerpts?.[0];
      if (excerpt) {
        text = text || excerpt.title || excerpt.originalText || "";
        sourceLabel = excerpt.sourcePath ? basenameOf(excerpt.sourcePath) : undefined;
        const link = excerpt.backlink?.match(/^\[\[(.+?)(?:\|.*)?\]\]$/)?.[1];
        if (link) openTarget = { link };
        else if (excerpt.sourcePath) openTarget = { path: excerpt.sourcePath };
      }
    }
    if (!text && cardPath) text = basenameOf(cardPath);
    if (!text) text = `${TYPE_META[type].label}批注`;
    items.push({
      key,
      type,
      text: text.replace(/\s+/g, " ").slice(0, 160),
      sourceLabel,
      openTarget,
      cardPath,
      preview: record.previewAssetPath,
      tags: record.tags ?? [],
      collections: (record.collectionIds ?? []).map((cid) => collectionsById.get(cid)?.name ?? cid),
      status,
      hasAi: (record.aiAnswers?.length ?? 0) > 0 || Boolean(record.aiSummary),
      time: (config.sortBy === "createdAt" ? record.createdAt : record.updatedAt) ?? record.updatedAt ?? record.createdAt ?? 0
    });
  }
  items.sort((a, b) => b.time - a.time);

  const bank = await readJsonFile<QuestionBank>(app, folders.center + "/question-bank.json");
  const now = Date.now();
  const questionDayStart = new Date();
  questionDayStart.setHours(0, 0, 0, 0);
  const endOfToday = new Date(questionDayStart);
  endOfToday.setHours(23, 59, 59, 999);
  let questions = 0;
  let due = 0;
  let newQuestions = 0;
  let hardQuestions = 0;
  let masteredQuestions = 0;
  let reviewedToday = 0;
  const questionItems: QuestionItem[] = [];
  for (const [id, question] of Object.entries(bank?.questions ?? {})) {
    questions += 1;
    const review = question.review ?? {};
    const mastered = review.mastered === true || review.state === "mastered";
    const dueAt = typeof review.dueAt === "number" ? review.dueAt : now;
    const verified = question.verified !== false;
    const legacy = question.answer === undefined && question.gaps === undefined && question.verified === undefined;
    const reviewable = (legacy || (verified && Boolean(question.stem?.trim()) && Boolean(question.answer?.trim()) && !(question.gaps?.length))) && !mastered && review.state !== "suspended";
    if (reviewable && dueAt <= endOfToday.getTime()) due += 1;
    if (review.state === "new") newQuestions += 1;
    if (mastered) masteredQuestions += 1;
    const lapses = typeof review.lapses === "number" ? review.lapses : 0;
    if ((question.difficulty ?? 0) >= 4 || lapses >= 2 || Boolean(question.errorReason?.trim())) hardQuestions += 1;
    if (review.history?.some((event) => typeof event.at === "number" && event.at >= questionDayStart.getTime() && event.at <= endOfToday.getTime() && event.undoneAt === undefined)) reviewedToday += 1;
    questionItems.push({
      id,
      stem: (question.stem ?? "待补充题干").replace(/\s+/g, " ").trim().slice(0, 220),
      questionType: question.questionType ?? "unknown",
      subject: question.subject ?? "",
      difficulty: Math.min(5, Math.max(0, Number(question.difficulty) || 0)),
      lapses,
      state: review.state ?? "new",
      dueAt,
      mastered,
      verified,
      sourceLabel: question.sources?.[0]?.sourceName ?? question.sources?.[0]?.path?.split("/").pop(),
      createdAt: question.createdAt ?? 0,
      updatedAt: question.updatedAt ?? question.createdAt ?? 0
    });
  }
  questionItems.sort((a, b) => b.updatedAt - a.updatedAt);
  const cardsFile = await readJsonFile<CardsFile>(app, `${folders.cards}/cards.json`);

  return {
    items,
    inbox,
    archived,
    collections: (index.collections ?? []).map((collection) => ({ ...collection, count: counts.get(collection.id) ?? 0 })),
    questions,
    due,
    cards: cardsFile?.cards?.length ?? 0,
    todayNew,
    questionItems,
    newQuestions,
    hardQuestions,
    masteredQuestions,
    reviewedToday,
    ready: true
  };
}

async function resolvePreview(app: App, path: string | undefined): Promise<string | null> {
  if (!path) return null;
  const candidates = /\.(png|jpe?g|webp|gif)$/i.test(path) ? [path] : [path, `${path}.png`, `${path}.jpg`, `${path}.webp`];
  for (const candidate of candidates) {
    try {
      if (await app.vault.adapter.exists(normalizePath(candidate))) return resourceUrl(app, candidate);
    } catch {
      // 忽略，继续尝试下一个候选。
    }
  }
  return null;
}

function openCenter(ctx: WidgetContext<AnnotationsConfig>, which: "center" | "cards"): void {
  const names = which === "center" ? ["annotation center", "批注中心"] : ["card favorites", "卡片收藏"];
  const id = findCommandId(ctx.app, { pluginId: ctx.config.pluginId, nameIncludes: names })
    ?? findCommandId(ctx.app, { nameIncludes: names });
  if (!id || !runCommand(ctx.app, id)) new Notice("未找到 Mobile Ink Annotation Pro 的命令，请确认插件已启用");
}

type InkBridge = {
  openQuestionBankQuestion?: (questionId: string) => Promise<void>;
  openAnnotationCenter?: (options?: { reveal?: boolean }) => Promise<void>;
};

function getInkBridge(ctx: WidgetContext<AnnotationsConfig>): InkBridge | null {
  const plugins = (ctx.app as App & { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins;
  const plugin = plugins?.[ctx.config.pluginId];
  return plugin && typeof plugin === "object" ? plugin as InkBridge : null;
}

function openQuestion(ctx: WidgetContext<AnnotationsConfig>, questionId: string): void {
  const bridge = getInkBridge(ctx);
  if (bridge?.openQuestionBankQuestion) {
    void bridge.openQuestionBankQuestion(questionId).catch(() => openCenter(ctx, "center"));
    return;
  }
  openCenter(ctx, "center");
}

function openQuestionAction(ctx: WidgetContext<AnnotationsConfig>, action: "new" | "review"): void {
  const names = action === "new"
    ? ["新建题目", "新增题目", "create question", "add question"]
    : ["开始今日复习", "独立复习", "复习题库", "review questions"];
  const id = findCommandId(ctx.app, { pluginId: ctx.config.pluginId, nameIncludes: names })
    ?? findCommandId(ctx.app, { nameIncludes: names });
  if (id && runCommand(ctx.app, id)) return;
  const bridge = getInkBridge(ctx);
  if (bridge?.openAnnotationCenter) void bridge.openAnnotationCenter({ reveal: true });
  else openCenter(ctx, "center");
  if (action === "new") new Notice("已打开题库，请点击“新建题目”开始录入");
}

function questionTypeLabel(type: string): string {
  return ({ "single-choice": "单选", "multi-choice": "多选", judge: "判断", "fill-blank": "填空", "short-answer": "简答", calculation: "计算", case: "案例" } as Record<string, string>)[type] ?? "题目";
}

// ---- 面板：批注 -------------------------------------------------------------

function renderAnnotationPanel(wrap: HTMLElement, ctx: WidgetContext<AnnotationsConfig>, data: AnnotationData): void {
  const { app, config } = ctx;
  if (config.showStats) {
    const stats = wrap.createDiv({ cls: "hp-kpis" });
    renderKpi(stats, { value: data.inbox, label: "收件箱待处理", tone: 2, icon: "inbox", onClick: () => void ctx.saveConfig({ status: "inbox" }).then(() => ctx.rerender()) });
    renderKpi(stats, { value: data.todayNew, label: "今日新增批注", tone: 1, icon: "sparkles" });
    renderKpi(stats, { value: data.cards, label: "收藏卡片", tone: 3, icon: "bookmark", onClick: () => openCenter(ctx, "cards") });
    renderKpi(stats, { value: data.archived, label: "已归档", tone: 0, icon: "archive", onClick: () => void ctx.saveConfig({ status: "archived" }).then(() => ctx.rerender()) });
  }

  const filters = wrap.createDiv({ cls: "hp-filter-row" });
  const segmented = filters.createDiv({ cls: "hp-segmented" });
  for (const status of ["inbox", "archived", "all"] as const) {
    const button = segmented.createEl("button", {
      cls: `hp-segment${config.status === status ? " is-active" : ""}`,
      text: status === "all" ? "全部" : status === "inbox" ? "收件箱" : "已归档",
      attr: { type: "button" }
    });
    button.addEventListener("click", () => {
      if (config.status === status) return;
      void ctx.saveConfig({ status }).then(() => ctx.rerender());
    });
  }
  for (const collection of data.collections) {
    const active = config.collection === collection.id || config.collection === collection.name;
    const chip = filters.createDiv({ cls: `hp-annot-collection${active ? " is-active" : ""}`, attr: { title: `只看集合「${collection.name}」` } });
    if (collection.color) chip.style.setProperty("--hp-chip-color", collection.color);
    setIcon(chip.createSpan({ cls: "hp-annot-collection-icon" }), collection.icon || "folder");
    chip.createSpan({ text: `${collection.name} ${collection.count}` });
    chip.addEventListener("click", () => void ctx.saveConfig({ collection: active ? "" : collection.id }).then(() => ctx.rerender()));
  }

  if (!config.showList) return;
  const items = data.items
    .filter((item) => config.status === "all" || item.status === config.status)
    .filter((item) => !config.collection || item.collections.includes(config.collection) || data.collections.some((collection) => collection.id === config.collection && item.collections.includes(collection.name)))
    .slice(0, config.limit);
  const list = wrap.createDiv({ cls: "hp-annot-list" });
  if (items.length === 0) {
    renderEmpty(list, { icon: "check-circle-2", text: config.status === "inbox" ? "收件箱已清空，今天没有待处理的批注" : "没有符合条件的批注" });
    return;
  }
  for (const item of items) {
    const row = list.createDiv({ cls: "hp-annot-item is-clickable" });
    if (config.showPreview) {
      const thumb = row.createDiv({ cls: "hp-annot-thumb" });
      setIcon(thumb, TYPE_META[item.type].icon);
      void resolvePreview(app, item.preview).then((url) => {
        if (!url || !ctx.isAlive()) return;
        thumb.empty();
        thumb.createEl("img", { attr: { src: url, alt: "" } });
      });
    }
    const content = row.createDiv({ cls: "hp-annot-content" });
    content.createDiv({ cls: "hp-annot-text", text: item.text });
    const meta = content.createDiv({ cls: "hp-annot-meta" });
    meta.createSpan({ cls: "hp-annot-type", text: TYPE_META[item.type].label });
    if (item.sourceLabel) meta.createSpan({ cls: "hp-annot-source", text: item.sourceLabel });
    for (const tag of item.tags.slice(0, 3)) meta.createSpan({ cls: "hp-annot-tag", text: `#${tag}` });
    for (const name of item.collections.slice(0, 2)) meta.createSpan({ cls: "hp-annot-tag is-collection", text: name });
    if (item.hasAi) meta.createSpan({ cls: "hp-annot-tag is-ai", text: "AI" });
    if (item.cardPath) {
      const card = meta.createSpan({ cls: "hp-annot-tag is-card", text: "卡片" });
      card.addEventListener("click", (event) => {
        event.stopPropagation();
        void ctx.openPath(item.cardPath as string, { event });
      });
    }
    if (item.status === "archived") meta.createSpan({ cls: "hp-annot-tag is-archived", text: "已归档" });
    if (item.time) meta.createSpan({ cls: "hp-annot-time", text: formatRelativeTime(item.time) });
    row.addEventListener("click", (event) => {
      if (item.openTarget && "link" in item.openTarget) {
        void app.workspace.openLinkText(item.openTarget.link, "", false);
      } else if (item.openTarget) {
        void ctx.openPath(item.openTarget.path, { line: item.openTarget.line, event });
      } else if (item.cardPath) {
        void ctx.openPath(item.cardPath, { event });
      } else {
        openCenter(ctx, "center");
      }
    });
  }
}

// ---- 面板：复习（题库） ------------------------------------------------------

function renderReviewPanel(wrap: HTMLElement, ctx: WidgetContext<AnnotationsConfig>, data: AnnotationData): void {
  const { config } = ctx;
  const questionItems = data.questionItems;
  if (config.showStats) {
    const stats = wrap.createDiv({ cls: "hp-kpis" });
    renderKpi(stats, { value: data.due, label: "今日待复习", tone: 0, icon: "brain", onClick: () => openQuestionAction(ctx, "review"), title: "开始今日复习" });
    renderKpi(stats, { value: data.newQuestions, label: "新题", tone: 1, icon: "sparkles" });
    renderKpi(stats, { value: data.hardQuestions, label: "难题", tone: 2, icon: "flame" });
    renderKpi(stats, { value: data.masteredQuestions, label: `已掌握 · 共 ${data.questions} 题`, tone: 3, icon: "trophy" });
  }

  const actions = wrap.createDiv({ cls: "hp-review-actions" });
  const start = actions.createEl("button", { cls: "hp-button mod-cta", attr: { type: "button" } });
  setIcon(start.createSpan({ cls: "hp-button-icon" }), "play");
  start.createSpan({ text: data.due > 0 ? `开始今日复习 · ${data.due}` : "打开题库" });
  start.addEventListener("click", () => openQuestionAction(ctx, "review"));
  const add = actions.createEl("button", { cls: "hp-button hp-button-quiet", attr: { type: "button" } });
  setIcon(add.createSpan({ cls: "hp-button-icon" }), "plus");
  add.createSpan({ text: "新增题目" });
  add.addEventListener("click", () => openQuestionAction(ctx, "new"));
  // 今日进度：已复习 / (已复习 + 待复习)。
  const done = data.reviewedToday;
  const total = done + data.due;
  const progress = actions.createDiv({ cls: "hp-review-progress", attr: { title: `今日已复习 ${done} 次，还有 ${data.due} 题到期` } });
  const track = progress.createDiv({ cls: "hp-review-progress-track" });
  track.createDiv({ cls: "hp-review-progress-fill" }).style.width = `${total > 0 ? Math.round((done / total) * 100) : 0}%`;
  progress.createSpan({ cls: "hp-review-progress-text", text: total > 0 ? `${done} / ${total}` : "今日无到期" });

  const reviewable = questionItems.filter((item) => item.verified && !item.mastered && item.state !== "suspended");
  const pool = reviewable.length > 0 ? reviewable : questionItems;
  const daily = pool.length > 0 ? pool[new Date().getDate() % pool.length] : undefined;
  const body = wrap.createDiv({ cls: "hp-review-body" });
  if (!daily) {
    renderEmpty(body, { icon: "brain", text: "题库还没有题目。", action: { label: "创建第一道题", onClick: () => openQuestionAction(ctx, "new") } });
    return;
  }
  const feature = body.createDiv({ cls: "hp-question-feature is-clickable", attr: { role: "button", tabindex: "0", title: "打开题目" } });
  const eyebrow = feature.createDiv({ cls: "hp-question-eyebrow" });
  setIcon(eyebrow.createSpan({ cls: "hp-question-eyebrow-icon" }), "lightbulb");
  eyebrow.createSpan({ text: "每日一题" });
  feature.createDiv({ cls: "hp-question-stem", text: daily.stem });
  const meta = feature.createDiv({ cls: "hp-question-meta" });
  meta.createSpan({ cls: "hp-question-chip", text: questionTypeLabel(daily.questionType) });
  if (daily.subject) meta.createSpan({ cls: "hp-question-chip", text: daily.subject });
  if (daily.difficulty > 0) meta.createSpan({ cls: "hp-question-difficulty", text: "★".repeat(daily.difficulty) + "☆".repeat(Math.max(0, 5 - daily.difficulty)) });
  if (daily.sourceLabel) meta.createSpan({ cls: "hp-question-source", text: daily.sourceLabel });
  meta.createSpan({ cls: "hp-question-open", text: "查看题目 →" });
  const open = (): void => openQuestion(ctx, daily.id);
  feature.addEventListener("click", open);
  feature.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });

  const hard = questionItems
    .filter((item) => !item.mastered && (item.difficulty >= 4 || item.lapses >= 2))
    .sort((a, b) => (b.lapses * 10 + b.difficulty) - (a.lapses * 10 + a.difficulty))
    .slice(0, 3);
  if (hard.length > 0) {
    const head = body.createDiv({ cls: "hp-review-list-head" });
    setIcon(head.createSpan({ cls: "hp-review-list-head-icon" }), "flame");
    head.createSpan({ text: "难题" });
    head.createSpan({ cls: "hp-review-list-head-count", text: `${data.hardQuestions}` });
    for (const question of hard) {
      const row = body.createDiv({ cls: "hp-question-mini is-clickable", attr: { role: "button", tabindex: "0" } });
      row.createDiv({ cls: "hp-question-mini-stem", text: question.stem });
      const rowMeta = row.createDiv({ cls: "hp-question-mini-meta" });
      if (question.difficulty > 0) rowMeta.createSpan({ cls: "hp-question-difficulty", text: "★".repeat(question.difficulty) });
      if (question.lapses > 0) rowMeta.createSpan({ text: `遗忘 ${question.lapses} 次` });
      rowMeta.createSpan({ text: questionTypeLabel(question.questionType) });
      row.addEventListener("click", () => openQuestion(ctx, question.id));
    }
  }
}

export const annotationsWidget: WidgetDefinition<AnnotationsConfig> = {
  kind: "annotations",
  name: "批注与复习",
  description: "Mobile Ink Annotation：今日待复习题数、收件箱待处理、今日新增，以及最近批注（缩略图 / OCR 文字 / 标签 / 卡片）。",
  icon: "highlighter",
  accent: "#f59e0b",
  defaultSize: { w: 6, h: 7 },
  defaultConfig: () => ({ ...DEFAULTS }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    config.pluginId = config.pluginId.trim() || DEFAULTS.pluginId;
    config.status = config.status === "inbox" || config.status === "archived" ? config.status : "all";
    config.sortBy = config.sortBy === "createdAt" ? "createdAt" : "updatedAt";
    config.limit = clampInt(config.limit, 1, 50, DEFAULTS.limit);
    config.panel = config.panel === "review" ? "review" : "annotations";
    return config;
  },

  async render(body, ctx) {
    const { app, config } = ctx;
    const data = await loadAnnotations(app, config);
    if (!ctx.isAlive()) return;
    // 批注数据可能位于 .obsidian 下（无 vault 事件），定时刷新兜底。
    ctx.registerInterval(() => ctx.rerender(), 5 * 60 * 1000);
    if (!data.ready) {
      ctx.setSubtitle("未找到数据");
      renderEmpty(body, {
        icon: "highlighter",
        text: "未读取到批注中心数据：请确认已安装 Mobile Ink Annotation Pro 并打开过批注中心，或在设置里指定数据目录。",
        action: { label: "打开批注中心", onClick: () => openCenter(ctx, "center") }
      });
      return;
    }
    ctx.setSubtitle(`收件箱 ${data.inbox} · 待复习 ${data.due}`);
    ctx.addHeaderAction("bookmark", "卡片收藏夹", () => openCenter(ctx, "cards"));
    ctx.addHeaderAction("external-link", "打开批注中心", () => openCenter(ctx, "center"));
    const wrap = body.createDiv({ cls: "hp-annot" });

    // 顶部：批注 / 复习 两个面板切换（记住上次选择）。
    const panel = config.panel === "review" ? "review" : "annotations";
    const switcher = wrap.createDiv({ cls: "hp-annot-switch" });
    const tabs: Array<[AnnotationsConfig["panel"], string, string, number]> = [
      ["annotations", "highlighter", "批注", data.inbox],
      ["review", "brain", "复习", data.due]
    ];
    for (const [key, icon, label, count] of tabs) {
      const tab = switcher.createEl("button", { cls: `hp-annot-tab${panel === key ? " is-active" : ""}`, attr: { type: "button" } });
      setIcon(tab.createSpan({ cls: "hp-annot-tab-icon" }), icon);
      tab.createSpan({ text: label });
      tab.createSpan({ cls: `hp-annot-tab-count${count > 0 ? " has-items" : ""}`, text: String(count) });
      tab.addEventListener("click", () => {
        if (panel === key) return;
        void ctx.saveConfig({ panel: key }).then(() => ctx.rerender());
      });
    }

    if (panel === "review") {
      renderReviewPanel(wrap, ctx, data);
      return;
    }
    renderAnnotationPanel(wrap, ctx, data);
  },

  renderSettings(container, ctx) {
    const { config } = ctx;
    new Setting(container).setName("默认面板")
      .addDropdown((dropdown) => dropdown
        .addOptions({ annotations: "批注", review: "复习（题库）" })
        .setValue(config.panel)
        .onChange((value) => ctx.update({ panel: value === "review" ? "review" : "annotations" })));
    new Setting(container).setName("显示统计磁贴")
      .addToggle((toggle) => toggle.setValue(config.showStats).onChange((value) => ctx.update({ showStats: value })));
    new Setting(container).setName("显示批注列表")
      .addToggle((toggle) => toggle.setValue(config.showList).onChange((value) => ctx.update({ showList: value })));
    new Setting(container).setName("显示缩略图")
      .addToggle((toggle) => toggle.setValue(config.showPreview).onChange((value) => ctx.update({ showPreview: value })));
    new Setting(container).setName("默认状态筛选")
      .addDropdown((dropdown) => dropdown
        .addOptions({ inbox: "收件箱", archived: "已归档", all: "全部" })
        .setValue(config.status)
        .onChange((value) => ctx.update({ status: value === "inbox" || value === "archived" ? value : "all" })));
    new Setting(container).setName("只看集合").setDesc("填集合 id 或名称（如 错题 / 收藏），留空显示全部。")
      .addText((text) => text.setValue(config.collection).onChange((value) => ctx.update({ collection: value.trim() })));
    new Setting(container).setName("排序依据")
      .addDropdown((dropdown) => dropdown
        .addOptions({ updatedAt: "最近更新", createdAt: "最近创建" })
        .setValue(config.sortBy)
        .onChange((value) => ctx.update({ sortBy: value === "createdAt" ? "createdAt" : "updatedAt" })));
    addNumberSetting(container, { name: "最多条数", value: config.limit, min: 1, max: 50, onChange: (value) => ctx.update({ limit: value }) });

    addSectionHeading(container, "数据来源");
    new Setting(container).setName("插件 id").setDesc("默认 mobile-ink-annotation-pro；目录留空时会从该插件的 data.json 读取自定义数据目录。")
      .addText((text) => text.setValue(config.pluginId).onChange((value) => ctx.update({ pluginId: value.trim() })));
    addPathSetting(container, ctx.app, {
      name: "批注中心目录",
      desc: "包含 index.json / question-bank.json 的目录，留空自动检测。",
      value: config.centerFolder,
      suggest: { files: false, folders: true },
      onChange: (value) => ctx.update({ centerFolder: value })
    });
    addPathSetting(container, ctx.app, {
      name: "原文批注目录",
      value: config.mdSourceFolder,
      suggest: { files: false, folders: true },
      onChange: (value) => ctx.update({ mdSourceFolder: value })
    });
    addPathSetting(container, ctx.app, {
      name: "卡片收藏目录",
      value: config.cardsFolder,
      suggest: { files: false, folders: true },
      onChange: (value) => ctx.update({ cardsFolder: value })
    });
  }
};
