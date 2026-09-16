# -*- coding: utf-8 -*-
"""把用户手画箭头的截图，解成**骨架的分支结构**，再拼成"杆"和"V 尖"两笔。

为什么要真解像素、而不是"看着差不多"写几个坐标：
  阈值（杆停在哪儿算够近、两只臂张开多大的角才算 V）必须按**用户真实手型**定。
  拍脑袋定过一次，吃过亏：按"全长的百分比"判箭头，600px 长杆上 20px 的回勾永远不达标，
  一个箭头都认不出来。

关键发现（第一版脚本只跟出一条最短路，把结构看丢了）：
  两张图里墨迹都是**一个连通块**，形状是"Y" —— 杆的末端和 V 尖在纸上**叠到一起了**
  （截图上看不出是"一笔画成"还是"两笔"，但两种手型的墨迹都长这样）。
  所以要把骨架按**分支**拆开：一条杆 + 两只臂。

产物：
  · scripts/fixtures/hand-arrows.json  —— 真实笔迹（杆 / 臂的关键点），当自检夹具
  · .cache/arrow-decoded.png           —— 解出来的骨架画回原图（给人看的证据）
  · .cache/arrow-extract.log           —— 量出来的几何

只读用户发来的截图，不碰项目里任何数据。
"""
import json
import math
import os

import numpy as np
from PIL import Image, ImageDraw

ROOT = r"C:\Users\luoji\Desktop\studyhelper"
CLIP = r"C:\Users\luoji\.workbuddy\clipboard-images"
OUT_JSON = os.path.join(ROOT, "scripts", "fixtures", "hand-arrows.json")
OUT_PNG = os.path.join(ROOT, ".cache", "arrow-decoded.png")
OUT_LOG = os.path.join(ROOT, ".cache", "arrow-extract.log")

LOG = []


def log(*a):
    LOG.append(" ".join(str(x) for x in a))


# ─────────────────────────── 骨架（纯 numpy，不依赖 scipy） ───────────────────────────
def neighbors8(m):
    p = np.zeros((m.shape[0] + 2, m.shape[1] + 2), dtype=bool)
    p[1:-1, 1:-1] = m
    return (
        p[0:-2, 1:-1], p[0:-2, 2:], p[1:-1, 2:], p[2:, 2:],
        p[2:, 1:-1], p[2:, 0:-2], p[1:-1, 0:-2], p[0:-2, 0:-2],
    )


def thin(mask, max_iter=200):
    """Zhang-Suen 细化（向量化）。"""
    m = mask.copy()
    for _ in range(max_iter):
        changed = False
        for step in (0, 1):
            P2, P3, P4, P5, P6, P7, P8, P9 = neighbors8(m)
            seq = [P2, P3, P4, P5, P6, P7, P8, P9, P2]
            B = sum(x.astype(np.uint8) for x in seq[:-1])
            A = sum(((seq[i] == 0) & (seq[i + 1] == 1)).astype(np.uint8) for i in range(8))
            if step == 0:
                # P2*P4*P6 = 0  且  P4*P6*P8 = 0
                c1 = ~(P2 & P4 & P6)
                c2 = ~(P4 & P6 & P8)
            else:
                # P2*P4*P8 = 0  且  P2*P6*P8 = 0
                c1 = ~(P2 & P4 & P8)
                c2 = ~(P2 & P6 & P8)
            cond = m & (B >= 2) & (B <= 6) & (A == 1) & c1 & c2
            if cond.any():
                m = m & ~cond
                changed = True
        if not changed:
            break
    return m


def components(mask):
    h, w = mask.shape
    seen = np.zeros_like(mask)
    out = []
    ys, xs = np.nonzero(mask)
    for sy, sx in zip(ys.tolist(), xs.tolist()):
        if seen[sy, sx]:
            continue
        stack = [(sy, sx)]
        seen[sy, sx] = True
        pts = []
        while stack:
            y, x = stack.pop()
            pts.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
        comp = np.zeros_like(mask)
        for y, x in pts:
            comp[y, x] = True
        out.append((comp, len(pts)))
    out.sort(key=lambda t: -t[1])
    return out


def nbrs(pixels):
    return {p: [(p[0] + dy, p[1] + dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                if (dy or dx) and (p[0] + dy, p[1] + dx) in pixels] for p in pixels}


def skel_graph(skel):
    """骨架 → 分支表。分支 = 两个"节点像素"之间那段度数全是 2 的点列。

    节点像素 = 8 邻域里"邻居数 ≠ 2"的点。⚠ 8 连通的骨架里，斜着走的线上
    会天然出现度数 3 的"台阶"像素 —— 所以节点必须**再并成簇**（见 cluster_nodes），
    否则那些台阶会被当成几十个分叉点，整个结构就散了。"""
    ys, xs = np.nonzero(skel)
    pixels = set(zip(ys.tolist(), xs.tolist()))
    nb = nbrs(pixels)
    nodes = {p for p in pixels if len(nb[p]) != 2}
    seen = set()
    out = []
    for p in nodes:
        for q in nb[p]:
            if (p, q) in seen:
                continue
            pts = [p, q]
            seen.add((p, q))
            prev, cur = p, q
            while cur not in nodes:
                nxt = [z for z in nb[cur] if z != prev]
                if not nxt:
                    break
                prev, cur = cur, nxt[0]
                pts.append(cur)
            if len(pts) >= 2:
                seen.add((pts[-1], pts[-2]))
            out.append({"p0": pts[0], "p1": pts[-1], "pts": pts})
    return out, nodes, nb


def bfs_all(nb, src):
    dist = {src: 0}
    parent = {src: None}
    q = [src]
    while q:
        nq = []
        for p in q:
            for z in nb[p]:
                if z not in dist:
                    dist[z] = dist[p] + 1
                    parent[z] = p
                    nq.append(z)
        q = nq
    return dist, parent


def path_to(parent, target):
    pts = [target]
    while parent.get(pts[-1]) is not None:
        pts.append(parent[pts[-1]])
    return pts[::-1]


def dissect(skel):
    """骨架 → 「主干 + 附属臂」：谁和谁在哪儿分岔。

    为什么不用"找分叉节点"那套（试过，弃了）：
      杆的墨迹和 V 的顶点**叠在一起**，那一小片是一个糊掉的多边形，
      细化之后在它内部会长出好几条彼此只有几个像素的小边，
      "度数 = 3 的节点"根本不唯一，坐标还会被簇心带偏好几像素。
      改成纯像素的做法就没有这些歧义：
        · 最长的两端 = 骨架直径（双扫最远点）
        · 长路径之外的那一坨 = 附属臂；它接在长路径上的哪一点 = 分岔点
    返回 (p1, p2, V, B, spine, arm_path)：主干 p1..p2，V 是分岔点，B 是附属臂的末端。"""
    ys, xs = np.nonzero(skel)
    pixels = set(zip(ys.tolist(), xs.tolist()))
    nb = nbrs(pixels)
    a = next(iter(pixels))
    d1, par1 = bfs_all(nb, a)
    p1 = max(d1, key=lambda k: d1[k])
    d2, par2 = bfs_all(nb, p1)
    p2 = max(d2, key=lambda k: d2[k])
    spine = path_to(par2, p2)
    # 主干周围 1 圈都算"主干身上的"，剩下的是附属臂
    near = set()
    for p in spine:
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                near.add((p[0] + dy, p[1] + dx))
    rest = {p for p in pixels if p not in near}
    if not rest:
        return None
    # 附属臂 = rest 里最大的连通块
    best = []
    left = set(rest)
    while left:
        s = next(iter(left))
        left.discard(s)
        stack, group = [s], [s]
        while stack:
            p = stack.pop()
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    q = (p[0] + dy, p[1] + dx)
                    if q in left:
                        left.discard(q)
                        stack.append(q)
                        group.append(q)
        if len(group) > len(best):
            best = group
    if len(best) < 4:
        return None
    arm = set(best)
    # 臂的"根"：臂上离主干最近的那个像素；V = 主干上离它最近的像素
    root = min(arm, key=lambda p: min((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 for q in spine))
    V = min(spine, key=lambda q: (q[0] - root[0]) ** 2 + (q[1] - root[1]) ** 2)
    # 臂的另一头：以 root 为起点在臂内走最远
    arm_nb = nbrs(arm)
    d3, _ = bfs_all(arm_nb, root)
    B = max(d3, key=lambda k: d3[k])
    arm_path = path_to(bfs_all(arm_nb, B)[1], root)   # B → root（末端 → 根）
    iV = spine.index(V)
    return {"p1": p1, "p2": p2, "V": V, "B": B, "spine": spine, "iV": iV,
            "leg_p1": spine[:iV + 1], "leg_p2": spine[iV:],
            "leg_arm": arm_path + [V], "nb": nb, "pixels": pixels}


def prune(skel, min_len=10, rounds=10):
    """剪毛刺：一端是端点、另一端是分叉点、长度 < min_len 的分支，整段删掉。"""
    m = skel.copy()
    for _ in range(rounds):
        brs, nodes, nb = skel_graph(m)
        ends = {p for p in nodes if len(nb[p]) == 1}
        kill = []
        for b in brs:
            a, z = b["p0"] in ends, b["p1"] in ends
            if a != z and len(b["pts"]) < min_len:
                kill.extend(b["pts"][:-1] if a else b["pts"][1:])
        if not kill:
            break
        for p in kill:
            m[p[0], p[1]] = False
    return m


def arclen(pts):
    return sum(math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
               for i in range(1, len(pts)))


def rdp(pts, eps):
    if len(pts) < 3:
        return pts
    (x0, y0), (x1, y1) = pts[0], pts[-1]
    dx, dy = x1 - x0, y1 - y0
    L = math.hypot(dx, dy)
    imax, dmax = 0, -1.0
    for i in range(1, len(pts) - 1):
        px, py = pts[i]
        d = abs(dy * (px - x0) - dx * (py - y0)) / L if L > 1e-9 else math.hypot(px - x0, py - y0)
        if d > dmax:
            imax, dmax = i, d
    if dmax <= eps:
        return [pts[0], pts[-1]]
    return rdp(pts[:imax + 1], eps)[:-1] + rdp(pts[imax:], eps)


def resample(pts, step):
    """按弧长重采样（保证点间距大致均匀 —— 后面算"沿臂走 25px 的方向"要用）。"""
    if len(pts) < 2:
        return pts
    out = [pts[0]]
    acc = 0.0
    for i in range(1, len(pts)):
        (x0, y0), (x1, y1) = pts[i - 1], pts[i]
        seg = math.hypot(x1 - x0, y1 - y0)
        if seg <= 0:
            continue
        t = 0.0
        while acc + seg - t >= step:
            t += step - acc
            k = t / seg
            out.append((x0 + (x1 - x0) * k, y0 + (y1 - y0) * k))
            acc = 0.0
        acc += seg - t
    if out[-1] != pts[-1]:
        out.append(pts[-1])
    return out


def arclen(pts):
    return sum(math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
               for i in range(1, len(pts)))


def dir_at(pts, i, span, forward=True):
    """从下标 i 出发、沿点列走 span 像素，返回单位方向（会沿点列找够 span 的那一点）。"""
    acc = 0.0
    j = i
    rng = range(i + 1, len(pts)) if forward else range(i - 1, -1, -1)
    for k in rng:
        acc += math.hypot(pts[k][0] - pts[j][0], pts[k][1] - pts[j][1])
        j = k
        if acc >= span:
            break
    d = (pts[j][0] - pts[i][0], pts[j][1] - pts[i][1])
    n = math.hypot(*d)
    return (d[0] / n, d[1] / n) if n > 1e-9 else (0.0, 0.0)


def angle_between(u, v):
    c = max(-1.0, min(1.0, u[0] * v[0] + u[1] * v[1]))
    return math.degrees(math.acos(c))


# ─────────────────────────── 主流程 ───────────────────────────
SAMPLES = [
    {
        "key": "long",
        "name": "长杆箭头（在横线纸上画的）",
        "file": os.path.join(CLIP, "clipboard-2026-09-16T11-56-04-036Z-0f2699cf.png"),
        "rule_paper": True,
    },
    {
        "key": "short",
        "name": "短粗箭头（形态参考：同样是「杆 + 单独的 V 尖」）",
        "file": os.path.join(CLIP, "clipboard-2026-09-16T11-56-04-038Z-4a37a7eb.png"),
        "rule_paper": False,
    },
]

PAPER_WORLD_GAP = 32.0   # 本项目「横线纸」的世界行距（styles.css 的 --paper-tile）
ASSUMED_ARM = 55.0       # 没有标定物时的兜底：让"臂长"落在 55 世界像素
ARMS_SPAN = 25.0         # 量臂方向时，沿臂走多远（太短会被笔宽糊掉）

result = {"note": "从用户手画箭头的截图里解出来的真实笔迹（中心线）。只读图，不含任何用户数据。",
          "generatedBy": "scripts/extract-hand-arrows.py", "images": []}
overlays = []

for smp in SAMPLES:
    im0 = Image.open(smp["file"]).convert("RGB")
    g = np.asarray(im0.convert("L"), dtype=np.uint8)
    W, H = im0.size
    mask = g < 150
    comps = [(c, a) for (c, a) in components(mask) if a >= 60]
    log("")
    log("=" * 74)
    log(smp["name"], "  图片", W, "x", H, "  墨迹块", len(comps))

    # ── 标定：横线纸的行距 → 截图缩放 ──
    scale = None
    if smp["rule_paper"]:
        rows = (g < 250).sum(axis=1) / W          # 纸的横线是很淡的灰，阈值放宽到 250
        peaks = []
        y = 0
        while y < H:
            if rows[y] > 0.55:
                y2 = y
                while y2 + 1 < H and rows[y2 + 1] > 0.55:
                    y2 += 1
                peaks.append((y + y2) / 2)
                y = y2 + 1
            else:
                y += 1
        if len(peaks) >= 2:
            gaps = sorted(peaks[i] - peaks[i - 1] for i in range(1, len(peaks)))
            gap = gaps[len(gaps) // 2]
            scale = gap / PAPER_WORLD_GAP
            log("  纸上横线在 y =", [round(p, 1) for p in peaks], " 行距中位数 %.2fpx" % gap)
            log("  → 截图缩放 ≈ %.3f，世界坐标 = 图上像素 / %.3f" % (scale, scale))
        else:
            log("  ⚠ 纸的横线太淡，没量到（按下面兜底）")

    # ── 先按图上像素解结构，再统一转世界坐标 ──
    c0 = comps[0][0]
    skel = prune(thin(c0), 10)
    graph, nodes, nb0 = skel_graph(skel)
    ends = [p for p in nodes if len(nb0[p]) == 1]
    log("  骨架：像素 %d，自由端 %d 个 %s" % (int(skel.sum()), len(ends),
                                            [(p[1], p[0]) for p in ends]))
    D = dissect(skel)
    if not D:
        log("  ⚠ 骨架分不出「主干 + 附属臂」—— 只出证据图，不出夹具")
        dr0 = ImageDraw.Draw(im0)
        for b in graph:
            dr0.line([(p[1], p[0]) for p in b["pts"]], fill=(230, 40, 40), width=2)
        overlays.append(im0)
        continue

    def eu(pts):
        return sum(math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
                   for i in range(1, len(pts)))

    nb = D["nb"]
    pix = D["pixels"]
    V = D["V"]                    # 骨架上的分岔点（杆身和两只臂在这附近糊在一起）
    free = [D["p1"], D["p2"], D["B"]]
    # 杆尾 = 离分岔点最远的那个自由端（另外两个是 V 的臂端）
    tail = max(free, key=lambda p: (p[0] - V[0]) ** 2 + (p[1] - V[1]) ** 2)
    arms = [p for p in free if p != tail]
    # 箭头尖 = 整条骨架上**离杆尾欧氏距离最远**的那个像素。
    #   为什么不用"图距离最远"：图距离最远的那头往往是**较长的臂端**（长杆箭头就是这样，
    #   尖反而离杆尾更近一点）。用欧氏距离，尖永远是尖 —— 两条都实测过。
    tip = max(pix, key=lambda p: (p[0] - tail[0]) ** 2 + (p[1] - tail[1]) ** 2)

    def walk(a, b):
        return path_to(bfs_all(nb, a)[1], b)

    shaft_pts = walk(tail, tip)
    arm_paths = [walk(tip, a) for a in arms]
    arm_paths.sort(key=lambda p: -eu(p))
    barb_a, barb_b = arm_paths[0], arm_paths[1]
    shaft_len, armA, armB = eu(shaft_pts), eu(barb_a), eu(barb_b)
    log("    杆尾 %s   尖 %s   两个臂端 %s" %
        ((tail[1], tail[0]), (tip[1], tip[0]), [(a[1], a[0]) for a in arms]))
    log("    杆 %.0fpx   臂A %.0fpx   臂B %.0fpx" % (shaft_len, armA, armB))

    # ── V 尖的张开角：顶点 = 尖，两只臂的方向（沿臂走 25px 量，避开糊掉的那一小片）──
    uA = dir_at(barb_a, 0, ARMS_SPAN, forward=True)
    uB = dir_at(barb_b, 0, ARMS_SPAN, forward=True)
    opening = angle_between(uA, uB)
    chordV = math.hypot(barb_a[-1][0] - barb_b[-1][0], barb_a[-1][1] - barb_b[-1][1])
    # 尖上"往回走"的量：一笔画成的箭头（杆 + 回勾）靠这个判；
    # 两笔画的（杆 + 单独一个 V）这里会是 0 —— 两种手型都得认，见下面的阈值
    log("    调试：uA=(%.2f,%.2f) uB=(%.2f,%.2f)  两臂端相距 %.0fpx"
        % (uA[0], uA[1], uB[0], uB[1], chordV))

    # ── 缩放：有纸的横线就按它，否则按"臂长 55 世界像素"兜底 ──
    if not scale:
        scale = max(armA, armB) / ASSUMED_ARM
        log("  → 兜底标定：按臂长 %.0fpx ≈ %d 世界像素 → 世界坐标 = 图上像素 / %.3f"
            % (max(armA, armB), ASSUMED_ARM, scale))
    log("  V 尖：臂 %.1f / %.1f 世界像素，端点相距 %.1f，张开角 %.1f°"
        % (armA / scale, armB / scale, chordV / scale, opening))

    def to_world(pts):
        """出关格式 = 应用自己的点格式：扁平的三元组 [x, y, 压力…]。
        为什么不写 [[x,y],…]：那份数据要直接喂给 lib/board.js 的 toPoints / newStroke，
        写成人看的形状还得在自检里再转一道 —— 多一道转换就多一个"夹具其实是坏的"的机会。"""
        out = []
        for p in resample(rdp(pts, 1.5), 6):
            out.append(round(p[1] / scale, 2))   # (y,x) → x
            out.append(round(p[0] / scale, 2))   # y
            out.append(0.5)                      # 压力（中心线没有压力信息，取中值）
        return out

    strokes = [
        {"role": "shaft", "len": round(shaft_len / scale, 2), "points": to_world(shaft_pts)},
        {"role": "barbA", "len": round(armA / scale, 2), "points": to_world(barb_a)},
        {"role": "barbB", "len": round(armB / scale, 2), "points": to_world(barb_b)},
    ]
    result["images"].append({
        "key": smp["key"], "name": smp["name"], "file": os.path.basename(smp["file"]),
        "size": [W, H], "scale": round(scale, 4),
        "openingDeg": round(opening, 1),
        "strokes": strokes,
    })

    # ── 证据图：把解出来的骨架画回原图上 ──
    dr = ImageDraw.Draw(im0)
    for b in graph:
        dr.line([(p[1], p[0]) for p in b["pts"]], fill=(230, 40, 40), width=2)
    for p in (tail, tip):
        dr.ellipse([p[1] - 6, p[0] - 6, p[1] + 6, p[0] + 6], outline=(20, 120, 240), width=3)
    dr.ellipse([V[1] - 5, V[0] - 5, V[1] + 5, V[0] + 5], outline=(20, 170, 60), width=2)
    overlays.append(im0)

os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
with open(OUT_JSON, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=1)

Wm = max(im.width for im in overlays) if overlays else 100
Hm = sum(im.height for im in overlays) + 8 * max(0, len(overlays) - 1)
canvas = Image.new("RGB", (Wm, Hm), (255, 255, 255))
y = 0
for im in overlays:
    canvas.paste(im, (0, y))
    y += im.height + 8
canvas.save(OUT_PNG)

log("")
log("夹具 →", OUT_JSON)
log("证据图 →", OUT_PNG)
with open(OUT_LOG, "w", encoding="utf-8") as f:
    f.write("\n".join(LOG) + "\n")
print("done")
