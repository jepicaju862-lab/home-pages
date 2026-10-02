# WeChat2Ob 接口约定（Home Pages 侧）

Home Pages 的「微信收件」与「信息流」组件读取 WeChat2Ob 数据时，**优先调用 WeChat2Ob 的公开 api**；
插件未提供 api、版本不认识、返回结构不对或调用出错时，才回退读取它的私有同步日志
（`<configDir>/plugins/wechat2ob/state/`）和 `data.json`。回退路径保留，旧版 WeChat2Ob 照常可用。

类型定义见 `src/widgets/wechat.ts` 中的 `Wechat2obApiV1`。

## 挂载

```ts
// WeChat2Ob main.ts（onload 末尾）
this.api = createApi(this);                                  // 见下方实现示意
this.app.workspace.trigger("wechat2ob:ready", this.api);
```

每次同步把消息写完（无论来自自动同步还是 `api.sync()`）后触发：

```ts
this.app.workspace.trigger("wechat2ob:synced");
```

Home Pages 收到 `wechat2ob:ready` / `wechat2ob:synced` 即重绘相关组件；走 api 时不再每 3 分钟轮询。

收件状态在同步之外变化时（例如 `setProcessed` 把消息标为已整理），WeChat2Ob 触发 `wechat2ob:changed`，Home Pages 同样重绘，「待整理」数即时更新。

## 接口（version 1）

```ts
interface Wechat2obApiV1 {
  version: 1;
  query(options: { days: number; limit: number; kinds: string[] }): Promise<Wechat2obInboxV1>;
  sync(): Promise<void>;           // 结果与错误由 WeChat2Ob 自己提示（通知 / 状态栏）
  openInbox(): Promise<void> | void;
}

interface Wechat2obInboxV1 {
  messages: Wechat2obMessageV1[];  // 按 days（0 = 不限）/ kinds（空 = 全部）过滤，新的在前，最多 limit 条
  today: number;                   // 以下统计不受 days / kinds / limit 影响
  week: number;                    // 最近 7 天
  attachments: number;             // 附件总数
  pending: number | null;          // 收件箱表格里“待整理”条数；未开启表格输出时为 null
  todayNotePath: string;           // 今日消息所写入的笔记路径
  tablePath: string;               // 收件箱 .duowei 路径；未开启时为空串
  inboxRoot: string;               // 收件目录（settings.root）
}

interface Wechat2obMessageV1 {
  key: string;                     // 同步日志 key（Journal.key）
  kind: string;                    // text / image / voice / video / file / mixed
  title: string;
  content: string;
  transcript: string;
  receivedAt: string;              // ISO 时间
  notePath?: string;               // 来自 receipts 中 notes:* 的路径
  tablePath?: string;              // 来自 receipts 中 duowei:* 的路径
  attachments: Array<{ path: string; kind: string; mimeType: string }>;  // 库内路径
}
```

约定：

- `today` / `week` / `attachments` 必须是非负数字，否则 Home Pages 视为不兼容并回退读日志。
- `messages` 中 `receivedAt` 无法解析的条目会被忽略；文字摘要由 Home Pages 生成（正文 → 转写 → 标题 → 附件类型）。
- `sync()` 复用现有的手动同步即可（`plugin.sync(true)` 已处理“正在同步”与失败提示）；Home Pages 只在它抛错时提示。
- 版本号只在出现不兼容变更时递增；新增可选字段不需要改版本。

## WeChat2Ob 侧实现示意

数据全部来自 WeChat2Ob 自己已有的 `state/` 日志与设置，Home Pages 不再需要知道它们的格式：

```ts
function createApi(plugin: WeChat2Ob): Wechat2obApiV1 {
  return {
    version: 1,
    query: (options) => plugin.queryInbox(options),          // 遍历 state/<stream>/<key>.json，按上面的口径汇总
    sync: () => plugin.sync(true),                           // 复用现有手动同步
    openInbox: () => plugin.openInbox()
  };
}
```

## 与 Momento（拾光）联动

装有带插件 API 的 Momento 时，「微信收件」组件（仅 WeChat2Ob 来源）会：

- 对已收进拾光的消息显示「✨ 已收录」，点击打开对应的拾光记录；
- 在其余消息上悬停显示 ✨「存为拾光」：调用 `momento.api.wechat.keep(key, { notify: true })`，同一会话里连着发的消息（例如几张照片加一句话）会一起收下，并由 Momento 给出“查看 / 撤销”提示；
- 收到 `momento:ready` / `momento:changed` 时重绘。
- 在拾光里收下的消息，Momento 会调用 WeChat2Ob 的 `setProcessed(keys, true)` 把收件箱表格里对应的行标为「已整理」（撤销或删除记录时改回「待整理」），首页的「待整理」数因此与拾光保持一致。

用到的接口（Momento 侧定义见其 `momento-api.ts`）：

```ts
interface MomentoApiLike {
  version: 1;
  findBySource(plugin: "wechat2ob", keys: string[]): Record<string, string>;  // 消息 key → 记录 id
  open(id: string): Promise<void>;
  wechat: { available(): boolean; keep(key: string, options?: { notify?: boolean }): Promise<string | null> };
}
```

Momento 自己通过宿主 API 注册「拾光」（时间线 + 随手记）、「今日拾光」「那年今日」「随机回忆」四个组件。「今日拾光」没有待收内容时调用 `ctx.setHidden(true)` 隐藏整张卡片（编辑布局时仍显示），这是本版新增的组件上下文方法；旧版首页没有该方法时，卡片显示一句空状态提示。
