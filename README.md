# 🌐 Scaler CLI Cloner

An AI-powered CLI agent that clones websites into pixel-perfect HTML/CSS/JS using **OpenRouter LLMs**.

Operates in an agentic loop:  
`START → THINK → TOOL → OBSERVE → THINK → TOOL → ... → OUTPUT`

---

## ✨ Features

- **Agentic loop** — LLM drives itself using tool calls
- **OpenRouter-powered** — Uses `meta-llama/llama-3.3-70b-instruct` by default
- **6 built-in tools**: `fetch_page_design`, `create_folder`, `write_file`, `read_file`, `list_files`, `validate_html`
- **Strict coding rules enforced** via system prompt (no inline styles, no Tailwind, no CSS vars)
- **Gradient text** animation baked in
- **Responsive** output (mobile + desktop)
- Auto-opens the result in your browser on completion

---

## 🚀 Quick Start

### 1. Get an OpenRouter API Key
- Go to → **https://openrouter.ai/keys**

### 2. Set up your `.env`
```bash
# Add to .env:
OPENROUTER_API_KEY=sk-or-v1-your_key_here
```

### 3. Install dependencies
```bash
npm install
```

## 🚀 How to Run

### 💬 Chat Mode (Default) — *Conversational AI Agent*
Interact with the agent in natural language, just like Cursor or Windsurf.
```bash
# Start the conversational chat
node src/index.js
```
**Examples of what you can say:**
- "Clone the Scaler Academy website into a folder called 'scaler_clone'"
- "Make the hero section have a darker background"
- "Add a button ripple effect in the script.js file"

### 🤖 Auto Mode — *One-Shot Autonomous Clone*
Let the agent clone the site fully on its own without intervention.
```bash
# Clone Scaler Academy autonomously
node src/index.js --auto

# Clone a specific website autonomously
node src/index.js --auto https://www.interviewbit.com
```

### ⚙️ Configuration Flags
| Flag | Description | Default |
|------|-------------|---------|
| `--model` | OpenRouter model to use | `meta-llama/llama-3.3-70b-instruct` |
| `--output` | Target folder name | `scaler_clone` |
| `--max-steps`| Max agent iterations | `20` |
| `--auto` | Run in autonomous mode | `false` |

---

## 📁 Project Structure

```
Scaler_CLI_cloner/
├── src/
│   ├── index.js     ← CLI entry point (arg parsing)
│   ├── agent.js     ← Agentic loop (START → THINK → TOOL → OBSERVE → OUTPUT)
│   ├── tools.js     ← All tool schemas + implementations
│   ├── prompts.js   ← System prompt builder
│   └── logger.js    ← Coloured terminal output
├── scaler_clone/    ← Generated output (created by the agent)
│   ├── index.html
│   ├── style.css
│   └── script.js
├── .env             ← Your Groq API key (git-ignored)
├── .env.example     ← Template
├── package.json
└── README.md
```

---

## 🛠 Available Tools

| Tool | Description |
|------|-------------|
| `fetch_page_design` | Fetches a URL and extracts headings, nav links, buttons, footer text |
| `create_folder` | Creates a directory on disk |
| `write_file` | Writes content to a file (creates parents if needed) |
| `read_file` | Reads a file for review/refinement |
| `list_files` | Lists all files in a folder |
| `validate_html` | Checks HTML for missing tags, charset, viewport, etc. |

---

## 📤 Output Format

Every agent step prints a JSON card:

```json
{
  "step": "THINK | TOOL | OBSERVE | OUTPUT",
  "content": "What the agent is doing",
  "tool_name": "write_file",
  "tool_args": "scaler_clone/index.html"
}
```

---

## 🤖 Models Recommended (OpenRouter)

| Model | Context | Notes |
|-------|---------|-------|
| `meta-llama/llama-3.3-70b-instruct` ← default | 128k | Smartest/Best |
| `meta-llama/llama-3.1-8b-instruct` | 128k | Cheaper/Faster |
| `google/gemini-2.0-flash-001` | 1M | High context |
| `mistralai/mistral-7b-instruct` | 32k | Fast |

---

## ⚠️ Notes

- The agent may take **2–4 minutes** depending on model speed and page complexity
- If the target site blocks scrapers, the agent falls back to Scaler's known design data
- Generated files are plain HTML/CSS/JS — open `index.html` directly in any browser
