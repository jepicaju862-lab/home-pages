import { Component, Keymap, MarkdownRenderer, Setting, TFile } from "obsidian";
import { stripFrontmatter } from "../utils/vault";
import { addPathSetting } from "../ui/settingHelpers";
import { WidgetDefinition, normalizeWith } from "./types";

export interface NoteConfig extends Record<string, unknown> {
  path: string;
  hideFrontmatter: boolean;
  /** 只渲染某个标题下的内容（含标题）；留空渲染全文。 */
  heading: string;
}

const DEFAULTS: NoteConfig = { path: "", hideFrontmatter: true, heading: "" };

export const noteWidget: WidgetDefinition<NoteConfig> = {
  kind: "note",
  name: "笔记嵌入",
  description: "把任意笔记（或其中某个标题下的内容）渲染在首页上，Dataview 等也能用。",
  icon: "file-text",
  accent: "#64748b",
  defaultSize: { w: 6, h: 6 },
  defaultConfig: () => ({ ...DEFAULTS }),
  normalizeConfig: (raw) => normalizeWith(DEFAULTS, raw),

  async render(body, ctx) {
    const { app, config } = ctx;
    const path = config.path.trim();
    const file = path ? app.vault.getAbstractFileByPath(path) : null;
    if (!(file instanceof TFile)) {
      ctx.setSubtitle("");
      body.createDiv({ cls: "hp-empty", text: path ? `笔记不存在：${path}` : "点击右上角齿轮选择要嵌入的笔记" });
      return;
    }
    ctx.setSubtitle(file.basename);
    let source = "";
    try {
      source = await app.vault.cachedRead(file);
    } catch {
      body.createDiv({ cls: "hp-empty", text: "读取失败" });
      return;
    }
    if (!ctx.isAlive()) return;
    if (config.hideFrontmatter) source = stripFrontmatter(source);
    if (config.heading.trim()) source = extractSection(source, config.heading.trim());

    const wrap = body.createDiv({ cls: "hp-note markdown-rendered" });
    // 每次渲染用独立的子 Component，重绘时随之卸载，避免渲染产物在视图上累积。
    const child = new Component();
    ctx.component.addChild(child);
    ctx.registerCleanup(() => ctx.component.removeChild(child));
    await MarkdownRenderer.render(app, source, wrap, file.path, child);
    // 自定义视图里内部链接不会自动跳转，这里手动接管。
    wrap.addEventListener("click", (event) => {
      const link = (event.target as HTMLElement).closest<HTMLAnchorElement>("a.internal-link");
      if (!link) return;
      event.preventDefault();
      const href = link.dataset.href ?? link.getAttribute("href") ?? "";
      if (href) void app.workspace.openLinkText(href, file.path, Keymap.isModEvent(event));
    });
    const openButton = body.createDiv({ cls: "hp-note-open", text: "打开笔记 ↗" });
    openButton.addEventListener("click", (event) => void ctx.openPath(file.path, { event }));
  },

  renderSettings(container, ctx) {
    const { config } = ctx;
    addPathSetting(container, ctx.app, {
      name: "笔记路径",
      value: config.path,
      suggest: { files: true, extensions: ["md"] },
      onChange: (value) => ctx.update({ path: value })
    });
    new Setting(container).setName("只显示某个标题下的内容").setDesc("填写标题文字（不含 #），留空渲染整篇。")
      .addText((text) => text.setValue(config.heading).onChange((value) => ctx.update({ heading: value })));
    new Setting(container).setName("隐藏 frontmatter")
      .addToggle((toggle) => toggle.setValue(config.hideFrontmatter).onChange((value) => ctx.update({ hideFrontmatter: value })));
  }
};

function extractSection(source: string, heading: string): string {
  const lines = source.split(/\r?\n/g);
  const start = lines.findIndex((line) => {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    return match && match[2].trim() === heading;
  });
  if (start < 0) return source;
  const level = (lines[start].match(/^#+/)?.[0].length) ?? 1;
  const collected = [lines[start]];
  for (let index = start + 1; index < lines.length; index++) {
    const match = lines[index].match(/^(#{1,6})\s/);
    if (match && match[1].length <= level) break;
    collected.push(lines[index]);
  }
  return collected.join("\n");
}
