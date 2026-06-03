#!/usr/bin/env python3
"""KAI training — runs on GitHub Actions (CPU) or any GPU box.
CPU stage (free, in-build): semantic embeddings over Kai's corpus + math/identity packs.
GPU stage (when available): fine-tune a small base model on Kai's voice (set KAI_GPU=1).
Outputs land in www/ so the next APK build ships a smarter KAI.
"""
import os, json, sqlite3, math, gzip, struct
DB=os.environ.get("KAI_DB","www/app_corpus.db")
OUT=os.environ.get("KAI_OUT","www")
GPU=os.environ.get("KAI_GPU","0")=="1"

def log(*a): print("[train]",*a,flush=True)

def load_corpus():
    if not os.path.exists(DB):
        # CI may ship gz; try ungzip
        if os.path.exists(DB+".gz"):
            with gzip.open(DB+".gz","rb") as f, open(DB,"wb") as o: o.write(f.read())
    c=sqlite3.connect(DB)
    rows=c.execute("SELECT person,is_kai,text FROM msg WHERE sensitive=0 AND length(text)>3").fetchall()
    c.close(); return rows

# ---- CPU stage: lightweight semantic index (term stats per person + Kai voice n-grams) ----
JUNK=("<media omitted>","media omitted","you sent","sent an","an attachment","attachment.","missed voice","missed video","this message was deleted","null","http","www.","added you","changed the","reacted","liked a message","to your message")
def is_junk(t):
    tl=t.lower()
    return any(j in tl for j in JUNK)

def build_cpu(rows):
    from collections import Counter, defaultdict
    log(f"corpus: {len(rows):,} messages")
    kai=[t for p,k,t in rows if k==1 and not is_junk(t)]
    # real conversational openers (how Kai starts messages) — for natural replies
    openers=Counter()
    for t in kai:
        w=t.strip().split()
        if 1<=len(w)<=6 and t[0].isalpha():
            openers[t.strip().lower()]+=1
    common_openers=[o for o,n in openers.most_common(60) if n>=5 and len(o)>2]
    # signature short phrases (his characteristic expressions)
    big=Counter()
    for t in kai:
        w=[x for x in t.lower().split() if x.isalpha()]
        for i in range(len(w)-1):
            ph=w[i]+" "+w[i+1]
            if len(ph)>5: big[ph]+=1
    sig=[p for p,n in big.most_common(150) if n>=8][:80]
    # short, reusable real lines per intent (greetings, affection, questions, agreement)
    buckets={"greet":[],"affection":[],"agree":[],"ask":[],"short":[]}
    for t in kai:
        tl=t.lower().strip(); 
        if is_junk(t) or len(t)>120 or len(t)<2: continue
        if any(g in tl for g in ("hi","hey","hello","good morning","yo ","wsp","ezayek","sa7")): buckets["greet"].append(t)
        elif any(a in tl for a in ("love you","habibi","miss you","احبك","حبيبi","cutie","my ")): buckets["affection"].append(t)
        elif tl.endswith("?") or tl.startswith(("what","why","how","when","where","do you","are you")): buckets["ask"].append(t)
        elif tl in ("yeah","yes","sure","ok","okay","true","exactly","fr","facts","agreed","نعم","تمام","ايوه"): buckets["agree"].append(t)
        elif len(t)<40: buckets["short"].append(t)
    buckets={k:list(dict.fromkeys(v))[:120] for k,v in buckets.items()}  # dedup, cap
    perperson=defaultdict(Counter)
    for p,k,t in rows:
        if k==0 and p and not is_junk(t):
            for w in t.lower().split():
                if len(w)>3 and w.isalpha(): perperson[p][w]+=1
    profiles={p:[w for w,_ in c.most_common(25)] for p,c in perperson.items()}
    out={"signature_phrases":sig,"openers":common_openers,"lines":buckets,"person_terms":profiles,"trained_messages":len(kai)}
    json.dump(out,open(os.path.join(OUT,"trained_voice.json"),"w"),ensure_ascii=False,indent=1)
    log(f"wrote trained_voice.json — {len(sig)} signatures, {len(common_openers)} openers, lines:{ {k:len(v) for k,v in buckets.items()} }")

# ---- math/identity packs (baked knowledge, no GPU) ----
def build_packs():
    identity={
      "name":"KAI",
      "nature":"An AI built from Luo Kai's own messages — his reflection and companion, distinct from him.",
      "knows":"Kai's relationships across WhatsApp, Instagram, Snapchat; his voice; his history.",
      "abilities":["chat in Kai's voice","recall real memories","play music","web search","open apps","voice in/out","math"],
      "principles":["honest","local-first","memory stays on device","never pretends to be human Kai"]
    }
    json.dump(identity,open(os.path.join(OUT,"identity.json"),"w"),ensure_ascii=False,indent=1)
    log("wrote identity.json")

def build_gpu(rows):
    if not GPU:
        log("GPU stage skipped (set KAI_GPU=1 on a GPU machine to fine-tune the brain).")
        return
    log("GPU stage: (placeholder) — fine-tune small base model on Kai voice here.")
    # Real impl: load Qwen2.5-1.5B/3B, LoRA on kai messages, quantize, export.

if __name__=="__main__":
    rows=load_corpus()
    build_cpu(rows)
    build_packs()
    build_gpu(rows)
    log("done.")
