/**
 * logger.js - Pretty terminal output with colours & step badges
 */

import chalk from "chalk";

const STEP_COLORS = {
  START:   chalk.bgBlue.white.bold,
  THINK:   chalk.bgMagenta.white.bold,
  TOOL:    chalk.bgYellow.black.bold,
  OBSERVE: chalk.bgCyan.black.bold,
  OUTPUT:  chalk.bgGreen.white.bold,
  info:    chalk.blue,
  warn:    chalk.yellow,
  error:   chalk.red.bold,
  success: chalk.green.bold,
};

/**
 * Prints the ASCII banner on startup
 */
export function printBanner() {
  console.log(chalk.bold.blue(`
  ╔═══════════════════════════════════════════════╗
  ║   🌐  SCALER CLI CLONER  •  Powered by Groq  ║
  ║   AI agent that clones websites into HTML     ║
  ╚═══════════════════════════════════════════════╝
  `));
}

/**
 * Logs a step card in the agentic loop
 * @param {"START"|"THINK"|"TOOL"|"OBSERVE"|"OUTPUT"} step
 * @param {string} content
 * @param {string} [extra] - optional tool name / detail
 */
export function logStep(step, content, extra = "") {
  const colorFn = STEP_COLORS[step] ?? chalk.white.bold;
  const badge   = colorFn(` ${step} `);
  const detail  = extra ? chalk.gray(` [${extra}]`) : "";
  const line    = `\n  ${badge}${detail}  ${chalk.white(content)}`;
  console.log(line);
}

/**
 * General purpose log (info / warn / error / success)
 */
export function log(level, msg) {
  const fn = STEP_COLORS[level] ?? chalk.white;
  const prefix = {
    info:    "  ℹ",
    warn:    "  ⚠",
    error:   "  ✗",
    success: "  ✔",
  }[level] ?? "  ·";
  console.log(`${fn(prefix)}  ${msg}`);
}

/**
 * Prints a JSON step object exactly as the spec requires
 */
export function printStepJSON(stepObj) {
  const json = JSON.stringify(stepObj, null, 2);
  console.log(chalk.gray("\n  ┌─ Step JSON ────────────────────────────────"));
  json.split("\n").forEach((l) => console.log(chalk.gray("  │ ") + chalk.dim(l)));
  console.log(chalk.gray("  └────────────────────────────────────────────"));
}
