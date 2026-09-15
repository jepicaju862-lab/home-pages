import type { WidgetInstance, WidgetKind } from "../types";
import { createId } from "../utils/id";
import { annotationsWidget } from "./annotations";
import { countdownWidget } from "./countdown";
import { duoweiWidget } from "./duowei";
import { habitWidget } from "./habit";
import { heroWidget } from "./hero";
import { insightsWidget } from "./insights";
import { kanbanWidget } from "./kanban";
import { noteWidget } from "./note";
import { onThisDayWidget } from "./onthisday";
import { pomodoroWidget } from "./pomodoro";
import { quicklinksWidget } from "./quicklinks";
import { quoteWidget } from "./quote";
import { recentWidget } from "./recent";
import { statsWidget } from "./stats";
import { wechatWidget } from "./wechat";
import type { WidgetDefinition } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWidgetDefinition = WidgetDefinition<any>;

const DEFINITIONS: AnyWidgetDefinition[] = [
  heroWidget,
  recentWidget,
  quicklinksWidget,
  countdownWidget,
  pomodoroWidget,
  quoteWidget,
  duoweiWidget,
  annotationsWidget,
  wechatWidget,
  kanbanWidget,
  habitWidget,
  statsWidget,
  onThisDayWidget,
  noteWidget,
  insightsWidget
];

const BY_KIND = new Map<WidgetKind, AnyWidgetDefinition>(DEFINITIONS.map((definition) => [definition.kind, definition]));
const BUILTIN_KINDS = new Set<WidgetKind>(BY_KIND.keys());
/** 第三方注册的组件记录其提供方插件 id，占位卡片据此提示。 */
const PROVIDERS = new Map<WidgetKind, string>();
const listeners = new Set<(kind: WidgetKind, registered: boolean) => void>();

export function listWidgetDefinitions(): AnyWidgetDefinition[] {
  return [...BY_KIND.values()];
}

export function getWidgetDefinition(kind: WidgetKind): AnyWidgetDefinition | undefined {
  return BY_KIND.get(kind);
}

export function getWidgetProvider(kind: WidgetKind): string | undefined {
  return PROVIDERS.get(kind);
}

export function isBuiltinKind(kind: WidgetKind): boolean {
  return BUILTIN_KINDS.has(kind);
}

/** kind 只要是非空字符串就保留：第三方组件所属插件未加载时，配置不能丢。 */
export function isWidgetKind(value: unknown): value is WidgetKind {
  return typeof value === "string" && value.trim().length > 0;
}

/** 第三方插件运行时注册组件；返回注销函数。同名 kind 会被覆盖（便于插件热重载）。 */
export function registerWidget(definition: AnyWidgetDefinition, provider?: string): () => void {
  if (!isWidgetKind(definition.kind)) throw new Error("Widget kind must be a non-empty string");
  if (BUILTIN_KINDS.has(definition.kind)) throw new Error(`Widget kind "${definition.kind}" is built in and cannot be replaced`);
  BY_KIND.set(definition.kind, definition);
  if (provider) PROVIDERS.set(definition.kind, provider);
  for (const listener of listeners) listener(definition.kind, true);
  return () => unregisterWidget(definition.kind, definition);
}

export function unregisterWidget(kind: WidgetKind, definition?: AnyWidgetDefinition): void {
  if (BUILTIN_KINDS.has(kind)) return;
  if (definition && BY_KIND.get(kind) !== definition) return;
  BY_KIND.delete(kind);
  for (const listener of listeners) listener(kind, false);
}

export function onRegistryChange(listener: (kind: WidgetKind, registered: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function createWidgetInstance(kind: WidgetKind, overrides: Partial<WidgetInstance> = {}): WidgetInstance {
  const definition = BY_KIND.get(kind);
  return {
    id: overrides.id ?? createId(kind),
    kind,
    title: overrides.title,
    w: overrides.w ?? definition?.defaultSize.w ?? 6,
    h: overrides.h ?? definition?.defaultSize.h ?? 6,
    config: { ...(definition?.defaultConfig() ?? {}), ...(overrides.config ?? {}) }
  };
}

/** 把持久化的 config 合并成完整配置对象。 */
export function normalizeWidgetConfig<C = Record<string, unknown>>(widget: WidgetInstance): C {
  const definition = BY_KIND.get(widget.kind);
  if (!definition) return { ...(widget.config ?? {}) } as C;
  const raw = widget.config ?? {};
  return (definition.normalizeConfig ? definition.normalizeConfig(raw) : { ...definition.defaultConfig(), ...raw }) as C;
}

export function widgetDisplayTitle(widget: WidgetInstance): string {
  const custom = widget.title?.trim();
  if (custom) return custom;
  return BY_KIND.get(widget.kind)?.name ?? widget.kind;
}
