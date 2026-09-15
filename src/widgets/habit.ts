import { App, Notice, Setting, TFile, setIcon } from "obsidian";
import { MONTH_LABELS, buildRecentDays, parseIsoDate, todayIso } from "../utils/date";
import { findDailyNote, getOrCreateDailyNote } from "../utils/vault";
import { addTextareaSetting } from "../ui/settingHelpers";
import { WidgetContext, WidgetDefinition, normalizeWith, toStringList } from "./types";

export type HabitRange = "week" | "month" | "year";

export interface HabitConfig extends Record<string, unknown> {
  habits: string[];
  range: HabitRange;
  /** plugin=存在插件数据里；daily=读写当天日记的“## 习惯打卡”任务块。 */
  storage: "plugin" | "daily";
  checkins: Record<string, string[]>;
  heading: string;
}

const DEFAULTS: HabitConfig = {
  habits: ["早起", "运动", "阅读", "复盘"],
  range: "year",
  storage: "plugin",
  checkins: {},
  heading: "## 习惯打卡"
};

const RANGE_DAYS: Record<HabitRange, number> = { week: 7, month: 30, year: 371 };
const RANGE_LABEL: Record<HabitRange, string> = { week: "近 7 天", month: "近 30 天", year: "近一年" };

export const habitWidget: WidgetDefinition<HabitConfig> = {
  kind: "habit",
  name: "习惯打卡",
  description: "今日打卡 + GitHub 风格热力图；可存在插件里或写入每日日记。",
  icon: "badge-check",
  accent: "#16a34a",
  defaultSize: { w: 6, h: 7 },
  defaultConfig: () => ({ ...DEFAULTS, habits: [...DEFAULTS.habits], checkins: {} }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    config.habits = toStringList(config.habits, 12);
    if (config.habits.length === 0) config.habits = [...DEFAULTS.habits];
    config.range = config.range === "week" || config.range === "month" ? config.range : "year";
    config.storage = config.storage === "daily" ? "daily" : "plugin";
    config.heading = config.heading.trim() || DEFAULTS.heading;
    const checkins: Record<string, string[]> = {};
    for (const [date, list] of Object.entries(config.checkins ?? {})) {
      if (parseIsoDate(date) && Array.isArray(list)) checkins[date] = list.map((item) => String(item));
    }
    config.checkins = checkins;
    return config;
  },

  async render(body, ctx) {
    const { config } = ctx;
    const today = todayIso();
    const days = buildRecentDays(RANGE_DAYS[config.range]);
    const doneByDate = await loadCheckins(ctx.app, config, days);
    if (!ctx.isAlive()) return;
    ctx.setSubtitle(`${config.storage === "daily" ? "Daily Note" : "本地记录"} · ${RANGE_LABEL[config.range]}`);

    const wrap = body.createDiv({ cls: `hp-habit is-range-${config.range}` });
    const toolbar = wrap.createDiv({ cls: "hp-habit-toolbar" });
    const noteButton = toolbar.createEl("button", { cls: "hp-pill", text: "日记", attr: { type: "button", title: "打开今天的日记" } });
    noteButton.addEventListener("click", () => void openDaily(ctx, today));
    for (const range of ["week", "month", "year"] as HabitRange[]) {
      const button = toolbar.createEl("button", {
        cls: `hp-pill${config.range === range ? " is-active" : ""}`,
        text: range === "week" ? "周" : range === "month" ? "月" : "年",
        attr: { type: "button" }
      });
      button.addEventListener("click", () => {
        if (config.range === range) return;
        void ctx.saveConfig({ range }).then(() => ctx.rerender());
      });
    }

    const todayRow = wrap.createDiv({ cls: "hp-habit-today" });
    todayRow.createDiv({ cls: "hp-habit-today-label", text: "今日" });
    const todaySet = doneByDate.get(today) ?? new Set<string>();
    for (const habit of config.habits) {
      const done = todaySet.has(habit);
      const chip = todayRow.createEl("button", { cls: `hp-habit-chip${done ? " is-done" : ""}`, attr: { type: "button" } });
      setIcon(chip.createSpan({ cls: "hp-habit-chip-icon" }), done ? "check" : "circle");
      chip.createSpan({ text: habit });
      chip.addEventListener("click", () => void toggleCheckin(ctx, today, habit, !done));
    }

    renderCalendar(wrap, ctx, days, doneByDate, today);
  },

  renderSettings(container, ctx) {
    const { config } = ctx;
    addTextareaSetting(container, {
      name: "习惯列表",
      desc: "一行一个，最多 12 个。",
      value: config.habits.join("\n"),
      rows: 5,
      onChange: (value) => ctx.update({ habits: toStringList(value, 12) })
    });
    new Setting(container).setName("默认时间范围")
      .addDropdown((dropdown) => dropdown
        .addOptions({ week: "近 7 天", month: "近 30 天", year: "近一年" })
        .setValue(config.range)
        .onChange((value) => ctx.update({ range: value === "week" || value === "month" ? value : "year" })));
    new Setting(container).setName("数据存储位置")
      .setDesc("本地记录：保存在插件数据中，零配置。Daily Note：读写当天日记里的打卡任务块（跟随核心“每日笔记”插件的文件夹与日期格式）。")
      .addDropdown((dropdown) => dropdown
        .addOptions({ plugin: "本地记录（插件数据）", daily: "Daily Note（每日日记）" })
        .setValue(config.storage)
        .onChange((value) => ctx.update({ storage: value === "daily" ? "daily" : "plugin" })));
    new Setting(container).setName("日记中的打卡标题").setDesc("Daily Note 模式下托管的标题行，标题下的 - [ ] 任务即为习惯。")
      .addText((text) => text.setValue(config.heading).onChange((value) => ctx.update({ heading: value.trim() || DEFAULTS.heading })));
    const count = Object.values(config.checkins).reduce((sum, list) => sum + list.length, 0);
    new Setting(container).setName("清空本地打卡记录").setDesc(`当前共 ${count} 条本地记录（不影响日记文件）。`)
      .addButton((button) => button.setButtonText("清空").setWarning().onClick(() => {
        ctx.update({ checkins: {} });
        ctx.refresh();
        new Notice("本地打卡记录已清空（保存后生效）");
      }));
  }
};

async function loadCheckins(app: App, config: HabitConfig, days: string[]): Promise<Map<string, Set<string>>> {
  const habitSet = new Set(config.habits);
  const result = new Map<string, Set<string>>();
  if (config.storage === "plugin") {
    for (const date of days) {
      result.set(date, new Set((config.checkins[date] ?? []).filter((name) => habitSet.has(name))));
    }
    return result;
  }
  await mapWithConcurrency(days, 6, async (date) => {
    const file = findDailyNote(app, date);
    const done = file ? await readDoneFromDaily(app, file, config.heading) : [];
    result.set(date, new Set(done.filter((name) => habitSet.has(name))));
  });
  return result;
}

async function toggleCheckin(
  ctx: WidgetContext<HabitConfig>,
  date: string,
  habit: string,
  checked: boolean,
  rerender = true
): Promise<void> {
  const { config } = ctx;
  if (config.storage === "plugin") {
    const checkins = { ...config.checkins };
    const current = new Set(checkins[date] ?? []);
    if (checked) current.add(habit);
    else current.delete(habit);
    checkins[date] = [...current];
    await ctx.saveConfig({ checkins });
    if (rerender) ctx.rerender();
    return;
  }
  try {
    const file = await getOrCreateDailyNote(ctx.app, date);
    await ctx.app.vault.process(file, (source) => updateHabitBlock(source, config.heading, config.habits, habit, checked));
    ctx.rerender();
  } catch (error) {
    console.error("Home Pages: failed to write habit checkin", error);
    new Notice("写入日记失败，请检查每日笔记设置");
  }
}

async function openDaily(ctx: WidgetContext<HabitConfig>, date: string): Promise<void> {
  try {
    const file = await getOrCreateDailyNote(ctx.app, date);
    await ctx.openPath(file.path);
  } catch (error) {
    console.error("Home Pages: failed to open daily note", error);
    new Notice("打开日记失败");
  }
}

function renderCalendar(
  wrap: HTMLElement,
  ctx: WidgetContext<HabitConfig>,
  days: string[],
  doneByDate: Map<string, Set<string>>,
  today: string
): void {
  const total = Math.max(1, ctx.config.habits.length);
  const first = parseIsoDate(days[0]);
  const startDow = first ? first.getDay() : 0;
  const weeks = Math.ceil((startDow + days.length) / 7);
  const padded: Array<string | null> = [];
  for (let i = 0; i < startDow; i++) padded.push(null);
  for (const day of days) padded.push(day);
  while (padded.length < weeks * 7) padded.push(null);

  // 每列第一个有效日期落在新月份时标注月份。
  const monthLabels: string[] = new Array(weeks).fill("");
  let lastMonth = -1;
  for (let week = 0; week < weeks; week++) {
    for (let row = 0; row < 7; row++) {
      const day = padded[week * 7 + row];
      if (!day) continue;
      const month = parseIsoDate(day)?.getMonth() ?? -1;
      if (month !== lastMonth) {
        monthLabels[week] = MONTH_LABELS[month] ?? "";
        lastMonth = month;
      }
      break;
    }
  }

  const cal = wrap.createDiv({ cls: "hp-habit-cal" });
  const dow = cal.createDiv({ cls: "hp-habit-dow" });
  for (const label of ["日", "一", "二", "三", "四", "五", "六"]) dow.createDiv({ cls: "hp-habit-dow-label", text: label });
  const right = cal.createDiv({ cls: "hp-habit-cal-right" });
  const monthRow = right.createDiv({ cls: "hp-habit-month-row" });
  monthRow.style.gridTemplateColumns = `repeat(${weeks}, var(--hp-cell))`;
  for (const label of monthLabels) monthRow.createDiv({ cls: "hp-habit-month-label", text: label });
  const grid = right.createDiv({ cls: "hp-habit-grid" });
  for (const day of padded) {
    if (!day) {
      grid.createDiv({ cls: "hp-habit-cell is-empty" });
      continue;
    }
    const done = doneByDate.get(day)?.size ?? 0;
    const level = done <= 0 ? 0 : Math.max(1, Math.min(4, Math.ceil((done / total) * 4)));
    const cell = grid.createDiv({
      cls: `hp-habit-cell level-${level}${day === today ? " is-today" : ""}`,
      attr: { title: `${day} · ${done}/${total}` }
    });
    if (ctx.config.storage === "daily") {
      cell.addEventListener("click", () => void openDaily(ctx, day));
    } else {
      cell.addEventListener("click", () => openDayEditor(ctx, day, doneByDate.get(day) ?? new Set(), cell));
    }
  }
  window.requestAnimationFrame(() => {
    cal.scrollLeft = cal.scrollWidth;
  });
}

/** 本地记录模式下，点热力图格子可以补打卡：弹出一个小面板勾选，关闭时再重绘。 */
function openDayEditor(ctx: WidgetContext<HabitConfig>, date: string, done: Set<string>, anchor: HTMLElement): void {
  document.querySelector(".hp-habit-popover")?.remove();
  const popover = document.body.createDiv({ cls: "hp-habit-popover" });
  popover.createDiv({ cls: "hp-habit-popover-title", text: date });
  let dirty = false;
  for (const habit of ctx.config.habits) {
    const row = popover.createEl("label", { cls: "hp-habit-popover-row" });
    const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
    checkbox.checked = done.has(habit);
    row.createSpan({ text: habit });
    checkbox.addEventListener("change", () => {
      dirty = true;
      void toggleCheckin(ctx, date, habit, checkbox.checked, false);
    });
  }
  let closed = false;
  const close = (rerender: boolean): void => {
    if (closed) return;
    closed = true;
    popover.remove();
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    if (rerender && dirty) ctx.rerender();
  };
  const onDown = (event: MouseEvent): void => {
    if (!popover.contains(event.target as Node)) close(true);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close(true);
  };
  window.setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
  ctx.registerCleanup(() => close(false));
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - popover.offsetWidth - 8));
  const below = rect.bottom + 6;
  const top = below + popover.offsetHeight > window.innerHeight - 8 ? rect.top - 8 - popover.offsetHeight : below;
  popover.style.left = `${left}px`;
  popover.style.top = `${Math.max(8, top)}px`;
}

// ---- Daily Note 读写 --------------------------------------------------------

async function readDoneFromDaily(app: App, file: TFile, heading: string): Promise<string[]> {
  let source = "";
  try {
    source = await app.vault.cachedRead(file);
  } catch {
    return [];
  }
  const block = getHabitBlock(source, heading);
  if (block !== null) {
    const done: string[] = [];
    for (const line of block.split(/\r?\n/g)) {
      const item = parseHabitLine(line);
      if (item?.done) done.push(item.name);
    }
    return done;
  }
  // 兼容 frontmatter habits: [早起, 阅读] 或 habits: {早起: true}。
  const raw = app.metadataCache.getFileCache(file)?.frontmatter?.habits;
  if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean);
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, value]) => value === true || value === "true" || value === 1)
      .map(([key]) => key);
  }
  return [];
}

function getHabitBlock(source: string, heading: string): string | null {
  const lines = source.split(/\r?\n/g);
  const headingIndex = lines.findIndex((line) => line.trim() === heading);
  if (headingIndex < 0) return null;
  const collected: string[] = [];
  for (let index = headingIndex + 1; index < lines.length; index++) {
    if (/^#{1,6}\s/.test(lines[index])) break;
    collected.push(lines[index]);
  }
  return collected.join("\n");
}

function parseHabitLine(line: string): { name: string; done: boolean } | null {
  const match = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/);
  if (!match) return null;
  const name = match[2].trim().split(/\s+[A-Za-z][\w-]*::/)[0]?.trim();
  if (!name) return null;
  return { name, done: match[1].toLowerCase() === "x" };
}

function habitLine(name: string, checked: boolean): string {
  return `- [${checked ? "x" : " "}] ${name}`;
}

/** 只改动标题下的任务块；没有块则在文末追加一个完整的块。 */
export function updateHabitBlock(source: string, heading: string, habits: string[], habit: string, checked: boolean): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/g);
  const headingIndex = lines.findIndex((line) => line.trim() === heading);
  if (headingIndex < 0) {
    const names = toStringList([...habits, habit], 20);
    const block = [heading, ...names.map((name) => habitLine(name, name === habit ? checked : false))].join(newline);
    const trimmed = lines.join(newline).replace(/\s+$/g, "");
    return `${trimmed ? `${trimmed}${newline}${newline}` : ""}${block}${newline}`;
  }
  let sectionEnd = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index++) {
    if (/^#{1,6}\s/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }
  let found = false;
  let lastTaskIndex = headingIndex;
  for (let index = headingIndex + 1; index < sectionEnd; index++) {
    const item = parseHabitLine(lines[index]);
    if (!item) continue;
    lastTaskIndex = index;
    if (item.name === habit) {
      lines[index] = habitLine(habit, checked);
      found = true;
    }
  }
  if (!found) lines.splice(lastTaskIndex + 1, 0, habitLine(habit, checked));
  return lines.join(newline);
}

async function mapWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  }));
}
