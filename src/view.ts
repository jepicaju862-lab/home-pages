import { ItemView, Menu, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type HomePagesPlugin from "./main";
import type { HomePage, WidgetInstance } from "./types";
import { createId } from "./utils/id";
import { openPath } from "./utils/vault";
import { AddWidgetModal, ConfirmModal, MAX_COLUMNS, MAX_ROWS, PromptModal, WidgetSettingsModal } from "./ui/modals";
import { createWidgetInstance, getWidgetDefinition, getWidgetProvider, normalizeWidgetConfig, onRegistryChange, widgetDisplayTitle } from "./widgets/registry";
import { renderEmpty } from "./ui/dom";
import type { WidgetContext } from "./widgets/types";

export const VIEW_TYPE_HOME = "home-pages-view";
const DRAG_MIME = "application/x-home-pages-widget";
const REFRESH_DEBOUNCE_MS = 900;

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
  private tabsEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private gridEl!: HTMLElement;
  private refreshTimer: number | null = null;
  private dragId: string | null = null;

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
    this.tabsEl = this.rootEl.createDiv({ cls: "hp-tabs" });
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

    this.bindGridDrop();
    // 第三方插件（多维表格等）晚于首页加载时，注册后立刻把占位卡片换成真实内容。
    const offRegistry = onRegistryChange((kind) => this.refreshKind(kind));
    this.register(offRegistry);
    this.render();
  }

  async onClose(): Promise<void> {
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
    const { pages, alwaysShowPageTabs } = this.plugin.settings;
    this.tabsEl.empty();
    const show = alwaysShowPageTabs || pages.length > 1 || this.editing;
    this.tabsEl.toggleClass("is-hidden", !show);
    if (!show) return;
    for (const page of pages) {
      const tab = this.tabsEl.createEl("button", {
        cls: `hp-tab${page.id === this.page.id ? " is-active" : ""}`,
        text: page.name,
        attr: { type: "button" }
      });
      tab.addEventListener("click", () => void this.switchPage(page.id));
      tab.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.showPageMenu(page, event);
      });
    }
    if (this.editing) {
      const add = this.tabsEl.createEl("button", { cls: "hp-tab hp-tab-add", attr: { type: "button", "aria-label": "新建页面" } });
      setIcon(add, "plus");
      add.addEventListener("click", () => {
        new PromptModal(this.app, { title: "新建页面", placeholder: "页面名称" }, async (name) => {
          const page: HomePage = { id: createId("page"), name, widgets: [] };
          this.plugin.settings.pages.push(page);
          await this.switchPage(page.id);
        }).open();
      });
    }
  }

  private renderToolbar(): void {
    this.toolbarEl.empty();
    this.toolbarEl.toggleClass("is-hidden", !this.editing);
    if (!this.editing) return;
    const hint = this.toolbarEl.createDiv({ cls: "hp-toolbar-hint" });
    setIcon(hint.createSpan({ cls: "hp-toolbar-hint-icon" }), "move");
    hint.createSpan({ text: "拖动卡片调整顺序，用卡片底部按钮调整尺寸；齿轮可配置组件内容。" });
    const actions = this.toolbarEl.createDiv({ cls: "hp-toolbar-actions" });
    const add = actions.createEl("button", { cls: "hp-button", attr: { type: "button" } });
    setIcon(add.createSpan({ cls: "hp-button-icon" }), "plus");
    add.createSpan({ text: "添加组件" });
    add.addEventListener("click", () => this.promptAddWidget());
    const done = actions.createEl("button", { cls: "hp-button mod-cta", attr: { type: "button" } });
    setIcon(done.createSpan({ cls: "hp-button-icon" }), "check");
    done.createSpan({ text: "完成" });
    done.addEventListener("click", () => this.toggleEditing(false));
  }

  private renderGrid(): void {
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
    const grip = titleWrap.createSpan({ cls: "hp-card-grip", attr: { "aria-label": "拖动排序" } });
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
    this.bindCardDrag(card, widget);
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
    card.style.gridColumn = `span ${w}`;
    card.style.gridRow = `span ${h}`;
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
    this.editing = next;
    this.rootEl.toggleClass("is-editing", this.editing);
    this.renderTabs();
    this.renderToolbar();
    for (const host of this.hosts.values()) host.cardEl.setAttribute("draggable", this.editing ? "true" : "false");
    if (this.page.widgets.length === 0) this.renderGrid();
  }

  promptAddWidget(): void {
    new AddWidgetModal(this.app, (kind) => {
      const widget = createWidgetInstance(kind);
      const page = this.page;
      page.widgets.push(widget);
      void this.plugin.saveSettings().then(() => {
        if (page.widgets.length === 1) this.renderGrid();
        else this.createCard(widget);
        this.updateHeader();
        this.openWidgetSettings(widget.id);
      });
    }).open();
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
    widget.w = Math.min(MAX_COLUMNS, Math.max(1, widget.w + dw));
    widget.h = Math.min(MAX_ROWS, Math.max(1, widget.h + dh));
    await this.plugin.saveSettings();
    const host = this.hosts.get(id);
    if (!host) return;
    this.applyCardSize(host.cardEl, widget);
    this.renderEditBar(host.cardEl, widget);
  }

  private async moveWidget(id: string, delta: number): Promise<void> {
    const widgets = this.page.widgets;
    const index = widgets.findIndex((item) => item.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= widgets.length) return;
    [widgets[index], widgets[target]] = [widgets[target], widgets[index]];
    await this.plugin.saveSettings();
    this.reorderCards();
  }

  private async reorderWidget(id: string, beforeId: string | null): Promise<void> {
    const widgets = this.page.widgets;
    const from = widgets.findIndex((item) => item.id === id);
    if (from < 0) return;
    const [moved] = widgets.splice(from, 1);
    const to = beforeId ? widgets.findIndex((item) => item.id === beforeId) : widgets.length;
    widgets.splice(to < 0 ? widgets.length : to, 0, moved);
    await this.plugin.saveSettings();
    this.reorderCards();
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
    await this.plugin.saveSettings();
    this.renderTabs();
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

  // ---- 拖拽排序 -------------------------------------------------------------

  private bindCardDrag(card: HTMLElement, widget: WidgetInstance): void {
    card.setAttribute("draggable", this.editing ? "true" : "false");
    card.addEventListener("dragstart", (event) => {
      if (!this.editing) {
        event.preventDefault();
        return;
      }
      this.dragId = widget.id;
      event.dataTransfer?.setData(DRAG_MIME, widget.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      card.addClass("is-dragging");
    });
    card.addEventListener("dragend", () => {
      this.dragId = null;
      card.removeClass("is-dragging");
      this.clearDropMarkers();
    });
    card.addEventListener("dragover", (event) => {
      if (!this.dragId || this.dragId === widget.id) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      const rect = card.getBoundingClientRect();
      const after = event.clientX - rect.left > rect.width / 2;
      this.clearDropMarkers();
      card.addClass(after ? "drop-after" : "drop-before");
    });
    card.addEventListener("dragleave", () => card.removeClass("drop-before", "drop-after"));
    card.addEventListener("drop", (event) => {
      if (!this.dragId || this.dragId === widget.id) return;
      event.preventDefault();
      event.stopPropagation();
      const after = card.hasClass("drop-after");
      const draggedId = this.dragId;
      this.clearDropMarkers();
      const widgets = this.page.widgets;
      const targetIndex = widgets.findIndex((item) => item.id === widget.id);
      const beforeId = after ? (widgets[targetIndex + 1]?.id ?? null) : widget.id;
      if (beforeId === draggedId) return;
      void this.reorderWidget(draggedId, beforeId);
    });
  }

  private bindGridDrop(): void {
    this.gridEl.addEventListener("dragover", (event) => {
      if (!this.dragId) return;
      event.preventDefault();
    });
    this.gridEl.addEventListener("drop", (event) => {
      if (!this.dragId) return;
      event.preventDefault();
      const draggedId = this.dragId;
      this.clearDropMarkers();
      void this.reorderWidget(draggedId, null);
    });
  }

  private clearDropMarkers(): void {
    for (const host of this.hosts.values()) host.cardEl.removeClass("drop-before", "drop-after");
  }
}
