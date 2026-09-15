import { Notice } from "obsidian";
import type HomePagesPlugin from "./main";
import { renderEmpty, renderKpi } from "./ui/dom";
import { openPath } from "./utils/vault";
import { createWidgetInstance, getWidgetDefinition, listWidgetDefinitions, registerWidget } from "./widgets/registry";
import type { WidgetDefinition } from "./widgets/types";

/**
 * Home Pages 对外 API：其他插件把自己的首页组件注册进来，首页只做宿主。
 *
 *   const api = app.plugins.plugins["home-pages"]?.api;
 *   api?.registerWidget(definition, "duowei-table-pro");
 *
 * 首页可能晚于调用方加载：首页就绪时会触发 workspace 事件 "home-pages:ready"（参数为 api）。
 */
export interface HomePagesApi {
  version: 1;
  /** 注册一个组件（同 kind 覆盖）；返回注销函数。provider 是提供方插件 id，用于插件未加载时的占位提示。 */
  registerWidget(definition: WidgetDefinition<Record<string, unknown>>, provider?: string): () => void;
  /** 已注册的组件 kind 列表。 */
  listWidgetKinds(): string[];
  /** 把某类组件追加到当前首页（已存在时可选择只刷新），并可立即打开首页。 */
  pinWidget(
    kind: string,
    config?: Record<string, unknown>,
    options?: { title?: string; w?: number; h?: number; provider?: string; open?: boolean; allowDuplicate?: boolean }
  ): Promise<void>;
  /** 让首页重绘某类组件（不传 kind 则全部）。 */
  refresh(kind?: string): void;
  /** 打开库内文件 / 文件夹。 */
  openPath: typeof openPath;
  /** 与内置组件同款的 UI 助手，保证视觉一致。 */
  ui: { renderKpi: typeof renderKpi; renderEmpty: typeof renderEmpty };
}

export function createApi(plugin: HomePagesPlugin): HomePagesApi {
  return {
    version: 1,
    registerWidget: (definition, provider) => {
      const unregister = registerWidget(definition, provider);
      plugin.refreshViews({ kind: definition.kind });
      return () => {
        unregister();
        plugin.refreshViews({ kind: definition.kind });
      };
    },
    listWidgetKinds: () => listWidgetDefinitions().map((definition) => definition.kind),
    pinWidget: async (kind, config = {}, options = {}) => {
      const page = plugin.getActivePage();
      const same = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => JSON.stringify(a) === JSON.stringify(b);
      const existing = options.allowDuplicate ? undefined : page.widgets.find((widget) => widget.kind === kind && same(widget.config, config));
      if (!existing) {
        const widget = createWidgetInstance(kind, { config, title: options.title, w: options.w, h: options.h });
        if (options.provider) widget.provider = options.provider;
        page.widgets.push(widget);
        await plugin.saveSettings();
        plugin.refreshViews();
        new Notice(`已固定到首页：${options.title ?? getWidgetDefinition(kind)?.name ?? kind}`);
      } else {
        new Notice("首页上已经有同样的组件了");
      }
      if (options.open !== false) await plugin.openHome();
    },
    refresh: (kind) => plugin.refreshViews(kind ? { kind } : {}),
    openPath: (app, path, options) => openPath(app, path, options),
    ui: { renderKpi, renderEmpty }
  };
}
