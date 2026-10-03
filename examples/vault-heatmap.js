// 全库热力值（vault-heatmap）—— Home Pages 自定义组件社区示例
// GitHub 风格日历热力图：全 vault 的 Markdown 笔记按修改日（stat.mtime）分日计数，
// 同文件同日去重，排除隐藏目录（"." 开头）；默认近 53 周，列 = 周（周日→周六），
// 横轴为月份英文缩写、纵轴标注 Mon / Wed / Fri。
//
// 使用方法：把本文件复制到你的自定义组件目录（如 _scripts/home-pages/），
// 保存后 Home Pages 会自动加载；在卡片设置中可调整周数、排除目录、强调色与自动刷新间隔。
module.exports = {
  kind: "vault-heatmap",
  name: "全库热力值",
  description: "GitHub 风格日历热力图：全库笔记按修改日分日计数（口径同知识工作台）",
  icon: "flame",
  accent: "#22c55e",
  defaultSize: { w: 10, h: 4 },

  defaultConfig() {
    return {
      weeks: 53,            // 显示周数（26–106）
      excludeFolders: "",   // 额外排除的目录，逗号分隔，如 "Archive,模板"
      autoRefreshMinutes: 5 // 自动刷新间隔（分钟，0 = 不自动刷新）
    };
  },

  render(body, ctx) {
    const cfg = {
      weeks: Math.max(26, Math.min(106, Number(ctx.config.weeks) || 53)),
      excludeFolders: String(ctx.config.excludeFolders || "")
        .split(",")
        .map((s) => s.trim().replace(/^\/+|\/+$/g, ""))
        .filter(Boolean),
      autoRefreshMinutes: Math.max(0, Number(ctx.config.autoRefreshMinutes) || 0)
    };

    // —— 数据：全库 md 按修改日分日计数（文件 × 天去重，排除隐藏目录与额外排除项）——
    const files = ctx.app.vault.getMarkdownFiles();
    const excluded = cfg.excludeFolders;
    const daySet = new Map(); // 'YYYY-MM-DD' -> Set(文件路径)
    for (const f of files) {
      if (f.path.startsWith(".")) continue;
      if (excluded.some((p) => f.path === p || f.path.startsWith(`${p}/`))) continue;
      const d = new Date(f.stat.mtime);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      let set = daySet.get(key);
      if (!set) daySet.set(key, (set = new Set()));
      set.add(f.path);
    }
    const dayCount = new Map();
    let total = 0;
    for (const [k, set] of daySet) {
      dayCount.set(k, set.size);
      total += set.size;
    }

    // —— 日历骨架：从本周周六回推 N 周，列 = 周（周日→周六）——
    const HEAT_WEEKS = cfg.weeks;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(today);
    end.setDate(end.getDate() + (6 - end.getDay())); // 本周周六
    const start = new Date(end);
    start.setDate(start.getDate() - (HEAT_WEEKS * 7 - 1));
    const cells = []; // { date, count }
    let activeDays = 0;
    // 按「日期部分」逐日推进（setDate），夏令时时区不会漂移；
    // 毫秒累加（t += 86400000）在 DST 切换后会把整条日历错位一天。
    for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const c = dayCount.get(key) || 0;
      if (c > 0) activeDays += 1;
      cells.push({ date: new Date(d), count: c, key });
    }
    const max = Math.max(1, ...cells.map((c) => c.count));

    // —— 渲染 ——
    body.empty();
    const wrap = body.createDiv({ cls: "vh-wrap" });
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.style.justifyContent = "center"; // 卡片比内容高时垂直居中
    wrap.style.gap = "6px";
    wrap.style.height = "100%";
    wrap.style.minWidth = "0";
    wrap.style.padding = "6px 12px 8px";

    // 摘要文字放到卡片头部、设置按钮旁边（点击即手动刷新统计）
    const infoBtn = ctx.addHeaderAction("activity", "点击刷新统计", () => ctx.rerender());
    infoBtn.empty();
    infoBtn.setText(`近 ${HEAT_WEEKS} 周 · ${total} 篇笔记有修改 · 活跃 ${activeDays} 天`);
    infoBtn.style.cssText =
      "width:auto;height:auto;padding:0 6px;font-size:12px;font-weight:normal;" +
      "color:var(--text-muted);background:transparent;border:none;box-shadow:none;cursor:pointer;";

    const scroll = wrap.createDiv({ cls: "vh-scroll" });
    scroll.style.overflowX = "auto";
    scroll.style.flex = "1";
    scroll.style.minHeight = "0";

    const inner = scroll.createDiv({ cls: "vh-inner" });
    inner.style.display = "flex";
    inner.style.gap = "4px";
    inner.style.width = "max-content";
    inner.style.margin = "0 auto"; // 卡片比日历宽时水平居中；不够宽时自动贴左并滚动

    // 左：星期标签列（七行与格子对齐，只标 Mon / Wed / Fri，GitHub 同款）
    const wdCol = inner.createDiv({ cls: "vh-weekdays" });
    wdCol.style.display = "grid";
    wdCol.style.gridTemplateRows = "16px repeat(7, 12px)"; // 首行留给月份标签，与右侧对齐
    wdCol.style.gap = "3px";
    const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];
    wdCol.createDiv({ text: "" });
    for (const w of WEEKDAY_LABELS) {
      const el = wdCol.createDiv({ text: w });
      el.style.fontSize = "9px";
      el.style.lineHeight = "12px";
      el.style.color = "var(--text-faint)";
      el.style.whiteSpace = "nowrap";
    }

    const gridCol = inner.createDiv({ cls: "vh-gridcol" });
    gridCol.style.display = "flex";
    gridCol.style.flexDirection = "column";
    gridCol.style.gap = "3px";

    // 上：月份标签（英文缩写，标在每月所在的第一个周列，GitHub 同款；间隔不足 3 列则跳过防重叠）
    const monthsRow = gridCol.createDiv({ cls: "vh-months" });
    monthsRow.style.display = "grid";
    monthsRow.style.gridAutoFlow = "column";
    monthsRow.style.gridAutoColumns = "12px";
    monthsRow.style.gap = "3px";
    monthsRow.style.height = "16px";
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const colCount = Math.ceil(cells.length / 7);
    let prevMonth = -1;
    let lastLabelCol = -3;
    for (let col = 0; col < colCount; col++) {
      const first = cells[col * 7];
      const m = first ? first.date.getMonth() : -1;
      let text = "";
      if (m !== prevMonth) {
        if (col - lastLabelCol >= 3) {
          text = MONTHS[m];
          lastLabelCol = col;
        }
        prevMonth = m;
      }
      const el = monthsRow.createDiv({ text });
      el.style.fontSize = "9px";
      el.style.lineHeight = "16px";
      el.style.color = "var(--text-faint)";
      el.style.whiteSpace = "nowrap";
    }

    const grid = gridCol.createDiv({ cls: "vh-grid" });
    grid.style.display = "grid";
    grid.style.gridAutoFlow = "column";
    grid.style.gridTemplateRows = "repeat(7, 12px)";
    grid.style.gridAutoColumns = "12px";
    grid.style.gap = "3px";
    grid.style.width = "max-content";

    // 逐格铺列（start 是周日，无需 padding）
    for (const cell of cells) {
      // 分档：0 / ≤25% / ≤50% / ≤75% / >75%（GitHub 同款思路）
      const ratio = cell.count / max;
      const level = cell.count === 0 ? 0 : ratio <= 0.25 ? 1 : ratio <= 0.5 ? 2 : ratio <= 0.75 ? 3 : 4;
      const el = grid.createDiv({ cls: `vh-cell vh-lv${level}` });
      el.style.width = "12px";
      el.style.height = "12px";
      el.style.borderRadius = "2px";
      const future = cell.date.getTime() > today.getTime();
      el.title = future ? `${cell.key}（未来）` : `${cell.key} · ${cell.count} 篇`;
      if (future) el.style.opacity = "0.35";
    }

    // 下：图例（少 → 五档 → 多，放网格下方右侧，GitHub 同款）
    const legend = wrap.createDiv({ cls: "vh-legend" });
    legend.style.display = "flex";
    legend.style.alignItems = "center";
    legend.style.justifyContent = "flex-end";
    legend.style.gap = "3px";
    legend.style.fontSize = "10px";
    legend.style.color = "var(--text-faint)";
    legend.createSpan({ text: "少" });
    for (let lv = 0; lv <= 4; lv++) {
      const dot = legend.createDiv({ cls: `vh-cell vh-lv${lv}` });
      dot.style.width = "10px";
      dot.style.height = "10px";
      dot.style.borderRadius = "2px";
    }
    legend.createSpan({ text: "多" });

    // —— 样式（accent 可调，颜色随主题背景混合，深浅色都可用）——
    const style = body.createEl("style");
    style.textContent = `
      .vh-lv0 { background: var(--background-modifier-hover); border: 1px solid var(--background-modifier-border); }
      .vh-lv1 { background: color-mix(in srgb, ${ctx.config.accent || "#22c55e"} 25%, var(--background-secondary)); }
      .vh-lv2 { background: color-mix(in srgb, ${ctx.config.accent || "#22c55e"} 50%, var(--background-secondary)); }
      .vh-lv3 { background: color-mix(in srgb, ${ctx.config.accent || "#22c55e"} 75%, var(--background-secondary)); }
      .vh-lv4 { background: ${ctx.config.accent || "#22c55e"}; }
    `;

    // —— 定时刷新（卡片重绘或卸载时自动注销）——
    if (cfg.autoRefreshMinutes > 0) {
      ctx.registerInterval(() => ctx.rerender(), cfg.autoRefreshMinutes * 60 * 1000);
    }
  },

  renderSettings(container, ctx) {
    const { Setting } = obsidian;

    new Setting(container)
      .setName("显示周数")
      .setDesc("热力图横向显示多少周（26–106，默认 53）")
      .addText((text) =>
        text.setValue(String(ctx.config.weeks)).onChange((val) => {
          const n = parseInt(val, 10);
          if (!isNaN(n)) ctx.update({ weeks: n });
        })
      );

    new Setting(container)
      .setName("额外排除目录")
      .setDesc("逗号分隔的 vault 相对路径，如 Archive,模板（隐藏目录始终排除）")
      .addText((text) =>
        text.setValue(ctx.config.excludeFolders).onChange((val) => ctx.update({ excludeFolders: val }))
      );

    new Setting(container)
      .setName("强调色")
      .setDesc("热力格子的主色（默认 GitHub 绿 #22c55e）")
      .addText((text) =>
        text.setValue(ctx.config.accent || "#22c55e").onChange((val) => ctx.update({ accent: val }))
      );

    new Setting(container)
      .setName("自动刷新（分钟）")
      .setDesc("0 = 不自动刷新，仅打开首页时计算")
      .addText((text) =>
        text.setValue(String(ctx.config.autoRefreshMinutes)).onChange((val) => {
          const n = parseInt(val, 10);
          if (!isNaN(n)) ctx.update({ autoRefreshMinutes: n });
        })
      );
  }
};
