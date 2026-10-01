import { ItemView, Menu, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type HomePagesPlugin from "./main";
import type { HomePage, WidgetInstance } from "./types";
import { createId } from "./utils/id";
import { openPath } from "./utils/vault";
import { AddWidgetModal, ConfirmModal, MAX_COLUMNS, MAX_ROWS, PromptModal, WidgetSettingsModal } from "./ui/modals";
import { PasteWidgetModal } from "./widgets/userLoader";
import { createWidgetInstance, getWidgetDefinition, getWidgetProvider, normalizeWidgetConfig, onRegistryChange, widgetDisplayTitle } from "./widgets/registry";
import { renderEmpty } from "./ui/dom";
import type { WidgetContext } from "./widgets/types";
import { animateLayout, moveBefore, PointerSorter } from "./ui/sortable";

export const VIEW_TYPE_HOME = "home-pages-view";
const REFRESH_DEBOUNCE_MS = 900;

const clampSpan = (value: number, max: number): number => Math.min(max, Math.max(1, Math.round(value)));

/** 一张卡片的渲染宿主：负责组件的生命周期（定时器、清理、异步渲染的失效判断）。 */
class WidgetHost {
  private cleanups: Array<() => void> = [];
  private token = 0;
  bodyEl: HTMLElement;

  constructor(
    private readonly view: HomeView,
    public widget: WidgetInstance,
    public readonly cardEl: HTMLElement,
    private readonly subtitleEl: HTMLElement,
    private readonly actionsEl: HTMLElement
  ) {
    this.bodyEl = cardEl.createDiv({ cls: "hp-card-body" });
  }

  async render(): Promise<void> {
    this.dispose();
    this.token += 1;
    const token = this.token;
    const body = createDiv({ cls: "hp-card-body" });
    this.bodyEl.replaceWith(body);
    this.bodyEl = body;
    this.subtitleEl.setText("");
    this.actionsEl.empty();

    const definition = getWidgetDefinition(this.widget.kind);
    if (!definition) {
      const provider = this.widget.provider ?? getWidgetProvider(this.widget.kind);
      this.subtitleEl.setText("等待插件");
      renderEmpty(body, {
        icon: "plug",
        text: provider
          ? `此组件由插件「${provider}」提供，启用该插件后会自动显示。`
          : `组件类型「${this.widget.kind}」由第三方插件提供，插件尚未加载；配置已保留。`
      });
      return;
    }
    const view = this.view;
    const config = normalizeWidgetConfig<Record<string, unknown>>(this.widget);
    const ctx: WidgetContext<Record<string, unknown>> = {
      app: view.app,
      plugin: view.plugin,
      widget: this.widget,
      config,
      component: view,
      saveConfig: async (patch) => {
        Object.assign(config, patch);
        this.widget.config = { ...this.widget.config, ...patch };
        await view.plugin.saveSettings();
      },
      rerender: () => void this.render(),
      openPath: (path, options) => openPath(view.app, path, options),
      setSubtitle: (text) => {
        if (token === this.token) this.subtitleEl.setText(text);
      },
      addHeaderAction: (icon, label, onClick) => {
        const button = this.actionsEl.createEl("button", { cls: "hp-card-action clickable-icon", attr: { type: "button", "aria-label": label, title: label } });
        setIcon(button, icon);
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          onClick(event);
        });
        return button;
      },
      registerInterval: (callback, ms) => {
        const id = window.setInterval(callback, ms);
        this.cleanups.push(() => window.clearInterval(id));
      },
      registerCleanup: (callback) => this.cleanups.push(callback),
      isAlive: () => token === this.token && body.isConnected,
      isEditing: () => view.isEditing()
    };
    try {
      await definition.render(body, ctx);
    } catch (error) {
      console.error(`Home Pages: widget "${this.widget.kind}" failed to render`, error);
      if (token === this.token) {
        body.empty();
        body.createDiv({ cls: "hp-empty", text: "组件渲染失败，请检查配置" });
      }
    }
  }

  dispose(): void {
    const cleanups = this.cleanups;
    this.cleanups = [];
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (error) {
        console.error("Home Pages: cleanup failed", error);
      }
    }
  }
}

export class HomeView extends ItemView {
  private editing = false;
  private hosts = new Map<string, WidgetHost>();
  private rootEl!: HTMLElement;
  /** 页面切换器的外壳：标题栏可见时挂进标题栏，否则挂在页面顶部。也是拖动预览的定位容器。 */
  private tabsHostEl!: HTMLElement;
  private tabsEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private gridEl!: HTMLElement;
  private refreshTimer: number | null = null;
  private cardSorter?: PointerSorter;
  private tabSorter?: PointerSorter;
  /** 正在拖动缩放时，取消并恢复原尺寸。 */
  private stopResize: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, readonly plugin: HomePagesPlugin) {
    super(leaf);
    this.navigation = true;
  }

  getViewType(): string {
    return VIEW_TYPE_HOME;
  }

  getDisplayText(): string {
    return this.plugin.getActivePage().name || "首页";
  }

  getIcon(): string {
    return "home";
  }

  isEditing(): boolean {
    return this.editing;
  }

  /** 标签页标题跟随页面名（updateHeader 不在公开类型里）。 */
  private updateHeader(): void {
    (this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("hp-view");
    this.rootEl = this.contentEl.createDiv({ cls: "hp-root" });
    this.tabsHostEl = createDiv({ cls: "hp-tabs-host" });
    this.tabsEl = this.tabsHostEl.createDiv({ cls: "hp-tabs" });
    this.toolbarEl = this.rootEl.createDiv({ cls: "hp-toolbar" });
    this.gridEl = this.rootEl.createDiv({ cls: "hp-grid" });

    this.addAction("refresh-cw", "刷新", () => this.refreshWidgets());
    this.addAction("pencil", "编辑布局", () => this.toggleEditing());
    this.addAction("settings", "插件设置", () => this.plugin.openSettings());

    const schedule = (file?: unknown): void => {
      if (file instanceof TFile && !["md", "base", "canvas", "duowei", "json"].includes(file.extension.toLowerCase())) return;
      this.scheduleRefresh();
    };
    this.registerEvent(this.app.vault.on("modify", schedule));
    this.registerEvent(this.app.vault.on("create", schedule));
    this.registerEvent(this.app.vault.on("delete", schedule));
    this.registerEvent(this.app.vault.on("rename", schedule));
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.scheduleRefresh()));
    // 「显示标签页标题栏」开关切换时，页面切换器在标题栏与页面顶部之间迁移。
    this.registerEvent(this.app.workspace.on("css-change", () => this.mountTabs()));

    this.bindSorting();
    // 第三方插件（多维表格等）晚于首页加载时，注册后立刻把占位卡片换成真实内容。
    const offRegistry = onRegistryChange((kind) => this.refreshKind(kind));
    this.register(offRegistry);
    this.render();
  }

  async onClose(): Promise<void> {
    this.stopResize?.();
    this.cardSorter?.destroy();
    this.tabSorter?.destroy();
    this.tabsHostEl.remove();
    this.headerTitleEl()?.removeClass("hp-has-switcher");
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    for (const host of this.hosts.values()) host.dispose();
    this.hosts.clear();
  }

  // ---- 渲染 ----------------------------------------------------------------

  get page(): HomePage {
    return this.plugin.getActivePage();
  }

  /** 全量重绘：页面标签、工具栏、网格与全部组件。 */
  render(): void {
    this.applyLayout();
    this.renderToolbar();
    this.renderGrid();
  }

  /** 只更新布局相关的样式与标签栏，不重绘组件。 */
  applyLayout(): void {
    const { rowHeight, gap, maxWidth } = this.plugin.settings;
    this.rootEl.style.setProperty("--hp-row", `${rowHeight}px`);
    this.rootEl.style.setProperty("--hp-gap", `${gap}px`);
    this.rootEl.style.setProperty("--hp-max-width", maxWidth > 0 ? `${maxWidth}px` : "none");
    this.rootEl.toggleClass("is-editing", this.editing);
    this.renderTabs();
    this.updateHeader();
  }

  private renderTabs(): void {
    this.tabSorter?.cancel();
    const { pages, alwaysShowPageTabs } = this.plugin.settings;
    this.tabsEl.empty();
    this.tabsEl.toggleClass("is-editing", this.editing);
    const show = alwaysShowPageTabs || pages.length > 1 || this.editing;
    this.tabsHostEl.toggleClass("is-hidden", !show);
    this.mountTabs();
    if (!show) return;
    this.tabsEl.setAttribute("role", "tablist");
    this.tabsEl.setAttribute("aria-label", "首页页面");
    for (const page of pages) {
      const active = page.id === this.page.id;
      const tab = this.tabsEl.createEl("button", {
        cls: `hp-tab${active ? " is-active" : ""}`,
        text: page.name,
        attr: {
          type: "button",
          role: "tab",
          "aria-selected": String(active),
          "data-id": page.id,
          title: this.editing ? "拖动标签调整页面顺序" : page.name
        }
      });
      tab.addEventListener("click", () => void this.switchPage(page.id));
      tab.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.showPageMenu(page, event);
      });
    }
    const add = this.tabsEl.createEl("button", { cls: "hp-tab hp-tab-add", attr: { type: "button", "aria-label": "新建页面", title: "新建页面" } });
    setIcon(add, "plus");
    add.addEventListener("click", () => {
      new PromptModal(this.app, { title: "新建页面", placeholder: "页面名称" }, async (name) => {
        const page: HomePage = { id: createId("page"), name, widgets: [] };
        this.plugin.settings.pages.push(page);
        await this.switchPage(page.id);
      }).open();
    });
  }

  private headerTitleEl(): HTMLElement | null {
    return this.containerEl.querySelector<HTMLElement>(":scope > .view-header .view-header-title-container");
  }

  /**
   * 页面切换器优先取代标题栏里与页面名重复的标题，不占内容区高度；
   * 用户关掉「显示标签页标题栏」时退回到页面顶部的一行文字标签。
   */
  private mountTabs(): void {
    const header = this.headerTitleEl();
    const body = this.containerEl.ownerDocument.body;
    const headerVisible = !!header && (body.hasClass("show-view-header") || body.hasClass("is-phone"));
    const visible = !this.tabsHostEl.hasClass("is-hidden");
    if (headerVisible) {
      if (this.tabsHostEl.parentElement !== header) header.appendChild(this.tabsHostEl);
    } else if (this.tabsHostEl.parentElement !== this.rootEl) {
      this.rootEl.insertBefore(this.tabsHostEl, this.rootEl.firstChild);
    }
    this.tabsHostEl.toggleClass("is-in-header", headerVisible);
    header?.toggleClass("hp-has-switcher", headerVisible && visible);
  }

  private renderToolbar(): void {
    this.toolbarEl.empty();
    this.toolbarEl.toggleClass("is-hidden", !this.editing);
    if (!this.editing) return;
    const hint = this.toolbarEl.createDiv({ cls: "hp-toolbar-hint" });
    setIcon(hint.createSpan({ cls: "hp-toolbar-hint-icon" }), "move");
    hint.createSpan({ text: "拖动卡片标题或页面标签调整顺序，拖右下角手柄调整尺寸（均支持触屏）；齿轮配置内容。" });
    const actions = this.toolbarEl.createDiv({ cls: "hp-toolbar-actions" });
    const add = actions.createEl("button", { cls: "hp-button", attr: { type: "button" } });
    setIcon(add.createSpan({ cls: "hp-button-icon" }), "plus");
    add.createSpan({ text: "添加组件" });
    add.addEventListener("click", () => this.promptAddWidget());

    const paste = actions.createEl("button", { cls: "hp-button", attr: { type: "button", title: "直接粘贴代码注册并添加新组件" } });
    setIcon(paste.createSpan({ cls: "hp-button-icon" }), "code");
    paste.createSpan({ text: "粘贴组件" });
    paste.addEventListener("click", () => this.promptPasteWidget());

    const done = actions.createEl("button", { cls: "hp-button mod-cta", attr: { type: "button" } });
    setIcon(done.createSpan({ cls: "hp-button-icon" }), "check");
    done.createSpan({ text: "完成" });
    done.addEventListener("click", () => this.toggleEditing(false));
  }

  private renderGrid(): void {
    this.stopResize?.();
    this.cardSorter?.cancel();
    for (const host of this.hosts.values()) host.dispose();
    this.hosts.clear();
    this.gridEl.empty();
    const widgets = this.page.widgets;
    if (widgets.length === 0) {
      const empty = this.gridEl.createDiv({ cls: "hp-grid-empty" });
      setIcon(empty.createDiv({ cls: "hp-grid-empty-icon" }), "layout-dashboard");
      empty.createDiv({ text: "这个页面还没有组件" });
      const button = empty.createEl("button", { cls: "hp-button mod-cta", text: "添加组件", attr: { type: "button" } });
      button.addEventListener("click", () => {
        if (!this.editing) this.toggleEditing(true);
        this.promptAddWidget();
      });
      return;
    }
    for (const widget of widgets) this.createCard(widget);
  }

  private createCard(widget: WidgetInstance, before?: HTMLElement): WidgetHost {
    const definition = getWidgetDefinition(widget.kind);
    const card = createDiv({ cls: `hp-card hp-card-${widget.kind}`, attr: { "data-id": widget.id } });
    if (before) this.gridEl.insertBefore(card, before);
    else this.gridEl.appendChild(card);
    card.style.setProperty("--hp-accent", definition?.accent ?? "#64748b");
    this.applyCardSize(card, widget);

    const header = card.createDiv({ cls: "hp-card-header" });
    const titleWrap = header.createDiv({ cls: "hp-card-title" });
    const grip = titleWrap.createSpan({ cls: "hp-card-grip", attr: { "aria-label": "拖动排序", title: "拖动调整组件顺序" } });
    setIcon(grip, "grip-vertical");
    setIcon(titleWrap.createSpan({ cls: "hp-card-icon" }), definition?.icon ?? "plug");
    titleWrap.createSpan({ cls: "hp-card-title-text", text: widgetDisplayTitle(widget) });
    const right = header.createDiv({ cls: "hp-card-header-right" });
    const subtitle = right.createSpan({ cls: "hp-card-subtitle" });
    const actions = right.createSpan({ cls: "hp-card-actions" });
    const gear = right.createEl("button", { cls: "hp-card-gear clickable-icon", attr: { type: "button", "aria-label": "配置组件" } });
    setIcon(gear, "settings");
    gear.addEventListener("click", (event) => {
      event.stopPropagation();
      this.openWidgetSettings(widget.id);
    });

    const host = new WidgetHost(this, widget, card, subtitle, actions);
    this.hosts.set(widget.id, host);
    this.renderEditBar(card, widget);
    const handle = card.createDiv({
      cls: "hp-card-resize",
      attr: { role: "button", tabindex: "0", "aria-label": "拖动调整尺寸（方向键逐格调整）", title: "拖动调整宽高" }
    });
    setIcon(handle, "move-diagonal-2");
    this.bindResize(handle, card, widget.id);
    void host.render();
    return host;
  }

  private applyCardSize(card: HTMLElement, widget: WidgetInstance): void {
    const w = Math.min(MAX_COLUMNS, Math.max(1, widget.w));
    const h = Math.min(MAX_ROWS, Math.max(1, widget.h));
    card.setAttribute("data-w", String(w));
    card.setAttribute("data-h", String(h));
    card.style.setProperty("--hp-card-w", String(w));
    card.style.setProperty("--hp-card-h", String(h));
  }

  private renderEditBar(card: HTMLElement, widget: WidgetInstance): void {
    card.querySelector(".hp-card-editbar")?.remove();
    const bar = card.createDiv({ cls: "hp-card-editbar" });
    const button = (icon: string, label: string, onClick: () => void, cls = ""): HTMLButtonElement => {
      const el = bar.createEl("button", { cls: `hp-editbtn ${cls}`.trim(), attr: { type: "button", "aria-label": label, title: label } });
      setIcon(el, icon);
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        onClick();
      });
      return el;
    };
    const group = (): HTMLElement => bar.createDiv({ cls: "hp-editbtn-group" });
    const order = group();
    order.appendChild(button("arrow-left", "前移", () => void this.moveWidget(widget.id, -1)));
    order.appendChild(button("arrow-right", "后移", () => void this.moveWidget(widget.id, 1)));
    const width = group();
    width.createSpan({ cls: "hp-editbtn-label", text: "宽" });
    width.appendChild(button("minus", "减小宽度", () => void this.resizeWidget(widget.id, -1, 0)));
    width.createSpan({ cls: "hp-editbtn-value", text: String(widget.w) });
    width.appendChild(button("plus", "增加宽度", () => void this.resizeWidget(widget.id, 1, 0)));
    const height = group();
    height.createSpan({ cls: "hp-editbtn-label", text: "高" });
    height.appendChild(button("minus", "减小高度", () => void this.resizeWidget(widget.id, 0, -1)));
    height.createSpan({ cls: "hp-editbtn-value", text: String(widget.h) });
    height.appendChild(button("plus", "增加高度", () => void this.resizeWidget(widget.id, 0, 1)));
    const misc = group();
    misc.appendChild(button("settings", "配置", () => this.openWidgetSettings(widget.id)));
    misc.appendChild(button("copy", "复制组件", () => void this.duplicateWidget(widget.id)));
    misc.appendChild(button("trash-2", "删除组件", () => this.removeWidget(widget.id), "hp-danger"));
  }

  // ---- 编辑操作 -------------------------------------------------------------

  toggleEditing(force?: boolean): void {
    const next = force ?? !this.editing;
    if (next === this.editing) return;
    this.stopResize?.();
    this.cardSorter?.cancel();
    this.tabSorter?.cancel();
    this.editing = next;
    this.rootEl.toggleClass("is-editing", this.editing);
    this.renderTabs();
    this.renderToolbar();
    if (this.page.widgets.length === 0) this.renderGrid();
  }

  promptAddWidget(): void {
    new AddWidgetModal(
      this.app,
      (kind) => this.insertWidget(kind),
      () => this.promptPasteWidget(),
      this.plugin
    ).open();
  }

  promptPasteWidget(): void {
    new PasteWidgetModal(this.app, this.plugin, (kind) => {
      // 新脚本第一次加载时已自动放上首页，这里直接打开它的配置，不再重复添加。
      const existing = this.page.widgets.find((item) => item.kind === kind);
      if (existing) this.openWidgetSettings(existing.id);
      else this.insertWidget(kind);
    }).open();
  }

  private insertWidget(kind: string): void {
    const widget = createWidgetInstance(kind);
    const page = this.page;
    page.widgets.push(widget);
    void this.plugin.saveSettings().then(() => {
      if (page.widgets.length === 1) this.renderGrid();
      else this.createCard(widget);
      this.updateHeader();
      this.openWidgetSettings(widget.id);
    });
  }

  openWidgetSettings(id: string): void {
    const widget = this.page.widgets.find((item) => item.id === id);
    if (!widget) return;
    new WidgetSettingsModal(this.app, this.plugin, widget, async (updated) => {
      const page = this.page;
      const index = page.widgets.findIndex((item) => item.id === id);
      if (index < 0) return;
      page.widgets[index] = updated;
      await this.plugin.saveSettings();
      this.replaceCard(updated);
    }).open();
  }

  /** 用新的实例数据重绘单张卡片（尺寸、标题、内容）。 */
  private replaceCard(widget: WidgetInstance): void {
    const host = this.hosts.get(widget.id);
    if (!host) {
      this.createCard(widget);
      return;
    }
    host.widget = widget;
    this.applyCardSize(host.cardEl, widget);
    host.cardEl.querySelector(".hp-card-title-text")?.setText(widgetDisplayTitle(widget));
    this.renderEditBar(host.cardEl, widget);
    void host.render();
  }

  private async resizeWidget(id: string, dw: number, dh: number): Promise<void> {
    const widget = this.page.widgets.find((item) => item.id === id);
    if (!widget) return;
    await this.setWidgetSize(id, widget.w + dw, widget.h + dh);
  }

  private async setWidgetSize(id: string, w: number, h: number): Promise<void> {
    const widget = this.page.widgets.find((item) => item.id === id);
    if (!widget) return;
    widget.w = clampSpan(w, MAX_COLUMNS);
    widget.h = clampSpan(h, MAX_ROWS);
    const host = this.hosts.get(id);
    if (host) {
      this.animateCards(() => this.applyCardSize(host.cardEl, widget));
      this.renderEditBar(host.cardEl, widget);
    }
    await this.plugin.saveSettings();
  }

  private async moveWidget(id: string, delta: number): Promise<void> {
    const widgets = this.page.widgets;
    const index = widgets.findIndex((item) => item.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= widgets.length) return;
    [widgets[index], widgets[target]] = [widgets[target], widgets[index]];
    this.animateCards(() => this.reorderCards());
    await this.plugin.saveSettings();
  }

  private async reorderWidget(id: string, beforeId: string | null): Promise<void> {
    const widgets = this.page.widgets;
    if (!moveBefore(widgets, id, beforeId)) return;
    this.reorderCards();
    await this.plugin.saveSettings();
  }

  /** 改布局时让其它卡片从原位置平滑滑到新位置（系统要求减少动态效果时直接跳变）。 */
  private animateCards(mutate: () => void): void {
    animateLayout(this.gridEl, ".hp-card", mutate);
  }

  /** 按 widgets 数组顺序重新排列已存在的卡片 DOM，不重绘内容。 */
  private reorderCards(): void {
    for (const widget of this.page.widgets) {
      const host = this.hosts.get(widget.id);
      if (host) this.gridEl.appendChild(host.cardEl);
    }
  }

  private async duplicateWidget(id: string): Promise<void> {
    const widgets = this.page.widgets;
    const index = widgets.findIndex((item) => item.id === id);
    if (index < 0) return;
    const source = widgets[index];
    const copy: WidgetInstance = { ...source, id: createId(source.kind), config: JSON.parse(JSON.stringify(source.config)) as Record<string, unknown> };
    widgets.splice(index + 1, 0, copy);
    await this.plugin.saveSettings();
    const next = widgets[index + 2];
    this.createCard(copy, next ? this.hosts.get(next.id)?.cardEl : undefined);
  }

  private removeWidget(id: string): void {
    const widget = this.page.widgets.find((item) => item.id === id);
    if (!widget) return;
    new ConfirmModal(this.app, { title: "删除组件", message: `确定删除“${widgetDisplayTitle(widget)}”？`, confirmText: "删除", danger: true }, async () => {
      const page = this.page;
      page.widgets = page.widgets.filter((item) => item.id !== id);
      await this.plugin.saveSettings();
      const host = this.hosts.get(id);
      host?.dispose();
      host?.cardEl.remove();
      this.hosts.delete(id);
      if (page.widgets.length === 0) this.renderGrid();
    }).open();
  }

  // ---- 页面 ----------------------------------------------------------------

  async switchPage(id: string): Promise<void> {
    if (!this.plugin.settings.pages.some((page) => page.id === id)) return;
    this.stopResize?.();
    this.cardSorter?.cancel();
    this.tabSorter?.cancel();
    this.plugin.settings.activePageId = id;
    await this.plugin.saveSettings();
    this.render();
  }

  private showPageMenu(page: HomePage, event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("重命名").setIcon("pencil").onClick(() => {
      new PromptModal(this.app, { title: "重命名页面", value: page.name }, async (name) => {
        page.name = name;
        await this.plugin.saveSettings();
        this.applyLayout();
      }).open();
    }));
    menu.addItem((item) => item.setTitle("向左移动").setIcon("arrow-left").onClick(() => void this.movePage(page.id, -1)));
    menu.addItem((item) => item.setTitle("向右移动").setIcon("arrow-right").onClick(() => void this.movePage(page.id, 1)));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("删除页面").setIcon("trash-2").setDisabled(this.plugin.settings.pages.length <= 1).onClick(() => {
      new ConfirmModal(this.app, { title: "删除页面", message: `确定删除页面“${page.name}”及其 ${page.widgets.length} 个组件？`, confirmText: "删除", danger: true }, async () => {
        const settings = this.plugin.settings;
        settings.pages = settings.pages.filter((item) => item.id !== page.id);
        if (settings.activePageId === page.id) settings.activePageId = settings.pages[0].id;
        await this.plugin.saveSettings();
        this.render();
      }).open();
    }));
    menu.showAtMouseEvent(event);
  }

  private async movePage(id: string, delta: number): Promise<void> {
    const pages = this.plugin.settings.pages;
    const index = pages.findIndex((page) => page.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= pages.length) return;
    [pages[index], pages[target]] = [pages[target], pages[index]];
    this.renderTabs();
    await this.plugin.saveSettings();
  }

  private async reorderPage(id: string, beforeId: string | null): Promise<void> {
    if (!moveBefore(this.plugin.settings.pages, id, beforeId)) return;
    this.renderTabs();
    await this.plugin.saveSettings();
  }

  // ---- 刷新 ----------------------------------------------------------------

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      // 用户正在卡片里输入（例如新增待办）时推迟刷新，避免输入框被销毁。
      const active = document.activeElement;
      if (active && this.contentEl.contains(active) && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
        this.scheduleRefresh();
        return;
      }
      this.refreshWidgets();
    }, REFRESH_DEBOUNCE_MS);
  }

  /** 只重绘某一类组件（含标题栏图标 / 名称）。 */
  refreshKind(kind: string): void {
    for (const host of this.hosts.values()) {
      if (host.widget.kind !== kind) continue;
      const definition = getWidgetDefinition(kind);
      const icon = host.cardEl.querySelector(".hp-card-icon");
      if (icon instanceof HTMLElement) {
        icon.empty();
        setIcon(icon, definition?.icon ?? "plug");
      }
      host.cardEl.style.setProperty("--hp-accent", definition?.accent ?? "#64748b");
      host.cardEl.querySelector(".hp-card-title-text")?.setText(widgetDisplayTitle(host.widget));
      void host.render();
    }
  }

  /** 重绘所有组件内容（不动布局）。 */
  refreshWidgets(): void {
    for (const host of this.hosts.values()) {
      const definition = getWidgetDefinition(host.widget.kind);
      if (definition?.liveRefresh === false) continue;
      void host.render();
    }
  }

  // ---- 拖拽缩放 -------------------------------------------------------------

  /**
   * 右下角手柄：按住拖动，宽度按列、高度按行吸附，松手保存；Esc 或指针中断则恢复原尺寸。
   * 窄屏时网格不是 12 列、卡片总是占满一行，只允许调高度。键盘聚焦手柄后可用方向键逐格调整。
   */
  private bindResize(handle: HTMLElement, card: HTMLElement, id: string): void {
    handle.addEventListener("keydown", (event) => {
      if (!this.editing) return;
      const widget = this.page.widgets.find((item) => item.id === id);
      const delta: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const step = delta[event.key];
      if (!widget || !step) return;
      event.preventDefault();
      void this.setWidgetSize(id, widget.w + step[0], widget.h + step[1]);
    });
    handle.addEventListener("pointerdown", (event) => {
      if (!this.editing || event.button !== 0 || !event.isPrimary || this.stopResize) return;
      const widget = this.page.widgets.find((item) => item.id === id);
      if (!widget) return;
      event.preventDefault();
      event.stopPropagation();
      this.cardSorter?.cancel();

      const grid = getComputedStyle(this.gridEl);
      const tracks = grid.gridTemplateColumns.split(" ").filter(Boolean);
      const colUnit = (parseFloat(tracks[0]) || 0) + (parseFloat(grid.columnGap) || 0);
      const rowUnit = (parseFloat(grid.gridAutoRows) || this.plugin.settings.rowHeight) + (parseFloat(grid.rowGap) || 0);
      const lockWidth = tracks.length !== MAX_COLUMNS || colUnit <= 0;
      const start = { x: event.clientX, y: event.clientY, w: widget.w, h: widget.h };
      let size = { w: widget.w, h: widget.h };

      const badge = card.createDiv({ cls: "hp-card-size-badge" });
      // 虚线框逐像素跟着指针，卡片本身按列 / 行吸附，其它卡片平滑让位。
      const startRect = card.getBoundingClientRect();
      const frame = this.rootEl.createDiv({ cls: "hp-resize-frame" });
      const minWidth = lockWidth ? startRect.width : Math.max(24, colUnit - (parseFloat(grid.columnGap) || 0));
      const minHeight = Math.max(24, rowUnit - (parseFloat(grid.rowGap) || 0));
      const moveFrame = (x: number, y: number): void => {
        const root = this.rootEl.getBoundingClientRect();
        frame.style.transform = `translate3d(${startRect.left - root.left}px, ${startRect.top - root.top}px, 0)`;
        frame.style.width = `${Math.max(minWidth, lockWidth ? startRect.width : startRect.width + x - start.x)}px`;
        frame.style.height = `${Math.max(minHeight, startRect.height + y - start.y)}px`;
      };
      const paint = (): void => {
        badge.setText(lockWidth ? `高 ${size.h} 行` : `${size.w} 列 × ${size.h} 行`);
        this.animateCards(() => this.applyCardSize(card, { ...widget, ...size }));
      };
      card.addClass("is-resizing");
      this.rootEl.addClass("is-resizing");
      handle.setPointerCapture(event.pointerId);
      moveFrame(start.x, start.y);
      badge.setText(lockWidth ? `高 ${size.h} 行` : `${size.w} 列 × ${size.h} 行`);

      const onMove = (move: PointerEvent): void => {
        if (move.pointerId !== event.pointerId) return;
        move.preventDefault();
        moveFrame(move.clientX, move.clientY);
        const w = lockWidth ? start.w : clampSpan(start.w + Math.round((move.clientX - start.x) / colUnit), MAX_COLUMNS);
        const h = clampSpan(start.h + Math.round((move.clientY - start.y) / rowUnit), MAX_ROWS);
        if (w === size.w && h === size.h) return;
        size = { w, h };
        paint();
      };
      const finish = (commit: boolean): void => {
        this.stopResize = null;
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onCancel);
        handle.removeEventListener("lostpointercapture", onCancel);
        handle.ownerDocument.removeEventListener("keydown", onKey, true);
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        badge.remove();
        frame.remove();
        card.removeClass("is-resizing");
        this.rootEl.removeClass("is-resizing");
        if (commit && (size.w !== start.w || size.h !== start.h)) void this.setWidgetSize(id, size.w, size.h);
        else this.animateCards(() => this.applyCardSize(card, widget));
      };
      const onUp = (up: PointerEvent): void => {
        if (up.pointerId === event.pointerId) finish(true);
      };
      const onCancel = (cancel: PointerEvent): void => {
        if (cancel.pointerId === event.pointerId) finish(false);
      };
      const onKey = (key: KeyboardEvent): void => {
        if (key.key !== "Escape") return;
        key.preventDefault();
        key.stopPropagation();
        finish(false);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onCancel);
      handle.addEventListener("lostpointercapture", onCancel);
      handle.ownerDocument.addEventListener("keydown", onKey, true);
      this.stopResize = () => finish(false);
    });
  }

  // ---- 拖拽排序 -------------------------------------------------------------

  private bindSorting(): void {
    this.cardSorter = new PointerSorter(this.gridEl, {
      itemSelector: ".hp-card",
      canStart: (event, card) => {
        if (!this.editing) return false;
        const target = event.target as Element;
        if (target.closest("button, input, textarea, select, a, [contenteditable], .hp-card-editbar, .hp-card-resize")) return false;
        // Touch scrolling remains available in the body; the title/grip starts a drag.
        return event.pointerType === "mouse" || target.closest(".hp-card-header")?.closest(".hp-card") === card;
      },
      onReorder: (id, beforeId) => void this.reorderWidget(id, beforeId),
      scrollContainer: this.contentEl
    });
    // 页面切换器多数时候挂在视图标题栏里（contentEl 之外），不能拿 contentEl 当可放置范围。
    this.tabSorter = new PointerSorter(this.tabsEl, {
      itemSelector: ".hp-tab[data-id]",
      canStart: () => this.editing,
      onReorder: (id, beforeId) => void this.reorderPage(id, beforeId)
    });
  }
}
