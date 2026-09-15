import { Setting } from "obsidian";
import { daysBetweenToday, isIsoDate } from "../utils/date";
import { addDateSetting } from "../ui/settingHelpers";
import { WidgetDefinition, normalizeWith } from "./types";

export interface CountdownConfig extends Record<string, unknown> {
  target: string;
  mode: "until" | "since";
  note: string;
}

const DEFAULTS: CountdownConfig = { target: "", mode: "until", note: "" };

export const countdownWidget: WidgetDefinition<CountdownConfig> = {
  kind: "countdown",
  name: "倒计时",
  description: "距离目标日还有多少天，或纪念日已过去多少天。",
  icon: "hourglass",
  accent: "#e11d48",
  defaultSize: { w: 4, h: 3 },
  defaultConfig: () => ({ ...DEFAULTS }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    config.mode = config.mode === "since" ? "since" : "until";
    return config;
  },

  render(body, ctx) {
    const { config } = ctx;
    const wrap = body.createDiv({ cls: "hp-countdown" });
    if (!isIsoDate(config.target)) {
      ctx.setSubtitle("未设置目标日");
      wrap.createDiv({ cls: "hp-empty", text: "点击右上角齿轮设置目标日期" });
      return;
    }
    ctx.setSubtitle(config.target);
    const raw = daysBetweenToday(config.target);
    const overdue = config.mode === "until" && raw < 0;
    wrap.toggleClass("is-overdue", overdue);
    wrap.toggleClass("is-today", raw === 0);
    const number = wrap.createDiv({ cls: "hp-countdown-num" });
    number.createSpan({ cls: "hp-countdown-value", text: String(Math.abs(raw)) });
    number.createSpan({ cls: "hp-countdown-unit", text: "天" });
    const verb = config.mode === "since" ? "已过去" : overdue ? "已逾期" : raw === 0 ? "就是今天" : "距目标还有";
    wrap.createDiv({ cls: "hp-countdown-label", text: `${verb} · ${config.target}` });
    if (config.note.trim()) wrap.createDiv({ cls: "hp-countdown-note", text: config.note.trim() });
  },

  renderSettings(container, ctx) {
    const { config } = ctx;
    addDateSetting(container, { name: "目标日期", value: config.target, onChange: (value) => ctx.update({ target: value }) });
    new Setting(container).setName("计时方向")
      .addDropdown((dropdown) => dropdown
        .addOptions({ until: "倒计时（还有 N 天）", since: "正计时（已过去 N 天）" })
        .setValue(config.mode)
        .onChange((value) => ctx.update({ mode: value === "since" ? "since" : "until" })));
    new Setting(container).setName("备注").setDesc("显示在数字下方的一句话。")
      .addText((text) => text.setValue(config.note).onChange((value) => ctx.update({ note: value })));
  }
};
