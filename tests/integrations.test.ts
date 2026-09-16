import { promises as fs } from "node:fs";
import path from "node:path";
import { formatValue, selectRecords, type DuoweiDoc } from "../src/widgets/duoweiCore";
import { loadAnnotations } from "../src/widgets/annotations";
import { buildDigest } from "../src/widgets/duoweiDigest";
import { loadWechat } from "../src/widgets/wechat";
import { TFile } from "obsidian";
import { createWidgetInstance, getWidgetDefinition, listWidgetDefinitions, onRegistryChange, registerWidget } from "../src/widgets/registry";
import { sanitizeWidget } from "../src/settings";
import { advanceSession, bumpHistory, formatClock, pauseSession, pomodoroWidget, remainingMs, resetSession, startSession, type PomodoroConfig } from "../src/widgets/pomodoro";

import { cmaIcon, normalizeHost, parseCoords, qweatherIcon, rankCmaCandidates, splitQuery, stripSuffix } from "../src/utils/weather";
import { htmlToMarkdown, mediaWidget, parseQiushiCatalog, parseQiushiIssueArticles, parseZjxcArticles } from "../src/widgets/media";

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
  check("today / week counts", data.today >= 0 && data.week === 4, [data.today, data.week]);
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
  check("question bank due today", data.questions === 7 && data.due === 3, [data.questions, data.due]);
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
}

testRegistry();
testPomodoro();
testWeatherHelpers();
testMedia();
await testDuowei();
await testDigest();
await testWechat();
await testDuoweiInbox();
await testAnnotations();
console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
