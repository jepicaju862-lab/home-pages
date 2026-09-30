import { App, Menu, Notice, Setting, TFile, TFolder, normalizePath, setIcon } from "obsidian";
import { todayIso } from "../utils/date";
import { ensureFolder } from "../utils/vault";
import { addNumberSetting, addPathSetting, addSectionHeading } from "../ui/settingHelpers";
import { WidgetContext, WidgetDefinition, clampInt, normalizeWith } from "./types";

export type TaskStatus = "todo" | "doing" | "done";

export interface KanbanConfig extends Record<string, unknown> {
  /** 待办来源：一个 md 文件，或一个文件夹（扫描其中所有笔记）；留空为全库。 */
  source: string;
  limit: number;
  todoTitle: string;
  doingTitle: string;
  doneTitle: string;
  /** 新增待办写入的文件名（来源是文件夹或全库时使用）。 */
  inboxName: string;
  hideDone: boolean;
}

export interface TaskRecord {
  path: string;
  line: number;
  raw: string;
  title: string;
  status: TaskStatus;
  date?: string;
}

const DEFAULTS: KanbanConfig = {
  source: "首页待办.md",
  limit: 60,
  todoTitle: "待办",
  doingTitle: "进行中",
  doneTitle: "已完成",
  inboxName: "待办收集箱.md",
  hideDone: false
};

const TASK_RE = /^(\s*[-*+]\s*\[)([^\]]?)(\]\s*)(.*)$/;
const DRAG_MIME = "application/x-home-pages-task";

export const kanbanWidget: WidgetDefinition<KanbanConfig> = {
  kind: "kanban",
  name: "任务看板",
  description: "把笔记里的 - [ ] 待办按 [ ] / [/] / [x] 分成三列，拖拽改状态、回车新增。",
  icon: "columns-3",
  accent: "#2563eb",
  defaultSize: { w: 6, h: 7 },
  defaultConfig: () => ({ ...DEFAULTS }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    config.limit = clampInt(config.limit, 1, 500, DEFAULTS.limit);
    config.inboxName = config.inboxName.trim() || DEFAULTS.inboxName;
    if (!config.inboxName.toLowerCase().endsWith(".md")) config.inboxName += ".md";
    return config;
  },

  async render(body, ctx) {
    const { app, config } = ctx;
    const { records, label } = await loadTasks(app, config);
    if (!ctx.isAlive()) return;
    ctx.setSubtitle(label);
    const sourceFile = config.source.trim() ? app.vault.getAbstractFileByPath(normalizePath(config.source.trim())) : null;
    if (sourceFile instanceof TFile) ctx.addHeaderAction("external-link", `打开 ${sourceFile.basename}`, (event) => void ctx.openPath(sourceFile.path, { event }));

    const allColumns: Array<{ id: TaskStatus; title: string }> = [
      { id: "todo", title: config.todoTitle || "待办" },
      { id: "doing", title: config.doingTitle || "进行中" },
      { id: "done", title: config.doneTitle || "已完成" }
    ];
    const columns = allColumns.filter((column) => !(config.hideDone && column.id === "done"));

    const board = body.createDiv({ cls: "hp-kanban" });
    board.style.setProperty("--hp-cols", String(columns.length));
    for (const column of columns) {
      const items = records.filter((record) => record.status === column.id);
      const columnEl = board.createDiv({ cls: `hp-kanban-column is-${column.id}` });
      const head = columnEl.createDiv({ cls: "hp-kanban-head" });
      head.createSpan({ text: column.title });
      head.createSpan({ cls: "hp-count", text: String(items.length) });
      const list = columnEl.createDiv({ cls: "hp-kanban-list" });
      bindDropTarget(list, ctx, column.id);
      for (const record of items) renderCard(list, ctx, record, column.id);
      if (items.length === 0) list.createDiv({ cls: "hp-kanban-empty", text: "添加或拖入待办" });
      const addRow = columnEl.createDiv({ cls: "hp-kanban-add" });
      const addButton = addRow.createDiv({ cls: "hp-kanban-add-btn", text: "＋ 添加待办" });
      addButton.addEventListener("click", () => beginAdd(ctx, column.id, addRow));
    }
  },

  renderSettings(container, ctx) {
    const { config } = ctx;
    addPathSetting(container, ctx.app, {
      name: "待办来源",
      desc: "一个笔记文件，或一个文件夹（扫描其中所有笔记的 - [ ] 任务）。留空为全库。",
      value: config.source,
      suggest: { files: true, folders: true, extensions: ["md"] },
      onChange: (value) => ctx.update({ source: value })
    });
    new Setting(container).setName("新增待办写入的文件").setDesc("来源是文件夹或全库时，新待办会追加到该文件（自动创建）。")
      .addText((text) => text.setValue(config.inboxName).onChange((value) => ctx.update({ inboxName: value.trim() })));
    addNumberSetting(container, { name: "最多显示条数", value: config.limit, min: 10, max: 500, step: 10, onChange: (value) => ctx.update({ limit: value }) });
    new Setting(container).setName("隐藏“已完成”列")
      .addToggle((toggle) => toggle.setValue(config.hideDone).onChange((value) => ctx.update({ hideDone: value })));
    addSectionHeading(container, "列标题");
    new Setting(container).setName("待办列").addText((text) => text.setValue(config.todoTitle).onChange((value) => ctx.update({ todoTitle: value })));
    new Setting(container).setName("进行中列").addText((text) => text.setValue(config.doingTitle).onChange((value) => ctx.update({ doingTitle: value })));
    new Setting(container).setName("已完成列").addText((text) => text.setValue(config.doneTitle).onChange((value) => ctx.update({ doneTitle: value })));
  }
};

// ---- 数据 ----------------------------------------------------------------

function resolveFiles(app: App, source: string): { files: TFile[]; label: string } {
  const path = source.trim().replace(/\/+$/g, "");
  if (!path) return { files: app.vault.getMarkdownFiles(), label: "全库" };
  const target = app.vault.getAbstractFileByPath(normalizePath(path));
  if (target instanceof TFile) return { files: [target], label: target.basename };
  if (target instanceof TFolder) {
    return { files: app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${target.path}/`)), label: `${target.path}/` };
  }
  return { files: [], label: `${path}（尚未创建）` };
}

async function loadTasks(app: App, config: KanbanConfig): Promise<{ records: TaskRecord[]; label: string }> {
  const { files, label } = resolveFiles(app, config.source);
  const records: TaskRecord[] = [];
  const sorted = [...files].sort((a, b) => b.stat.mtime - a.stat.mtime);
  for (const file of sorted) {
    if (records.length >= config.limit) break;
    // 有缓存时先用 listItems 判断是否含任务，避免读取无关笔记。
    const cache = app.metadataCache.getFileCache(file);
    if (cache && cache.listItems && !cache.listItems.some((item) => item.task !== undefined)) continue;
    let content = "";
    try {
      content = await app.vault.cachedRead(file);
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/g);
    lines.forEach((raw, line) => {
      const match = raw.match(TASK_RE);
      if (!match) return;
      const text = match[4].trim();
      if (!text) return;
      const parsed = parseTaskDate(text);
      records.push({ path: file.path, line, raw, title: parsed.clean, status: charToStatus(match[2]), date: parsed.date });
    });
  }
  records.sort((a, b) => {
    if (a.date && b.date) return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });
  return { records: records.slice(0, config.limit), label: `${label} · ${records.length} 条` };
}

/** 解析 Tasks 插件 emoji / Dataview inline / 纯 ISO 日期，并从标题中剥掉。 */
function parseTaskDate(text: string): { date?: string; clean: string } {
  const pick = (re: RegExp): string | undefined => text.match(re)?.[1];
  const date = pick(/\u{1F4C5}\uFE0F?\s*(\d{4}-\d{2}-\d{2})/u)
    ?? pick(/\[due::\s*(\d{4}-\d{2}-\d{2})\s*\]/i)
    ?? pick(/[\u{23F3}\u{1F6EB}]\uFE0F?\s*(\d{4}-\d{2}-\d{2})/u)
    ?? pick(/\[(?:scheduled|start)::\s*(\d{4}-\d{2}-\d{2})\s*\]/i);
  const clean = text
    .replace(/[\u{1F4C5}\u{23F3}\u{1F6EB}\u{2795}\u{2705}\u{1F501}]\uFE0F?\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/\[(?:due|scheduled|start|created|completion|done|repeat)::\s*[^\]]*\]/gi, "")
    .replace(/[\u{1F53A}\u{23EB}\u{1F53C}\u{1F53D}\u{23EC}]\uFE0F?/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (date) return { date, clean: clean || text };
  const plain = clean.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  return { date: plain, clean: clean || text };
}

function charToStatus(char: string): TaskStatus {
  const value = char.trim().toLowerCase();
  if (value === "x") return "done";
  if (value === "/" || value === ">") return "doing";
  return "todo";
}

function statusChar(status: TaskStatus): string {
  return status === "done" ? "x" : status === "doing" ? "/" : " ";
}

/** 只改一行；行内容与快照不一致时视为冲突，拒绝写入。 */
export function rewriteTaskLine(content: string, update: { line: number; expected: string; status?: TaskStatus; text?: string }): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/g);
  if (update.line < 0 || update.line >= lines.length) throw new Error("任务行已不存在");
  const current = lines[update.line];
  if (current !== update.expected) throw new Error("文件已被修改，请刷新后重试");
  const match = current.match(TASK_RE);
  if (!match) throw new Error("该行已不是任务");
  if (update.status !== undefined) lines[update.line] = `${match[1]}${statusChar(update.status)}${match[3]}${match[4]}`;
  else if (update.text !== undefined) lines[update.line] = `${match[1]}${match[2]}${match[3]}${update.text}`;
  return lines.join(newline);
}

async function updateTask(ctx: WidgetContext<KanbanConfig>, record: TaskRecord, patch: { status?: TaskStatus; text?: string }): Promise<void> {
  const file = ctx.app.vault.getAbstractFileByPath(record.path);
  if (!(file instanceof TFile)) {
    new Notice("任务所在文件不存在");
    ctx.rerender();
    return;
  }
  try {
    await ctx.app.vault.process(file, (content) => rewriteTaskLine(content, { line: record.line, expected: record.raw, ...patch }));
  } catch (error) {
    console.error("Home Pages: failed to update task", error);
    new Notice(error instanceof Error ? error.message : "更新任务失败");
  }
  ctx.rerender();
}

/** 删除任务所在的整行（行内容需与快照一致）。 */
async function deleteTask(ctx: WidgetContext<KanbanConfig>, record: TaskRecord): Promise<void> {
  const file = ctx.app.vault.getAbstractFileByPath(record.path);
  if (!(file instanceof TFile)) return;
  try {
    await ctx.app.vault.process(file, (content) => {
      const newline = content.includes("\r\n") ? "\r\n" : "\n";
      const lines = content.split(/\r?\n/g);
      if (lines[record.line] !== record.raw) throw new Error("文件已被修改，请刷新后重试");
      lines.splice(record.line, 1);
      return lines.join(newline);
    });
    new Notice("已删除任务行");
  } catch (error) {
    console.error("Home Pages: failed to delete task", error);
    new Notice(error instanceof Error ? error.message : "删除任务失败");
  }
  ctx.rerender();
}

async function addTask(ctx: WidgetContext<KanbanConfig>, status: TaskStatus, text: string): Promise<void> {
  const { app, config } = ctx;
  const source = config.source.trim().replace(/\/+$/g, "");
  const existing = source ? app.vault.getAbstractFileByPath(normalizePath(source)) : null;
  let path: string;
  if (existing instanceof TFile) path = existing.path;
  else if (existing instanceof TFolder) path = normalizePath(`${existing.path}/${config.inboxName}`);
  else if (source && source.toLowerCase().endsWith(".md")) path = normalizePath(source);
  else path = normalizePath(source ? `${source}/${config.inboxName}` : config.inboxName);
  try {
    const existingFile = app.vault.getAbstractFileByPath(path);
    let file: TFile;
    if (existingFile instanceof TFile) {
      file = existingFile;
    } else {
      const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (folder) await ensureFolder(app, folder);
      file = await app.vault.create(path, "");
    }
    await app.vault.process(file, (content) => {
      const trimmed = content.replace(/\s+$/g, "");
      return `${trimmed ? `${trimmed}\n` : ""}- [${statusChar(status)}] ${text}\n`;
    });
  } catch (error) {
    console.error("Home Pages: failed to add task", error);
    new Notice("添加待办失败");
  }
  ctx.rerender();
}

// ---- 渲染 ----------------------------------------------------------------

function renderCard(list: HTMLElement, ctx: WidgetContext<KanbanConfig>, record: TaskRecord, columnId: TaskStatus): void {
  const card = list.createDiv({ cls: "hp-kanban-card", attr: { draggable: "true" } });
  const check = card.createEl("button", { cls: `hp-kanban-check${columnId === "done" ? " is-done" : ""}`, attr: { type: "button", "aria-label": "切换完成" } });
  setIcon(check, columnId === "done" ? "check-circle-2" : "circle");
  check.addEventListener("click", (event) => {
    event.stopPropagation();
    void updateTask(ctx, record, { status: columnId === "done" ? "todo" : "done" });
  });
  const content = card.createDiv({ cls: "hp-kanban-content" });
  const title = content.createDiv({ cls: "hp-kanban-title", text: record.title, attr: { title: "双击编辑" } });
  if (record.date) {
    const today = todayIso();
    const overdue = columnId !== "done" && record.date < today;
    const isToday = columnId !== "done" && record.date === today;
    content.createDiv({
      cls: `hp-kanban-meta${overdue ? " is-overdue" : isToday ? " is-today" : ""}`,
      text: overdue ? `逾期 · ${record.date}` : isToday ? `今天 · ${record.date}` : record.date
    });
  } else if (!ctx.config.source.trim() || ctx.app.vault.getAbstractFileByPath(ctx.config.source.trim()) instanceof TFolder) {
    content.createDiv({ cls: "hp-kanban-meta", text: record.path.replace(/\.md$/i, "") });
  }
  title.addEventListener("dblclick", (event) => {
    event.preventDefault();
    beginEdit(ctx, record, title);
  });
  const open = card.createEl("button", { cls: "hp-kanban-open clickable-icon", attr: { type: "button", "aria-label": "打开笔记" } });
  setIcon(open, "external-link");
  open.addEventListener("click", (event) => {
    event.stopPropagation();
    void ctx.openPath(record.path, { line: record.line, event });
  });

  // 右键菜单：不方便拖拽（移动端 / 触控板）时也能改状态、打开或删除。
  card.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const menu = new Menu();
    const targets: Array<[TaskStatus, string]> = [
      ["todo", ctx.config.todoTitle || "待办"],
      ["doing", ctx.config.doingTitle || "进行中"],
      ["done", ctx.config.doneTitle || "已完成"]
    ];
    for (const [status, label] of targets) {
      if (status === columnId) continue;
      menu.addItem((item) => item.setTitle(`移到「${label}」`).setIcon("arrow-right").onClick(() => void updateTask(ctx, record, { status })));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("编辑文字").setIcon("pencil").onClick(() => beginEdit(ctx, record, title)));
    menu.addItem((item) => item.setTitle("打开笔记").setIcon("external-link").onClick(() => void ctx.openPath(record.path, { line: record.line })));
    menu.addItem((item) => item.setTitle("删除任务行").setIcon("trash-2").onClick(() => void deleteTask(ctx, record)));
    menu.showAtMouseEvent(event);
  });
  card.addEventListener("dragstart", (event) => {
    if (ctx.isEditing()) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    event.dataTransfer?.setData(DRAG_MIME, JSON.stringify({ path: record.path, line: record.line, raw: record.raw }));
    event.dataTransfer?.setData("text/plain", record.title);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    card.addClass("is-dragging");
  });
  card.addEventListener("dragend", () => card.removeClass("is-dragging"));
}

function bindDropTarget(list: HTMLElement, ctx: WidgetContext<KanbanConfig>, status: TaskStatus): void {
  list.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes(DRAG_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    list.addClass("is-drag-over");
  });
  list.addEventListener("dragleave", () => list.removeClass("is-drag-over"));
  list.addEventListener("drop", (event) => {
    list.removeClass("is-drag-over");
    const payload = event.dataTransfer?.getData(DRAG_MIME);
    if (!payload) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const data = JSON.parse(payload) as { path: string; line: number; raw: string };
      void updateTask(ctx, { path: data.path, line: data.line, raw: data.raw, title: "", status }, { status });
    } catch {
      // 非法拖拽数据，忽略。
    }
  });
}

function beginAdd(ctx: WidgetContext<KanbanConfig>, status: TaskStatus, addRow: HTMLElement): void {
  addRow.empty();
  const input = addRow.createEl("input", { cls: "hp-kanban-input", attr: { type: "text", placeholder: "新待办，回车添加" } });
  input.focus();
  let finished = false;
  const finish = (save: boolean): void => {
    if (finished) return;
    finished = true;
    const text = input.value.trim();
    if (save && text) void addTask(ctx, status, text);
    else ctx.rerender();
  };
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
}

function beginEdit(ctx: WidgetContext<KanbanConfig>, record: TaskRecord, titleEl: HTMLElement): void {
  const original = record.raw.match(TASK_RE)?.[4] ?? record.title;
  const input = createEl("input", { cls: "hp-kanban-input", attr: { type: "text" } });
  input.value = original;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = (save: boolean): void => {
    if (finished) return;
    finished = true;
    const text = input.value.trim();
    if (save && text && text !== original) void updateTask(ctx, record, { text });
    else ctx.rerender();
  };
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
}
