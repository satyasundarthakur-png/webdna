import { createServerFn } from "@tanstack/react-start";
import JSZip from "jszip";

type BuildInput = { prompt: string };

// Full-app code generation genuinely takes longer than a typical API call —
// give Gemini real room to finish instead of aborting mid-generation.
const GEMINI_TIMEOUT_MS = 240_000; // 4 minutes
const MAX_FILES = 80;
const MAX_FILE_BYTES = 300 * 1024;
// Gemini's max output for 2.5 Flash; give generation the full budget so
// full-app code doesn't get cut off mid-file.
const MAX_OUTPUT_TOKENS = 65_536;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    projectName: { type: "STRING" },
    stack: { type: "STRING" },
    description: { type: "STRING" },
    setup: { type: "ARRAY", items: { type: "STRING" } },
    files: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          path: { type: "STRING" },
          content: { type: "STRING" },
        },
        required: ["path", "content"],
      },
    },
  },
  required: ["projectName", "stack", "description", "files"],
};

function slugify(text: string) {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "app";
}

async function fetchWithTimeout(url: string, init: RequestInit | undefined, timeoutMs: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

type GeneratedFile = { path: string; content: string };
type GeneratedApp = {
  projectName: string;
  stack: string;
  description: string;
  setup: string[];
  files: GeneratedFile[];
};

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Gemini response did not contain valid JSON");
  }
  return candidate.slice(start, end + 1);
}

async function callGeminiOnce(apiKey: string, prompt: string, systemInstruction: string) {
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { role: "system", parts: [{ text: systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: `Build this app: ${prompt}` }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    },
    GEMINI_TIMEOUT_MS,
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  };
  const candidate = json.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const finishReason = candidate?.finishReason;
  if (!text) {
    throw new Error(`Gemini returned an empty response${finishReason ? ` (finishReason: ${finishReason})` : ""}`);
  }
  return { text, finishReason };
}

function systemInstructionFor(fileCap: number) {
  return `You are a senior full-stack engineer. Given a plain-language app request, design and write a complete, working, minimal-but-functional full-stack web application.

Rules:
- Prefer a React + Vite + TypeScript frontend and a small Node/Express (or equivalent lightweight) backend, unless the request clearly implies something else.
- Include package.json (with correct dependencies/scripts), config files, and a README with setup + run instructions.
- Keep it runnable locally with "npm install" then the documented start command. Use in-memory or file-based storage if no database is specified, and clearly note that in the README.
- Do not invent external paid API keys as hard requirements; if an AI/API key is used, read it from an environment variable and degrade gracefully if missing.
- Keep the file count under ${fileCap} and each file concise, with no comments and minimal whitespace — this is a working starter/MVP, not an enterprise monorepo. Favor fewer, denser files over many tiny ones so generation finishes reliably and is never cut off.
- Return ONLY JSON matching the provided response schema. Every file's "content" must be the complete literal file contents, not a placeholder or diff.`;
}

async function callGeminiBuild(apiKey: string, prompt: string): Promise<GeneratedApp> {
  async function attempt(fileCap: number, extraNote?: string) {
    const systemInstruction = systemInstructionFor(fileCap);
    const userPrompt = extraNote ? `Build this app: ${prompt}\n\n${extraNote}` : `Build this app: ${prompt}`;
    return callGeminiOnce(apiKey, userPrompt, systemInstruction);
  }

  let result: { text: string; finishReason?: string };
  try {
    result = await attempt(25);
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    const isTransient =
      isAbort || (err instanceof Error && /Gemini (429|500|502|503|504)/.test(err.message));
    if (!isTransient) throw err;
    // one retry — codegen calls occasionally time out or hit a transient 5xx
    result = await attempt(25);
  }

  // If Gemini ran out of output budget mid-generation, retry once with a
  // deliberately smaller scope instead of failing outright.
  if (result.finishReason === "MAX_TOKENS") {
    result = await attempt(
      10,
      "Your previous attempt was too large and got cut off. This time, produce a much smaller MVP: fewer files, terser code, no comments, and skip anything non-essential to the core feature.",
    );
  }

  let parsed: GeneratedApp;
  try {
    parsed = JSON.parse(extractJson(result.text)) as GeneratedApp;
  } catch {
    const reasonNote = result.finishReason === "MAX_TOKENS" ? " (response was truncated)" : "";
    throw new Error(
      `Gemini's response got cut off or wasn't valid JSON${reasonNote} — try a shorter/simpler app description and build again.`,
    );
  }
  if (!parsed.files || !Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error("Gemini response had no files");
  }
  return parsed;
}

export const buildApp = createServerFn({ method: "POST" })
  .inputValidator((input: BuildInput) => {
    if (!input || typeof input.prompt !== "string" || !input.prompt.trim()) {
      throw new Error("Describe the app you want to build");
    }
    if (input.prompt.length > 4000) throw new Error("Prompt is too long (max 4000 characters)");
    return { prompt: input.prompt.trim() };
  })
  .handler(async ({ data }) => {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      throw new Error("GEMINI_API_KEY is not configured on the server");
    }

    const app = await callGeminiBuild(geminiKey, data.prompt);

    const zip = new JSZip();
    let fileCount = 0;
    let totalBytes = 0;

    for (const f of app.files) {
      if (fileCount >= MAX_FILES) break;
      if (!f.path || typeof f.content !== "string") continue;
      const cleanPath = f.path.replace(/^\/+/, "").replace(/\.\.+/g, ".");
      const bytes = new TextEncoder().encode(f.content);
      if (bytes.byteLength > MAX_FILE_BYTES) continue;
      zip.file(cleanPath, f.content);
      fileCount += 1;
      totalBytes += bytes.byteLength;
    }

    const readme = `# ${app.projectName || "Generated App"}

${app.description || ""}

**Stack:** ${app.stack || "Not specified"}

## Setup

${(app.setup && app.setup.length ? app.setup : ["npm install", "npm run dev"])
  .map((s, i) => `${i + 1}. ${s}`)
  .join("\n")}

---
Generated by Site Cloner's "Build with Gemini" mode from this prompt:

> ${data.prompt}

Review the generated code before deploying — it's an AI-generated starting point, not production-audited code.
`;
    zip.file("README.md", readme);

    const zipBuf = await zip.generateAsync({ type: "uint8array" });
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < zipBuf.length; i += chunk) {
      binary += String.fromCharCode(...zipBuf.subarray(i, i + chunk));
    }
    const zipBase64 = btoa(binary);

    return {
      projectName: slugify(app.projectName || "generated-app"),
      stack: app.stack || "",
      description: app.description || "",
      setup: app.setup || [],
      fileCount,
      totalSizeKB: Math.round(totalBytes / 1024),
      zipBase64,
    };
  });
