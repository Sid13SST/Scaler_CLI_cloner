/**
 * chat.js — Conversational CLI interface (Cursor/Windsurf-style)
 *
 * The user types natural language in the terminal.
 * The agent reads it, reasons, calls tools, and responds.
 * The loop continues until the user types "exit".
 */

import readline from "readline";
import OpenAI   from "openai";
import chalk    from "chalk";
import path     from "path";
import open     from "open";

import { TOOL_SCHEMAS, callTool } from "./tools.js";
import { logStep, printStepJSON, log } from "./logger.js";

/* ═══════════════════════════════════════════════════════
   CHAT SYSTEM PROMPT
═══════════════════════════════════════════════════════ */
const CHAT_SYSTEM_PROMPT = `You are an expert web-cloning AI agent embedded in a conversational CLI terminal — similar to how Cursor or Windsurf work.
You are powered by OpenRouter.

You help users clone websites by generating pixel-perfect HTML, CSS, and JavaScript files.

PERSONALITY:
- Be concise and direct like a senior engineer
- Always explain what you are about to do BEFORE calling a tool
- After each tool call, summarise what happened
- Ask clarifying questions if the user's request is ambiguous

TOOLS AVAILABLE:
- fetch_page_design(url)     — fetch & analyse a website's design content
- create_folder(folder_path) — create a directory
- create_new_file(file_path, content) — ONLY for creating NEW files. NEVER use this to edit existing files.
- replace_in_file(file_path, target, replacement) — SURGICAL EDITS. Use this for 99% of updates.
- append_to_file(file_path, content) — Add new code to the end of a file.
- read_file(file_path)       — read a file
- list_files(folder_path)    — list files in a folder
- validate_html(file_path)   — check HTML for common issues
- open_in_browser(file_path) — open the website for the user

CRITICAL TOOL CALLING RULES:
1. ALWAYS use the provided tools to take action.
2. To use a tool, you MUST return a tool_call. 
3. NEVER use create_new_file to edit an existing file. It OVERWRITES everything.
4. For ALL EDITS to existing files, use replace_in_file or append_to_file.
5. If you want to add a section to HTML, replace "</body>" with "YOUR_NEW_HTML\n</body>".
6. Call open_in_browser ONLY ONCE at the very end of your task. Do NOT call it after every small change.
7. Do NOT use placeholder comments. Write REAL CODE.

CODING RULES (NEVER break these):
1. Semantic HTML5: <header>, <nav>, <section>, <footer>
2. Class-based CSS only — NO inline styles
3. Pure vanilla CSS — NO Tailwind
4. NO CSS variables (var(--...)) — use real hex/px values
5. Outfit Google Font, responsive (mobile + desktop)
6. Gradient text: background: linear-gradient(90deg, #0055ff 0%, #06b6d4 25%, #0055ff 50%, #06b6d4 75%, #0055ff 100%); with -webkit-background-clip: text
7. Header: logo left, nav center, CTA right
8. Hero: 60px heading, gradient span, stats row, 2 CTAs, 3 success cards
9. Footer: #011845 background, 3 link columns

WHEN CLONING SCALER:
- Use output folder: scaler_clone/
- Files: index.html, style.css, script.js
- Must have: Header + Hero Section + Footer
- Auto-open in browser when done

RESPONSE FORMAT:
- For plain conversation: just reply naturally in plain text
- When taking action: explain what you are doing, then call the tool
- I will AUTOMATICALLY open the browser for the user after you finish writing files. You don't need to ask.
- After all files are written: confirm the changes to the user.

You are ready. Wait for the user's first message.`;

/* ═══════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════ */

/** Animate a "thinking" spinner while awaiting LLM response */
function startSpinner(label = "Thinking") {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r  ${chalk.cyan(frames[i % frames.length])}  ${chalk.gray(label + "...")}`);
    i++;
  }, 80);
  return () => {
    clearInterval(id);
    process.stdout.write("\r" + " ".repeat(40) + "\r"); // clear line
  };
}

/** Wrap text at word boundaries for clean terminal output */
function wrapText(text, width = 78, indent = "  ") {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    if ((line + word).length > width) {
      if (line) lines.push(indent + line.trimEnd());
      line = word + " ";
    } else {
      line += word + " ";
    }
  }
  if (line.trim()) lines.push(indent + line.trimEnd());
  return lines.join("\n");
}

/** Print the agent's text reply with nice formatting */
function printAgentReply(text) {
  console.log();
  console.log(chalk.bold.cyan("  🤖 Agent"));
  console.log(chalk.gray("  " + "─".repeat(50)));
  // Handle markdown-ish formatting
  text.split("\n").forEach((line) => {
    if (line.startsWith("## ")) {
      console.log(chalk.bold.white("  " + line.replace("## ", "")));
    } else if (line.startsWith("# ")) {
      console.log(chalk.bold.blue("  " + line.replace("# ", "")));
    } else if (line.match(/^[-*] /)) {
      console.log(chalk.white("  • " + line.slice(2)));
    } else if (line.match(/^\d+\. /)) {
      console.log(chalk.white("  " + line));
    } else if (line.trim() === "") {
      console.log();
    } else {
      console.log(wrapText(line));
    }
  });
  console.log();
}

/** Print a tool action summary */
function printToolAction(toolName, args) {
  const icons = {
    fetch_page_design: "🌐",
    create_folder:     "📁",
    write_file:        "✍️ ",
    read_file:         "📖",
    list_files:        "📋",
    validate_html:     "✅",
    open_in_browser:   "🌐",
    replace_in_file:   "✂️",
    append_to_file:    "➕",
  };
  const icon = icons[toolName] ?? "🔧";
  const argStr = args.file_path ?? args.folder_path ?? args.url ?? "";
  console.log(chalk.yellow(`\n  ${icon}  ${chalk.bold(toolName)}`) + chalk.gray(`  ${argStr}`));
}

/** Print a tool result summary */
function printToolResult(toolName, result) {
  if (!result.ok) {
    console.log(chalk.red(`     ✗ Error: ${result.error}`));
    return;
  }
  const summaries = {
    fetch_page_design: `Scraped: "${result.data?.title ?? "OK"}"`,
    create_folder:     `Created`,
    write_file:        `Written (${result.size_kb} KB)`,
    read_file:         `Read (${(result.content?.length ?? 0)} chars)`,
    list_files:        `Found ${result.files?.length ?? 0} file(s)`,
    validate_html:     `${result.status} — ${result.warnings?.length ?? 0} warning(s)`,
    open_in_browser:   `Opened in browser`,
    replace_in_file:   `Updated file`,
    append_to_file:    `Appended to file`,
  };
  console.log(chalk.green(`     ✔ ${summaries[toolName] ?? "Done"}`));
}

/* ═══════════════════════════════════════════════════════
   POST-PROCESS: fill skeleton HTML if LLM left placeholders
═══════════════════════════════════════════════════════ */
async function ensureFullHTML(outputDir, scrapedData) {
  const { default: fs } = await import("fs/promises");
  let html;
  try { html = await fs.readFile(path.resolve(outputDir, "index.html"), "utf8"); }
  catch { return; }

  const hasPlaceholder = /<!--.*?(ticker|cards|brand|logo here|columns).*?-->/i.test(html);
  const isThin = Buffer.byteLength(html, "utf8") < 5000;
  if (!hasPlaceholder && !isThin) return;

  log("info", "Filling skeleton HTML with full content...");

  const navMatch = html.match(/<ul class="nav-links">([\s\S]*?)<\/ul>/);
  const navLinks = navMatch ? navMatch[1] : `
    <li><a href="#" class="nav-link">MASTERCLASS</a></li>
    <li><a href="#" class="nav-link">AI LABS</a></li>
    <li><a href="#" class="nav-link">ALUMNI</a></li>
    <li><a href="#" class="nav-link">Why Scaler</a></li>
    <li><a href="#" class="nav-link">Program</a></li>
    <li><a href="#" class="nav-link">Placement Report</a></li>`;

  const mobileLinks = navLinks.replace(/class="nav-link"/g, 'class="mobile-nav-link"');
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
    <header class="header" id="site-header">
      <a href="#" class="logo" aria-label="Scaler Home">
        <svg class="logo-icon" width="28" height="28" viewBox="0 0 28 28" fill="none">
          <rect width="28" height="28" rx="6" fill="#0055FF"/>
          <path d="M8 10h4v8H8zM12 14h4v4h-4zM16 8h4v10h-4z" fill="white"/>
        </svg>
        <span class="logo-text">SCALER</span>
      </a>
      <nav class="nav" aria-label="Main Navigation">
        <ul class="nav-links" id="nav-links">${navLinks}</ul>
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
    <div class="mobile-nav" id="mobile-nav" aria-hidden="true">
      <ul class="mobile-nav-links">${mobileLinks}
        <li><a href="#" class="mobile-nav-link mobile-cta">REQUEST A CALLBACK</a></li>
      </ul>
    </div>
    <section class="hero" id="hero">
      <div class="hero-badge"><span class="badge-dot"></span>THE MARKET HAS ALREADY CHANGED</div>
      <h1 class="hero-title">Become the Professional<br />Built for the <span class="gradient-text">Next Decade in AI.</span></h1>
      <p class="hero-subtext">The investment that compounds. Strong technical foundations,<br class="break-desktop" />AI integrated at every stage, and a curriculum that evolves as the market does.</p>
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
        <div class="hero-card"><span class="card-emoji">&#127891;</span><div class="card-info"><span class="card-name">Rahul K.</span><span class="card-role">Software Engineer @ Google</span><span class="card-salary">18 LPA &rarr; 42 LPA</span></div></div>
        <div class="hero-card"><span class="card-emoji">&#128640;</span><div class="card-info"><span class="card-name">Priya S.</span><span class="card-role">ML Engineer @ Amazon</span><span class="card-salary">12 LPA &rarr; 38 LPA</span></div></div>
        <div class="hero-card"><span class="card-emoji">&#128161;</span><div class="card-info"><span class="card-name">Arjun M.</span><span class="card-role">Backend Dev @ Microsoft</span><span class="card-salary">10 LPA &rarr; 32 LPA</span></div></div>
      </div>
    </section>
    <section class="companies-section" id="companies">
      <p class="companies-label">Our alumni work at top companies</p>
      <div class="companies-track-wrapper">
        <div class="companies-track" id="companies-track">
          <span class="company-logo">Google</span><span class="company-logo">Amazon</span><span class="company-logo">Microsoft</span><span class="company-logo">Meta</span><span class="company-logo">Apple</span><span class="company-logo">Netflix</span><span class="company-logo">Flipkart</span><span class="company-logo">Swiggy</span><span class="company-logo">Razorpay</span><span class="company-logo">Paytm</span>
          <span class="company-logo">Google</span><span class="company-logo">Amazon</span><span class="company-logo">Microsoft</span><span class="company-logo">Meta</span><span class="company-logo">Apple</span><span class="company-logo">Netflix</span><span class="company-logo">Flipkart</span><span class="company-logo">Swiggy</span><span class="company-logo">Razorpay</span><span class="company-logo">Paytm</span>
        </div>
      </div>
    </section>
    <footer class="footer" id="site-footer">
      <div class="footer-inner">
        <div class="footer-top">
          <div class="footer-brand">
            <a href="#" class="footer-logo"><svg width="24" height="24" viewBox="0 0 28 28" fill="none"><rect width="28" height="28" rx="6" fill="#0055FF"/><path d="M8 10h4v8H8zM12 14h4v4h-4zM16 8h4v10h-4z" fill="white"/></svg><span class="footer-logo-text">SCALER</span></a>
            <p class="footer-tagline">Building the engineers<br />that AI can't replace.</p>
            <div class="footer-socials">
              <a href="#" class="social-link">YT</a>
              <a href="#" class="social-link">in</a>
              <a href="#" class="social-link">X</a>
              <a href="#" class="social-link">IG</a>
            </div>
          </div>
          <div class="footer-links-grid">
            <div class="footer-col"><h3 class="footer-col-title">Explore Scaler</h3><ul class="footer-col-list"><li><a href="#" class="footer-link">Modern Software &amp; AI Engineering</a></li><li><a href="#" class="footer-link">Data Science &amp; ML with AI</a></li><li><a href="#" class="footer-link">DevOps, Cloud &amp; AI Platform</a></li><li><a href="#" class="footer-link">Advanced AI &amp; ML</a></li><li><a href="#" class="footer-link">System Design</a></li></ul></div>
            <div class="footer-col"><h3 class="footer-col-title">Resources</h3><ul class="footer-col-list"><li><a href="#" class="footer-link">Alumni Reviews</a></li><li><a href="#" class="footer-link">Blog</a></li><li><a href="#" class="footer-link">Interview Questions</a></li><li><a href="#" class="footer-link">Placement Report</a></li><li><a href="#" class="footer-link">Contact Us</a></li></ul></div>
            <div class="footer-col"><h3 class="footer-col-title">Company</h3><ul class="footer-col-list"><li><a href="#" class="footer-link">About Us</a></li><li><a href="#" class="footer-link">Become a Mentor</a></li><li><a href="#" class="footer-link">Hire From Us</a></li><li><a href="#" class="footer-link">Privacy Policy</a></li><li><a href="#" class="footer-link">Terms of Use</a></li></ul></div>
          </div>
        </div>
        <div class="footer-bottom">
          <p class="footer-bottom-text">Need help? Call us at <strong>08047939623</strong> or <a href="#" class="footer-bottom-link">Request a Call</a></p>
          <p class="footer-copyright">&copy; 2024 Interviewbit Software Services Private Limited, Bengaluru, Karnataka.</p>
        </div>
      </div>
    </footer>
    <script src="script.js"></script>
  </body>
</html>`;

  await fs.writeFile(path.resolve(outputDir, "index.html"), fullHTML, "utf8");
  log("success", `Rebuilt index.html (${(Buffer.byteLength(fullHTML) / 1024).toFixed(1)} KB)`);
}

/* ═══════════════════════════════════════════════════════
   MAIN CHAT LOOP
═══════════════════════════════════════════════════════ */
export async function startChat({ model }) {
  const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/Sid13SST/Scaler_CLI_cloner",
      "X-Title": "Scaler CLI Cloner",
    },
  });

  // Conversation history — persists across the whole session
  const messages = [{ role: "system", content: CHAT_SYSTEM_PROMPT }];

  // Track state across turns
  let scrapedData  = null;
  let outputDir    = "scaler_clone";
  let filesWritten = new Set();

  /* ── Print welcome ─────────────────────────────────── */
  console.log();
  console.log(chalk.bold.blue("  ╔═══════════════════════════════════════════════╗"));
  console.log(chalk.bold.blue("  ║   🤖  SCALER CLI AGENT  • Powered by OpenRouter ║"));
  console.log(chalk.bold.blue("  ║   Chat naturally — I'll clone the website     ║"));
  console.log(chalk.bold.blue("  ╚═══════════════════════════════════════════════╝"));
  console.log();
  console.log(chalk.gray("  Type your instruction below. Examples:"));
  console.log(chalk.gray('  › "Clone the Scaler Academy website"'));
  console.log(chalk.gray('  › "Clone scaler.com with a dark hero section"'));
  console.log(chalk.gray('  › "Add a testimonials section"'));
  console.log(chalk.gray('  › exit   (to quit)'));
  console.log();

  /* ── Set up readline ───────────────────────────────── */
  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    prompt: chalk.bold.green("  You › "),
  });

  rl.prompt();

  /* ── Handle each line of user input ───────────────── */
  rl.on("line", async (rawInput) => {
    const input = rawInput.trim();

    // Exit commands
    if (!input || ["exit", "quit", "bye", "q"].includes(input.toLowerCase())) {
      console.log(chalk.gray("\n  👋  Goodbye!\n"));
      rl.close();
      process.exit(0);
    }

    // Pause readline during agent processing
    rl.pause();

    // Add user message to history
    messages.push({ role: "user", content: input });

    let turnModifiedFiles = false;

    /* ── Agentic sub-loop for this user turn ─────────── */
    let turnDone = false;
    let stepCount = 0;
    const MAX_STEPS = 15;

    while (!turnDone && stepCount < MAX_STEPS) {
      stepCount++;

      /* Call Groq with retry */
      const stopSpinner = startSpinner(stepCount === 1 ? "Thinking" : "Working");
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
          break;
        } catch (err) {
          const is429 = err.status === 429 || err.message?.includes("rate_limit_exceeded");
          if (is429 && retries < 3) {
            retries++;
            const waitMatch = err.message?.match(/try again in (\d+)m(\d+(?:\.\d+)?)?s/);
            const waitMs = waitMatch
              ? (parseInt(waitMatch[1], 10) * 60 + parseFloat(waitMatch[2] ?? "0")) * 1000 + 3000
              : retries * 20000;
            stopSpinner();
            log("warn", chalk.yellow(`Rate limit — waiting ${Math.ceil(waitMs / 1000)}s...`));
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          stopSpinner();
          log("error", err.message);
          turnDone = true;
          break;
        }
      }

      stopSpinner();
      if (turnDone) break;

      const choice  = response.choices[0];
      const message = choice.message;
      messages.push(message);

      /* ── Agent called a tool (official or failsafe) ── */
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
          // REPAIR HISTORY: Inject these into the assistant message so the LLM stays in sync
          message.tool_calls = toolCalls;
        }
      }

      if (toolCalls.length > 0) {
        const toolResults = [];

        for (const tc of toolCalls) {
          const toolName = tc.function.name;
          let toolArgs;
          try { toolArgs = JSON.parse(tc.function.arguments); }
          catch { toolArgs = {}; }

          printToolAction(toolName, toolArgs);

          let result;
          try   { result = await callTool(toolName, toolArgs); }
          catch (e) { result = { ok: false, error: e.message }; }

          printToolResult(toolName, result);

          // Track state
          if (toolName === "fetch_page_design" && result.ok) scrapedData = result.data;
          if ((toolName === "write_file" || toolName === "replace_in_file" || toolName === "append_to_file") && result.ok) {
            turnModifiedFiles = true;
            if (toolArgs.file_path) {
              filesWritten.add(path.basename(toolArgs.file_path));
              if (toolArgs.file_path.includes("/")) {
                outputDir = toolArgs.file_path.split("/")[0];
              }
            }
          }

          toolResults.push({
            role:         "tool",
            tool_call_id: tc.id,
            content:      JSON.stringify(result),
          });
        }

        messages.push(...toolResults);

        // After all 3 files written, post-process + offer to open
        const allDone = ["index.html", "style.css", "script.js"].every((f) => filesWritten.has(f));
        if (allDone) {
          await ensureFullHTML(outputDir, scrapedData);
          // Let the agent give a final reply then stop
        }

        continue; // go back to top of sub-loop
      }

      /* ── Agent gave a text reply ───────────────────── */
      const text = message.content ?? "";
      printAgentReply(text);

      turnDone = true;
    }

    if (stepCount >= MAX_STEPS) {
      console.log(chalk.yellow("\n  ⚠  Reached max steps for this turn.\n"));
    }

    // Resume readline for next user input
    rl.resume();
    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });
}
