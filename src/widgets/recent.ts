import { App, Setting, TFile, setIcon } from "obsidian";
import { formatRelativeTime } from "../utils/date";
import { isExcluded, isInScope } from "../utils/vault";
import { addNumberSetting, addPathSetting, addTextareaSetting } from "../ui/settingHelpers";
import { WidgetDefinition, clampInt, normalizeWith, toStringList } from "./types";

export interface RecentConfig extends Record<string, unknown> {
  limit: number;
  folder: string;
  excludeFolders: string[];
  /** 要显示的文件扩展名（小写、不带点）；"*" 表示所有文件。 */
  extensions: string[];
  sortBy: "mtime" | "ctime";
  showFolder: boolean;
}

const DEFAULTS: RecentConfig = { limit: 8, folder: "", excludeFolders: [], extensions: ["md"], sortBy: "mtime", showFolder: false };

/** 配置面板里的快捷格式：点一下加入 / 移出。 */
const PRESETS: Array<{ label: string; extensions: string[] }> = [
  { label: "笔记", extensions: ["md"] },
  { label: "PDF", extensions: ["pdf"] },
  { label: "多维表格", extensions: ["duowei"] },
  { label: "白板", extensions: ["canvas"] },
  { label: "Bases", extensions: ["base"] },
  { label: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] },
  { label: "音视频", extensions: ["mp3", "m4a", "wav", "ogg", "mp4", "mov", "webm"] }
];

const ICONS: Array<[string, string[]]> = [
  ["file-text", ["md", "txt"]],
  ["table-2", ["duowei"]],
  ["layout-dashboard", ["canvas"]],
  ["database", ["base"]],
  ["image", ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic"]],
  ["film", ["mp4", "mov", "webm", "mkv", "ogv"]],
  ["music", ["mp3", "m4a", "wav", "ogg", "flac", "aac", "3gp"]],
  ["file-spreadsheet", ["csv", "xls", "xlsx"]],
  ["file-code", ["js", "ts", "css", "html", "json", "py"]],
  ["file-archive", ["zip", "rar", "7z"]]
];

/** 把用户输入的格式（".PDF"、"*.pdf"、"pdf"，逗号 / 空格 / 换行分隔）整理成小写扩展名列表；空则只显示 Markdown。 */
export function normalizeExtensions(value: unknown): string[] {
  const raw = typeof value === "string" ? value.split(/[\s,，;；、]+/g) : toStringList(value);
  const seen = new Set<string>();
  for (const item of raw) {
    const ext = item.trim().toLowerCase().replace(/^\*?\./, "");
    if (ext === "*") return ["*"];
    if (/^[a-z0-9_-]{1,16}$/.test(ext)) seen.add(ext);
  }
  return seen.size > 0 ? Array.from(seen) : ["md"];
}

export function matchesExtension(extension: string, extensions: string[]): boolean {
  return extensions.includes("*") || extensions.includes(extension.toLowerCase());
}

export function fileIcon(extension: string): string {
  const ext = extension.toLowerCase();
  return ICONS.find(([, list]) => list.includes(ext))?.[0] ?? "file";
}

/** 预设开关：全部包含时视为开启；开启时加入，关闭时移出（"*" 与具体格式互斥）。 */
export function togglePreset(current: string[], preset: string[]): string[] {
  const list = current.filter((ext) => ext !== "*");
  const on = preset.every((ext) => list.includes(ext));
  const next = on ? list.filter((ext) => !preset.includes(ext)) : [...list, ...preset.filter((ext) => !list.includes(ext))];
  return next.length > 0 ? next : ["md"];
}

/** 没有对应视图的格式（如 docx）交给系统默认程序打开，避免 Obsidian 打开一个空标签页。 */
async function openFile(app: App, file: TFile, open: () => Promise<void>): Promise<void> {
  const internal = app as App & {
    viewRegistry?: { isExtensionRegistered?: (extension: string) => boolean };
    openWithDefaultApp?: (path: string) => void;
  };
  const registered = internal.viewRegistry?.isExtensionRegistered?.(file.extension);
  if (registered === false && internal.openWithDefaultApp) {
    internal.openWithDefaultApp(file.path);
    return;
  }
  await open();
}

export const recentWidget: WidgetDefinition<RecentConfig> = {
  kind: "recent",
  name: "最近笔记",
  description: "最近修改（或创建）的文件列表，点击打开；可选 Markdown、PDF、多维表格等任意格式。",
  icon: "history",
  accent: "#2563eb",
  defaultSize: { w: 4, h: 6 },
  defaultConfig: () => ({ ...DEFAULTS, excludeFolders: [], extensions: [...DEFAULTS.extensions] }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    config.limit = clampInt(config.limit, 1, 50, DEFAULTS.limit);
    config.excludeFolders = toStringList(config.excludeFolders);
    config.extensions = normalizeExtensions(raw.extensions ?? DEFAULTS.extensions);
    config.sortBy = config.sortBy === "ctime" ? "ctime" : "mtime";
    return config;
  },
  watchesFile: (file, config) => matchesExtension(file.extension, config.extensions),

  render(body, ctx) {
    const { app, config } = ctx;
    const onlyNotes = config.extensions.length === 1 && config.extensions[0] === "md";
    const all = (onlyNotes ? app.vault.getMarkdownFiles() : app.vault.getFiles())
      .filter((file) => matchesExtension(file.extension, config.extensions));
    const scoped = all.filter((file) => isInScope(file, config.folder) && !isExcluded(file, config.excludeFolders));
    const files = scoped
      .sort((a, b) => (config.sortBy === "ctime" ? b.stat.ctime - a.stat.ctime : b.stat.mtime - a.stat.mtime))
      .slice(0, config.limit);
    const unit = onlyNotes ? "篇" : "个文件";
    ctx.setSubtitle(config.folder.trim() ? `${config.folder.trim()} · ${scoped.length} ${unit}` : `全库 · ${scoped.length} ${unit}`);

    const list = body.createDiv({ cls: "hp-list" });
    if (files.length === 0) {
      list.createDiv({ cls: "hp-empty", text: onlyNotes ? "还没有笔记" : "没有符合格式的文件" });
      return;
    }
    for (const file of files) {
      const ext = file.extension.toLowerCase();
      const row = list.createDiv({ cls: "hp-list-row is-clickable", attr: { title: file.path } });
      setIcon(row.createSpan({ cls: "hp-list-icon" }), fileIcon(ext));
      const text = row.createDiv({ cls: "hp-list-text" });
      const title = text.createDiv({ cls: "hp-list-title hp-recent-title" });
      title.createSpan({ cls: "hp-recent-name", text: file.basename });
      if (ext !== "md") title.createSpan({ cls: "hp-recent-ext", text: ext.toUpperCase() });
      if (config.showFolder && file.parent && file.parent.path !== "/") {
        text.createDiv({ cls: "hp-list-sub", text: file.parent.path });
      }
      row.createSpan({ cls: "hp-list-meta", text: formatRelativeTime(config.sortBy === "ctime" ? file.stat.ctime : file.stat.mtime) });
      row.addEventListener("click", (event) => void openFile(app, file, () => ctx.openPath(file.path, { event })));
    }
  },

  renderSettings(container, ctx) {
    const { config } = ctx;
    addNumberSetting(container, { name: "显示条数", value: config.limit, min: 1, max: 50, onChange: (value) => ctx.update({ limit: value }) });

    const choices = [...PRESETS, { label: "全部文件", extensions: ["*"] }];
    let input: HTMLInputElement | null = null;
    const chipEls: HTMLButtonElement[] = [];
    // 快捷格式只反映 / 修改当前草稿，就地更新选中状态，不重绘面板（避免打断输入或吞掉点击）。
    const paint = (): void => {
      const all = config.extensions.includes("*");
      choices.forEach((preset, index) => {
        const on = preset.extensions[0] === "*" ? all : !all && preset.extensions.every((ext) => config.extensions.includes(ext));
        chipEls[index]?.toggleClass("is-on", on);
        chipEls[index]?.setAttr("aria-pressed", String(on));
      });
    };
    const formats = new Setting(container)
      .setName("文件格式")
      .setDesc("填扩展名，用逗号分隔；填 * 显示所有文件。也可以直接点下面的常用格式。")
      .addText((text) => {
        input = text.inputEl;
        text.setPlaceholder("例如：duowei, canvas")
          .setValue(config.extensions.join(", "))
          .onChange((value) => {
            ctx.update({ extensions: normalizeExtensions(value) });
            paint();
          });
        text.inputEl.addClass("hp-setting-input-wide");
      });
    const chips = formats.descEl.createDiv({ cls: "hp-recent-presets" });
    for (const preset of choices) {
      const chip = chips.createEl("button", { cls: "hp-recent-preset", text: preset.label, attr: { type: "button" } });
      chipEls.push(chip);
      chip.addEventListener("click", () => {
        const next = preset.extensions[0] === "*"
          ? (config.extensions.includes("*") ? ["md"] : ["*"])
          : togglePreset(config.extensions, preset.extensions);
        ctx.update({ extensions: next });
        if (input) input.value = next.join(", ");
        paint();
      });
    }
    paint();

    addPathSetting(container, ctx.app, {
      name: "限定文件夹",
      desc: "只显示该文件夹内的文件，留空为全库。",
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
