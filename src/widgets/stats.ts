import { Setting } from "obsidian";
import { daysBetweenToday, isIsoDate } from "../utils/date";
import { earliestVaultDay, getTagCount, isExcluded } from "../utils/vault";
import { addDateSetting, addTextareaSetting } from "../ui/settingHelpers";
import { WidgetDefinition, normalizeWith, toStringList } from "./types";

export type StatTile = "notes" | "tags" | "words" | "attachments" | "folders" | "vaultAge" | "todayNotes" | "weekNotes";

export interface StatsConfig extends Record<string, unknown> {
  tiles: StatTile[];
  columns: number;
  excludeFolders: string[];
  since: string;
}

const ALL_TILES: Array<{ id: StatTile; label: string }> = [
  { id: "notes", label: "笔记" },
  { id: "tags", label: "标签" },
  { id: "words", label: "约字数" },
  { id: "attachments", label: "附件" },
  { id: "folders", label: "文件夹" },
  { id: "vaultAge", label: "库龄（天）" },
  { id: "todayNotes", label: "今日新建" },
  { id: "weekNotes", label: "本周修改" }
];

const DEFAULTS: StatsConfig = { tiles: ["notes", "tags", "words", "attachments"], columns: 2, excludeFolders: [], since: "" };

export const statsWidget: WidgetDefinition<StatsConfig> = {
  kind: "stats",
  name: "库统计",
  description: "笔记 / 标签 / 字数 / 附件等知识库概览数字。",
  icon: "pie-chart",
  accent: "#d97706",
  defaultSize: { w: 5, h: 4 },
  defaultConfig: () => ({ ...DEFAULTS, tiles: [...DEFAULTS.tiles], excludeFolders: [] }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    const valid = new Set(ALL_TILES.map((tile) => tile.id));
    config.tiles = toStringList(config.tiles, 8).filter((tile): tile is StatTile => valid.has(tile as StatTile));
    if (config.tiles.length === 0) config.tiles = [...DEFAULTS.tiles];
    config.columns = config.columns === 3 || config.columns === 4 ? config.columns : 2;
    config.excludeFolders = toStringList(config.excludeFolders);
    return config;
  },

  render(body, ctx) {
    const { app, config } = ctx;
    ctx.setSubtitle("知识库概览");
    const markdown = app.vault.getMarkdownFiles().filter((file) => !isExcluded(file, config.excludeFolders));
    const all = app.vault.getFiles().filter((file) => !isExcluded(file, config.excludeFolders));
    const values: Record<StatTile, () => string> = {
      notes: () => markdown.length.toLocaleString(),
      tags: () => getTagCount(app).toLocaleString(),
      // 字数估算：Markdown 总字节 ÷ 3（中文 UTF-8 约 3 字节/字），避免逐篇读取。
      words: () => {
        const words = Math.round(markdown.reduce((sum, file) => sum + file.stat.size, 0) / 3);
        return words >= 10000 ? `${Math.round(words / 1000)}k` : words.toLocaleString();
      },
      attachments: () => Math.max(0, all.length - markdown.length).toLocaleString(),
      folders: () => app.vault.getAllLoadedFiles().filter((file) => !("extension" in file) && file.path !== "/").length.toLocaleString(),
      vaultAge: () => {
        const since = isIsoDate(config.since) ? config.since : earliestVaultDay(app);
        return since ? Math.max(0, -daysBetweenToday(since)).toLocaleString() : "—";
      },
      todayNotes: () => {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        return markdown.filter((file) => file.stat.ctime >= start.getTime()).length.toLocaleString();
      },
      weekNotes: () => {
        const since = Date.now() - 7 * 86400000;
        return markdown.filter((file) => file.stat.mtime >= since).length.toLocaleString();
      }
    };
    const grid = body.createDiv({ cls: "hp-stats" });
    grid.style.setProperty("--hp-cols", String(config.columns));
    config.tiles.forEach((tile, index) => {
      const item = grid.createDiv({ cls: `hp-stat hp-tone-${index % 4}` });
      item.createDiv({ cls: "hp-stat-value", text: values[tile]() });
      item.createDiv({ cls: "hp-stat-label", text: ALL_TILES.find((entry) => entry.id === tile)?.label ?? tile });
    });
  },

  renderSettings(container, ctx) {
    const { config } = ctx;
    new Setting(container).setName("每行列数")
      .addDropdown((dropdown) => dropdown
        .addOptions({ "2": "2", "3": "3", "4": "4" })
        .setValue(String(config.columns))
        .onChange((value) => ctx.update({ columns: Number(value) })));
    container.createEl("h4", { cls: "hp-settings-heading", text: "显示的数字（按勾选顺序排列）" });
    for (const tile of ALL_TILES) {
      new Setting(container).setName(tile.label)
        .addToggle((toggle) => toggle.setValue(config.tiles.includes(tile.id)).onChange((value) => {
          const next = config.tiles.filter((item) => item !== tile.id);
          if (value) next.push(tile.id);
          ctx.update({ tiles: next });
        }));
    }
    addDateSetting(container, { name: "库龄起算日", desc: "留空自动取库内最早文件。", value: config.since, onChange: (value) => ctx.update({ since: value }) });
    addTextareaSetting(container, {
      name: "排除文件夹",
      desc: "一行一个，统计时跳过这些文件夹（例如模板、附件目录）。",
      value: config.excludeFolders.join("\n"),
      rows: 3,
      onChange: (value) => ctx.update({ excludeFolders: toStringList(value) })
    });
  }
};
