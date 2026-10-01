import type { App, Component } from "obsidian";
import type HomePagesPlugin from "../main";
import type { WidgetInstance, WidgetKind } from "../types";

/** 组件渲染时拿到的上下文：数据访问、持久化、生命周期。 */
export interface WidgetContext<C> {
  app: App;
  plugin: HomePagesPlugin;
  widget: WidgetInstance;
  /** 已与默认值合并过的配置。 */
  config: C;
  /** 宿主 Component（MarkdownRenderer 等需要）。 */
  component: Component;
  /** 更新配置并持久化（不会自动重绘，需要时调用 rerender）。 */
  saveConfig(patch: Partial<C>): Promise<void>;
  /** 重新渲染本组件。 */
  rerender(): void;
  /** 打开库内文件/文件夹；带 event 时支持 ctrl/cmd 点击新标签页打开。 */
  openPath(path: string, options?: { line?: number; event?: MouseEvent | KeyboardEvent; newLeaf?: boolean }): Promise<void>;
  /** 设置卡片标题栏右侧的副标题。 */
  setSubtitle(text: string): void;
  /** 在卡片标题栏（齿轮左侧）加一个图标按钮；重绘时自动清除。 */
  addHeaderAction(icon: string, label: string, onClick: (event: MouseEvent) => void): HTMLElement;
  /** 注册定时器；组件重绘或卸载时自动清除。 */
  registerInterval(callback: () => void, ms: number): void;
  /** 注册清理函数；组件重绘或卸载时调用。 */
  registerCleanup(callback: () => void): void;
  /** 渲染是否仍然有效（异步加载完成后用来判断是否已被重绘）。 */
  isAlive(): boolean;
  /** 是否处于布局编辑模式。 */
  isEditing(): boolean;
  /** 暂时隐藏整张卡片（没有内容可显示时）；编辑布局时仍会显示，便于调整。每次重绘前自动恢复显示。 */
  setHidden(hidden: boolean): void;
}

/** 组件配置面板的上下文：操作的是草稿，点“保存”后才写回。 */
export interface WidgetSettingsContext<C> {
  app: App;
  plugin: HomePagesPlugin;
  config: C;
  /** 修改草稿。 */
  update(patch: Partial<C>): void;
  /** 重新绘制配置面板（列表增删后用）。 */
  refresh(): void;
}

export interface WidgetDefinition<C = Record<string, unknown>> {
  kind: WidgetKind;
  name: string;
  description: string;
  /** lucide 图标名。 */
  icon: string;
  /** 主题色（十六进制）。 */
  accent: string;
  defaultSize: { w: number; h: number };
  defaultConfig(): C;
  /** 把持久化的 config 合并成完整配置（缺省值补齐、类型纠正）。 */
  normalizeConfig?(raw: Record<string, unknown>): C;
  render(body: HTMLElement, ctx: WidgetContext<C>): Promise<void> | void;
  renderSettings(container: HTMLElement, ctx: WidgetSettingsContext<C>): void;
  /** 库文件变化时是否需要重绘（默认 true）。 */
  liveRefresh?: boolean;
}

export function normalizeWith<C extends Record<string, unknown>>(defaults: C, raw: Record<string, unknown>): C {
  const result: Record<string, unknown> = { ...defaults };
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof fallback === "number") {
      const parsed = typeof value === "number" ? value : Number(value);
      if (Number.isFinite(parsed)) result[key] = parsed;
    } else if (typeof fallback === "boolean") {
      result[key] = value === true || value === "true";
    } else if (typeof fallback === "string") {
      result[key] = String(value);
    } else if (Array.isArray(fallback)) {
      if (Array.isArray(value)) result[key] = value;
    } else if (typeof fallback === "object" && fallback !== null) {
      if (typeof value === "object" && !Array.isArray(value)) result[key] = value;
    } else {
      result[key] = value;
    }
  }
  return result as C;
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function toStringList(value: unknown, max = 50): string[] {
  const list = Array.isArray(value)
    ? value.map((item) => String(item ?? "").trim())
    : typeof value === "string"
      ? value.split(/[\n,，]/g).map((item) => item.trim())
      : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of list) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= max) break;
  }
  return result;
}
