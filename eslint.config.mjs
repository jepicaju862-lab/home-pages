import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
    {
        ignores: ["node_modules/**", "main.js"]
    },
    ...obsidianmd.configs.recommended,
    {
        files: ["src/**/*.ts"],
        languageOptions: {
            parser: tsparser,
            parserOptions: {
                project: "./tsconfig.json"
            }
        },
        rules: {
            "@typescript-eslint/no-floating-promises": "warn",
            "@typescript-eslint/no-misused-promises": "warn",
            "@typescript-eslint/no-require-imports": "warn",
            "@typescript-eslint/no-this-alias": "warn",
            "@typescript-eslint/no-unnecessary-type-assertion": "warn",
            "@typescript-eslint/no-unsafe-argument": "warn",
            "@typescript-eslint/no-unsafe-assignment": "warn",
            "@typescript-eslint/no-unsafe-call": "warn",
            "@typescript-eslint/no-unsafe-member-access": "warn",
            "@typescript-eslint/no-unsafe-return": "warn",
            "@typescript-eslint/no-base-to-string": "warn",
            "@typescript-eslint/no-unused-vars": "warn",
            "eslint-comments/no-restricted-disable": "warn",
            "eslint-comments/require-description": "warn",
            "no-empty": "warn",
            "no-useless-escape": "warn"
        }
    }
]);
