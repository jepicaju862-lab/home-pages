import { App, TFile } from "obsidian";
import { todayIso } from "../utils/date";
import type { DuoweiConfig } from "./duowei";

// ---- .duowei 文件的最小类型（只取首页需要的部分） ------------------------------

interface DuoweiOption {
  id: string;
  name: string;
  color?: string;
}

export interface DuoweiField {
  id: string;
  name: string;
  type: string;
  options?: DuoweiOption[];
  ratingMax?: number;
}

export interface DuoweiRecord {
  id: string;
  values: Record<string, unknown>;
  notePath?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface DuoweiDoc {
  name?: string;
  fields: DuoweiField[];
  records: DuoweiRecord[];
  views?: Array<{ id: string; name: string; type: string }>;
  titleFieldId?: string;
  source?: unknown;
}

export const docCache = new Map<string, { mtime: number; doc: DuoweiDoc | null }>();

export async function loadDoc(app: App, path: string): Promise<DuoweiDoc | null> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    // 不存在的路径也记录下来，设置面板据此判断“已经尝试过”，避免反复重载。
    docCache.set(path, { mtime: -1, doc: null });
    return null;
  }
  const cached = docCache.get(path);
  if (cached && cached.mtime === file.stat.mtime) return cached.doc;
  let doc: DuoweiDoc | null = null;
  try {
    const parsed = JSON.parse(await app.vault.cachedRead(file)) as Partial<DuoweiDoc>;
    if (parsed && Array.isArray(parsed.fields) && Array.isArray(parsed.records)) doc = parsed as DuoweiDoc;
  } catch (error) {
    console.error("Home Pages: failed to parse .duowei", error);
  }
  docCache.set(path, { mtime: file.stat.mtime, doc });
  return doc;
}

export function fieldByName(doc: DuoweiDoc, name: string): DuoweiField | undefined {
  const key = name.trim();
  if (!key) return undefined;
  return doc.fields.find((field) => field.name === key || field.id === key);
}

export function titleFieldOf(doc: DuoweiDoc, config: DuoweiConfig): DuoweiField | undefined {
  return fieldByName(doc, config.titleField)
    ?? doc.fields.find((field) => field.id === doc.titleFieldId)
    ?? doc.fields.find((field) => field.type === "text")
    ?? doc.fields[0];
}

export interface Chip {
  text: string;
  color?: string;
}

/** 把记录值转成可显示的文字 / 彩色标签。 */
export function formatValue(field: DuoweiField, value: unknown): Chip[] {
  if (value === null || value === undefined || value === "") return [];
  const optionChip = (id: unknown): Chip => {
    const option = field.options?.find((item) => item.id === id || item.name === id);
    return option ? { text: option.name, color: option.color } : { text: String(id) };
  };
  switch (field.type) {
    case "singleSelect":
      return [optionChip(value)];
    case "multiSelect":
      return (Array.isArray(value) ? value : [value]).map(optionChip);
    case "checkbox":
      return [{ text: value === true || value === "true" ? "☑ " + field.name : "☐ " + field.name }];
    case "rating": {
      const max = Math.max(1, Math.min(10, field.ratingMax ?? 5));
      const count = Math.max(0, Math.min(max, Number(value) || 0));
      return [{ text: "★".repeat(count) + "☆".repeat(max - count) }];
    }
    case "progress":
      return [{ text: `${Math.round(Number(value) || 0)}%` }];
    case "noteLink":
    case "attachment":
      return (Array.isArray(value) ? value : [value]).map((item) => ({ text: String(item).replace(/^\[\[|\]\]$/g, "").split("|").pop() ?? "" }));
    default:
      if (Array.isArray(value)) return value.map((item) => ({ text: String(item) }));
      if (typeof value === "object") return [{ text: JSON.stringify(value) }];
      return [{ text: String(value) }];
  }
}

export function dateKeyOf(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else {
    const text = String(value).trim();
    const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
    parsed = Date.parse(text);
  }
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function selectRecords(doc: DuoweiDoc, config: DuoweiConfig): DuoweiRecord[] {
  let records = doc.records.slice();
  const filterField = fieldByName(doc, config.filterField);
  if (filterField && config.filterValue.trim()) {
    const wanted = config.filterValue.trim().toLowerCase();
    const wantedIds = new Set((filterField.options ?? []).filter((option) => option.name.toLowerCase() === wanted).map((option) => option.id));
    records = records.filter((record) => {
      const raw = record.values[filterField.id];
      if (filterField.type === "checkbox") return String(raw === true || raw === "true") === wanted || (wanted === "是" && raw === true) || (wanted === "否" && !raw);
      const values = Array.isArray(raw) ? raw : [raw];
      return values.some((item) => wantedIds.has(String(item)) || String(item ?? "").toLowerCase().includes(wanted));
    });
  }
  const dateField = fieldByName(doc, config.dateField);
  if (dateField && config.dateRange !== "all") {
    const today = todayIso();
    const weekEnd = new Date();
    weekEnd.setDate(weekEnd.getDate() + 7);
    const weekEndKey = dateKeyOf(weekEnd.getTime()) ?? today;
    records = records.filter((record) => {
      const key = dateKeyOf(record.values[dateField.id]);
      if (!key) return false;
      if (config.dateRange === "today") return key === today;
      if (config.dateRange === "week") return key >= today && key <= weekEndKey;
      if (config.dateRange === "upcoming") return key >= today;
      return key < today;
    });
  }
  const sortField = fieldByName(doc, config.sortField) ?? dateField;
  if (sortField) {
    const dir = config.sortDir === "desc" ? -1 : 1;
    records.sort((a, b) => {
      const av = a.values[sortField.id];
      const bv = b.values[sortField.id];
      if (av === bv) return 0;
      if (av === null || av === undefined || av === "") return 1;
      if (bv === null || bv === undefined || bv === "") return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv), "zh") * dir;
    });
  } else {
    records.sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));
  }
  return records.slice(0, config.limit);
}
