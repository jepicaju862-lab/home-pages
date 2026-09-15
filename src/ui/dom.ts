import { setIcon } from "obsidian";

/** 统一的空状态：图标 + 一句话（+ 可选操作按钮）。 */
export function renderEmpty(
  container: HTMLElement,
  options: { icon: string; text: string; action?: { label: string; onClick: () => void } }
): HTMLElement {
  const empty = container.createDiv({ cls: "hp-empty" });
  setIcon(empty.createDiv({ cls: "hp-empty-icon" }), options.icon);
  empty.createDiv({ cls: "hp-empty-text", text: options.text });
  if (options.action) {
    const button = empty.createEl("button", { cls: "hp-pill", text: options.action.label, attr: { type: "button" } });
    button.addEventListener("click", options.action.onClick);
  }
  return empty;
}

/** 统一的 KPI 磁贴：大数字 + 说明，tone 0-3 轮换配色。 */
export function renderKpi(
  container: HTMLElement,
  options: { value: string | number; label: string; tone: number; icon?: string; onClick?: () => void; title?: string }
): HTMLElement {
  const tile = container.createDiv({ cls: `hp-kpi hp-tone-${options.tone % 4}${options.onClick ? " is-clickable" : ""}` });
  if (options.title) tile.setAttribute("title", options.title);
  if (options.icon) setIcon(tile.createSpan({ cls: "hp-kpi-icon" }), options.icon);
  tile.createDiv({ cls: "hp-kpi-value", text: String(options.value) });
  tile.createDiv({ cls: "hp-kpi-label", text: options.label });
  if (options.onClick) tile.addEventListener("click", options.onClick);
  return tile;
}
