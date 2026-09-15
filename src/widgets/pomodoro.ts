import { Notice, Setting, setIcon } from "obsidian";
import type HomePagesPlugin from "../main";
import type { WidgetInstance } from "../types";
import { toIsoDate, todayIso } from "../utils/date";
import { addNumberSetting } from "../ui/settingHelpers";
import { WidgetContext, WidgetDefinition, clampInt, normalizeWith } from "./types";

export type PomodoroPhase = "focus" | "short" | "long";
export type PomodoroState = "idle" | "running" | "paused";

/** 计时状态持久化在组件配置里：重绘、切页、重启 Obsidian 都不会丢。 */
export interface PomodoroSession {
  phase: PomodoroPhase;
  state: PomodoroState;
  /** running 时的结束时间戳（ms）。 */
  endsAt: number;
  /** paused 时的剩余毫秒。 */
  remainingMs: number;
  /** 本轮循环里已完成的番茄数（0..roundsBeforeLongBreak）。 */
  round: number;
}

export interface PomodoroConfig extends Record<string, unknown> {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  roundsBeforeLongBreak: number;
  autoStartBreak: boolean;
  autoStartFocus: boolean;
  sound: boolean;
  notify: boolean;
  /** 当前番茄要做的事（卡片里直接编辑）。 */
  task: string;
  /** 每天完成的番茄数：YYYY-MM-DD → 次数。 */
  history: Record<string, number>;
  session: PomodoroSession;
}

const KIND = "pomodoro";
const PHASES: PomodoroPhase[] = ["focus", "short", "long"];
const PHASE_LABEL: Record<PomodoroPhase, string> = { focus: "专注", short: "短休息", long: "长休息" };
const HISTORY_DAYS = 90;
/** 关着 Obsidian 时已到点超过这么久，再恢复时只结算不自动开始下一段。 */
const STALE_MS = 60_000;
const MAX_TIMEOUT = 2_147_483_647;
const RING_RADIUS = 54;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

const DEFAULTS: PomodoroConfig = {
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  roundsBeforeLongBreak: 4,
  autoStartBreak: true,
  autoStartFocus: false,
  sound: true,
  notify: true,
  task: "",
  history: {},
  session: { phase: "focus", state: "idle", endsAt: 0, remainingMs: 0, round: 0 }
};

// ---- 纯状态机（可单测） ------------------------------------------------------

export function phaseDurationMs(config: PomodoroConfig, phase: PomodoroPhase): number {
  const minutes = phase === "focus" ? config.focusMinutes : phase === "short" ? config.shortBreakMinutes : config.longBreakMinutes;
  return minutes * 60_000;
}

export function remainingMs(config: PomodoroConfig, session: PomodoroSession, now: number): number {
  const duration = phaseDurationMs(config, session.phase);
  if (session.state === "running") return Math.max(0, session.endsAt - now);
  if (session.state === "paused") return Math.min(duration, Math.max(0, session.remainingMs));
  return duration;
}

export function startSession(config: PomodoroConfig, session: PomodoroSession, now: number): PomodoroSession {
  if (session.state === "running") return session;
  return { ...session, state: "running", endsAt: now + remainingMs(config, session, now), remainingMs: 0 };
}

export function pauseSession(config: PomodoroConfig, session: PomodoroSession, now: number): PomodoroSession {
  if (session.state !== "running") return session;
  return { ...session, state: "paused", endsAt: 0, remainingMs: remainingMs(config, session, now) };
}

/** 回到某一阶段的起点；进入专注时若已完成整轮则清零计数。 */
export function resetSession(config: PomodoroConfig, session: PomodoroSession, phase = session.phase): PomodoroSession {
  const round = phase === "focus" && session.round >= config.roundsBeforeLongBreak ? 0 : session.round;
  return { phase, state: "idle", endsAt: 0, remainingMs: 0, round };
}

/**
 * 进入下一阶段。count=true 表示当前专注段算作完成（到点），跳过则不计数。
 * allowAutoStart=false 用于恢复很久以前到点的会话：只结算，不替用户开始下一段。
 */
export function advanceSession(
  config: PomodoroConfig,
  session: PomodoroSession,
  options: { count: boolean; now: number; allowAutoStart: boolean }
): { session: PomodoroSession; completedFocus: boolean } {
  const completedFocus = session.phase === "focus" && options.count;
  let next: PomodoroSession;
  if (session.phase === "focus") {
    const round = completedFocus ? session.round + 1 : session.round;
    const phase: PomodoroPhase = round >= config.roundsBeforeLongBreak ? "long" : "short";
    next = resetSession(config, { ...session, round }, phase);
    if (options.allowAutoStart && config.autoStartBreak) next = startSession(config, next, options.now);
  } else {
    next = resetSession(config, session, "focus");
    if (options.allowAutoStart && config.autoStartFocus) next = startSession(config, next, options.now);
  }
  return { session: next, completedFocus };
}

export function bumpHistory(history: Record<string, number>, date: string): Record<string, number> {
  const next = { ...history, [date]: (history[date] ?? 0) + 1 };
  const keys = Object.keys(next).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - HISTORY_DAYS))) delete next[key];
  return next;
}

function normalizeHistory(raw: unknown): Record<string, number> {
  const history: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return history;
  for (const [date, count] of Object.entries(raw as Record<string, unknown>)) {
    const value = clampInt(count, 0, 999, 0);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && value > 0) history[date] = value;
  }
  return history;
}

function normalizeSession(raw: unknown, config: PomodoroConfig): PomodoroSession {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<PomodoroSession>;
  const phase = PHASES.includes(value.phase as PomodoroPhase) ? (value.phase as PomodoroPhase) : "focus";
  const duration = phaseDurationMs(config, phase);
  const endsAt = typeof value.endsAt === "number" && Number.isFinite(value.endsAt) && value.endsAt > 0 ? value.endsAt : 0;
  const state: PomodoroState = value.state === "running" && endsAt > 0 ? "running" : value.state === "paused" ? "paused" : "idle";
  // 专注段里计数最多到 N-1（第 N 个正在做）；休息段允许等于 N（刚做满一轮，长休息中）。
  const maxRound = phase === "focus" ? config.roundsBeforeLongBreak - 1 : config.roundsBeforeLongBreak;
  return {
    phase,
    state,
    endsAt: state === "running" ? endsAt : 0,
    remainingMs: state === "paused" ? clampInt(value.remainingMs, 0, duration, duration) : 0,
    round: clampInt(value.round, 0, maxRound, 0)
  };
}

function normalizeConfig(raw: Record<string, unknown>): PomodoroConfig {
  const config = normalizeWith(DEFAULTS, raw);
  config.focusMinutes = clampInt(config.focusMinutes, 1, 180, DEFAULTS.focusMinutes);
  config.shortBreakMinutes = clampInt(config.shortBreakMinutes, 1, 60, DEFAULTS.shortBreakMinutes);
  config.longBreakMinutes = clampInt(config.longBreakMinutes, 1, 120, DEFAULTS.longBreakMinutes);
  config.roundsBeforeLongBreak = clampInt(config.roundsBeforeLongBreak, 1, 12, DEFAULTS.roundsBeforeLongBreak);
  config.task = config.task.trim().slice(0, 80);
  config.history = normalizeHistory(config.history);
  config.session = normalizeSession(config.session, config);
  return config;
}

function sumHistory(history: Record<string, number>, days: string[]): number {
  return days.reduce((sum, date) => sum + (history[date] ?? 0), 0);
}

function recentDays(count: number): string[] {
  const today = new Date();
  return Array.from({ length: count }, (_, index) => toIsoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - index)));
}

export function formatClock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// ---- 后台定时器：随插件存活，首页关掉了也会到点提醒 ----------------------------

const timers = new Map<string, number>();
let boundPlugin: HomePagesPlugin | null = null;

function bindPlugin(plugin: HomePagesPlugin): void {
  if (boundPlugin === plugin) return;
  boundPlugin = plugin;
  plugin.register(() => {
    for (const id of timers.values()) window.clearTimeout(id);
    timers.clear();
    if (boundPlugin === plugin) boundPlugin = null;
  });
}

function findWidget(plugin: HomePagesPlugin, widgetId: string): WidgetInstance | undefined {
  for (const page of plugin.settings.pages) {
    const widget = page.widgets.find((item) => item.id === widgetId);
    if (widget) return widget;
  }
  return undefined;
}

/** 让后台定时器与持久化状态一致：running 就按 endsAt 排定到点回调，否则取消。 */
export function syncPomodoroTimer(plugin: HomePagesPlugin, widgetId: string): void {
  bindPlugin(plugin);
  const existing = timers.get(widgetId);
  if (existing !== undefined) {
    window.clearTimeout(existing);
    timers.delete(widgetId);
  }
  const widget = findWidget(plugin, widgetId);
  if (!widget || widget.kind !== KIND) return;
  const { session } = normalizeConfig(widget.config ?? {});
  if (session.state !== "running") return;
  const delay = Math.min(MAX_TIMEOUT, Math.max(0, session.endsAt - Date.now()) + 30);
  timers.set(widgetId, window.setTimeout(() => {
    timers.delete(widgetId);
    void completePomodoro(plugin, widgetId);
  }, delay));
}

/** 插件加载后恢复仍在运行的计时；关着 Obsidian 时已到点的会立即结算。 */
export function resumePomodoroTimers(plugin: HomePagesPlugin): void {
  for (const page of plugin.settings.pages) {
    for (const widget of page.widgets) {
      if (widget.kind === KIND) syncPomodoroTimer(plugin, widget.id);
    }
  }
}

async function completePomodoro(plugin: HomePagesPlugin, widgetId: string): Promise<void> {
  const widget = findWidget(plugin, widgetId);
  if (!widget) return;
  const config = normalizeConfig(widget.config ?? {});
  const now = Date.now();
  if (config.session.state !== "running") return;
  if (config.session.endsAt - now > 250) {
    // 定时器提前触发（系统时钟调整），按剩余时间重新排定。
    syncPomodoroTimer(plugin, widgetId);
    return;
  }
  const stale = now - config.session.endsAt > STALE_MS;
  const result = advanceSession(config, config.session, { count: true, now, allowAutoStart: !stale });
  const history = result.completedFocus ? bumpHistory(config.history, toIsoDate(new Date(config.session.endsAt))) : config.history;
  widget.config = { ...widget.config, session: result.session, history };
  void plugin.saveSettings();
  syncPomodoroTimer(plugin, widgetId);
  plugin.refreshViews({ kind: KIND });
  announce(config, result.session, result.completedFocus, stale);
}

function announce(config: PomodoroConfig, next: PomodoroSession, completedFocus: boolean, stale: boolean): void {
  const nextMinutes = phaseDurationMs(config, next.phase) / 60_000;
  const text = completedFocus
    ? `🍅 番茄完成！${next.phase === "long" ? "长" : ""}休息 ${nextMinutes} 分钟${next.state === "running" ? "，已开始计时" : ""}`
    : `休息结束，${next.state === "running" ? "下一个番茄已开始" : `开始下一个 ${nextMinutes} 分钟的番茄吧`}`;
  new Notice(stale ? `番茄时钟：上次的${completedFocus ? "专注" : "休息"}已到点。${text}` : text, 8000);
  if (stale) return;
  if (config.sound) playChime();
  if (config.notify) systemNotification("番茄时钟", text);
}

function systemNotification(title: string, body: string): void {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const notification = new Notification(title, { body, silent: true });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch (error) {
    console.warn("Home Pages: system notification failed", error);
  }
}

// ---- 提示音：Web Audio 合成三个上行音，不需要音频文件 -------------------------

let audio: AudioContext | null = null;

function ensureAudio(): AudioContext | null {
  try {
    if (!audio) audio = new AudioContext();
    if (audio.state === "suspended") void audio.resume();
    return audio;
  } catch {
    return null;
  }
}

export function playChime(): void {
  const context = ensureAudio();
  if (!context) return;
  const base = context.currentTime + 0.02;
  [659.25, 783.99, 1046.5].forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = base + index * 0.17;
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.55);
  });
}

// ---- 组件 ---------------------------------------------------------------------

export const pomodoroWidget: WidgetDefinition<PomodoroConfig> = {
  kind: KIND,
  name: "番茄时钟",
  description: "专注 / 短休息 / 长休息循环计时，到点提示音 + 通知，记录每天完成的番茄数。",
  icon: "timer",
  accent: "#e11d48",
  defaultSize: { w: 4, h: 5 },
  liveRefresh: false,
  defaultConfig: () => ({ ...DEFAULTS, history: {}, session: { ...DEFAULTS.session } }),
  normalizeConfig,

  render(body, ctx) {
    const { config, plugin, widget } = ctx;
    const { session } = config;
    // 每次渲染都对齐后台定时器（设置弹窗保存、导入布局等都可能改动状态）。
    syncPomodoroTimer(plugin, widget.id);

    const today = todayIso();
    const todayCount = config.history[today] ?? 0;
    const weekCount = sumHistory(config.history, recentDays(7));
    const duration = phaseDurationMs(config, session.phase);
    const wrap = body.createDiv({ cls: `hp-pomo is-${session.phase} is-${session.state}` });

    const phases = wrap.createDiv({ cls: "hp-pomo-phases" });
    for (const phase of PHASES) {
      const button = phases.createEl("button", {
        cls: `hp-pill${session.phase === phase ? " is-active" : ""}`,
        text: PHASE_LABEL[phase],
        attr: { type: "button", title: `${phaseDurationMs(config, phase) / 60_000} 分钟` }
      });
      button.addEventListener("click", () => {
        if (session.phase === phase) return;
        commit(ctx, { session: resetSession(config, session, phase) });
      });
    }

    const main = wrap.createDiv({ cls: "hp-pomo-main" });
    const ring = main.createDiv({ cls: "hp-pomo-ring" });
    const svg = ring.createSvg("svg", { attr: { viewBox: "0 0 120 120", "aria-hidden": "true" } });
    svg.createSvg("circle", { cls: "hp-pomo-track", attr: { cx: "60", cy: "60", r: String(RING_RADIUS) } });
    const bar = svg.createSvg("circle", { cls: "hp-pomo-bar", attr: { cx: "60", cy: "60", r: String(RING_RADIUS) } });
    bar.style.strokeDasharray = String(RING_LENGTH);
    const center = ring.createDiv({ cls: "hp-pomo-center" });
    const clock = center.createDiv({ cls: "hp-pomo-time" });
    const status = center.createDiv({ cls: "hp-pomo-status" });

    const side = main.createDiv({ cls: "hp-pomo-side" });
    const task = side.createEl("input", {
      cls: "hp-pomo-task",
      attr: { type: "text", placeholder: "这个番茄要做什么？", maxlength: "80", spellcheck: "false", "aria-label": "当前任务" }
    });
    task.value = config.task;
    task.addEventListener("change", () => {
      const value = task.value.trim();
      if (value !== config.task) void ctx.saveConfig({ task: value });
    });
    task.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === "Escape") task.blur();
    });

    const rounds = side.createDiv({ cls: "hp-pomo-rounds" });
    const dots = rounds.createDiv({ cls: "hp-pomo-dots", attr: { title: `本轮已完成 ${session.round}/${config.roundsBeforeLongBreak} 个番茄` } });
    for (let index = 0; index < config.roundsBeforeLongBreak; index += 1) {
      const done = index < session.round;
      const active = !done && index === session.round && session.phase === "focus";
      dots.createSpan({ cls: `hp-pomo-dot${done ? " is-done" : active ? " is-active" : ""}` });
    }
    rounds.createSpan({ cls: "hp-pomo-count", text: `今日 ${todayCount} · 本周 ${weekCount}` });

    const controls = side.createDiv({ cls: "hp-pomo-controls" });
    const iconButton = (icon: string, label: string, onClick: () => void): HTMLButtonElement => {
      const button = controls.createEl("button", { cls: "hp-pomo-btn clickable-icon", attr: { type: "button", "aria-label": label, title: label } });
      setIcon(button, icon);
      button.addEventListener("click", onClick);
      return button;
    };
    iconButton("rotate-ccw", "重置本段", () => commit(ctx, { session: resetSession(config, session) }));
    const primary = controls.createEl("button", { cls: "hp-pomo-primary", attr: { type: "button" } });
    const primaryIcon = primary.createSpan({ cls: "hp-pomo-primary-icon" });
    const primaryText = primary.createSpan();
    if (session.state === "running") {
      setIcon(primaryIcon, "pause");
      primaryText.setText("暂停");
      primary.addEventListener("click", () => commit(ctx, { session: pauseSession(config, session, Date.now()) }));
    } else {
      setIcon(primaryIcon, "play");
      primaryText.setText(session.state === "paused" ? "继续" : "开始");
      primary.addEventListener("click", () => {
        // 在用户手势里先把 AudioContext 建好，到点时才允许出声。
        if (config.sound) ensureAudio();
        commit(ctx, { session: startSession(config, session, Date.now()) });
      });
    }
    iconButton("skip-forward", session.phase === "focus" ? "跳过本段（不计数）" : "跳过休息", () => {
      const result = advanceSession(config, session, { count: false, now: Date.now(), allowAutoStart: true });
      commit(ctx, { session: result.session });
    });

    const update = (): void => {
      const now = Date.now();
      const left = remainingMs(config, session, now);
      clock.setText(formatClock(left));
      bar.style.strokeDashoffset = String(RING_LENGTH * (1 - (duration > 0 ? left / duration : 0)));
      const label = PHASE_LABEL[session.phase];
      status.setText(session.state === "paused" ? `${label} · 已暂停` : session.state === "running" ? `${label}中` : label);
      const position = session.phase === "focus" ? `第 ${Math.min(session.round + 1, config.roundsBeforeLongBreak)}/${config.roundsBeforeLongBreak} 个` : `${label} ${duration / 60_000} 分钟`;
      ctx.setSubtitle(session.state === "idle" ? `今日 ${todayCount} 🍅` : `${position}${session.state === "paused" ? " · 已暂停" : ""}`);
      // 到点由后台定时器结算；这里只在它迟到时补一脚。
      if (session.state === "running" && left <= 0) syncPomodoroTimer(plugin, widget.id);
    };
    update();
    if (session.state === "running") ctx.registerInterval(update, 500);
  },

  renderSettings(container, ctx) {
    const { config } = ctx;
    addNumberSetting(container, { name: "专注时长（分钟）", value: config.focusMinutes, min: 1, max: 120, onChange: (value) => ctx.update({ focusMinutes: value }) });
    addNumberSetting(container, { name: "短休息（分钟）", value: config.shortBreakMinutes, min: 1, max: 30, onChange: (value) => ctx.update({ shortBreakMinutes: value }) });
    addNumberSetting(container, { name: "长休息（分钟）", value: config.longBreakMinutes, min: 1, max: 60, onChange: (value) => ctx.update({ longBreakMinutes: value }) });
    addNumberSetting(container, {
      name: "几个番茄后长休息",
      desc: "完成这么多个专注段后进入长休息。",
      value: config.roundsBeforeLongBreak,
      min: 1,
      max: 12,
      onChange: (value) => ctx.update({ roundsBeforeLongBreak: value })
    });
    new Setting(container).setName("休息自动开始").setDesc("专注到点后立刻开始计时休息。")
      .addToggle((toggle) => toggle.setValue(config.autoStartBreak).onChange((value) => ctx.update({ autoStartBreak: value })));
    new Setting(container).setName("专注自动开始").setDesc("休息结束后自动开始下一个番茄。")
      .addToggle((toggle) => toggle.setValue(config.autoStartFocus).onChange((value) => ctx.update({ autoStartFocus: value })));
    new Setting(container).setName("提示音").setDesc("到点时播放一段短提示音。")
      .addButton((button) => button.setButtonText("试听").onClick(() => playChime()))
      .addToggle((toggle) => toggle.setValue(config.sound).onChange((value) => ctx.update({ sound: value })));
    new Setting(container).setName("系统通知").setDesc("到点时弹出系统通知；Obsidian 内的提示总会显示。")
      .addToggle((toggle) => toggle.setValue(config.notify).onChange((value) => ctx.update({ notify: value })));
    const total = Object.values(config.history).reduce((sum, count) => sum + count, 0);
    new Setting(container).setName("清空番茄记录").setDesc(`已记录 ${total} 个番茄（保留最近 ${HISTORY_DAYS} 天）。`)
      .addButton((button) => button.setButtonText("清空").setWarning().onClick(() => {
        ctx.update({ history: {} });
        ctx.refresh();
        new Notice("番茄记录已清空（保存后生效）");
      }));
  }
};

/** 写回状态、对齐后台定时器并立刻重绘（不等待写盘的防抖）。 */
function commit(ctx: WidgetContext<PomodoroConfig>, patch: Partial<PomodoroConfig>): void {
  void ctx.saveConfig(patch);
  syncPomodoroTimer(ctx.plugin, ctx.widget.id);
  ctx.rerender();
}
