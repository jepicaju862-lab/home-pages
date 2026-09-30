# Home Pages v0.3.1 Release Notes

- Release date: September 30, 2026
- Minimum Obsidian version: 1.7.2

## 🔧 Maintenance

Fixes for the Obsidian community plugin automated review. No feature changes.

- Removed the `no-explicit-any` lint suppression and several unsafe `any` usages and redundant type assertions.
- Deleting a custom widget script now always goes through `FileManager.trashFile`, respecting your file deletion preference.
- Replaced the `builtin-modules` dev dependency with Node's `node:module`.
- Removed unused helpers.
- Styles: card size and grid column counts are driven by CSS variables instead of inline styles, so responsive rules no longer need `!important`.

---

# Home Pages v0.3.0 Release Notes

- Release date: September 30, 2026
- Minimum Obsidian version: 1.7.2
- Supported platforms: Desktop and Obsidian Mobile (iOS / Android)
- License: GNU General Public License v3.0

---

## 🌟 New

### 🧩 User custom widgets
- Point **Custom widgets folder** at a vault folder and write widgets in plain JavaScript (`module.exports = { kind, name, render }`). Generate a sample template, or paste code straight from the homepage.
- **Hot reload**: save a `.js` file in Obsidian or an external editor and its cards reload immediately.
- **Save and it appears**: the first time a new script loads, its widget is added to the current page. This happens once per widget; editing a script after you removed its card does not add it back. Turn off with **Add new custom widgets automatically**.

### 📐 Layout editing rebuilt
- **Reordering uses pointer events**: works with mouse, touch and pen; drop markers for left/right, above/below and gaps; auto-scroll at the view edge; Esc or dropping outside the grid cancels. Fixes cards jumping to the end when dropped in a gap and order drifting from dense backfilling.
- **Drag page tabs to reorder** in edit mode; a tap still switches pages.
- **Corner resize handle**: width snaps to columns and height to rows with a live "N 列 × M 行" badge; height only on narrow screens; Esc cancels; arrow keys step the size when the handle is focused.
- **12 column guides** show in the grid while editing and get stronger while resizing.
- **Smoother dragging**: a copy of the card follows the pointer every frame while the original stays as a dashed placeholder; on drop the card glides from the preview into its slot (or back, when cancelled). While resizing, a dashed frame tracks the pointer pixel by pixel and neighbouring cards slide aside. Move and size buttons animate too. No animation when the OS asks for reduced motion. Markers only touch the DOM when the drop position changes, so pointer moves no longer force a layout.

### ✨ Details
- The `+` new-page button at the end of the tab bar is available outside edit mode; new installs show the tab bar by default (existing settings are unchanged).
- Welcome banner clock can show seconds.
- Habit tracker shows the current streak (not checking in yet today does not break it).

### 📝 Docs
- README default-settings table now matches the real defaults (row height 40px, gap 16px, max width 1400px).

---

# Home Pages v0.2.0 Release Notes

- Release date: September 18, 2026
- Minimum Obsidian version: 1.7.2
- Supported platforms: Desktop and Obsidian Mobile (iOS / Android)
- License: GNU General Public License v3.0

---

## 🌟 New Features & Major Improvements

### 📰 Media & RSS / OPML Subscription Center
- **Built-in Authoritative Publications**: Curated issues and featured columns from top publications with issue archiving, chapter categories, and reader view.
- **Robust Custom RSS / OPML Import & Export**:
  - One-click import of `*.opml` files exported from Follow and other RSS readers, preserving nested folder categories and feed metadata.
  - Export all personal subscriptions to standard OPML files for seamless cross-vault and cross-tool backup.
  - Manual addition of custom RSS / Atom feeds with customizable titles, icons, and category tags.
- **Enhanced WeChat Official Account RSS Support**:
  - First-class support for WeChat public platform RSS feeds with automatic author extraction, publication timestamp, and cover images.
  - Automatic parsing and proxying for `data-src` lazy-loaded images.
- **One-Click Offline Full-Text Clipping**:
  - Save articles directly into clean Markdown notes inside your chosen vault folder with a single click.
  - For WeChat and supported sources, extracts full HTML and converts into native Markdown while maintaining headers, formatting, and images.
- **Podcast & Video Detection**:
  - Automatic detection of multimedia enclosures (audio podcasts and video streams) with badges and duration indicators.
- **Channel Navigation**:
  - Seamless toggle between Tab bar mode and Select dropdown mode.
  - Smooth pagination and visual unread status indicators.

### 📱 Tablet & Responsive Layout Enhancements
- **Tablet Layout Optimization**: Fixed horizontal overflow and card clipping on medium-width screens (600px - 1024px).
- **Adaptive Pomodoro Buttons**:
  - Resolved button wrapping on wider cards, ensuring comfortable horizontal placement on desktop while folding cleanly on mobile.
- **Touch & Reading Interaction Polish**:
  - Enhanced touch scrolling and gesture handling inside the modal article reader.
  - Improved touch-and-hold responsiveness for grid card dragging on touchscreens.

---

# Home Pages v0.1.0 Release Notes

- Release date: September 15, 2026
- Minimum Obsidian version: 1.7.2
- Supported platforms: Desktop and Obsidian Mobile (iOS / Android)
- License: GNU General Public License v3.0

---

## Initial Open Source Release

Welcome to the initial open-source release of **Home Pages** for Obsidian! This release delivers a modular, responsive, and customizable dashboard experience designed to turn your Obsidian vault into a powerful personal workspace.

### 🌟 Core Features & Highlights

- **12-Column Responsive Grid System**:
  - Automatically adapts to changing viewport sizes across desktop displays and mobile devices.
  - Smooth reflow mechanics that maintain readability and touch targets on smartphones and tablets.
- **Interactive Visual Layout Editor**:
  - Drag-and-drop card reordering directly within the dashboard view.
  - Card-level grid sizing controls allowing width (1–12 columns) and height adjustments.
  - Duplicate, move forward, move backward, and delete actions on each widget.
- **Multi-Page Dashboard Management**:
  - Organize your workspace into multiple discrete pages (e.g. Work, Personal, Learning, Project Hubs).
  - Tab bar management for creating, renaming, reordering, and deleting pages.
- **12+ Built-in Productivity Widgets**:
  - **Welcome Banner**: Greetings by time of day, customizable username, live clock, weather forecast (China Meteorological Administration station data without keys, Open-Meteo, or QWeather), vault statistics badge, countdown badge, and customizable background image.
  - **Recent Notes**: Displays recently modified or created notes with configurable folder filters and sorting.
  - **Quick Access**: Interactive bookmark tiles for frequently accessed notes, folders, and attachments, featuring Lucide icons and path autocompletion.
  - **Countdown & Anniversaries**: Tracks remaining days to targets or elapsed days since milestones.
  - **Pomodoro Timer**: Focus and break interval timer with visual progress ring, persisted state across view switches and app restarts, sound effects, and native system notifications.
  - **Daily Quote**: Displays rotating quotes from a dedicated note or customizable list.
  - **Habit Tracker**: Daily check-in checklist integrated with a GitHub-style activity heatmap (week, month, and year views), supporting local storage or Daily Note block sync.
  - **Task Kanban**: Extracts `- [ ]` markdown checkboxes and categorizes them into Todo, In-Progress, and Done columns with drag-to-change status support.
  - **Vault Statistics**: Displays high-level vault health metrics (note count, tag count, word count, attachments, vault age).
  - **On This Day**: Re-surfaces notes created on the current date in previous years.
  - **Note Embed**: Inline rendering of any note or specific heading section.
  - **Ecosystem Widgets**: Duowei Table integration (tasks and schedules, view pinning), WeChat inbox sync, and Mobile Ink Annotation review.
- **Extensible Host Plugin API**:
  - Allows third-party Obsidian plugins to register custom widgets and programmatic view pinning (e.g. Duowei Table Pro).
  - Supplies shared UI rendering helpers (`renderKpi`, `renderEmpty`).

### 🔒 Security & Code Quality

- **Local-First & Privacy First**: All layout preferences, check-in data, and pomodoro logs are stored locally in the vault's `data.json`.
- **Fail-Closed Security Gate**: Integrated `scripts/verify-bundle.mjs` prevents bundled code from including dynamic `<script>` creation, `eval()`, or `new Function()`.
- **Comprehensive CI/CD Pipeline**: GitHub Actions release workflow includes tag verification against `manifest.json`, automated ESLint checks, production builds, provenance attestations (`actions/attest@v4`), and automated release asset uploads.
