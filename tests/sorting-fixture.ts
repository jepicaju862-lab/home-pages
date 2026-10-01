import { HomeView } from "../src/view";
import { moveBefore } from "../src/ui/sortable";
import type HomePagesPlugin from "../src/main";
import type { HomePage, WidgetInstance } from "../src/types";
import type { WorkspaceLeaf } from "obsidian";

// Minimal Obsidian DOM helpers; the view and sorting controller are the real implementations.
function createElement(tag: string, options: DomElementInfo = {}): HTMLElement {
  const element = document.createElement(tag);
  if (options.cls) element.className = Array.isArray(options.cls) ? options.cls.join(" ") : options.cls;
  if (options.text) element.textContent = options.text;
  for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, String(value));
  return element;
}
Object.assign(HTMLElement.prototype, {
  createEl(this: HTMLElement, tag: string, options: DomElementInfo) { return this.appendChild(createElement(tag, options)); },
  createDiv(this: HTMLElement, options: DomElementInfo) { return this.appendChild(createElement("div", options)); },
  createSpan(this: HTMLElement, options: DomElementInfo) { return this.appendChild(createElement("span", options)); },
  empty(this: HTMLElement) { this.replaceChildren(); },
  addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
  removeClass(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); },
  toggleClass(this: HTMLElement, name: string, enabled: boolean) { this.classList.toggle(name, enabled); },
  hasClass(this: HTMLElement, name: string) { return this.classList.contains(name); },
  setText(this: HTMLElement, value: string) { this.textContent = value; }
});
Object.assign(globalThis, { createDiv: (options: DomElementInfo) => createElement("div", options) });

let view: HomeView | undefined;
let saved: string[][] = [];
let pages: HomePage[];
let settings: HomePagesPlugin["settings"];

async function reset(options: { editing?: boolean; widths?: number[]; count?: number } = {}): Promise<void> {
  await view?.onClose();
  document.body.replaceChildren();
  const savedForSession = saved = [];
  const widths = options.widths ?? Array(options.count ?? 4).fill(6) as number[];
  const widgets: WidgetInstance[] = widths.map((w, index) => ({
    id: String.fromCharCode(97 + index), kind: "test-missing-widget", title: `Card ${index + 1}`, w, h: 4, config: { preserved: index }
  }));
  pages = [
    { id: "p1", name: "Page 1", widgets },
    { id: "p2", name: "Page 2", widgets: [{ ...widgets[0], id: "other", config: { other: true } }] },
    { id: "p3", name: "Page 3", widgets: [] }
  ];
  settings = { version: 1, pages, activePageId: "p1", rowHeight: 40, gap: 16, maxWidth: 1400,
    alwaysShowPageTabs: true, openOnStartup: false, openInNewTab: true, customWidgetsFolder: "" };
  const contentEl = document.body.appendChild(createElement("div"));
  contentEl.style.height = "550px";
  const app = { vault: { on: () => ({}) }, metadataCache: { on: () => ({}) }, workspace: { on: () => ({}) } };
  const plugin = {
    settings, getActivePage: () => pages.find((page) => page.id === settings.activePageId)!,
    saveSettings: async () => { await new Promise((resolve) => setTimeout(resolve, 200)); savedForSession.push(plugin.getActivePage().widgets.map((item) => item.id)); },
    openSettings: () => undefined
  };
  view = new HomeView({ app, contentEl, updateHeader: () => undefined } as unknown as WorkspaceLeaf, plugin as unknown as HomePagesPlugin);
  // No view header in the fixture: the page switcher stays at the top of the page.
  (view as unknown as { containerEl: HTMLElement }).containerEl = contentEl;
  await view.onOpen();
  if (options.editing !== false) view.toggleEditing(true);
}

Object.assign(window, { fixture: {
  reset,
  order: () => pages[0].widgets.map((item) => item.id),
  pageOrder: () => pages.map((page) => page.id),
  saved: () => saved,
  activePage: () => settings.activePageId,
  configs: () => pages[0].widgets.map((item) => item.config),
  sizes: () => pages[0].widgets.map((item) => `${item.w}x${item.h}`).join(" "),
  editing: (enabled: boolean) => view?.toggleEditing(enabled),
  switchPage: (id: string) => view?.switchPage(id),
  close: () => view?.onClose(),
  moveBefore
} });
