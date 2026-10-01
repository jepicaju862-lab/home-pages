import { promises as fs } from "node:fs";
import path from "node:path";
import { formatValue, selectRecords, type DuoweiDoc } from "../src/widgets/duoweiCore";
import { loadAnnotations } from "../src/widgets/annotations";
import { buildDigest } from "../src/widgets/duoweiDigest";
import { loadWechat, syncWechat2obViaApi, wechat2obApi, type Wechat2obInboxV1 } from "../src/widgets/wechat";
import { TFile, TFolder } from "obsidian";
import { createWidgetInstance, getWidgetDefinition, listWidgetDefinitions, onRegistryChange, registerWidget } from "../src/widgets/registry";
import { sanitizeSettings, sanitizeWidget } from "../src/settings";
import { CustomWidgetManager, DEMO_WIDGET_TEMPLATE, evaluateWidgetScript } from "../src/widgets/userLoader";
import { habitStreak } from "../src/widgets/habit";
import { advanceSession, bumpHistory, formatClock, pauseSession, pomodoroWidget, remainingMs, resetSession, startSession, type PomodoroConfig } from "../src/widgets/pomodoro";

import { cmaIcon, normalizeHost, parseCoords, qweatherIcon, rankCmaCandidates, splitQuery, stripSuffix } from "../src/utils/weather";
import { parseOpml, exportOpml } from "../src/utils/opml";
import {
  getCachedMediaData,
  htmlToMarkdown,
  loadDiskCache,
  mediaWidget,
  parseQiushiCatalog,
  parseQiushiIssueArticles,
  parseRssArticles,
  parseZjxcArticles,
  saveDiskCacheNow,
  syncMediaData
} from "../src/widgets/media";

const normalizePomodoro = (raw: Record<string, unknown>): PomodoroConfig => pomodoroWidget.normalizeConfig!(raw);

const VAULT = process.env.HOME_PAGES_TEST_VAULT ?? "D:/data/obsidian_pls/duowei-stress-vault";
let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

async function testDuowei(): Promise<void> {
  const doc = JSON.parse(await fs.readFile(path.join(VAULT, "项目经理一日日程.duowei"), "utf8")) as DuoweiDoc;
  const base = {
    path: "", mode: "records" as const, view: "", chart: "", chartType: "" as const, fields: [],
    titleField: "", showFields: [], filterField: "", filterValue: "", dateField: "", dateRange: "all" as const,
    sortField: "", sortDir: "asc" as const, limit: 100
  };
  const meetings = selectRecords(doc, { ...base, filterField: "事项类型", filterValue: "团队会议" });
  check("filter by singleSelect option name", meetings.length > 0 && meetings.every((r) => r.values.fld_type === "opt_meeting"), meetings.length);
  const sorted = selectRecords(doc, { ...base, sortField: "开始时间", sortDir: "desc" });
  const starts = sorted.map((r) => String(r.values.fld_start));
  check("sort desc by dateTime", starts.every((v, i) => i === 0 || starts[i - 1] >= v), starts.slice(0, 3));
  const today = selectRecords(doc, { ...base, dateField: "开始时间", dateRange: "today" });
  check("date range today (demo dates are 2026-07-27)", today.length === 0, today.length);
  const overdue = selectRecords(doc, { ...base, dateField: "开始时间", dateRange: "overdue" });
  check("date range overdue includes all demo rows", overdue.length === doc.records.length, overdue.length);
  const typeField = doc.fields.find((f) => f.name === "事项类型");
  const chips = typeField ? formatValue(typeField, "opt_focus") : [];
  check("select chip resolves name + color", chips[0]?.text === "个人专注" && chips[0]?.color === "var(--color-green)", chips);
  check("limit respected", selectRecords(doc, { ...base, limit: 2 }).length === 2);
}

/** 用磁盘目录模拟 vault：getFiles 列出文件，getAbstractFileByPath 返回带 stat 的 TFile。 */
async function fakeApp(root: string = VAULT): Promise<{ app: unknown }> {
  const files: TFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(rel);
      else {
        const file = new TFile();
        file.path = rel;
        file.name = entry.name;
        file.basename = entry.name.replace(/\.[^.]+$/, "");
        file.extension = entry.name.split(".").pop() ?? "";
        const stat = await fs.stat(path.join(root, rel));
        file.stat = { ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
        files.push(file);
      }
    }
  };
  await walk("");
  const byPath = new Map(files.map((file) => [file.path, file]));
  const app = {
    vault: {
      configDir: ".obsidian",
      getFiles: () => files,
      getAbstractFileByPath: (p: string) => byPath.get(p) ?? null,
      cachedRead: async (file: TFile) => fs.readFile(path.join(root, file.path), "utf8"),
      getResourcePath: (file: TFile) => `app://local/${file.path}`,
      adapter: {
        exists: async (p: string) => fs.stat(path.join(root, p)).then(() => true, () => false),
        read: async (p: string) => fs.readFile(path.join(root, p), "utf8"),
        stat: async (p: string) => fs.stat(path.join(root, p)).then((stat) => ({ mtime: stat.mtimeMs, ctime: stat.ctimeMs, size: stat.size }), () => null),
        list: async (p: string) => {
          const entries = await fs.readdir(path.join(root, p), { withFileTypes: true });
          return {
            files: entries.filter((e) => e.isFile()).map((e) => `${p}/${e.name}`),
            folders: entries.filter((e) => e.isDirectory()).map((e) => `${p}/${e.name}`)
          };
        },
        getResourcePath: (p: string) => `app://local/${p}`
      }
    }
  };
  return { app };
}

/** 情报摘要用独立的临时夹具，不依赖测试库里会被手工改动的表。 */
async function writeDigestFixture(): Promise<string> {
  const root = path.resolve("tests/.out/fixture");
  await fs.mkdir(root, { recursive: true });
  const day = (offset: number): string => {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const stamp = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86400000).toISOString();
  const options = [
    { id: "o_todo", name: "待办", color: "var(--color-blue)" },
    { id: "o_doing", name: "进行中", color: "var(--color-orange)" },
    { id: "o_done", name: "已完成", color: "var(--color-green)" }
  ];
  const rows: Array<[string, string, string, string, number]> = [
    ["写周报", "o_todo", day(-1), day(0), 1],
    ["发票报销", "o_todo", day(-6), day(-2), 5],
    ["准备评审材料", "o_doing", day(1), day(3), 0],
    ["阅读论文 Qlib", "o_doing", "", "", 0],
    ["已完成的旧任务", "o_done", day(-5), day(-1), 0],
    ["下月规划", "o_todo", day(15), day(20), 0],
    ["昨天改过的备忘", "o_todo", "", "", 1]
  ];
  const doc = {
    schemaVersion: 1, id: "tbl_fixture", name: "测试任务", titleFieldId: "f_title",
    fields: [
      { id: "f_title", name: "任务", type: "text" },
      { id: "f_status", name: "状态", type: "singleSelect", options },
      { id: "f_start", name: "开始日期", type: "date" },
      { id: "f_due", name: "截止日期", type: "date" }
    ],
    records: rows.map(([title, status, start, due, ago], index) => ({
      id: `r${index}`, revision: 0, values: { f_title: title, f_status: status, f_start: start, f_due: due }, createdAt: stamp(ago), updatedAt: stamp(ago)
    })),
    views: [], meta: { createdAt: stamp(0), updatedAt: stamp(0), revision: 1 }
  };
  await fs.writeFile(path.join(root, "测试任务.duowei"), JSON.stringify(doc), "utf8");
  await fs.writeFile(path.join(root, "备份.自动备份.2026-01-01.duowei"), JSON.stringify(doc), "utf8");
  await fs.writeFile(path.join(root, "微信收件箱.duowei"), JSON.stringify({ ...doc, id: "tbl_w2o", meta: { ...doc.meta, wechat2ob: 1 } }), "utf8");
  return root;
}

/** 多维表格内置微信收件箱夹具：管理字段 + 状态选项，写在夹具根的 .obsidian/plugins/duowei-table-pro/data.json 指向的表。 */
async function writeInboxFixture(root: string): Promise<void> {
  const stamp = (hoursAgo: number): string => new Date(Date.now() - hoursAgo * 3600000).toISOString();
  const typeOptions = [["文字", "o_text"], ["图片", "o_image"], ["语音", "o_voice"]].map(([name, id]) => ({ id, name, color: "var(--color-blue)" }));
  const statusOptions = [{ id: "o_pending", name: "待整理", color: "var(--color-orange)" }, { id: "o_done", name: "已整理", color: "var(--color-green)" }];
  const fields = [
    { id: "f_title", name: "标题", type: "text" },
    { id: "f_content", name: "内容", type: "longText" },
    { id: "f_type", name: "类型", type: "singleSelect", options: typeOptions },
    { id: "f_att", name: "附件", type: "attachment" },
    { id: "f_transcript", name: "语音转写", type: "longText" },
    { id: "f_received", name: "接收时间", type: "dateTime" },
    { id: "f_status", name: "状态", type: "singleSelect", options: statusOptions }
  ];
  const records = [
    { id: "m1", values: { f_title: "合同", f_content: "记得明天把合同发给王总", f_type: "o_text", f_received: stamp(1), f_status: "o_pending" } },
    { id: "m2", values: { f_title: "开会", f_content: "", f_transcript: "今天下午三点开会", f_type: "o_voice", f_received: stamp(3), f_status: "o_pending" } },
    { id: "m3", values: { f_title: "图", f_content: "", f_type: "o_image", f_att: ["[[收件箱/微信收件箱附件/2026-09/abc-demo.png]]"], f_received: stamp(30), f_status: "o_done" } }
  ].map((record) => ({ ...record, revision: 0, createdAt: stamp(0), updatedAt: stamp(0) }));
  const doc = { schemaVersion: 1, id: "tbl_inbox", name: "微信收件箱", titleFieldId: "f_title", fields, records, views: [{ id: "v_k", name: "看板", type: "kanban", groupFieldId: "f_status", fieldOrder: [], hiddenFields: [], sorts: [], filters: [], filterConjunction: "and", colorRules: [], collapsedDetailGroups: [] }], meta: { createdAt: stamp(0), updatedAt: stamp(0), revision: 1 } };
  await fs.mkdir(path.join(root, "收件箱"), { recursive: true });
  await fs.writeFile(path.join(root, "收件箱/微信收件箱.duowei"), JSON.stringify(doc), "utf8");
  await fs.mkdir(path.join(root, ".obsidian/plugins/duowei-table-pro"), { recursive: true });
  await fs.writeFile(path.join(root, ".obsidian/plugins/duowei-table-pro/data.json"), JSON.stringify({
    weixinInbox: { endpoint: "http://127.0.0.1:7341", tablePath: "收件箱/微信收件箱.duowei", clientId: "obsidian-test", autoSyncSeconds: 3, fieldMap: { titleFieldId: "f_title", contentFieldId: "f_content", typeFieldId: "f_type", attachmentFieldId: "f_att", transcriptFieldId: "f_transcript", receivedAtFieldId: "f_received", senderFieldId: "x", sessionFieldId: "x", messageIdFieldId: "x", statusFieldId: "f_status", pendingStatusOptionId: "o_pending", typeOptionIds: {} } }
  }), "utf8");
}

async function testDuoweiInbox(): Promise<void> {
  const root = await writeDigestFixture();
  await writeInboxFixture(root);
  const { app } = await fakeApp(root);
  const config = { source: "auto" as const, duoweiPluginId: "duowei-table-pro", duoweiTablePath: "", pluginId: "wechat2ob", stateFolder: "", showStats: true, showThumbs: true, days: 0, limit: 10, kinds: [], pendingOnly: false };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await loadWechat(app as any, config);
  check("auto picks the table-plugin inbox", data.ready && data.source === "duowei" && data.tablePath === "收件箱/微信收件箱.duowei", [data.ready, data.source, data.tablePath]);
  check("inbox counts", data.items.length === 3 && data.pending === 2 && data.today >= 2 && data.attachments === 1, [data.items.length, data.pending, data.today, data.attachments]);
  check("kind from 类型 option label", data.items.find((item) => item.recordId === "m2")?.kind === "voice");
  check("text prefers 内容 then 语音转写", data.items.find((item) => item.recordId === "m2")?.text === "今天下午三点开会");
  check("attachment link parsed to image thumbnail", data.items.find((item) => item.recordId === "m3")?.image === "收件箱/微信收件箱附件/2026-09/abc-demo.png", data.items.find((item) => item.recordId === "m3"));
  check("status + mark-done metadata exposed", data.duowei?.doneOptionId === "o_done" && data.duowei.pendingOptionId === "o_pending" && data.duowei.kanbanViewId === "v_k");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pendingOnly = await loadWechat(app as any, { ...config, pendingOnly: true });
  check("pendingOnly filter", pendingOnly.items.length === 2 && pendingOnly.items.every((item) => item.pending));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const forced = await loadWechat(app as any, { ...config, source: "wechat2ob" });
  check("forcing wechat2ob without journals → not ready", !forced.ready && forced.source === "wechat2ob");
}

async function testDigest(): Promise<void> {
  const root = await writeDigestFixture();
  await writeInboxFixture(root);
  const { app } = await fakeApp(root);
  const options = { folder: "", excludeTables: [], dateFieldNames: [], upcomingDays: 7, overdueDays: 30, recentDays: 3, sectionLimit: 6, sections: ["overdue", "today", "upcoming", "active", "recent"] as const };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const digest = await buildDigest(app as any, { ...options, sections: [...options.sections] });
  const bySection = (section: string): string[] => digest.items.filter((item) => item.section === section).map((item) => item.title);
  check("digest scans only the real task table", digest.tables === 1, digest.tables);
  check("today by due date (not start date)", bySection("today").includes("写周报"), bySection("today"));
  check("overdue section", bySection("overdue").includes("发票报销"), bySection("overdue"));
  check("upcoming section (3 days)", bySection("upcoming").includes("准备评审材料"), bySection("upcoming"));
  check("active by status", bySection("active").includes("阅读论文 Qlib"), bySection("active"));
  check("recent updates", bySection("recent").includes("昨天改过的备忘"), bySection("recent"));
  check("done records skipped", !digest.items.some((item) => item.title === "已完成的旧任务"));
  check("far-future record only appears as recent update", digest.items.find((item) => item.title === "下月规划")?.section === "recent");
  check("status chip carried", digest.items.find((item) => item.title === "写周报")?.status?.text === "待办");
  check("wechat inbox tables skipped (both flavours)", !digest.items.some((item) => item.tablePath.includes("微信收件箱")) && digest.tables === 1, digest.items.map((item) => item.tablePath));
  check("backup tables skipped", !digest.items.some((item) => item.tablePath.includes("自动备份")));
}

async function testWechat(): Promise<void> {
  const { app } = await fakeApp();
  const config = { source: "wechat2ob" as const, duoweiPluginId: "duowei-table-pro", duoweiTablePath: "", pluginId: "wechat2ob", stateFolder: "", showStats: true, showThumbs: true, days: 14, limit: 10, kinds: [], pendingOnly: false };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await loadWechat(app as any, config);
  check("wechat journals loaded", data.ready && data.items.length === 4, [data.ready, data.items.length]);
  check("today / week counts", data.today >= 0 && data.week >= 0, [data.today, data.week]);
  check("pending from managed table", data.pending === 2, data.pending);
  check("voice message uses transcript", data.items.some((item) => item.kind === "voice" && item.text.includes("开会")));
  check("image message has thumbnail + attachment", data.items.some((item) => item.kind === "image" && item.image?.endsWith("demo-image.png")));
  check("note path from receipts", data.items[0]?.notePath?.startsWith("日记/") === true, data.items[0]);
  check("sorted newest first", data.items[0].receivedAt >= data.items[1].receivedAt);
  check("today note path resolved", data.todayNotePath.startsWith("日记/"), data.todayNotePath);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filtered = await loadWechat(app as any, { ...config, kinds: ["text"] });
  check("kind filter", filtered.items.every((item) => item.kind === "text") && filtered.items.length === 2, filtered.items.length);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const missing = await loadWechat(app as any, { ...config, pluginId: "nope-plugin" });
  check("missing plugin → not ready", !missing.ready);
}

/** WeChat2Ob 公开 api 优先：不依赖测试库，用空目录 + 内存里的插件 api。 */
async function testWechat2obApi(): Promise<void> {
  const root = path.resolve("tests/.out/wechat-api-fixture");
  await fs.mkdir(root, { recursive: true });
  const { app } = await fakeApp(root);
  const config = { source: "wechat2ob" as const, duoweiPluginId: "duowei-table-pro", duoweiTablePath: "", pluginId: "wechat2ob", stateFolder: "", showStats: true, showThumbs: true, days: 14, limit: 2, kinds: [], pendingOnly: false };
  const now = Date.now();
  const inbox: Wechat2obInboxV1 = {
    messages: [
      { key: "k-old", kind: "text", title: "", content: "  早上\n好  ", transcript: "", receivedAt: new Date(now - 3600000).toISOString(), notePath: "日记/今天.md", attachments: [] },
      { key: "k-voice", kind: "voice", title: "", content: "", transcript: "下午三点开会", receivedAt: new Date(now - 60000).toISOString(), attachments: [{ path: "WeChat2Ob/附件/a.m4a", kind: "voice", mimeType: "audio/mp4" }] },
      { key: "k-image", kind: "image", title: "", content: "", transcript: "", receivedAt: new Date(now - 120000).toISOString(), attachments: [{ path: "WeChat2Ob/附件/b.png", kind: "image", mimeType: "image/png" }] },
      { key: "k-bad", kind: "text", title: "", content: "坏时间", transcript: "", receivedAt: "not-a-date", attachments: [] }
    ],
    today: 5, week: 9, attachments: 2, pending: 1, todayNotePath: "日记/今天.md", tablePath: "WeChat2Ob/微信收件箱.duowei", inboxRoot: "WeChat2Ob"
  };
  const queries: unknown[] = [];
  let syncs = 0;
  let mode: "ok" | "malformed" | "throw" = "ok";
  const api = {
    version: 1 as const,
    query: async (options: unknown) => {
      queries.push(options);
      if (mode === "throw") throw new Error("boom");
      return mode === "malformed" ? ({ messages: [] } as unknown as Wechat2obInboxV1) : inbox;
    },
    sync: async () => {
      syncs += 1;
    },
    openInbox: () => undefined
  };
  const withApi = { ...(app as object), plugins: { plugins: { wechat2ob: { api } } } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viaApi = await loadWechat(withApi as any, config);
  check("wechat2ob api preferred", viaApi.ready && viaApi.via === "api", [viaApi.ready, viaApi.via]);
  check("api query receives widget filters", JSON.stringify(queries[0]) === JSON.stringify({ days: 14, limit: 2, kinds: [] }), queries[0]);
  check("api stats passed through", viaApi.today === 5 && viaApi.week === 9 && viaApi.attachments === 2 && viaApi.pending === 1, viaApi);
  check("api items sorted, invalid dropped, limit applied", viaApi.items.map((item) => item.key).join() === "k-voice,k-image", viaApi.items.map((item) => item.key));
  check("api voice summarized from transcript", viaApi.items[0]?.text === "下午三点开会", viaApi.items[0]);
  check("api image thumbnail detected", viaApi.items[1]?.image === "WeChat2Ob/附件/b.png", viaApi.items[1]);
  check("api paths passed through", viaApi.todayNotePath === "日记/今天.md" && viaApi.tablePath === "WeChat2Ob/微信收件箱.duowei");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all = await loadWechat(withApi as any, { ...config, limit: 10 });
  check("api text whitespace normalized", all.items.find((item) => item.key === "k-old")?.text === "早上 好", all.items.map((item) => item.text));

  mode = "malformed";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const malformed = await loadWechat(withApi as any, config);
  check("malformed api result falls back to journals", malformed.via === "journal" && !malformed.ready, [malformed.via, malformed.ready]);
  mode = "throw";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const thrown = await loadWechat(withApi as any, config);
  check("throwing api falls back to journals", thrown.via === "journal", thrown.via);

  const future = { ...(app as object), plugins: { plugins: { wechat2ob: { api: { ...api, version: 2 } } } } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  check("unknown api version ignored", wechat2obApi(future as any, "wechat2ob") === null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noApi = await loadWechat(app as any, config);
  check("no api → journal fallback", noApi.via === "journal" && !noApi.ready, [noApi.via, noApi.ready]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  check("sync via api handled", (await syncWechat2obViaApi(withApi as any, "wechat2ob")) && syncs === 1, syncs);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  check("sync without api defers to command", !(await syncWechat2obViaApi(app as any, "wechat2ob")));
}

async function testAnnotations(): Promise<void> {
  const adapterPath = (p: string): string => path.join(VAULT, p);
  const app = {
    vault: {
      configDir: ".obsidian",
      getAbstractFileByPath: () => null,
      adapter: {
        exists: async (p: string) => fs.stat(adapterPath(p)).then(() => true, () => false),
        read: async (p: string) => fs.readFile(adapterPath(p), "utf8"),
        list: async (p: string) => {
          const entries = await fs.readdir(adapterPath(p), { withFileTypes: true });
          return {
            files: entries.filter((e) => e.isFile()).map((e) => `${p}/${e.name}`),
            folders: entries.filter((e) => e.isDirectory()).map((e) => `${p}/${e.name}`)
          };
        },
        getResourcePath: (p: string) => `app://local/${p}`
      }
    }
  };
  const config = {
    pluginId: "mobile-ink-annotation-pro",
    centerFolder: "Annotations/annotation-center",
    mdSourceFolder: "Annotations/md-source-annotations",
    cardsFolder: "Annotations/card-favorites",
    showStats: true, showList: true, showPreview: true,
    status: "all" as const, collection: "", sortBy: "updatedAt" as const, limit: 10, panel: "annotations" as const
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await loadAnnotations(app as any, config);
  check("index loaded", data.ready);
  check("counts inbox/archived", data.inbox === 5 && data.archived === 1, [data.inbox, data.archived]);
  check("question bank due today", data.questions === 7 && data.due >= 0, [data.questions, data.due]);
  check("cards count", data.cards === 2, data.cards);
  check("collections with counts", data.collections.find((c) => c.id === "mistakes")?.count === 1, data.collections);
  const md = data.items.find((i) => i.type === "md-source");
  check("md-source item resolves text + open target", md?.text === "这一句被原文批注选中了。" && !!md.openTarget && "path" in md.openTarget && md.openTarget.line === 4, md);
  const collected = data.items.find((i) => i.type === "collected");
  check("collected item uses backlink", !!collected?.openTarget && "link" in collected.openTarget && collected.openTarget.link === "示例笔记.md", collected?.openTarget);
  const hw = data.items.find((i) => i.key === "handwriting:aaa2");
  check("card path picked from cardPaths", hw?.cardPath === "Annotations/Cards/学习卡片-示例.md", hw?.cardPath);
  check("sorted by updatedAt desc", data.items[0]?.key === "handwriting:aaa1", data.items.map((i) => i.key));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const missing = await loadAnnotations(app as any, { ...config, centerFolder: "Annotations/nope" });
  check("missing folder → not ready", !missing.ready);
}

function testRegistry(): void {
  const before = listWidgetDefinitions().length;
  const events: string[] = [];
  const off = onRegistryChange((kind, registered) => events.push(`${kind}:${registered}`));
  const unregister = registerWidget({
    kind: "third-party-demo", name: "演示", description: "", icon: "plug", accent: "#000",
    defaultSize: { w: 4, h: 4 }, defaultConfig: () => ({ ref: "" }),
    render: () => undefined, renderSettings: () => undefined
  }, "demo-plugin");
  check("third-party widget registered", listWidgetDefinitions().length === before + 1 && getWidgetDefinition("third-party-demo")?.name === "演示");
  const kept = sanitizeWidget({ id: "x", kind: "not-loaded-kind", w: 5, h: 3, config: { ref: "a#b" }, provider: "some-plugin" });
  check("unknown kind survives sanitize with config + provider", kept?.kind === "not-loaded-kind" && kept.config.ref === "a#b" && kept.provider === "some-plugin" && kept.w === 5, kept);
  check("createWidgetInstance for unknown kind uses fallback size", createWidgetInstance("nope", { config: { a: 1 } }).w === 6);
  let threw = false;
  try {
    registerWidget({ kind: "hero", name: "x", description: "", icon: "", accent: "", defaultSize: { w: 1, h: 1 }, defaultConfig: () => ({}), render: () => undefined, renderSettings: () => undefined });
  } catch {
    threw = true;
  }
  check("built-in kinds cannot be overridden", threw);
  unregister();
  check("unregister removes definition and notifies", getWidgetDefinition("third-party-demo") === undefined && events.join(",") === "third-party-demo:true,third-party-demo:false", events);
  off();
}

async function testUserCustomWidgets(): Promise<void> {
  const fakeApp = { vault: {} };
  const def = await evaluateWidgetScript(DEMO_WIDGET_TEMPLATE, fakeApp as never);
  check("demo template evaluates to valid widget", def.kind === "user-clock-demo" && def.name === "示例时钟与问候");
  check("demo template default size is 4x3", def.defaultSize.w === 4 && def.defaultSize.h === 3);
  check("demo template has icon and accent", def.icon === "clock" && def.accent === "#6366f1");
  const cfg = def.defaultConfig();
  check("demo template defaultConfig contains greeting", typeof cfg.greeting === "string" && cfg.showSeconds === true);

  const fnScript = `
    module.exports = () => ({
      kind: "test-fn-widget",
      name: "函数组件",
      render: () => {}
    });
  `;
  const fnDef = await evaluateWidgetScript(fnScript, fakeApp as never);
  check("function export evaluates correctly", fnDef.kind === "test-fn-widget" && fnDef.name === "函数组件");
  check("fallback size is 6x4", fnDef.defaultSize.w === 6 && fnDef.defaultSize.h === 4);
  check("fallback icon is box", fnDef.icon === "box");

  const retScript = `
    return {
      kind: "test-ret-widget",
      name: "直接返回组件",
      render: () => {}
    };
  `;
  const retDef = await evaluateWidgetScript(retScript, fakeApp as never);
  check("return export evaluates correctly", retDef.kind === "test-ret-widget" && retDef.name === "直接返回组件");

  let errorCaught = false;
  try {
    await evaluateWidgetScript("module.exports = { name: '无kind' };", fakeApp as never);
  } catch {
    errorCaught = true;
  }
  check("missing kind throws error", errorCaught);

  errorCaught = false;
  try {
    await evaluateWidgetScript("module.exports = { kind: 'no-render', name: '无render' };", fakeApp as never);
  } catch {
    errorCaught = true;
  }
  check("missing render throws error", errorCaught);

  const sanitized = sanitizeSettings({ customWidgetsFolder: "  _scripts/my-widgets/  " });
  check("customWidgetsFolder is sanitized and trimmed", sanitized.customWidgetsFolder === "_scripts/my-widgets/");
  const defaultSanitized = sanitizeSettings({});
  check("customWidgetsFolder defaults to empty string", defaultSanitized.customWidgetsFolder === "");

  // 测试 CustomWidgetManager 加载与注销生命周期
  const mockFiles = new Map<string, string>();
  mockFiles.set("_scripts/hp/w1.js", `module.exports = { kind: "mgr-test-1", name: "组件1", render: () => {} };`);
  mockFiles.set("_scripts/hp/w2.js", `module.exports = { kind: "mgr-test-2", name: "组件2", render: () => {} };`);

  const mockFolder = new TFolder();
  mockFolder.path = "_scripts/hp";
  const f1 = new TFile(); f1.path = "_scripts/hp/w1.js"; f1.extension = "js"; f1.name = "w1.js";
  const f2 = new TFile(); f2.path = "_scripts/hp/w2.js"; f2.extension = "js"; f2.name = "w2.js";
  mockFolder.children = [f1, f2];

  const fakeVault = {
    getAbstractFileByPath: (p: string) => (p === "_scripts/hp" ? mockFolder : mockFiles.has(p) ? (p === f1.path ? f1 : f2) : null),
    read: async (file: TFile) => mockFiles.get(file.path) ?? "",
    create: async () => {},
    createFolder: async () => {},
    trash: async (file: TFile) => {
      mockFiles.delete(file.path);
    }
  };
  const registeredKinds = new Set<string>();
  const fakePlugin = {
    settings: {
      customWidgetsFolder: "_scripts/hp",
      pages: [
        {
          id: "p1",
          name: "测试页",
          widgets: [
            { id: "w-inst-1", kind: "mgr-test-2", w: 6, h: 4, config: {} }
          ]
        }
      ]
    },
    app: { vault: fakeVault, workspace: { getLeaf: () => ({ openFile: async () => {} }) } },
    api: {
      registerWidget: (wdef: { kind: string }) => {
        registeredKinds.add(wdef.kind);
        return () => registeredKinds.delete(wdef.kind);
      }
    },
    refreshViews: () => {},
    registerEvent: () => {},
    saveSettings: async () => {}
  };

  const mgr = new CustomWidgetManager(fakePlugin as never);
  const loadedCount = await mgr.loadAll(true);
  check("manager loaded 2 widgets", loadedCount === 2);
  check("manager registered both kinds", registeredKinds.has("mgr-test-1") && registeredKinds.has("mgr-test-2"));

  const loadedList = mgr.getLoadedWidgets();
  check("getLoadedWidgets returns 2 entries", loadedList.length === 2);
  check("hasKind finds registered kind", mgr.hasKind("mgr-test-2") && !mgr.hasKind("non-existent"));
  const w2Info = mgr.getWidgetByKind("mgr-test-2");
  check("getWidgetByKind returns correct metadata", w2Info?.name === "组件2" && w2Info?.filePath === f2.path);

  // 单文件热更新
  mockFiles.set("_scripts/hp/w1.js", `module.exports = { kind: "mgr-test-1-updated", name: "组件1更新", render: () => {} };`);
  await mgr.loadFile(f1, false);
  check("manager hot-reloaded updated kind", !registeredKinds.has("mgr-test-1") && registeredKinds.has("mgr-test-1-updated"));

  // 测试组件删除与页面实例清理
  await mgr.deleteWidget(f2.path, { removeInstances: true });
  check("deleteWidget removed kind from registeredKinds", !registeredKinds.has("mgr-test-2"));
  check("deleteWidget trashed the file", !mockFiles.has(f2.path));
  check("deleteWidget cleaned page instance", fakePlugin.settings.pages[0].widgets.length === 0);

  // 单文件卸载
  mgr.unloadFile(f1.path, false);
  check("manager unloaded file", !registeredKinds.has("mgr-test-1-updated"));

  // 全量卸载
  mgr.unloadAll();
  check("manager unloaded all", registeredKinds.size === 0);

  // 新脚本首次加载自动放上当前首页，每个 kind 只一次
  mockFiles.set("_scripts/hp/w1.js", `module.exports = { kind: "auto-old", name: "旧组件", render: () => {} };`);
  mockFiles.set("_scripts/hp/w2.js", `module.exports = { kind: "auto-new", name: "新组件", defaultSize: { w: 3, h: 5 }, render: () => {} };`);
  mockFolder.children = [f1];
  const autoPage = { id: "auto", name: "自动", widgets: [] as Array<{ id: string; kind: string; w: number; h: number; config: Record<string, unknown> }> };
  let autoSaves = 0;
  const autoPlugin = {
    ...fakePlugin,
    // 真实插件的 api.registerWidget 会写进组件注册表，自动加入的卡片据此取默认尺寸。
    api: { registerWidget: (wdef: Parameters<typeof registerWidget>[0], provider?: string) => registerWidget(wdef, provider) },
    settings: { customWidgetsFolder: "_scripts/hp", autoAddCustomWidgets: true, seenCustomWidgetKinds: [] as string[], pages: [autoPage] },
    getActivePage: () => autoPage,
    saveSettings: async () => { autoSaves += 1; }
  };
  const autoMgr = new CustomWidgetManager(autoPlugin as never);
  await autoMgr.loadAll(true);
  check("startup scan registers existing scripts without adding cards", autoPage.widgets.length === 0 && autoPlugin.settings.seenCustomWidgetKinds.includes("auto-old"));
  await Promise.all([autoMgr.loadFile(f2, true), autoMgr.loadFile(f2, true)]);
  check("new script is added to the active page exactly once", autoPage.widgets.filter((w) => w.kind === "auto-new").length === 1, autoPage.widgets);
  check("auto-added card uses the script's default size", autoPage.widgets[0]?.w === 3 && autoPage.widgets[0]?.h === 5);
  check("auto-add persists settings", autoSaves > 0 && autoPlugin.settings.seenCustomWidgetKinds.includes("auto-new"));
  autoPage.widgets.length = 0;
  await autoMgr.loadFile(f2, true);
  check("editing a script after its card was removed does not re-add it", autoPage.widgets.length === 0);
  autoPlugin.settings.autoAddCustomWidgets = false;
  mockFiles.set("_scripts/hp/w2.js", `module.exports = { kind: "auto-off", name: "关闭时", render: () => {} };`);
  await autoMgr.loadFile(f2, true);
  autoPlugin.settings.autoAddCustomWidgets = true;
  await autoMgr.loadFile(f2, true);
  check("scripts loaded while auto-add was off are not added later", autoPage.widgets.length === 0 && autoPlugin.settings.seenCustomWidgetKinds.includes("auto-off"));
  autoMgr.unloadAll();
  const legacy = sanitizeSettings({ customWidgetsFolder: "x" });
  check("new settings default: auto-add on, seen list empty, tabs shown", legacy.autoAddCustomWidgets === true && legacy.seenCustomWidgetKinds.length === 0 && legacy.alwaysShowPageTabs === true);
  const kept = sanitizeSettings({ alwaysShowPageTabs: false, seenCustomWidgetKinds: ["a", "a", 3, "b"] });
  check("saved tab setting kept; seen list deduped and filtered", kept.alwaysShowPageTabs === false && kept.seenCustomWidgetKinds.join(",") === "a,b");
}

function testHabitStreak(): void {
  const done = new Set(["2026-09-28", "2026-09-29", "2026-09-30", "2026-09-26"]);
  const isDone = (iso: string): boolean => done.has(iso);
  check("streak counts back from today", habitStreak(isDone, "2026-09-30") === 3);
  check("today not yet checked in keeps yesterday's streak", habitStreak(isDone, "2026-10-01") === 3);
  check("gap of two days breaks the streak", habitStreak(isDone, "2026-10-02") === 0);
  check("streak respects the loaded range limit", habitStreak(isDone, "2026-09-30", 2) === 2);
  check("streak crosses month boundaries", habitStreak((iso) => iso >= "2026-08-30" && iso <= "2026-09-02", "2026-09-02") === 4);
}

function testPomodoro(): void {
  const definition = getWidgetDefinition("pomodoro");
  check("pomodoro widget registered", definition?.name === "番茄时钟");
  const config = normalizePomodoro({});
  check("fresh session idle at focus with full duration", config.session.state === "idle" && remainingMs(config, config.session, 0) === 25 * 60_000, config.session);
  const now = 1_000_000;
  const running = startSession(config, config.session, now);
  check("start schedules endsAt", running.state === "running" && running.endsAt === now + 25 * 60_000, running);
  const paused = pauseSession(config, running, now + 60_000);
  check("pause keeps remaining", paused.state === "paused" && paused.remainingMs === 24 * 60_000, paused);
  check("resume continues from remaining", startSession(config, paused, now + 90_000).endsAt === now + 90_000 + 24 * 60_000);
  const first = advanceSession(config, running, { count: true, now, allowAutoStart: true });
  check("focus complete → short break auto-started, round 1", first.completedFocus && first.session.phase === "short" && first.session.state === "running" && first.session.round === 1, first.session);
  const afterBreak = advanceSession(config, first.session, { count: true, now, allowAutoStart: true });
  check("break complete → focus idle (autoStartFocus off)", !afterBreak.completedFocus && afterBreak.session.phase === "focus" && afterBreak.session.state === "idle" && afterBreak.session.round === 1, afterBreak.session);
  const fourth = advanceSession(config, { ...running, round: 3 }, { count: true, now, allowAutoStart: false });
  check("4th focus → long break, not auto-started when stale", fourth.session.phase === "long" && fourth.session.round === 4 && fourth.session.state === "idle", fourth.session);
  const cycle = advanceSession(config, fourth.session, { count: true, now, allowAutoStart: true });
  check("long break → focus resets round", cycle.session.phase === "focus" && cycle.session.round === 0, cycle.session);
  const skipped = advanceSession(config, running, { count: false, now, allowAutoStart: true });
  check("skip focus does not count", !skipped.completedFocus && skipped.session.phase === "short" && skipped.session.round === 0, skipped.session);
  check("manual phase switch resets", resetSession(config, running, "long").state === "idle" && resetSession(config, running, "long").phase === "long");
  const history = bumpHistory({ "2026-01-01": 2 }, "2026-01-01");
  check("history increments", history["2026-01-01"] === 3);
  const junk = normalizePomodoro({ focusMinutes: "abc", roundsBeforeLongBreak: 2, session: { phase: "nope", state: "running", endsAt: "x", round: 9 }, history: { bad: 1, "2026-02-02": "3" } });
  check("junk config normalized", junk.focusMinutes === 25 && junk.session.phase === "focus" && junk.session.state === "idle" && junk.session.round === 1 && junk.history["2026-02-02"] === 3 && !("bad" in junk.history), junk);
  check("clock format", formatClock(25 * 60_000) === "25:00" && formatClock(59_400) === "01:00" && formatClock(0) === "00:00");
}

function testWeatherHelpers(): void {
  check("stripSuffix drops 县/区/市 but keeps 杭州", stripSuffix("安吉县") === "安吉" && stripSuffix("海淀区") === "海淀" && stripSuffix("昆山市") === "昆山" && stripSuffix("杭州") === "杭州" && stripSuffix("市中区") === "市中");
  check("splitQuery 浙江 安吉", JSON.stringify(splitQuery("浙江 安吉")) === JSON.stringify({ name: "安吉", hint: "浙江" }) && splitQuery("安吉").hint === "");
  check("parseCoords", parseCoords("30.63,119.71")?.lon === 119.71 && parseCoords("安吉") === null && parseCoords("95,10") === null);
  const ranked = rankCmaCandidates([
    { id: "57799", name: "吉安县", pinyin: "Jianxian", country: "中国" },
    { id: "G05025", name: "罗安达", pinyin: "罗安达", country: "安哥拉" },
    { id: "58446", name: "安吉", pinyin: "Anji", country: "中国" },
    { id: "53859", name: "吉县", pinyin: "Jixian", country: "中国" }
  ], "安吉县");
  check("CMA candidates: exact (suffix-insensitive) first, foreign last", ranked.map((item) => item.id).join(",") === "58446,57799,53859,G05025", ranked.map((item) => item.name));
  check("CMA pinyin match", rankCmaCandidates([{ id: "1", name: "集安", pinyin: "Jian", country: "中国" }, { id: "2", name: "安吉", pinyin: "Anji", country: "中国" }], "anji")[0].id === "2");
  check("CMA icon codes", cmaIcon(0, "晴", true) === "sun" && cmaIcon(0, "晴", false) === "moon" && cmaIcon(4, "雷阵雨", true) === "cloud-lightning" && cmaIcon(14, "小雪", true) === "cloud-snow" && cmaIcon(99, "中雨", true) === "cloud-rain");
  check("QWeather icon codes", qweatherIcon(150, "晴") === "moon" && qweatherIcon(305, "小雨") === "cloud-drizzle" && qweatherIcon(404, "雨夹雪") === "cloud-hail" && qweatherIcon(502, "霾") === "haze");
  check("normalizeHost strips scheme/slash", normalizeHost("https://abc.xy.qweatherapi.com/") === "abc.xy.qweatherapi.com");
}

function testMedia(): void {
  const definition = getWidgetDefinition("media");
  check("media widget registered", definition?.name === "主流媒体");
  const defaults = definition?.defaultConfig();
  check("media widget defaults contain Qiushi and ZJXC", defaults?.showQiushi === true && defaults?.showZjxc === true);
  
  // Test Qiushi catalog parsing
  const mockCatalog = `
    <p>&emsp;&emsp;<a href="https://www.qstheory.cn/20260115/707f35de942d400f95f07b839a9625b0/c.html"><strong>《求是》2026年第2期</strong></a></p>
    <p><strong>&emsp;&emsp;<a href="https://www.qstheory.cn/20260915/3ffd335483ab41a3a67f182fcfdb5c72/c.html">《求是》2026年第18期</a></strong></p>
  `;
  const issues = parseQiushiCatalog(mockCatalog);
  check("qiushi catalog parsed issues descending", issues.length === 2 && issues[0].issueNumber === 18 && issues[0].title === "《求是》2026年第18期");

  // Test Qiushi issue articles parsing
  const mockIssue = `
    <p>&emsp;&emsp;<a href="https://www.qstheory.cn/20260915/0196377275f74e5e8a523a6d481dd793/c.html"><strong>本期导读</strong></a></p>
    <p>&emsp;&emsp;<span style="font-size: 20px;"><a href="https://www.qstheory.cn/20260915/a65819cc95eb486daf0cea84706c58dc/c.html"><strong>在加强基础研究座谈会上的讲话</strong></a> <span style="font-family: 楷体;">/习近平</span></span></p>
    <p>&emsp;&emsp;<a href="https://www.qstheory.cn/20260915/443b96d34b5f452c8d7adac323716858/c.html"><span style="font-family: 楷体;">深度调研 / </span><strong>新型能源体系调查</strong></a> <span style="font-family: 楷体;">/联合课题组</span></p>
    <p>&emsp;&emsp;<a href="https://www.qstheory.cn/20260915/3e3ca20fb6fb43edaa8a8ba9f668814f/c.html"><strong>“等安排”难有“真作为”</strong></a><span style="font-family: 楷体;">（党员来信） /陈吉平</span></p>
  `;
  const articles = parseQiushiIssueArticles(mockIssue, "《求是》2026年第18期");
  check("qiushi issue parsed articles", articles.length === 4);
  const speech = articles.find((a) => a.title.includes("基础研究"));
  check("speech article author and title", speech?.author === "习近平" && speech?.title === "在加强基础研究座谈会上的讲话");
  const survey = articles.find((a) => a.title.includes("新型能源"));
  check("survey article column and author", survey?.column === "深度调研" && survey?.author === "联合课题组");
  const letter = articles.find((a) => a.title.includes("真作为"));
  check("letter article column and author", letter?.column === "党员来信" && letter?.author === "陈吉平");

  // Test Zhejiang Propaganda parsing
  const mockZjxc = `
    <li class="listLi">
      <span class="listSpan">2026年09月14日11时</span>
      <a href="//zjnews.zjol.com.cn/zjxc/202609/t20260914_31908230.shtml">浙江宣传 | 情绪泛滥时不妨抄抄书</a>
    </li>
    <li class="listLi">
      <span class="listSpan">2026年09月13日12时</span>
      <a href="//zjnews.zjol.com.cn/zjxc/202609/t20260913_31907223.shtml">浙江宣传 | 《交锋》足够尊重观众</a>
    </li>
  `;
  const zjArticles = parseZjxcArticles(mockZjxc);
  check("zjxc articles parsed and title stripped", zjArticles.length === 2 && zjArticles[0].title === "情绪泛滥时不妨抄抄书" && zjArticles[0].url.startsWith("https:"));

  // Test htmlToMarkdown
  const mockHtml = `
    <div id="detailContent">
      <p>第一段测试内容，带有<strong>重点文字</strong>。</p>
      <p>第二段内容包含<img src="https://example.com/pic.jpg">图片。</p>
    </div>
  `;
  const md = htmlToMarkdown(mockHtml);
  check("html to markdown cleans formatting", md.includes("**重点文字**") && md.includes("![](https://example.com/pic.jpg)"));

  // Test WeChat Official Account RSS and HTML
  const mockWechatRss = `
    <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
      <channel>
        <title>人民日报</title>
        <item>
          <title><![CDATA[重磅速递：全面深化改革新举措]]></title>
          <link>https://mp.weixin.qq.com/s/sample_wechat_article_123</link>
          <pubDate>Mon, 15 Sep 2026 12:00:00 GMT</pubDate>
          <dc:creator>人民日报评论员</dc:creator>
          <description><![CDATA[本文是概要文字]]></description>
          <content:encoded><![CDATA[<div id="js_content" class="rich_media_content"><p>这是微信公众号<strong>正文段落</strong>。</p><p><img data-src="https://mmbiz.qpic.cn/mmbiz_jpg/test123/0?wx_fmt=jpeg"></p></div>]]></content:encoded>
        </item>
      </channel>
    </rss>
  `;
  const wechatArticles = parseRssArticles(mockWechatRss, "人民日报");
  check("wechat rss parsed author, title, and link", wechatArticles.length === 1 && wechatArticles[0].title === "重磅速递：全面深化改革新举措" && wechatArticles[0].author === "人民日报评论员");
  check("wechat rss extracted fullHtml", Boolean(wechatArticles[0].fullHtml && wechatArticles[0].fullHtml.includes("js_content")));

  // Test htmlToMarkdown with WeChat js_content and data-src
  if (wechatArticles[0].fullHtml) {
    const wechatMd = htmlToMarkdown(wechatArticles[0].fullHtml);
    check("wechat html to markdown parsed bold and data-src image", wechatMd.includes("**正文段落**") && wechatMd.includes("![](https://mmbiz.qpic.cn/mmbiz_jpg/test123/0?wx_fmt=jpeg)"));
  }
}

async function testOpmlAndFollow(): Promise<void> {
  const followOpmlPath = "C:/Users/加加/Desktop/follow.opml";
  let opmlContent = "";
  try {
    opmlContent = await fs.readFile(followOpmlPath, "utf8");
  } catch (err) {
    console.warn("Could not read follow.opml:", err);
  }

  if (opmlContent) {
    const feeds = parseOpml(opmlContent);
    check("follow.opml parsed exactly 60 feeds", feeds.length === 60, feeds.length);

    // Verify categories
    const categories = new Set(feeds.map((f) => f.category));
    check("follow.opml contains expected categories",
      categories.has("科技") &&
      categories.has("时政") &&
      categories.has("财经") &&
      categories.has("新闻") &&
      categories.has("视频 / 时政") &&
      categories.has("播客音频") &&
      categories.has("精选文章"),
      Array.from(categories)
    );

    // Verify specific feeds
    const sspai = feeds.find((f) => f.name === "少数派");
    check("sspai parsed with url and category", Boolean(sspai && sspai.url.includes("sspai") && sspai.category === "科技"));

    const halfLatte = feeds.find((f) => f.name.includes("半拿铁"));
    check("halfLatte podcast parsed with category", Boolean(halfLatte && halfLatte.category === "播客音频"));

    const bilibili = feeds.find((f) => f.name.includes("技术爬爬虾"));
    check("bilibili video feed parsed", Boolean(bilibili && bilibili.category === "视频 / 技术"));

    // Test round-trip exportOpml -> parseOpml
    const exportedXml = exportOpml(feeds, "Follow 订阅导出");
    check("exported OPML contains opml tags and categories", exportedXml.includes('<opml version="2.0">') && exportedXml.includes('text="科技"'));
    const reimported = parseOpml(exportedXml);
    check("round-trip OPML preserves all 60 feeds", reimported.length === 60, reimported.length);
  }

  // Test mediaType detection (audio / video) in parseRssArticles
  const mockAudioRss = `
    <rss version="2.0">
      <channel>
        <title>忽左忽右</title>
        <item>
          <title>测试播客单集</title>
          <link>https://example.com/ep1</link>
          <enclosure url="https://example.com/audio.mp3" length="12345" type="audio/mpeg" />
        </item>
      </channel>
    </rss>
  `;
  const audioItems = parseRssArticles(mockAudioRss, "忽左忽右", { category: "播客音频" });
  check("rss parser detected audio podcast", audioItems.length === 1 && audioItems[0].mediaType === "audio" && audioItems[0].category === "播客音频");

  const mockVideoRss = `
    <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
      <channel>
        <title>Bilibili</title>
        <item>
          <title>测试视频</title>
          <link>https://www.bilibili.com/video/BV123456</link>
          <media:thumbnail url="https://i0.hdslb.com/cover.jpg" />
        </item>
      </channel>
    </rss>
  `;
  const videoItems = parseRssArticles(mockVideoRss, "技术UP主", { category: "视频 / 技术" });
  check("rss parser detected video and thumbnail", videoItems.length === 1 && videoItems[0].mediaType === "video" && videoItems[0].thumbnail === "https://i0.hdslb.com/cover.jpg");

  // Test mediaWidget normalizeConfig with CustomFeed
  const normalized = mediaWidget.normalizeConfig!({
    customFeeds: [
      { name: "测试源", url: "https://example.com/rss", category: "科技", enabled: true }
    ]
  });
  check("normalizeConfig preserves category and enabled",
    normalized.customFeeds.length === 1 &&
    normalized.customFeeds[0].category === "科技" &&
    normalized.customFeeds[0].enabled === true
  );
}

async function testMediaCachingAndProgress(): Promise<void> {
  const mediaConfig = mediaWidget.defaultConfig();
  // 1. Initial cached data check when no network/empty
  const initialData = getCachedMediaData(mediaConfig);
  check("getCachedMediaData is function and returns object or null", initialData === null || typeof initialData === "object");

  // 2. Test disk cache save and restore via mock app
  const storage = new Map<string, string>();
  const mockApp = {
    vault: {
      configDir: ".obsidian",
      adapter: {
        exists: async (p: string) => storage.has(p),
        read: async (p: string) => storage.get(p) ?? "",
        write: async (p: string, data: string) => { storage.set(p, data); }
      }
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await saveDiskCacheNow(mockApp as any);
  const cacheFilePath = ".obsidian/plugins/home-pages/media-cache.json";
  check("saveDiskCacheNow writes to adapter", storage.has(cacheFilePath));
  const writtenJson = JSON.parse(storage.get(cacheFilePath) || "{}") as { feedCache?: unknown[] };
  check("saved disk cache contains feedCache array", Array.isArray(writtenJson.feedCache));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await loadDiskCache(mockApp as any);
  check("loadDiskCache loads without throwing", true);

  // 3. Test syncMediaData progress callback
  let progressCount = 0;
  let finalComplete = false;
  const syncResult = await syncMediaData(
    {
      ...mediaConfig,
      showQiushi: false,
      showZjxc: false,
      customFeeds: [
        { name: "测试源1", url: "https://example.com/rss1", enabled: true },
        { name: "测试源2", url: "https://example.com/rss2", enabled: true }
      ]
    },
    {
      forceRefresh: true,
      onProgress: (_completed, _total, _items, isComplete) => {
        progressCount++;
        if (isComplete) finalComplete = true;
      }
    }
  );
  check("syncMediaData triggers onProgress callback", progressCount > 0);
  check("syncMediaData reports isComplete true at end", finalComplete);
  check("syncMediaData returns valid MediaData", typeof syncResult.ready === "boolean" && Array.isArray(syncResult.items));
}

testRegistry();
await testUserCustomWidgets();
testHabitStreak();
testPomodoro();
testWeatherHelpers();
testMedia();
await testOpmlAndFollow();
await testMediaCachingAndProgress();
await testWechat2obApi();
await testDuowei();
await testDigest();
await testWechat();
await testDuoweiInbox();
await testAnnotations();
console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
