# Getting Started

## Prerequisites

margin is a single **TanStack Start** app (editor UI + `/api/*` served by one
Node server). You run it with **Docker** (Linux), or with **Node.js** for local dev.

### Docker (recommended)

- Docker Engine with Compose v2

### Local dev (optional)

- Node.js 22 or newer

  ```bash
  node --version
  ```

  Download from [nodejs.org](https://nodejs.org) if needed.

### AI Provider (pick one)

margin needs an AI model to power its writing assistant. You have two options:

**Option A -- Local (Private, Offline)**
Run a model entirely on your machine. No internet required, no data leaves your computer.

- [Ollama](https://ollama.ai) -- runs on `http://localhost:11434`
- [LM Studio](https://lmstudio.ai) -- runs on `http://localhost:1234`
- Any OpenAI-compatible local server

**Option B -- Cloud API**
Use an online provider. Your content is sent to their servers for processing.

- [OpenAI](https://platform.openai.com/api-keys)
- [Anthropic](https://console.anthropic.com)
- [Google Gemini](https://aistudio.google.com/apikey)
- [Grok (xAI)](https://console.x.ai)
- [OpenRouter](https://openrouter.ai/keys)
- [Groq](https://console.groq.com/keys)
- Any OpenAI-compatible cloud provider

> All cloud providers require an API key. margin stores it securely in your local settings file.

::: tip You don't need to edit `.env` files -- everything is configured inside margin's settings UI.
:::

## Installation

### Step 1: Clone the repository

```bash
git clone https://github.com/prxshetty/margin.git
cd margin
```

### Step 2: Run margin

Pick one:

```bash
# Docker (single process on :3000, data in the margin-data volume)
cp .env.example .env
docker compose up --build
```

```bash
# Local dev (from the repo root, serves UI + /api on :3000)
npm install
npm run dev
```

The editor opens at `http://localhost:3000`. The first Docker boot seeds
`/data/workspaces/default` from the bundled `sample-workspace/`.

### Step 3: Configure your AI provider

1. Open margin in your browser.
2. Click the **gear icon** to open Settings.
3. Go to **Endpoints** tab.
4. Choose your AI provider:
   - Click **Add New Endpoint**, give it a name (e.g., "Ollama"), enter the URL, and click **Save Endpoint** (or **Import from .env** if you already configured one in your `.env` file).
5. Click **Test Connection** to verify everything works.
6. Pick your endpoint as active from the assistant panel's harness menu (**Endpoint** flyout).

### Step 4: Start writing

The default workspace (`sample-workspace`) is loaded automatically. It includes sample characters, a chapter, and style presets so you can start experimenting right away.

You can link your own workspace folder from **Settings > Workspaces** (or the workspace switcher in the file sidebar header).

## Next Steps

- Learn about [workspaces and settings](./configuration/general.md)
- Understand [AI assist modes and the writing guide](./writing-guide.md)
- Create your own [character profiles and style guides](./writing-guide.md#character-profiles)
