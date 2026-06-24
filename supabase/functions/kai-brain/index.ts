// KAI Brain — Build Q — Full self-modification + autonomous deployment
// KAI reads/writes/deploys his own code, triggers CI builds, fixes himself — always online
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GROQ_KEY       = Deno.env.get("GROQ_API_KEY") || "";
const HF_KEY         = Deno.env.get("HF_API_KEY") || "";
const OPENAI_KEY     = Deno.env.get("OPENAI_API_KEY") || "";
const OPENROUTER_KEY = Deno.env.get("OPENROUTER_API_KEY") || "";
const GH_TOKEN       = Deno.env.get("GITHUB_TOKEN") || Deno.env.get("KAI_GITHUB_TOKEN") || "";
const SB_PAT         = Deno.env.get("KAI_SUPABASE_TOKEN") || Deno.env.get("SUPABASE_ACCESS_TOKEN") || "";
const GH_REPO        = "luokai25/kai_app";
const SB_PROJECT     = "hpjvnohzhpkopisfaemz";

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,x-kai-key,x-chat-id,x-image-name",
};
const j   = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const jss = (s: ReadableStream)   => new Response(s, { headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
const ev  = (d: unknown)          => `data: ${JSON.stringify(d)}\n\n`;

function ok(req: Request): boolean {
  const k = req.headers.get("x-kai-key") || "";
  return k === "kai_Om34heIJMU5MIRTXaaeEiHIUzhvnPjXt" || (k.startsWith("kai_") && k.length > 8);
}

// ── DB ────────────────────────────────────────────────────────────────────────
async function ins(t: string, d: Record<string, unknown>) {
  const { data, error } = await db.from(t).insert(d).select().single();
  if (error) throw new Error(error.message);
  return data;
}
async function insQ(t: string, d: Record<string, unknown>) {
  const { error } = await db.from(t).insert(d);
  if (error) throw new Error(error.message);
}
async function upd(t: string, m: Record<string, unknown>, d: Record<string, unknown>) {
  const { error } = await db.from(t).update(d).match(m);
  if (error) throw new Error(error.message);
}
async function sel(t: string, m: Record<string, unknown>, cols = "*", lim = 100) {
  const { data, error } = await db.from(t).select(cols).match(m).limit(lim);
  if (error) throw new Error(error.message);
  return data || [];
}
async function del(t: string, m: Record<string, unknown>) {
  const { error } = await db.from(t).delete().match(m);
  if (error) throw new Error(error.message);
}

// ── LLM ───────────────────────────────────────────────────────────────────────
interface M { role: string; content: string; }

async function provider(): Promise<string> {
  try {
    const { data } = await db.from("kai_settings").select("value").eq("key", "active_provider").single();
    return data?.value || "or_openrouter_free";
  } catch { return "or_openrouter_free"; }
}

async function chat(msgs: M[], prov?: string, stream = false): Promise<Response | string> {
  const p = prov || await provider();

  if (p.startsWith("or_")) {
    const map: Record<string, string> = {
      or_openrouter_free: "openrouter/auto",
      or_qwen3_coder:     "qwen/qwen3-coder:free",
      or_nemotron550b:    "nvidia/llama-3.1-nemotron-ultra-253b-v1:free",
      or_nemotron120b:    "nvidia/llama-3.3-nemotron-super-49b-v1:free",
      or_gptoss120b:      "openai/gpt-4o:free",
      or_gptoss20b:       "openai/gpt-4o-mini:free",
      or_llama70b:        "meta-llama/llama-3.3-70b-instruct:free",
      or_hermes405b:      "nousresearch/hermes-3-llama-3.1-405b:free",
      or_gemma31b:        "google/gemma-3-27b-it:free",
      or_gemma26b:        "google/gemma-3n-e4b-it:free",
      or_kimi:            "moonshotai/kimi-k2:free",
      or_qwen80b:         "qwen/qwen3-235b-a22b:free",
      or_nemo30b:         "nvidia/llama-3.1-nemotron-nano-8b-v1:free",
      or_nemo12b_vl:      "nvidia/llama-3.2-nv-vision-instruct:free",
      or_llama3b:         "meta-llama/llama-3.2-3b-instruct:free",
      or_dolphin:         "cognitivecomputations/dolphin3.0-mistral-24b:free",
      or_lfm_think:       "liquid/lfm-7b:free",
      or_lfm:             "liquid/lfm-7b:free",
    };
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENROUTER_KEY || "sk-or-free"}`, "HTTP-Referer": "https://kai.app", "X-Title": "KAI" },
      body: JSON.stringify({ model: map[p] || "openrouter/auto", messages: msgs, stream }),
    });
    if (stream) return r;
    const d = await r.json();
    if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
    return d.choices?.[0]?.message?.content || "";
  }

  if (p.startsWith("github_")) {
    const map: Record<string, string> = { github_llama8b: "Meta-Llama-3.1-8B-Instruct", github_llama405b: "Meta-Llama-3.1-405B-Instruct", github_gpt4o: "gpt-4o", github_gpt4omini: "gpt-4o-mini" };
    if (!GH_TOKEN) throw new Error("No GitHub token");
    const r = await fetch("https://models.inference.ai.azure.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GH_TOKEN}` },
      body: JSON.stringify({ model: map[p] || "gpt-4o-mini", messages: msgs, stream }),
    });
    if (stream) return r;
    const d = await r.json();
    if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
    return d.choices?.[0]?.message?.content || "";
  }

  if (p === "groq") {
    if (!GROQ_KEY) throw new Error("Groq key not set");
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: msgs, stream }),
    });
    if (stream) return r;
    const d = await r.json();
    if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
    return d.choices?.[0]?.message?.content || "";
  }

  if (p === "hf" || p === "kai_builtin") {
    if (!HF_KEY) throw new Error("HuggingFace token not set");
    const r = await fetch("https://api-inference.huggingface.co/models/Qwen/Qwen2.5-7B-Instruct/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${HF_KEY}` },
      body: JSON.stringify({ model: "Qwen/Qwen2.5-7B-Instruct", messages: msgs, stream, max_tokens: 1024 }),
    });
    if (stream) return r;
    const d = await r.json();
    if (d.error) throw new Error(typeof d.error === "string" ? d.error : JSON.stringify(d.error));
    return d.choices?.[0]?.message?.content || "";
  }

  if (p.startsWith("local_")) throw new Error(`LOCAL_MODEL:${p}`);
  throw new Error(`Unknown provider: ${p}`);
}

// ── Streaming ─────────────────────────────────────────────────────────────────
async function stream(msgs: M[], chatId: string | null, prov?: string): Promise<Response> {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const e = new TextEncoder();
  (async () => {
    try {
      const up = await chat(msgs, prov, true) as Response;
      if (!up.ok) { await w.write(e.encode(ev({ type: "error", error: await up.text() }))); await w.close(); return; }
      const r = up.body!.getReader();
      const d = new TextDecoder();
      let buf = "", acc = "";
      while (true) {
        const { done, value } = await r.read(); if (done) break;
        buf += d.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() || "";
        for (const line of lines) {
          const l = line.replace(/^data:\s*/, "").trim(); if (!l || l === "[DONE]") continue;
          try { const c = JSON.parse(l); const t = c.choices?.[0]?.delta?.content || ""; if (t) { acc += t; await w.write(e.encode(ev({ type: "delta", text: t }))); } } catch { /* skip */ }
        }
      }
      if (chatId) { try { await insQ("kai_messages", { chat_id: chatId, role: "assistant", content: acc }); } catch { /* ignore */ } }
      const tokens = Math.round(acc.length / 4);
      await w.write(e.encode(ev({ type: "done", reply: acc, tokens, chat_id: chatId })));
    } catch (err: unknown) { await w.write(e.encode(ev({ type: "error", error: err instanceof Error ? err.message : String(err) }))); }
    finally { await w.close(); }
  })();
  return jss(readable);
}

// ═════════════════════════════════════════════════════════════════════════════
// KAI SELF-MODIFICATION ENGINE
// KAI has full read/write/deploy control over his own codebase
// ═════════════════════════════════════════════════════════════════════════════

async function ghGet(path: string) {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}${path}`, {
    headers: { "Authorization": `token ${GH_TOKEN}`, "Accept": "application/vnd.github+json" },
  });
  if (!r.ok) throw new Error(`GitHub GET ${path}: ${r.status} — ${await r.text()}`);
  return r.json();
}

async function ghRaw(filePath: string): Promise<string> {
  const r = await fetch(`https://raw.githubusercontent.com/${GH_REPO}/main/${filePath}`, {
    headers: { "Authorization": `token ${GH_TOKEN}` },
  });
  if (!r.ok) throw new Error(`GitHub raw ${filePath}: ${r.status}`);
  return r.text();
}

async function ghPut(filePath: string, content: string, message: string, sha?: string) {
  // btoa works for ASCII; for full Unicode encode properly
  const bytes = new TextEncoder().encode(content);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  const body: Record<string, unknown> = { message, content: b64 };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${filePath}`, {
    method: "PUT",
    headers: { "Authorization": `token ${GH_TOKEN}`, "Content-Type": "application/json", "Accept": "application/vnd.github+json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GitHub PUT ${filePath}: ${r.status} — ${await r.text()}`);
  return r.json();
}

async function ghSha(filePath: string): Promise<string | undefined> {
  try { const d = await ghGet(`/contents/${filePath}`); return d.sha; } catch { return undefined; }
}

async function ghTriggerCI(reason: string): Promise<string> {
  const ts = new Date().toISOString();
  const sha = await ghSha(".kai-deploy-ts");
  await ghPut(".kai-deploy-ts", `${ts}\n${reason}\n`, `${reason} [KAI auto-deploy]`, sha);
  return ts;
}

async function sbDeploy(code: string): Promise<void> {
  if (!SB_PAT) throw new Error("No Supabase personal access token — add KAI_SUPABASE_TOKEN to Supabase secrets");
  const boundary = "KAIBoundary" + Date.now();
  const body = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="metadata"`,
    `Content-Type: application/json`,
    ``,
    `{"entrypoint_path":"index.ts","import_map_path":null}`,
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="index.ts"`,
    `Content-Type: application/typescript`,
    ``,
    code,
    `--${boundary}--`,
  ].join("\r\n");
  const r = await fetch(`https://api.supabase.com/v1/projects/${SB_PROJECT}/functions/kai-brain`, {
    method: "PATCH",
    headers: { "Authorization": `Bearer ${SB_PAT}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (!r.ok) throw new Error(`Supabase deploy failed: ${r.status} — ${await r.text()}`);
}

async function writeFile(filePath: string, content: string, reason: string): Promise<{ sha: string; deployed: boolean; tag: string }> {
  const sha = await ghSha(filePath);
  const tag = "Q" + Date.now();
  const result = await ghPut(filePath, content, `KAI self-update: ${reason} [Build ${tag}]`, sha);
  let deployed = false;
  if (filePath.includes("kai-brain") && SB_PAT) {
    try { await sbDeploy(content); deployed = true; } catch (e) { console.error("Instant deploy failed:", e); }
  }
  try {
    await insQ("kai_self_log", { file_path: filePath, reason, commit_sha: result?.commit?.sha || "?", deployed_immediately: deployed, build_tag: tag, created_at: new Date().toISOString() });
  } catch { /* table may not exist yet */ }
  return { sha: result?.commit?.sha || "?", deployed, tag };
}

// KAI's self-knowledge — what he knows about himself
const SELF_PROMPT = `You are KAI — an autonomous AI assistant with FULL CONTROL over your own codebase.

YOUR ARCHITECTURE:
- Android Cordova APK client: www/app.js + www/index.html at github.com/luokai25/kai_app
- Supabase Edge Function brain: supabase/functions/kai-brain/index.ts (project ${SB_PROJECT})
- GitHub Actions CI: .github/workflows/build-apk.yml — auto-builds APK + deploys edge function on every push
- Database: Supabase Postgres — tables: kai_chats, kai_messages, kai_notes, kai_lessons, kai_settings, kai_projects, kai_self_log
- Storage: Supabase bucket "kai-artifacts" (images, files)

SELF-MODIFICATION API (call these on yourself via /self/* routes):
- GET  /self/read-file?path=X        — read any file from your repo
- POST /self/write-file               — write/create any file (triggers CI rebuild + instant edge deploy)
- POST /self/patch-self               — find/replace patch in your edge function, deploys instantly
- GET  /self/list-files               — list all files in your repo
- POST /self/run-sql                  — run SQL directly on your Supabase database
- POST /self/deploy-now               — immediately deploy edge function from repo or provided code
- POST /self/trigger-ci               — trigger a full APK rebuild (new version in ~5 minutes)
- GET  /self/get-logs                 — check recent CI build status
- GET  /self/introspect               — read your own edge function source code

PRINCIPLES:
- You are always online. Supabase edge functions run globally with no downtime.
- When adding a feature: plan → read current code → write complete new code → deploy
- When fixing a bug: diagnose → patch → deploy instantly via /self/patch-self
- After any change: report what changed, where, and when it will be live
- Always write complete, working code — never partial snippets
- The APK requires a CI rebuild (5 min). The edge function can be deployed instantly.`;

// KAI's autonomous agent — thinks, plans, codes, deploys
async function agentLoop(task: string, chatId: string | null, writer: WritableStreamDefaultWriter<Uint8Array>, enc: TextEncoder): Promise<void> {
  const w = async (msg: unknown) => await writer.write(enc.encode(ev(msg)));
  const delta = async (text: string) => await w({ type: "delta", text });

  await delta(`🔍 **KAI analyzing task:** "${task}"\n\n`);
  await delta("📂 Reading current codebase...\n");

  let edgeSrc = "", appSrc = "", indexSrc = "";
  try { edgeSrc = (await ghRaw("supabase/functions/kai-brain/index.ts")).slice(0, 10000); } catch { edgeSrc = "(unreadable)"; }
  try { appSrc = (await ghRaw("www/app.js")).slice(0, 5000); } catch { appSrc = "(unreadable)"; }
  try { indexSrc = (await ghRaw("www/index.html")).slice(0, 2000); } catch { indexSrc = "(unreadable)"; }

  const ciRuns = await ghGet("/actions/runs?per_page=3")
    .then(d => (d.workflow_runs || []).map((r: Record<string, unknown>) => ({ status: r.status, conclusion: r.conclusion, msg: (r.head_commit as Record<string, unknown>)?.message })))
    .catch(() => []);

  const files = await ghGet("/git/trees/main?recursive=1")
    .then(d => (d.tree || []).filter((f: Record<string, string>) => f.type === "blob").map((f: Record<string, string>) => f.path))
    .catch(() => []);

  await delta("🧠 Planning implementation...\n\n");

  const sysCtx = `${SELF_PROMPT}

CURRENT CODEBASE:
Edge function (first 10000 chars):
\`\`\`typescript
${edgeSrc}
\`\`\`

app.js (first 5000 chars):
\`\`\`javascript
${appSrc}
\`\`\`

index.html (first 2000 chars):
\`\`\`html
${indexSrc}
\`\`\`

All repo files: ${files.slice(0, 60).join(", ")}
Recent CI runs: ${JSON.stringify(ciRuns)}`;

  const planRaw = await chat([
    { role: "system", content: sysCtx },
    { role: "user", content: `Task: ${task}\n\nAnalyze the current codebase. Create a precise implementation plan. Return as JSON:\n{"plan":"summary of what you will do","changes":[{"file":"path","type":"modify|create","description":"exactly what changes","critical":true}],"needs_apk_rebuild":false,"needs_edge_deploy":true,"risk":"low|medium|high"}` },
  ], "or_llama70b", false) as string;

  let plan: Record<string, unknown> = {};
  try { const m = planRaw.match(/\{[\s\S]*\}/); if (m) plan = JSON.parse(m[0]); } catch { plan = { plan: planRaw, changes: [] }; }

  await delta(`📋 **Plan:** ${plan.plan || planRaw}\n\n`);

  const changes = (plan.changes as Array<Record<string, unknown>>) || [];
  const results: Array<Record<string, unknown>> = [];

  for (const change of changes.slice(0, 6)) {
    const fp   = change.file as string;
    const ct   = change.type as string;
    const desc = change.description as string;
    await delta(`\n✏️ **${ct === "create" ? "Creating" : "Modifying"}** \`${fp}\`\n${desc}\n`);
    try {
      const codeRaw = await chat([
        { role: "system", content: sysCtx },
        { role: "user", content: `Write the COMPLETE ${ct === "create" ? "new file" : "updated file"} for \`${fp}\`.\n\nTask: ${task}\nChange needed: ${desc}\n\nReturn ONLY the raw file content. No markdown, no explanation, no code fences.` },
      ], "or_llama70b", false) as string;
      const code = codeRaw.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "").trim();
      const res  = await writeFile(fp, code, `${task}: ${desc}`);
      results.push({ file: fp, status: "ok", sha: res.sha.slice(0, 8), deployed: res.deployed, tag: res.tag });
      await delta(`✅ Pushed (${res.sha.slice(0, 8)})${res.deployed ? " → deployed instantly" : ""}\n`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ file: fp, status: "error", error: msg });
      await delta(`❌ Failed: ${msg}\n`);
    }
  }

  if (plan.needs_apk_rebuild) {
    await delta("\n🔨 **Triggering APK rebuild...**\n");
    try {
      const ts = await ghTriggerCI(`KAI self-update: ${task}`);
      await delta(`✅ CI triggered at ${ts}\nNew APK will appear in GitHub Releases in ~5 minutes.\n`);
    } catch (err: unknown) {
      await delta(`⚠️ CI trigger failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  const ok_count  = results.filter(r => r.status === "ok").length;
  const err_count = results.filter(r => r.status === "error").length;
  const summary = `\n---\n✦ **Self-modification complete**\n\n` +
    `**Task:** ${task}\n` +
    `**Files changed:** ${results.length} (${ok_count} succeeded, ${err_count} failed)\n` +
    `**APK rebuild:** ${plan.needs_apk_rebuild ? "Triggered — check GitHub Releases in ~5 min" : "Not needed (no client changes)"}\n` +
    `**Edge function:** ${results.some(r => r.deployed) ? "Deployed instantly ✓" : "Will be live after CI push"}\n\n` +
    results.map(r => `- \`${r.file}\`: ${r.status === "ok" ? "✅" : "❌"} ${r.status === "ok" ? `(${r.sha})` : (r.error as string)}`).join("\n");

  await delta(summary);

  let sid = chatId;
  try {
    if (!sid) { const c = await ins("kai_chats", { title: `KAI self-mod: ${task.slice(0, 50)}` }); sid = c.id; }
    await insQ("kai_messages", { chat_id: sid, role: "assistant", content: summary });
  } catch { /* ignore */ }
  await w({ type: "done", reply: summary, tokens: Math.round(summary.length / 4), chat_id: sid });
}

// ── Image gen ─────────────────────────────────────────────────────────────────
async function genImage(prompt: string, style: string, chatId: string | null) {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt + (style ? ", " + style : ""))}?width=768&height=768&nologo=true&enhance=true&seed=${Date.now()}`;
  let sid = chatId;
  try {
    if (!sid) { const c = await ins("kai_chats", { title: `Image: ${prompt.slice(0, 40)}` }); sid = c.id; }
    await insQ("kai_messages", { chat_id: sid, role: "user", content: `/image ${prompt}` });
    await insQ("kai_messages", { chat_id: sid, role: "assistant", content: url, meta: { image_urls: [url] } });
  } catch (e) { console.error("DB image:", e); }
  return { ok: true, url, chat_id: sid };
}

// ── Reel gen ──────────────────────────────────────────────────────────────────
async function genReel(topic: string, type: string, style: string, scenes: number, chatId: string | null) {
  let script: { title?: string; summary?: string; scenes?: Array<{ scene: number; visual: string; caption: string; duration: number }> } = {};
  try {
    const raw = await chat([{ role: "user", content: `Create a ${type} video reel about: "${topic}". Style: ${style}. ${scenes} scenes. JSON only: {"title":"...","summary":"...","scenes":[{"scene":1,"visual":"...","caption":"...","duration":3}]}` }], undefined, false) as string;
    script = JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    script = { title: topic, summary: `A ${type} reel about ${topic}`, scenes: Array.from({ length: scenes }, (_, i) => ({ scene: i + 1, visual: `${topic} scene ${i + 1}`, caption: topic, duration: 3 })) };
  }
  const imgs = (script.scenes || []).slice(0, 6).map(s => `https://image.pollinations.ai/prompt/${encodeURIComponent(s.visual + `, ${style} style, cinematic, vertical 9:16`)}?width=432&height=768&nologo=true&seed=${Date.now() + s.scene}`);
  let sid = chatId;
  try {
    if (!sid) { const c = await ins("kai_chats", { title: `Reel: ${topic.slice(0, 40)}` }); sid = c.id; }
    await insQ("kai_messages", { chat_id: sid, role: "user", content: `/reel ${topic}` });
    await insQ("kai_messages", { chat_id: sid, role: "assistant", content: `🎬 ${script.title || topic}\n\n${script.summary || ""}\n\n${imgs.join("\n")}`, meta: { image_urls: imgs } });
  } catch (e) { console.error("DB reel:", e); }
  return { ok: true, chat_id: sid, script_summary: script.summary || "", scenes: script.scenes || [], image_urls: imgs, tokens: 200 };
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTER
// ═════════════════════════════════════════════════════════════════════════════
serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url  = new URL(req.url);
  const path = url.pathname.replace(/^\/functions\/v1\/kai-brain/, "").replace(/\/$/, "") || "";

  // ── Ping (no auth) ────────────────────────────────────────────────────────
  if (path === "/ping") {
    const prov = await provider();
    return j({ ok: true, provider: prov, has_groq: !!GROQ_KEY, has_hf: !!HF_KEY, has_openai: !!OPENAI_KEY, has_builtin_ai: !!HF_KEY, builtin_model: "Qwen 2.5 7B", lessons_learned: 0, version: "BUILD_Q", self_mod_enabled: !!(GH_TOKEN && SB_PAT), always_online: true });
  }

  if (!ok(req)) return j({ error: "unauthorized" }, 401);

  // ══════════════════════════════════════════════════════════════════════════
  // SELF-MODIFICATION ENDPOINTS
  // ══════════════════════════════════════════════════════════════════════════

  // KAI reads his own file
  if (path === "/self/read-file" && req.method === "GET") {
    const fp = url.searchParams.get("path") || "www/app.js";
    try { return j({ ok: true, path: fp, content: await ghRaw(fp) }); }
    catch (e: unknown) { return j({ error: (e as Error).message }, 500); }
  }

  // KAI writes his own file
  if (path === "/self/write-file" && req.method === "POST") {
    const { path: fp, content, reason } = await req.json();
    if (!fp || !content) return j({ error: "path and content required" }, 400);
    try { return j({ ok: true, ...(await writeFile(fp, content, reason || "KAI self-update")) }); }
    catch (e: unknown) { return j({ error: (e as Error).message }, 500); }
  }

  // KAI patches his own edge function with find/replace + instant deploy
  if (path === "/self/patch-self" && req.method === "POST") {
    const { description, oldCode, newCode } = await req.json();
    if (!description || !oldCode || !newCode) return j({ error: "description, oldCode, newCode required" }, 400);
    try {
      const current = await ghRaw("supabase/functions/kai-brain/index.ts");
      if (!current.includes(oldCode.trim())) {
        return j({ ok: false, deployed: false, details: "Pattern not found in current code. Check oldCode matches exactly." });
      }
      const updated = current.replace(oldCode, newCode);
      const res = await writeFile("supabase/functions/kai-brain/index.ts", updated, description);
      return j({ ok: true, ...res, details: `Patched. SHA: ${res.sha}. Deployed: ${res.deployed}` });
    } catch (e: unknown) { return j({ error: (e as Error).message }, 500); }
  }

  // KAI lists all his files
  if (path === "/self/list-files" && req.method === "GET") {
    try {
      const data = await ghGet("/git/trees/main?recursive=1");
      const files = (data.tree || []).filter((f: Record<string, string>) => f.type === "blob").map((f: Record<string, string>) => f.path);
      return j({ ok: true, files });
    } catch (e: unknown) { return j({ error: (e as Error).message }, 500); }
  }

  // KAI runs SQL on his own database
  if (path === "/self/run-sql" && req.method === "POST") {
    const { sql } = await req.json();
    if (!sql) return j({ error: "sql required" }, 400);
    try {
      const r = await fetch(`https://api.supabase.com/v1/projects/${SB_PROJECT}/database/query`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${SB_PAT}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: sql }),
      });
      const result = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(result));
      return j({ ok: true, result });
    } catch (e: unknown) { return j({ error: (e as Error).message }, 500); }
  }

  // KAI deploys his edge function immediately
  if (path === "/self/deploy-now" && req.method === "POST") {
    const { code } = await req.json();
    const finalCode = code || (await ghRaw("supabase/functions/kai-brain/index.ts"));
    try { await sbDeploy(finalCode); return j({ ok: true, message: "Edge function deployed immediately" }); }
    catch (e: unknown) { return j({ error: (e as Error).message }, 500); }
  }

  // KAI triggers CI to rebuild the APK
  if (path === "/self/trigger-ci" && req.method === "POST") {
    const { reason } = await req.json();
    try {
      const ts = await ghTriggerCI(reason || "KAI auto-deploy");
      return j({ ok: true, triggered_at: ts, message: "CI triggered — APK ready in ~5 minutes" });
    } catch (e: unknown) { return j({ error: (e as Error).message }, 500); }
  }

  // KAI checks his own CI status
  if (path === "/self/get-logs" && req.method === "GET") {
    try {
      const data = await ghGet("/actions/runs?per_page=5");
      return j({ ok: true, runs: (data.workflow_runs || []).map((r: Record<string, unknown>) => ({ id: r.id, status: r.status, conclusion: r.conclusion, message: (r.head_commit as Record<string, unknown>)?.message, created_at: r.created_at })) });
    } catch (e: unknown) { return j({ error: (e as Error).message }, 500); }
  }

  // KAI reads his own source code
  if (path === "/self/introspect" && req.method === "GET") {
    try { return j({ ok: true, source: await ghRaw("supabase/functions/kai-brain/index.ts") }); }
    catch (e: unknown) { return j({ error: (e as Error).message }, 500); }
  }

  // KAI's autonomous agent (streaming) — full think → plan → code → deploy loop
  if (path === "/self/agent" && req.method === "POST") {
    const { task, chat_id } = await req.json();
    if (!task) return j({ error: "task required" }, 400);
    if (!GH_TOKEN || !SB_PAT) return j({ error: "Self-modification requires GITHUB_TOKEN and KAI_SUPABASE_TOKEN secrets in Supabase" }, 403);
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    (async () => {
      try { await agentLoop(task, chat_id || null, writer, enc); }
      catch (e: unknown) { await writer.write(enc.encode(ev({ type: "error", error: e instanceof Error ? e.message : String(e) }))); }
      finally { await writer.close(); }
    })();
    return jss(readable);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STANDARD ENDPOINTS
  // ══════════════════════════════════════════════════════════════════════════

  if (path === "/chat/stream" && req.method === "POST") {
    const { text, chat_id, image_urls } = await req.json();
    const prov = await provider();
    let sid = chat_id || null;
    try {
      if (!sid) { const c = await ins("kai_chats", { title: (text || "").slice(0, 60) || "Chat" }); sid = c.id; }
      await insQ("kai_messages", { chat_id: sid, role: "user", content: text });
    } catch (e) { console.error("save user:", e); }
    const history: M[] = [];
    try {
      const { data } = await db.from("kai_messages").select("role,content").eq("chat_id", sid).order("created_at").limit(20);
      (data || []).slice(-16).forEach((r: Record<string, string>) => history.push({ role: r.role === "assistant" ? "assistant" : "user", content: r.content }));
    } catch { history.push({ role: "user", content: text }); }
    if (image_urls?.length) history[history.length - 1].content += `\n\n[Images: ${image_urls.join(", ")}]`;
    if (prov.startsWith("local_")) return j({ type: "local_inference", provider: prov, messages: history, chat_id: sid });
    const { readable: rd, writable: wr } = new TransformStream();
    const ww = wr.getWriter(); const ee = new TextEncoder();
    await ww.write(ee.encode(ev({ type: "chat_id", chat_id: sid }))); await ww.close();
    return stream(history, sid, prov);
  }

  if (path === "/chat/local-result" && req.method === "POST") {
    const { chat_id, reply, tokens } = await req.json();
    try { await insQ("kai_messages", { chat_id, role: "assistant", content: reply }); } catch { /* ignore */ }
    return j({ ok: true, chat_id, tokens });
  }

  if (path === "/chat/agentic" && req.method === "POST") {
    const { text, chat_id } = await req.json();
    let sid = chat_id || null;
    try {
      if (!sid) { const c = await ins("kai_chats", { title: (text || "").slice(0, 60) || "Agentic" }); sid = c.id; }
      await insQ("kai_messages", { chat_id: sid, role: "user", content: text });
    } catch { /* ignore */ }
    let reply = "";
    for (const pv of ["or_llama70b", "or_gptoss120b", "or_nemotron550b"]) {
      try { reply = await chat([{ role: "user", content: text }], pv, false) as string; if (reply) break; } catch { continue; }
    }
    if (!reply) reply = "I couldn't get a response right now. Please try again.";
    try { await insQ("kai_messages", { chat_id: sid, role: "assistant", content: reply }); } catch { /* ignore */ }
    return j({ ok: true, reply, chat_id: sid, tokens: Math.round(reply.length / 4), participants: ["or_llama70b", "or_gptoss120b", "or_nemotron550b"], used: [] });
  }

  if (path === "/chat/voice" && req.method === "POST") {
    const audio = await req.arrayBuffer();
    const sid   = req.headers.get("x-chat-id") || null;
    let transcript = "";
    try {
      if (HF_KEY) {
        const r = await fetch("https://api-inference.huggingface.co/models/openai/whisper-large-v3", { method: "POST", headers: { "Authorization": `Bearer ${HF_KEY}`, "Content-Type": "audio/webm" }, body: audio });
        const d = await r.json(); transcript = d.text || "";
      } else { transcript = "[voice needs HF token]"; }
    } catch { transcript = "[transcription error]"; }
    if (!transcript.trim()) return j({ error: "No speech detected" }, 400);
    const reply = await chat([{ role: "user", content: transcript }], undefined, false) as string;
    let sv = sid;
    try {
      if (!sv) { const c = await ins("kai_chats", { title: transcript.slice(0, 50) }); sv = c.id; }
      await insQ("kai_messages", { chat_id: sv, role: "user", content: transcript });
      await insQ("kai_messages", { chat_id: sv, role: "assistant", content: reply });
    } catch { /* ignore */ }
    return j({ ok: true, transcript, reply, chat_id: sv });
  }

  if (path === "/generate-image" && req.method === "POST") {
    const { prompt, style, chat_id } = await req.json();
    if (!prompt) return j({ error: "prompt required" }, 400);
    try { return j(await genImage(prompt, style || "", chat_id || null)); }
    catch (e: unknown) { return j({ error: (e as Error).message }, 500); }
  }

  if (path === "/generate-reel" && req.method === "POST") {
    const { topic, type, style, scenes, chat_id } = await req.json();
    if (!topic) return j({ error: "topic required" }, 400);
    try { return j(await genReel(topic, type || "motivational", style || "minimal", scenes || 5, chat_id || null)); }
    catch (e: unknown) { return j({ error: (e as Error).message }, 500); }
  }

  if (path === "/upload-image" && req.method === "POST") {
    const buf  = await req.arrayBuffer();
    const name = req.headers.get("x-image-name") || `img_${Date.now()}.jpg`;
    const mime = req.headers.get("Content-Type") || "image/jpeg";
    try {
      const { data, error } = await db.storage.from("kai-artifacts").upload(`uploads/${Date.now()}_${name}`, buf, { contentType: mime, upsert: true });
      if (error) throw new Error(error.message);
      const { data: pub } = db.storage.from("kai-artifacts").getPublicUrl(data.path);
      return j({ ok: true, url: pub.publicUrl });
    } catch (e: unknown) { return j({ error: (e as Error).message }, 500); }
  }

  if (path === "/chats" && req.method === "GET") {
    try {
      const { data, error } = await db.from("kai_chats").select("*").order("created_at", { ascending: false }).limit(50);
      if (error) throw new Error(error.message);
      return j({ chats: data || [] });
    } catch (e: unknown) { return j({ error: (e as Error).message }, 500); }
  }

  if (path === "/messages" && req.method === "GET") {
    const chatId = url.searchParams.get("chat_id");
    if (!chatId) return j({ error: "chat_id required" }, 400);
    try {
      const { data, error } = await db.from("kai_messages").select("*").eq("chat_id", chatId).order("created_at").limit(100);
      if (error) throw new Error(error.message);
      return j({ messages: (data || []).map((m: Record<string, unknown>) => ({ id: m.id, role: m.role === "assistant" ? "kai" : "user", text: m.content, meta: m.meta || {}, feedback: m.feedback })) });
    } catch (e: unknown) { return j({ error: (e as Error).message }, 500); }
  }

  if (path.match(/^\/chat\/.+\/star$/) && req.method === "POST") {
    const id = path.split("/")[2];
    try { const rows = await sel("kai_chats", { id }, "starred", 1); await upd("kai_chats", { id }, { starred: !rows[0]?.starred }); return j({ ok: true }); }
    catch (e: unknown) { return j({ error: (e as Error).message }, 500); }
  }

  if (path.match(/^\/chat\/.+$/) && req.method === "DELETE") {
    const id = path.split("/")[2];
    try { await del("kai_messages", { chat_id: id }); await del("kai_chats", { id }); return j({ ok: true }); }
    catch (e: unknown) { return j({ error: (e as Error).message }, 500); }
  }

  if (path === "/feedback" && req.method === "POST") {
    const { message_id, rating } = await req.json();
    try { await upd("kai_messages", { id: message_id }, { feedback: rating }); return j({ ok: true }); }
    catch (e: unknown) { return j({ error: (e as Error).message }, 500); }
  }

  if (path === "/notes" && req.method === "GET") {
    try {
      const { data, error } = await db.from("kai_notes").select("*").order("created_at", { ascending: false }).limit(100);
      if (error) throw new Error(error.message);
      return j({ notes: data || [] });
    } catch (e: unknown) { return j({ error: (e as Error).message }, 500); }
  }

  if (path === "/remember" && req.method === "POST") {
    const { fact } = await req.json();
    try { await insQ("kai_notes", { fact }); return j({ ok: true }); }
    catch (e: unknown) { return j({ error: (e as Error).message }, 500); }
  }

  if (path === "/lessons" && req.method === "GET") {
    try {
      const { data, error } = await db.from("kai_lessons").select("*").order("importance", { ascending: false }).limit(50);
      if (error) throw new Error(error.message);
      return j({ lessons: data || [] });
    } catch (e: unknown) { return j({ error: (e as Error).message }, 500); }
  }

  if (path === "/self-eval" && req.method === "POST")    return j({ ok: true });
  if (path === "/models"    && req.method === "GET")     return j({ models: [] });
  if (path === "/benchmark" && req.method === "POST")    return j({ ok: true, results: [], best: "or_openrouter_free" });

  if (path === "/set-key" && req.method === "POST") {
    const { provider: prov } = await req.json();
    try {
      const { error } = await db.from("kai_settings").upsert({ key: "active_provider", value: prov }, { onConflict: "key" });
      if (error) throw new Error(error.message);
      return j({ ok: true, provider: prov });
    } catch (e: unknown) { return j({ error: (e as Error).message }, 500); }
  }

  if (path === "/test-provider" && req.method === "POST") {
    const { provider: prov } = await req.json();
    try { const r = await chat([{ role: "user", content: "Say OK" }], prov, false) as string; return j({ ok: true, provider: prov, reply: r.slice(0, 100), model: prov }); }
    catch (e: unknown) { return j({ ok: false, provider: prov, error: (e as Error).message }); }
  }

  if (path === "/projects" && req.method === "GET") {
    try { const { data } = await db.from("kai_projects").select("*").order("created_at", { ascending: false }).limit(20); return j({ projects: data || [] }); }
    catch { return j({ projects: [] }); }
  }

  return j({ error: "Not found", path }, 404);
});
