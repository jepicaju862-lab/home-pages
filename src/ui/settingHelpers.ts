import { App, Setting, setIcon } from "obsidian";
import { PathSuggest, PathSuggestOptions } from "./PathSuggest";

/** 带库内路径联想的文本设置项。 */
export function addPathSetting(
  container: HTMLElement,
  app: App,
  options: {
    name: string;
    desc?: string;
    value: string;
    placeholder?: string;
    suggest?: PathSuggestOptions;
    onChange: (value: string) => void;
    /** 选中联想项或输入框失焦时触发（适合做一次性的重载 / 刷新，避免逐字重绘）。 */
    onCommit?: (value: string) => void;
  }
): Setting {
  const setting = new Setting(container).setName(options.name);
  if (options.desc) setting.setDesc(options.desc);
  setting.addText((text) => {
    text.setValue(options.value).onChange((value) => options.onChange(value.trim()));
    if (options.placeholder) text.setPlaceholder(options.placeholder);
    text.inputEl.addClass("hp-setting-input-wide");
    // 选中联想项时 PathSuggest 会触发 input 事件，TextComponent 的 onChange 随之生效。
    new PathSuggest(app, text.inputEl, {
      ...options.suggest,
      onSelect: (path) => {
        options.suggest?.onSelect?.(path);
        options.onCommit?.(path);
      }
    });
    if (options.onCommit) {
      text.inputEl.addEventListener("blur", () => options.onCommit?.(text.inputEl.value.trim()));
    }
  });
  return setting;
}

/** 日期设置项（原生 date 输入框，值为 YYYY-MM-DD）。 */
export function addDateSetting(
  container: HTMLElement,
  options: { name: string; desc?: string; value: string; onChange: (value: string) => void }
): Setting {
  const setting = new Setting(container).setName(options.name);
  if (options.desc) setting.setDesc(options.desc);
  setting.addText((text) => {
    text.inputEl.type = "date";
    text.setValue(options.value).onChange((value) => options.onChange(value.trim()));
  });
  return setting;
}

export function addNumberSetting(
  container: HTMLElement,
  options: { name: string; desc?: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }
): Setting {
  const setting = new Setting(container).setName(options.name);
  if (options.desc) setting.setDesc(options.desc);
  setting.addSlider((slider) => {
    slider
      .setLimits(options.min, options.max, options.step ?? 1)
      .setValue(options.value)
      .setDynamicTooltip()
      .onChange((value) => options.onChange(value));
  });
  return setting;
}

/** 多行文本设置项（一行一项的列表编辑）。 */
export function addTextareaSetting(
  container: HTMLElement,
  options: { name: string; desc?: string; value: string; placeholder?: string; rows?: number; onChange: (value: string) => void }
): Setting {
  const setting = new Setting(container).setName(options.name);
  if (options.desc) setting.setDesc(options.desc);
  setting.addTextArea((area) => {
    area.setValue(options.value).onChange((value) => options.onChange(value));
    if (options.placeholder) area.setPlaceholder(options.placeholder);
    area.inputEl.rows = options.rows ?? 4;
    area.inputEl.addClass("hp-setting-textarea");
  });
  return setting;
}

/** lucide 图标名输入框，右侧实时预览。 */
export function addIconSetting(
  container: HTMLElement,
  options: { name: string; desc?: string; value: string; onChange: (value: string) => void }
): Setting {
  const setting = new Setting(container).setName(options.name);
  setting.setDesc(options.desc ?? "lucide 图标名，例如 file-text / folder / star / calendar");
  const preview = setting.controlEl.createSpan({ cls: "hp-icon-preview" });
  const paint = (name: string): void => {
    preview.empty();
    if (name.trim()) setIcon(preview, name.trim());
  };
  paint(options.value);
  setting.addText((text) => {
    text.setValue(options.value).onChange((value) => {
      options.onChange(value.trim());
      paint(value);
    });
    text.inputEl.addClass("hp-setting-input-narrow");
  });
  return setting;
}

export function addSectionHeading(container: HTMLElement, text: string): void {
  container.createEl("h4", { cls: "hp-settings-heading", text });
}
