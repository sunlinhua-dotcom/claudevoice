#!/usr/bin/env python3
# 生成"星际穿越式"高级提示音（管风琴涌升 + 上行琶音风铃 + 滴答 + 卷积混响 + 立体声）
import numpy as np, wave, struct, sys

SR = 44100

def fftconvolve(x, h):
    n = len(x) + len(h) - 1
    N = 1 << (n - 1).bit_length()
    y = np.fft.irfft(np.fft.rfft(x, N) * np.fft.rfft(h, N), N)[:n]
    return y

def make_ir(seconds=2.0, decay=3.2):
    n = int(SR * seconds)
    t = np.arange(n) / SR
    env = np.exp(-decay * t)
    # 两声道去相关噪声 → 立体声空间
    L = (np.random.randn(n)) * env
    R = (np.random.randn(n)) * env
    return L * 0.5, R * 0.5

class Bus:
    def __init__(self, total):
        self.n = int(SR * total)
        self.L = np.zeros(self.n); self.R = np.zeros(self.n)
    def add(self, sig, start, pan=0.0):
        s = int(SR * start); e = min(self.n, s + len(sig))
        if s >= self.n: return
        seg = sig[:e - s]
        lg = np.sqrt((1 - pan) / 2); rg = np.sqrt((1 + pan) / 2)
        self.L[s:e] += seg * lg; self.R[s:e] += seg * rg

def t_arr(dur): return np.arange(int(SR * dur)) / SR

def organ(freq, dur, attack, amp):
    t = t_arr(dur)
    env = np.minimum(t / attack, 1.0) * np.exp(-np.maximum(0, t - attack) * 0.6)
    # 微失谐三振荡 + 柔八度
    s = (np.sin(2*np.pi*freq*t) + np.sin(2*np.pi*freq*1.003*t) * 0.7
         + np.sin(2*np.pi*freq*2*t) * 0.25 + np.sin(2*np.pi*freq*0.5*t) * 0.3)
    return s * env * amp

def bell(freq, dur, amp):
    t = t_arr(dur)
    env = np.exp(-t * 4.2)
    s = np.sin(2*np.pi*freq*t) + 0.4*np.sin(2*np.pi*freq*2.01*t) + 0.15*np.sin(2*np.pi*freq*3.0*t)
    return s * env * amp

def sub(freq, dur, amp):
    t = t_arr(dur)
    env = np.minimum(t/0.6, 1.0) * np.exp(-np.maximum(0, t-0.6)*0.9)
    return np.sin(2*np.pi*freq*t) * env * amp

def tick(dur, freq, amp):
    t = t_arr(dur)
    env = np.exp(-t * 90)
    return np.sin(2*np.pi*freq*t) * env * amp

def build(kind):
    needs = (kind != 'done')
    dur = 4.0 if needs else 3.5
    total = dur + 2.2
    dry = Bus(total); wet = Bus(total)
    if needs:
        chordA = [146.83, 174.61, 220.0, 261.63]   # Dm7
        chordB = [164.81, 196.0, 246.94, 293.66]    # 上行
        arp = [587.33, 698.46, 880.0, 1174.7, 1396.9, 1760.0]
        subf = 49.0
    else:
        chordA = [130.81, 164.81, 196.0, 261.63]    # C 大
        chordB = [130.81, 174.61, 220.0, 261.63]    # → F 色彩
        arp = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568.0]
        subf = 43.65
    # 低频体感
    dry.add(sub(subf, dur, 0.5), 0.0, 0.0)
    # 管风琴和弦 A→B，左右铺开
    for i, f in enumerate(chordA):
        pan = (i/(len(chordA)-1) - 0.5) * 1.1
        sig = organ(f, dur*0.62, 0.6 if needs else 0.45, 0.10)
        dry.add(sig, 0.0, pan); wet.add(sig*0.8, 0.0, pan)
    for i, f in enumerate(chordB):
        pan = (i/(len(chordB)-1) - 0.5) * 1.1
        sig = organ(f, dur*0.55, 0.55, 0.10)
        dry.add(sig, dur*0.45, pan); wet.add(sig*0.8, dur*0.45, pan)
    # 上行琶音风铃 + 叠高八度
    gap = 0.26 if needs else 0.30
    for i, f in enumerate(arp):
        st = 0.35 + i*gap; pan = 0.4 if i % 2 else -0.4
        b = bell(f, 1.3, 0.13); dry.add(b, st, pan); wet.add(b, st, pan)
        b2 = bell(f*2, 1.1, 0.06); dry.add(b2, st+0.04, -pan*0.7); wet.add(b2, st+0.04, -pan*0.7)
    # 收尾下行风铃
    top = arp[-1]*1.33
    for j in range(4):
        b = bell(top*(0.84**j), 1.0, 0.08); dry.add(b, dur*0.72 + j*0.13, 0.45 if j%2 else -0.45); wet.add(b, dur*0.72+j*0.13, 0.45 if j%2 else -0.45)
    # 滴答时间动机
    ticks = 9 if needs else 4
    for k in range(ticks):
        st = 0.15 + k*(0.16 if needs else 0.24)
        dry.add(tick(0.08, 2600 if needs else 2200, 0.05*(1+k/ticks)), st, 0.2 if k%2 else -0.2)
    # 顶点穿透泛音
    pk = dur*(0.72 if needs else 0.5)
    t = t_arr(0.85); shimmer = np.sin(2*np.pi*(3000 if needs else 2500)*t*(1+0.4*t)) * np.exp(-t*3) * 0.10
    dry.add(shimmer, pk, 0.0); wet.add(shimmer, pk, 0.0)

    irL, irR = make_ir()
    L = dry.L + fftconvolve(wet.L, irL)[:dry.n] * 0.9
    R = dry.R + fftconvolve(wet.R, irR)[:dry.n] * 0.9
    # 整体淡入 + 软限幅 + 归一
    fade = np.minimum(np.arange(len(L))/(SR*0.05), 1.0)
    L *= fade; R *= fade
    L = np.tanh(L*1.1); R = np.tanh(R*1.1)
    peak = max(np.max(np.abs(L)), np.max(np.abs(R)), 1e-6)
    g = 0.92/peak; L *= g; R *= g
    return L, R

def write_wav(path, L, R):
    n = len(L); data = np.empty(n*2, dtype='<i2')
    data[0::2] = np.clip(L, -1, 1) * 32767
    data[1::2] = np.clip(R, -1, 1) * 32767
    w = wave.open(path, 'w'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(data.tobytes()); w.close()
    print("  写", path, "%.1fs" % (n/SR))

for kind, out in [('done', 'chime-done.wav'), ('alert', 'chime-alert.wav')]:
    L, R = build(kind); write_wav(out, L, R)
print("done")
