#!/usr/bin/env node
/**
 * Scaler CLI Cloner - Entry Point
 *
 * MODES:
 *   node src/index.js              → conversational chat (default)
 *   node src/index.js --chat       → conversational chat (explicit)
 *   node src/index.js --auto [URL] → one-shot autonomous clone (no chat)
 *
 * CHAT EXAMPLES (after running node src/index.js):
 *   You › Clone the Scaler Academy website
 *   You › Add a dark mode toggle
 *   You › Make the hero heading bigger
 *   You › exit
 */

import "dotenv/config";
import { startChat } from "./chat.js";
import { runAgent }  from "./agent.js";
import { printBanner, log } from "./logger.js";
import chalk from "chalk";

/* ─── CLI argument parsing ─────────────────────────── */
const args = process.argv.slice(2);

function getArg(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const isAutoMode = args.includes("--auto");
const model      = getArg("--model",   "meta-llama/llama-3.3-70b-instruct");
const maxIter    = parseInt(getArg("--max-steps", "20"), 10);
const output     = getArg("--output",  "scaler_clone");
const url        = args.find((a) => !a.startsWith("--")) ?? "https://www.scaler.com";

/* ─── Guard: API key ──────────────────────────────── */
if (!process.env.OPENROUTER_API_KEY) {
  console.error(chalk.red.bold("\n✗ OPENROUTER_API_KEY is not set in your .env file.\n"));
  console.error(chalk.yellow("  1. Get a key → https://openrouter.ai/keys"));
  console.error(chalk.yellow("  2. Add to .env:  OPENROUTER_API_KEY=sk-or-v1-...\n"));
  process.exit(1);
}

/* ─── Launch ──────────────────────────────────────── */
if (isAutoMode) {
  /* ── Autonomous mode (one-shot, no chat) ── */
  console.log(chalk.bold.blue("\n  🌐 SCALER CLI CLONER • Powered by OpenRouter"));
  log("info", `Mode        : ${chalk.cyan("Auto (one-shot)")}`);
  log("info", `Target URL  : ${chalk.cyan(url)}`);
  log("info", `Output dir  : ${chalk.cyan(output)}`);
  log("info", `OpenRouter Model : ${chalk.cyan(model)}`);
  log("info", `Max steps   : ${chalk.cyan(maxIter)}`);
  console.log();
  runAgent({ url, output, model, maxIter }).catch((err) => {
    log("error", err.message);
    process.exit(1);
  });
} else {
  /* ── Conversational chat mode (default) ── */
  startChat({ model }).catch((err) => {
    log("error", err.message);
    process.exit(1);
  });
}
