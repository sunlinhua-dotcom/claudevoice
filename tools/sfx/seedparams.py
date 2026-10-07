"""把 cuegen-batch.html 里的播种逻辑照抄一份到 Python，只为了试听页能显示每个项目分到了什么。
两边必须一模一样：同一个 mulberry32、同一个 FNV-1a、同一个取值顺序。改一边就要改另一边。
"""
M32 = 0xFFFFFFFF


def _imul(a, b):
    """JS 的 Math.imul：取乘积低 32 位。这里全程用无符号表示，位运算结果与 JS 一致。"""
    return ((a & M32) * (b & M32)) & M32


def hash32(s):
    h = 2166136261
    for ch in s:
        h = (h ^ ord(ch)) & M32
        h = _imul(h, 16777619)
    return h


def mulberry32(seed):
    st = {"a": seed & M32}

    def rnd():
        st["a"] = (st["a"] + 0x6D2B79F5) & M32
        a = st["a"]
        t = _imul(a ^ (a >> 15), 1 | a)
        # 注意 JS 那行是 t = (t + imul(...)) ^ t，右边那个 ^ t 用的是旧的 t，不是 a
        t = (((t + _imul(t ^ (t >> 7), 61 | t)) & M32) ^ t) & M32
        return ((t ^ (t >> 14)) & M32) / 4294967296
    return rnd


SHIFTS = [-5, -4, -2, 0, 2, 3, 5, 7]
NOTE = {-5: "G", -4: "降A", -2: "降B", 0: "C", 2: "D", 3: "降E", 5: "F", 7: "G(高)"}
VOICE = {"done": ["大三和弦", "大七和弦", "挂四和弦", "大六和弦"],
         "alert": ["小七和弦", "小三和弦", "小挂二", "小六和弦"]}
ARPS = ["琶音 A", "琶音 B", "琶音 C", "琶音 D", "琶音 E"]


def params_for(key, kind="done"):
    r = mulberry32(hash32(f"{key}|{kind}"))
    pick = lambda a: a[int(r() * len(a))]
    rng = lambda a, b: a + r() * (b - a)
    needs = kind != "done"
    shift = pick(SHIFTS)
    voice = pick(VOICE["alert" if needs else "done"])
    arp = pick(ARPS)
    rng(.22, .30) if needs else rng(.26, .34)          # arpStep
    bell = "三角波铃" if r() < .55 else "正弦波铃"
    tick_hz = rng(1900, 2900)
    ticks = round(rng(7, 11) if needs else rng(3, 6))
    return {"key": NOTE[shift], "chord": voice, "arp": arp,
            "bell": bell, "tickHz": int(tick_hz), "ticks": ticks}
