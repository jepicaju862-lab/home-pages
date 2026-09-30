// 测试用的 obsidian 模块桩：只提供被测模块 import 时需要存在的符号。
if (typeof (globalThis as unknown as { window?: unknown }).window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = globalThis;
}

export class TAbstractFile {
  path = "";
  name = "";
  parent: TFolder | null = null;
}
export class TFile extends TAbstractFile {
  basename = "";
  extension = "";
  stat = { ctime: 0, mtime: 0, size: 0 };
}
export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}
export class Component {
  addChild<T>(child: T): T {
    return child;
  }
  removeChild<T>(child: T): T {
    return child;
  }
}
export class ItemView extends Component {
  app: unknown;
  contentEl: HTMLElement;
  constructor(public leaf: { app: unknown; contentEl: HTMLElement }) {
    super();
    this.app = leaf.app;
    this.contentEl = leaf.contentEl;
  }
  addAction(): void {}
  registerEvent(): void {}
  register(): void {}
}
export class Modal {
  constructor(public app: unknown) {}
  open(): void {}
  close(): void {}
}
export abstract class FuzzySuggestModal<T> extends Modal {
  setPlaceholder(_placeholder: string): void {}
  abstract getItems(): T[];
  abstract getItemText(item: T): string;
  abstract onChooseItem(item: T): void;
}
export class Notice {
  constructor(public message: string) {
    console.log("[Notice]", message);
  }
}
export class Setting {
  constructor(public containerEl: unknown) {}
  setName(): this {
    return this;
  }
  setDesc(): this {
    return this;
  }
}
export class AbstractInputSuggest<T> {
  constructor(public app: unknown, public inputEl: unknown) {}
  close(): void {}
  getSuggestions(_query: string): T[] {
    return [];
  }
}
export const MarkdownRenderer = { render: async (): Promise<void> => undefined };
export const Keymap = { isModEvent: (): boolean => false };
export function setIcon(): void {}
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
export async function requestUrl(): Promise<never> {
  throw new Error("no network in tests");
}
export class PluginSettingTab {
  containerEl = { empty(): void {}, addClass(): void {}, createEl(): unknown { return {}; }, createDiv(): unknown { return {}; } };
  constructor(public app: unknown, public plugin: unknown) {}
  display(): void {}
}
export class Menu {
  addItem(): this {
    return this;
  }
  addSeparator(): this {
    return this;
  }
  showAtMouseEvent(): void {}
  showAtPosition(): void {}
}
