import { Setting, TFile, TFolder, setIcon } from "obsidian";
import { basenameOf } from "../utils/vault";
import { addIconSetting, addPathSetting, addSectionHeading } from "../ui/settingHelpers";
import { WidgetDefinition, clampInt, normalizeWith } from "./types";

export interface QuickLink {
  path: string;
  label: string;
  icon: string;
}

export interface QuicklinksConfig extends Record<string, unknown> {
  pins: QuickLink[];
  columns: number;
}

const DEFAULTS: QuicklinksConfig = { pins: [], columns: 2 };

export const quicklinksWidget: WidgetDefinition<QuicklinksConfig> = {
  kind: "quicklinks",
  name: "快捷入口",
  description: "置顶常用笔记、文件夹或任意文件的图标磁贴。",
  icon: "pin",
  accent: "#0d9488",
  defaultSize: { w: 4, h: 6 },
  defaultConfig: () => ({ pins: [], columns: 2 }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    config.columns = clampInt(config.columns, 1, 4, 2);
    config.pins = (Array.isArray(config.pins) ? config.pins : [])
      .map((pin) => {
        const item = (pin ?? {}) as Partial<QuickLink>;
        return { path: String(item.path ?? "").trim(), label: String(item.label ?? "").trim(), icon: String(item.icon ?? "").trim() };
      })
      .filter((pin) => pin.path);
    return config;
  },

  render(body, ctx) {
    const { app, config } = ctx;
    ctx.setSubtitle(`${config.pins.length} 个入口`);
    const grid = body.createDiv({ cls: "hp-quicklinks" });
    grid.style.gridTemplateColumns = `repeat(${config.columns}, minmax(0, 1fr))`;
    if (config.pins.length === 0) {
      grid.createDiv({ cls: "hp-empty", text: "点击右上角齿轮添加入口" });
      return;
    }
    config.pins.forEach((pin, index) => {
      const file = app.vault.getAbstractFileByPath(pin.path);
      const isFolder = file instanceof TFolder;
      const exists = file instanceof TFile || isFolder;
      const icon = pin.icon || (isFolder ? "folder" : "file-text");
      const cell = grid.createDiv({
        cls: `hp-quicklink${exists ? " is-clickable" : " is-missing"} hp-tone-${index % 4}`,
        attr: { title: exists ? pin.path : `不存在：${pin.path}` }
      });
      setIcon(cell.createSpan({ cls: "hp-quicklink-icon" }), icon);
      cell.createSpan({ cls: "hp-quicklink-label", text: pin.label || basenameOf(pin.path) });
      if (exists) cell.addEventListener("click", (event) => void ctx.openPath(pin.path, { event }));
    });
  },

  renderSettings(container, ctx) {
    const { config } = ctx;
    new Setting(container).setName("每行列数")
      .addDropdown((dropdown) => dropdown
        .addOptions({ "1": "1", "2": "2", "3": "3", "4": "4" })
        .setValue(String(config.columns))
        .onChange((value) => ctx.update({ columns: clampInt(value, 1, 4, 2) })));

    addSectionHeading(container, "入口列表");
    const pins = config.pins.map((pin) => ({ ...pin }));
    const commit = (): void => ctx.update({ pins: pins.map((pin) => ({ ...pin })) });

    pins.forEach((pin, index) => {
      const card = container.createDiv({ cls: "hp-pin-editor" });
      const head = card.createDiv({ cls: "hp-pin-editor-head" });
      head.createSpan({ cls: "hp-pin-editor-index", text: `#${index + 1}` });
      const actions = head.createDiv({ cls: "hp-pin-editor-actions" });
      const moveUp = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "上移", type: "button" } });
      setIcon(moveUp, "arrow-up");
      moveUp.disabled = index === 0;
      moveUp.addEventListener("click", () => {
        [pins[index - 1], pins[index]] = [pins[index], pins[index - 1]];
        commit();
        ctx.refresh();
      });
      const moveDown = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "下移", type: "button" } });
      setIcon(moveDown, "arrow-down");
      moveDown.disabled = index === pins.length - 1;
      moveDown.addEventListener("click", () => {
        [pins[index + 1], pins[index]] = [pins[index], pins[index + 1]];
        commit();
        ctx.refresh();
      });
      const remove = actions.createEl("button", { cls: "clickable-icon hp-danger", attr: { "aria-label": "删除", type: "button" } });
      setIcon(remove, "trash-2");
      remove.addEventListener("click", () => {
        pins.splice(index, 1);
        commit();
        ctx.refresh();
      });

      addPathSetting(card, ctx.app, {
        name: "路径",
        value: pin.path,
        placeholder: "笔记 / 文件夹 / 任意文件",
        suggest: { files: true, folders: true },
        onChange: (value) => {
          pin.path = value;
          commit();
        }
      });
      new Setting(card).setName("显示名称").setDesc("留空使用文件名。")
        .addText((text) => text.setValue(pin.label).onChange((value) => {
          pin.label = value.trim();
          commit();
        }));
      addIconSetting(card, {
        name: "图标",
        value: pin.icon,
        onChange: (value) => {
          pin.icon = value;
          commit();
        }
      });
    });

    new Setting(container).addButton((button) => button.setButtonText("＋ 添加入口").setCta().onClick(() => {
      pins.push({ path: "", label: "", icon: "" });
      commit();
      ctx.refresh();
    }));
  }
};
