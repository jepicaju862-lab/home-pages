import { AbstractInputSuggest, App, TAbstractFile, TFile, TFolder } from "obsidian";

export type PathSuggestOptions = {
  files?: boolean;
  folders?: boolean;
  /** 只列出这些扩展名（小写，不带点）；留空=所有文件。 */
  extensions?: string[];
  onSelect?: (path: string) => void;
};

/** 输入框的库内路径联想：支持文件 / 文件夹 / 按扩展名过滤。 */
export class PathSuggest extends AbstractInputSuggest<TAbstractFile> {
  constructor(app: App, private readonly inputEl: HTMLInputElement, private readonly options: PathSuggestOptions = {}) {
    super(app, inputEl);
  }

  getSuggestions(query: string): TAbstractFile[] {
    const lower = query.trim().toLowerCase();
    const wantFiles = this.options.files ?? true;
    const wantFolders = this.options.folders ?? false;
    const extensions = this.options.extensions?.map((ext) => ext.toLowerCase());
    const result: TAbstractFile[] = [];
    const walk = (folder: TFolder): void => {
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          if (wantFolders && matches(child.path, lower)) result.push(child);
          walk(child);
        } else if (child instanceof TFile && wantFiles) {
          if (extensions && !extensions.includes(child.extension.toLowerCase())) continue;
          if (matches(child.path, lower)) result.push(child);
        }
        if (result.length >= 60) return;
      }
    };
    walk(this.app.vault.getRoot());
    return result.sort((a, b) => rank(a.path, lower) - rank(b.path, lower) || a.path.localeCompare(b.path)).slice(0, 40);
  }

  renderSuggestion(value: TAbstractFile, el: HTMLElement): void {
    el.addClass("hp-suggest-item");
    el.createDiv({ cls: "hp-suggest-title", text: value instanceof TFolder ? `${value.path}/` : value.name });
    if (value.parent && value.parent.path !== "/") {
      el.createDiv({ cls: "hp-suggest-path", text: value.parent.path });
    }
  }

  selectSuggestion(value: TAbstractFile): void {
    this.inputEl.value = value.path;
    this.inputEl.trigger("input");
    this.options.onSelect?.(value.path);
    this.close();
  }
}

function matches(path: string, query: string): boolean {
  if (!query) return true;
  const lower = path.toLowerCase();
  let index = 0;
  // 子序列匹配：输入 "dn" 也能命中 "Daily Notes"。
  for (const char of query) {
    index = lower.indexOf(char, index);
    if (index < 0) return false;
    index += 1;
  }
  return true;
}

function rank(path: string, query: string): number {
  if (!query) return 0;
  const lower = path.toLowerCase();
  const name = lower.split("/").pop() ?? lower;
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  if (lower.includes(query)) return 2;
  return 3;
}
