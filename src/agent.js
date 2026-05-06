/**
 * agent.js - The agentic loop
 *
 * Flow:
 *   1. Send system prompt + user message to Groq
 *   2. Groq responds with either tool_calls or a text message
 *   3. If tool_calls → execute them → append results → go to 1
 *   4. If text contains "OUTPUT" step → stop
 *   5. Repeat up to maxIter times
 */

import OpenAI from "openai";
import { buildSystemPrompt }      from "./prompts.js";
import { TOOL_SCHEMAS, callTool } from "./tools.js";
import { logStep, printStepJSON, log } from "./logger.js";
import chalk from "chalk";
import open  from "open";
import path  from "path";

/* ═══════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════ */

/**
 * Safely parse a JSON string. Returns null on failure.
 */
function safeParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    // Try to extract a JSON object from mixed text
    const match = str.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* ignore */ }
    }
    return null;
  }
}

/**
 * Detect the agentic step from an LLM text response
 */
function detectStep(text) {
  if (!text) return "THINK";
  const upper = text.toUpperCase();
  if (upper.includes('"STEP": "OUTPUT"') || upper.includes('"step": "OUTPUT"')) return "OUTPUT";
  if (upper.includes('"STEP": "OBSERVE"')) return "OBSERVE";
  if (upper.includes('"STEP": "THINK"'))   return "THINK";
  if (upper.includes('"STEP": "TOOL"'))    return "TOOL";
  if (upper.includes('"STEP": "START"'))   return "START";
  return "THINK";
}

/* ═══════════════════════════════════════════════════════
   MAIN AGENT RUNNER
═══════════════════════════════════════════════════════ */
export async function runAgent({ url, output, model, maxIter }) {
  const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/Sid13SST/Scaler_CLI_cloner",
      "X-Title": "Scaler CLI Cloner",
    },
  });

  /* Track which files the agent has written (used for smart nudges) */
  const writtenFiles = new Set();

  /* Build conversation history */
  const messages = [
    {
      role: "system",
      content: buildSystemPrompt({ url, outputDir: output }),
    },
    {
      role: "user",
      content: `Clone the website at: ${url}\nSave output to: ${output}/\nBegin now. Follow the execution plan step by step.`,
    },
  ];

  logStep("START", `Starting agent loop (max ${maxIter} steps)`);
  printStepJSON({ step: "START", content: `Cloning ${url} → ${output}/` });

  let iteration    = 0;
  let finalOutput  = null;
  let scrapedData  = null;  // captured from fetch_page_design

  /* ── Main loop ──────────────────────────────────────── */
  while (iteration < maxIter) {
    iteration++;
    log("info", chalk.gray(`─── Iteration ${iteration}/${maxIter} ───────────────────`));

    /* 1. Call Groq (with retry on 429) ─────────────── */
    let response;
    let retries = 0;
    while (true) {
      try {
        response = await client.chat.completions.create({
          model,
          messages,
          tools:       TOOL_SCHEMAS,
          tool_choice: "auto",
        });
        break; // success
      } catch (err) {
        const is429 = err.status === 429 || err.message?.includes("rate_limit_exceeded") || err.message?.includes("429");
        if (is429 && retries < 3) {
          retries++;
          // Parse wait time from error message if available
          const waitMatch = err.message?.match(/try again in (\d+)m(\d+(?:\.\d+)?)?s/);
          const waitMs = waitMatch
            ? (parseInt(waitMatch[1], 10) * 60 + parseFloat(waitMatch[2] ?? "0")) * 1000 + 5000
            : retries * 30000;
          const waitSec = Math.ceil(waitMs / 1000);
          log("warn", chalk.yellow(`Rate limit hit — waiting ${waitSec}s before retry ${retries}/3...`));
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        log("error", `Groq API error: ${err.message}`);
        throw err;
      }
    }

    const choice  = response.choices[0];
    const message = choice.message;

    /* Append assistant turn to history */
    messages.push(message);

    /* 2. Handle tool calls (official or failsafe) ────────── */
    let toolCalls = message.tool_calls || [];

    // Failsafe: detect hallucinated tool calls in text (handle multiple)
    if (toolCalls.length === 0 && message.content?.includes('"name":')) {
      const text = message.content;
      let pos = 0;
      const hallucinatedCalls = [];
      while ((pos = text.indexOf('"name":', pos)) !== -1) {
        try {
          const nameMatch = text.slice(pos).match(/"name":\s*"(\w+)"/);
          if (!nameMatch) { pos++; continue; }
          const name = nameMatch[1];
          const paramIdx = text.slice(pos).search(/"(parameters|args|arguments)":\s*\{/);
          if (paramIdx === -1) { pos++; continue; }
          const blockStart = pos + paramIdx + text.slice(pos + paramIdx).indexOf('{');
          let depth = 0;
          let blockEnd = -1;
          for (let i = blockStart; i < text.length; i++) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}') depth--;
            if (depth === 0) { blockEnd = i + 1; break; }
          }
          if (blockEnd !== -1) {
            const argsStr = text.slice(blockStart, blockEnd);
            hallucinatedCalls.push({
              id: `fs_${Date.now()}_${hallucinatedCalls.length}`,
              type: "function",
              function: { name, arguments: argsStr }
            });
            pos = blockEnd;
          } else { pos++; }
        } catch { pos++; }
      }
      if (hallucinatedCalls.length > 0) {
        log("info", chalk.blue(`Detected ${hallucinatedCalls.length} failsafe tool call(s) — executing...`));
        toolCalls = hallucinatedCalls;
        // REPAIR HISTORY: Inject these into the assistant message
        message.tool_calls = toolCalls;
      }
    }

    if (toolCalls.length > 0) {
      logStep("TOOL", `Agent is calling ${toolCalls.length} tool(s)`);

      const toolResults = [];

      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        let   toolArgs;

        try {
          toolArgs = JSON.parse(tc.function.arguments);
        } catch {
          toolArgs = {};
        }

        logStep("TOOL", `→ ${toolName}`, toolName);
        printStepJSON({
          step:      "TOOL",
          content:   `Calling tool: ${toolName}`,
          tool_name: toolName,
          tool_args: JSON.stringify(toolArgs).slice(0, 200),
        });

        let result;
        try {
          result = await callTool(toolName, toolArgs);
        } catch (err) {
          result = { ok: false, error: err.message };
          log("warn", `Tool ${toolName} threw: ${err.message}`);
        }

        /* Track written files and capture scraped data */
        if (toolName === "write_file" && result.ok && toolArgs.file_path) {
          writtenFiles.add(path.basename(toolArgs.file_path));
        }
        if (toolName === "fetch_page_design" && result.ok && result.data) {
          scrapedData = result.data;
        }

        logStep("OBSERVE", `← ${toolName} returned: ${result.ok ? "OK" : "ERROR"}`);
        printStepJSON({
          step:    "OBSERVE",
          content: `Result from ${toolName}: ${JSON.stringify(result).slice(0, 300)}`,
        });

        toolResults.push({
          role:         "tool",
          tool_call_id: tc.id,
          content:      JSON.stringify(result),
        });
      }

      /* Append all tool results to history */
      messages.push(...toolResults);
      continue; // go back to top of loop
    }

    /* 3. Handle text response ───────────────────────── */
    const text = message.content ?? "";
    const step = detectStep(text);
    const parsed = safeParseJSON(text);

    logStep(step, parsed?.content ?? text.slice(0, 120));
    if (parsed) printStepJSON(parsed);

    /* 4. Check for OUTPUT ───────────────────────────── */
    if (step === "OUTPUT" || choice.finish_reason === "stop") {
      finalOutput = parsed ?? { step: "OUTPUT", content: text };

      if (step === "OUTPUT") {
        log("success", "Agent reached OUTPUT — clone complete!");
        break;
      }

      // Only stop early once ALL 3 required files have been written
      const allDone = ["index.html", "style.css", "script.js"].every((f) => writtenFiles.has(f));
      if (choice.finish_reason === "stop" && (allDone || iteration >= 12)) {
        log("info", "Agent finished responding — checking generated files...");
        break;
      }
    }

    /* 5. Continue loop with a targeted nudge ─────────── */
    if (step === "THINK" || choice.finish_reason === "stop") {
      const missing = ["index.html", "style.css", "script.js"].filter((f) => !writtenFiles.has(f));
      const nudge = missing.length > 0
        ? `Now write the next file: ${missing[0]}. Use the write_file tool with the FULL content — do NOT use placeholder comments. Write every line of HTML/CSS/JS.`
        : "All 3 files written. Now call validate_html on index.html, then call list_files to confirm, then output the final OUTPUT step JSON.";
      messages.push({ role: "user", content: nudge });
    }
  }

  if (iteration >= maxIter) {
    log("warn", `Reached max iterations (${maxIter}). Stopping.`);
  }

  /* ── Print final summary ────────────────────────────── */
  await printSummary(output, url, scrapedData);
}

/* ═══════════════════════════════════════════════════════
   POST-PROCESS: merge LLM output with full base template
═══════════════════════════════════════════════════════ */
async function mergeWithBaseFiles(outputDir, scrapedData) {
  const fs = (await import("fs/promises")).default;

  let htmlContent;
  try {
    htmlContent = await fs.readFile(path.resolve(outputDir, "index.html"), "utf8");
  } catch { return; }

  // If the file is thin (< 3 KB) or has placeholder comments, rebuild it
  const hasPlaceholders = /<!--.*?(ticker|cards|brand|columns|logo here).*?-->/i.test(htmlContent);
  const isThin = Buffer.byteLength(htmlContent, "utf8") < 5000;

  if (!hasPlaceholders && !isThin) {
    log("info", "HTML looks complete — no merge needed");
    return;
  }

  log("info", "HTML has placeholders — injecting real content from scraped data...");

  // Extract real nav links from the LLM-written HTML
  const navMatch = htmlContent.match(/<ul class="nav-links">([\s\S]*?)<\/ul>/);
  const realNavLinks = navMatch ? navMatch[1] : `
    <li><a href="#" class="nav-link">MASTERCLASS</a></li>
    <li><a href="#" class="nav-link">AI LABS</a></li>
    <li><a href="#" class="nav-link">ALUMNI</a></li>
    <li><a href="#" class="nav-link">Why Scaler</a></li>
    <li><a href="#" class="nav-link">Program</a></li>
    <li><a href="#" class="nav-link">Placement Report</a></li>`;

  // Build mobile links from the same nav data
  const mobileLinks = realNavLinks.replace(/class="nav-link"/g, 'class="mobile-nav-link"');

  // Build footer programs from scraped footer text
  const programs = (scrapedData?.footer_text ?? "").match(/Modern[\w\s&,]+Engineering[^.]+/g) ?? [];
  const footerPrograms = programs.slice(0, 4).map(
    (p) => `<li><a href="#" class="footer-link">${p.trim().slice(0, 55)}</a></li>`
  ).join("\n                ") || `
    <li><a href="#" class="footer-link">Modern Software & AI Engineering</a></li>
    <li><a href="#" class="footer-link">Data Science & ML with AI</a></li>
    <li><a href="#" class="footer-link">DevOps, Cloud & AI Platform</a></li>
    <li><a href="#" class="footer-link">Advanced AI & ML with Agentic AI</a></li>`;

  const title = scrapedData?.title ?? "Scaler Academy";
  const description = scrapedData?.description ?? "The investment that compounds.";

  const fullHTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="${description}" />
    <title>${title}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>

    <!-- HEADER -->
    <header class="header" id="site-header">
      <a href="#" class="logo" aria-label="Scaler Home">
        <svg class="logo-icon" width="28" height="28" viewBox="0 0 28 28" fill="none">
          <rect width="28" height="28" rx="6" fill="#0055FF"/>
          <path d="M8 10h4v8H8zM12 14h4v4h-4zM16 8h4v10h-4z" fill="white"/>
        </svg>
        <span class="logo-text">SCALER</span>
      </a>
      <nav class="nav" aria-label="Main Navigation">
        <ul class="nav-links" id="nav-links">
          ${realNavLinks}
        </ul>
      </nav>
      <div class="header-actions">
        <a href="#" class="btn-login" id="btn-login">Login</a>
        <a href="#" class="cta-btn header-cta" id="header-cta-btn">REQUEST A CALLBACK</a>
      </div>
      <button class="hamburger" id="hamburger" aria-label="Toggle menu" aria-expanded="false">
        <span class="hamburger-bar"></span>
        <span class="hamburger-bar"></span>
        <span class="hamburger-bar"></span>
      </button>
    </header>

    <!-- Mobile nav -->
    <div class="mobile-nav" id="mobile-nav" aria-hidden="true">
      <ul class="mobile-nav-links">
        ${mobileLinks}
        <li><a href="#" class="mobile-nav-link mobile-cta">REQUEST A CALLBACK</a></li>
      </ul>
    </div>

    <!-- HERO -->
    <section class="hero" id="hero">
      <div class="hero-badge">
        <span class="badge-dot"></span>
        THE MARKET HAS ALREADY CHANGED
      </div>
      <h1 class="hero-title">
        Become the Professional<br />
        Built for the <span class="gradient-text">Next Decade in AI.</span>
      </h1>
      <p class="hero-subtext">
        The investment that compounds. Strong technical foundations,<br class="break-desktop" />
        AI integrated at every stage, and a curriculum that evolves as the market does.
      </p>
      <div class="hero-stats">
        <div class="stat-item"><span class="stat-number">700+</span><span class="stat-label">Hiring Partners</span></div>
        <div class="stat-divider"></div>
        <div class="stat-item"><span class="stat-number">40 LPA</span><span class="stat-label">Highest Salary</span></div>
        <div class="stat-divider"></div>
        <div class="stat-item"><span class="stat-number">6&times;</span><span class="stat-label">Average Salary Hike</span></div>
        <div class="stat-divider"></div>
        <div class="stat-item"><span class="stat-number">20,000+</span><span class="stat-label">Lives Transformed</span></div>
      </div>
      <div class="hero-cta-group">
        <a href="#" class="cta-btn hero-primary-btn" id="hero-primary-btn">REQUEST A CALLBACK</a>
        <a href="#" class="btn-secondary hero-secondary-btn" id="hero-secondary-btn">BOOK FREE LIVE CLASS</a>
      </div>
      <div class="hero-cards">
        <div class="hero-card">
          <span class="card-emoji">&#127891;</span>
          <div class="card-info">
            <span class="card-name">Rahul K.</span>
            <span class="card-role">Software Engineer @ Google</span>
            <span class="card-salary">18 LPA &rarr; 42 LPA</span>
          </div>
        </div>
        <div class="hero-card">
          <span class="card-emoji">&#128640;</span>
          <div class="card-info">
            <span class="card-name">Priya S.</span>
            <span class="card-role">ML Engineer @ Amazon</span>
            <span class="card-salary">12 LPA &rarr; 38 LPA</span>
          </div>
        </div>
        <div class="hero-card">
          <span class="card-emoji">&#128161;</span>
          <div class="card-info">
            <span class="card-name">Arjun M.</span>
            <span class="card-role">Backend Dev @ Microsoft</span>
            <span class="card-salary">10 LPA &rarr; 32 LPA</span>
          </div>
        </div>
      </div>
    </section>

    <!-- COMPANIES TICKER -->
    <section class="companies-section" id="companies">
      <p class="companies-label">Our alumni work at top companies</p>
      <div class="companies-track-wrapper">
        <div class="companies-track" id="companies-track">
          <span class="company-logo">Google</span>
          <span class="company-logo">Amazon</span>
          <span class="company-logo">Microsoft</span>
          <span class="company-logo">Meta</span>
          <span class="company-logo">Apple</span>
          <span class="company-logo">Netflix</span>
          <span class="company-logo">Flipkart</span>
          <span class="company-logo">Swiggy</span>
          <span class="company-logo">Razorpay</span>
          <span class="company-logo">Paytm</span>
          <span class="company-logo">Google</span>
          <span class="company-logo">Amazon</span>
          <span class="company-logo">Microsoft</span>
          <span class="company-logo">Meta</span>
          <span class="company-logo">Apple</span>
          <span class="company-logo">Netflix</span>
          <span class="company-logo">Flipkart</span>
          <span class="company-logo">Swiggy</span>
          <span class="company-logo">Razorpay</span>
          <span class="company-logo">Paytm</span>
        </div>
      </div>
    </section>

    <!-- FOOTER -->
    <footer class="footer" id="site-footer">
      <div class="footer-inner">
        <div class="footer-top">
          <div class="footer-brand">
            <a href="#" class="footer-logo" aria-label="Scaler Home">
              <svg width="24" height="24" viewBox="0 0 28 28" fill="none">
                <rect width="28" height="28" rx="6" fill="#0055FF"/>
                <path d="M8 10h4v8H8zM12 14h4v4h-4zM16 8h4v10h-4z" fill="white"/>
              </svg>
              <span class="footer-logo-text">SCALER</span>
            </a>
            <p class="footer-tagline">Building the engineers<br />that AI can't replace.</p>
            <div class="footer-socials">
              <a href="#" class="social-link" aria-label="YouTube">YT</a>
              <a href="#" class="social-link" aria-label="LinkedIn">in</a>
              <a href="#" class="social-link" aria-label="Twitter">X</a>
              <a href="#" class="social-link" aria-label="Instagram">IG</a>
            </div>
          </div>
          <div class="footer-links-grid">
            <div class="footer-col">
              <h3 class="footer-col-title">Explore Scaler</h3>
              <ul class="footer-col-list">
                ${footerPrograms}
              </ul>
            </div>
            <div class="footer-col">
              <h3 class="footer-col-title">Resources</h3>
              <ul class="footer-col-list">
                <li><a href="#" class="footer-link">Alumni Reviews</a></li>
                <li><a href="#" class="footer-link">Blog</a></li>
                <li><a href="#" class="footer-link">Interview Questions</a></li>
                <li><a href="#" class="footer-link">Placement Report</a></li>
                <li><a href="#" class="footer-link">Contact Us</a></li>
              </ul>
            </div>
            <div class="footer-col">
              <h3 class="footer-col-title">Company</h3>
              <ul class="footer-col-list">
                <li><a href="#" class="footer-link">About Us</a></li>
                <li><a href="#" class="footer-link">Become a Mentor</a></li>
                <li><a href="#" class="footer-link">Hire From Us</a></li>
                <li><a href="#" class="footer-link">Privacy Policy</a></li>
                <li><a href="#" class="footer-link">Terms of Use</a></li>
              </ul>
            </div>
          </div>
        </div>
        <div class="footer-bottom">
          <p class="footer-bottom-text">
            Need help? Call us at <strong>08047939623</strong> or
            <a href="#" class="footer-bottom-link">Request a Call</a>
          </p>
          <p class="footer-copyright">
            &copy; 2024 Interviewbit Software Services Private Limited, Bengaluru, Karnataka.
          </p>
        </div>
      </div>
    </footer>

    <script src="script.js"></script>
  </body>
</html>`;

  await fs.writeFile(path.resolve(outputDir, "index.html"), fullHTML, "utf8");
  log("success", `Merged & rebuilt index.html with real scraped content (${(Buffer.byteLength(fullHTML)/1024).toFixed(1)} KB)`);
}

/* ═══════════════════════════════════════════════════════
   SUMMARY
═══════════════════════════════════════════════════════ */
async function printSummary(outputDir, url, scrapedData) {
  const { list_files } = await import("./tools.js");

  /* Merge step: inject real content if LLM left placeholders */
  await mergeWithBaseFiles(outputDir, scrapedData);

  const result = await list_files({ folder_path: outputDir });

  console.log("\n");
  console.log(chalk.bold.green("  ╔════════════════════════════════════════╗"));
  console.log(chalk.bold.green("  ║         ✅  CLONE COMPLETE             ║"));
  console.log(chalk.bold.green("  ╚════════════════════════════════════════╝\n"));

  if (result.ok && result.files.length > 0) {
    console.log(chalk.bold("  Generated files:"));
    result.files.forEach((f) => console.log(chalk.cyan(`    📄 ${f}`)));
  }

  const indexPath = path.resolve(outputDir, "index.html");
  console.log(`\n  ${chalk.bold("Open in browser:")}`);
  console.log(chalk.cyan(`    file:///${indexPath.replace(/\\/g, "/")}\n`));

  printStepJSON({
    step:         "OUTPUT",
    content:      `Successfully cloned ${url} → ${outputDir}/`,
    output_files: result.files ?? [],
  });

  /* Auto-open in default browser */
  try {
    await open(indexPath);
    log("success", "Opened index.html in your default browser");
  } catch {
    log("info", `Open manually: file:///${indexPath.replace(/\\/g, "/")}`);
  }
}
