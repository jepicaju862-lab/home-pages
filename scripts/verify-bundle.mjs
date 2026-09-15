import { readFile } from "node:fs/promises";

const bundlePath = new URL("../main.js", import.meta.url);
const bundle = await readFile(bundlePath, "utf8");

const forbiddenPatterns = [
	{
		name: "dynamic script element creation",
		pattern: /\.(?:createElement|createEl)\(\s*["']script["']\s*\)/g,
	},
	{
		name: "eval()",
		pattern: /(?:^|[^\w$.])eval\s*\(/g,
	},
	{
		name: "new Function()",
		pattern: /\bnew\s+Function\s*\(/g,
	},
];

const failures = forbiddenPatterns
	.map(({ name, pattern }) => ({ name, count: bundle.match(pattern)?.length ?? 0 }))
	.filter(({ count }) => count > 0);

if (failures.length > 0) {
	for (const failure of failures) {
		console.error(`${failure.name}: ${failure.count} occurrence(s)`);
	}
	process.exit(1);
}

console.log("Bundle security check passed: no dynamic scripts, eval(), or new Function().");
