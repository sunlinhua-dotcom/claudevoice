#!/usr/bin/env python
"""cv-sfx —— 用 Stable Audio Open Small（本地 341M 模型）给每个项目生成专属提示音。

生成 → ffmpeg 裁到 2~5 秒 + 淡入淡出 + 响度对齐 → ~/.claude/cv-cues/<key>-<kind>.wav
模型与权重全在本机 ~/.cache/cv-sfx，不联网、不花钱。
"""
import argparse, json, os, subprocess, sys, tempfile, hashlib
from pathlib import Path

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")  # T5 走镜像，直连慢 17 倍
CACHE = Path(os.path.expanduser("~/.cache/cv-sfx"))
MODEL_DIR = CACHE / "model"
OUT_DIR = Path(os.path.expanduser("~/.claude/cv-cues"))

_model = None

def load_model():
    global _model
    if _model: return _model
    import torch
    from stable_audio_tools.models.factory import create_model_from_config
    from stable_audio_tools.models.utils import load_ckpt_state_dict
    cfg = json.loads((MODEL_DIR / "model_config.json").read_text())
    # T5 文本编码器指到本机副本（从阿里 ModelScope 下的），跑的时候完全不联网
    for c in cfg["model"]["conditioning"]["configs"]:
        if c.get("type") == "t5":
            c["config"]["model_path"] = str(CACHE / "t5-base")   # 官方留的本地权重入口
    model = create_model_from_config(cfg)
    model.load_state_dict(load_ckpt_state_dict(str(MODEL_DIR / "model.safetensors")))
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    model = model.to(dev).eval().requires_grad_(False)
    _model = (model, cfg, dev)
    return _model

def synth(prompt, seconds, seed):
    """跑一次扩散，返回 44.1k 立体声 float tensor。small 版是 pingpong 少步采样器。"""
    import torch
    from stable_audio_tools.inference.generation import generate_diffusion_cond
    model, cfg, dev = load_model()
    audio = generate_diffusion_cond(
        model,
        steps=8, cfg_scale=1.0,                     # ARC 后训练版的官方少步设置
        conditioning=[{"prompt": prompt, "seconds_total": float(seconds)}],
        sample_size=cfg["sample_size"], sigma_min=0.3, sigma_max=500,
        sampler_type="pingpong", device=dev, seed=seed,
    )
    return audio.squeeze(0).to(torch.float32).cpu(), cfg["sample_rate"]

def _dur_of(p):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", str(p)], capture_output=True, text=True).stdout
    return float(out.strip() or 0)


def post(raw_wav, out_path, dur):
    """两趟处理。

    第一趟：掐掉头尾的死静音，只留真正有声音的那一段。门限压到 -62dB / -45dB 是刻意的——
    这批是慢起慢消的涌升，切太狠会削掉柔和的起音和教堂混响的尾巴，听着就成了敲击。
    第二趟：把它夹到 2~5 秒（够长就按 dur 裁，不够长就留原样、最少补到 2 秒），
    再加淡入淡出和响度对齐。这样文件里不会拖一大段听不见的空白，
    免得音效"早就放完了"语音却还没开口。
    """
    lo, hi = 2.0, 5.0
    out_path.parent.mkdir(parents=True, exist_ok=True)
    trimmed = out_path.with_suffix(".trim.wav")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw_wav), "-af",
                    "silenceremove=start_periods=1:start_threshold=-62dB:start_silence=0.05,"
                    "areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15,"
                    "areverse", "-ar", "44100", "-ac", "2", str(trimmed)], check=True)

    d = min(hi, max(lo, min(float(dur), _dur_of(trimmed))))
    fade_out = min(1.0, d / 3)
    af = (f"atrim=0:{d},afade=t=in:st=0:d=0.15:curve=ipar,"
          f"afade=t=out:st={d - fade_out:.3f}:d={fade_out:.3f}:curve=exp,"
          f"loudnorm=I=-16:TP=-1.5:LRA=11,apad=whole_dur={d}")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(trimmed),
                    "-af", af, "-ar", "44100", "-ac", "2", str(out_path)], check=True)
    trimmed.unlink(missing_ok=True)


def write_wav(path, audio, sr):
    """用标准库 wave 写 16-bit 立体声，绕开 torchaudio 缺后端。"""
    import wave, torch
    peak = audio.abs().max().clamp(min=1e-6)
    pcm = (audio / peak * 0.95 * 32767).to(torch.int16).t().contiguous()   # [samples, ch] 交织
    with wave.open(str(path), "wb") as w:
        w.setnchannels(pcm.shape[1]); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(pcm.numpy().tobytes())

def make(prompt, out_path, dur=3.2, seed=-1):
    audio, sr = synth(prompt, dur, seed)               # seconds_total 就给目标时长，让它写一个刚好这么长的完整乐句
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        tmp = Path(f.name)
    write_wav(tmp, audio, sr)
    post(tmp, out_path, dur)
    tmp.unlink(missing_ok=True)
    return out_path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--dur", type=float, default=3.2)
    ap.add_argument("--seed", type=int, default=-1)
    a = ap.parse_args()
    p = make(a.prompt, Path(os.path.expanduser(a.out)), a.dur, a.seed)
    print(p)

if __name__ == "__main__":
    main()
