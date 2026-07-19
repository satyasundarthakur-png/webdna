import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { cloneSite } from "@/lib/clone-site.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Site Cloner — mirror any site to a downloadable ZIP" },
      {
        name: "description",
        content:
          "Paste a URL, get a ZIP of the site: HTML, CSS, JS, images, plus a Gemini-generated design summary.",
      },
      { property: "og:title", content: "Site Cloner" },
      {
        property: "og:description",
        content: "Mirror any public site into a downloadable codebase, with an AI design summary.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type LogLine = { text: string; kind?: "info" | "done" | "error" };

function isValidUrl(value: string) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function Index() {
  const clone = useServerFn(cloneSite);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [result, setResult] = useState<{
    zipBase64: string;
    siteName: string;
    summary: string | null;
  } | null>(null);

  const pushLog = (text: string, kind: LogLine["kind"] = "info") =>
    setLogs((prev) => [...prev, { text, kind }]);

  async function handleClone() {
    if (!isValidUrl(url)) {
      setLogs([{ text: "Enter a valid http(s) URL first.", kind: "error" }]);
      return;
    }
    setLoading(true);
    setResult(null);
    setLogs([{ text: `Fetching ${url}…` }]);
    try {
      const data = await clone({ data: { url } });
      pushLog(`Downloaded ${data.fileCount} files (${data.totalSizeKB} KB).`);
      if (data.geminiSummary) pushLog("Gemini 2.5 Flash Lite design summary generated.");
      else if (data.geminiError) pushLog(`Gemini summary skipped: ${data.geminiError}`, "error");
      else if (!data.geminiConfigured)
        pushLog("Gemini key not configured — skipping design summary.", "error");
      pushLog("Packaged ZIP is ready.", "done");
      setResult({
        zipBase64: data.zipBase64,
        siteName: data.siteName,
        summary: data.geminiSummary,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pushLog(`Failed: ${msg}`, "error");
    } finally {
      setLoading(false);
    }
  }

  function downloadZip() {
    if (!result) return;
    const binary = atob(result.zipBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: "application/zip" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${result.siteName}.zip`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <div className="min-h-screen text-foreground flex flex-col">
      <main className="mx-auto w-full max-w-3xl px-6 py-20 flex-1">
        <div className="rainbow-border-wrap rainbow-card">
          <div className="rounded-[calc(1rem-3px)] bg-background/95 backdrop-blur-xl px-6 py-10 sm:px-10 sm:py-12">
            <div className="mb-10">
              <div className="rainbow-float inline-flex items-center gap-2 rounded-full border border-border bg-muted/50 px-3 py-1 text-xs text-muted-foreground mb-6 shadow-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Powered by Gemini 2.5 Flash Lite
              </div>
              <h1 className="rainbow-text text-4xl sm:text-5xl font-extrabold tracking-tight">
                Site Cloner
              </h1>
              <p className="mt-4 text-muted-foreground max-w-xl">
                Paste any public URL. Get back a downloadable ZIP of the site — HTML, CSS, JS, and
                images mirrored, plus an AI-generated design summary.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
                className="flex-1 rounded-md border border-input bg-card px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-ring transition"
                onKeyDown={(e) => e.key === "Enter" && !loading && handleClone()}
              />
              <button
                onClick={handleClone}
                disabled={loading}
                className="rainbow-btn rounded-md text-white px-5 py-3 text-sm font-semibold disabled:opacity-50"
              >
                {loading ? "Cloning…" : "Clone site"}
              </button>
            </div>

            {logs.length > 0 && (
              <div className="mt-8 rounded-md border border-border bg-card p-4 font-mono text-xs space-y-1 animate-in fade-in slide-in-from-top-2">
                {logs.map((l, i) => (
                  <div
                    key={i}
                    className={
                      l.kind === "error"
                        ? "text-destructive"
                        : l.kind === "done"
                          ? "text-emerald-500 font-semibold"
                          : "text-muted-foreground"
                    }
                  >
                    › {l.text}
                  </div>
                ))}
              </div>
            )}

            {result && (
              <div className="mt-6 space-y-4">
                <button
                  onClick={downloadZip}
                  className="rainbow-btn w-full rounded-md text-white px-5 py-3 text-sm font-semibold"
                >
                  🎉 Download {result.siteName}.zip
                </button>

                {result.summary && (
                  <details className="rounded-md border border-border bg-card p-4 text-sm">
                    <summary className="cursor-pointer font-medium">
                      View design summary (DESIGN_SUMMARY.md)
                    </summary>
                    <pre className="mt-4 whitespace-pre-wrap text-xs text-muted-foreground">
                      {result.summary}
                    </pre>
                  </details>
                )}
              </div>
            )}

            <p className="mt-12 text-xs text-muted-foreground leading-relaxed">
              Mirrors the presentation layer only (HTML/CSS/JS/images) of publicly reachable pages.
              Same-origin assets only, capped at 60 files and 4 MB each. Backend logic, auth, and
              paid/proprietary code are not copied. Use on sites you have the right to copy.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
