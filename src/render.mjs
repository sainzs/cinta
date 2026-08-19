/**
 * Cinta core: turn a terminal script into an animated GIF.
 *
 * Harness-agnostic — the pi extension wraps this, but it can be driven from
 * any Node host (including an OpenCode plugin later). Requires Chrome (found
 * automatically or via chromePath) and ffmpeg on PATH.
 */
import { spawn } from "node:child_process";
import { accessSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

export const DEFAULTS = {
  fps: 12,
  scale: 880,
  width: 1008,
  height: 640,
  font: '"Berkeley Mono Variable", "Berkeley Mono", ui-monospace, Menlo, monospace',
  colors: {
    bg: "#000000",
    panel: "#070707",
    ink: "#eeeeee",
    dim: "#8a8a93",
    faint: "#55555e",
    accent: "#00ffb2",
    border: "#16181a",
    bar: "#101013",
  },
  timing: { typeMs: 34, lineMs: 90, afterCmdMs: 260, endHoldMs: 1600 },
};

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.CHROMIUM_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      accessSync(c);
      return c;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

function buildHtml(script, opts) {
  const c = { ...DEFAULTS.colors, ...(opts.colors ?? {}) };
  const t = { ...DEFAULTS.timing, ...(opts.timing ?? {}) };
  const font = opts.font ?? DEFAULTS.font;
  const subHtml = (opts.sub ?? []).join("<br />");
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;padding:0;background:${c.bg}}
body{font-family:${font};color:${c.ink};padding:48px 56px;-webkit-font-smoothing:antialiased}
.wordmark{display:flex;align-items:baseline;gap:14px;margin-bottom:8px}
.wordmark .name{font-size:28px;font-weight:700;letter-spacing:-.5px}
.wordmark .tag{color:${c.accent};font-size:13px;font-weight:600}
.sub{color:${c.dim};font-size:14px;margin-bottom:28px;line-height:1.5}
.sub b{color:${c.ink};font-weight:600}
.term{background:${c.panel};border:1px solid ${c.border};border-radius:12px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.6);width:880px}
.term-bar{display:flex;align-items:center;gap:8px;padding:12px 16px;background:${c.bar};border-bottom:1px solid ${c.border}}
.dot{width:11px;height:11px;border-radius:50%}.dot.r{background:#ff5f57}.dot.y{background:#febc2e}.dot.g{background:#28c840}
.term-title{margin-left:10px;color:${c.faint};font-size:12px}
.term-body{padding:20px 22px 24px;font-size:13.5px;line-height:1.55;min-height:360px}
.p{color:${c.accent};font-weight:700}.cmd{color:${c.ink}}.out{color:${c.dim};white-space:pre-wrap}.ok{color:${c.accent}}.hl{color:${c.ink}}
.line{display:block}.cursor{display:inline-block;width:8px;height:16px;background:${c.accent};vertical-align:-2px}
.cursor.blink{animation:blink 1.1s steps(1) infinite}@keyframes blink{50%{opacity:0}}.gap{height:14px}
</style></head><body>
<div class="wordmark"><span class="name">${esc(opts.name ?? "")}</span><span class="tag">${esc(opts.tag ?? "")}</span></div>
<div class="sub">${subHtml}</div>
<div class="term"><div class="term-bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="term-title">${esc(opts.title ?? opts.name ?? "")}</span></div>
<div class="term-body" id="body"></div></div>
<script>
const body=document.getElementById("body");
const SCRIPT=${JSON.stringify(script)};
const TYPE_MS=${t.typeMs},LINE_MS=${t.lineMs},AFTER_CMD=${t.afterCmdMs},END_HOLD=${t.endHoldMs};
let cursor=null;
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const escH=(s)=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;");
function newCursor(b){const c=document.createElement("span");c.className="cursor"+(b?" blink":"");return c;}
async function typeCommand(text){const line=document.createElement("div");line.innerHTML='<span class="p">$</span> <span class="cmd"></span>';const cs=line.querySelector(".cmd");body.appendChild(line);cursor=newCursor(false);line.appendChild(cursor);for(const ch of String(text)){cs.textContent+=ch;line.appendChild(cursor);await wait(TYPE_MS);}await wait(AFTER_CMD);cursor.remove();}
async function showOut(t2,cls){const line=document.createElement("div");line.innerHTML='<span class="out '+(cls||"")+'">'+escH(t2)+"</span>";body.appendChild(line);}
async function streamLines(lines){const box=document.createElement("div");box.className="out";body.appendChild(box);for(const ln of lines){const s=document.createElement("span");s.className="line";s.textContent=ln;box.appendChild(s);await wait(LINE_MS);}}
function addGap(){const g=document.createElement("div");g.className="gap";body.appendChild(g);}
async function run(){for(const st of SCRIPT){if(st.type==="cmd")await typeCommand(st.text);else if(st.type==="out")await showOut(st.text,st.cls);else if(st.type==="stream")await streamLines(st.lines);else if(st.type==="gap")addGap();else if(st.type==="done"){const p=document.createElement("div");p.innerHTML='<span class="p">▊</span>';cursor=newCursor(true);p.appendChild(cursor);body.appendChild(p);}}await wait(END_HOLD);window.__done=true;}
run();
</script></body></html>`;
}

function estimateMs(script, timing) {
  let ms = timing.endHoldMs + 800;
  for (const st of script) {
    if (st.type === "cmd") ms += String(st.text).length * timing.typeMs + timing.afterCmdMs;
    else if (st.type === "stream") ms += st.lines.length * timing.lineMs;
    else if (st.type === "out") ms += 60;
  }
  return Math.max(2500, ms);
}

function run(cmd, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", rejectPromise);
    child.on("close", (code) =>
      code === 0 ? resolvePromise() : rejectPromise(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`)),
    );
  });
}

/**
 * Render a terminal script to an animated GIF.
 * Returns { gif, html, frames, width, height, bytes }.
 */
export async function renderGif(script, options = {}) {
  if (!Array.isArray(script) || script.length === 0) {
    throw new Error("script must be a non-empty array of steps");
  }
  const fps = options.fps ?? DEFAULTS.fps;
  const scale = options.scale ?? DEFAULTS.scale;
  const width = options.width ?? DEFAULTS.width;
  const height = options.height ?? DEFAULTS.height;
  const timing = { ...DEFAULTS.timing, ...(options.timing ?? {}) };
  const out = options.out ?? "cinta.gif";

  const chromePath = options.chromePath ?? findChrome();
  if (!chromePath) throw new Error("Chrome not found — install Chrome or pass chromePath");

  const html = buildHtml(script, { ...options, timing });
  const dir = await mkdtemp(join(tmpdir(), "cinta-"));
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    const htmlPath = join(dir, "hero.html");
    await writeFile(htmlPath, html);
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle0" });
    await page.evaluate(() => document.fonts.ready);

    const totalMs = estimateMs(script, timing);
    const frames = Math.ceil((totalMs / 1000) * fps);
    const interval = 1000 / fps;
    for (let i = 0; i < frames; i++) {
      await writeFile(join(dir, `f${String(i).padStart(4, "0")}.png`), await page.screenshot({ type: "png" }));
      await new Promise((r) => setTimeout(r, interval));
    }
    const finished = await page.evaluate(() => window.__done === true);
    if (!finished) throw new Error("animation did not complete within the recorded frame budget");

    const palette = join(dir, "palette.png");
    const vf = `fps=${fps},scale=${scale}:-1:flags=lanczos`;
    await run("ffmpeg", ["-y", "-framerate", String(fps), "-i", join(dir, "f%04d.png"), "-vf", `${vf},palettegen=max_colors=128:stats_mode=diff`, palette]);
    await run("ffmpeg", ["-y", "-framerate", String(fps), "-i", join(dir, "f%04d.png"), "-i", palette, "-lavfi", `${vf} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4`, out]);

    const htmlOut = join(dirname(out), `${basename(out).replace(/\.gif$/i, "")}.html`);
    await writeFile(htmlOut, html);
    const s = await stat(out);
    return { gif: out, html: htmlOut, frames, width: scale, height: Math.round((scale * height) / width), bytes: s.size };
  } finally {
    await browser.close().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
