import { App, Setting, TFile, setIcon } from "obsidian";
import { dayOfYear } from "../utils/date";
import { addPathSetting, addTextareaSetting } from "../ui/settingHelpers";
import { WidgetDefinition, normalizeWith, toStringList } from "./types";

export interface QuoteConfig extends Record<string, unknown> {
  source: string;
  mode: "daily" | "random";
  quotes: string[];
}

const BUILTIN_QUOTES = [
  "慢慢来，比较快。",
  "种一棵树最好的时间是十年前，其次是现在。",
  "日拱一卒，功不唐捐。",
  "把简单的事做到极致，就是不简单。",
  "不积跬步，无以至千里。",
  "记录是为了更好地遗忘，也为了更好地记起。",
  "今天也要好好生活呀。"
];

const DEFAULTS: QuoteConfig = { source: "", mode: "daily", quotes: [] };

async function loadQuotes(ctx: { app: App; config: QuoteConfig }): Promise<{ lines: string[]; label: string; path?: string }> {
  const { app, config } = ctx;
  const path = config.source.trim();
  if (path) {
    const file = app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      try {
        const lines = (await app.vault.cachedRead(file))
          .split(/\r?\n/g)
          .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.|>)\s*/, "").trim())
          .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("---") && !line.startsWith("```"));
        if (lines.length > 0) return { lines, label: file.basename, path };
      } catch (error) {
        console.error("Home Pages: failed to read quote source", error);
      }
    }
  }
  if (config.quotes.length > 0) return { lines: config.quotes, label: "自定义语录" };
  return { lines: BUILTIN_QUOTES, label: "内置语录" };
}

export const quoteWidget: WidgetDefinition<QuoteConfig> = {
  kind: "quote",
  name: "每日一言",
  description: "从指定笔记（一行一条）或自定义列表中每天挑一句。",
  icon: "quote",
  accent: "#16a34a",
  defaultSize: { w: 4, h: 3 },
  defaultConfig: () => ({ ...DEFAULTS, quotes: [] }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    config.mode = config.mode === "random" ? "random" : "daily";
    config.quotes = toStringList(config.quotes, 500);
    return config;
  },

  async render(body, ctx) {
    const { lines, label, path } = await loadQuotes(ctx);
    if (!ctx.isAlive()) return;
    ctx.setSubtitle(label);
    const wrap = body.createDiv({ cls: "hp-quote" });
    const text = wrap.createDiv({ cls: "hp-quote-text" });
    let index = ctx.config.mode === "random" ? Math.floor(Math.random() * lines.length) : dayOfYear() % lines.length;
    text.setText(lines[index]);
    const footer = wrap.createDiv({ cls: "hp-quote-footer" });
    const shuffle = footer.createEl("button", { cls: "clickable-icon hp-quote-shuffle", attr: { "aria-label": "换一条", type: "button" } });
    setIcon(shuffle, "shuffle");
    shuffle.addEventListener("click", () => {
      if (lines.length <= 1) return;
      let next = index;
      while (next === index) next = Math.floor(Math.random() * lines.length);
      index = next;
      text.setText(lines[index]);
    });
    const source = footer.createSpan({ cls: `hp-quote-source${path ? " is-clickable" : ""}`, text: `— ${label}` });
    if (path) source.addEventListener("click", (event) => void ctx.openPath(path, { event }));
  },

  renderSettings(container, ctx) {
    const { config } = ctx;
    addPathSetting(container, ctx.app, {
      name: "语录来源笔记",
      desc: "一行一条语录（列表符号会自动去掉）。留空则使用下方自定义语录或内置语录。",
      value: config.source,
      suggest: { files: true, extensions: ["md"] },
      onChange: (value) => ctx.update({ source: value })
    });
    new Setting(container).setName("选取方式")
      .addDropdown((dropdown) => dropdown
        .addOptions({ daily: "每天固定一条", random: "每次打开随机" })
        .setValue(config.mode)
        .onChange((value) => ctx.update({ mode: value === "random" ? "random" : "daily" })));
    addTextareaSetting(container, {
      name: "自定义语录",
      desc: "一行一条；来源笔记为空时使用。",
      value: config.quotes.join("\n"),
      rows: 6,
      onChange: (value) => ctx.update({ quotes: toStringList(value, 500) })
    });
  }
};
