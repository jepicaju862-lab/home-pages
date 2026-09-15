import { App, TFile } from "obsidian";
import { todayIso } from "../utils/date";
import { isExcluded, isInScope } from "../utils/vault";
import { formatValue, loadDoc, type DuoweiDoc, type DuoweiField, type DuoweiRecord } from "./duoweiCore";

/** 跨表格情报摘要：从库内所有 .duowei 表格里挑出今天 / 逾期 / 即将到期 / 进行中 / 最近更新的记录。 */

export type DigestSection = "today" | "overdue" | "upcoming" | "active" | "recent";

export const SECTION_META: Record<DigestSection, { label: string; icon: string; tone: string }> = {
  today: { label: "今天", icon: "calendar-check", tone: "#2563eb" },
  overdue: { label: "已逾期", icon: "alarm-clock-off", tone: "#dc2626" },
  upcoming: { label: "即将到期", icon: "calendar-clock", tone: "#d97706" },
  active: { label: "进行中", icon: "loader", tone: "#7c3aed" },
  recent: { label: "最近更新", icon: "history", tone: "#0d9488" }
};

export interface DigestOptions {
  folder: string;
  excludeTables: string[];
  /** 优先当作“计划日期”的字段名（留空自动识别）。 */
  dateFieldNames: string[];
  upcomingDays: number;
  overdueDays: number;
  recentDays: number;
  sectionLimit: number;
  sections: DigestSection[];
  /** 额外视为“已完成”的状态选项名。 */
  doneValues?: string[];
}

export interface DigestItem {
  section: DigestSection;
  tablePath: string;
  tableName: string;
  title: string;
  /** YYYY-MM-DD 或含时间的原始日期文本。 */
  date?: string;
  dateText?: string;
  status?: { text: string; color?: string };
  notePath?: string;
  updatedAt: number;
}

export interface DigestResult {
  items: DigestItem[];
  /** 各分区的总条数（未按 sectionLimit 截断）。 */
  totals: Record<DigestSection, number>;
  tables: number;
  scanned: number;
}

const PLAN_DATE_RE = /截止|到期|期限|deadline|due|开始|结束|start|end|日期|date|时间|time|计划|安排|提醒|复习|排期/i;
/** 同时存在“开始”和“截止”时，待办语义以截止 / 结束为准。 */
const DUE_DATE_RE = /截止|到期|期限|deadline|due|结束|end|完成日|交付/i;
const NOT_PLAN_DATE_RE = /接收|收到|创建|更新|修改|received|created|modified|updated|同步/i;
const STATUS_FIELD_RE = /状态|进度|阶段|status|stage|progress/i;
const DONE_OPTION_RE = /完成|done|closed|已取消|取消|归档|archived|cancel|已读|结束|finished|已交付/i;
const ACTIVE_OPTION_RE = /进行中|doing|in progress|处理中|执行中|推进中|开发中|阅读中|精读中|正在/i;
const DONE_CHECKBOX_RE = /完成|done|finished|已读|checked/i;

function isWechatInboxTable(doc: DuoweiDoc, file: TFile): boolean {
  if ((doc as { meta?: { wechat2ob?: number } }).meta?.wechat2ob) return true;
  if ((doc.name ?? "").includes("微信收件箱") || file.basename.includes("微信收件箱")) return true;
  return doc.fields.some((field) => /微信消息\s*ID/i.test(field.name));
}

function isBackupTable(file: TFile): boolean {
  return /自动备份|多维表格备份|\.duoweibak$/i.test(file.path) || /\.duoweibak$/i.test(file.name);
}

function pickDateFields(doc: DuoweiDoc, preferred: string[]): DuoweiField[] {
  const dateFields = doc.fields.filter((field) => field.type === "date" || field.type === "dateTime");
  const byName = preferred.map((name) => dateFields.find((field) => field.name === name || field.id === name)).filter((field): field is DuoweiField => !!field);
  if (byName.length > 0) return byName;
  const planned = dateFields.filter((field) => !NOT_PLAN_DATE_RE.test(field.name));
  const due = planned.filter((field) => DUE_DATE_RE.test(field.name));
  const strong = planned.filter((field) => PLAN_DATE_RE.test(field.name) && !DUE_DATE_RE.test(field.name));
  const ordered = [...due, ...strong];
  return ordered.length > 0 ? ordered : planned;
}

function dateKey(value: unknown): { key: string; text: string } | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return { key: localKey(date), text: localKey(date) };
  }
  const text = String(value).trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
  if (match) return { key: match[1], text: match[2] ? `${match[1]} ${match[2]}` : match[1] };
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  return { key: localKey(date), text: localKey(date) };
}

function localKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function shiftKey(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localKey(date);
}

function recordTitle(doc: DuoweiDoc, record: DuoweiRecord): string {
  const field = doc.fields.find((item) => item.id === doc.titleFieldId)
    ?? doc.fields.find((item) => item.type === "text")
    ?? doc.fields[0];
  if (!field) return record.id;
  const text = formatValue(field, record.values[field.id]).map((chip) => chip.text).join(" ").trim();
  return text || "（无标题）";
}

function recordStatus(doc: DuoweiDoc, record: DuoweiRecord): { field: DuoweiField; text: string; color?: string } | null {
  for (const field of doc.fields) {
    if (field.type !== "singleSelect" || !STATUS_FIELD_RE.test(field.name)) continue;
    const chip = formatValue(field, record.values[field.id])[0];
    if (chip) return { field, text: chip.text, color: chip.color };
  }
  return null;
}

function isDone(doc: DuoweiDoc, record: DuoweiRecord, status: { text: string } | null, doneValues: Set<string>): boolean {
  if (status && (DONE_OPTION_RE.test(status.text) || doneValues.has(status.text.toLowerCase()))) return true;
  for (const field of doc.fields) {
    if (field.type === "checkbox" && DONE_CHECKBOX_RE.test(field.name)) {
      const value = record.values[field.id];
      if (value === true || value === "true") return true;
    }
  }
  return false;
}

export async function buildDigest(app: App, options: DigestOptions): Promise<DigestResult> {
  const today = todayIso();
  const upcomingEnd = shiftKey(Math.max(0, options.upcomingDays));
  const overdueStart = shiftKey(-Math.max(0, options.overdueDays));
  const recentSince = Date.now() - Math.max(0, options.recentDays) * 86400000;
  const wanted = new Set(options.sections);
  const doneValues = new Set((options.doneValues ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean));
  const files = app.vault.getFiles().filter((file) =>
    file.extension.toLowerCase() === "duowei"
    && !isBackupTable(file)
    && isInScope(file, options.folder)
    && !isExcluded(file, options.excludeTables)
    && !options.excludeTables.includes(file.path));
  const items: DigestItem[] = [];
  let tables = 0;
  for (const file of files) {
    const doc = await loadDoc(app, file.path);
    if (!doc || doc.records.length === 0) continue;
    // 微信收件箱表（WeChat2Ob 或多维表格内置）由“微信收件”组件负责，避免每条消息都被当成待办。
    if (isWechatInboxTable(doc, file)) continue;
    tables += 1;
    const dateFields = pickDateFields(doc, options.dateFieldNames);
    const tableName = doc.name || file.basename;
    for (const record of doc.records) {
      const status = recordStatus(doc, record);
      if (isDone(doc, record, status, doneValues)) continue;
      const updatedAt = Date.parse(record.updatedAt ?? "") || 0;
      const base = {
        tablePath: file.path,
        tableName,
        title: recordTitle(doc, record),
        status: status ? { text: status.text, color: status.color } : undefined,
        notePath: record.notePath ?? undefined,
        updatedAt
      };
      let section: DigestSection | null = null;
      let date: { key: string; text: string } | null = null;
      for (const field of dateFields) {
        date = dateKey(record.values[field.id]);
        if (date) break;
      }
      if (date) {
        if (date.key === today) section = "today";
        else if (date.key < today && date.key >= overdueStart) section = "overdue";
        else if (date.key > today && date.key <= upcomingEnd) section = "upcoming";
      }
      if (!section && status && ACTIVE_OPTION_RE.test(status.text)) section = "active";
      if (!section && updatedAt >= recentSince) section = "recent";
      if (!section || !wanted.has(section)) continue;
      items.push({ ...base, section, date: date?.key, dateText: date?.text });
    }
  }
  const order: DigestSection[] = ["overdue", "today", "upcoming", "active", "recent"];
  items.sort((a, b) => {
    const diff = order.indexOf(a.section) - order.indexOf(b.section);
    if (diff !== 0) return diff;
    if (a.date && b.date && a.date !== b.date) return a.section === "overdue" ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date);
    return b.updatedAt - a.updatedAt;
  });
  const totals: Record<DigestSection, number> = { today: 0, overdue: 0, upcoming: 0, active: 0, recent: 0 };
  for (const item of items) totals[item.section] += 1;
  // 每个分区最多保留 sectionLimit 条。
  const counts = new Map<DigestSection, number>();
  const limited = items.filter((item) => {
    const count = counts.get(item.section) ?? 0;
    if (count >= options.sectionLimit) return false;
    counts.set(item.section, count + 1);
    return true;
  });
  return { items: limited, totals, tables, scanned: files.length };
}
