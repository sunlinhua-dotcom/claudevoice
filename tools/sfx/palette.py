"""每个项目的音效 prompt 是怎么来的。

风格定死：**一件独奏乐器吹/拉/弹一句 POP 旋律 + Techno 伴奏**，整体正能量。
前景每个项目随机分到一件能 solo 的乐器——钢琴、小提琴、萨克斯、黑管、大提琴、
小号、长笛、电吉他、颤音琴、口琴、二胡……后面垫现代电子舞曲的制作。

两条是踩过坑才定的：
① 旋律必须"是首歌"。上一版出来听着诡异，是因为模型默认往氛围音乐上跑；
   prompt 里要明写 catchy pop melody / singable hook / major key / consonant，
   并且明确拒绝 atonal、dissonant、drone、ambient、horror。
② 全程回避 notification / beep / alarm / ringtone，那是最早那版听着像闹钟的根因。

prompt 还要短——T5 编码器只吃 128 token，写太长重要的词会被截掉。
所以乐器和"pop 旋律"放最前面，修饰词能省则省。

区分靠四个维度按项目名 hash 各选一个（乐器 20 × 伴奏 8 × 走向 4 × 音区 5 = 3200 格），
批量生成时再去一次重，保证 140 个项目互不相同。新项目不用登记也能自动分到一个稳定的音效。
"""
import hashlib

# 独奏乐器：能唱出一句旋律的都算，音色彼此离得远。
SOLOS = [
    "grand piano", "solo violin", "alto saxophone", "tenor saxophone",
    "clarinet", "cello", "muted trumpet", "flute",
    "electric guitar lead", "nylon string acoustic guitar", "Rhodes electric piano",
    "vibraphone", "pan flute", "oboe", "soprano saxophone", "french horn",
    "harmonica", "steel string acoustic guitar", "analog saw synth lead", "erhu",
]
# Techno 伴奏：变的是后面这套电子配器和律动。
BACKINGS = [
    "a pumping sidechained analog synth bass",
    "a driving four-on-the-floor techno beat",
    "a rolling acid bassline",
    "a rising filtered supersaw pad",
    "a hypnotic arpeggiated synth sequence",
    "deep sub bass and crisp hi-hats",
    "an FM bass with short gated reverb",
    "a progressive techno build",
]
# 走向：这句旋律怎么走。都是流行歌里常见的句型。
MOTIONS = [
    "the hook rising and opening up",
    "the hook landing on a bright resolved note",
    "a call and answer, two phrases",
    "the phrase lifting at the end",
]
# 旋律音区：说的是独奏落在哪一档。
REGISTERS = [
    "low and warm", "low-mid", "mid register", "bright and high", "sparkling top octave",
]

# 收尾语：钉死"这是首歌的一句"，并赶走氛围/诡异/闹钟三个方向。
BASE = ("clean tonal melody, consonant harmony, modern techno production, "
        "no vocals, no atonal, no dissonance, no drone, no ambient, no alarm")

# 手工登记的项目性格词（可选）。没登记的项目照样有音效，只是少一层"跟项目有关"的味道。
CHARACTER = {}


def _h(key, salt):
    return int(hashlib.md5(f"{salt}:{key}".encode("utf-8")).hexdigest()[:8], 16)


def slot_for(key):
    """项目在 3200 格调色盘里的坐标。"""
    return (_h(key, "solo") % len(SOLOS), _h(key, "back") % len(BACKINGS),
            _h(key, "mot") % len(MOTIONS), _h(key, "reg") % len(REGISTERS))


def assign_slots(keys):
    """批量分配：hash 优先，撞了就在盘子里顺延到下一个空位，保证互不相同。"""
    used, out = set(), {}
    total = len(SOLOS) * len(BACKINGS) * len(MOTIONS) * len(REGISTERS)
    for k in sorted(keys):
        i, b, m, r = slot_for(k)
        idx = ((i * len(BACKINGS) + b) * len(MOTIONS) + m) * len(REGISTERS) + r
        for step in range(total):
            c = (idx + step) % total
            if c not in used:
                used.add(c); break
        r = c % len(REGISTERS);           c //= len(REGISTERS)
        m = c % len(MOTIONS);             c //= len(MOTIONS)
        b = c % len(BACKINGS);            i = c // len(BACKINGS)
        out[k] = (i, b, m, r)
    return out


def prompt_for(key, kind="done", slot=None):
    """给项目 key 和事件类型，拼出一句英文 prompt（T5 编码器只吃英文）。"""
    i, b, m, r = slot or slot_for(key)
    solo, back, mot, reg = SOLOS[i], BACKINGS[b], MOTIONS[m], REGISTERS[r]
    if kind == "done":                     # 完成：唱完一句，落在主音上
        mood = "uplifting, triumphant, major key"
    else:                                  # 提醒/授权：句子悬着没落，但仍然明亮
        mood = "warm, expectant, unresolved ending, major key"
        mot = "a short call and answer, two phrases"
    parts = [f"catchy pop melody hook played on {solo}", reg, mot, f"over {back}", mood]
    char = CHARACTER.get(key)
    if char:
        parts.insert(1, char)
    return ", ".join(parts) + ", " + BASE


def seed_for(key, kind):
    return _h(key, "seed:" + kind) % (2 ** 31)


def describe(key, slot=None):
    """人看的：这个项目分到了什么。"""
    i, b, m, r = slot or slot_for(key)
    return {"family": SOLOS[i], "space": BACKINGS[b],
            "motion": MOTIONS[m], "register": REGISTERS[r]}
