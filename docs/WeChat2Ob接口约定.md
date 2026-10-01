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
