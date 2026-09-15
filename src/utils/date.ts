export const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
export const MONTH_LABELS = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

export function toIsoDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

export function todayIso(): string {
  return toIsoDate(new Date());
}

export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function parseIsoDate(iso: string): Date | null {
  const match = iso.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && parseIsoDate(value) !== null;
}

/** target - today，向下取整到天。正=未来，负=已过。 */
export function daysBetweenToday(targetIso: string): number {
  const target = parseIsoDate(targetIso);
  if (!target) return NaN;
  const today = startOfLocalDay(new Date()).getTime();
  return Math.round((target.getTime() - today) / 86400000);
}

export function buildRecentDays(count: number): string[] {
  const days: string[] = [];
  const today = startOfLocalDay(new Date());
  for (let offset = count - 1; offset >= 0; offset--) {
    days.push(toIsoDate(new Date(today.getTime() - offset * 86400000)));
  }
  return days;
}

export function dayOfYear(date = new Date()): number {
  const start = new Date(date.getFullYear(), 0, 0).getTime();
  return Math.floor((startOfLocalDay(date).getTime() - start) / 86400000);
}

export function greetingForHour(hour: number): string {
  if (hour < 5) return "夜深了";
  if (hour < 9) return "早上好";
  if (hour < 12) return "上午好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  if (hour < 23) return "晚上好";
  return "夜深了";
}

export function greetingIcon(greeting: string): string {
  if (greeting.includes("早")) return "sunrise";
  if (greeting.includes("晚")) return "sunset";
  if (greeting.includes("夜")) return "moon";
  return "sun";
}

export function dateLabel(date: Date): string {
  return `${toIsoDate(date)} ${WEEKDAY_LABELS[date.getDay()]}`;
}

export function clockLabel(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatRelativeTime(time: number): string {
  const diff = Math.max(0, Date.now() - time);
  const minute = 60_000;
  if (diff < minute) return "刚刚";
  if (diff < 60 * minute) return `${Math.round(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.round(diff / (60 * minute))} 小时前`;
  const days = Math.round(diff / (24 * 60 * minute));
  if (days < 30) return `${days} 天前`;
  const date = new Date(time);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 从任意值里提取 YYYY-MM-DD（frontmatter 日期、时间戳、Date、Dataview 日期对象）。 */
export function firstIsoDateString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "number" && Number.isFinite(value)) return toIsoDate(new Date(value));
    if (value instanceof Date) return toIsoDate(value);
    if (typeof value === "object" && value !== null && "ts" in value && typeof (value as { ts?: unknown }).ts === "number") {
      return toIsoDate(new Date((value as { ts: number }).ts));
    }
    const text = String(value).trim();
    const match = text.match(/\d{4}-\d{2}-\d{2}/);
    if (match) return match[0];
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return toIsoDate(new Date(parsed));
  }
  return undefined;
}
