/**
 * tools.js - All tools the agent can call
 *
 * Each tool:
 *   - Has a JSON Schema definition for Groq tool-calling
 *   - Has a corresponding JS implementation
 */

import fs   from "fs/promises";
import path from "path";
import { log } from "./logger.js";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import open from "open";

/* ═══════════════════════════════════════════════════════
   TOOL SCHEMAS (sent to Groq so it knows what to call)
═══════════════════════════════════════════════════════ */
export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "fetch_page_design",
      description:
        "Fetches a URL and extracts design-relevant information: heading text, nav links, colours mentioned in inline styles, CTA text, footer content. Use this FIRST to understand the target site.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The full URL to fetch and analyse" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_folder",
      description: "Creates a folder (and any necessary parent folders) on disk.",
      parameters: {
        type: "object",
        properties: {
          folder_path: { type: "string", description: "Relative path to the folder to create, e.g. scaler_clone" },
        },
        required: ["folder_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Writes content to a file. Creates the file (and parent dirs) if they don't exist. Use this to write index.html, style.css, and script.js.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Relative path to the file, e.g. scaler_clone/index.html" },
          content:   { type: "string", description: "Full file content to write" },
        },
        required: ["file_path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Reads and returns the contents of a file. Use to review what was already written before refining it.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Relative path to the file to read" },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "Lists all files in a folder recursively. Use to check what has been generated so far.",
      parameters: {
        type: "object",
        properties: {
          folder_path: { type: "string", description: "Relative folder path to list" },
        },
        required: ["folder_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "validate_html",
      description:
        "Checks a generated HTML file for basic issues: missing tags, missing stylesheet link, missing script tag. Returns a list of warnings.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Relative path to the HTML file to validate" },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_in_browser",
      description: "Opens a file (usually index.html) in the user's default web browser so they can see the website.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Relative path to the HTML file to open" },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replace_in_file",
      description: "Performs a surgical text replacement in a file. Use this for small edits or adding features (like a dark mode toggle) without rewriting the whole file.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the file" },
          target: { type: "string", description: "The exact string to search for and replace" },
          replacement: { type: "string", description: "The new string to put in its place" },
        },
        required: ["file_path", "target", "replacement"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "append_to_file",
      description: "Appends content to the end of a file. Use this for adding new CSS rules or JS logic without searching for a target.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the file" },
          content: { type: "string", description: "The content to append" },
        },
        required: ["file_path", "content"],
      },
    },
  },
];

/* ═══════════════════════════════════════════════════════
   TOOL IMPLEMENTATIONS
═══════════════════════════════════════════════════════ */

/**
 * Fetches a URL and returns structured design info extracted by cheerio
 */
export async function fetch_page_design({ url }) {
  try {
    log("info", `Fetching: ${url}`);
    const res  = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 15000,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const html = await res.text();
    const $    = cheerio.load(html);

    /* Remove script / style / noscript noise */
    $("script, noscript, iframe").remove();

    const result = {
      title:       $("title").first().text().trim(),
      description: $('meta[name="description"]').attr("content") ?? "",
      headings: {
        h1: $("h1").map((_, el) => $(el).text().trim()).get(),
        h2: $("h2").map((_, el) => $(el).text().trim()).get().slice(0, 6),
      },
      nav_links:   $("nav a, header a").map((_, el) => $(el).text().trim()).get().filter(Boolean),
      buttons:     $("button, a.btn, a[class*='btn'], a[class*='cta'], a[class*='button']")
                     .map((_, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 10),
      footer_text: $("footer").text().replace(/\s+/g, " ").trim().slice(0, 500),
      hero_text:   ($('section, [class*="hero"], [class*="banner"]').first().text() || $("main").first().text())
                     .replace(/\s+/g, " ").trim().slice(0, 800),
      logo_text:   $('[class*="logo"], [class*="brand"]').first().text().trim().slice(0, 60),
    };

    log("success", `Fetched "${result.title}" — extracted design info`);
    return { ok: true, data: result };
  } catch (err) {
    log("warn", `fetch_page_design failed: ${err.message} — using default Scaler design data`);
    return {
      ok: false,
      error: err.message,
      data: {
        title:       "Scaler Academy",
        description: "Become the Professional Built for the Next Decade in AI.",
        headings: {
          h1: ["Become the Professional Built for the Next Decade in AI."],
          h2: ["Why Scaler?", "Our Programs", "Alumni Stories"],
        },
        nav_links: ["WHY SCALER", "PROGRAM", "STORIES", "PEOPLE", "PODCAST", "PLACEMENT REPORT"],
        buttons:   ["REQUEST A CALLBACK", "BOOK FREE LIVE CLASS", "Login"],
        footer_text:"© 2024 Interviewbit Software Services Pvt Ltd, Bengaluru. | 08047939623",
        hero_text: "Become the Professional Built for the Next Decade in AI. The investment that compounds. 700+ Hiring Partners. 40 LPA Highest Salary. 6× Average Hike. 20000+ Lives Transformed.",
        logo_text: "SCALER",
      },
    };
  }
}

/**
 * Creates a folder recursively
 */
export async function create_folder({ folder_path }) {
  const abs = path.resolve(folder_path);
  await fs.mkdir(abs, { recursive: true });
  log("success", `Created folder: ${folder_path}`);
  return { ok: true, path: abs };
}

/**
 * Writes content to a file (creates parents if needed)
 */
export async function write_file({ file_path, content }) {
  try {
    const abs = path.resolve(file_path);
    
    // SAFETY INTERLOCK: Prevent lazy overwriting of existing code
    if (require('fs').existsSync(abs)) {
      const stats = require('fs').statSync(abs);
      // If the file is > 500 bytes and we are writing less than 50% of its current size, BLOCK IT.
      if (stats.size > 500 && Buffer.byteLength(content, 'utf8') < (stats.size * 0.5)) {
        return { 
          ok: false, 
          error: `SAFETY BLOCK: You are trying to overwrite a ${stats.size} byte file with only ${Buffer.byteLength(content, 'utf8')} bytes. This would delete most of the existing code. Use replace_in_file for surgical edits instead.` 
        };
      }
    }

    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    const kb = (Buffer.byteLength(content, "utf8") / 1024).toFixed(1);
    log("success", `Wrote ${file_path}  (${kb} KB, ${content.split("\n").length} lines)`);
    return { ok: true, path: abs, size_kb: kb };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Reads a file and returns its content
 */
export async function read_file({ file_path }) {
  try {
    const abs     = path.resolve(file_path);
    const content = await fs.readFile(abs, "utf8");
    log("info", `Read ${file_path} (${content.split("\n").length} lines)`);
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Lists files in a folder recursively
 */
export async function list_files({ folder_path }) {
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...await walk(full));
      else                  files.push(full);
    }
    return files;
  }

  const abs   = path.resolve(folder_path);
  const files = await walk(abs);
  const rel   = files.map((f) => path.relative(process.cwd(), f));
  log("info", `Listed ${rel.length} file(s) in ${folder_path}`);
  return { ok: true, files: rel };
}

/**
 * Basic HTML validator - checks for common issues
 */
export async function validate_html({ file_path }) {
  try {
    const content  = await fs.readFile(path.resolve(file_path), "utf8");
    const warnings = [];

    if (!content.includes("<!DOCTYPE html>"))       warnings.push("Missing DOCTYPE declaration");
    if (!content.includes('<meta charset'))          warnings.push("Missing charset meta tag");
    if (!content.includes('<meta name="viewport"'))  warnings.push("Missing viewport meta tag");
    if (!content.includes("style.css"))              warnings.push("Missing link to style.css");
    if (!content.includes("script.js"))              warnings.push("Missing script.js reference");
    if (!content.includes("<header"))                warnings.push("Missing <header> element");
    if (!content.includes("<section"))               warnings.push("Missing <section> element");
    if (!content.includes("<footer"))                warnings.push("Missing <footer> element");
    if (!content.includes('<h1'))                    warnings.push("Missing <h1> heading");

    const status = warnings.length === 0 ? "PASS" : "WARNINGS";
    log(warnings.length === 0 ? "success" : "warn", `validate_html: ${status} (${warnings.length} issue(s))`);
    return { ok: true, status, warnings };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Opens a file in the default browser
 */
export async function open_in_browser({ file_path }) {
  try {
    const abs = path.resolve(file_path);
    await open(abs);
    log("success", `Opened in browser: ${file_path}`);
    return { ok: true, message: `Opened ${file_path} in browser.` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Surgical text replacement
 */
export async function replace_in_file({ file_path, target, replacement }) {
  try {
    const abs = path.resolve(file_path);
    let content = await fs.readFile(abs, "utf8");

    // Robust matching: Try exact match first, then loose match (ignoring whitespace)
    if (!content.includes(target)) {
      // Escape target for regex, but allow any whitespace to match any other whitespace
      const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      const regex = new RegExp(escapedTarget, "m");
      if (regex.test(content)) {
        content = content.replace(regex, replacement);
      } else {
        return { ok: false, error: `Target text not found in ${file_path}. Make sure you use exact text from the file.` };
      }
    } else {
      content = content.replace(target, replacement);
    }

    await fs.writeFile(abs, content, "utf8");
    log("success", `Updated ${file_path}`);
    return { ok: true, message: `Successfully updated ${file_path}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Append to file
 */
export async function append_to_file({ file_path, content }) {
  try {
    const abs = path.resolve(file_path);
    await fs.appendFile(abs, "\n" + content, "utf8");
    log("success", `Appended content to ${file_path}`);
    return { ok: true, message: `Successfully appended to ${file_path}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ─── Tool dispatcher ─────────────────────────────── */
export const TOOL_MAP = {
  fetch_page_design,
  create_folder,
  create_new_file: write_file,
  read_file,
  list_files,
  validate_html,
  open_in_browser,
  replace_in_file,
  append_to_file,
};

export async function callTool(name, args) {
  const fn = TOOL_MAP[name];
  if (!fn) throw new Error(`Unknown tool: ${name}`);
  return fn(args);
}
