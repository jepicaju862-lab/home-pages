// 把构建产物复制到本地库的插件目录：
//   HOME_PAGES_DEV_PLUGIN_DIR="<vault>/.obsidian/plugins/home-pages" npm run deploy
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const targetInput = process.env.HOME_PAGES_DEV_PLUGIN_DIR?.trim();
if (!targetInput) throw new Error("HOME_PAGES_DEV_PLUGIN_DIR must point to <vault>/.obsidian/plugins/home-pages");
const target = resolve(targetInput);
if (!isAbsolute(target) || target === parse(target).root || target === root) {
  throw new Error(`Refusing unsafe plugin deployment target: ${target}`);
}
mkdirSync(target, { recursive: true });
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
for (const fileName of ["main.js", "styles.css", "manifest.json"]) {
  const source = resolve(root, fileName);
  if (!existsSync(source)) throw new Error(`Build artifact missing: ${source}`);
  copyFileSync(source, resolve(target, fileName));
}
console.log(`Deployed Home Pages ${manifest.version} to ${target}`);
