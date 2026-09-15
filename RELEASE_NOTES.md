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
