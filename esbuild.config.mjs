import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";
const watch = process.argv.includes("--watch");

const context = await esbuild.context({
  banner: { js: "/* Home Pages — Obsidian homepage dashboard plugin */" },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  outfile: "main.js"
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  process.exit(0);
}
