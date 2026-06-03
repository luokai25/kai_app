# ==========================================================================
# KAI BRAIN TRAINER  —  for Lightning AI (lightning.ai)  [80 free GPU hrs/mo]
# --------------------------------------------------------------------------
# Trains a real reasoning model INTO KAI: sounds like Kai, knows Kai, AND assists.
# Base: Qwen2.5-3B-Instruct (strong reasoning + multilingual EN/Arabic).
# Output: a merged model + GGUF you download and run offline.
#
# ===== HOW TO RUN (your only job) =====
# 1. lightning.ai -> Start free -> verify phone -> you get ~80 GPU hrs/month
# 2. Create a new Studio. In the right panel, switch the machine to a GPU
#    (L4 or A10G is plenty; even T4 works).
# 3. Upload your data file:  kai_assistant_train.jsonl
# 4. Open a terminal in the Studio and run:   python KAI_train_lightning.py
# 5. Wait ~2-4 hours. Download kai-brain-Q4_K_M.gguf at the end. Done.
# ==========================================================================

import subprocess, sys, os
def sh(c): subprocess.run(c, shell=True, check=True)
sh(f"{sys.executable} -m pip install -q -U torch transformers>=4.44 peft>=0.12 trl>=0.9 datasets accelerate bitsandbytes sentencepiece")

import torch
from datasets import load_dataset
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from peft import LoraConfig, get_peft_model
from trl import SFTTrainer, SFTConfig

assert torch.cuda.is_available(), "Switch the Studio machine to a GPU first (right panel)."
print("GPU:", torch.cuda.get_device_name(0))

BASE = "Qwen/Qwen2.5-3B-Instruct"   # use -1.5B- if you want it faster/lighter
DATA = "kai_assistant_train.jsonl"

bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                         bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
tok = AutoTokenizer.from_pretrained(BASE); tok.pad_token = tok.eos_token
model = AutoModelForCausalLM.from_pretrained(BASE, quantization_config=bnb, device_map="auto",
                                             torch_dtype=torch.bfloat16)
model = get_peft_model(model, LoraConfig(
    r=32, lora_alpha=64, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM",
    target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"]))
model.print_trainable_parameters()

ds = load_dataset("json", data_files=DATA, split="train")
print("examples:", len(ds))
ds = ds.map(lambda ex: {"text": tok.apply_chat_template(ex["messages"], tokenize=False)})

trainer = SFTTrainer(model=model, train_dataset=ds, tokenizer=tok, args=SFTConfig(
    output_dir="kai-lora", per_device_train_batch_size=4, gradient_accumulation_steps=4,
    num_train_epochs=2, learning_rate=2e-4, bf16=True, logging_steps=25,
    save_strategy="epoch", max_seq_length=1024, warmup_ratio=0.03,
    lr_scheduler_type="cosine", report_to="none"))
trainer.train()

# merge + save full model
model = model.merge_and_unload()
model.save_pretrained("kai-merged"); tok.save_pretrained("kai-merged")
print("merged model saved -> kai-merged/")

# GGUF (runs offline on laptop/phone afterward, no GPU needed)
sh("git clone -q https://github.com/ggerganov/llama.cpp || true")
sh(f"{sys.executable} -m pip install -q -r llama.cpp/requirements.txt")
sh(f"{sys.executable} llama.cpp/convert_hf_to_gguf.py kai-merged --outfile kai-brain-f16.gguf")
sh("cd llama.cpp && (cmake -B build >/dev/null 2>&1 && cmake --build build --target llama-quantize -j >/dev/null 2>&1 || make -j llama-quantize >/dev/null 2>&1) || true")
q = next((p for p in ["llama.cpp/build/bin/llama-quantize","llama.cpp/llama-quantize"] if os.path.exists(p)), None)
if q: sh(f"{q} kai-brain-f16.gguf kai-brain-Q4_K_M.gguf Q4_K_M")
print("\n=== DONE. Download kai-brain-Q4_K_M.gguf — that's KAI's brain. ===")
