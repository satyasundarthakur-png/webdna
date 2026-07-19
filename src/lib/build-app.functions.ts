import { createServerFn } from "@tanstack/react-start";
import JSZip from "jszip";
import { bytesToBase64, fetchWithTimeout } from "@/lib/http";

type BuildInput = { prompt: string };

// Full-app code generation genuinely takes longer than a typical API call —
// give Gemini real room to finish instead of aborting mid-generation.
const GEMINI_TIMEOUT_MS = 240_000; // 4 minutes
const MAX_FILES = 80;
const MAX_FILE_BYTES = 300 * 1024;
// Gemini's max output for 2.5 Flash; give generation the full budget so
// full-app code doesn't get cut off mid-file.
const MAX_OUTPUT_TOKENS = 65_536;

function slugify(text: string) {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "app";
}

type GeneratedFile = { path: string; content: string };
type GeneratedApp = {
  projectName: string;
  stack: string;
  description: string;
  setup: string[];
  files: GeneratedFile[];
};

// Plain-text, delimiter-based output protocol (instead of JSON mode).
// JSON-escaping full source files makes models write shorter, lazier,
// more placeholder-y code — asking for raw text between markers lets
// Gemini write real, natural code with no escaping tax.
const FILE_START = /^@@FILE:\s*(.+?)\s*$/;
const FILE_END = /^@@ENDFILE\s*$/;
const META_START = /^@@META\s*$/;
const META_END = /^@@ENDMETA\s*$/;

function parseGeneratedApp(text: string): GeneratedApp {
  const lines = text.split("\n");

  let projectName = "";
  let stack = "";
  let description = "";
  const setup: string[] = [];
  const files: GeneratedFile[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (META_START.test(line)) {
      i += 1;
      while (i < lines.length && !META_END.test(lines[i])) {
        const m = lines[i].match(/^(\w+):\s*(.*)$/);
        if (m) {
          const [, key, value] = m;
          if (key === "projectName") projectName = value.trim();
          else if (key === "stack") stack = value.trim();
          else if (key === "description") description = value.trim();
          else if (key === "setup") setup.push(value.trim());
        }
        i += 1;
      }
      i += 1; // skip @@ENDMETA
      continue;
    }

    const fileMatch = line.match(FILE_START);
    if (fileMatch) {
      const path = fileMatch[1];
      i += 1;
      const contentLines: string[] = [];
      while (i < lines.length && !FILE_END.test(lines[i])) {
        contentLines.push(lines[i]);
        i += 1;
      }
      i += 1; // skip @@ENDFILE
      files.push({ path, content: contentLines.join("\n") });
      continue;
    }

    i += 1;
  }

  return { projectName, stack, description, setup, files };
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
          temperature: 0.4,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
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
    throw new Error(
      `Gemini returned an empty response${finishReason ? ` (finishReason: ${finishReason})` : ""}`,
    );
  }
  return { text, finishReason };
}

function systemInstructionFor(fileCap: number) {
  return `You are a senior full-stack engineer. Given a plain-language app request, design and write a complete, WORKING full-stack web application. Write real, functional code — no TODOs, no "implement this later" placeholders, no stub functions. Every feature the user asked for must actually be implemented.

Stack defaults: React + Vite + TypeScript frontend, small Node/Express (or equivalent lightweight) backend, unless the request clearly implies something else. Use in-memory or file-based storage if no database is specified, and note that clearly in the README. Read any AI/API keys from environment variables and degrade gracefully if missing — never hard-require a paid key.

Keep the file count under ${fileCap}. Favor fewer, complete files over many tiny stub files — but never sacrifice correctness or completeness to save space. Include package.json with correct dependencies and scripts, needed config files, and a README with setup + run instructions.

Output format — this is critical, follow it exactly:

Start with a metadata block:

@@META
projectName: kebab-case-name
stack: short description, e.g. React + Vite + Express
description: 1-2 sentence summary of what the app does
setup: step 1 (e.g. npm install)
setup: step 2 (e.g. npm run dev)
@@ENDMETA

Then one block per file, in this exact form, with the complete literal file contents between the markers (no escaping, no markdown code fences, no extra commentary):

@@FILE: relative/path/to/file.ext
<the full raw file contents go here, verbatim>
@@ENDFILE

Repeat the @@FILE / @@ENDFILE block for every file. Output nothing before @@META and nothing after the final @@ENDFILE — no prose, no explanations, no markdown fences anywhere.`;
}

async function callGeminiBuild(apiKey: string, prompt: string): Promise<GeneratedApp> {
  async function attempt(fileCap: number, extraNote?: string) {
    const systemInstruction = systemInstructionFor(fileCap);
    const userPrompt = extraNote
      ? `Build this app: ${prompt}\n\n${extraNote}`
      : `Build this app: ${prompt}`;
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

  let parsed = parseGeneratedApp(result.text);

  // If Gemini ran out of output budget mid-generation, or the protocol
  // didn't parse into any files, retry once with a deliberately smaller scope
  // instead of failing outright.
  if (result.finishReason === "MAX_TOKENS" || parsed.files.length === 0) {
    result = await attempt(
      10,
      "Your previous attempt was too large, got cut off, or didn't follow the output format. This time: produce a much smaller MVP (fewer files, terser but still complete and working code), and follow the @@META / @@FILE / @@ENDFILE format exactly with no deviation.",
    );
    parsed = parseGeneratedApp(result.text);
  }

  if (parsed.files.length === 0) {
    const reasonNote = result.finishReason === "MAX_TOKENS" ? " (response was truncated)" : "";
    throw new Error(
      `Gemini didn't return any usable files${reasonNote} — try a shorter/simpler app description and build again.`,
    );
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
      if (!f.path || typeof f.content !== "string" || !f.content.trim()) continue;
      const cleanPath = f.path.replace(/^\/+/, "").replace(/\.\.+/g, ".");
      const bytes = new TextEncoder().encode(f.content);
      if (bytes.byteLength > MAX_FILE_BYTES) continue;
      zip.file(cleanPath, f.content);
      fileCount += 1;
      totalBytes += bytes.byteLength;
    }

    if (fileCount === 0) {
      throw new Error("Gemini's files were empty after filtering — try building again.");
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
    const zipBase64 = bytesToBase64(zipBuf);

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
