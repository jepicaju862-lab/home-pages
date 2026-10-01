import { Notice, Plugin, WorkspaceLeaf, type EventRef } from "obsidian";
import { DEFAULT_SETTINGS, HomePagesSettingTab, createDefaultPage, sanitizeSettings } from "./settings";
import { createWidgetInstance } from "./widgets/registry";
import { resumePomodoroTimers } from "./widgets/pomodoro";
import { createApi, type HomePagesApi } from "./api";
import type { HomePage, HomePagesSettings, WidgetKind } from "./types";
import { HomeView, VIEW_TYPE_HOME } from "./view";
import { CustomWidgetManager, DeleteCustomWidgetSuggestModal, PasteWidgetModal } from "./widgets/userLoader";

type SettingApp = { setting?: { open: () => void; openTabById: (id: string) => void } };

export default class HomePagesPlugin extends Plugin {
  settings: HomePagesSettings = { ...DEFAULT_SETTINGS, pages: [createDefaultPage()] };
  /** 对外 API：其他插件用 app.plugins.plugins["home-pages"].api 注册自己的首页组件。 */
  api: HomePagesApi = createApi(this);
  /** 自定义脚本组件管理器：负责扫描指定目录、热重载与示例生成。 */
  readonly customWidgetManager = new CustomWidgetManager(this);
  private saveTimer: number | null = null;
  private pendingSave: Promise<void> | null = null;
  private resolveSave: (() => void) | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    // 番茄时钟：恢复上次仍在运行的计时（首页没打开也会到点提醒）。
    resumePomodoroTimers(this);

    this.registerView(VIEW_TYPE_HOME, (leaf) => new HomeView(leaf, this));
    this.addRibbonIcon("home", "打开首页", () => void this.openHome());
    this.addCommand({ id: "open-home", name: "打开首页", callback: () => void this.openHome() });
    this.addCommand({
      id: "toggle-edit-layout",
      name: "编辑首页布局",
      checkCallback: (checking) => {
        const view = this.getActiveHomeView();
        if (!view) return false;
        if (!checking) view.toggleEditing();
        return true;
      }
    });
    this.addCommand({
      id: "next-page",
      name: "切换到下一个首页页面",
      checkCallback: (checking) => {
        const view = this.getActiveHomeView();
        if (!view || this.settings.pages.length < 2) return false;
        if (!checking) {
          const pages = this.settings.pages;
          const index = pages.findIndex((page) => page.id === this.settings.activePageId);
          void view.switchPage(pages[(index + 1) % pages.length].id);
        }
        return true;
      }
    });
    this.addCommand({
      id: "add-source-widgets",
      name: "把「待办与日程 / 批注与复习 / 微信收件」加入当前首页",
      callback: () => void this.addSourceWidgets()
    });
    this.addCommand({
      id: "paste-custom-widget",
      name: "粘贴代码新建自定义组件",
      callback: () => new PasteWidgetModal(this.app, this).open()
    });
    this.addCommand({
      id: "delete-custom-widget",
      name: "删除自定义组件",
      callback: () => {
        const widgets = this.customWidgetManager.getLoadedWidgets();
        if (widgets.length === 0) {
          new Notice("当前没有已载入的自定义组件");
          return;
        }
        if (widgets.length === 1) {
          this.customWidgetManager.promptDeleteWidget(widgets[0].kind);
          return;
        }
        new DeleteCustomWidgetSuggestModal(this.app, widgets, (item) => {
          this.customWidgetManager.promptDeleteWidget(item.kind);
        }).open();
      }
    });
    this.addSettingTab(new HomePagesSettingTab(this.app, this));

    // 通知晚于本插件加载 / 正在监听的插件：可以注册组件了。
    (this.app.workspace as unknown as { trigger(name: string, ...data: unknown[]): void }).trigger("home-pages:ready", this.api);

    // WeChat2Ob 的 api 就绪 / 同步写完：重绘读微信消息的组件（不再依赖定时轮询它的私有日志）。
    const workspace = this.app.workspace as unknown as { on(name: string, callback: () => void): EventRef };
    // Momento（拾光）就绪 / 记录变化：微信组件里的“已收录”标记随之更新。
    for (const name of ["wechat2ob:ready", "wechat2ob:synced", "momento:ready", "momento:changed"]) {
      this.registerEvent(workspace.on(name, () => {
        this.refreshViews({ kind: "wechat" });
        this.refreshViews({ kind: "insights" });
      }));
    }

    this.customWidgetManager.registerWatcher();
    this.app.workspace.onLayoutReady(async () => {
      await this.customWidgetManager.loadAll(true);
      if (this.settings.openOnStartup && this.getHomeLeaves().length === 0) void this.openHome();
    });
  }

  onunload(): void {
    this.customWidgetManager.unloadAll();
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      const resolve = this.resolveSave;
      this.pendingSave = null;
      this.resolveSave = null;
      void this.saveData(this.settings).finally(() => resolve?.());
    }
  }

  // ---- 设置 ----------------------------------------------------------------

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as unknown;
    this.settings = sanitizeSettings(raw);
  }

  /** 合并短时间内的多次保存，避免拖拽/打卡时频繁写盘。 */
  saveSettings(): Promise<void> {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    if (!this.pendingSave) {
      this.pendingSave = new Promise<void>((resolve) => {
        this.resolveSave = resolve;
      });
    }
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      const resolve = this.resolveSave;
      this.pendingSave = null;
      this.resolveSave = null;
      this.saveData(this.settings)
        .catch((error) => console.error("Home Pages: failed to save settings", error))
        .finally(() => resolve?.());
    }, 200);
    return this.pendingSave;
  }

  getActivePage(): HomePage {
    const { pages, activePageId } = this.settings;
    const page = pages.find((item) => item.id === activePageId);
    if (page) return page;
    if (pages.length === 0) pages.push(createDefaultPage());
    this.settings.activePageId = pages[0].id;
    return pages[0];
  }

  /** 老布局升级：把三个数据源组件补到当前页（已存在的跳过）。 */
  async addSourceWidgets(): Promise<void> {
    const page = this.getActivePage();
    const wanted: Array<[WidgetKind, string]> = [["duowei", "待办与日程"], ["annotations", "批注与复习"], ["wechat", "微信收件"]];
    let added = 0;
    for (const [kind, title] of wanted) {
      if (page.widgets.some((widget) => widget.kind === kind)) continue;
      page.widgets.push(createWidgetInstance(kind, { w: 6, h: 7, title }));
      added += 1;
    }
    await this.saveSettings();
    this.refreshViews();
    new Notice(added > 0 ? `已加入 ${added} 个组件，可在“编辑布局”里调整位置` : "这三个组件已经在当前页上了");
  }

  openSettings(): void {
    const setting = (this.app as unknown as SettingApp).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  // ---- 视图 ----------------------------------------------------------------

  getHomeLeaves(): WorkspaceLeaf[] {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE_HOME);
  }

  getActiveHomeView(): HomeView | null {
    const view = this.app.workspace.getActiveViewOfType(HomeView);
    return view ?? null;
  }

  async openHome(): Promise<void> {
    const existing = this.getHomeLeaves()[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      this.app.workspace.setActiveLeaf(existing, { focus: true });
      return;
    }
    const leaf = this.settings.openInNewTab ? this.app.workspace.getLeaf("tab") : this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_HOME, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  refreshViews(options: { layoutOnly?: boolean; kind?: string } = {}): void {
    for (const leaf of this.getHomeLeaves()) {
      const view = leaf.view;
      if (!(view instanceof HomeView)) continue;
      if (options.layoutOnly) view.applyLayout();
      else if (options.kind) view.refreshKind(options.kind);
      else view.render();
    }
  }
}
