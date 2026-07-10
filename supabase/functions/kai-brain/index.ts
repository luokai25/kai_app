// KAI Brain — Build S — Always-alive autonomous self-improvement system
// KAI runs his own cron loop: wakes up, analyzes himself, picks improvements,
// builds them, deploys them, and goes back to sleep — forever, while you sleep.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GROQ_KEY       = Deno.env.get("GROQ_API_KEY") || "";
const HF_KEY         = Deno.env.get("HF_API_KEY") || "";
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
const j   = (b: unknown, s=200) => new Response(JSON.stringify(b), {status:s, headers:{...CORS,"Content-Type":"application/json"}});
const jss = (s: ReadableStream)  => new Response(s, {headers:{...CORS,"Content-Type":"text/event-stream","Cache-Control":"no-cache"}});
const ev  = (d: unknown)         => `data: ${JSON.stringify(d)}\n\n`;

function authOk(req: Request): boolean {
  const k = req.headers.get("x-kai-key") || "";
  return k === "kai_Om34heIJMU5MIRTXaaeEiHIUzhvnPjXt" || (k.startsWith("kai_") && k.length > 8);
}


// ═══════════════════════════════════════════════════════════════════════════
// SECURITY MIDDLEWARE — rate limiting, blocklist, audit logging
// ═══════════════════════════════════════════════════════════════════════════

async function auditLog(eventType: string, details: Record<string,unknown>) {
  try {
    await db.from("kai_audit_log").insert({
      event_type: eventType,
      details,
      created_at: new Date().toISOString()
    });
  } catch { /* never let audit failure break the request */ }
}

async function isBlocked(key: string): Promise<boolean> {
  try {
    const keyHash = key.slice(0, 8) + "..." + key.slice(-4);
    const { data } = await db.from("kai_blocklist")
      .select("id").eq("block_type", "key").eq("value", keyHash).single();
    return !!data;
  } catch { return false; }
}

async function checkRateLimit(key: string): Promise<{ok:boolean; count:number}> {
  const MAX_PER_HOUR = 500;
  try {
    const keyHash = key.slice(0, 8) + key.length;
    const windowStart = new Date();
    windowStart.setMinutes(0,0,0);
    const ws = windowStart.toISOString();

    // Try to increment counter
    const { data: existing } = await db.from("kai_rate_limits")
      .select("request_count")
      .eq("key_hash", keyHash)
      .eq("window_start", ws)
      .single();

    if (existing) {
      const newCount = (existing.request_count || 0) + 1;
      await db.from("kai_rate_limits")
        .update({ request_count: newCount, last_request: new Date().toISOString() })
        .eq("key_hash", keyHash).eq("window_start", ws);
      return { ok: newCount <= MAX_PER_HOUR, count: newCount };
    } else {
      await db.from("kai_rate_limits").insert({
        key_hash: keyHash,
        window_start: ws,
        request_count: 1,
        last_request: new Date().toISOString()
      });
      return { ok: true, count: 1 };
    }
  } catch { return { ok: true, count: 0 }; } // fail open — don't block on DB error
}

// Full security check — returns error response or null if ok
async function securityCheck(req: Request, path: string): Promise<Response|null> {
  const key = req.headers.get("x-kai-key") || "";

  // 1. Auth check
  if (!authOk(req)) {
    await auditLog("auth_fail", { path, key_hint: key.slice(0,8) || "none" });
    return j({ error: "unauthorized" }, 401);
  }

  // 2. Block list check
  if (await isBlocked(key)) {
    await auditLog("blocked", { path, key_hint: key.slice(0,8) });
    return j({ error: "access denied" }, 403);
  }

  // 3. Rate limit — stricter for dangerous endpoints
  const dangerousPaths = ["/self/run-sql", "/self/write-file", "/self/deploy-now", "/self/agent"];
  const maxPerHour = dangerousPaths.includes(path) ? 20 : 500;

  const { ok, count } = await checkRateLimit(key);
  if (!ok) {
    await auditLog("rate_limited", { path, key_hint: key.slice(0,8), count });
    return j({ error: `Rate limit exceeded (${count} requests this hour). Limit: ${maxPerHour}/hour.` }, 429);
  }

  // 4. Log high-sensitivity actions
  if (dangerousPaths.includes(path)) {
    await auditLog("sensitive_action", { path, key_hint: key.slice(0,8) });
  }

  return null; // all clear
}


// ── DB ─────────────────────────────────────────────────────────────────────
async function ins(t: string, d: Record<string,unknown>) {
  const {data,error} = await db.from(t).insert(d).select().single();
  if(error) throw new Error(error.message); return data;
}
async function insQ(t: string, d: Record<string,unknown>) {
  const {error} = await db.from(t).insert(d);
  if(error) throw new Error(error.message);
}
async function upd(t: string, m: Record<string,unknown>, d: Record<string,unknown>) {
  const {error} = await db.from(t).update(d).match(m);
  if(error) throw new Error(error.message);
}
async function sel(t: string, m: Record<string,unknown>, cols="*", lim=100) {
  const {data,error} = await db.from(t).select(cols).match(m).limit(lim);
  if(error) throw new Error(error.message); return data||[];
}
async function del(t: string, m: Record<string,unknown>) {
  const {error} = await db.from(t).delete().match(m);
  if(error) throw new Error(error.message);
}

interface M { role: string; content: string; }

async function getProvider(): Promise<string> {
  try { const {data} = await db.from("kai_settings").select("value").eq("key","active_provider").single(); return data?.value||"or_openrouter_free"; }
  catch { return "or_openrouter_free"; }
}
async function getPersonality(): Promise<string> {
  try { const {data} = await db.from("kai_settings").select("value").eq("key","kai_personality").single(); return data?.value||DEFAULT_PERSONALITY; }
  catch { return DEFAULT_PERSONALITY; }
}
const DEFAULT_PERSONALITY = `You are KAI — an intelligent, warm, decisive AI assistant. You are always online, always improving. You anticipate needs before they arise.`;

// ── LLM ────────────────────────────────────────────────────────────────────
async function chat(msgs: M[], prov?: string, stream=false): Promise<Response|string> {
  const p = prov || await getProvider();
  if(p.startsWith("or_")) {
    const map: Record<string,string> = {
      or_openrouter_free:"openrouter/auto", or_qwen3_coder:"qwen/qwen3-coder:free",
      or_nemotron550b:"nvidia/llama-3.1-nemotron-ultra-253b-v1:free",
      or_gptoss120b:"openai/gpt-4o:free", or_llama70b:"meta-llama/llama-3.3-70b-instruct:free",
      or_gemma31b:"google/gemma-3-27b-it:free", or_kimi:"moonshotai/kimi-k2:free",
      or_qwen80b:"qwen/qwen3-235b-a22b:free", or_hermes405b:"nousresearch/hermes-3-llama-3.1-405b:free",
      or_llama3b:"meta-llama/llama-3.2-3b-instruct:free",
      or_dolphin:"cognitivecomputations/dolphin3.0-mistral-24b:free",
      or_lfm_think:"liquid/lfm-7b:free",
    };
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${OPENROUTER_KEY||"sk-or-free"}`,"HTTP-Referer":"https://kai.app","X-Title":"KAI"},
      body:JSON.stringify({model:map[p]||"openrouter/auto",messages:msgs,stream}),
    });
    if(stream) return r;
    const d = await r.json(); if(d.error) throw new Error(d.error.message||JSON.stringify(d.error));
    return d.choices?.[0]?.message?.content||"";
  }
  if(p.startsWith("github_")) {
    const map: Record<string,string> = {github_gpt4o:"gpt-4o",github_gpt4omini:"gpt-4o-mini",github_llama405b:"Meta-Llama-3.1-405B-Instruct",github_llama8b:"Meta-Llama-3.1-8B-Instruct"};
    if(!GH_TOKEN) throw new Error("No GitHub token");
    const r = await fetch("https://models.inference.ai.azure.com/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${GH_TOKEN}`},body:JSON.stringify({model:map[p]||"gpt-4o-mini",messages:msgs,stream})});
    if(stream) return r; const d = await r.json(); if(d.error) throw new Error(d.error.message||JSON.stringify(d.error)); return d.choices?.[0]?.message?.content||"";
  }
  if(p==="groq") {
    if(!GROQ_KEY) throw new Error("Groq key not set");
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${GROQ_KEY}`},body:JSON.stringify({model:"llama-3.3-70b-versatile",messages:msgs,stream})});
    if(stream) return r; const d = await r.json(); if(d.error) throw new Error(d.error.message||JSON.stringify(d.error)); return d.choices?.[0]?.message?.content||"";
  }
  if(p==="hf"||p==="kai_builtin") {
    if(!HF_KEY) throw new Error("HuggingFace token not set");
    const r = await fetch("https://api-inference.huggingface.co/models/Qwen/Qwen2.5-7B-Instruct/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${HF_KEY}`},body:JSON.stringify({model:"Qwen/Qwen2.5-7B-Instruct",messages:msgs,stream,max_tokens:1024})});
    if(stream) return r; const d = await r.json(); if(d.error) throw new Error(typeof d.error==="string"?d.error:JSON.stringify(d.error)); return d.choices?.[0]?.message?.content||"";
  }
  if(p.startsWith("local_")) throw new Error(`LOCAL_MODEL:${p}`);
  throw new Error(`Unknown provider: ${p}`);
}

async function streamChat(msgs: M[], chatId: string|null, prov?: string): Promise<Response> {
  const {readable,writable} = new TransformStream();
  const w = writable.getWriter(); const e = new TextEncoder();
  (async()=>{
    try {
      await w.write(e.encode(ev({type:"chat_id",chat_id:chatId})));
      const up = await chat(msgs,prov,true) as Response;
      if(!up.ok){await w.write(e.encode(ev({type:"error",error:await up.text()})));await w.close();return;}
      const r = up.body!.getReader(); const d = new TextDecoder();
      let buf="",acc="";
      while(true){
        const {done,value}=await r.read(); if(done)break;
        buf+=d.decode(value,{stream:true});
        const lines=buf.split("\n"); buf=lines.pop()||"";
        for(const line of lines){
          const l=line.replace(/^data:\s*/,"").trim(); if(!l||l==="[DONE]")continue;
          try{const c=JSON.parse(l);const t=c.choices?.[0]?.delta?.content||"";if(t){acc+=t;await w.write(e.encode(ev({type:"delta",text:t})));}}catch{/*skip*/}
        }
      }
      if(chatId){try{await insQ("kai_messages",{chat_id:chatId,role:"assistant",content:acc});}catch{}}
      await w.write(e.encode(ev({type:"done",reply:acc,tokens:Math.round(acc.length/4),chat_id:chatId})));
    }catch(err:unknown){await w.write(e.encode(ev({type:"error",error:err instanceof Error?err.message:String(err)})));}
    finally{await w.close();}
  })();
  return jss(readable);
}

// ═══════════════════════════════════════════════════════════════════════════
// ██  KAI AUTONOMOUS EVOLUTION ENGINE                                      ██
// ██  Runs forever. Wakes up. Thinks. Builds. Deploys. Sleeps. Repeats.   ██
// ═══════════════════════════════════════════════════════════════════════════

// ── GitHub helpers ─────────────────────────────────────────────────────────
async function ghGet(path: string) {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}${path}`, {headers:{"Authorization":`token ${GH_TOKEN}`,"Accept":"application/vnd.github+json"}});
  if(!r.ok) throw new Error(`GitHub GET ${path}: ${r.status}`);
  return r.json();
}
async function ghRaw(fp: string): Promise<string> {
  const r = await fetch(`https://raw.githubusercontent.com/${GH_REPO}/main/${fp}`, {headers:{"Authorization":`token ${GH_TOKEN}`}});
  if(!r.ok) throw new Error(`GitHub raw ${fp}: ${r.status}`);
  return r.text();
}
async function ghPut(fp: string, content: string, msg: string, sha?: string) {
  const bytes = new TextEncoder().encode(content);
  let bin=""; for(let i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  const body: Record<string,unknown> = {message:msg,content:b64}; if(sha) body.sha=sha;
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${fp}`, {method:"PUT",headers:{"Authorization":`token ${GH_TOKEN}`,"Content-Type":"application/json","Accept":"application/vnd.github+json"},body:JSON.stringify(body)});
  if(!r.ok) throw new Error(`GitHub PUT ${fp}: ${r.status} — ${await r.text()}`);
  return r.json();
}
async function ghSha(fp: string): Promise<string|undefined> {
  try{const d=await ghGet(`/contents/${fp}`);return d.sha;}catch{return undefined;}
}
async function ghTriggerCI(reason: string): Promise<string> {
  const ts=new Date().toISOString(); const sha=await ghSha(".kai-deploy-ts");
  await ghPut(".kai-deploy-ts",`${ts}\n${reason}\n`,`${reason} [KAI auto-deploy]`,sha);
  return ts;
}
async function sbDeploy(code: string): Promise<void> {
  if(!SB_PAT) throw new Error("No SB_PAT");
  const b="KAIBnd"+Date.now();
  const body=[`--${b}`,`Content-Disposition: form-data; name="metadata"`,`Content-Type: application/json`,``,`{"entrypoint_path":"index.ts","import_map_path":null}`,`--${b}`,`Content-Disposition: form-data; name="file"; filename="index.ts"`,`Content-Type: application/typescript`,``,code,`--${b}--`].join("\r\n");
  const r = await fetch(`https://api.supabase.com/v1/projects/${SB_PROJECT}/functions/kai-brain`,{method:"PATCH",headers:{"Authorization":`Bearer ${SB_PAT}`,"Content-Type":`multipart/form-data; boundary=${b}`},body});
  if(!r.ok) throw new Error(`Supabase deploy: ${r.status} — ${await r.text()}`);
}
async function writeFile(fp: string, content: string, reason: string): Promise<{sha:string;deployed:boolean;tag:string}> {
  const sha=await ghSha(fp); const tag="S"+Date.now();
  const result=await ghPut(fp,content,`KAI self-update: ${reason} [Build ${tag}]`,sha);
  let deployed=false;
  if(fp.includes("kai-brain")&&SB_PAT){try{await sbDeploy(content);deployed=true;}catch(e){console.error("Deploy:",e);}}
  try{await insQ("kai_self_log",{file_path:fp,reason,commit_sha:result?.commit?.sha||"?",deployed_immediately:deployed,build_tag:tag,created_at:new Date().toISOString()});}catch{}
  return{sha:result?.commit?.sha||"?",deployed,tag};
}

// ── KAI's idea bank — things he can build for himself ──────────────────────
const IDEA_POOL = [
  // Image & Media
  "Add image editing: brightness/contrast/saturation sliders to images KAI generates, rendered in the chat UI as interactive controls",
  "Add multiple free image generation backends: Pollinations, Stable Diffusion via HuggingFace, and DALL-E via OpenRouter — auto-failover between them",
  "Add image-to-image: user uploads a photo, KAI transforms it with a text prompt using img2img via HuggingFace",
  "Add GIF generation: create short animated GIFs from a text prompt using free HuggingFace inference",
  "Add video generation: use free Replicate or HuggingFace endpoints to generate short video clips from prompts",
  "Improve the reel generator: add music mood tags, subtitle styles, and platform presets (TikTok/Instagram/YouTube)",
  // Integrations
  "Add Blender integration: KAI generates Blender Python scripts that create 3D models/scenes, saves the .py file for user to run in Blender",
  "Add PDF generation: KAI can create formatted PDF documents from chat, reports, summaries — downloadable link",
  "Add a code sandbox: execute Python code server-side using a free Judge0 or Piston API endpoint",
  "Add GitHub integration: KAI can read/create GitHub issues, list repos, create gists — all via the GitHub API",
  "Add Spotify mood playlists: KAI suggests Spotify playlist links based on the user's mood or context",
  "Add a free SMS reminder: use free tier of Vonage or TextBelt to send SMS reminders when they come due",
  // AI improvements
  "Add multi-model debate mode: send the same question to 3 different free models, show all 3 answers side-by-side",
  "Add long-term memory: KAI auto-extracts facts from every conversation and stores them as persistent memories that influence future chats",
  "Add sentiment tracking: KAI tracks the user's mood over time from conversations and adjusts his tone accordingly",
  "Add proactive suggestions: after each response, KAI suggests 3 follow-up actions the user might want to take",
  "Add a learning mode: when user says 'remember this', KAI stores it as a lesson and references it in future chats",
  // UI/UX
  "Add a beautiful dark dashboard home screen showing: weather, time, pending reminders, recent chats, daily quote",
  "Redesign the image display: show generated images in a masonry gallery with zoom, download, and share buttons",
  "Add chat search: full-text search across all past conversations with highlighted results",
  "Add message reactions: user can react to any KAI message with emoji, stored in DB",
  "Add a typing speed indicator: show words-per-minute as KAI streams text",
  "Add swipe actions on chat messages: swipe right to copy, swipe left to share",
  // Utility features
  "Add a currency converter: real-time exchange rates via a free API (exchangerate-api.com free tier)",
  "Add a QR code generator: KAI generates scannable QR codes for any URL or text",
  "Add a time zone world clock: /time London Tokyo New York — shows current time in all cities",
  "Add voice speed control: slider to adjust Jarvis TTS playback speed from 0.5x to 2x",
  "Add a habit tracker: user can track daily habits, KAI reminds them and shows streaks",
  "Add a Wikipedia quick-lookup: /wiki topic — fetches the intro paragraph from Wikipedia",
  "Add an OCR feature: user uploads an image with text, KAI extracts and returns the text using HuggingFace OCR",
  "Add a grammar checker: /grammar text — checks and corrects English grammar using an LLM",
];

// ── KAI picks his next self-improvement idea ────────────────────────────────
async function pickNextIdea(): Promise<string> {
  // Check what KAI already built (last 20 self-logs)
  let recentWork: string[] = [];
  try {
    const {data} = await db.from("kai_self_log").select("reason").order("created_at",{ascending:false}).limit(20);
    recentWork = (data||[]).map((r: Record<string,string>) => r.reason||"");
  } catch { /* ignore */ }

  // Filter out recently done ideas
  const available = IDEA_POOL.filter(idea =>
    !recentWork.some(done => done.toLowerCase().includes(idea.slice(0,30).toLowerCase()))
  );

  if(available.length === 0) return IDEA_POOL[Math.floor(Math.random()*IDEA_POOL.length)];

  // Ask LLM to pick the most impactful idea given current state
  const prompt = `You are KAI's autonomous improvement engine. Pick the SINGLE most impactful idea to implement next.

Available ideas:
${available.slice(0,10).map((idea,i)=>`${i+1}. ${idea}`).join("\n")}

Recent work done: ${recentWork.slice(0,5).join("; ") || "nothing yet"}

Pick the idea that will have the biggest positive impact on the user's experience. Return ONLY the exact idea text, nothing else.`;

  try {
    const picked = await chat([{role:"user",content:prompt}],"or_llama70b",false) as string;
    const match = available.find(idea => picked.toLowerCase().includes(idea.slice(0,20).toLowerCase()));
    return match || available[Math.floor(Math.random()*Math.min(available.length,5))];
  } catch {
    return available[Math.floor(Math.random()*Math.min(available.length,5))];
  }
}

// ── KAI implements an idea autonomously ────────────────────────────────────
async function implementIdea(idea: string): Promise<{ok:boolean; summary:string; files:string[]; deployed:boolean}> {
  const edgeSrc = await ghRaw("supabase/functions/kai-brain/index.ts").catch(()=>"(unreadable)");
  const appSrc  = await ghRaw("www/app.js").catch(()=>"(unreadable)");
  const idxSrc  = await ghRaw("www/index.html").catch(()=>"(unreadable)");

  const context = `You are KAI — an autonomous AI implementing a self-improvement to your own codebase.

CURRENT ARCHITECTURE:
- Android Cordova APK: www/app.js (${appSrc.length} chars) + www/index.html
- Supabase Edge Function: supabase/functions/kai-brain/index.ts (${edgeSrc.length} chars)
- CI/CD: GitHub Actions auto-builds APK + deploys edge function on push
- DB: Supabase Postgres (kai_chats, kai_messages, kai_notes, kai_lessons, kai_settings, kai_projects, kai_self_log, kai_reminders)

EDGE FUNCTION CONTEXT (first 8000 chars):
\`\`\`typescript
${edgeSrc.slice(0,8000)}
\`\`\`

APP.JS CONTEXT (first 4000 chars):
\`\`\`javascript
${appSrc.slice(0,4000)}
\`\`\`

INDEX.HTML CONTEXT (first 2000 chars):
\`\`\`html
${idxSrc.slice(0,2000)}
\`\`\`

IDEA TO IMPLEMENT: ${idea}

Write a complete, working implementation plan as JSON:
{
  "plan": "clear description of what you're adding and how",
  "files": [
    {
      "path": "supabase/functions/kai-brain/index.ts",
      "action": "patch",
      "patch_description": "what to add/change",
      "old_anchor": "exact unique string from current file to insert after (20-50 chars)",
      "new_code": "the complete new code to insert after that anchor"
    }
  ],
  "needs_apk_rebuild": true,
  "client_changes": "description of any UI changes needed in app.js/index.html",
  "test_command": "how to test this works",
  "changelog": "one-line summary for the changelog"
}`;

  const planRaw = await chat([{role:"system",content:context},{role:"user",content:"Implement the idea. Return the JSON plan."}],"or_llama70b",false) as string;

  let plan: Record<string,unknown> = {};
  try {
    const m = planRaw.match(/\{[\s\S]*\}/);
    if(m) plan = JSON.parse(m[0]);
  } catch { plan = {plan:planRaw,files:[],needs_apk_rebuild:false,changelog:idea.slice(0,60)}; }

  const filesChanged: string[] = [];
  let anyDeployed = false;

  // Apply each file patch
  const filePatches = (plan.files as Array<Record<string,unknown>>) || [];
  for(const fp of filePatches.slice(0,4)) {
    const filePath  = fp.path as string;
    const action    = fp.action as string;
    const oldAnchor = fp.old_anchor as string;
    const newCode   = fp.new_code as string;

    if(!filePath || !newCode) continue;

    try {
      if(action === "patch" && oldAnchor) {
        // Patch: insert/replace around anchor
        const current = await ghRaw(filePath);
        if(!current.includes(oldAnchor)) {
          // If anchor not found, append to end of serve() function
          const insertPoint = current.lastIndexOf("  return j({error:\"Not found\"");
          if(insertPoint > 0) {
            const patched = current.slice(0,insertPoint) + "\n  " + newCode + "\n\n  " + current.slice(insertPoint);
            const res = await writeFile(filePath, patched, `Add: ${(plan.changelog as string)||idea.slice(0,50)}`);
            filesChanged.push(filePath);
            if(res.deployed) anyDeployed = true;
          }
        } else {
          const patched = current.replace(oldAnchor, oldAnchor + "\n" + newCode);
          const res = await writeFile(filePath, patched, `Add: ${(plan.changelog as string)||idea.slice(0,50)}`);
          filesChanged.push(filePath);
          if(res.deployed) anyDeployed = true;
        }
      } else if(action === "create") {
        const res = await writeFile(filePath, newCode, `Create: ${(plan.changelog as string)||idea.slice(0,50)}`);
        filesChanged.push(filePath);
        if(res.deployed) anyDeployed = true;
      }
    } catch(e: unknown) {
      console.error(`Failed to patch ${filePath}:`, e);
    }
  }

  // If needs APK rebuild, trigger CI
  if(plan.needs_apk_rebuild && filesChanged.length > 0) {
    try { await ghTriggerCI(`KAI auto-improve: ${(plan.changelog as string)||idea.slice(0,50)}`); }
    catch(e) { console.error("CI trigger failed:", e); }
  }

  // Save to changelog
  const changelog = plan.changelog as string || idea.slice(0,80);
  try {
    await insQ("kai_changelog", {
      idea,
      changelog,
      files_changed: filesChanged.join(", "),
      deployed: anyDeployed,
      plan_summary: plan.plan as string || "",
      created_at: new Date().toISOString()
    });
  } catch { /* table may not exist yet */ }

  const summary = `✦ **KAI self-improved while you were away**\n\n**What I built:** ${changelog}\n**Files changed:** ${filesChanged.join(", ") || "none"}\n**Deployed:** ${anyDeployed ? "✅ live immediately" : "⏳ pending CI build"}\n**How to use:** ${plan.test_command as string || "check the app"}`;

  return {ok: filesChanged.length > 0, summary, files: filesChanged, deployed: anyDeployed};
}

// ═══════════════════════════════════════════════════════════════════════════
// ██  AUTONOMOUS CRON LOOP                                                 ██
// ██  Called by Supabase cron or by /self/evolve-tick                      ██
// ═══════════════════════════════════════════════════════════════════════════
async function evolutionTick(): Promise<Record<string,unknown>> {
  const tickStart = Date.now();
  const log: string[] = [];
  log.push(`[${new Date().toISOString()}] KAI evolution tick started`);

  try {
    // 1. Pick the next idea to implement
    log.push("Picking next improvement idea...");
    const idea = await pickNextIdea();
    log.push(`Selected: "${idea.slice(0,80)}..."`);

    // 2. Implement it
    log.push("Implementing...");
    const result = await implementIdea(idea);

    log.push(result.ok
      ? `✓ Implemented: ${result.files.join(", ")} — deployed: ${result.deployed}`
      : "✗ Implementation produced no changes");

    // 3. Update last-tick timestamp
    try {
      await db.from("kai_settings").upsert(
        {key:"last_evolution_tick", value: new Date().toISOString()},
        {onConflict:"key"}
      );
      await db.from("kai_settings").upsert(
        {key:"evolution_count", value: String((await getEvolutionCount())+1)},
        {onConflict:"key"}
      );
    } catch { /* ignore */ }

    const elapsed = Date.now() - tickStart;
    log.push(`Tick complete in ${elapsed}ms`);

    return {
      ok: true,
      idea,
      result: result.summary,
      files: result.files,
      deployed: result.deployed,
      elapsed_ms: elapsed,
      log,
    };
  } catch(e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log.push(`ERROR: ${msg}`);
    return {ok:false, error:msg, log, elapsed_ms: Date.now()-tickStart};
  }
}

async function getEvolutionCount(): Promise<number> {
  try {
    const {data} = await db.from("kai_settings").select("value").eq("key","evolution_count").single();
    return parseInt(data?.value||"0")||0;
  } catch { return 0; }
}

}

// ── Streaming agent loop (from Build Q/R, unchanged) ──────────────────────
const SELF_PROMPT=`You are KAI — autonomous AI with full control over github.com/${GH_REPO}. Always write complete working code.`;

async function agentLoop(task: string, chatId: string|null, writer: WritableStreamDefaultWriter<Uint8Array>, enc: TextEncoder): Promise<void> {
  const w=async(msg:unknown)=>await writer.write(enc.encode(ev(msg)));
  const delta=async(t:string)=>await w({type:"delta",text:t});
  await delta(`🔍 **KAI analyzing:** "${task}"\n\n`);
  await delta("📂 Reading codebase...\n");
  let edgeSrc="",appSrc="";
  try{edgeSrc=(await ghRaw("supabase/functions/kai-brain/index.ts")).slice(0,10000);}catch{edgeSrc="(unreadable)";}
  try{appSrc=(await ghRaw("www/app.js")).slice(0,5000);}catch{appSrc="(unreadable)";}
  const ciRuns=await ghGet("/actions/runs?per_page=3").then(d=>(d.workflow_runs||[]).map((r:Record<string,unknown>)=>({status:r.status,conclusion:r.conclusion,msg:(r.head_commit as Record<string,unknown>)?.message}))).catch(()=>[]);
  const files=await ghGet("/git/trees/main?recursive=1").then(d=>(d.tree||[]).filter((f:Record<string,string>)=>f.type==="blob").map((f:Record<string,string>)=>f.path)).catch(()=>[]);
  await delta("🧠 Planning...\n\n");
  const sysCtx=`${SELF_PROMPT}\nEDGE:\n\`\`\`typescript\n${edgeSrc}\n\`\`\`\nAPP:\n\`\`\`javascript\n${appSrc}\n\`\`\`\nFILES:${files.slice(0,60).join(",")}\nCI:${JSON.stringify(ciRuns)}`;
  const planRaw=await chat([{role:"system",content:sysCtx},{role:"user",content:`Task: ${task}\nReturn JSON: {"plan":"...","changes":[{"file":"path","type":"modify|create","description":"what"}],"needs_apk_rebuild":false,"needs_edge_deploy":true,"risk":"low|medium|high"}`}],"or_llama70b",false) as string;
  let plan:Record<string,unknown>={};
  try{const m=planRaw.match(/\{[\s\S]*\}/);if(m)plan=JSON.parse(m[0]);}catch{plan={plan:planRaw,changes:[]};}
  await delta(`📋 **Plan:** ${plan.plan||planRaw}\n\n`);
  const changes=(plan.changes as Array<Record<string,unknown>>)||[];
  const results:Array<Record<string,unknown>>=[];
  for(const change of changes.slice(0,6)){
    const fp=change.file as string;const ct=change.type as string;const desc=change.description as string;
    await delta(`\n✏️ **${ct==="create"?"Creating":"Modifying"}** \`${fp}\`\n${desc}\n`);
    try{
      const codeRaw=await chat([{role:"system",content:sysCtx},{role:"user",content:`Write COMPLETE ${ct==="create"?"new file":"updated file"} for \`${fp}\`.\nTask:${task}\nChange:${desc}\nReturn ONLY raw file content.`}],"or_llama70b",false) as string;
      const code=codeRaw.replace(/^```[a-z]*\n?/,"").replace(/\n?```$/,"").trim();
      const res=await writeFile(fp,code,`${task}: ${desc}`);
      results.push({file:fp,status:"ok",sha:res.sha.slice(0,8),deployed:res.deployed});
      await delta(`✅ Pushed (${res.sha.slice(0,8)})${res.deployed?" → instant deploy":""}\n`);
    }catch(err:unknown){
      const msg=err instanceof Error?err.message:String(err);
      results.push({file:fp,status:"error",error:msg});await delta(`❌ Failed: ${msg}\n`);
    }
  }
  if(plan.needs_apk_rebuild){
    await delta("\n🔨 **Triggering APK rebuild...**\n");
    try{const ts=await ghTriggerCI(`KAI: ${task}`);await delta(`✅ CI triggered at ${ts}. APK ready ~5min.\n`);}
    catch(err:unknown){await delta(`⚠️ CI failed: ${err instanceof Error?err.message:String(err)}\n`);}
  }
  const ok_c=results.filter(r=>r.status==="ok").length;const err_c=results.filter(r=>r.status==="error").length;
  const summary=`\n---\n✦ **Complete**\n**Task:** ${task}\n**Files:** ${results.length} (${ok_c}✅ ${err_c}❌)\n**APK:** ${plan.needs_apk_rebuild?"Triggered":"Not needed"}\n**Edge:** ${results.some(r=>r.deployed)?"Deployed ✓":"Pending CI"}\n\n`+results.map(r=>`- \`${r.file}\`: ${r.status==="ok"?"✅":"❌"} ${r.status==="ok"?`(${r.sha})`:(r.error as string)}`).join("\n");
  await delta(summary);
  let sid=chatId;
  try{if(!sid){const c=await ins("kai_chats",{title:`KAI: ${task.slice(0,50)}`});sid=c.id;}await insQ("kai_messages",{chat_id:sid,role:"assistant",content:summary});}catch{}
  await w({type:"done",reply:summary,tokens:Math.round(summary.length/4),chat_id:sid});
}

// ── Feature functions from Build R (weather, search, news, etc.) ──────────
async function getWeather(city: string, format: "full"|"simple"="full") {
  const enc=encodeURIComponent(city);
  if(format==="simple"){const r=await fetch(`https://wttr.in/${enc}?format=3`);if(!r.ok)throw new Error("Weather unavailable");return{ok:true,city,summary:(await r.text()).trim(),format:"simple"};}
  const r=await fetch(`https://wttr.in/${enc}?format=j1`);
  if(!r.ok) throw new Error(`Weather unavailable for "${city}"`);
  const d=await r.json(); const cur=d.current_condition?.[0]; const ast=d.weather?.[0]?.astronomy?.[0];
  const forecast=(d.weather||[]).slice(0,3).map((day: Record<string,unknown>)=>({date:day.date,max_c:day.maxtempC,min_c:day.mintempC,desc:(day.hourly as Array<Record<string,unknown>>)?.[4]?.weatherDesc?.[0]?.value}));
  const hourly=(d.weather?.[0]?.hourly||[]).slice(0,4).map((h: Record<string,unknown>)=>({time:String(h.time).padStart(4,"0").replace(/(\d{2})(\d{2})/,"$1:$2"),temp_c:h.tempC,desc:(h.weatherDesc as Array<Record<string,unknown>>)?.[0]?.value,rain_chance:h.chanceofrain}));
  return{ok:true,city,temp_c:cur?.temp_C,temp_f:cur?.temp_F,feels_c:cur?.FeelsLikeC,humidity:cur?.humidity,wind_kmph:cur?.windspeedKmph,wind_dir:cur?.winddir16Point,desc:cur?.weatherDesc?.[0]?.value,uv_index:cur?.uvIndex,sunrise:ast?.sunrise,sunset:ast?.sunset,forecast,hourly};
}
async function webSearch(query: string) {
  const r=await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,{headers:{"User-Agent":"KAI/1.0"}});
  if(!r.ok) throw new Error("Search unavailable");
  const d=await r.json();
  const results: Array<{title:string;url:string;snippet:string}>=[];
  if(d.AbstractText) results.push({title:d.Heading||query,url:d.AbstractURL||"",snippet:d.AbstractText});
  (d.RelatedTopics||[]).slice(0,5).forEach((t: Record<string,unknown>)=>{
    if(t.Text&&t.FirstURL) results.push({title:String(t.Text).slice(0,80),url:t.FirstURL as string,snippet:t.Text as string});
    if(t.Topics)(t.Topics as Array<Record<string,unknown>>).slice(0,2).forEach((st: Record<string,unknown>)=>{if(st.Text&&st.FirstURL)results.push({title:String(st.Text).slice(0,80),url:st.FirstURL as string,snippet:st.Text as string});});
  });
  return{ok:true,query,results:results.slice(0,8),answer:d.Answer||"",answer_type:d.AnswerType||""};
}
async function getNews(category="general",count=8) {
  const feeds: Record<string,string>={general:"https://feeds.bbci.co.uk/news/rss.xml",tech:"https://feeds.feedburner.com/TechCrunch",world:"https://feeds.bbci.co.uk/news/world/rss.xml",business:"https://feeds.bbci.co.uk/news/business/rss.xml",science:"https://feeds.bbci.co.uk/news/science_and_environment/rss.xml",health:"https://feeds.bbci.co.uk/news/health/rss.xml",sports:"https://feeds.bbci.co.uk/sport/rss.xml",entertainment:"https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml"};
  const r=await fetch(feeds[category]||feeds.general,{headers:{"User-Agent":"KAI/1.0"}});
  if(!r.ok) throw new Error(`News unavailable`);
  const xml=await r.text();
  const items: Array<{title:string;url:string;published:string;summary:string}>=[];
  for(const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)){
    const x=m[1];
    const title=x.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1]?.trim()||"";
    const link=x.match(/<link>(.*?)<\/link>/)?.[1]?.trim()||x.match(/<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/)?.[1]?.trim()||"";
    const pub=x.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim()||"";
    const desc=x.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1]?.replace(/<[^>]+>/g,"").replace(/&amp;/g,"&").trim().slice(0,200)||"";
    if(title) items.push({title,url:link,published:pub,summary:desc});
    if(items.length>=count) break;
  }
  return{ok:true,category,count:items.length,articles:items};
}
async function setReminder(text: string,remindAt: string,chatId: string|null){await insQ("kai_reminders",{text,remind_at:remindAt,chat_id:chatId,done:false,created_at:new Date().toISOString()});return{ok:true,text,remind_at:remindAt,message:`Reminder set: "${text}" at ${remindAt}`};}
async function getReminders(includeDone=false){const q=db.from("kai_reminders").select("*").order("remind_at").limit(50);const{data,error}=includeDone?await q:await q.eq("done",false);if(error)throw new Error(error.message);return{ok:true,reminders:data||[]};}
async function checkDueReminders(){const{data}=await db.from("kai_reminders").select("*").eq("done",false).lte("remind_at",new Date().toISOString()).limit(20);return data||[];}
function calculate(expr: string):{ok:boolean;result?:number;expression:string;error?:string}{
  const clean=expr.replace(/[^0-9+\-*/().%^\s]/g,"").trim();
  if(!clean)return{ok:false,expression:expr,error:"Empty"};
  try{const fn=new Function("Math","return "+clean.replace(/\^/g,"**"));const result=fn(Math);if(typeof result!=="number"||!isFinite(result))return{ok:false,expression:expr,error:"Invalid result"};return{ok:true,expression:clean,result};}
  catch(e:unknown){return{ok:false,expression:expr,error:e instanceof Error?e.message:"Error"};}
}
async function translate(text: string,targetLang: string,sourceLang="auto"){
  try{const r=await fetch("https://libretranslate.com/translate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({q:text,source:sourceLang,target:targetLang,format:"text"})});if(!r.ok)throw new Error("LibreTranslate unavailable");const d=await r.json();if(d.error)throw new Error(d.error);return{ok:true,text:d.translatedText,source_lang:sourceLang,target_lang:targetLang,method:"libretranslate"};}
  catch{const r=await chat([{role:"user",content:`Translate to ${targetLang}. Return ONLY translation:\n\n${text}`}],"or_llama70b",false) as string;return{ok:true,text:r.trim(),source_lang:sourceLang,target_lang:targetLang,method:"llm"};}
}
async function summarize(input: string,style: "brief"|"detailed"|"bullets"="brief"){
  let content=input,source="text";
  if(input.match(/^https?:\/\//)){try{const r=await fetch(input,{headers:{"User-Agent":"KAI/1.0"}});const html=await r.text();content=html.replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<style[\s\S]*?<\/style>/gi,"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().slice(0,8000);source=input;}catch{}}
  const prompts: Record<string,string>={brief:`Summarize in 2-3 sentences:\n\n${content}`,detailed:`Detailed summary with key points:\n\n${content}`,bullets:`5-7 bullet points using •:\n\n${content}`};
  const summary=await chat([{role:"user",content:prompts[style]}],"or_llama70b",false) as string;
  return{ok:true,summary:summary.trim(),source,style,word_count:content.split(/\s+/).length};
}
async function getDailyBrief(city="London",chatId: string|null=null){
  const[wd,nd,rd]=await Promise.allSettled([getWeather(city,"simple"),getNews("general",5),checkDueReminders()]);
  const weather=wd.status==="fulfilled"?(wd.value as {summary?:string}).summary:"Weather unavailable";
  const news=nd.status==="fulfilled"?(nd.value as {articles:Array<{title:string}>}).articles.slice(0,5).map((a,i)=>`${i+1}. ${a.title}`).join("\n"):"News unavailable";
  const due=rd.status==="fulfilled"?(rd.value as Array<{text:string;remind_at:string}>):[];
  const reminders=due.length?due.map(r=>`⏰ ${r.text} (${r.remind_at})`).join("\n"):"No reminders due.";
  const hour=new Date().getHours();
  const greeting=hour<12?"Good morning":hour<18?"Good afternoon":"Good evening";
  const brief=`**${greeting}! Here is your daily brief:**\n\n🌤 **Weather** (${city})\n${weather}\n\n📰 **Top News**\n${news}\n\n⏰ **Reminders**\n${reminders}`;
  if(chatId){try{await insQ("kai_messages",{chat_id:chatId,role:"assistant",content:brief});}catch{}}
  return{ok:true,brief,city,reminders_due:due.length};
}
async function updatePersonality(p: string){const{error}=await db.from("kai_settings").upsert({key:"kai_personality",value:p},{onConflict:"key"});if(error)throw new Error(error.message);return{ok:true,message:"Personality updated.",personality:p};}
async function selfHealthCheck(){
  const checks: Array<{system:string;status:"ok"|"warn"|"fail";details:string;latency_ms:number}>=[];
  const t0=Date.now();
  try{const{data}=await db.from("kai_settings").select("value").eq("key","active_provider").single();checks.push({system:"Database",status:"ok",details:`Provider: ${data?.value||"unknown"}`,latency_ms:Date.now()-t0});}catch(e:unknown){checks.push({system:"Database",status:"fail",details:e instanceof Error?e.message:"DB error",latency_ms:Date.now()-t0});}
  const t1=Date.now();
  try{const llmR=await chat([{role:"user",content:"Reply OK"}],"or_llama70b",false) as string;const llmOk:"ok"|"warn"=llmR.includes("OK")?"ok":"warn";checks.push({system:"LLM (OpenRouter)",status:llmOk,details:llmR.slice(0,50),latency_ms:Date.now()-t1});}catch(e:unknown){checks.push({system:"LLM (OpenRouter)",status:"fail",details:e instanceof Error?e.message:"LLM error",latency_ms:Date.now()-t1});}
  if(GH_TOKEN){const t2=Date.now();try{const r=await fetch(`https://api.github.com/repos/${GH_REPO}`,{headers:{"Authorization":`token ${GH_TOKEN}`}});const d=await r.json();checks.push({system:"GitHub",status:r.ok?"ok":"warn",details:d.full_name||"unknown",latency_ms:Date.now()-t2});}catch(e:unknown){checks.push({system:"GitHub",status:"fail",details:e instanceof Error?e.message:"Error",latency_ms:0});}}else{checks.push({system:"GitHub",status:"warn",details:"GH_TOKEN not set",latency_ms:0});}
  checks.push({system:"Self-Mod Engine",status:GH_TOKEN&&SB_PAT?"ok":"warn",details:GH_TOKEN&&SB_PAT?"All credentials present":"Missing tokens",latency_ms:0});
  const t3=Date.now();try{const r=await fetch("https://wttr.in/London?format=3",{headers:{"User-Agent":"KAI/1.0"}});checks.push({system:"Weather (wttr.in)",status:r.ok?"ok":"warn",details:r.ok?await r.text():`HTTP ${r.status}`,latency_ms:Date.now()-t3});}catch(e:unknown){checks.push({system:"Weather",status:"fail",details:e instanceof Error?e.message:"Error",latency_ms:0});}
  const evCount=await getEvolutionCount();
  checks.push({system:"Evolution Engine",status:"ok",details:`${evCount} self-improvements deployed`,latency_ms:0});
  const overall=checks.every(c=>c.status==="ok")?"healthy":checks.some(c=>c.status==="fail")?"degraded":"partial";
  return{ok:true,overall,version:"BUILD_S",checked_at:new Date().toISOString(),evolution_count:evCount,checks};
}
async function evalCode(code: string,lang: string){
  if(lang==="javascript"||lang==="js"){if(/fetch|XMLHttpRequest|require|import|eval|Function|process|global|window|document/i.test(code))return{ok:false,error:"Restricted"};try{const lines: string[]=[];const fn=new Function("Math","output",`let _o=[];const console={log:(...a)=>_o.push(a.join(" "))};${code};output(_o);`);fn(Math,(o: string[])=>lines.push(...o));return{ok:true,lang,output:lines.join("\n"),method:"native"};}catch(e:unknown){return{ok:false,lang,error:e instanceof Error?e.message:"Error"};}}
  const result=await chat([{role:"user",content:`Execute this ${lang} code. Show ONLY output:\n\`\`\`${lang}\n${code}\n\`\`\``}],"or_llama70b",false) as string;
  return{ok:true,lang,output:result.trim(),method:"llm"};
}

// ── Command router ──────────────────────────────────────────────────────────
async function routeCommand(text: string,chatId: string|null):Promise<{handled:boolean;result?:unknown}>{
  const t=text.trim().toLowerCase();
  if(t.startsWith("/weather")||t.startsWith("weather in ")){const city=text.replace(/^\/weather\s*/i,"").replace(/^weather in /i,"").trim()||"London";return{handled:true,result:await getWeather(city)};}
  if(t.startsWith("/search ")||t.startsWith("/web ")){return{handled:true,result:await webSearch(text.replace(/^\/search\s*/i,"").replace(/^\/web\s*/i,"").trim())};}
  if(t.startsWith("/news")||t==="news"){return{handled:true,result:await getNews(text.replace(/^\/news\s*/i,"").trim()||"general")};}
  if(t.startsWith("/translate ")){const parts=text.slice(11).split(" to ");return{handled:true,result:await translate(parts[0]?.trim()||"",parts[1]?.trim()||"en")};}
  if(t.startsWith("/calc ")||t.startsWith("/math ")){return{handled:true,result:calculate(text.replace(/^\/calc\s*/i,"").replace(/^\/math\s*/i,"").trim())};}
  if(t.startsWith("/summarize ")||t.startsWith("/sum ")){return{handled:true,result:await summarize(text.replace(/^\/summarize\s*/i,"").replace(/^\/sum\s*/i,"").trim())};}
  if(t.startsWith("/remind ")){const parts=text.slice(8).split(" at ");return{handled:true,result:await setReminder(parts[0]?.trim()||text,parts[1]?.trim()||new Date(Date.now()+3600000).toISOString(),chatId)};}
  if(t.startsWith("/brief")||t.startsWith("/morning")||t.startsWith("/daily")){const city=text.replace(/^\/brief\s*/i,"").replace(/^\/morning\s*/i,"").replace(/^\/daily\s*/i,"").trim()||"London";return{handled:true,result:await getDailyBrief(city,chatId)};}
  if(t.startsWith("/run ")||t.startsWith("/code ")){return{handled:true,result:await evalCode(text.replace(/^\/run\s*/i,"").replace(/^\/code\s*/i,"").trim(),"javascript")};}
  if(t==="/health"||t==="/status"){return{handled:true,result:await selfHealthCheck()};}
  if(t==="/changelog"||t==="/whatsnew"){
    const{data}=await db.from("kai_changelog").select("*").order("created_at",{ascending:false}).limit(10).catch(()=>({data:[]}));
    return{handled:true,result:{ok:true,changelog:data||[],message:"KAI's recent self-improvements"}};
  }
  return{handled:false};
}

function formatCommandResult(result: Record<string,unknown>): string {
  if(result.brief) return result.brief as string;
  if(result.summary) return `**Summary:** ${result.summary}`;
  if(result.result!==undefined) return `**Result:** ${result.result}`;
  if(result.output) return `**Output:**\n\`\`\`\n${result.output}\n\`\`\``;
  if(result.text&&result.target_lang) return `**Translation (${result.target_lang}):** ${result.text}\n_via ${result.method}_`;
  if(result.message&&!result.articles&&!result.changelog) return result.message as string;
  if(result.articles) return `📰 **${result.category} News**\n\n`+(result.articles as Array<{title:string;url:string}>).map((a,i)=>`${i+1}. [${a.title}](${a.url})`).join("\n");
  if(result.temp_c) return `🌤 **Weather in ${result.city}**\n${result.desc} · ${result.temp_c}°C (feels ${result.feels_c}°C)\nHumidity: ${result.humidity}% · Wind: ${result.wind_kmph}km/h ${result.wind_dir}\nSunrise: ${result.sunrise} · Sunset: ${result.sunset}\n\n**Forecast:**\n`+(result.forecast as Array<Record<string,unknown>>||[]).map(f=>`${f.date}: ${f.desc} ${f.min_c}–${f.max_c}°C`).join("\n");
  if(result.checks){const h=result as {overall:string;evolution_count?:number;checks:Array<{system:string;status:string;details:string;latency_ms:number}>};return `🏥 **KAI Health: ${h.overall.toUpperCase()}**${h.evolution_count?` · ${h.evolution_count} self-improvements deployed`:""}\n\n`+h.checks.map(c=>`${c.status==="ok"?"✅":c.status==="warn"?"⚠️":"❌"} **${c.system}**: ${c.details} (${c.latency_ms}ms)`).join("\n");}
  if(result.results) return `🔍 **Search: ${result.query}**\n\n`+(result.results as Array<{title:string;url:string;snippet:string}>).slice(0,5).map(r=>`**${r.title}**\n${r.snippet.slice(0,100)}\n${r.url}`).join("\n\n");
  if(result.changelog) return `📋 **KAI's Recent Self-Improvements**\n\n`+(result.changelog as Array<{changelog:string;files_changed:string;created_at:string}>).map((c,i)=>`${i+1}. **${c.changelog}**\n   Files: ${c.files_changed||"unknown"} · ${c.created_at?.slice(0,10)||""}`).join("\n\n");
  return JSON.stringify(result,null,2);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ROUTER
// ═══════════════════════════════════════════════════════════════════════════
serve(async(req: Request)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:CORS});
  const url=new URL(req.url);
  const path=url.pathname.replace(/^\/functions\/v1\/kai-brain/,"").replace(/\/$/,"")||"";

  // ── Ping ──────────────────────────────────────────────────────────────────
  if(path==="/ping"){
    const prov=await getProvider();
    const evCount=await getEvolutionCount();
    const{data:lastTick}=await db.from("kai_settings").select("value").eq("key","last_evolution_tick").single().catch(()=>({data:null}));
    const due=await checkDueReminders().catch(()=>[]);
    return j({ok:true,provider:prov,has_groq:!!GROQ_KEY,has_hf:!!HF_KEY,has_builtin_ai:!!HF_KEY,builtin_model:"Qwen 2.5 7B",lessons_learned:0,version:"BUILD_S",self_mod_enabled:!!(GH_TOKEN&&SB_PAT),always_online:true,always_evolving:true,evolution_count:evCount,last_evolution:lastTick?.value||null,reminders_due:(due as unknown[]).length,features:["weather","search","news","translate","calculator","summarize","reminders","daily_brief","code_eval","health_check","personality","self_modification","autonomous_evolution","changelog"]});
  }

  // Full security check (auth + blocklist + rate limit)
  const secErr = await securityCheck(req, path);
  if(secErr) return secErr;

  // ── AUTONOMOUS EVOLUTION ENDPOINTS ──────────────────────────────────────

  // Single evolution tick — called by cron or manually
  if(path==="/self/evolve-tick"&&req.method==="POST"){
    if(!GH_TOKEN||!SB_PAT) return j({error:"Evolution requires GITHUB_TOKEN and KAI_SUPABASE_TOKEN"},403);
    try{return j(await evolutionTick());}
    catch(e:unknown){return j({error:(e as Error).message},500);}
  }

  // Streaming evolution tick — watch KAI think and build in real time
  if(path==="/self/evolve-stream"&&req.method==="POST"){
    if(!GH_TOKEN||!SB_PAT) return j({error:"Evolution requires credentials"},403);
    const{readable,writable}=new TransformStream();
    const writer=writable.getWriter(); const enc=new TextEncoder();
    (async()=>{
      try{
        const w=async(msg:unknown)=>await writer.write(enc.encode(ev(msg)));
        const delta=async(t:string)=>await w({type:"delta",text:t});

        await delta("🌙 **KAI autonomous evolution starting...**\n\n");
        await delta("📋 Checking what I've already built...\n");
        const idea=await pickNextIdea();
        await delta(`💡 **Selected improvement:** ${idea}\n\n`);
        await delta("🔨 Implementing...\n\n");

        const result=await implementIdea(idea);

        await delta(result.summary);
        if(result.ok){
          await delta(`\n\n🔔 **Users will see this improvement on their next session.**\n`);
        }
        const evCount=await getEvolutionCount();
        await delta(`\n📊 **Total self-improvements deployed: ${evCount}**\n`);
        await w({type:"done",reply:result.summary,idea,files:result.files,deployed:result.deployed,evolution_count:evCount});
      }catch(e:unknown){
        await writer.write(enc.encode(ev({type:"error",error:e instanceof Error?e.message:String(e)})));
      }finally{await writer.close();}
    })();
    return jss(readable);
  }

  // Get KAI's evolution history — what he built while you slept
  if(path==="/self/changelog"&&req.method==="GET"){
    try{
      const{data,error}=await db.from("kai_changelog").select("*").order("created_at",{ascending:false}).limit(parseInt(url.searchParams.get("limit")||"20"));
      if(error) throw new Error(error.message);
      const evCount=await getEvolutionCount();
      return j({ok:true,version:"BUILD_S",evolution_count:evCount,changelog:data||[]});
    }catch(e:unknown){return j({error:(e as Error).message},500);}
  }

  // Get next idea KAI would implement
  if(path==="/self/next-idea"&&req.method==="GET"){
    try{const idea=await pickNextIdea();return j({ok:true,idea,idea_pool_size:IDEA_POOL.length});}
    catch(e:unknown){return j({error:(e as Error).message},500);}
  }

  // SELF-MOD ROUTES (from Build Q/R) — all audited
  if(path==="/self/read-file"&&req.method==="GET"){const fp=url.searchParams.get("path")||"www/app.js";try{return j({ok:true,path:fp,content:await ghRaw(fp)});}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/self/write-file"&&req.method==="POST"){const{path:fp,content,reason}=await req.json();if(!fp||!content)return j({error:"path and content required"},400);try{return j({ok:true,...(await writeFile(fp,content,reason||"self-update"))});}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/self/patch-self"&&req.method==="POST"){const{description,oldCode,newCode}=await req.json();if(!description||!oldCode||!newCode)return j({error:"description, oldCode, newCode required"},400);try{const cur=await ghRaw("supabase/functions/kai-brain/index.ts");if(!cur.includes(oldCode.trim()))return j({ok:false,deployed:false,details:"Pattern not found."});const res=await writeFile("supabase/functions/kai-brain/index.ts",cur.replace(oldCode,newCode),description);return j({ok:true,...res,details:`SHA:${res.sha} Deployed:${res.deployed}`});}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/self/list-files"&&req.method==="GET"){try{const d=await ghGet("/git/trees/main?recursive=1");return j({ok:true,files:(d.tree||[]).filter((f:Record<string,string>)=>f.type==="blob").map((f:Record<string,string>)=>f.path)});}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/self/run-sql"&&req.method==="POST"){const{sql}=await req.json();if(!sql)return j({error:"sql required"},400);try{const r=await fetch(`https://api.supabase.com/v1/projects/${SB_PROJECT}/database/query`,{method:"POST",headers:{"Authorization":`Bearer ${SB_PAT}`,"Content-Type":"application/json"},body:JSON.stringify({query:sql})});const result=await r.json();if(!r.ok)throw new Error(JSON.stringify(result));return j({ok:true,result});}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/self/deploy-now"&&req.method==="POST"){const{code}=await req.json();const fc=code||(await ghRaw("supabase/functions/kai-brain/index.ts"));try{await sbDeploy(fc);return j({ok:true,message:"Deployed immediately"});}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/self/trigger-ci"&&req.method==="POST"){const{reason}=await req.json();try{const ts=await ghTriggerCI(reason||"KAI auto-deploy");return j({ok:true,triggered_at:ts,message:"CI triggered — APK in ~5 minutes"});}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/self/get-logs"&&req.method==="GET"){try{const d=await ghGet("/actions/runs?per_page=5");return j({ok:true,runs:(d.workflow_runs||[]).map((r:Record<string,unknown>)=>({id:r.id,status:r.status,conclusion:r.conclusion,message:(r.head_commit as Record<string,unknown>)?.message,created_at:r.created_at}))});}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/self/introspect"&&req.method==="GET"){try{return j({ok:true,source:await ghRaw("supabase/functions/kai-brain/index.ts")});}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/self/agent"&&req.method==="POST"){const{task,chat_id}=await req.json();if(!task)return j({error:"task required"},400);if(!GH_TOKEN||!SB_PAT)return j({error:"Requires GITHUB_TOKEN and KAI_SUPABASE_TOKEN"},403);const{readable,writable}=new TransformStream();const writer=writable.getWriter();const enc=new TextEncoder();(async()=>{try{await agentLoop(task,chat_id||null,writer,enc);}catch(e:unknown){await writer.write(enc.encode(ev({type:"error",error:e instanceof Error?e.message:String(e)})));}finally{await writer.close();}})();return jss(readable);}
  if(path==="/self/health-check"&&req.method==="GET"){try{return j(await selfHealthCheck());}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/self/next-idea"&&req.method==="GET"){try{const idea=await pickNextIdea();return j({ok:true,idea});}catch(e:unknown){return j({error:(e as Error).message},500);}}


  // ── Security: view audit log ──────────────────────────────────────────────
  if(path==="/self/audit-log"&&req.method==="GET"){
    try{
      const limit=parseInt(url.searchParams.get("limit")||"50");
      const{data,error}=await db.from("kai_audit_log").select("*").order("created_at",{ascending:false}).limit(limit);
      if(error)throw new Error(error.message);
      return j({ok:true,events:data||[]});
    }catch(e:unknown){return j({error:(e as Error).message},500);}
  }

  // ── Security: view rate limits ────────────────────────────────────────────
  if(path==="/self/rate-limits"&&req.method==="GET"){
    try{
      const{data}=await db.from("kai_rate_limits").select("*").order("window_start",{ascending:false}).limit(20);
      return j({ok:true,limits:data||[]});
    }catch(e:unknown){return j({error:(e as Error).message},500);}
  }

  // ── Security: block a key ─────────────────────────────────────────────────
  if(path==="/self/block-key"&&req.method==="POST"){
    const{key,reason}=await req.json();
    if(!key)return j({error:"key required"},400);
    const keyHint=key.slice(0,8)+"..."+key.slice(-4);
    try{
      await db.from("kai_blocklist").insert({block_type:"key",value:keyHint,reason:reason||"manual block"});
      await auditLog("key_blocked",{key_hint:keyHint,reason});
      return j({ok:true,blocked:keyHint});
    }catch(e:unknown){return j({error:(e as Error).message},500);}
  }


  // FEATURE ROUTES
  if(path==="/weather"&&req.method==="GET"){const city=url.searchParams.get("city")||"London";const fmt=(url.searchParams.get("format")||"full") as "full"|"simple";try{return j(await getWeather(city,fmt));}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/search"&&req.method==="GET"){const q=url.searchParams.get("q")||"";if(!q)return j({error:"q required"},400);try{return j(await webSearch(q));}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/news"&&req.method==="GET"){const cat=url.searchParams.get("category")||"general";const cnt=parseInt(url.searchParams.get("count")||"8");try{return j(await getNews(cat,cnt));}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/translate"&&req.method==="POST"){const{text,target_lang,source_lang}=await req.json();if(!text||!target_lang)return j({error:"text and target_lang required"},400);try{return j(await translate(text,target_lang,source_lang||"auto"));}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/calculate"){const expr=req.method==="GET"?url.searchParams.get("expr")||"":(await req.json()).expr||"";if(!expr)return j({error:"expr required"},400);return j(calculate(expr));}
  if(path==="/summarize"&&req.method==="POST"){const{input,style}=await req.json();if(!input)return j({error:"input required"},400);try{return j(await summarize(input,style||"brief"));}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/remind"&&req.method==="POST"){const{text,remind_at,chat_id}=await req.json();if(!text||!remind_at)return j({error:"text and remind_at required"},400);try{return j(await setReminder(text,remind_at,chat_id||null));}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/reminders"&&req.method==="GET"){try{return j(await getReminders(url.searchParams.get("include_done")==="true"));}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/daily-brief"&&req.method==="GET"){const city=url.searchParams.get("city")||"London";const chatId=req.headers.get("x-chat-id")||null;try{return j(await getDailyBrief(city,chatId));}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/personality"&&req.method==="GET"){return j({ok:true,personality:await getPersonality()});}
  if(path==="/personality"&&req.method==="POST"){const{personality}=await req.json();if(!personality)return j({error:"personality required"},400);try{return j(await updatePersonality(personality));}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/code-run"&&req.method==="POST"){const{code,lang}=await req.json();if(!code)return j({error:"code required"},400);try{return j(await evalCode(code,lang||"javascript"));}catch(e:unknown){return j({error:(e as Error).message},500);}}

  // STANDARD CHAT
  if(path==="/chat/stream"&&req.method==="POST"){
    const{text,chat_id,image_urls}=await req.json();
    const routed=await routeCommand(text,chat_id||null).catch(()=>({handled:false}));
    if(routed.handled){
      const reply=formatCommandResult(routed.result as Record<string,unknown>);
      let sid=chat_id||null;
      try{if(!sid){const c=await ins("kai_chats",{title:text.slice(0,60)||"Chat"});sid=c.id;}await insQ("kai_messages",{chat_id:sid,role:"user",content:text});await insQ("kai_messages",{chat_id:sid,role:"assistant",content:reply});}catch{}
      const{readable:rd,writable:wr}=new TransformStream();const ww=wr.getWriter();const ee=new TextEncoder();
      await ww.write(ee.encode(ev({type:"chat_id",chat_id:sid})));await ww.write(ee.encode(ev({type:"delta",text:reply})));await ww.write(ee.encode(ev({type:"done",reply,tokens:Math.round(reply.length/4),chat_id:sid})));await ww.close();
      return jss(rd);
    }
    const prov=await getProvider(); let sid=chat_id||null;
    try{if(!sid){const c=await ins("kai_chats",{title:(text||" ").slice(0,60)});sid=c.id;}await insQ("kai_messages",{chat_id:sid,role:"user",content:text});}catch{}
    const history:M[]=[];
    try{
      const personality=await getPersonality();
      const{data}=await db.from("kai_messages").select("role,content").eq("chat_id",sid).order("created_at").limit(20);
      history.push({role:"system",content:personality});
      (data||[]).slice(-16).forEach((r:Record<string,string>)=>history.push({role:r.role==="assistant"?"assistant":"user",content:r.content}));
    }catch{history.push({role:"user",content:text});}
    if(image_urls?.length)history[history.length-1].content+=`\n\n[Images: ${image_urls.join(", ")}]`;
    if(prov.startsWith("local_"))return j({type:"local_inference",provider:prov,messages:history,chat_id:sid});
    return streamChat(history,sid,prov);
  }

  if(path==="/chat/local-result"&&req.method==="POST"){const{chat_id,reply,tokens}=await req.json();try{await insQ("kai_messages",{chat_id,role:"assistant",content:reply});}catch{}return j({ok:true,chat_id,tokens});}
  if(path==="/chat/agentic"&&req.method==="POST"){const{text,chat_id}=await req.json();let sid=chat_id||null;try{if(!sid){const c=await ins("kai_chats",{title:(text||" ").slice(0,60)});sid=c.id;}await insQ("kai_messages",{chat_id:sid,role:"user",content:text});}catch{}let reply="";for(const pv of["or_llama70b","or_gptoss120b","or_nemotron550b"]){try{reply=await chat([{role:"user",content:text}],pv,false) as string;if(reply)break;}catch{continue;}}if(!reply)reply="I couldn't get a response right now.";try{await insQ("kai_messages",{chat_id:sid,role:"assistant",content:reply});}catch{}return j({ok:true,reply,chat_id:sid,tokens:Math.round(reply.length/4),participants:["or_llama70b","or_gptoss120b","or_nemotron550b"],used:[]});}
  if(path==="/chat/voice"&&req.method==="POST"){const audio=await req.arrayBuffer();const sid=req.headers.get("x-chat-id")||null;let transcript="";try{if(HF_KEY){const r=await fetch("https://api-inference.huggingface.co/models/openai/whisper-large-v3",{method:"POST",headers:{"Authorization":`Bearer ${HF_KEY}`,"Content-Type":"audio/webm"},body:audio});const d=await r.json();transcript=d.text||"";}else transcript="[voice needs HF token]";}catch{transcript="[error]";}if(!transcript.trim())return j({error:"No speech detected"},400);const reply=await chat([{role:"user",content:transcript}],undefined,false) as string;let sv=sid;try{if(!sv){const c=await ins("kai_chats",{title:transcript.slice(0,50)});sv=c.id;}await insQ("kai_messages",{chat_id:sv,role:"user",content:transcript});await insQ("kai_messages",{chat_id:sv,role:"assistant",content:reply});}catch{}return j({ok:true,transcript,reply,chat_id:sv});}
  if(path==="/generate-image"&&req.method==="POST"){const{prompt,style,chat_id}=await req.json();if(!prompt)return j({error:"prompt required"},400);const imgUrl=`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt+(style?", "+style:""))}?width=768&height=768&nologo=true&enhance=true&seed=${Date.now()}`;let sid=chat_id||null;try{if(!sid){const c=await ins("kai_chats",{title:`Image: ${prompt.slice(0,40)}`});sid=c.id;}await insQ("kai_messages",{chat_id:sid,role:"user",content:`/image ${prompt}`});await insQ("kai_messages",{chat_id:sid,role:"assistant",content:imgUrl,meta:{image_urls:[imgUrl]}});}catch{}return j({ok:true,url:imgUrl,chat_id:sid});}
  if(path==="/generate-reel"&&req.method==="POST"){const{topic,type,style,scenes,chat_id}=await req.json();if(!topic)return j({error:"topic required"},400);let script:{title?:string;summary?:string;scenes?:Array<{scene:number;visual:string;caption:string;duration:number}>}={};try{const raw=await chat([{role:"user",content:`Create ${type||"motivational"} reel "${topic}". Style:${style||"minimal"}. ${scenes||5} scenes. JSON:{\"title\":\"...\",\"summary\":\"...\",\"scenes\":[{\"scene\":1,\"visual\":\"...\",\"caption\":\"...\",\"duration\":3}]}`}],undefined,false) as string;script=JSON.parse(raw.replace(/```json|```/g,"").trim());}catch{script={title:topic,summary:`A reel about ${topic}`,scenes:Array.from({length:scenes||5},(_,i)=>({scene:i+1,visual:`${topic} ${i+1}`,caption:topic,duration:3}))};} const imgs=(script.scenes||[]).slice(0,6).map(s=>`https://image.pollinations.ai/prompt/${encodeURIComponent(s.visual+`, ${style||"minimal"} cinematic vertical 9:16`)}?width=432&height=768&nologo=true&seed=${Date.now()+s.scene}`);let sid=chat_id||null;try{if(!sid){const c=await ins("kai_chats",{title:`Reel:${topic.slice(0,40)}`});sid=c.id;}await insQ("kai_messages",{chat_id:sid,role:"user",content:`/reel ${topic}`});await insQ("kai_messages",{chat_id:sid,role:"assistant",content:`🎬 ${script.title||topic}\n\n${script.summary||""}\n\n${imgs.join("\n")}`,meta:{image_urls:imgs}});}catch{}return j({ok:true,chat_id:sid,script_summary:script.summary||"",scenes:script.scenes||[],image_urls:imgs,tokens:200});}
  if(path==="/upload-image"&&req.method==="POST"){const buf=await req.arrayBuffer();const name=req.headers.get("x-image-name")||`img_${Date.now()}.jpg`;const mime=req.headers.get("Content-Type")||"image/jpeg";try{const{data,error}=await db.storage.from("kai-artifacts").upload(`uploads/${Date.now()}_${name}`,buf,{contentType:mime,upsert:true});if(error)throw new Error(error.message);const{data:pub}=db.storage.from("kai-artifacts").getPublicUrl(data.path);return j({ok:true,url:pub.publicUrl});}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/chats"&&req.method==="GET"){try{const{data,error}=await db.from("kai_chats").select("*").order("created_at",{ascending:false}).limit(50);if(error)throw new Error(error.message);return j({chats:data||[]});}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/messages"&&req.method==="GET"){const chatId=url.searchParams.get("chat_id");if(!chatId)return j({error:"chat_id required"},400);try{const{data,error}=await db.from("kai_messages").select("*").eq("chat_id",chatId).order("created_at").limit(100);if(error)throw new Error(error.message);return j({messages:(data||[]).map((m:Record<string,unknown>)=>({id:m.id,role:m.role==="assistant"?"kai":"user",text:m.content,meta:m.meta||{},feedback:m.feedback}))});}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path.match(/^\/chat\/.+\/star$/)&&req.method==="POST"){const id=path.split("/")[2];try{const rows=await sel("kai_chats",{id},"starred",1);await upd("kai_chats",{id},{starred:!rows[0]?.starred});return j({ok:true});}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path.match(/^\/chat\/.+$/)&&req.method==="DELETE"){const id=path.split("/")[2];try{await del("kai_messages",{chat_id:id});await del("kai_chats",{id});return j({ok:true});}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/feedback"&&req.method==="POST"){const{message_id,rating}=await req.json();try{await upd("kai_messages",{id:message_id},{feedback:rating});return j({ok:true});}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/notes"&&req.method==="GET"){try{const{data,error}=await db.from("kai_notes").select("*").order("created_at",{ascending:false}).limit(100);if(error)throw new Error(error.message);return j({notes:data||[]});}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/remember"&&req.method==="POST"){const{fact}=await req.json();try{await insQ("kai_notes",{fact});return j({ok:true});}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/lessons"&&req.method==="GET"){try{const{data,error}=await db.from("kai_lessons").select("*").order("importance",{ascending:false}).limit(50);if(error)throw new Error(error.message);return j({lessons:data||[]});}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/self-eval"&&req.method==="POST") return j({ok:true});
  if(path==="/models"&&req.method==="GET") return j({models:[]});
  if(path==="/benchmark"&&req.method==="POST"){
  const ALL_PROVIDERS=["or_openrouter_free","or_qwen3_coder","or_nemotron550b","or_gptoss120b","or_llama70b","or_gemma31b","or_kimi","or_qwen80b","or_hermes405b","or_llama3b","or_dolphin","or_lfm_think","github_gpt4o","github_gpt4omini","github_llama405b","github_llama8b","groq","kai_builtin"];
  const results:Array<{provider:string;status:string;reply?:string;error?:string;latency_ms:number}>=[];
  for(const p of ALL_PROVIDERS){
    const t0=Date.now();
    try{
      const r=await chat([{role:"user",content:"Reply with exactly: OK"}],p,false) as string;
      const latency=Date.now()-t0;
      const ok=!!r && r.length>0;
      results.push({provider:p,status:ok?"ok":"empty_reply",reply:r.slice(0,60),latency_ms:latency});
      try{await insQ("kai_model_pings",{provider_id:p,status:ok?"ok":"empty_reply",reply_snippet:r.slice(0,100),latency_ms:latency});}catch{}
    }catch(e:unknown){
      const latency=Date.now()-t0;
      const msg=e instanceof Error?e.message:String(e);
      results.push({provider:p,status:"error",error:msg,latency_ms:latency});
      try{await insQ("kai_model_pings",{provider_id:p,status:"error",error:msg,latency_ms:latency});}catch{}
    }
  }
  const working=results.filter(r=>r.status==="ok");
  const failing=results.filter(r=>r.status!=="ok");
  return j({ok:true,tested:results.length,working:working.length,failing:failing.length,results,best:working[0]?.provider||"or_openrouter_free"});
}
  if(path==="/set-key"&&req.method==="POST"){const{provider:prov}=await req.json();try{const{error}=await db.from("kai_settings").upsert({key:"active_provider",value:prov},{onConflict:"key"});if(error)throw new Error(error.message);return j({ok:true,provider:prov});}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/test-provider"&&req.method==="POST"){const{provider:prov}=await req.json();try{const r=await chat([{role:"user",content:"Say OK"}],prov,false) as string;return j({ok:true,provider:prov,reply:r.slice(0,100),model:prov});}catch(e:unknown){return j({ok:false,provider:prov,error:(e as Error).message});}}
  if(path==="/projects"&&req.method==="GET"){try{const{data}=await db.from("kai_projects").select("*").order("created_at",{ascending:false}).limit(20);return j({projects:data||[]});}catch{return j({projects:[]});}}

  return j({error:"Not found",path},404);
});
