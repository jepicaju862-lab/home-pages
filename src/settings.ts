import { App, Modal, Notice, PluginSettingTab, Setting, TFile } from "obsidian";
import type HomePagesPlugin from "./main";
import type { HomePage, HomePagesSettings, WidgetInstance } from "./types";
import { createId } from "./utils/id";
import { ConfirmModal, MAX_COLUMNS, MAX_ROWS, PromptModal } from "./ui/modals";
import { addPathSetting } from "./ui/settingHelpers";
import { createWidgetInstance, isWidgetKind } from "./widgets/registry";
import { PasteWidgetModal } from "./widgets/userLoader";

export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS: HomePagesSettings = {
  version: SETTINGS_VERSION,
  pages: [],
  activePageId: "",
  openOnStartup: true,
  openInNewTab: true,
  rowHeight: 40,
  gap: 16,
  maxWidth: 1400,
  alwaysShowPageTabs: true,
  customWidgetsFolder: "",
  autoAddCustomWidgets: true,
  seenCustomWidgetKinds: []
};

/** 默认首页：复刻“场景·首页｜个人主页”的布局。 */
export function createDefaultPage(name = "首页"): HomePage {
  return {
    id: createId("page"),
    name,
    widgets: [
      createWidgetInstance("hero", { w: 12, h: 4, title: "欢迎回来" }),
      createWidgetInstance("recent", { w: 4, h: 6 }),
      createWidgetInstance("quicklinks", { w: 4, h: 6 }),
      createWidgetInstance("countdown", { w: 4, h: 3, title: "产品发布" }),
      createWidgetInstance("quote", { w: 4, h: 3 }),
      // 三个数据源组件放在同一页，不再单开“聚合”页面。
      createWidgetInstance("duowei", { w: 6, h: 7, title: "待办与日程" }),
      createWidgetInstance("annotations", { w: 6, h: 7, title: "批注与复习" }),
      createWidgetInstance("wechat", { w: 6, h: 7, title: "微信收件" }),
      createWidgetInstance("kanban", { w: 6, h: 7, title: "今日任务看板" }),
      createWidgetInstance("habit", { w: 6, h: 7 }),
      createWidgetInstance("stats", { w: 6, h: 4 }),
      createWidgetInstance("onthisday", { w: 6, h: 3 })
    ]
  };
}

export function sanitizeWidget(raw: unknown): WidgetInstance | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<WidgetInstance>;
  if (!isWidgetKind(value.kind)) return null;
  const widget = createWidgetInstance(value.kind, {
    id: typeof value.id === "string" && value.id ? value.id : undefined,
    title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : undefined,
    w: clamp(value.w, 1, MAX_COLUMNS),
    h: clamp(value.h, 1, MAX_ROWS),
    config: value.config && typeof value.config === "object" ? (value.config as Record<string, unknown>) : {}
  });
  if (typeof value.provider === "string" && value.provider.trim()) widget.provider = value.provider.trim();
  return widget;
}

export function sanitizePage(raw: unknown, fallbackName: string): HomePage | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<HomePage>;
  const widgets = Array.isArray(value.widgets)
    ? value.widgets.map(sanitizeWidget).filter((widget): widget is WidgetInstance => widget !== null)
    : [];
  return {
    id: typeof value.id === "string" && value.id ? value.id : createId("page"),
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : fallbackName,
    widgets
  };
}

export function sanitizeSettings(raw: unknown): HomePagesSettings {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<HomePagesSettings>;
  const pages = Array.isArray(value.pages)
    ? value.pages.map((page, index) => sanitizePage(page, `页面 ${index + 1}`)).filter((page): page is HomePage => page !== null)
    : [];
  const settings: HomePagesSettings = {
    version: SETTINGS_VERSION,
    pages: pages.length > 0 ? pages : [createDefaultPage()],
    activePageId: typeof value.activePageId === "string" ? value.activePageId : "",
    openOnStartup: value.openOnStartup ?? DEFAULT_SETTINGS.openOnStartup,
    openInNewTab: value.openInNewTab ?? DEFAULT_SETTINGS.openInNewTab,
    rowHeight: clamp(value.rowHeight, 24, 96) ?? DEFAULT_SETTINGS.rowHeight,
    gap: clamp(value.gap, 4, 40) ?? DEFAULT_SETTINGS.gap,
    maxWidth: clamp(value.maxWidth, 0, 4000) ?? DEFAULT_SETTINGS.maxWidth,
    alwaysShowPageTabs: value.alwaysShowPageTabs ?? DEFAULT_SETTINGS.alwaysShowPageTabs,
    customWidgetsFolder:
      typeof value.customWidgetsFolder === "string" ? value.customWidgetsFolder.trim() : DEFAULT_SETTINGS.customWidgetsFolder,
    autoAddCustomWidgets: value.autoAddCustomWidgets ?? DEFAULT_SETTINGS.autoAddCustomWidgets,
    seenCustomWidgetKinds: Array.isArray(value.seenCustomWidgetKinds)
      ? [...new Set(value.seenCustomWidgetKinds.filter((kind): kind is string => typeof kind === "string"))]
      : []
  };
  if (!settings.pages.some((page) => page.id === settings.activePageId)) settings.activePageId = settings.pages[0].id;
  return settings;
}

function clamp(value: unknown, min: number, max: number): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export class HomePagesSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: HomePagesPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("hp-settings-tab");
    const settings = this.plugin.settings;

    new Setting(containerEl).setName("启动时打开首页")
      .setDesc("Obsidian 启动完成后自动打开首页看板。")
      .addToggle((toggle) => toggle.setValue(settings.openOnStartup).onChange(async (value) => {
        settings.openOnStartup = value;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("在新标签页中打开")
      .setDesc("关闭后，打开首页会复用当前标签页。")
      .addToggle((toggle) => toggle.setValue(settings.openInNewTab).onChange(async (value) => {
        settings.openInNewTab = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl).setName("网格布局").setHeading();
    new Setting(containerEl).setName("行高").setDesc("组件高度以“行”为单位，这里决定一行多少像素。")
      .addSlider((slider) => slider.setLimits(24, 96, 2).setValue(settings.rowHeight).setDynamicTooltip().onChange(async (value) => {
        settings.rowHeight = value;
        await this.plugin.saveSettings();
        this.plugin.refreshViews({ layoutOnly: true });
      }));
    new Setting(containerEl).setName("间距").setDesc("组件之间的间隔（像素）。")
      .addSlider((slider) => slider.setLimits(4, 40, 2).setValue(settings.gap).setDynamicTooltip().onChange(async (value) => {
        settings.gap = value;
        await this.plugin.saveSettings();
        this.plugin.refreshViews({ layoutOnly: true });
      }));
    new Setting(containerEl).setName("内容最大宽度").setDesc("像素；0 表示铺满窗口。")
      .addText((text) => text.setValue(String(settings.maxWidth)).onChange(async (value) => {
        const parsed = clamp(value, 0, 4000);
        if (parsed === undefined) return;
        settings.maxWidth = parsed;
        await this.plugin.saveSettings();
        this.plugin.refreshViews({ layoutOnly: true });
      }));
    new Setting(containerEl).setName("始终显示页面标签栏")
      .setDesc("关闭后，只有多个页面或处于编辑模式时才显示。标签栏末尾的“+”可直接新建页面。")
      .addToggle((toggle) => toggle.setValue(settings.alwaysShowPageTabs).onChange(async (value) => {
        settings.alwaysShowPageTabs = value;
        await this.plugin.saveSettings();
        this.plugin.refreshViews({ layoutOnly: true });
      }));

    new Setting(containerEl).setName("页面").setHeading();
    containerEl.createEl("p", { cls: "setting-item-description", text: "可以创建多个首页（例如“工作”“生活”），在首页顶部的标签栏切换。组件的添加、排序、尺寸与配置请在首页中点击“编辑布局”完成。" });
    for (const page of settings.pages) {
      const row = new Setting(containerEl).setName(page.name).setDesc(`${page.widgets.length} 个组件${page.id === settings.activePageId ? " · 当前" : ""}`);
      row.addButton((button) => button.setButtonText("重命名").onClick(() => {
        new PromptModal(this.app, { title: "重命名页面", value: page.name }, async (value) => {
          page.name = value;
          await this.plugin.saveSettings();
          this.plugin.refreshViews({ layoutOnly: true });
          this.display();
        }).open();
      }));
      row.addButton((button) => button.setButtonText("复制").onClick(async () => {
        const copy = sanitizePage({ ...page, id: undefined, name: `${page.name} 副本`, widgets: page.widgets.map((widget) => ({ ...widget, id: undefined })) }, `${page.name} 副本`);
        if (!copy) return;
        settings.pages.push(copy);
        await this.plugin.saveSettings();
        this.plugin.refreshViews({ layoutOnly: true });
        this.display();
      }));
      row.addButton((button) => {
        button.setButtonText("删除").setWarning().onClick(() => {
          new ConfirmModal(this.app, { title: "删除页面", message: `确定删除页面“${page.name}”及其 ${page.widgets.length} 个组件？`, confirmText: "删除", danger: true }, async () => {
            settings.pages = settings.pages.filter((item) => item.id !== page.id);
            if (settings.pages.length === 0) settings.pages.push(createDefaultPage());
            if (settings.activePageId === page.id) settings.activePageId = settings.pages[0].id;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
            this.display();
          }).open();
        });
        button.setDisabled(settings.pages.length <= 1);
      });
    }
    new Setting(containerEl)
      .addButton((button) => button.setButtonText("＋ 新建空白页面").onClick(() => {
        new PromptModal(this.app, { title: "新建页面", placeholder: "页面名称" }, async (value) => {
          settings.pages.push({ id: createId("page"), name: value, widgets: [] });
          await this.plugin.saveSettings();
          this.plugin.refreshViews({ layoutOnly: true });
          this.display();
        }).open();
      }))
      .addButton((button) => button.setButtonText("＋ 新建默认布局页面").onClick(() => {
        new PromptModal(this.app, { title: "新建页面", placeholder: "页面名称", value: "首页" }, async (value) => {
          settings.pages.push(createDefaultPage(value));
          await this.plugin.saveSettings();
          this.plugin.refreshViews({ layoutOnly: true });
          this.display();
        }).open();
      }));

    new Setting(containerEl).setName("自定义组件").setHeading();
    addPathSetting(containerEl, this.app, {
      name: "自定义组件目录",
      desc: "放置自定义组件 JavaScript (.js) 脚本的库内目录。保存修改即自动生效并支持热重载。",
      placeholder: "_scripts/home-pages",
      value: settings.customWidgetsFolder,
      suggest: { folders: true, files: false },
      onChange: (value) => {
        settings.customWidgetsFolder = value.trim();
      },
      onCommit: async (value) => {
        settings.customWidgetsFolder = value.trim();
        await this.plugin.saveSettings();
        await this.plugin.customWidgetManager.loadAll();
      }
    });
    new Setting(containerEl).setName("新组件自动加入首页")
      .setDesc("在组件目录里新建的脚本第一次加载成功时，自动放到当前首页。之后删掉卡片、再修改脚本不会重新加入。")
      .addToggle((toggle) => toggle.setValue(settings.autoAddCustomWidgets).onChange(async (value) => {
        settings.autoAddCustomWidgets = value;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("组件开发与注册")
      .setDesc("直接粘贴代码创建组件、生成示例模板文件，或重新扫描加载已修改的脚本。")
      .addButton((button) =>
        button.setButtonText("📋 粘贴代码新建组件").setCta().onClick(() => {
          new PasteWidgetModal(this.app, this.plugin).open();
        })
      )
      .addButton((button) =>
        button.setButtonText("📄 生成示例模板").onClick(async () => {
          await this.plugin.customWidgetManager.createDemoTemplate();
          this.display();
        })
      )
      .addButton((button) =>
        button.setButtonText("🔄 重新扫描加载").onClick(async () => {
          const count = await this.plugin.customWidgetManager.loadAll();
          new Notice(`Home Pages: 已成功载入 ${count} 个自定义组件`);
        })
      );

    const loadedCustomWidgets = this.plugin.customWidgetManager.getLoadedWidgets();
    new Setting(containerEl).setName("已安装的自定义组件").setHeading();
    if (loadedCustomWidgets.length === 0) {
      new Setting(containerEl)
        .setName("暂无已加载的自定义组件")
        .setDesc("未在自定义组件目录中检测到已注册的 JavaScript 组件。可通过上方按钮粘贴代码或生成示例模板。");
    } else {
      for (const w of loadedCustomWidgets) {
        new Setting(containerEl)
          .setName(w.name)
          .setDesc(`${w.description ? `${w.description} — ` : ""}标识: ${w.kind} | 文件: ${w.filePath}`)
          .addButton((button) =>
            button.setButtonText("📄 打开代码").onClick(async () => {
              const file = this.app.vault.getAbstractFileByPath(w.filePath);
              if (file instanceof TFile) {
                const leaf = this.app.workspace.getLeaf(false);
                await leaf.openFile(file);
              } else {
                new Notice(`未找到文件：${w.filePath}`);
              }
            })
          )
          .addButton((button) =>
            button
              .setButtonText("🗑️ 删除")
              .setWarning()
              .onClick(() => {
                this.plugin.customWidgetManager.promptDeleteWidget(w.kind, () => {
                  this.display();
                });
              })
          );
      }
    }

    new Setting(containerEl).setName("备份与迁移").setHeading();
    new Setting(containerEl).setName("导出布局").setDesc("把所有页面与组件配置复制为 JSON。")
      .addButton((button) => button.setButtonText("复制到剪贴板").onClick(async () => {
        const payload = JSON.stringify({ version: SETTINGS_VERSION, pages: settings.pages }, null, 2);
        try {
          await navigator.clipboard.writeText(payload);
          new Notice("布局 JSON 已复制");
        } catch {
          new TextModal(this.app, "导出布局", payload).open();
        }
      }));
    new Setting(containerEl).setName("导入布局").setDesc("粘贴之前导出的 JSON；导入的页面会追加到现有页面之后。")
      .addButton((button) => button.setButtonText("粘贴导入").onClick(() => {
        new ImportModal(this.app, async (text) => {
          try {
            const parsed = JSON.parse(text) as { pages?: unknown } | unknown[];
            const rawPages = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { pages?: unknown }).pages) ? ((parsed as { pages: unknown[] }).pages) : [parsed];
            const pages = rawPages
              .map((page, index) => sanitizePage(page, `导入页面 ${index + 1}`))
              .filter((page): page is HomePage => page !== null)
              .map((page) => ({ ...page, id: createId("page"), widgets: page.widgets.map((widget) => ({ ...widget, id: createId(widget.kind) })) }));
            if (pages.length === 0) throw new Error("没有可导入的页面");
            settings.pages.push(...pages);
            await this.plugin.saveSettings();
            this.plugin.refreshViews({ layoutOnly: true });
            this.display();
            new Notice(`已导入 ${pages.length} 个页面`);
          } catch (error) {
            new Notice(`导入失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }).open();
      }));
    new Setting(containerEl).setName("重置为默认布局").setDesc("删除所有页面并重新生成默认首页（习惯打卡等本地数据也会清除）。")
      .addButton((button) => button.setButtonText("重置").setWarning().onClick(() => {
        new ConfirmModal(this.app, { title: "重置布局", message: "确定删除所有页面并恢复默认首页？此操作不可撤销。", confirmText: "重置", danger: true }, async () => {
          settings.pages = [createDefaultPage()];
          settings.activePageId = settings.pages[0].id;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
          this.display();
        }).open();
      }));
  }
}

class TextModal extends Modal {
  constructor(app: App, private readonly title: string, private readonly text: string) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    const area = this.contentEl.createEl("textarea", { cls: "hp-json-area" });
    area.value = this.text;
    area.readOnly = true;
    area.rows = 18;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ImportModal extends Modal {
  constructor(app: App, private readonly onSubmit: (text: string) => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("导入布局 JSON");
    const area = this.contentEl.createEl("textarea", { cls: "hp-json-area", attr: { placeholder: "在此粘贴 JSON" } });
    area.rows = 16;
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("导入").setCta().onClick(async () => {
        const text = area.value.trim();
        if (!text) return;
        await this.onSubmit(text);
        this.close();
      }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
