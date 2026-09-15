// 把集成测试与 obsidian 桩一起打包后在 Node 里运行（不需要启动 Obsidian）。
//   HOME_PAGES_TEST_VAULT=<含测试数据的库路径> node scripts/test-integrations.mjs
import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

mkdirSync("tests/.out", { recursive: true });
await esbuild.build({
  entryPoints: ["tests/integrations.test.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  outfile: "tests/.out/integrations.test.mjs",
  alias: { obsidian: resolve("tests/obsidian-stub.ts") },
  logLevel: "warning"
});
const result = spawnSync(process.execPath, ["tests/.out/integrations.test.mjs"], { stdio: "inherit" });
process.exit(result.status ?? 1);
