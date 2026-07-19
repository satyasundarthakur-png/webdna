import { createServerFn } from "@tanstack/react-start";
import JSZip from "jszip";

type CloneInput = { url: string };

const MAX_ASSETS = 60;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

function safeSlug(u: URL) {
  return u.hostname.replace(/[^a-z0-9.-]/gi, "_") || "clone";
}

function absoluteUrl(base: URL, ref: string): URL | null {
  try {
    return new URL(ref, base);
  } catch {
    return null;
  }
}

function extFromUrl(u: URL, fallback: string) {
  const m = u.pathname.match(/\.([a-z0-9]{1,6})(?:$)/i);
  return m ? m[1].toLowerCase() : fallback;
}

function pathFromUrl(u: URL, fallback: string) {
  const clean = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!clean) return `asset-${Math.random().toString(36).slice(2, 8)}.${fallback}`;
  return clean;
}

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; SiteClonerBot/1.0; +https://lovable.dev)",
        accept: "*/*",
        ...(init?.headers || {}),
      },
      redirect: "follow",
    });
  } finally {
    clearTimeout(t);
  }
}

// Extract asset refs from HTML: link rel=stylesheet, script src, img src, favicon.
function extractAssetRefs(html: string): { attr: string; value: string; full: string }[] {
  const refs: { attr: string; value: string; full: string }[] = [];
  const patterns: RegExp[] = [
    /<link[^>]+rel=["']?(?:stylesheet|icon|shortcut icon)["']?[^>]*href=["']([^"']+)["'][^>]*>/gi,
    /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']?(?:stylesheet|icon|shortcut icon)["']?[^>]*>/gi,
    /<script[^>]+src=["']([^"']+)["'][^>]*>/gi,
    /<img[^>]+src=["']([^"']+)["'][^>]*>/gi,
    /<source[^>]+src=["']([^"']+)["'][^>]*>/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      refs.push({ attr: "src/href", value: m[1], full: m[0] });
    }
  }
  return refs;
}

function extractCssUrls(css: string): string[] {
  const urls: string[] = [];
  const re = /url\((?!['"]?data:)['"]?([^'")]+)['"]?\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) urls.push(m[1]);
  return urls;
}

async function callGeminiSummary(apiKey: string, html: string, css: string) {
  const prompt = `You are a senior web designer. Analyze this cloned website and produce a concise DESIGN_SUMMARY.md covering:

- Brand feel (adjectives, mood)
- Color palette (hex values you observed)
- Typography (font families, sizes, weights)
- Layout patterns (grid, sections, spacing)
- Components (buttons, cards, nav, forms)
- Any notable interactions or animations

Return valid Markdown only.

---- HTML (truncated) ----
${html.slice(0, 30_000)}

---- CSS (truncated) ----
${css.slice(0, 20_000)}
`;

  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
}

export const cloneSite = createServerFn({ method: "POST" })
  .inputValidator((input: CloneInput) => {
    if (!input || typeof input.url !== "string") throw new Error("Missing url");
    const u = new URL(input.url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error("Only http(s) URLs are allowed");
    }
    return { url: u.toString() };
  })
  .handler(async ({ data }) => {
    const geminiKey = process.env.GEMINI_API_KEY;
    const pageUrl = new URL(data.url);

    const pageRes = await fetchWithTimeout(pageUrl.toString());
    if (!pageRes.ok) throw new Error(`Failed to fetch page: ${pageRes.status}`);
    let html = await pageRes.text();

    const refs = extractAssetRefs(html);
    const seen = new Map<string, string>(); // absolute url -> local path
    const zip = new JSZip();
    const cssTexts: string[] = [];

    let assetCount = 0;
    let totalBytes = 0;

    async function fetchAsset(absUrl: URL): Promise<string | null> {
      if (assetCount >= MAX_ASSETS) return null;
      const key = absUrl.toString();
      if (seen.has(key)) return seen.get(key)!;

      try {
        const r = await fetchWithTimeout(key);
        if (!r.ok) return null;
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.byteLength > MAX_ASSET_BYTES) return null;

        const ct = r.headers.get("content-type") || "";
        const fallbackExt = ct.includes("css")
          ? "css"
          : ct.includes("javascript")
            ? "js"
            : ct.includes("svg")
              ? "svg"
              : ct.includes("png")
                ? "png"
                : ct.includes("jpeg") || ct.includes("jpg")
                  ? "jpg"
                  : ct.includes("webp")
                    ? "webp"
                    : ct.includes("woff2")
                      ? "woff2"
                      : ct.includes("woff")
                        ? "woff"
                        : "bin";
        const ext = extFromUrl(absUrl, fallbackExt);
        let local = `assets/${pathFromUrl(absUrl, ext)}`;
        // ensure unique filename
        if (zip.file(local)) local = `assets/${assetCount}-${pathFromUrl(absUrl, ext)}`;

        zip.file(local, buf);
        assetCount += 1;
        totalBytes += buf.byteLength;
        seen.set(key, local);

        if (ext === "css") {
          const cssText = new TextDecoder().decode(buf);
          cssTexts.push(cssText);
          // rewrite url() references inside CSS to local assets too
          let rewritten = cssText;
          const cssUrls = extractCssUrls(cssText);
          for (const rel of cssUrls) {
            const nested = absoluteUrl(absUrl, rel);
            if (!nested) continue;
            if (nested.origin !== pageUrl.origin) continue;
            const nestedLocal = await fetchAsset(nested);
            if (nestedLocal) {
              rewritten = rewritten.split(rel).join(`/${nestedLocal}`);
            }
          }
          zip.file(local, rewritten);
        }
        return local;
      } catch {
        return null;
      }
    }

    for (const ref of refs) {
      const abs = absoluteUrl(pageUrl, ref.value);
      if (!abs) continue;
      if (abs.origin !== pageUrl.origin) continue;
      const local = await fetchAsset(abs);
      if (local) {
        html = html.split(ref.value).join(`./${local}`);
      }
    }

    zip.file("index.html", html);

    let geminiSummary = "";
    let geminiError: string | null = null;
    if (geminiKey) {
      try {
        geminiSummary = await callGeminiSummary(geminiKey, html, cssTexts.join("\n\n"));
        if (geminiSummary) zip.file("DESIGN_SUMMARY.md", geminiSummary);
      } catch (e) {
        geminiError = e instanceof Error ? e.message : String(e);
      }
    }

    zip.file(
      "README.md",
      `# Cloned site: ${pageUrl.hostname}

Source: ${pageUrl.toString()}
Cloned at: ${new Date().toISOString()}
Files: ${assetCount + 1} (index.html + ${assetCount} assets)

This is a static mirror of the presentation layer (HTML/CSS/JS/images) only.
No backend logic, auth, or dynamic data is included.
`,
    );

    const zipBuf = await zip.generateAsync({ type: "uint8array" });
    // Base64 encode
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < zipBuf.length; i += chunk) {
      binary += String.fromCharCode(...zipBuf.subarray(i, i + chunk));
    }
    const zipBase64 = btoa(binary);

    return {
      siteName: safeSlug(pageUrl),
      fileCount: assetCount + 1,
      totalSizeKB: Math.round(totalBytes / 1024),
      zipBase64,
      geminiSummary: geminiSummary || null,
      geminiError,
      geminiConfigured: Boolean(geminiKey),
    };
  });
