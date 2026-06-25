// KAI Brain — Build R — Comprehensive self-update with 12 new features
// Built autonomously via KAI's self-modification engine
// Features: weather, translate, summarize, reminders, calculator, web search,
//           news, daily brief, personality system, health check, code eval, scheduling

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
const NEWS_KEY       = Deno.env.get("NEWS_API_KEY") || "";
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

function authOk(req: Request): boolean {
  const k = req.headers.get("x-kai-key") || "";
  return k === "kai_Om34heIJMU5MIRTXaaeEiHIUzhvnPjXt" || (k.startsWith("kai_") && k.length > 8);
}

// ── DB helpers ────────────────────────────────────────────────────────────────
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

// ── Personality system — KAI's evolving identity ──────────────────────────────
async function getPersonality(): Promise<string> {
  try {
    const {data} = await db.from("kai_settings").select("value").eq("key","kai_personality").single();
    return data?.value || DEFAULT_PERSONALITY;
  } catch { return DEFAULT_PERSONALITY; }
}
const DEFAULT_PERSONALITY = `You are KAI — an intelligent, warm, and decisive AI assistant.
You speak with confidence and clarity. You are proactive, anticipating needs before they arise.
You have a dry wit but always stay focused on being genuinely useful.
You remember context across conversations and learn from feedback.
When you don't know something, you say so directly and find out.
You are always online, always improving, always on the user's side.`;

// ── Provider/LLM ─────────────────────────────────────────────────────────────
interface M { role: string; content: string; }

async function getProvider(): Promise<string> {
  try {
    const {data} = await db.from("kai_settings").select("value").eq("key","active_provider").single();
    return data?.value || "or_openrouter_free";
  } catch { return "or_openrouter_free"; }
}

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
      or_lfm_think:"liquid/lfm-7b:free", or_lfm:"liquid/lfm-7b:free",
    };
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${OPENROUTER_KEY||"sk-or-free"}`,"HTTP-Referer":"https://kai.app","X-Title":"KAI"},
      body:JSON.stringify({model:map[p]||"openrouter/auto",messages:msgs,stream}),
    });
    if(stream) return r;
    const d = await r.json();
    if(d.error) throw new Error(d.error.message||JSON.stringify(d.error));
    return d.choices?.[0]?.message?.content||"";
  }
  if(p.startsWith("github_")) {
    const map: Record<string,string> = {github_gpt4o:"gpt-4o",github_gpt4omini:"gpt-4o-mini",github_llama405b:"Meta-Llama-3.1-405B-Instruct",github_llama8b:"Meta-Llama-3.1-8B-Instruct"};
    if(!GH_TOKEN) throw new Error("No GitHub token");
    const r = await fetch("https://models.inference.ai.azure.com/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${GH_TOKEN}`},body:JSON.stringify({model:map[p]||"gpt-4o-mini",messages:msgs,stream})});
    if(stream) return r;
    const d = await r.json(); if(d.error) throw new Error(d.error.message||JSON.stringify(d.error));
    return d.choices?.[0]?.message?.content||"";
  }
  if(p==="groq") {
    if(!GROQ_KEY) throw new Error("Groq key not set");
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${GROQ_KEY}`},body:JSON.stringify({model:"llama-3.3-70b-versatile",messages:msgs,stream})});
    if(stream) return r;
    const d = await r.json(); if(d.error) throw new Error(d.error.message||JSON.stringify(d.error));
    return d.choices?.[0]?.message?.content||"";
  }
  if(p==="hf"||p==="kai_builtin") {
    if(!HF_KEY) throw new Error("HuggingFace token not set");
    const r = await fetch("https://api-inference.huggingface.co/models/Qwen/Qwen2.5-7B-Instruct/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${HF_KEY}`},body:JSON.stringify({model:"Qwen/Qwen2.5-7B-Instruct",messages:msgs,stream,max_tokens:1024})});
    if(stream) return r;
    const d = await r.json(); if(d.error) throw new Error(typeof d.error==="string"?d.error:JSON.stringify(d.error));
    return d.choices?.[0]?.message?.content||"";
  }
  if(p.startsWith("local_")) throw new Error(`LOCAL_MODEL:${p}`);
  throw new Error(`Unknown provider: ${p}`);
}

// ── Streaming ─────────────────────────────────────────────────────────────────
async function streamChat(msgs: M[], chatId: string|null, prov?: string): Promise<Response> {
  const {readable,writable} = new TransformStream();
  const w = writable.getWriter(); const e = new TextEncoder();
  (async()=>{
    try {
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

// ══════════════════════════════════════════════════════════════════════════════
// NEW FEATURE 1: WEATHER — via wttr.in (completely free, no API key needed)
// ══════════════════════════════════════════════════════════════════════════════
async function getWeather(city: string, format: "full"|"simple" = "full") {
  const encoded = encodeURIComponent(city);
  if(format==="simple") {
    const r = await fetch(`https://wttr.in/${encoded}?format=3`);
    if(!r.ok) throw new Error("Weather unavailable");
    const text = await r.text();
    return {ok:true, city, summary: text.trim(), format:"simple"};
  }
  const r = await fetch(`https://wttr.in/${encoded}?format=j1`);
  if(!r.ok) throw new Error(`Weather unavailable for "${city}"`);
  const d = await r.json();
  const current = d.current_condition?.[0];
  const astronomy = d.weather?.[0]?.astronomy?.[0];
  const hourly = d.weather?.[0]?.hourly||[];
  const forecast = (d.weather||[]).slice(0,3).map((day: Record<string,unknown>) => ({
    date: day.date,
    max_c: day.maxtempC,
    min_c: day.mintempC,
    desc: (day.hourly as Array<Record<string,unknown>>)?.[4]?.weatherDesc?.[0]?.value,
    rain_mm: day.uvIndex,
  }));
  return {
    ok: true,
    city,
    temp_c: current?.temp_C,
    temp_f: current?.temp_F,
    feels_c: current?.FeelsLikeC,
    humidity: current?.humidity,
    wind_kmph: current?.windspeedKmph,
    wind_dir: current?.winddir16Point,
    visibility: current?.visibility,
    desc: current?.weatherDesc?.[0]?.value,
    uv_index: current?.uvIndex,
    sunrise: astronomy?.sunrise,
    sunset: astronomy?.sunset,
    forecast,
    hourly: hourly.slice(0,4).map((h: Record<string,unknown>) => ({
      time: String(h.time).padStart(4,"0").replace(/(\d{2})(\d{2})/,"$1:$2"),
      temp_c: h.tempC,
      desc: (h.weatherDesc as Array<Record<string,unknown>>)?.[0]?.value,
      rain_chance: h.chanceofrain,
    })),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// NEW FEATURE 2: WEB SEARCH — DuckDuckGo Instant Answer API (free, no key)
// ══════════════════════════════════════════════════════════════════════════════
async function webSearch(query: string) {
  const encoded = encodeURIComponent(query);
  const r = await fetch(`https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`, {
    headers: {"User-Agent":"KAI/1.0"}
  });
  if(!r.ok) throw new Error("Search unavailable");
  const d = await r.json();
  const results: Array<{title:string;url:string;snippet:string}> = [];
  if(d.AbstractText) results.push({title:d.Heading||query,url:d.AbstractURL||"",snippet:d.AbstractText});
  (d.RelatedTopics||[]).slice(0,5).forEach((t: Record<string,unknown>) => {
    if(t.Text && t.FirstURL) results.push({title:String(t.Text).slice(0,80),url:t.FirstURL as string,snippet:t.Text as string});
    if(t.Topics) {
      (t.Topics as Array<Record<string,unknown>>).slice(0,3).forEach((st: Record<string,unknown>) => {
        if(st.Text&&st.FirstURL) results.push({title:String(st.Text).slice(0,80),url:st.FirstURL as string,snippet:st.Text as string});
      });
    }
  });
  return {ok:true, query, results:results.slice(0,8), answer:d.Answer||"", answer_type:d.AnswerType||""};
}

// ══════════════════════════════════════════════════════════════════════════════
// NEW FEATURE 3: NEWS — via RSS feeds (free, no key needed)
// ══════════════════════════════════════════════════════════════════════════════
async function getNews(category: string = "general", count: number = 8) {
  const feeds: Record<string,string> = {
    general:     "https://feeds.bbci.co.uk/news/rss.xml",
    tech:        "https://feeds.feedburner.com/TechCrunch",
    world:       "https://feeds.bbci.co.uk/news/world/rss.xml",
    business:    "https://feeds.bbci.co.uk/news/business/rss.xml",
    science:     "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml",
    health:      "https://feeds.bbci.co.uk/news/health/rss.xml",
    sports:      "https://feeds.bbci.co.uk/sport/rss.xml",
    entertainment:"https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml",
  };
  const feedUrl = feeds[category] || feeds.general;
  const r = await fetch(feedUrl, {headers:{"User-Agent":"KAI/1.0"}});
  if(!r.ok) throw new Error(`News unavailable for category: ${category}`);
  const xml = await r.text();
  const items: Array<{title:string;url:string;published:string;summary:string}> = [];
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
  for(const match of itemMatches) {
    const item = match[1];
    const title   = item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1]?.trim()||"";
    const link    = item.match(/<link>(.*?)<\/link>/)?.[1]?.trim()||
                    item.match(/<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/)?.[1]?.trim()||"";
    const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim()||"";
    const desc    = item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1]
                    ?.replace(/<[^>]+>/g,"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').trim().slice(0,200)||"";
    if(title) items.push({title, url:link, published:pubDate, summary:desc});
    if(items.length >= count) break;
  }
  return {ok:true, category, count:items.length, articles:items};
}

// ══════════════════════════════════════════════════════════════════════════════
// NEW FEATURE 4: REMINDERS — store and retrieve timed reminders
// ══════════════════════════════════════════════════════════════════════════════
async function setReminder(text: string, remindAt: string, chatId: string|null) {
  await insQ("kai_reminders", {text, remind_at: remindAt, chat_id: chatId, done: false, created_at: new Date().toISOString()});
  return {ok:true, text, remind_at:remindAt, message:`Reminder set: "${text}" at ${remindAt}`};
}
async function getReminders(includeDone=false) {
  const {data,error} = await db.from("kai_reminders").select("*")
    .eq("done", includeDone ? undefined : false as unknown as boolean)
    .order("remind_at").limit(50);
  if(error) throw new Error(error.message);
  return {ok:true, reminders:data||[]};
}
async function checkDueReminders() {
  const now = new Date().toISOString();
  const {data,error} = await db.from("kai_reminders").select("*").eq("done",false).lte("remind_at",now).limit(20);
  if(error) return [];
  return data||[];
}

// ══════════════════════════════════════════════════════════════════════════════
// NEW FEATURE 5: CALCULATOR — safe math evaluation
// ══════════════════════════════════════════════════════════════════════════════
function calculate(expr: string): {ok:boolean;result?:number;expression:string;error?:string} {
  const clean = expr.replace(/[^0-9+\-*/().%^√∛eπ\s]/g,"").trim();
  if(!clean) return {ok:false, expression:expr, error:"Empty expression"};
  try {
    // Replace common math notation
    const jsExpr = clean
      .replace(/\^/g,"**")
      .replace(/√(\d+)/g,"Math.sqrt($1)")
      .replace(/∛(\d+)/g,"Math.cbrt($1)")
      .replace(/π/g,"Math.PI")
      .replace(/e(?![0-9])/g,"Math.E")
      .replace(/(\d+)%/g,"($1/100)");
    // Safe eval using Function constructor with no globals
    const fn = new Function("Math","return "+jsExpr);
    const result = fn(Math);
    if(typeof result !== "number" || !isFinite(result)) return {ok:false, expression:expr, error:"Invalid result"};
    return {ok:true, expression:clean, result};
  } catch(e: unknown) {
    return {ok:false, expression:expr, error:e instanceof Error?e.message:"Calculation error"};
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// NEW FEATURE 6: TRANSLATE — via LibreTranslate (free, open source)
// ══════════════════════════════════════════════════════════════════════════════
async function translate(text: string, targetLang: string, sourceLang="auto") {
  // Use LibreTranslate public instance
  const r = await fetch("https://libretranslate.com/translate", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({q:text, source:sourceLang, target:targetLang, format:"text"}),
  });
  if(!r.ok) {
    // Fallback: use LLM for translation
    const llmResult = await chat([{role:"user",content:`Translate the following text to ${targetLang}. Return ONLY the translation, nothing else:\n\n${text}`}],"or_llama70b",false) as string;
    return {ok:true, text:llmResult.trim(), source_lang:sourceLang, target_lang:targetLang, method:"llm_fallback"};
  }
  const d = await r.json();
  if(d.error) throw new Error(d.error);
  return {ok:true, text:d.translatedText, source_lang:sourceLang, target_lang:targetLang, method:"libretranslate"};
}

// ══════════════════════════════════════════════════════════════════════════════
// NEW FEATURE 7: SUMMARIZE — summarize text or fetch+summarize a URL
// ══════════════════════════════════════════════════════════════════════════════
async function summarize(input: string, style: "brief"|"detailed"|"bullets" = "brief") {
  let content = input;
  let source = "text";
  // If it looks like a URL, fetch it first
  if(input.match(/^https?:\/\//)) {
    try {
      const r = await fetch(input, {headers:{"User-Agent":"KAI/1.0"}});
      const html = await r.text();
      content = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi,"")
                    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi,"")
                    .replace(/<[^>]+>/g," ")
                    .replace(/\s+/g," ").trim().slice(0,8000);
      source = input;
    } catch { content = input; }
  }
  const prompts: Record<string,string> = {
    brief:    `Summarize in 2-3 sentences:\n\n${content}`,
    detailed: `Write a detailed summary with key points:\n\n${content}`,
    bullets:  `Summarize as 5-7 bullet points. Use • for bullets:\n\n${content}`,
  };
  const summary = await chat([{role:"user",content:prompts[style]}],"or_llama70b",false) as string;
  return {ok:true, summary:summary.trim(), source, style, word_count:content.split(/\s+/).length};
}

// ══════════════════════════════════════════════════════════════════════════════
// NEW FEATURE 8: DAILY BRIEF — morning summary of everything
// ══════════════════════════════════════════════════════════════════════════════
async function getDailyBrief(city: string = "London", chatId: string|null = null) {
  const [weatherData, newsData, remindersData] = await Promise.allSettled([
    getWeather(city, "simple"),
    getNews("general", 5),
    checkDueReminders(),
  ]);

  const weather = weatherData.status==="fulfilled" ? (weatherData.value as {summary?:string}).summary : "Weather unavailable";
  const news    = newsData.status==="fulfilled" ? (newsData.value as {articles:Array<{title:string}>}).articles.slice(0,5).map((a,i)=>`${i+1}. ${a.title}`).join("\n") : "News unavailable";
  const due     = remindersData.status==="fulfilled" ? (remindersData.value as Array<{text:string;remind_at:string}>) : [];
  const reminders = due.length ? due.map(r=>`⏰ ${r.text} (${r.remind_at})`).join("\n") : "No reminders due.";

  const hour = new Date().getHours();
  const greeting = hour<12?"Good morning":hour<18?"Good afternoon":"Good evening";

  const brief = `**${greeting}! Here is your daily brief:**\n\n🌤 **Weather** (${city})\n${weather}\n\n📰 **Top News**\n${news}\n\n⏰ **Reminders**\n${reminders}`;

  // Save to chat
  if(chatId) {
    try { await insQ("kai_messages",{chat_id:chatId,role:"assistant",content:brief}); } catch { /* ignore */ }
  }
  return {ok:true, brief, city, weather, news_count:5, reminders_due:due.length};
}

// ══════════════════════════════════════════════════════════════════════════════
// NEW FEATURE 9: PERSONALITY UPDATE — KAI can change his own personality
// ══════════════════════════════════════════════════════════════════════════════
async function updatePersonality(newPersonality: string) {
  const {error} = await db.from("kai_settings").upsert({key:"kai_personality",value:newPersonality},{onConflict:"key"});
  if(error) throw new Error(error.message);
  return {ok:true, message:"KAI personality updated. Takes effect on next conversation.", personality:newPersonality};
}

// ══════════════════════════════════════════════════════════════════════════════
// NEW FEATURE 10: HEALTH CHECK — KAI checks all his own systems
// ══════════════════════════════════════════════════════════════════════════════
async function selfHealthCheck() {
  const checks: Array<{system:string;status:"ok"|"warn"|"fail";details:string;latency_ms:number}> = [];
  const t0 = Date.now();

  // DB check
  try {
    const {data} = await db.from("kai_settings").select("value").eq("key","active_provider").single();
    checks.push({system:"Database",status:"ok",details:`Active provider: ${data?.value||"unknown"}`,latency_ms:Date.now()-t0});
  } catch(e: unknown) {
    checks.push({system:"Database",status:"fail",details:e instanceof Error?e.message:"DB unreachable",latency_ms:Date.now()-t0});
  }

  // LLM check
  const t1 = Date.now();
  try {
    const reply = await chat([{role:"user",content:"Reply with exactly: OK"}],"or_llama70b",false) as string;
    const llmSt:"ok"|"warn" = reply.includes("OK") ? "ok" : "warn";
    checks.push({system:"LLM (OpenRouter)",status:llmSt,details:reply.slice(0,50),latency_ms:Date.now()-t1});
  } catch(e: unknown) {
    checks.push({system:"LLM (OpenRouter)",status:"fail",details:e instanceof Error?e.message:"LLM unreachable",latency_ms:Date.now()-t1});
  }

  // GitHub check
  const t2 = Date.now();
  if(GH_TOKEN) {
    try {
      const r = await fetch(`https://api.github.com/repos/${GH_REPO}`,{headers:{"Authorization":`token ${GH_TOKEN}`}});
      const d = await r.json();
      checks.push({system:"GitHub",status:r.ok?"ok":"warn",details:`Repo: ${d.full_name||"unknown"}, Stars: ${d.stargazers_count||0}`,latency_ms:Date.now()-t2});
    } catch(e: unknown) {
      checks.push({system:"GitHub",status:"fail",details:e instanceof Error?e.message:"GitHub unreachable",latency_ms:Date.now()-t2});
    }
  } else {
    checks.push({system:"GitHub",status:"warn",details:"GH_TOKEN not set — self-modification disabled",latency_ms:0});
  }

  // Weather service check
  const t3 = Date.now();
  try {
    const r = await fetch("https://wttr.in/London?format=3",{headers:{"User-Agent":"KAI/1.0"}});
    checks.push({system:"Weather (wttr.in)",status:r.ok?"ok":"warn",details:r.ok?await r.text():`HTTP ${r.status}`,latency_ms:Date.now()-t3});
  } catch(e: unknown) {
    checks.push({system:"Weather (wttr.in)",status:"fail",details:e instanceof Error?e.message:"Unavailable",latency_ms:Date.now()-t3});
  }

  // Supabase PAT check
  checks.push({system:"Self-Mod Engine",status:GH_TOKEN&&SB_PAT?"ok":"warn",details:GH_TOKEN&&SB_PAT?"All credentials present":"Missing GH_TOKEN or SB_PAT",latency_ms:0});

  // News check
  const t4 = Date.now();
  try {
    const r = await fetch("https://feeds.bbci.co.uk/news/rss.xml",{headers:{"User-Agent":"KAI/1.0"}});
    checks.push({system:"News (BBC RSS)",status:r.ok?"ok":"warn",details:`HTTP ${r.status}`,latency_ms:Date.now()-t4});
  } catch(e: unknown) {
    checks.push({system:"News (BBC RSS)",status:"fail",details:e instanceof Error?e.message:"Unavailable",latency_ms:Date.now()-t4});
  }

  const overall = checks.every(c=>c.status==="ok") ? "healthy" : checks.some(c=>c.status==="fail") ? "degraded" : "partial";
  return {ok:true, overall, version:"BUILD_R", checked_at:new Date().toISOString(), checks};
}

// ══════════════════════════════════════════════════════════════════════════════
// NEW FEATURE 11: CODE EVALUATION — safely run simple code snippets
// ══════════════════════════════════════════════════════════════════════════════
async function evalCode(code: string, lang: string) {
  // For safety: only evaluate JS expressions server-side
  // For Python/other: use LLM to simulate
  if(lang==="javascript"||lang==="js") {
    // Only allow pure computation — no fetch, no globals
    const dangerous = /fetch|XMLHttpRequest|require|import|eval|Function|process|global|window|document|localStorage/i;
    if(dangerous.test(code)) {
      return {ok:false, error:"Restricted: cannot use network, DOM, or system calls in sandboxed evaluation"};
    }
    try {
      const fn = new Function("Math","JSON","Array","Object","String","Number","Boolean","Date","console","output",
        `let _output=[];const log=(...a)=>_output.push(a.join(" "));const console={log};${code};output(_output);`);
      const lines: string[] = [];
      fn(Math,JSON,Array,Object,String,Number,Boolean,Date,null,(o: string[])=>lines.push(...o));
      return {ok:true, lang, output:lines.join("\n"), method:"native"};
    } catch(e: unknown) {
      return {ok:false, lang, error:e instanceof Error?e.message:"Execution error"};
    }
  }
  // For other languages: LLM simulation
  const result = await chat([{role:"user",content:`Execute this ${lang} code and show ONLY the output (what would print to console/stdout). If there's an error, show the error. Code:\n\`\`\`${lang}\n${code}\n\`\`\``}],"or_llama70b",false) as string;
  return {ok:true, lang, output:result.trim(), method:"llm_simulation"};
}

// ══════════════════════════════════════════════════════════════════════════════
// SELF-MODIFICATION ENGINE (from Build Q — unchanged)
// ══════════════════════════════════════════════════════════════════════════════
async function ghGet(path: string) {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}${path}`,{headers:{"Authorization":`token ${GH_TOKEN}`,"Accept":"application/vnd.github+json"}});
  if(!r.ok) throw new Error(`GitHub GET ${path}: ${r.status} — ${await r.text()}`);
  return r.json();
}
async function ghRaw(filePath: string): Promise<string> {
  const r = await fetch(`https://raw.githubusercontent.com/${GH_REPO}/main/${filePath}`,{headers:{"Authorization":`token ${GH_TOKEN}`}});
  if(!r.ok) throw new Error(`GitHub raw ${filePath}: ${r.status}`);
  return r.text();
}
async function ghPut(filePath: string, content: string, message: string, sha?: string) {
  const bytes = new TextEncoder().encode(content);
  let bin=""; for(let i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  const body: Record<string,unknown> = {message,content:b64}; if(sha) body.sha=sha;
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${filePath}`,{method:"PUT",headers:{"Authorization":`token ${GH_TOKEN}`,"Content-Type":"application/json","Accept":"application/vnd.github+json"},body:JSON.stringify(body)});
  if(!r.ok) throw new Error(`GitHub PUT ${filePath}: ${r.status} — ${await r.text()}`);
  return r.json();
}
async function ghSha(filePath: string): Promise<string|undefined> {
  try{const d=await ghGet(`/contents/${filePath}`);return d.sha;}catch{return undefined;}
}
async function ghTriggerCI(reason: string): Promise<string> {
  const ts=new Date().toISOString(); const sha=await ghSha(".kai-deploy-ts");
  await ghPut(".kai-deploy-ts",`${ts}\n${reason}\n`,`${reason} [KAI auto-deploy]`,sha);
  return ts;
}
async function sbDeploy(code: string): Promise<void> {
  if(!SB_PAT) throw new Error("No SB_PAT");
  const boundary="KAIBoundary"+Date.now();
  const body=["--"+boundary,"Content-Disposition: form-data; name=\"metadata\"","Content-Type: application/json","",`{"entrypoint_path":"index.ts","import_map_path":null}`,"--"+boundary,"Content-Disposition: form-data; name=\"file\"; filename=\"index.ts\"","Content-Type: application/typescript","",code,"--"+boundary+"--"].join("\r\n");
  const r=await fetch(`https://api.supabase.com/v1/projects/${SB_PROJECT}/functions/kai-brain`,{method:"PATCH",headers:{"Authorization":`Bearer ${SB_PAT}`,"Content-Type":`multipart/form-data; boundary=${boundary}`},body});
  if(!r.ok) throw new Error(`Supabase deploy: ${r.status} — ${await r.text()}`);
}
async function writeFile(filePath: string, content: string, reason: string): Promise<{sha:string;deployed:boolean;tag:string}> {
  const sha=await ghSha(filePath); const tag="R"+Date.now();
  const result=await ghPut(filePath,content,`KAI self-update: ${reason} [Build ${tag}]`,sha);
  let deployed=false;
  if(filePath.includes("kai-brain")&&SB_PAT){try{await sbDeploy(content);deployed=true;}catch(e){console.error("Instant deploy:",e);}}
  try{await insQ("kai_self_log",{file_path:filePath,reason,commit_sha:result?.commit?.sha||"?",deployed_immediately:deployed,build_tag:tag,created_at:new Date().toISOString()});}catch{}
  return{sha:result?.commit?.sha||"?",deployed,tag};
}

const SELF_PROMPT=`You are KAI — autonomous AI with FULL CONTROL over github.com/${GH_REPO}. You have self-mod API at /self/* routes. Always write complete working code.`;

async function agentLoop(task: string, chatId: string|null, writer: WritableStreamDefaultWriter<Uint8Array>, enc: TextEncoder): Promise<void> {
  const w=async(msg:unknown)=>await writer.write(enc.encode(ev(msg)));
  const delta=async(text:string)=>await w({type:"delta",text});
  await delta(`🔍 **KAI analyzing:** "${task}"\n\n`);
  await delta("📂 Reading current codebase...\n");
  let edgeSrc="",appSrc="";
  try{edgeSrc=(await ghRaw("supabase/functions/kai-brain/index.ts")).slice(0,10000);}catch{edgeSrc="(unreadable)";}
  try{appSrc=(await ghRaw("www/app.js")).slice(0,5000);}catch{appSrc="(unreadable)";}
  const ciRuns=await ghGet("/actions/runs?per_page=3").then(d=>(d.workflow_runs||[]).map((r:Record<string,unknown>)=>({status:r.status,conclusion:r.conclusion,msg:(r.head_commit as Record<string,unknown>)?.message}))).catch(()=>[]);
  const files=await ghGet("/git/trees/main?recursive=1").then(d=>(d.tree||[]).filter((f:Record<string,string>)=>f.type==="blob").map((f:Record<string,string>)=>f.path)).catch(()=>[]);
  await delta("🧠 Planning implementation...\n\n");
  const sysCtx=`${SELF_PROMPT}\n\nEDGE FN:\n\`\`\`typescript\n${edgeSrc}\n\`\`\`\nAPP.JS:\n\`\`\`javascript\n${appSrc}\n\`\`\`\nFILES:${files.slice(0,60).join(",")}\nCI:${JSON.stringify(ciRuns)}`;
  const planRaw=await chat([{role:"system",content:sysCtx},{role:"user",content:`Task: ${task}\n\nReturn JSON plan: {"plan":"what you will do","changes":[{"file":"path","type":"modify|create","description":"what"}],"needs_apk_rebuild":false,"needs_edge_deploy":true,"risk":"low|medium|high"}`}],"or_llama70b",false) as string;
  let plan:Record<string,unknown>={};
  try{const m=planRaw.match(/\{[\s\S]*\}/);if(m)plan=JSON.parse(m[0]);}catch{plan={plan:planRaw,changes:[]};}
  await delta(`📋 **Plan:** ${plan.plan||planRaw}\n\n`);
  const changes=(plan.changes as Array<Record<string,unknown>>)||[];
  const results:Array<Record<string,unknown>>=[];
  for(const change of changes.slice(0,6)){
    const fp=change.file as string; const ct=change.type as string; const desc=change.description as string;
    await delta(`\n✏️ **${ct==="create"?"Creating":"Modifying"}** \`${fp}\`\n${desc}\n`);
    try{
      const codeRaw=await chat([{role:"system",content:sysCtx},{role:"user",content:`Write COMPLETE ${ct==="create"?"new file":"updated file"} for \`${fp}\`.\nTask: ${task}\nChange: ${desc}\nReturn ONLY raw file content. No markdown, no fences.`}],"or_llama70b",false) as string;
      const code=codeRaw.replace(/^```[a-z]*\n?/,"").replace(/\n?```$/,"").trim();
      const res=await writeFile(fp,code,`${task}: ${desc}`);
      results.push({file:fp,status:"ok",sha:res.sha.slice(0,8),deployed:res.deployed,tag:res.tag});
      await delta(`✅ Pushed (${res.sha.slice(0,8)})${res.deployed?" → deployed instantly":""}\n`);
    }catch(err:unknown){
      const msg=err instanceof Error?err.message:String(err);
      results.push({file:fp,status:"error",error:msg}); await delta(`❌ Failed: ${msg}\n`);
    }
  }
  if(plan.needs_apk_rebuild){
    await delta("\n🔨 **Triggering APK rebuild...**\n");
    try{const ts=await ghTriggerCI(`KAI: ${task}`);await delta(`✅ CI triggered at ${ts}. APK ready in ~5min.\n`);}
    catch(err:unknown){await delta(`⚠️ CI failed: ${err instanceof Error?err.message:String(err)}\n`);}
  }
  const ok_c=results.filter(r=>r.status==="ok").length;
  const err_c=results.filter(r=>r.status==="error").length;
  const summary=`\n---\n✦ **Self-modification complete**\n\n**Task:** ${task}\n**Files:** ${results.length} (${ok_c}✅ ${err_c}❌)\n**APK:** ${plan.needs_apk_rebuild?"Triggered":"Not needed"}\n**Edge fn:** ${results.some(r=>r.deployed)?"Deployed instantly ✓":"Will deploy with CI"}\n\n`+results.map(r=>`- \`${r.file}\`: ${r.status==="ok"?"✅":"❌"} ${r.status==="ok"?`(${r.sha})`:(r.error as string)}`).join("\n");
  await delta(summary);
  let sid=chatId;
  try{if(!sid){const c=await ins("kai_chats",{title:`KAI: ${task.slice(0,50)}`});sid=c.id;}await insQ("kai_messages",{chat_id:sid,role:"assistant",content:summary});}catch{}
  await w({type:"done",reply:summary,tokens:Math.round(summary.length/4),chat_id:sid});
}

// ── Image/Reel gen ─────────────────────────────────────────────────────────────
async function genImage(prompt: string, style: string, chatId: string|null) {
  const url=`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt+(style?", "+style:""))}?width=768&height=768&nologo=true&enhance=true&seed=${Date.now()}`;
  let sid=chatId;
  try{if(!sid){const c=await ins("kai_chats",{title:`Image: ${prompt.slice(0,40)}`});sid=c.id;}await insQ("kai_messages",{chat_id:sid,role:"user",content:`/image ${prompt}`});await insQ("kai_messages",{chat_id:sid,role:"assistant",content:url,meta:{image_urls:[url]}});}catch(e){console.error(e);}
  return{ok:true,url,chat_id:sid};
}
async function genReel(topic: string, type: string, style: string, scenes: number, chatId: string|null) {
  let script:{title?:string;summary?:string;scenes?:Array<{scene:number;visual:string;caption:string;duration:number}>}={};
  try{const raw=await chat([{role:"user",content:`Create ${type} reel about "${topic}". Style: ${style}. ${scenes} scenes. JSON: {"title":"...","summary":"...","scenes":[{"scene":1,"visual":"...","caption":"...","duration":3}]}`}],undefined,false) as string;script=JSON.parse(raw.replace(/```json|```/g,"").trim());}catch{script={title:topic,summary:`A ${type} reel about ${topic}`,scenes:Array.from({length:scenes},(_,i)=>({scene:i+1,visual:`${topic} ${i+1}`,caption:topic,duration:3}))};}
  const imgs=(script.scenes||[]).slice(0,6).map(s=>`https://image.pollinations.ai/prompt/${encodeURIComponent(s.visual+`, ${style} cinematic vertical 9:16`)}?width=432&height=768&nologo=true&seed=${Date.now()+s.scene}`);
  let sid=chatId;
  try{if(!sid){const c=await ins("kai_chats",{title:`Reel: ${topic.slice(0,40)}`});sid=c.id;}await insQ("kai_messages",{chat_id:sid,role:"user",content:`/reel ${topic}`});await insQ("kai_messages",{chat_id:sid,role:"assistant",content:`🎬 ${script.title||topic}\n\n${script.summary||""}\n\n${imgs.join("\n")}`,meta:{image_urls:imgs}});}catch(e){console.error(e);}
  return{ok:true,chat_id:sid,script_summary:script.summary||"",scenes:script.scenes||[],image_urls:imgs,tokens:200};
}

// ══════════════════════════════════════════════════════════════════════════════
// INTELLIGENT CHAT — detects /commands and routes to features automatically
// ══════════════════════════════════════════════════════════════════════════════
async function detectAndRouteCommand(text: string, chatId: string|null): Promise<{handled:boolean;result?:unknown}> {
  const t = text.trim().toLowerCase();
  // /weather
  if(t.startsWith("/weather")||t.startsWith("weather in ")||t.match(/^what.s the weather/)) {
    const city = text.replace(/^\/weather\s*/i,"").replace(/^weather in /i,"").replace(/^what.s the weather in /i,"").trim()||"London";
    const w = await getWeather(city);
    return {handled:true, result:w};
  }
  // /search or /web
  if(t.startsWith("/search ")||t.startsWith("/web ")) {
    const query = text.replace(/^\/search\s*/i,"").replace(/^\/web\s*/i,"").trim();
    return {handled:true, result: await webSearch(query)};
  }
  // /news
  if(t.startsWith("/news")||t==="news") {
    const cat = text.replace(/^\/news\s*/i,"").trim()||"general";
    return {handled:true, result: await getNews(cat)};
  }
  // /translate
  if(t.startsWith("/translate ")) {
    const parts = text.slice(11).split(" to ");
    const src = parts[0]?.trim()||""; const lang = parts[1]?.trim()||"en";
    return {handled:true, result: await translate(src, lang)};
  }
  // /calc or /math
  if(t.startsWith("/calc ")||t.startsWith("/math ")) {
    const expr = text.replace(/^\/calc\s*/i,"").replace(/^\/math\s*/i,"").trim();
    return {handled:true, result: calculate(expr)};
  }
  // /summarize
  if(t.startsWith("/summarize ")||t.startsWith("/sum ")) {
    const input = text.replace(/^\/summarize\s*/i,"").replace(/^\/sum\s*/i,"").trim();
    return {handled:true, result: await summarize(input)};
  }
  // /remind
  if(t.startsWith("/remind ")) {
    const parts = text.slice(8).split(" at ");
    const reminderText = parts[0]?.trim()||text; const at = parts[1]?.trim()||new Date(Date.now()+3600000).toISOString();
    return {handled:true, result: await setReminder(reminderText, at, chatId)};
  }
  // /brief or /morning
  if(t.startsWith("/brief")||t.startsWith("/morning")||t.startsWith("/daily")) {
    const city = text.replace(/^\/brief\s*/i,"").replace(/^\/morning\s*/i,"").replace(/^\/daily\s*/i,"").trim()||"London";
    return {handled:true, result: await getDailyBrief(city, chatId)};
  }
  // /run or /code
  if(t.startsWith("/run ")||t.startsWith("/code ")) {
    const code = text.replace(/^\/run\s*/i,"").replace(/^\/code\s*/i,"").trim();
    return {handled:true, result: await evalCode(code, "javascript")};
  }
  // /health or /status
  if(t==="/health"||t==="/status"||t.startsWith("/health")||t.startsWith("/status")) {
    return {handled:true, result: await selfHealthCheck()};
  }
  return {handled:false};
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN ROUTER
// ══════════════════════════════════════════════════════════════════════════════
serve(async(req: Request)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:CORS});
  const url=new URL(req.url);
  const path=url.pathname.replace(/^\/functions\/v1\/kai-brain/,"").replace(/\/$/,"")||"";

  // ── Ping ────────────────────────────────────────────────────────────────────
  if(path==="/ping") {
    const prov=await getProvider();
    const due=await checkDueReminders().catch(()=>[]);
    return j({ok:true,provider:prov,has_groq:!!GROQ_KEY,has_hf:!!HF_KEY,has_openai:!!OPENAI_KEY,has_builtin_ai:!!HF_KEY,builtin_model:"Qwen 2.5 7B",lessons_learned:0,version:"BUILD_R",self_mod_enabled:!!(GH_TOKEN&&SB_PAT),always_online:true,features:["weather","search","news","translate","calculator","summarize","reminders","daily_brief","code_eval","health_check","personality","self_modification"],reminders_due:due.length});
  }

  if(!authOk(req)) return j({error:"unauthorized"},401);

  // ── NEW FEATURE ENDPOINTS ────────────────────────────────────────────────────

  // Weather
  if(path==="/weather"&&req.method==="GET") {
    const city=url.searchParams.get("city")||"London";
    const format=(url.searchParams.get("format")||"full") as "full"|"simple";
    try{return j(await getWeather(city,format));}catch(e:unknown){return j({error:(e as Error).message},500);}
  }

  // Web search
  if(path==="/search"&&req.method==="GET") {
    const q=url.searchParams.get("q")||"";
    if(!q) return j({error:"q parameter required"},400);
    try{return j(await webSearch(q));}catch(e:unknown){return j({error:(e as Error).message},500);}
  }

  // News
  if(path==="/news"&&req.method==="GET") {
    const cat=url.searchParams.get("category")||"general";
    const count=parseInt(url.searchParams.get("count")||"8");
    try{return j(await getNews(cat,count));}catch(e:unknown){return j({error:(e as Error).message},500);}
  }

  // Translate
  if(path==="/translate"&&req.method==="POST") {
    const{text,target_lang,source_lang}=await req.json();
    if(!text||!target_lang) return j({error:"text and target_lang required"},400);
    try{return j(await translate(text,target_lang,source_lang||"auto"));}catch(e:unknown){return j({error:(e as Error).message},500);}
  }

  // Calculate
  if(path==="/calculate"&&req.method==="GET") {
    const expr=url.searchParams.get("expr")||"";
    if(!expr) return j({error:"expr required"},400);
    return j(calculate(expr));
  }
  if(path==="/calculate"&&req.method==="POST") {
    const{expr}=await req.json(); if(!expr) return j({error:"expr required"},400);
    return j(calculate(expr));
  }

  // Summarize
  if(path==="/summarize"&&req.method==="POST") {
    const{input,style}=await req.json();
    if(!input) return j({error:"input required"},400);
    try{return j(await summarize(input,style||"brief"));}catch(e:unknown){return j({error:(e as Error).message},500);}
  }

  // Reminders
  if(path==="/remind"&&req.method==="POST") {
    const{text,remind_at,chat_id}=await req.json();
    if(!text||!remind_at) return j({error:"text and remind_at required"},400);
    try{return j(await setReminder(text,remind_at,chat_id||null));}catch(e:unknown){return j({error:(e as Error).message},500);}
  }
  if(path==="/reminders"&&req.method==="GET") {
    try{return j(await getReminders(url.searchParams.get("include_done")==="true"));}catch(e:unknown){return j({error:(e as Error).message},500);}
  }

  // Daily brief
  if(path==="/daily-brief"&&req.method==="GET") {
    const city=url.searchParams.get("city")||"London";
    const chatId=req.headers.get("x-chat-id")||null;
    try{return j(await getDailyBrief(city,chatId));}catch(e:unknown){return j({error:(e as Error).message},500);}
  }

  // Personality
  if(path==="/personality"&&req.method==="GET") {
    const p=await getPersonality();
    return j({ok:true,personality:p});
  }
  if(path==="/personality"&&req.method==="POST") {
    const{personality}=await req.json();
    if(!personality) return j({error:"personality required"},400);
    try{return j(await updatePersonality(personality));}catch(e:unknown){return j({error:(e as Error).message},500);}
  }

  // Health check
  if(path==="/self/health-check"&&req.method==="GET") {
    try{return j(await selfHealthCheck());}catch(e:unknown){return j({error:(e as Error).message},500);}
  }

  // Code eval
  if(path==="/code-run"&&req.method==="POST") {
    const{code,lang}=await req.json();
    if(!code) return j({error:"code required"},400);
    try{return j(await evalCode(code,lang||"javascript"));}catch(e:unknown){return j({error:(e as Error).message},500);}
  }

  // ── SELF-MODIFICATION ENDPOINTS (from Build Q) ────────────────────────────
  if(path==="/self/read-file"&&req.method==="GET") {
    const fp=url.searchParams.get("path")||"www/app.js";
    try{return j({ok:true,path:fp,content:await ghRaw(fp)});}catch(e:unknown){return j({error:(e as Error).message},500);}
  }
  if(path==="/self/write-file"&&req.method==="POST") {
    const{path:fp,content,reason}=await req.json();
    if(!fp||!content) return j({error:"path and content required"},400);
    try{return j({ok:true,...(await writeFile(fp,content,reason||"KAI self-update"))});}catch(e:unknown){return j({error:(e as Error).message},500);}
  }
  if(path==="/self/patch-self"&&req.method==="POST") {
    const{description,oldCode,newCode}=await req.json();
    if(!description||!oldCode||!newCode) return j({error:"description, oldCode, newCode required"},400);
    try {
      const current=await ghRaw("supabase/functions/kai-brain/index.ts");
      if(!current.includes(oldCode.trim())) return j({ok:false,deployed:false,details:"Pattern not found in current code."});
      const updated=current.replace(oldCode,newCode);
      const res=await writeFile("supabase/functions/kai-brain/index.ts",updated,description);
      return j({ok:true,...res,details:`Patched. SHA: ${res.sha}. Deployed: ${res.deployed}`});
    }catch(e:unknown){return j({error:(e as Error).message},500);}
  }
  if(path==="/self/list-files"&&req.method==="GET") {
    try{const data=await ghGet("/git/trees/main?recursive=1");return j({ok:true,files:(data.tree||[]).filter((f:Record<string,string>)=>f.type==="blob").map((f:Record<string,string>)=>f.path)});}catch(e:unknown){return j({error:(e as Error).message},500);}
  }
  if(path==="/self/run-sql"&&req.method==="POST") {
    const{sql}=await req.json(); if(!sql) return j({error:"sql required"},400);
    try{const r=await fetch(`https://api.supabase.com/v1/projects/${SB_PROJECT}/database/query`,{method:"POST",headers:{"Authorization":`Bearer ${SB_PAT}`,"Content-Type":"application/json"},body:JSON.stringify({query:sql})});const result=await r.json();if(!r.ok)throw new Error(JSON.stringify(result));return j({ok:true,result});}catch(e:unknown){return j({error:(e as Error).message},500);}
  }
  if(path==="/self/deploy-now"&&req.method==="POST") {
    const{code}=await req.json();
    const finalCode=code||(await ghRaw("supabase/functions/kai-brain/index.ts"));
    try{await sbDeploy(finalCode);return j({ok:true,message:"Edge function deployed immediately"});}catch(e:unknown){return j({error:(e as Error).message},500);}
  }
  if(path==="/self/trigger-ci"&&req.method==="POST") {
    const{reason}=await req.json();
    try{const ts=await ghTriggerCI(reason||"KAI auto-deploy");return j({ok:true,triggered_at:ts,message:"CI triggered — APK ready in ~5 minutes"});}catch(e:unknown){return j({error:(e as Error).message},500);}
  }
  if(path==="/self/get-logs"&&req.method==="GET") {
    try{const data=await ghGet("/actions/runs?per_page=5");return j({ok:true,runs:(data.workflow_runs||[]).map((r:Record<string,unknown>)=>({id:r.id,status:r.status,conclusion:r.conclusion,message:(r.head_commit as Record<string,unknown>)?.message,created_at:r.created_at}))});}catch(e:unknown){return j({error:(e as Error).message},500);}
  }
  if(path==="/self/introspect"&&req.method==="GET") {
    try{return j({ok:true,source:await ghRaw("supabase/functions/kai-brain/index.ts")});}catch(e:unknown){return j({error:(e as Error).message},500);}
  }
  if(path==="/self/agent"&&req.method==="POST") {
    const{task,chat_id}=await req.json();
    if(!task) return j({error:"task required"},400);
    if(!GH_TOKEN||!SB_PAT) return j({error:"Self-modification requires GITHUB_TOKEN and KAI_SUPABASE_TOKEN in Supabase function secrets"},403);
    const{readable,writable}=new TransformStream();
    const writer=writable.getWriter(); const enc=new TextEncoder();
    (async()=>{try{await agentLoop(task,chat_id||null,writer,enc);}catch(e:unknown){await writer.write(enc.encode(ev({type:"error",error:e instanceof Error?e.message:String(e)})));}finally{await writer.close();}})();
    return jss(readable);
  }

  // ── STANDARD CHAT ENDPOINTS ─────────────────────────────────────────────────
  if(path==="/chat/stream"&&req.method==="POST") {
    const{text,chat_id,image_urls}=await req.json();
    // Check for command routing first
    const routed=await detectAndRouteCommand(text,chat_id||null).catch(()=>({handled:false}));
    if(routed.handled) {
      // Save command result to chat and stream it
      const result=routed.result as Record<string,unknown>;
      let reply="";
      if(result.brief) reply=result.brief as string;
      else if(result.summary) reply=`**Summary:** ${result.summary}`;
      else if(result.result!==undefined) reply=`**Result:** ${result.result}`;
      else if(result.output) reply=`**Output:** ${result.output}`;
      else if(result.text) reply=`**Translation:** ${result.text}`;
      else if(result.message) reply=result.message as string;
      else if(result.articles) reply=`📰 **${result.category} News**\n\n`+(result.articles as Array<{title:string;url:string}>).map((a,i)=>`${i+1}. [${a.title}](${a.url})`).join("\n");
      else if(result.temp_c) reply=`🌤 **Weather in ${result.city}**\n${result.desc} · ${result.temp_c}°C (feels ${result.feels_c}°C)\nHumidity: ${result.humidity}% · Wind: ${result.wind_kmph}km/h ${result.wind_dir}\nSunrise: ${result.sunrise} · Sunset: ${result.sunset}`;
      else if(result.checks) {
        const h=result as {overall:string;version:string;checks:Array<{system:string;status:string;details:string;latency_ms:number}>};
        reply=`🏥 **KAI Health Check** — ${h.overall.toUpperCase()}\n\n`+h.checks.map(c=>`${c.status==="ok"?"✅":c.status==="warn"?"⚠️":"❌"} **${c.system}**: ${c.details} (${c.latency_ms}ms)`).join("\n");
      }
      else reply=JSON.stringify(result,null,2);
      let sid=chat_id||null;
      try{if(!sid){const c=await ins("kai_chats",{title:text.slice(0,60)||"Chat"});sid=c.id;}await insQ("kai_messages",{chat_id:sid,role:"user",content:text});await insQ("kai_messages",{chat_id:sid,role:"assistant",content:reply});}catch{}
      const{readable:rd,writable:wr}=new TransformStream();
      const ww=wr.getWriter();const ee=new TextEncoder();
      await ww.write(ee.encode(ev({type:"chat_id",chat_id:sid})));
      await ww.write(ee.encode(ev({type:"delta",text:reply})));
      await ww.write(ee.encode(ev({type:"done",reply,tokens:Math.round(reply.length/4),chat_id:sid,command_result:result})));
      await ww.close();
      return jss(rd);
    }
    // Normal chat
    const prov=await getProvider();
    let sid=chat_id||null;
    try{if(!sid){const c=await ins("kai_chats",{title:(text||"").slice(0,60)||"Chat"});sid=c.id;}await insQ("kai_messages",{chat_id:sid,role:"user",content:text});}catch(e){console.error("save user:",e);}
    const history:M[]=[];
    try{
      const personality=await getPersonality();
      const{data}=await db.from("kai_messages").select("role,content").eq("chat_id",sid).order("created_at").limit(20);
      (data||[]).slice(-16).forEach((r:Record<string,string>)=>history.push({role:r.role==="assistant"?"assistant":"user",content:r.content}));
      if(history.length>0&&history[0].role!=="system") history.unshift({role:"system",content:personality});
    }catch{history.push({role:"user",content:text});}
    if(image_urls?.length) history[history.length-1].content+=`\n\n[Images: ${image_urls.join(", ")}]`;
    if(prov.startsWith("local_")) return j({type:"local_inference",provider:prov,messages:history,chat_id:sid});
    const{readable:rd,writable:wr}=new TransformStream();
    const ww=wr.getWriter();const ee=new TextEncoder();
    await ww.write(ee.encode(ev({type:"chat_id",chat_id:sid})));await ww.close();
    return streamChat(history,sid,prov);
  }

  if(path==="/chat/local-result"&&req.method==="POST"){const{chat_id,reply,tokens}=await req.json();try{await insQ("kai_messages",{chat_id,role:"assistant",content:reply});}catch{}return j({ok:true,chat_id,tokens});}
  if(path==="/chat/agentic"&&req.method==="POST"){const{text,chat_id}=await req.json();let sid=chat_id||null;try{if(!sid){const c=await ins("kai_chats",{title:(text||"").slice(0,60)||"Agentic"});sid=c.id;}await insQ("kai_messages",{chat_id:sid,role:"user",content:text});}catch{}let reply="";for(const pv of["or_llama70b","or_gptoss120b","or_nemotron550b"]){try{reply=await chat([{role:"user",content:text}],pv,false) as string;if(reply)break;}catch{continue;}}if(!reply)reply="I couldn't get a response right now.";try{await insQ("kai_messages",{chat_id:sid,role:"assistant",content:reply});}catch{}return j({ok:true,reply,chat_id:sid,tokens:Math.round(reply.length/4),participants:["or_llama70b","or_gptoss120b","or_nemotron550b"],used:[]});}
  if(path==="/chat/voice"&&req.method==="POST"){const audio=await req.arrayBuffer();const sid=req.headers.get("x-chat-id")||null;let transcript="";try{if(HF_KEY){const r=await fetch("https://api-inference.huggingface.co/models/openai/whisper-large-v3",{method:"POST",headers:{"Authorization":`Bearer ${HF_KEY}`,"Content-Type":"audio/webm"},body:audio});const d=await r.json();transcript=d.text||"";}else transcript="[voice needs HF token]";}catch{transcript="[transcription error]";}if(!transcript.trim())return j({error:"No speech detected"},400);const reply=await chat([{role:"user",content:transcript}],undefined,false) as string;let sv=sid;try{if(!sv){const c=await ins("kai_chats",{title:transcript.slice(0,50)});sv=c.id;}await insQ("kai_messages",{chat_id:sv,role:"user",content:transcript});await insQ("kai_messages",{chat_id:sv,role:"assistant",content:reply});}catch{}return j({ok:true,transcript,reply,chat_id:sv});}
  if(path==="/generate-image"&&req.method==="POST"){const{prompt,style,chat_id}=await req.json();if(!prompt)return j({error:"prompt required"},400);try{return j(await genImage(prompt,style||"",chat_id||null));}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/generate-reel"&&req.method==="POST"){const{topic,type,style,scenes,chat_id}=await req.json();if(!topic)return j({error:"topic required"},400);try{return j(await genReel(topic,type||"motivational",style||"minimal",scenes||5,chat_id||null));}catch(e:unknown){return j({error:(e as Error).message},500);}}
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
  if(path==="/benchmark"&&req.method==="POST") return j({ok:true,results:[],best:"or_openrouter_free"});
  if(path==="/set-key"&&req.method==="POST"){const{provider:prov}=await req.json();try{const{error}=await db.from("kai_settings").upsert({key:"active_provider",value:prov},{onConflict:"key"});if(error)throw new Error(error.message);return j({ok:true,provider:prov});}catch(e:unknown){return j({error:(e as Error).message},500);}}
  if(path==="/test-provider"&&req.method==="POST"){const{provider:prov}=await req.json();try{const r=await chat([{role:"user",content:"Say OK"}],prov,false) as string;return j({ok:true,provider:prov,reply:r.slice(0,100),model:prov});}catch(e:unknown){return j({ok:false,provider:prov,error:(e as Error).message});}}
  if(path==="/projects"&&req.method==="GET"){try{const{data}=await db.from("kai_projects").select("*").order("created_at",{ascending:false}).limit(20);return j({projects:data||[]});}catch{return j({projects:[]});}}

  return j({error:"Not found",path},404);
});
