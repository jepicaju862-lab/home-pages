import { Setting, setIcon } from "obsidian";
import { formatRelativeTime } from "../utils/date";
import { isExcluded, isInScope } from "../utils/vault";
import { addNumberSetting, addPathSetting, addTextareaSetting } from "../ui/settingHelpers";
import { WidgetDefinition, clampInt, normalizeWith, toStringList } from "./types";

export interface RecentConfig extends Record<string, unknown> {
  limit: number;
  folder: string;
  excludeFolders: string[];
  sortBy: "mtime" | "ctime";
  showFolder: boolean;
}

const DEFAULTS: RecentConfig = { limit: 8, folder: "", excludeFolders: [], sortBy: "mtime", showFolder: false };

export const recentWidget: WidgetDefinition<RecentConfig> = {
  kind: "recent",
  name: "最近笔记",
  description: "最近修改（或创建）的笔记列表，点击打开。",
  icon: "history",
  accent: "#2563eb",
  defaultSize: { w: 4, h: 6 },
  defaultConfig: () => ({ ...DEFAULTS, excludeFolders: [] }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    config.limit = clampInt(config.limit, 1, 50, DEFAULTS.limit);
    config.excludeFolders = toStringList(config.excludeFolders);
    config.sortBy = config.sortBy === "ctime" ? "ctime" : "mtime";
    return config;
  },

  render(body, ctx) {
    const { app, config } = ctx;
    const all = app.vault.getMarkdownFiles();
    const files = all
      .filter((file) => isInScope(file, config.folder) && !isExcluded(file, config.excludeFolders))
      .sort((a, b) => (config.sortBy === "ctime" ? b.stat.ctime - a.stat.ctime : b.stat.mtime - a.stat.mtime))
      .slice(0, config.limit);
    ctx.setSubtitle(config.folder.trim() ? `${config.folder.trim()} · ${files.length} 篇` : `全库 · ${all.length} 篇`);

    const list = body.createDiv({ cls: "hp-list" });
    if (files.length === 0) {
      list.createDiv({ cls: "hp-empty", text: "还没有笔记" });
      return;
    }
    for (const file of files) {
      const row = list.createDiv({ cls: "hp-list-row is-clickable", attr: { title: file.path } });
      setIcon(row.createSpan({ cls: "hp-list-icon" }), "file-text");
      const text = row.createDiv({ cls: "hp-list-text" });
      text.createDiv({ cls: "hp-list-title", text: file.basename });
      if (config.showFolder && file.parent && file.parent.path !== "/") {
        text.createDiv({ cls: "hp-list-sub", text: file.parent.path });
      }
      row.createSpan({ cls: "hp-list-meta", text: formatRelativeTime(config.sortBy === "ctime" ? file.stat.ctime : file.stat.mtime) });
      row.addEventListener("click", (event) => void ctx.openPath(file.path, { event }));
    }
  },

  renderSettings(container, ctx) {
    const { config } = ctx;
    addNumberSetting(container, { name: "显示条数", value: config.limit, min: 1, max: 50, onChange: (value) => ctx.update({ limit: value }) });
    addPathSetting(container, ctx.app, {
      name: "限定文件夹",
      desc: "只显示该文件夹内的笔记，留空为全库。",
      value: config.folder,
      suggest: { files: false, folders: true },
      onChange: (value) => ctx.update({ folder: value })
    });
    addTextareaSetting(container, {
      name: "排除文件夹",
      desc: "一行一个文件夹路径。",
      value: config.excludeFolders.join("\n"),
      rows: 3,
      onChange: (value) => ctx.update({ excludeFolders: toStringList(value) })
    });
    new Setting(container).setName("排序依据")
      .addDropdown((dropdown) => dropdown
        .addOptions({ mtime: "最近修改", ctime: "最近创建" })
        .setValue(config.sortBy)
        .onChange((value) => ctx.update({ sortBy: value === "ctime" ? "ctime" : "mtime" })));
    new Setting(container).setName("显示所在文件夹")
      .addToggle((toggle) => toggle.setValue(config.showFolder).onChange((value) => ctx.update({ showFolder: value })));
  }
};
