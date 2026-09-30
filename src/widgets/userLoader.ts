import * as obsidian from "obsidian";
import { FuzzySuggestModal, Modal, normalizePath, Notice, Setting, TAbstractFile, TFile, TFolder, type App } from "obsidian";
import type HomePagesPlugin from "../main";
import { createWidgetInstance, getWidgetDefinition, isWidgetKind } from "./registry";
import type { WidgetDefinition } from "./types";

export const DEMO_WIDGET_TEMPLATE = `// 这是一个 Home Pages 自定义组件示例：极简动态时钟与问候语
module.exports = {
  // 1. 组件唯一标识（建议小写字母与中划线，不能与内置组件重复）
  kind: "user-clock-demo",
  // 2. 在“添加组件”面板中显示的名称与描述
  name: "示例时钟与问候",
  description: "展示动态走动的当前时间与温馨问候语（自定义组件示例）",
  // 3. Lucide 图标名称（如 clock, sparkles, cloud-sun 等）与强调色
  icon: "clock",
  accent: "#6366f1",
  // 4. 默认网格尺寸 (w: 1-12 列, h: 行数)
  defaultSize: { w: 4, h: 3 },

  // 5. 默认配置项
  defaultConfig() {
    return {
      greeting: "欢迎使用 Home Pages",
      showSeconds: true
    };
  },

  // 6. 卡片渲染函数
  render(body, ctx) {
    body.empty();
    const container = body.createDiv({ cls: "user-clock-card" });
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.justifyContent = "center";
    container.style.alignItems = "center";
    container.style.height = "100%";
    container.style.gap = "6px";

    const greetingEl = container.createDiv({ text: ctx.config.greeting });
    greetingEl.style.fontSize = "13px";
    greetingEl.style.color = "var(--text-muted)";

    const timeEl = container.createDiv();
    timeEl.style.fontSize = "26px";
    timeEl.style.fontWeight = "bold";
    timeEl.style.fontFamily = "var(--font-monospace)";
    timeEl.style.letterSpacing = "0.05em";

    const updateTime = () => {
      const d = new Date();
      const hours = String(d.getHours()).padStart(2, "0");
      const minutes = String(d.getMinutes()).padStart(2, "0");
      const seconds = String(d.getSeconds()).padStart(2, "0");
      timeEl.setText(ctx.config.showSeconds ? \`\${hours}:\${minutes}:\${seconds}\` : \`\${hours}:\${minutes}\`);
    };
    updateTime();

    // 注册定时器（卡片重绘或组件卸载时会自动注销，防止内存泄漏）
    ctx.registerInterval(updateTime, 1000);

    // 在标题栏右上角加一个操作按钮（点击随机更换问候语）
    ctx.addHeaderAction("sparkles", "刷新问候", () => {
      const greetings = ["今天也要元气满满！", "保持专注，创造价值", "千里之行，始于足下", "享受当下的宁静与思考"];
      const next = greetings[Math.floor(Math.random() * greetings.length)];
      void ctx.saveConfig({ greeting: next });
      ctx.rerender();
    });
  },

  // 7. 卡片右上角齿轮设置面板（可选）
  renderSettings(container, ctx) {
    const { Setting } = obsidian;

    new Setting(container)
      .setName("问候语")
      .setDesc("卡片上方显示的文本")
      .addText((text) =>
        text.setValue(ctx.config.greeting).onChange((val) => ctx.update({ greeting: val }))
      );

    new Setting(container)
      .setName("显示秒数")
      .setDesc("是否在时钟末尾显示秒数")
      .addToggle((toggle) =>
        toggle.setValue(ctx.config.showSeconds).onChange((val) => ctx.update({ showSeconds: val }))
      );
  }
};
`;

/** 执行并验证一个用户组件脚本，返回标准的 WidgetDefinition */
export async function evaluateWidgetScript(
  source: string,
  app: App,
  _filePath = "custom-widget.js"
): Promise<WidgetDefinition<Record<string, unknown>>> {
  const asyncFnConstructor = Object.getPrototypeOf(async function () {}) as {
    constructor: new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;
  };
  const AsyncFunction = asyncFnConstructor.constructor;

  const moduleObj = { exports: {} as Record<string, unknown> };
  const exportsObj = moduleObj.exports;
  const windowObj = window as unknown as { obsidian?: unknown; require?: (mod: string) => unknown };
  if (!windowObj.obsidian) {
    try {
      windowObj.obsidian = obsidian;
    } catch {
      // Ignore
    }
  }

  const customRequire = (name: string): unknown => {
    if (name === "obsidian") return obsidian;
    try {
      return windowObj.require?.(name);
    } catch {
      return undefined;
    }
  };

  const runner = new AsyncFunction("module", "exports", "require", "app", "obsidian", source);
  const returned = await runner(moduleObj, exportsObj, customRequire, app, obsidian);

  const isExportsModified =
    moduleObj.exports !== exportsObj ||
    typeof moduleObj.exports === "function" ||
    (moduleObj.exports && Object.keys(moduleObj.exports).length > 0);

  let def: unknown = isExportsModified
    ? ((moduleObj.exports as { default?: unknown })?.default ?? moduleObj.exports)
    : returned;

  if (typeof def === "function") {
    def = await (def as (ctx: { app: App; obsidian: unknown }) => unknown)({
      app,
      obsidian: obsidian
    });
  }

  if (!def || typeof def !== "object") {
    throw new Error("脚本未导出有效的组件对象（需 module.exports = { ... } 或 return { ... }）");
  }

  const raw = def as Record<string, unknown>;
  if (!isWidgetKind(raw.kind)) {
    throw new Error("组件缺少有效的 kind 字段（非空字符串，如 \"my-widget\"）");
  }
  if (typeof raw.name !== "string" || !raw.name.trim()) {
    throw new Error("组件缺少 name 显示名称");
  }
  if (typeof raw.render !== "function") {
    throw new Error("组件缺少 render(body, ctx) 渲染函数");
  }

  const validated: WidgetDefinition<Record<string, unknown>> = {
    kind: raw.kind,
    name: raw.name.trim(),
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    icon: typeof raw.icon === "string" && raw.icon.trim() ? raw.icon.trim() : "box",
    accent: typeof raw.accent === "string" && raw.accent.trim() ? raw.accent.trim() : "#64748b",
    defaultSize:
      raw.defaultSize && typeof raw.defaultSize === "object"
        ? {
            w: Math.max(1, Math.min(12, Number((raw.defaultSize as { w?: unknown }).w) || 6)),
            h: Math.max(1, Math.min(24, Number((raw.defaultSize as { h?: unknown }).h) || 4))
          }
        : { w: 6, h: 4 },
    defaultConfig:
      typeof raw.defaultConfig === "function"
        ? (raw.defaultConfig as () => Record<string, unknown>)
        : () => ({}),
    normalizeConfig:
      typeof raw.normalizeConfig === "function"
        ? (raw.normalizeConfig as (r: Record<string, unknown>) => Record<string, unknown>)
        : undefined,
    render: raw.render as WidgetDefinition["render"],
    renderSettings:
      typeof raw.renderSettings === "function"
        ? (raw.renderSettings as WidgetDefinition["renderSettings"])
        : () => undefined,
    liveRefresh: raw.liveRefresh !== false
  };

  return validated;
}

export interface CustomWidgetInfo {
  kind: string;
  name: string;
  icon: string;
  accent: string;
  description: string;
  filePath: string;
}

export class CustomWidgetManager {
  private readonly registeredByFile = new Map<
    string,
    {
      kind: string;
      name: string;
      icon: string;
      accent: string;
      description: string;
      unregister: () => void;
    }
  >();

  constructor(private readonly plugin: HomePagesPlugin) {}

  getFolder(): string {
    const raw = this.plugin.settings.customWidgetsFolder?.trim() ?? "";
    return raw ? normalizePath(raw) : "";
  }

  isInFolder(file: TAbstractFile): boolean {
    const folder = this.getFolder();
    if (!folder || !(file instanceof TFile)) return false;
    if (file.extension.toLowerCase() !== "js") return false;
    const normPath = normalizePath(file.path);
    return normPath.startsWith(folder === "." ? "" : `${folder}/`);
  }

  async loadAll(silent = false): Promise<number> {
    const folderPath = this.getFolder();
    if (!folderPath) {
      this.unloadAll();
      return 0;
    }

    const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) {
      this.unloadAll();
      return 0;
    }

    const currentJsFiles = new Set<string>();
    const filesToLoad: TFile[] = [];

    const scan = (f: TFolder): void => {
      for (const child of f.children) {
        if (child instanceof TFolder) {
          scan(child);
        } else if (child instanceof TFile && child.extension.toLowerCase() === "js") {
          currentJsFiles.add(child.path);
          filesToLoad.push(child);
        }
      }
    };
    scan(folder);

    // 清理已在磁盘上被删除的旧文件注册
    for (const [path, entry] of [...this.registeredByFile.entries()]) {
      if (!currentJsFiles.has(path)) {
        entry.unregister();
        this.registeredByFile.delete(path);
      }
    }

    let loadedCount = 0;
    for (const file of filesToLoad) {
      // 批量扫描（启动、改目录、手动重扫）只登记，不自动加卡片：已有脚本可能很多，也可能是用户故意没放上首页的。
      const ok = await this.loadFile(file, false, false);
      if (ok) loadedCount += 1;
    }
    await this.markSeen([...this.registeredByFile.values()].map((entry) => entry.kind));

    if (!silent && loadedCount > 0) {
      new Notice(`Home Pages: 已成功加载 ${loadedCount} 个自定义组件`);
    }

    return loadedCount;
  }

  /**
   * autoAdd：脚本第一次加载成功时（新建、粘贴、生成模板）把组件放到当前首页。
   * 每个 kind 只触发一次，记录在 settings.seenCustomWidgetKinds。
   */
  async loadFile(file: TFile, notify = false, autoAdd = true): Promise<boolean> {
    if (file.extension.toLowerCase() !== "js") return false;

    let source = "";
    try {
      source = await this.plugin.app.vault.read(file);
    } catch (err) {
      console.error(`Home Pages: 读取自定义组件脚本失败 [${file.path}]`, err);
      return false;
    }

    // 先注销该文件先前的注册
    const previous = this.registeredByFile.get(file.path);
    if (previous) {
      previous.unregister();
      this.registeredByFile.delete(file.path);
    }

    try {
      const def = await evaluateWidgetScript(source, this.plugin.app, file.path);
      const unregister = this.plugin.api.registerWidget(def, `user-script:${file.path}`);
      this.registeredByFile.set(file.path, {
        kind: def.kind,
        name: def.name,
        icon: def.icon,
        accent: def.accent,
        description: def.description,
        unregister
      });
      this.plugin.refreshViews({ kind: def.kind });
      let added = false;
      if (autoAdd) {
        const seen = this.seenKinds();
        const isNew = !seen.includes(def.kind);
        added = this.autoAddOnce(def.kind);
        // 关闭了自动加入时也登记，之后再打开开关不会把旧脚本一股脑加进来。
        if (isNew && !seen.includes(def.kind)) seen.push(def.kind);
        if (isNew) await this.plugin.saveSettings();
      }
      if (added) {
        this.plugin.refreshViews();
        new Notice(`已加入首页：${def.name}`);
      } else if (notify) {
        new Notice(`已重新加载自定义组件：${def.name}`);
      }
      return true;
    } catch (error) {
      console.error(`Home Pages: 加载自定义组件失败 [${file.path}]`, error);
      const msg = error instanceof Error ? error.message : String(error);
      new Notice(`加载自定义组件失败: ${file.name}\n${msg}`);
      return false;
    }
  }

  /**
   * 同步完成“判断 + 登记 + 放卡片”，这样 vault 的 create 事件和调用方各自触发的两次加载
   * 不会各放一张卡片。只改内存，由调用方保存。返回是否新放了卡片。
   */
  private autoAddOnce(kind: string): boolean {
    const settings = this.plugin.settings;
    const seen = this.seenKinds();
    if (!settings.autoAddCustomWidgets || seen.includes(kind)) return false;
    seen.push(kind);
    if (settings.pages.some((page) => page.widgets.some((widget) => widget.kind === kind))) return false;
    this.plugin.getActivePage().widgets.push(createWidgetInstance(kind));
    return true;
  }

  private seenKinds(): string[] {
    return (this.plugin.settings.seenCustomWidgetKinds ??= []);
  }

  private async markSeen(kinds: string[]): Promise<void> {
    const seen = this.seenKinds();
    const fresh = kinds.filter((kind) => !seen.includes(kind));
    if (fresh.length === 0) return;
    seen.push(...fresh);
    await this.plugin.saveSettings();
  }

  unloadFile(filePath: string, notify = false): void {
    const existing = this.registeredByFile.get(filePath);
    if (!existing) return;
    existing.unregister();
    this.registeredByFile.delete(filePath);
    this.plugin.refreshViews({ kind: existing.kind });
    if (notify) {
      new Notice(`已移除自定义组件：${existing.kind}`);
    }
  }

  unloadAll(): void {
    for (const entry of this.registeredByFile.values()) {
      entry.unregister();
    }
    this.registeredByFile.clear();
  }

  getLoadedWidgets(): CustomWidgetInfo[] {
    const list: CustomWidgetInfo[] = [];
    for (const [filePath, entry] of this.registeredByFile.entries()) {
      const def = getWidgetDefinition(entry.kind);
      list.push({
        kind: entry.kind,
        name: def?.name ?? entry.name ?? entry.kind,
        icon: def?.icon ?? entry.icon ?? "box",
        accent: def?.accent ?? entry.accent ?? "#64748b",
        description: def?.description ?? entry.description ?? "",
        filePath
      });
    }
    return list;
  }

  hasKind(kind: string): boolean {
    for (const entry of this.registeredByFile.values()) {
      if (entry.kind === kind) return true;
    }
    return false;
  }

  getWidgetByKind(kind: string): CustomWidgetInfo | undefined {
    for (const [filePath, entry] of this.registeredByFile.entries()) {
      if (entry.kind === kind) {
        const def = getWidgetDefinition(entry.kind);
        return {
          kind: entry.kind,
          name: def?.name ?? entry.name ?? entry.kind,
          icon: def?.icon ?? entry.icon ?? "box",
          accent: def?.accent ?? entry.accent ?? "#64748b",
          description: def?.description ?? entry.description ?? "",
          filePath
        };
      }
    }
    return undefined;
  }

  async deleteWidget(
    filePathOrKind: string,
    options: { removeInstances?: boolean } = {}
  ): Promise<boolean> {
    let filePath = filePathOrKind;
    let kind = "";
    if (this.registeredByFile.has(filePathOrKind)) {
      filePath = filePathOrKind;
      kind = this.registeredByFile.get(filePathOrKind)?.kind ?? "";
    } else {
      const info = this.getWidgetByKind(filePathOrKind);
      if (info) {
        filePath = info.filePath;
        kind = info.kind;
      }
    }

    if (!filePath) return false;

    // 1. 如果需要移除页面卡片实例
    if (options.removeInstances && kind) {
      for (const page of this.plugin.settings.pages) {
        page.widgets = page.widgets.filter((w) => w.kind !== kind);
      }
      await this.plugin.saveSettings();
    }

    // 2. 移至回收站
    const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
    if (file instanceof TFile) {
      try {
        await this.plugin.app.fileManager.trashFile(file);
      } catch (err) {
        console.error("Home Pages: 移动组件脚本至回收站失败", err);
      }
    }

    // 3. 注销并刷新
    this.unloadFile(filePath, false);
    this.plugin.refreshViews();
    return true;
  }

  promptDeleteWidget(kindOrPath: string, onDeleted?: () => void): void {
    let info = this.getWidgetByKind(kindOrPath);
    if (!info && this.registeredByFile.has(kindOrPath)) {
      const entry = this.registeredByFile.get(kindOrPath);
      if (entry) {
        const def = getWidgetDefinition(entry.kind);
        info = {
          kind: entry.kind,
          name: def?.name ?? entry.kind,
          icon: def?.icon ?? "box",
          accent: def?.accent ?? "#64748b",
          description: def?.description ?? "",
          filePath: kindOrPath
        };
      }
    }
    if (!info) {
      new Notice("未找到指定的自定义组件");
      return;
    }

    let instancesCount = 0;
    for (const page of this.plugin.settings.pages) {
      instancesCount += page.widgets.filter((w) => w.kind === info?.kind).length;
    }

    new DeleteCustomWidgetModal(
      this.plugin.app,
      {
        kind: info.kind,
        name: info.name,
        filePath: info.filePath,
        instancesCount
      },
      async ({ removeInstances }) => {
        if (info) {
          await this.deleteWidget(info.filePath, { removeInstances });
          new Notice(`已删除自定义组件：${info.name}`);
          onDeleted?.();
        }
      }
    ).open();
  }

  registerWatcher(): void {
    const { vault } = this.plugin.app;

    this.plugin.registerEvent(
      vault.on("modify", async (file) => {
        if (this.isInFolder(file) && file instanceof TFile) {
          await this.loadFile(file, true);
        }
      })
    );

    this.plugin.registerEvent(
      vault.on("delete", (file) => {
        if (this.registeredByFile.has(file.path)) {
          this.unloadFile(file.path, true);
        } else if (file instanceof TFolder) {
          const prefix = `${normalizePath(file.path)}/`;
          for (const p of [...this.registeredByFile.keys()]) {
            if (normalizePath(p).startsWith(prefix)) {
              this.unloadFile(p, true);
            }
          }
        } else if (this.isInFolder(file)) {
          this.unloadFile(file.path, true);
        }
      })
    );

    this.plugin.registerEvent(
      vault.on("rename", async (file, oldPath) => {
        const wasIn = this.registeredByFile.has(oldPath);
        if (wasIn) {
          this.unloadFile(oldPath, false);
        }
        if (this.isInFolder(file) && file instanceof TFile) {
          await this.loadFile(file, true);
        }
      })
    );

    this.plugin.registerEvent(
      vault.on("create", async (file) => {
        if (this.isInFolder(file) && file instanceof TFile) {
          await this.loadFile(file, true);
        }
      })
    );
  }

  async createDemoTemplate(): Promise<TFile | null> {
    const folderPath = this.getFolder() || "_scripts/home-pages";
    const vault = this.plugin.app.vault;

    if (!this.plugin.settings.customWidgetsFolder) {
      this.plugin.settings.customWidgetsFolder = folderPath;
      await this.plugin.saveSettings();
    }

    const folder = vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      try {
        await vault.createFolder(folderPath);
      } catch (err) {
        console.error("Home Pages: 创建自定义组件目录失败", err);
        new Notice(`创建目录失败：${folderPath}`);
        return null;
      }
    }

    let fileName = "demo-widget.js";
    let targetPath = normalizePath(`${folderPath}/${fileName}`);
    let counter = 1;
    while (vault.getAbstractFileByPath(targetPath)) {
      counter += 1;
      fileName = `demo-widget-${counter}.js`;
      targetPath = normalizePath(`${folderPath}/${fileName}`);
    }

    try {
      const createdFile = await vault.create(targetPath, DEMO_WIDGET_TEMPLATE);
      new Notice(`已创建示例组件：${targetPath}`);
      await this.loadFile(createdFile, true);
      const leaf = this.plugin.app.workspace.getLeaf(false);
      await leaf.openFile(createdFile);
      return createdFile;
    } catch (err) {
      console.error("Home Pages: 创建示例组件文件失败", err);
      new Notice(`创建示例文件失败：${targetPath}`);
      return null;
    }
  }
}

/** 粘贴代码注册自定义组件的模态框 */
export class PasteWidgetModal extends Modal {
  private code = "";

  constructor(
    app: App,
    private readonly plugin: HomePagesPlugin,
    private readonly onCreated?: (kind: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("hp-modal");
    this.titleEl.setText("粘贴代码注册自定义组件");
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "将符合规范的组件 JavaScript 代码粘贴至下方输入框。点击确定后将自动校验语法、保存为脚本文件并即时生效。"
    });

    const errorEl = this.contentEl.createDiv({ cls: "hp-paste-error is-hidden" });

    const textarea = this.contentEl.createEl("textarea", {
      cls: "hp-json-area",
      attr: { placeholder: "在此粘贴 module.exports = { kind: 'my-widget', ... } 代码...", rows: "16" }
    });
    textarea.addEventListener("input", () => {
      this.code = textarea.value;
      errorEl.addClass("is-hidden");
    });

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) =>
        button.setButtonText("校验并注册").setCta().onClick(async () => {
          const source = this.code.trim();
          if (!source) return;
          try {
            const def = await evaluateWidgetScript(source, this.app);
            const mgr = this.plugin.customWidgetManager;
            const folderPath = mgr.getFolder() || "_scripts/home-pages";
            const vault = this.app.vault;

            if (!this.plugin.settings.customWidgetsFolder) {
              this.plugin.settings.customWidgetsFolder = folderPath;
              await this.plugin.saveSettings();
            }

            const folder = vault.getAbstractFileByPath(folderPath);
            if (!folder) {
              try {
                await vault.createFolder(folderPath);
              } catch (err) {
                console.error("Home Pages: 创建自定义组件目录失败", err);
                errorEl.setText(`创建目录失败：${folderPath}`);
                errorEl.removeClass("is-hidden");
                return;
              }
            }

            const fileName = `${def.kind}.js`;
            const filePath = normalizePath(`${folderPath}/${fileName}`);
            const existing = vault.getAbstractFileByPath(filePath);
            let file: TFile;
            if (existing instanceof TFile) {
              await vault.modify(existing, source);
              file = existing;
            } else {
              file = await vault.create(filePath, source);
            }

            await mgr.loadFile(file, true);
            this.close();
            this.onCreated?.(def.kind);
          } catch (err) {
            errorEl.setText(`校验失败：${err instanceof Error ? err.message : String(err)}`);
            errorEl.removeClass("is-hidden");
          }
        })
      );

    window.setTimeout(() => textarea.focus(), 50);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export interface DeleteWidgetOptions {
  kind: string;
  name: string;
  filePath: string;
  instancesCount: number;
}

/** 删除自定义组件的确认弹窗 */
export class DeleteCustomWidgetModal extends Modal {
  private removeInstances = false;

  constructor(
    app: App,
    private readonly info: DeleteWidgetOptions,
    private readonly onConfirm: (options: { removeInstances: boolean }) => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("hp-modal");
    this.titleEl.setText(`删除自定义组件：${this.info.name}`);

    this.contentEl.createEl("p", {
      text: `确定要删除自定义组件「${this.info.name}」(${this.info.kind}) 吗？`
    });

    const meta = this.contentEl.createDiv({ cls: "hp-delete-meta" });
    meta.createDiv({ text: `脚本文件：${this.info.filePath}` });
    meta.createDiv({ text: "此操作会将对应的 .js 脚本文件移至回收站，并注销该组件。" });

    if (this.info.instancesCount > 0) {
      new Setting(this.contentEl)
        .setName("同时从所有首页布局中移除该组件卡片")
        .setDesc(`当前共有 ${this.info.instancesCount} 处页面正在使用此组件。如果不勾选，卡片将保留并显示为「等待插件」占位卡片。`)
        .addToggle((toggle) =>
          toggle.setValue(this.removeInstances).onChange((val) => {
            this.removeInstances = val;
          })
        );
    }

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText("移至回收站并删除")
          .setWarning()
          .onClick(async () => {
            this.close();
            await this.onConfirm({ removeInstances: this.removeInstances });
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 命令面板选择自定义组件进行删除的模糊搜索弹窗 */
export class DeleteCustomWidgetSuggestModal extends FuzzySuggestModal<CustomWidgetInfo> {
  constructor(
    app: App,
    private readonly items: CustomWidgetInfo[],
    private readonly onChoose: (item: CustomWidgetInfo) => void
  ) {
    super(app);
    this.setPlaceholder("选择要删除的自定义组件...");
  }

  getItems(): CustomWidgetInfo[] {
    return this.items;
  }

  getItemText(item: CustomWidgetInfo): string {
    return `${item.name} (${item.kind}) - ${item.filePath}`;
  }

  onChooseItem(item: CustomWidgetInfo): void {
    this.onChoose(item);
  }
}
