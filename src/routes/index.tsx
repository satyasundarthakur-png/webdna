import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { cloneSite } from "@/lib/clone-site.functions";
import { buildApp } from "@/lib/build-app.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Site Cloner — mirror any site or build a new app with Gemini" },
      {
        name: "description",
        content:
          "Paste a URL to mirror a site, or describe an app and let Gemini write the full-stack code — either way, get a downloadable ZIP.",
      },
      { property: "og:title", content: "Site Cloner" },
      {
        property: "og:description",
        content: "Mirror any public site, or build a new full-stack app with Gemini, as a downloadable ZIP.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type LogLine = { text: string; kind?: "info" | "done" | "error" };
type Mode = "clone" | "build";
type StepStatus = "pending" | "active" | "done" | "error";
type Step = { label: string; target: number };

const CLONE_STEPS: Step[] = [
  { label: "Fetching page HTML", target: 20 },
  { label: "Discovering assets (CSS/JS/images)", target: 45 },
  { label: "Downloading same-origin assets", target: 70 },
  { label: "Generating Gemini design summary", target: 88 },
  { label: "Packaging ZIP", target: 100 },
];

const BUILD_STEPS: Step[] = [
  { label: "Sending spec to Gemini", target: 15 },
  { label: "Gemini designing architecture", target: 40 },
  { label: "Gemini writing source files", target: 75 },
  { label: "Writing README & setup steps", target: 90 },
  { label: "Packaging ZIP", target: 100 },
];

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
  const build = useServerFn(buildApp);

  const [mode, setMode] = useState<Mode>("clone");

  const [url, setUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);

  const [progress, setProgress] = useState(0);
  const [stepIndex, setStepIndex] = useState(-1);
  const [failed, setFailed] = useState(false);
  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const [cloneResult, setCloneResult] = useState<{
    zipBase64: string;
    siteName: string;
    summary: string | null;
  } | null>(null);

  const [buildResult, setBuildResult] = useState<{
    zipBase64: string;
    projectName: string;
    stack: string;
    description: string;
    setup: string[];
    fileCount: number;
  } | null>(null);

  const steps = mode === "clone" ? CLONE_STEPS : BUILD_STEPS;

  useEffect(() => {
    return () => {
      if (progressTimer.current) clearInterval(progressTimer.current);
    };
  }, []);

  const pushLog = (text: string, kind: LogLine["kind"] = "info") =>
    setLogs((prev) => [...prev, { text, kind }]);

  function switchMode(next: Mode) {
    if (loading) return;
    setMode(next);
    setLogs([]);
    setCloneResult(null);
    setBuildResult(null);
    setProgress(0);
    setStepIndex(-1);
    setFailed(false);
  }

  function startProgress(forMode: Mode) {
    const list = forMode === "clone" ? CLONE_STEPS : BUILD_STEPS;
    setFailed(false);
    setProgress(0);
    setStepIndex(0);
    if (progressTimer.current) clearInterval(progressTimer.current);

    let currentStep = 0;
    let current = 0;
    progressTimer.current = setInterval(() => {
      const cap = list[currentStep].target;
      // ease toward the cap for the current step, then advance to the next step
      const remaining = cap - current;
      const step = Math.max(0.4, remaining * 0.12);
      current = Math.min(cap - 0.5, current + step);
      setProgress(Math.round(current));

      if (cap - current < 1 && currentStep < list.length - 1) {
        currentStep += 1;
        setStepIndex(currentStep);
      }
    }, 220);
  }

  function finishProgress(ok: boolean) {
    if (progressTimer.current) clearInterval(progressTimer.current);
    if (ok) {
      setStepIndex(steps.length - 1);
      setProgress(100);
    } else {
      setFailed(true);
    }
  }

  async function handleClone() {
    if (!isValidUrl(url)) {
      setLogs([{ text: "Enter a valid http(s) URL first.", kind: "error" }]);
      return;
    }
    setLoading(true);
    setCloneResult(null);
    setLogs([{ text: `Fetching ${url}…` }]);
    startProgress("clone");
    try {
      const data = await clone({ data: { url } });
      pushLog(`Downloaded ${data.fileCount} files (${data.totalSizeKB} KB).`);
      if (data.geminiSummary) pushLog("Gemini 2.5 Flash Lite design summary generated.");
      else if (data.geminiError) pushLog(`Gemini summary skipped: ${data.geminiError}`, "error");
      else if (!data.geminiConfigured)
        pushLog("Gemini key not configured — skipping design summary.", "error");
      pushLog("Packaged ZIP is ready.", "done");
      setCloneResult({
        zipBase64: data.zipBase64,
        siteName: data.siteName,
        summary: data.geminiSummary,
      });
      finishProgress(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pushLog(`Failed: ${msg}`, "error");
      finishProgress(false);
    } finally {
      setLoading(false);
    }
  }

  async function handleBuild() {
    if (!prompt.trim()) {
      setLogs([{ text: "Describe the app you want built first.", kind: "error" }]);
      return;
    }
    setLoading(true);
    setBuildResult(null);
    setLogs([{ text: "Sending your spec to Gemini…" }]);
    startProgress("build");
    try {
      const data = await build({ data: { prompt } });
      pushLog(`Gemini designed "${data.projectName}" (${data.stack}).`);
      pushLog(`Wrote ${data.fileCount} files (${data.totalSizeKB} KB).`);
      pushLog("Packaged ZIP is ready.", "done");
      setBuildResult({
        zipBase64: data.zipBase64,
        projectName: data.projectName,
        stack: data.stack,
        description: data.description,
        setup: data.setup,
        fileCount: data.fileCount,
      });
      finishProgress(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pushLog(`Failed: ${msg}`, "error");
      finishProgress(false);
    } finally {
      setLoading(false);
    }
  }

  function downloadZip(zipBase64: string, name: string) {
    const binary = atob(zipBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: "application/zip" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${name}.zip`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  const showProgress = loading || progress > 0;

  return (
    <div className="min-h-screen text-foreground flex flex-col">
      <main className="mx-auto w-full max-w-6xl px-6 py-20 flex-1">
        <div className="flex flex-col lg:flex-row gap-6 items-start">
          <div className="rainbow-border-wrap rainbow-card flex-1 min-w-0">
            <div className="rounded-[calc(1rem-3px)] bg-background/95 backdrop-blur-xl px-6 py-10 sm:px-10 sm:py-12">
              <div className="mb-10">
                <div className="rainbow-float inline-flex items-center gap-2 rounded-full border border-border bg-muted/50 px-3 py-1 text-xs text-muted-foreground mb-6 shadow-sm">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Powered by Gemini
                </div>
                <h1 className="rainbow-text text-4xl sm:text-5xl font-extrabold tracking-tight">
                  Site Cloner
                </h1>
                <p className="mt-4 text-muted-foreground max-w-xl">
                  Mirror any public site, or describe a full-stack app and let Gemini write the
                  code. Either way, you get a downloadable ZIP.
                </p>
              </div>

              <div className="mb-6 inline-flex rounded-lg border border-border bg-muted/40 p-1 text-sm">
                <button
                  onClick={() => switchMode("clone")}
                  disabled={loading}
                  className={`rounded-md px-4 py-2 font-medium transition disabled:cursor-not-allowed ${
                    mode === "clone" ? "rainbow-btn text-white" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Clone a site
                </button>
                <button
                  onClick={() => switchMode("build")}
                  disabled={loading}
                  className={`rounded-md px-4 py-2 font-medium transition disabled:cursor-not-allowed ${
                    mode === "build" ? "rainbow-btn text-white" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Build with Gemini
                </button>
              </div>

              {mode === "clone" ? (
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
              ) : (
                <div className="flex flex-col gap-2">
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="e.g. A React + Express task tracker with login, boards, and drag-and-drop cards stored in a local JSON file."
                    rows={4}
                    className="flex-1 resize-y rounded-md border border-input bg-card px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-ring transition"
                  />
                  <button
                    onClick={handleBuild}
                    disabled={loading}
                    className="rainbow-btn self-end rounded-md text-white px-5 py-3 text-sm font-semibold disabled:opacity-50"
                  >
                    {loading ? "Building…" : "Build app"}
                  </button>
                </div>
              )}

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

              {mode === "clone" && cloneResult && (
                <div className="mt-6 space-y-4">
                  <button
                    onClick={() => downloadZip(cloneResult.zipBase64, cloneResult.siteName)}
                    className="rainbow-btn w-full rounded-md text-white px-5 py-3 text-sm font-semibold"
                  >
                    🎉 Download {cloneResult.siteName}.zip
                  </button>

                  {cloneResult.summary && (
                    <details className="rounded-md border border-border bg-card p-4 text-sm">
                      <summary className="cursor-pointer font-medium">
                        View design summary (DESIGN_SUMMARY.md)
                      </summary>
                      <pre className="mt-4 whitespace-pre-wrap text-xs text-muted-foreground">
                        {cloneResult.summary}
                      </pre>
                    </details>
                  )}
                </div>
              )}

              {mode === "build" && buildResult && (
                <div className="mt-6 space-y-4">
                  <button
                    onClick={() => downloadZip(buildResult.zipBase64, buildResult.projectName)}
                    className="rainbow-btn w-full rounded-md text-white px-5 py-3 text-sm font-semibold"
                  >
                    🎉 Download {buildResult.projectName}.zip
                  </button>

                  <div className="rounded-md border border-border bg-card p-4 text-sm space-y-2">
                    <div>
                      <span className="font-medium">Stack:</span>{" "}
                      <span className="text-muted-foreground">{buildResult.stack}</span>
                    </div>
                    {buildResult.description && (
                      <p className="text-muted-foreground">{buildResult.description}</p>
                    )}
                    {buildResult.setup.length > 0 && (
                      <div>
                        <p className="font-medium mb-1">Setup</p>
                        <ol className="list-decimal list-inside text-muted-foreground space-y-0.5 font-mono text-xs">
                          {buildResult.setup.map((step, i) => (
                            <li key={i}>{step}</li>
                          ))}
                        </ol>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">{buildResult.fileCount} files generated.</p>
                  </div>
                </div>
              )}

              <p className="mt-12 text-xs text-muted-foreground leading-relaxed">
                {mode === "clone"
                  ? "Mirrors the presentation layer only (HTML/CSS/JS/images) of publicly reachable pages. Same-origin assets only. Backend logic, auth, and paid/proprietary code are not copied. Use on sites you have the right to copy."
                  : "Code is generated by Gemini from your description as a working starting point — review it before running or deploying, and treat any generated secrets/config as placeholders to replace."}
              </p>
            </div>
          </div>

          {showProgress && (
            <aside className="w-full lg:w-80 shrink-0 lg:sticky lg:top-10">
              <div className="rainbow-border-wrap rainbow-card">
                <div className="rounded-[calc(1rem-3px)] bg-background/95 backdrop-blur-xl px-5 py-6">
                  <div className="flex items-baseline justify-between mb-1">
                    <h2 className="text-sm font-semibold">
                      {mode === "clone" ? "Cloning progress" : "Build progress"}
                    </h2>
                    <span
                      className={`rainbow-text text-2xl font-extrabold tabular-nums ${
                        failed ? "!text-destructive [-webkit-text-fill-color:unset] [background:none]" : ""
                      }`}
                    >
                      {failed ? "!" : `${progress}%`}
                    </span>
                  </div>

                  <div className="h-2.5 w-full rounded-full bg-muted overflow-hidden mb-5">
                    <div
                      className={`h-full rounded-full transition-all duration-200 ease-out ${
                        failed ? "bg-destructive" : "rainbow-btn"
                      }`}
                      style={{ width: `${failed ? 100 : progress}%` }}
                    />
                  </div>

                  <ul className="space-y-3">
                    {steps.map((s, i) => {
                      const status: StepStatus = failed && i === stepIndex
                        ? "error"
                        : i < stepIndex || (i === stepIndex && progress >= s.target && !loading)
                          ? "done"
                          : i === stepIndex
                            ? "active"
                            : "pending";
                      return (
                        <li key={s.label} className="flex items-center gap-3 text-xs">
                          <span
                            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${
                              status === "done"
                                ? "bg-emerald-500 border-emerald-500 text-white"
                                : status === "active"
                                  ? "border-transparent rainbow-btn text-white animate-pulse"
                                  : status === "error"
                                    ? "bg-destructive border-destructive text-white"
                                    : "border-border text-muted-foreground"
                            }`}
                          >
                            {status === "done" ? "✓" : status === "error" ? "✕" : i + 1}
                          </span>
                          <span
                            className={
                              status === "pending"
                                ? "text-muted-foreground"
                                : status === "error"
                                  ? "text-destructive font-medium"
                                  : "text-foreground font-medium"
                            }
                          >
                            {s.label}
                          </span>
                        </li>
                      );
                    })}
                  </ul>

                  <p className="mt-5 text-[11px] text-muted-foreground leading-relaxed">
                    {mode === "clone"
                      ? "Non-AI steps (fetch/download/package) plus an AI step for the Gemini design summary."
                      : "One AI step does the heavy lifting: Gemini plans and writes every file, then it's zipped up."}
                  </p>
                </div>
              </div>
            </aside>
          )}
        </div>
      </main>
    </div>
  );
}
