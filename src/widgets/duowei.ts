import { Component, MarkdownRenderer, Setting, TFile, setIcon } from "obsidian";
import { formatRelativeTime } from "../utils/date";
import { bindInternalLinks, isAnyPluginEnabled } from "../utils/plugins";
import { addNumberSetting, addPathSetting, addSectionHeading, addTextareaSetting } from "../ui/settingHelpers";
import { renderEmpty } from "../ui/dom";
import { WidgetContext, WidgetDefinition, clampInt, normalizeWith, toStringList } from "./types";
import { docCache, fieldByName, formatValue, loadDoc, selectRecords, titleFieldOf, type DuoweiDoc, type DuoweiField } from "./duoweiCore";
import { SECTION_META, buildDigest, type DigestSection } from "./duoweiDigest";

/** 已知会注册 `duowei` 代码块渲染器的多维表格插件 id。 */
const DUOWEI_PLUGIN_IDS = ["duowei-table-pro", "duowei-table", "duowei-table-basic", "obsidian-multidimensional-table"];

export interface DuoweiConfig extends Record<string, unknown> {
  path: string;
  /** digest=跨表格情报摘要；records=单表记录列表；embed=交给多维表格插件渲染（视图 / 仪表盘图表）。 */
  mode: "digest" | "records" | "embed";
  // ---- digest ----
  folder: string;
  excludeTables: string[];
  dateFieldNames: string[];
  upcomingDays: number;
  overdueDays: number;
  recentDays: number;
  sectionLimit: number;
  sections: DigestSection[];
  // ---- embed ----
  view: string;
  chart: string;
  chartType: "" | "number" | "bar" | "pie" | "line";
  fields: string[];
  // ---- records ----
  titleField: string;
  showFields: string[];
  filterField: string;
  filterValue: string;
  dateField: string;
  dateRange: "all" | "today" | "week" | "upcoming" | "overdue";
  sortField: string;
  sortDir: "asc" | "desc";
  limit: number;
}

const DEFAULTS: DuoweiConfig = {
  path: "",
  mode: "digest",
  folder: "",
  excludeTables: [],
  dateFieldNames: [],
  upcomingDays: 7,
  overdueDays: 30,
  recentDays: 3,
  sectionLimit: 6,
  sections: ["overdue", "today", "upcoming", "active", "recent"],
  view: "",
  chart: "",
  chartType: "",
  fields: [],
  titleField: "",
  showFields: [],
  filterField: "",
  filterValue: "",
  dateField: "",
  dateRange: "all",
  sortField: "",
  sortDir: "asc",
  limit: 10
};

// ---- 渲染 ----------------------------------------------------------------

async function renderEmbed(body: HTMLElement, ctx: WidgetContext<DuoweiConfig>, file: TFile): Promise<void> {
  const { app, config } = ctx;
  const lines = [`path: ${file.path}`];
  if (config.view.trim()) lines.push(`view: ${config.view.trim()}`);
  if (config.chart.trim()) lines.push(`widget: ${config.chart.trim()}`);
  if (config.chartType) lines.push(`type: ${config.chartType}`);
  if (config.limit) lines.push(`limit: ${Math.min(100, config.limit)}`);
  if (config.fields.length > 0) lines.push(`fields: ${config.fields.join(", ")}`);
  const source = "```duowei\n" + lines.join("\n") + "\n```";
  const wrap = body.createDiv({ cls: "hp-duowei-embed markdown-rendered" });
  const child = new Component();
  ctx.component.addChild(child);
  ctx.registerCleanup(() => ctx.component.removeChild(child));
  await MarkdownRenderer.render(app, source, wrap, file.path, child);
  bindInternalLinks(wrap, app, file.path);
}

function renderRecords(body: HTMLElement, ctx: WidgetContext<DuoweiConfig>, doc: DuoweiDoc, file: TFile): void {
  const { config } = ctx;
  if (doc.source && doc.records.length === 0) {
    body.createDiv({ cls: "hp-empty", text: "库数据源表格的记录在运行时生成，请改用“嵌入”模式显示。" });
    return;
  }
  const records = selectRecords(doc, config);
  const titleField = titleFieldOf(doc, config);
  const showFields = config.showFields.map((name) => fieldByName(doc, name)).filter((field): field is DuoweiField => !!field && field.id !== titleField?.id);
  const list = body.createDiv({ cls: "hp-list hp-duowei-list" });
  if (records.length === 0) {
    list.createDiv({ cls: "hp-empty", text: "没有符合条件的记录" });
    return;
  }
  for (const record of records) {
    const row = list.createDiv({ cls: "hp-list-row is-clickable hp-duowei-row" });
    const text = row.createDiv({ cls: "hp-list-text" });
    const title = titleField ? formatValue(titleField, record.values[titleField.id]).map((chip) => chip.text).join(" ") : record.id;
    text.createDiv({ cls: "hp-list-title", text: title || "（无标题）" });
    const chips = text.createDiv({ cls: "hp-duowei-chips" });
    for (const field of showFields) {
      for (const chip of formatValue(field, record.values[field.id])) {
        const el = chips.createSpan({ cls: `hp-duowei-chip${chip.color ? " has-color" : ""}`, text: chip.text, attr: { title: field.name } });
        if (chip.color) el.style.setProperty("--hp-chip-color", chip.color);
      }
    }
    if (chips.childElementCount === 0) chips.remove();
    const updated = Date.parse(record.updatedAt ?? "");
    if (Number.isFinite(updated)) row.createSpan({ cls: "hp-list-meta", text: formatRelativeTime(updated) });
    row.addEventListener("click", (event) => {
      if (record.notePath) void ctx.openPath(record.notePath, { event });
      else void ctx.openPath(file.path, { event });
    });
  }
}

const ALL_SECTIONS: DigestSection[] = ["overdue", "today", "upcoming", "active", "recent"];

async function renderDigest(body: HTMLElement, ctx: WidgetContext<DuoweiConfig>): Promise<void> {
  const { app, config } = ctx;
  const result = await buildDigest(app, {
    folder: config.folder,
    excludeTables: config.excludeTables,
    dateFieldNames: config.dateFieldNames,
    upcomingDays: config.upcomingDays,
    overdueDays: config.overdueDays,
    recentDays: config.recentDays,
    sectionLimit: config.sectionLimit,
    sections: config.sections
  });
  if (!ctx.isAlive()) return;
  ctx.setSubtitle(`${result.tables} 张表格 · ${result.items.length} 条`);
  if (result.scanned === 0) {
    renderEmpty(body, { icon: "table-2", text: config.folder ? `文件夹「${config.folder}」里没有 .duowei 表格` : "库里还没有 .duowei 表格；在多维表格里建一张带日期或状态字段的表，待办会自动出现在这里。" });
    return;
  }
  const wrap = body.createDiv({ cls: "hp-digest" });
  const summary = wrap.createDiv({ cls: "hp-digest-summary" });
  for (const section of ALL_SECTIONS) {
    if (!config.sections.includes(section)) continue;
    const meta = SECTION_META[section];
    const pill = summary.createDiv({ cls: `hp-digest-pill${result.totals[section] > 0 ? " has-items" : ""}` });
    pill.style.setProperty("--hp-tone", meta.tone);
    setIcon(pill.createSpan({ cls: "hp-digest-pill-icon" }), meta.icon);
    pill.createSpan({ text: `${meta.label} ${result.totals[section]}` });
  }
  if (result.items.length === 0) {
    renderEmpty(wrap, { icon: "check-circle-2", text: "没有逾期、到期或进行中的记录，一切安好。" });
    return;
  }
  const list = wrap.createDiv({ cls: "hp-digest-list" });
  let current: DigestSection | null = null;
  for (const item of result.items) {
    if (item.section !== current) {
      current = item.section;
      const meta = SECTION_META[item.section];
      const head = list.createDiv({ cls: "hp-digest-head" });
      head.style.setProperty("--hp-tone", meta.tone);
      setIcon(head.createSpan({ cls: "hp-digest-head-icon" }), meta.icon);
      head.createSpan({ text: meta.label });
      const total = result.totals[item.section];
      head.createSpan({ cls: "hp-digest-head-count", text: total > config.sectionLimit ? `${config.sectionLimit} / ${total}` : String(total) });
    }
    const row = list.createDiv({ cls: "hp-digest-row is-clickable", attr: { title: item.notePath ?? item.tablePath } });
    row.style.setProperty("--hp-tone", SECTION_META[item.section].tone);
    const text = row.createDiv({ cls: "hp-digest-text" });
    text.createDiv({ cls: "hp-digest-title", text: item.title });
    const meta = text.createDiv({ cls: "hp-digest-meta" });
    meta.createSpan({ cls: "hp-digest-table", text: item.tableName });
    if (item.dateText) meta.createSpan({ cls: "hp-digest-date", text: item.dateText });
    if (item.status) {
      const chip = meta.createSpan({ cls: `hp-duowei-chip${item.status.color ? " has-color" : ""}`, text: item.status.text });
      if (item.status.color) chip.style.setProperty("--hp-chip-color", item.status.color);
    }
    row.addEventListener("click", (event) => void ctx.openPath(item.notePath ?? item.tablePath, { event }));
  }
}

export const duoweiWidget: WidgetDefinition<DuoweiConfig> = {
  kind: "duowei",
  name: "待办与日程（多维表格）",
  description: "从库内所有 .duowei 表格提炼待办：已逾期、今天、即将到期、进行中、最近更新；也可切换为单表记录列表或嵌入视图。",
  icon: "table-2",
  accent: "#0ea5e9",
  defaultSize: { w: 6, h: 6 },
  defaultConfig: () => ({ ...DEFAULTS, fields: [], showFields: [] }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    config.mode = config.mode === "embed" || config.mode === "records" ? config.mode : "digest";
    config.excludeTables = toStringList(config.excludeTables, 50);
    config.dateFieldNames = toStringList(config.dateFieldNames, 10);
    config.upcomingDays = clampInt(config.upcomingDays, 0, 90, DEFAULTS.upcomingDays);
    config.overdueDays = clampInt(config.overdueDays, 0, 365, DEFAULTS.overdueDays);
    config.recentDays = clampInt(config.recentDays, 0, 30, DEFAULTS.recentDays);
    config.sectionLimit = clampInt(config.sectionLimit, 1, 30, DEFAULTS.sectionLimit);
    config.sections = toStringList(config.sections, 5).filter((section): section is DigestSection => ALL_SECTIONS.includes(section as DigestSection));
    if (config.sections.length === 0) config.sections = [...ALL_SECTIONS];
    config.chartType = ["number", "bar", "pie", "line"].includes(config.chartType) ? config.chartType : "";
    config.fields = toStringList(config.fields, 20);
    config.showFields = toStringList(config.showFields, 10);
    config.dateRange = ["today", "week", "upcoming", "overdue"].includes(config.dateRange) ? config.dateRange : "all";
    config.sortDir = config.sortDir === "desc" ? "desc" : "asc";
    config.limit = clampInt(config.limit, 1, 100, DEFAULTS.limit);
    return config;
  },

  async render(body, ctx) {
    const { app, config } = ctx;
    if (config.mode === "digest") {
      await renderDigest(body, ctx);
      return;
    }
    const path = config.path.trim();
    const file = path ? app.vault.getAbstractFileByPath(path) : null;
    if (!(file instanceof TFile)) {
      ctx.setSubtitle("");
      body.createDiv({ cls: "hp-empty", text: path ? `表格不存在：${path}` : "点击右上角齿轮选择一个 .duowei 表格" });
      return;
    }
    const doc = await loadDoc(app, file.path);
    if (!ctx.isAlive()) return;
    if (!doc) {
      body.createDiv({ cls: "hp-empty", text: "无法解析该 .duowei 文件" });
      return;
    }
    ctx.setSubtitle(`${doc.name || file.basename} · ${doc.records.length} 条`);
    const pluginReady = isAnyPluginEnabled(app, DUOWEI_PLUGIN_IDS);
    if (config.mode === "embed" && pluginReady) {
      await renderEmbed(body, ctx, file);
    } else {
      if (config.mode === "embed") {
        body.createDiv({ cls: "hp-duowei-warn", text: "未检测到多维表格插件，已回退为记录列表。" });
      }
      renderRecords(body, ctx, doc, file);
    }
    if (!ctx.isAlive()) return;
    const open = body.createDiv({ cls: "hp-note-open", text: "打开表格 ↗" });
    open.addEventListener("click", (event) => void ctx.openPath(file.path, { event }));
  },

  renderSettings(container, ctx) {
    const { config } = ctx;
    new Setting(container).setName("显示方式")
      .setDesc("情报摘要：扫描库内全部表格，汇总今天 / 逾期 / 即将到期 / 进行中 / 最近更新的记录。记录列表：只看一张表，可按字段筛选。嵌入：由多维表格插件渲染指定视图或图表（需已启用该插件）。")
      .addDropdown((dropdown) => dropdown
        .addOptions({ digest: "情报摘要（跨表格）", records: "单表记录列表", embed: "嵌入表格视图 / 图表" })
        .setValue(config.mode)
        .onChange((value) => {
          ctx.update({ mode: value === "embed" || value === "records" ? value : "digest" });
          ctx.refresh();
        }));

    if (config.mode === "digest") {
      addSectionHeading(container, "情报摘要设置");
      addPathSetting(container, ctx.app, {
        name: "限定文件夹",
        desc: "只扫描该文件夹下的 .duowei 表格；留空为全库（自动跳过备份表与微信收件箱表）。",
        value: config.folder,
        suggest: { files: false, folders: true },
        onChange: (value) => ctx.update({ folder: value })
      });
      addTextareaSetting(container, {
        name: "排除的表格",
        desc: "一行一个 .duowei 路径或文件夹。",
        value: config.excludeTables.join("\n"),
        rows: 2,
        onChange: (value) => ctx.update({ excludeTables: toStringList(value, 50) })
      });
      addTextareaSetting(container, {
        name: "计划日期字段名",
        desc: "一行一个；留空时自动识别（截止 / 到期 / 开始 / 日期 …，跳过接收 / 创建 / 更新时间）。",
        value: config.dateFieldNames.join("\n"),
        rows: 2,
        onChange: (value) => ctx.update({ dateFieldNames: toStringList(value, 10) })
      });
      const sectionLabels: Array<[DigestSection, string]> = [
        ["overdue", "已逾期"], ["today", "今天"], ["upcoming", "即将到期"], ["active", "进行中（状态字段）"], ["recent", "最近更新"]
      ];
      for (const [section, label] of sectionLabels) {
        new Setting(container).setName(`显示「${label}」`)
          .addToggle((toggle) => toggle.setValue(config.sections.includes(section)).onChange((value) => {
            const next = config.sections.filter((item) => item !== section);
            if (value) next.push(section);
            ctx.update({ sections: next });
          }));
      }
      addNumberSetting(container, { name: "即将到期：未来几天", value: config.upcomingDays, min: 0, max: 90, onChange: (value) => ctx.update({ upcomingDays: value }) });
      addNumberSetting(container, { name: "已逾期：回看几天", value: config.overdueDays, min: 0, max: 365, step: 5, onChange: (value) => ctx.update({ overdueDays: value }) });
      addNumberSetting(container, { name: "最近更新：几天内", value: config.recentDays, min: 0, max: 30, onChange: (value) => ctx.update({ recentDays: value }) });
      addNumberSetting(container, { name: "每个分区最多条数", value: config.sectionLimit, min: 1, max: 30, onChange: (value) => ctx.update({ sectionLimit: value }) });
      return;
    }

    addPathSetting(container, ctx.app, {
      name: "表格文件",
      value: config.path,
      placeholder: "xxx.duowei",
      suggest: { files: true, extensions: ["duowei"] },
      onChange: (value) => ctx.update({ path: value }),
      onCommit: (value) => {
        if (!value) return;
        void loadDoc(ctx.app, value).then(() => ctx.refresh());
      }
    });

    const doc = config.path.trim() ? docCache.get(config.path.trim())?.doc ?? null : null;
    if (config.path.trim() && !docCache.has(config.path.trim())) {
      void loadDoc(ctx.app, config.path.trim()).then(() => ctx.refresh());
    }
    const fieldOptions: Record<string, string> = { "": "（不使用）" };
    for (const field of doc?.fields ?? []) fieldOptions[field.name] = `${field.name}（${field.type}）`;
    const fieldDropdown = (name: string, desc: string, key: keyof DuoweiConfig, filter?: (field: DuoweiField) => boolean): void => {
      const options = filter && doc
        ? Object.fromEntries([["", "（不使用）"], ...doc.fields.filter(filter).map((field) => [field.name, `${field.name}（${field.type}）`])])
        : fieldOptions;
      const setting = new Setting(container).setName(name).setDesc(desc);
      if (doc) {
        setting.addDropdown((dropdown) => dropdown.addOptions(options).setValue(String(config[key] ?? "")).onChange((value) => ctx.update({ [key]: value } as Partial<DuoweiConfig>)));
      } else {
        setting.addText((text) => text.setValue(String(config[key] ?? "")).setPlaceholder("字段名").onChange((value) => ctx.update({ [key]: value.trim() } as Partial<DuoweiConfig>)));
      }
    };

    if (config.mode === "embed") {
      addSectionHeading(container, "嵌入设置");
      const viewSetting = new Setting(container).setName("视图").setDesc("留空使用第一个视图。");
      if (doc?.views?.length) {
        const options: Record<string, string> = { "": "（默认视图）" };
        for (const view of doc.views) options[view.name] = `${view.name}（${view.type}）`;
        viewSetting.addDropdown((dropdown) => dropdown.addOptions(options).setValue(config.view).onChange((value) => ctx.update({ view: value })));
      } else {
        viewSetting.addText((text) => text.setValue(config.view).onChange((value) => ctx.update({ view: value.trim() })));
      }
      new Setting(container).setName("仪表盘图表").setDesc("填写仪表盘视图里的图表标题即可只显示该图表；留空显示表格。")
        .addText((text) => text.setValue(config.chart).onChange((value) => ctx.update({ chart: value.trim() })));
      new Setting(container).setName("图表类型覆盖")
        .addDropdown((dropdown) => dropdown
          .addOptions({ "": "跟随图表设置", number: "数字", bar: "柱状图", pie: "饼图", line: "折线图" })
          .setValue(config.chartType)
          .onChange((value) => ctx.update({ chartType: (["number", "bar", "pie", "line"].includes(value) ? value : "") as DuoweiConfig["chartType"] })));
      addNumberSetting(container, { name: "最多行数", value: Math.min(100, config.limit), min: 1, max: 100, onChange: (value) => ctx.update({ limit: value }) });
      addTextareaSetting(container, {
        name: "限定显示列",
        desc: "一行一个字段名；留空显示视图前 6 列。",
        value: config.fields.join("\n"),
        rows: 3,
        onChange: (value) => ctx.update({ fields: toStringList(value, 20) })
      });
      return;
    }

    addSectionHeading(container, "记录列表设置");
    if (!doc && config.path.trim()) container.createDiv({ cls: "setting-item-description", text: "正在读取表格字段…" });
    fieldDropdown("标题字段", "每条记录显示的主文字；留空用表格的标题字段。", "titleField");
    addTextareaSetting(container, {
      name: "附加显示字段",
      desc: doc ? `一行一个字段名，可选：${doc.fields.map((field) => field.name).join("、")}` : "一行一个字段名。",
      value: config.showFields.join("\n"),
      rows: 3,
      onChange: (value) => ctx.update({ showFields: toStringList(value, 10) })
    });
    fieldDropdown("筛选字段", "按单选 / 多选 / 勾选 / 文本字段筛选。", "filterField");
    const filterField = doc ? fieldByName(doc, config.filterField) : undefined;
    const filterSetting = new Setting(container).setName("筛选值").setDesc("单选 / 多选填选项名；勾选填 true / false；文本按包含匹配。");
    if (filterField?.options?.length) {
      const options: Record<string, string> = { "": "（任意）" };
      for (const option of filterField.options) options[option.name] = option.name;
      filterSetting.addDropdown((dropdown) => dropdown.addOptions(options).setValue(config.filterValue).onChange((value) => ctx.update({ filterValue: value })));
    } else {
      filterSetting.addText((text) => text.setValue(config.filterValue).onChange((value) => ctx.update({ filterValue: value.trim() })));
    }
    fieldDropdown("日期字段", "配合下方日期范围，可做“今日日程”“本周到期”。", "dateField", (field) => ["date", "dateTime", "createdTime", "updatedTime", "text"].includes(field.type));
    new Setting(container).setName("日期范围")
      .addDropdown((dropdown) => dropdown
        .addOptions({ all: "全部", today: "今天", week: "未来 7 天", upcoming: "今天及以后", overdue: "已过期" })
        .setValue(config.dateRange)
        .onChange((value) => ctx.update({ dateRange: (["today", "week", "upcoming", "overdue"].includes(value) ? value : "all") as DuoweiConfig["dateRange"] })));
    fieldDropdown("排序字段", "留空时按日期字段排序，再无则按更新时间倒序。", "sortField");
    new Setting(container).setName("排序方向")
      .addDropdown((dropdown) => dropdown.addOptions({ asc: "升序", desc: "降序" }).setValue(config.sortDir).onChange((value) => ctx.update({ sortDir: value === "desc" ? "desc" : "asc" })));
    addNumberSetting(container, { name: "最多条数", value: config.limit, min: 1, max: 100, onChange: (value) => ctx.update({ limit: value }) });
  }
};
