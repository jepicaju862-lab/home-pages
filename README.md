[![English](https://img.shields.io/badge/Language-English-blue)](README.md)
[![简体中文](https://img.shields.io/badge/Language-简体中文-red)](README.zh-CN.md)

# Home Pages for Obsidian

A modern, modular, and responsive homepage dashboard plugin for Obsidian. Built on a flexible 12-column adaptive grid, it empowers you to customize your workspace with draggable, resizable, and individually configurable widgets. Support multiple pages and third-party plugin integrations.

- **Website:** [peyote.info](https://peyote.info/)
- **Current release:** [v0.1.0](https://github.com/jepicaju862-lab/home-pages/releases/tag/v0.1.0)
- **Minimum Obsidian version:** 1.7.2
- **Supported platforms:** Desktop and Obsidian Mobile (iOS / Android)
- **License:** [GNU General Public License v3.0](LICENSE)

> [!NOTE]
> **Local-First & Privacy Assured:** Home Pages operates entirely within your local Obsidian vault. Layouts, states, and settings are persisted locally in `data.json` without any background analytics, telemetry, or hidden network tracking.

---

## 🌟 Features

### 🧩 Rich Built-in Dashboard Widgets

Home Pages comes with 12+ built-in productivity widgets that can be freely combined and configured:

| Widget | Description | Key Configurations |
| :--- | :--- | :--- |
| **Welcome Banner** | Greeting by time of day, custom nickname, live clock, weather forecast, vault stats, countdown badge, and customizable background image. | Weather provider (CMA Station / Open-Meteo / QWeather), city/district selection, background mask, field toggles, vault founding date, target date. |
| **Recent Notes** | Fast access to recently modified or newly created notes with folder paths. | Note count limit, include/exclude folders, sort order, display folder option. |
| **Quick Access** | Pinned notes, folders, or attachments displayed as interactive icon tiles. | Note path autocomplete, display name, Lucide icon picker, custom order, column count. |
| **Countdown & Anniversaries** | Accurate day count tracking remaining days to goals or elapsed days from anniversaries. | Target date, counting direction (past / future), description and subtitle. |
| **Pomodoro Clock** | Focus, short break, and long break cycle timer with progress ring, task note, and daily/weekly completion statistics. Timers persist across note switches and restarts. | Stage durations, long break frequency, auto-start breaks, sound alerts, system notifications. |
| **Daily Quote** | Display inspiring quotes from a dedicated note (one per line) or custom quote list. | Source note path, daily rotation vs. random, custom quote pool. |
| **Habit Tracker** | Today's check-in checklist combined with a GitHub-style activity heatmap (week / month / year). | Habit items list, storage mode (local plugin data or Daily Note task block sync). |
| **Task Kanban** | Scans `- [ ]` markdown tasks and arranges them across Todo `[ ]`, Doing `[/]`, and Done `[x]` columns. Supports drag-and-drop status changes and inline task creation. | Source file or folder, default inbox file, column headers, hide completed toggle. |
| **Vault Statistics** | Overview metrics including notes count, tags, word count, attachments, folders, vault age, created today, and modified this week. | Metric items toggle, grid column layout, exclude folders. |
| **On This Day** | Surfaces notes created or written on this day across past years. | Item count limit, date property key, filename date fallback, ctime fallback. |
| **Note Embed** | Render any note or specific heading section directly within your dashboard. | Note path, section heading, hide frontmatter toggle. |
| **Integrated Feed** *(Optional)* | Aggregated information stream combining duowei table insights, annotation inbox, and synced messages. | Source toggles, table scope, date fields, message sources. |
| **Tasks & Schedule** *(Duowei Table)* | Scans multidimensional tables (`.duowei`), surfaces overdue, today, upcoming, and recent updates with direct row navigation. | Scan scope, exclude tables, date field mappings, section day limits. |
| **WeChat Inbox** | Aggregates WeChat sync messages with text, audio transcription, and image thumbnails. | Data source, unorganized filter, days range, type filters. |
| **Annotations & Review** | Connects to Mobile Ink Annotation Pro to show inbox annotations, daily reviews, and collections. | Card statistics, thumbnail preview, one-click jump to annotation center. |
| **Media & RSS Subscriptions** | Surfaces articles from mainstream sources and personal custom RSS / OPML feeds. Supports Follow exports, nested categories, podcast/video detection, and offline Markdown clipping. | Channel nav style, default channel, OPML import/export, category organization, clipping folder. |

---

## 📐 Responsive 12-Column Layout

- **12-Column Adaptive Grid**: Automatically reflows and scales proportionately based on viewport width, providing a native visual layout on both desktop ultrawide monitors and mobile devices.
- **WYSIWYG Layout Editing**:
  - Click **Edit Layout** in the header to enter arrangement mode.
  - Drag and drop cards to reorder anywhere on the grid.
  - Use card footer buttons to resize width (1–12 columns) and height (rows).
  - Easily move forward, move backward, duplicate, or delete any widget.
- **Multi-Page Management**:
  - Click `+` on the tab bar to create distinct pages (e.g., "Work Dashboard", "Life Log", "Project Hub").
  - Right-click tabs to rename, reorder, or delete pages.
- **JSON Import & Export**: One-click copy and paste of complete dashboard layouts for easy backup and cross-vault migration.

---

## 🔌 Host API for Plugin Developers

Home Pages exposes a lightweight host API allowing other Obsidian plugins to register custom widgets and views into the homepage framework:

```ts
// Retrieve the API instance when Home Pages is loaded (or listen to "home-pages:ready")
const api = app.plugins.plugins["home-pages"]?.api;

// 1. Register a new widget type
const unregister = api.registerWidget(myWidgetDefinition, "my-plugin-id");

// 2. Programmatically pin a widget to the current homepage
api.pinWidget("my-widget-kind", { ref: "note-path" }, {
  title: "My Pinned View",
  w: 6,
  h: 4,
  provider: "my-plugin-id"
});

// 3. Trigger a dashboard redraw when underlying data changes
api.refresh("my-widget-kind");

// 4. Utilize consistent UI rendering helpers
api.ui.renderKpi(containerEl, { label: "Completed", value: 12 });
api.ui.renderEmpty(containerEl, { message: "No data available" });
```

> **Integration Example:** **Duowei Table (duowei-table-pro ≥ 1.4.0)** registers `duowei-view` via the Host API. Users can right-click any table view tab and select "Pin to Homepage" to display live calendars, kanban boards, and progress timelines on their homepage.

---

## 📥 Installation

### Method 1: Obsidian Community Plugins (Recommended)

Once available in the official Obsidian Community Plugins directory:
1. In Obsidian, go to **Settings → Community plugins**.
2. Turn off **Restricted mode** and click **Browse**.
3. Search for **Home Pages**.
4. Click **Install**, then click **Enable**.

### Method 2: Manual Installation

1. Download the latest release assets from the [GitHub Releases](https://github.com/jepicaju862-lab/home-pages/releases) page:
   - `main.js`
   - `manifest.json`
   - `styles.css`
2. Locate or create your plugin folder inside your vault:
   ```text
   <vault>/.obsidian/plugins/home-pages/
   ```
3. Copy the downloaded files into that directory.
4. Reload Obsidian and enable **Home Pages** in **Settings → Community plugins**.

---

## 🖊️ Usage

1. **Opening Home Pages**:
   - Click the homepage icon on the left ribbon.
   - Or press `Ctrl/Cmd + P` and execute the command `Home Pages: Open Homepage`.
2. **Customizing Layout & Widgets**:
   - Click **Edit Layout** in the top-right corner of the view.
   - Click **Add Widget** at the top to select and insert any widget.
   - Click the **Gear** icon on any card header to customize its parameters (weather city, habit list, stats filters, etc.).
3. **Global Settings**:
   - Navigate to Obsidian **Settings → Home Pages**.
   - Configure auto-open on startup, default row height (px), grid gap, maximum width, and manage pages.

---

## ⚙️ Settings Reference

| Setting | Description | Default |
| :--- | :--- | :--- |
| **Open on startup** | Automatically open homepage when Obsidian launches | On |
| **Open in new tab** | Open homepage in a new tab instead of replacing active tab | On |
| **Row height** | Unit height for grid rows in pixels (24px - 96px) | 36px |
| **Grid gap** | Spacing between widget cards in pixels (4px - 40px) | 12px |
| **Max content width** | Max width constraint (0 fills window width) | 0 |
| **Always show page tabs** | Keep page tabs visible even with single page | Off |
| **Page management** | Add, duplicate, rename, or remove homepage layouts | Default page |
| **Import / Export** | Copy or paste full dashboard layouts in JSON format | - |

---

## 🔒 Data & Privacy

- **100% Local Storage:** All dashboard configurations, layout JSONs, pomodoro records, and habits are stored locally in `data.json`.
- **Zero Telemetry:** The plugin does not collect usage analytics, telemetry, or user metrics.
- **Network Requests:** Weather queries are only initiated when a weather-enabled banner is rendered:
  - CMA Station requests public endpoints without keys.
  - Open-Meteo and QWeather only connect when explicitly selected and configured.
- **Bundle Integrity:** A fail-closed security gate (`scripts/verify-bundle.mjs`) ensures the distributed bundle contains no dynamic script generation, `eval()`, or `new Function()`.

---

## ❓ FAQ

### Will layout break on mobile devices?
No. Home Pages provides responsive adaptive rules for small screens. On narrow viewports, the grid seamlessly collapses into full-width or compact columns optimized for touch interaction.

### Does the Pomodoro timer keep running if I switch notes or restart Obsidian?
Yes. The timer state and start timestamp are persisted in plugin memory and data. Switching views or restarting Obsidian restores the timer seamlessly.

### How do I restore the default initial layout?
In **Settings → Home Pages → Pages**, click **＋ New Default Page** at any time to generate a clean instance of the default layout.

---

## 🧑‍💻 Development

Contributions and pull requests are welcome!

```bash
# 1. Install dependencies
npm install

# 2. Start dev build with watch mode
npm run dev

# 3. Lint source code
npm run lint

# 4. Production build with security audit
npm run build
```

---

## 📋 Release Notes

For detailed changelogs and version release histories, see [RELEASE_NOTES.md](RELEASE_NOTES.md) (or [RELEASE_NOTES.zh-CN.md](RELEASE_NOTES.zh-CN.md)).

---

## 🤝 Support & Feedback

- **Bug Reports & Feature Requests — [this repository's issue tracker](https://github.com/jepicaju862-lab/home-pages/issues).** Please include your Obsidian version, operating system, and reproduction steps whenever possible.
- **Questions & Discussion — QQ group `1094620986`.** The group communicates primarily in Simplified Chinese.
- **Email — <jepicaju862@gmail.com>.** Use email for private reproduction files or inquiries.
- **Official Website — [peyote.info](https://peyote.info/).**

---

## 📬 Contact

- **QQ group:** `1094620986`
- **Email:** <jepicaju862@gmail.com>
- **Website:** [peyote.info](https://peyote.info/)

---

## 📄 License

This project is licensed under the [GNU General Public License v3.0](LICENSE).

