import { Setting, setIcon } from "obsidian";
import { firstIsoDateString } from "../utils/date";
import { isExcluded, isInScope } from "../utils/vault";
import { addNumberSetting, addPathSetting, addTextareaSetting } from "../ui/settingHelpers";
import { WidgetDefinition, clampInt, normalizeWith, toStringList } from "./types";

export interface OnThisDayConfig extends Record<string, unknown> {
  limit: number;
  folder: string;
  excludeFolders: string[];
  /** 依次尝试的 frontmatter 日期字段。 */
  dateFields: string[];
  /** 文件名里含 YYYY-MM-DD 时用它当创建日期（日记很常见）。 */
  useFilenameDate: boolean;
  /** 都没有时退回文件系统创建时间。 */
  fallbackCtime: boolean;
}

const DEFAULTS: OnThisDayConfig = {
  limit: 6,
  folder: "",
  excludeFolders: [],
  dateFields: ["created", "date", "创建", "创建日期"],
  useFilenameDate: true,
  fallbackCtime: true
};

export const onThisDayWidget: WidgetDefinition<OnThisDayConfig> = {
  kind: "onthisday",
  name: "那年今日",
  description: "往年同月同日创建的笔记，回顾当年的自己。",
  icon: "calendar-clock",
  accent: "#db2777",
  defaultSize: { w: 7, h: 4 },
  defaultConfig: () => ({ ...DEFAULTS, excludeFolders: [], dateFields: [...DEFAULTS.dateFields] }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    config.limit = clampInt(config.limit, 1, 50, DEFAULTS.limit);
    config.excludeFolders = toStringList(config.excludeFolders);
    config.dateFields = toStringList(config.dateFields, 10);
    if (config.dateFields.length === 0) config.dateFields = [...DEFAULTS.dateFields];
    return config;
  },

  render(body, ctx) {
    const { app, config } = ctx;
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const thisYear = now.getFullYear();
    ctx.setSubtitle(`${now.getMonth() + 1}月${now.getDate()}日`);

    const items = app.vault.getMarkdownFiles()
      .filter((file) => isInScope(file, config.folder) && !isExcluded(file, config.excludeFolders))
      .map((file) => {
        const fm: Record<string, unknown> = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
        let iso = firstIsoDateString(...config.dateFields.map((field) => fm[field]));
        if (!iso && config.useFilenameDate) iso = file.basename.match(/\d{4}-\d{2}-\d{2}/)?.[0];
        if (!iso && config.fallbackCtime) iso = firstIsoDateString(file.stat.ctime);
        return { file, iso };
      })
      .filter((entry): entry is { file: typeof entry.file; iso: string } => !!entry.iso)
      .filter(({ iso }) => iso.slice(5, 7) === mm && iso.slice(8, 10) === dd && Number(iso.slice(0, 4)) < thisYear)
      .sort((a, b) => (a.iso < b.iso ? 1 : a.iso > b.iso ? -1 : 0))
      .slice(0, config.limit);

    const list = body.createDiv({ cls: "hp-list" });
    if (items.length === 0) {
      list.createDiv({ cls: "hp-empty", text: "往年的今天还没有笔记" });
      return;
    }
    for (const { file, iso } of items) {
      const year = Number(iso.slice(0, 4));
      const row = list.createDiv({ cls: "hp-list-row is-clickable", attr: { title: file.path } });
      const badge = row.createSpan({ cls: "hp-list-year" });
      setIcon(badge.createSpan({ cls: "hp-list-year-icon" }), "calendar");
      badge.createSpan({ text: String(year) });
      row.createDiv({ cls: "hp-list-title", text: file.basename });
      row.createSpan({ cls: "hp-list-meta", text: `${thisYear - year} 年前` });
      row.addEventListener("click", (event) => void ctx.openPath(file.path, { event }));
    }
  },

  renderSettings(container, ctx) {
    const { config } = ctx;
    addNumberSetting(container, { name: "显示条数", value: config.limit, min: 1, max: 50, onChange: (value) => ctx.update({ limit: value }) });
    addPathSetting(container, ctx.app, {
      name: "限定文件夹",
      desc: "留空为全库。",
      value: config.folder,
      suggest: { files: false, folders: true },
      onChange: (value) => ctx.update({ folder: value })
    });
    addTextareaSetting(container, {
      name: "排除文件夹",
      value: config.excludeFolders.join("\n"),
      rows: 2,
      onChange: (value) => ctx.update({ excludeFolders: toStringList(value) })
    });
    addTextareaSetting(container, {
      name: "创建日期字段",
      desc: "frontmatter 中依次尝试的字段名，一行一个。",
      value: config.dateFields.join("\n"),
      rows: 3,
      onChange: (value) => ctx.update({ dateFields: toStringList(value, 10) })
    });
    new Setting(container).setName("识别文件名中的日期").setDesc("如 2024-09-14.md 视为该日创建。")
      .addToggle((toggle) => toggle.setValue(config.useFilenameDate).onChange((value) => ctx.update({ useFilenameDate: value })));
    new Setting(container).setName("回退到文件创建时间").setDesc("没有日期字段时使用文件系统 ctime（同步后可能不准）。")
      .addToggle((toggle) => toggle.setValue(config.fallbackCtime).onChange((value) => ctx.update({ fallbackCtime: value })));
  }
};
