import { Setting, TFile, setIcon } from "obsidian";
import { clockLabel, dateLabel, daysBetweenToday, greetingForHour, greetingIcon, isIsoDate } from "../utils/date";
import { earliestVaultDay, getTagCount } from "../utils/vault";
import { WeatherQuery, WeatherSource, fetchWeather, isWeatherSource, searchWeatherLocations } from "../utils/weather";
import { addDateSetting, addPathSetting, addSectionHeading } from "../ui/settingHelpers";
import { WidgetDefinition, WidgetSettingsContext, normalizeWith } from "./types";

export interface HeroConfig extends Record<string, unknown> {
  name: string;
  city: string;
  /** 天气数据源：中国气象局（默认，县区级）/ Open-Meteo / 和风天气。 */
  weatherSource: WeatherSource;
  /** 选定的位置 id（站号 / LocationID / 坐标）；留空按城市名自动匹配。 */
  weatherLocation: string;
  weatherLocationLabel: string;
  qweatherHost: string;
  qweatherKey: string;
  image: string;
  showGreeting: boolean;
  showMeta: boolean;
  showClock: boolean;
  showWeather: boolean;
  showVaultAge: boolean;
  showCountdown: boolean;
  /** 库龄起算日；留空自动取最早文件。 */
  since: string;
  target: string;
  targetLabel: string;
  countdownMode: "until" | "since";
}

const DEFAULTS: HeroConfig = {
  name: "",
  city: "",
  weatherSource: "cma",
  weatherLocation: "",
  weatherLocationLabel: "",
  qweatherHost: "",
  qweatherKey: "",
  image: "",
  showGreeting: true,
  showMeta: true,
  showClock: true,
  showWeather: true,
  showVaultAge: true,
  showCountdown: true,
  since: "",
  target: "",
  targetLabel: "目标",
  countdownMode: "until"
};

export const heroWidget: WidgetDefinition<HeroConfig> = {
  kind: "hero",
  name: "欢迎横幅",
  description: "问候语、实时时钟、天气、库龄与目标倒计时。",
  icon: "sunrise",
  accent: "#7c3aed",
  defaultSize: { w: 12, h: 4 },
  defaultConfig: () => ({ ...DEFAULTS }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    config.countdownMode = config.countdownMode === "since" ? "since" : "until";
    if (!isWeatherSource(config.weatherSource)) config.weatherSource = "cma";
    return config;
  },

  render(body, ctx) {
    const { app, config } = ctx;
    const now = new Date();
    ctx.setSubtitle(dateLabel(now));

    body.addClass("hp-hero");
    if (config.image.trim()) {
      const file = app.vault.getAbstractFileByPath(config.image.trim());
      if (file instanceof TFile) {
        body.addClass("has-image");
        body.style.setProperty("--hp-hero-image", `url("${app.vault.getResourcePath(file).replace(/["\\]/g, "")}")`);
      }
    }

    const top = body.createDiv({ cls: "hp-hero-top" });
    const left = top.createDiv({ cls: "hp-hero-left" });
    if (config.showGreeting) {
      const greeting = greetingForHour(now.getHours());
      const line = left.createDiv({ cls: "hp-hero-greeting" });
      setIcon(line.createSpan({ cls: "hp-hero-greeting-icon" }), greetingIcon(greeting));
      line.createSpan({ text: greeting });
      if (config.name.trim()) {
        line.createSpan({ text: "，" });
        line.createSpan({ cls: "hp-hero-name", text: config.name.trim() });
      }
    }
    if (config.showMeta) {
      const meta = left.createDiv({ cls: "hp-hero-meta" });
      addMeta(meta, "file-text", `${app.vault.getMarkdownFiles().length.toLocaleString()} 篇笔记`);
      addMeta(meta, "tag", `${getTagCount(app).toLocaleString()} 标签`);
    }

    const wantWeather = config.showWeather && config.city.trim().length > 0;
    if (config.showClock || wantWeather) {
      const right = top.createDiv({ cls: "hp-hero-clockbox" });
      if (config.showClock) {
        const clock = right.createDiv({ cls: "hp-hero-clock", text: clockLabel(now) });
        const date = right.createDiv({ cls: "hp-hero-date", text: dateLabel(now) });
        ctx.registerInterval(() => {
          const current = new Date();
          clock.setText(clockLabel(current));
          date.setText(dateLabel(current));
        }, 1000);
      }
      if (wantWeather) {
        const box = right.createDiv({ cls: "hp-hero-weather" });
        void fetchWeather(weatherQuery(config)).then((weather) => {
          if (!ctx.isAlive() || !weather) return;
          const line = box.createDiv({ cls: "hp-hero-weather-line" });
          setIcon(line.createSpan({ cls: "hp-hero-weather-icon" }), weather.icon);
          line.createSpan({ cls: "hp-hero-weather-temp", text: `${weather.tempC}°` });
          line.createSpan({ cls: "hp-hero-weather-text", text: weather.text });
          const range = weather.high !== undefined && weather.low !== undefined ? ` · ${weather.low}~${weather.high}°` : "";
          box.createDiv({ cls: "hp-hero-weather-meta", text: `体感 ${weather.feelsC}°${range} · ${weather.city}` });
          // 按名称自动匹配到的位置记下来，之后直接按 id 取，不再每次解析地名。
          if (weather.resolved && !config.weatherLocation) {
            void ctx.saveConfig({ weatherLocation: weather.resolved.id, weatherLocationLabel: `${weather.resolved.name} · ${weather.resolved.detail}` });
          }
        });
      }
    }

    const chips = body.createDiv({ cls: "hp-hero-chips" });
    if (config.showVaultAge) {
      const since = isIsoDate(config.since) ? config.since : earliestVaultDay(app);
      if (since) {
        const days = Math.max(0, -daysBetweenToday(since));
        addChip(chips, "sprout", `已耕耘知识花园 ${days.toLocaleString()} 天`, `起算日 ${since}`);
      }
    }
    if (config.showCountdown && isIsoDate(config.target)) {
      const raw = daysBetweenToday(config.target);
      const label = config.targetLabel.trim() || "目标";
      const text = config.countdownMode === "since"
        ? `${label}已过去 ${Math.abs(raw)} 天`
        : raw < 0
          ? `${label}已逾期 ${Math.abs(raw)} 天`
          : raw === 0
            ? `${label}就是今天`
            : `距${label}还有 ${raw} 天`;
      addChip(chips, "flag", text, config.target);
    }
    if (chips.childElementCount === 0) chips.remove();
  },

  renderSettings(container, ctx) {
    const { config } = ctx;
    new Setting(container).setName("称呼").setDesc("问候语里显示的名字，留空只显示时段问候。")
      .addText((text) => text.setValue(config.name).onChange((value) => ctx.update({ name: value })));
    addPathSetting(container, ctx.app, {
      name: "横幅背景图",
      desc: "库内图片路径，留空使用渐变背景。",
      value: config.image,
      suggest: { files: true, extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"] },
      onChange: (value) => ctx.update({ image: value })
    });

    addSectionHeading(container, "显示内容");
    const toggles: Array<[keyof HeroConfig, string]> = [
      ["showGreeting", "问候语"],
      ["showMeta", "笔记 / 标签数量"],
      ["showClock", "实时时钟"],
      ["showVaultAge", "库龄徽章"],
      ["showCountdown", "倒计时徽章"]
    ];
    for (const [key, label] of toggles) {
      new Setting(container).setName(label)
        .addToggle((toggle) => toggle.setValue(Boolean(config[key])).onChange((value) => ctx.update({ [key]: value } as Partial<HeroConfig>)));
    }

    addSectionHeading(container, "天气");
    new Setting(container).setName("显示天气").setDesc("需要联网；数据 30 分钟缓存一次。")
      .addToggle((toggle) => toggle.setValue(config.showWeather).onChange((value) => ctx.update({ showWeather: value })));
    new Setting(container).setName("数据源")
      .setDesc("中国气象局：国家站覆盖到县区，免密钥。Open-Meteo：全球，免密钥，中文县名需手动选站或填坐标。和风天气：需自己的 API Host 与 Key。")
      .addDropdown((dropdown) => dropdown
        .addOptions({ cma: "中国气象局（默认）", openmeteo: "Open-Meteo", qweather: "和风天气" })
        .setValue(config.weatherSource)
        .onChange((value) => {
          ctx.update({ weatherSource: isWeatherSource(value) ? value : "cma", weatherLocation: "", weatherLocationLabel: "" });
          ctx.refresh();
        }));
    if (config.weatherSource === "qweather") {
      new Setting(container).setName("和风 API Host").setDesc("控制台 → 设置里的专属地址，形如 abc123.xy.qweatherapi.com。")
        .addText((text) => {
          text.setPlaceholder("xxx.qweatherapi.com").setValue(config.qweatherHost).onChange((value) => ctx.update({ qweatherHost: value.trim() }));
          text.inputEl.addClass("hp-setting-input-wide");
        });
      new Setting(container).setName("和风 API Key")
        .addText((text) => {
          text.setValue(config.qweatherKey).onChange((value) => ctx.update({ qweatherKey: value.trim() }));
          text.inputEl.type = "password";
          text.inputEl.addClass("hp-setting-input-wide");
        });
    }
    renderCitySetting(container, ctx);

    addSectionHeading(container, "库龄与倒计时");
    addDateSetting(container, {
      name: "库龄起算日",
      desc: "留空时自动取库内最早文件的创建日期。",
      value: config.since,
      onChange: (value) => ctx.update({ since: value })
    });
    addDateSetting(container, { name: "目标日期", value: config.target, onChange: (value) => ctx.update({ target: value }) });
    new Setting(container).setName("目标名称")
      .addText((text) => text.setValue(config.targetLabel).onChange((value) => ctx.update({ targetLabel: value })));
    new Setting(container).setName("计时方向")
      .addDropdown((dropdown) => dropdown
        .addOptions({ until: "倒计时（还有 N 天）", since: "正计时（已过去 N 天）" })
        .setValue(config.countdownMode)
        .onChange((value) => ctx.update({ countdownMode: value === "since" ? "since" : "until" })));
  }
};

function weatherQuery(config: HeroConfig): WeatherQuery {
  return {
    source: config.weatherSource,
    city: config.city,
    location: config.weatherLocation,
    qweatherHost: config.qweatherHost,
    qweatherKey: config.qweatherKey
  };
}

/** 城市输入 + “查找”按钮 + 候选站点列表；选定后把位置 id 写进草稿，重名地方不会再猜错。 */
function renderCitySetting(container: HTMLElement, ctx: WidgetSettingsContext<HeroConfig>): void {
  const { config } = ctx;
  const hintBySource: Record<WeatherSource, string> = {
    cma: "例如：安吉、平谷、朝阳；重名时写“辽宁 朝阳”。留空不显示天气。",
    openmeteo: "例如：Tokyo、北京，或直接填坐标“30.63,119.71”。留空不显示天气。",
    qweather: "例如：安吉、东城；重名时写“湖州 安吉”。留空不显示天气。"
  };
  let input: HTMLInputElement | null = null;
  const setting = new Setting(container).setName("城市 / 区县").setDesc(hintBySource[config.weatherSource]);
  setting.addText((text) => {
    input = text.inputEl;
    text.setValue(config.city).onChange((value) => {
      // 改了名字就作废之前选定的站点，重新按名字匹配。
      ctx.update({ city: value.trim(), weatherLocation: "", weatherLocationLabel: "" });
      paintStatus();
    });
    text.inputEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void search();
    });
  });
  setting.addButton((button) => button.setButtonText("查找").onClick(() => void search()));

  const status = container.createDiv({ cls: "hp-weather-status" });
  const list = container.createDiv({ cls: "hp-weather-candidates" });
  const paintStatus = (): void => {
    const draft = ctx.config;
    status.setText(draft.weatherLocation
      ? `已选定：${draft.weatherLocationLabel || draft.weatherLocation}`
      : draft.city
        ? "未选定站点：会按名字自动匹配第一个结果，点“查找”可以手动挑选。"
        : "");
  };
  paintStatus();

  async function search(): Promise<void> {
    const text = (input?.value ?? ctx.config.city).trim();
    list.empty();
    if (!text) {
      status.setText("先输入城市 / 区县名。");
      return;
    }
    status.setText("查找中…");
    try {
      const results = await searchWeatherLocations(weatherQuery(ctx.config), text);
      if (results.length === 0) {
        status.setText("没找到。试试不带“县 / 区”，或换上一级城市名。");
        return;
      }
      status.setText("点一个选定：");
      for (const item of results) {
        const pill = list.createEl("button", { cls: "hp-pill hp-weather-candidate", attr: { type: "button" } });
        pill.createSpan({ cls: "hp-weather-candidate-name", text: item.name });
        if (item.detail) pill.createSpan({ cls: "hp-weather-candidate-detail", text: item.detail });
        pill.toggleClass("is-active", item.id === ctx.config.weatherLocation);
        pill.addEventListener("click", () => {
          ctx.update({ city: item.name, weatherLocation: item.id, weatherLocationLabel: `${item.name} · ${item.detail}` });
          if (input) input.value = item.name;
          for (const sibling of Array.from(list.children)) sibling.toggleClass("is-active", sibling === pill);
          paintStatus();
        });
      }
    } catch (error) {
      status.setText(`查找失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function addMeta(parent: HTMLElement, icon: string, text: string): void {
  const item = parent.createSpan({ cls: "hp-hero-meta-item" });
  setIcon(item.createSpan({ cls: "hp-hero-meta-icon" }), icon);
  item.createSpan({ text });
}

function addChip(parent: HTMLElement, icon: string, text: string, title?: string): void {
  const chip = parent.createDiv({ cls: "hp-hero-chip" });
  if (title) chip.setAttribute("title", title);
  setIcon(chip.createSpan({ cls: "hp-hero-chip-icon" }), icon);
  chip.createSpan({ text });
}
