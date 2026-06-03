# ==========================================================================
# KAI BRAIN TRAINER  —  run on Kaggle (free GPU) or Google Colab
# --------------------------------------------------------------------------
# WHAT THIS DOES:
#   Takes a real open reasoning model (Qwen2.5-1.5B-Instruct) and fine-tunes
#   it INTO KAI on Luo Kai's own messages, so it REASONS *and* speaks as Kai.
#   Output: a trained, quantized model you download and put in the app/laptop.
#
# HOW TO RUN (your only job — the 'one click' Claude can't do):
#   1. Go to kaggle.com -> Create -> New Notebook
#   2. Settings -> Accelerator -> GPU T4 x2  (free, 30 hrs/week)
#   3. Settings -> Internet -> ON
#   4. Upload your corpus file: kai_train.jsonl  (Claude generates this for you)
#   5. Paste this whole file into a cell -> Run All -> wait ~2-4 hours
#   6. Download kai-brain-gguf/ at the end. Done.
# ==========================================================================

# ---- 1. install ----
import subprocess, sys
def pip(*a): subprocess.run([sys.executable,"-m","pip","install","-q",*a],check=True)
pip("torch","transformers>=4.44","peft>=0.12","trl>=0.9","datasets","accelerate","bitsandbytes")

import torch, json, os
from datasets import load_dataset
from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig
from peft import LoraConfig, get_peft_model
from trl import SFTTrainer, SFTConfig

assert torch.cuda.is_available(), "Turn ON the GPU accelerator in Kaggle settings!"
print("GPU:", torch.cuda.get_device_name(0))

# ---- 2. base model: small, strong, multilingual (EN + Arabic), CPU-runnable after ----
BASE = "Qwen/Qwen2.5-1.5B-Instruct"   # bump to 3B if you want deeper reasoning + have time

bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                         bnb_4bit_compute_dtype=torch.float16, bnb_4bit_use_double_quant=True)
tok = AutoTokenizer.from_pretrained(BASE)
tok.pad_token = tok.eos_token
model = AutoModelForCausalLM.from_pretrained(BASE, quantization_config=bnb, device_map="auto")

# ---- 3. LoRA: train KAI's voice/identity into the model efficiently ----
lora = LoraConfig(r=32, lora_alpha=64, lora_dropout=0.05, bias="none",
                  task_type="CAUSAL_LM",
                  target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"])
model = get_peft_model(model, lora)
model.print_trainable_parameters()

# ---- 4. data: kai_train.jsonl  (each line: {"messages":[{role,content}...]}) ----
# KAI's identity is taught here via a system message Claude bakes into every example.
ds = load_dataset("json", data_files="kai_train.jsonl", split="train")
print("training examples:", len(ds))

def fmt(ex):
    return {"text": tok.apply_chat_template(ex["messages"], tokenize=False, add_generation_prompt=False)}
ds = ds.map(fmt)

# ---- 5. train ----
cfg = SFTConfig(
    output_dir="kai-lora", per_device_train_batch_size=2, gradient_accumulation_steps=8,
    num_train_epochs=3, learning_rate=2e-4, fp16=True, logging_steps=20,
    save_strategy="epoch", max_seq_length=1024, warmup_ratio=0.03, lr_scheduler_type="cosine",
    report_to="none")
trainer = SFTTrainer(model=model, train_dataset=ds, args=cfg, tokenizer=tok)
trainer.train()

# ---- 6. merge LoRA into base + save ----
model = model.merge_and_unload()
model.save_pretrained("kai-merged"); tok.save_pretrained("kai-merged")
print("merged model saved.")

# ---- 7. quantize to GGUF (runs on CPU/phone/laptop, no GPU needed afterward) ----
subprocess.run("git clone -q https://github.com/ggerganov/llama.cpp", shell=True)
subprocess.run("pip install -q -r llama.cpp/requirements.txt", shell=True)
subprocess.run("python llama.cpp/convert_hf_to_gguf.py kai-merged --outfile kai-brain-f16.gguf", shell=True)
subprocess.run("cd llama.cpp && make -j quantize 2>/dev/null || cmake -B build && cmake --build build --target llama-quantize", shell=True)
QUANT = "llama.cpp/build/bin/llama-quantize"
if not os.path.exists(QUANT): QUANT = "llama.cpp/llama-quantize"
subprocess.run(f"{QUANT} kai-brain-f16.gguf kai-brain-Q4_K_M.gguf Q4_K_M", shell=True)
print("\n=== DONE. Download kai-brain-Q4_K_M.gguf — that's KAI's brain. ===")
