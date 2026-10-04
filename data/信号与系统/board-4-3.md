{
 "title": "4-3",
 "version": 4,
 "viewPinned": true,
 "view": {
  "s": 0.82,
  "tx": 659.4,
  "ty": -17531.9
 },
 "strokes": [
  {
   "id": "smunslunh1y",
   "tool": "pen",
   "color": "#1b1d22",
   "width": 2.6,
   "pressure": true,
   "points": [
    182.2,
    14042,
    0.22,
    182.7,
    14042.9,
    0.16,
    184.5,
    14042.9,
    0.16
   ]
  }
 ],
 "cards": [
  {
   "id": "nmunqh8lx2",
   "kind": "note",
   "x": 416,
   "y": -90,
   "w": 400,
   "h": 398,
   "src": "",
   "tex": "",
   "text": "连续时间傅里叶变换（第 1 页）\n\n这是第 4 章的封面页，也是 Lecture 4-3 的开头，所以这一页没有具体知识点，只是告诉你接下来要讲什么：连续时间傅里叶变换（C-T Fourier Transform）。\n\n先把这个名字拆开看。“连续时间”是说我们处理的信号 $x(t)$ 的自变量 $t$ 是连续取值的，不是只在整数点上才有值——这是它和后面离散时间傅里叶变换的分界线。“傅里叶变换”则是把信号从时间域搬到频率域的一套工具：它告诉你这个信号里各个频率成分各占多大比重。\n\n这一章和前面级数的关系要拎清楚：傅里叶级数只能对付周期信号，而傅里叶变换把周期这个限制去掉了，非周期信号也能做频率分析。你可以把非周期信号想成周期趋于无穷大的周期信号，谱线就从离散的一根根变成连续的。\n\n所以这一讲（4-3）的任务，就是建立变换的定义、收敛条件和基本性质。具体内容看后面的页，这一页只要记住：接下来讨论的对象是连续时间信号，工具是傅里叶变换。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 1
   }
  },
  {
   "id": "nmunqh8lx3",
   "kind": "note",
   "x": -792,
   "y": -90,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 1 页 · 重点\n\n- 本章讲连续时间傅里叶变换\n- 对象是连续时间信号 $x(t)$\n- 把信号从时间域变到频率域\n- 它比傅里叶级数适用面更广",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 1
   }
  },
  {
   "id": "nmunqh8lx4",
   "kind": "note",
   "x": 416,
   "y": 470,
   "w": 400,
   "h": 466,
   "src": "",
   "tex": "",
   "text": "回顾：连续时间傅里叶变换（第 2 页）\n\n这一页是把连续时间傅里叶变换（FT）的两套公式摆在一起复习，左边管非周期信号，右边管周期信号，中间用同一个变换核 $e^{-j\\omega t}$ 串起来。\n\n先看左边。分析公式 $X(j\\omega)=\\int_{-\\infty}^{\\infty}x(t)e^{-j\\omega t}dt$ 干的事，就是拿不同频率的复指数去和 $x(t)$ 做内积，看信号里含多少这个频率的成分，结果 $X(j\\omega)$ 是频率的连续函数，所以叫连续谱。综合公式是反过来的：把所有这些频率成分按权重 $X(j\\omega)$ 叠加回去，注意前面那个 $\\frac{1}{2\\pi}$，它是频率轴用 $\\omega$ 而不是 $f$ 带来的归一化因子，漏掉就错了。\n\n右边是周期信号。周期信号可以展成傅里叶级数，只有 $k\\omega_1$ 这些离散的谐波频率上有分量，所以它的频谱是一串冲激。第一行用傅里叶级数系数 $F_k$ 写，第二行换成用非周期信号频谱 $X_0(jk\\omega_1)$ 写，这里的 $X_0$ 指的是取周期信号一个周期算出来的变换。冲激强度正比于 $X_0(jk\\omega_1)\\omega_1$，这个 $\\omega_1$ 就是基波角频率。\n\n最容易想错的地方：周期信号的频谱不是连续的，而是间隔 $\\omega_1$ 的冲激序列；非周期信号反过来，频谱连续、没有冲激。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 2
   }
  },
  {
   "id": "nmunqh8lx5",
   "kind": "note",
   "x": -792,
   "y": 470,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 2 页 · 重点\n\n- 非周期信号：频谱连续，$X(j\\omega)$ 是幅度密度谱\n- 周期信号：频谱是间隔 $\\omega_1$ 的冲激序列\n- 综合公式前的 $\\frac{1}{2\\pi}$ 不能丢\n- 冲激强度 $\\propto X_0(jk\\omega_1)\\omega_1$",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 2
   }
  },
  {
   "id": "fmunqh8lx6",
   "kind": "formula",
   "x": -581,
   "y": 620,
   "w": 189,
   "h": 46,
   "src": "X(j\\omega)=\\int_{-\\infty}^{\\infty}x(t)e^{-j\\omega t}dt",
   "tex": "X(j\\omega)=\\int_{-\\infty}^{\\infty}x(t)e^{-j\\omega t}dt",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 2
   }
  },
  {
   "id": "fmunqh8lx7",
   "kind": "formula",
   "x": -601,
   "y": 684,
   "w": 209,
   "h": 46,
   "src": "x(t)=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}X(j\\omega)e^{j\\omega t}d\\omega",
   "tex": "x(t)=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}X(j\\omega)e^{j\\omega t}d\\omega",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 2
   }
  },
  {
   "id": "fmunqh8lx8",
   "kind": "formula",
   "x": -628,
   "y": 748,
   "w": 236,
   "h": 56,
   "src": "X_T(j\\omega)=\\sum_{k=-\\infty}^{\\infty}2\\pi F_k\\delta(\\omega-k\\omega_1)",
   "tex": "X_T(j\\omega)=\\sum_{k=-\\infty}^{\\infty}2\\pi F_k\\delta(\\omega-k\\omega_1)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 2
   }
  },
  {
   "id": "fmunqh8lx9",
   "kind": "formula",
   "x": -674,
   "y": 822,
   "w": 282,
   "h": 56,
   "src": "X_T(j\\omega)=\\sum_{k=-\\infty}^{\\infty}X_0(jk\\omega_1)\\omega_1\\delta(\\omega-k\\omega_1)",
   "tex": "X_T(j\\omega)=\\sum_{k=-\\infty}^{\\infty}X_0(jk\\omega_1)\\omega_1\\delta(\\omega-k\\omega_1)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 2
   }
  },
  {
   "id": "nmunqh8lxa",
   "kind": "note",
   "x": 416,
   "y": 1030,
   "w": 400,
   "h": 496,
   "src": "",
   "tex": "",
   "text": "第 3 页 · 讲解\n\n这是本讲的目录页，先扫一眼整条路线，心里有个数。\n\n前三条是\"定义\"：第 1 条把傅里叶变换从周期信号推广到非周期信号，也就是从傅里叶级数走到傅里叶变换；第 2 条拿几个典型信号（比如矩形脉冲、指数信号）把变换算一遍，让你对\"时域长什么样、频域长什么样\"有感觉；第 3 条再回头处理周期信号，说明周期信号也能用傅里叶变换表示，只是频谱里出现冲激。\n\n第 4 条是这一讲的重点，标红了，还写着\"接上一讲\"——说明上一讲已经开过头，这次接着往下讲性质。性质这一块是后面所有内容的地基：时移、频移、尺度变换、微分、积分、对偶等等，每一条都在告诉你\"时域做一个动作，频域会跟着发生什么\"。\n\n第 5 条把卷积和相乘单独拎出来，因为这两个性质最常用：时域卷积对应频域相乘，时域相乘对应频域卷积，系统分析基本就靠它。第 6 条用线性常系数微分方程描述系统，把前面学的变换拿来解方程、求频率响应。第 7 条是应用，收尾。\n\n所以这一页不是要你背，是让你知道：接下来每一节都在为\"用频域的眼光看信号和系统\"这件事服务。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 3
   }
  },
  {
   "id": "nmunqh8lxb",
   "kind": "note",
   "x": -792,
   "y": 1030,
   "w": 400,
   "h": 154,
   "src": "",
   "tex": "",
   "text": "第 3 页 · 重点\n\n- 第 1~3 条：非周期、典型信号、周期信号的傅里叶变换\n- 第 4 条是重点，接上一讲继续讲性质\n- 第 5 条：卷积与相乘性质，系统分析的核心\n- 第 6~7 条：微分方程描述系统及其应用",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 3
   }
  },
  {
   "id": "nmunqh8lxc",
   "kind": "note",
   "x": 416,
   "y": 1590,
   "w": 400,
   "h": 376,
   "src": "",
   "tex": "",
   "text": "4.9 Parseval's Relation (帕斯瓦尔定理)（第 4 页）\n\n这一页就讲一件事：能量守恒。左边 $\\int_{-\\infty}^{\\infty}|x(t)|^2dt$ 是信号在时域里的总能量——把每一瞬间的功率 $|x(t)|^2$ 累加起来。右边 $\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}|X(j\\omega)|^2d\\omega$ 是同一份能量在频域里的算法：把各个频率分量的能量密度累加起来。定理说这两个积分相等，也就是信号的能量不管你从时域看还是从频域看，总量一样，不会凭空多也不会少。\n\n注意前提：$x(t)$ 必须是能量有限信号，否则两边都是无穷大，等式没意义。\n\n$|X(j\\omega)|^2$ 叫能量密度谱，单位是 $V^2/(\\text{rad}\\cdot\\text{Hz})$。为什么是平方？因为 $X(j\\omega)$ 是幅度谱，平方之后才对应能量。为什么前面有 $\\frac{1}{2\\pi}$？因为傅里叶反变换里带这个因子，频域积分要除以 $2\\pi$ 才能和时域对上。\n\n最容易错的地方：把 $|X(j\\omega)|^2$ 当成能量本身。它不是能量，是密度，要乘上 $d\\omega$ 再积分才是能量。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 4
   }
  },
  {
   "id": "nmunqh8lxd",
   "kind": "note",
   "x": -792,
   "y": 1590,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 4 页 · 重点\n\n- 时域总能量 = 频域总能量\n- 前提：$x(t)$ 是能量有限信号\n- $|X(j\\omega)|^2$ 是能量密度谱，不是能量\n- 频域积分前有 $\\frac{1}{2\\pi}$ 因子",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 4
   }
  },
  {
   "id": "fmunqh8lxe",
   "kind": "formula",
   "x": -653,
   "y": 1740,
   "w": 261,
   "h": 46,
   "src": "\\int_{-\\infty}^{\\infty}|x(t)|^2dt=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}|X(j\\omega)|^2d\\omega",
   "tex": "\\int_{-\\infty}^{\\infty}|x(t)|^2dt=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}|X(j\\omega)|^2d\\omega",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 4
   }
  },
  {
   "id": "nmunqh8lxf",
   "kind": "note",
   "x": 416,
   "y": 2150,
   "w": 400,
   "h": 422,
   "src": "",
   "tex": "",
   "text": "微分与积分性质（第 5 页）\n\n这一页讲傅里叶变换的微分和积分性质，说白了就是：对时间求导，频谱上就乘一个 $j\\omega$；对时间积分，频谱上就除以 $j\\omega$。\n\n先看上面两条。$x^{(n)}(t)$ 是 $x(t)$ 的 $n$ 阶导数，它的频谱是 $(j\\omega)^n X(j\\omega)$，也就是每求一次导，就在频域乘一个 $j\\omega$。反过来，如果对频谱 $X(j\\omega)$ 求导，对应到时域是乘 $(-jt)^n$，这就是第二条。这两条是对称的，记住一条就能推出另一条。\n\n再看下面这条积分性质。$\\int_{-\\infty}^{t} x(\\tau)d\\tau$ 的频谱是 $\\frac{1}{j\\omega}X(j\\omega)$ 再加上 $\\pi X(0)\\delta(\\omega)$。前面那项好理解，就是微分性质反过来用；关键是后面这个 $\\pi X(0)\\delta(\\omega)$，它对应的是直流分量。因为积分会让信号里多出一个不随时间变化的常数项，这个常数在频域就是 $\\omega=0$ 处的一个冲激。\n\n最后那句提醒很重要：用微分性质算的时候，容易把常数分量丢掉。比如先微分再积分，那个常数就找不回来了，所以积分性质里必须补上 $\\pi X(0)\\delta(\\omega)$ 这一项。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 5
   }
  },
  {
   "id": "nmunqh8lxg",
   "kind": "note",
   "x": -792,
   "y": 2150,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 5 页 · 重点\n\n- 求导对应频域乘 $j\\omega$\n- 积分对应频域除以 $j\\omega$\n- 积分性质要补直流分量 $\\pi X(0)\\delta(\\omega)$\n- 微分运算容易丢掉常数分量",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 5
   }
  },
  {
   "id": "fmunqh8lxh",
   "kind": "formula",
   "x": -559,
   "y": 2300,
   "w": 167,
   "h": 28,
   "src": "x^{(n)}(t) \\leftrightarrow (j\\omega)^n X(j\\omega)",
   "tex": "x^{(n)}(t) \\leftrightarrow (j\\omega)^n X(j\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 5
   }
  },
  {
   "id": "fmunqh8lxi",
   "kind": "formula",
   "x": -566,
   "y": 2346,
   "w": 174,
   "h": 28,
   "src": "X^{(n)}(j\\omega) \\leftrightarrow (-jt)^n x(t)",
   "tex": "X^{(n)}(j\\omega) \\leftrightarrow (-jt)^n x(t)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 5
   }
  },
  {
   "id": "fmunqh8lxj",
   "kind": "formula",
   "x": -673,
   "y": 2392,
   "w": 281,
   "h": 48,
   "src": "\\int_{-\\infty}^{t} x(\\tau)d\\tau \\leftrightarrow \\frac{1}{j\\omega}X(j\\omega) + \\pi X(0)\\delta(\\omega)",
   "tex": "\\int_{-\\infty}^{t} x(\\tau)d\\tau \\leftrightarrow \\frac{1}{j\\omega}X(j\\omega) + \\pi X(0)\\delta(\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 5
   }
  },
  {
   "id": "nmunqh8lxk",
   "kind": "note",
   "x": 416,
   "y": 2710,
   "w": 400,
   "h": 496,
   "src": "",
   "tex": "",
   "text": "傅里叶变换微分性质示例（第 6 页）\n\n这一页是拿微分性质去算一个具体信号的频谱，思路是“绕道走”。直接对三角脉冲 $x(t)$ 做积分很麻烦，但它的二阶导数 $x''(t)$ 特别简单，就是三个冲激。\n\n先看右边三张图。$x(t)$ 是底宽 $\\tau$、高 $E$ 的偶对称三角脉冲。求一次导，上升段斜率是 $2E/\\tau$，下降段是 $-2E/\\tau$，所以 $x'(t)$ 是两个矩形。再求一次导，矩形跳变的地方就变成冲激：$t=-\\tau/2$ 和 $t=\\tau/2$ 处各一个正冲激，强度 $2E/\\tau$；$t=0$ 处因为从正跳到负，落差是 $4E/\\tau$，所以是负冲激。这就是 $x''(t)$ 的表达式。\n\n接着求它的傅里叶变换。冲激的 FT 是复指数，$\\delta(t-t_0)$ 对应 $e^{-j\\omega t_0}$，所以三个冲激直接换成三项，得到 $X_2(j\\omega)$。\n\n关键一步是微分性质：$x''(t)$ 的 FT 等于 $(j\\omega)^2 X(j\\omega)$。注意 $(j\\omega)^2 = -\\omega^2$，不是正的。于是把上面算出的 $X_2$ 除以 $(j\\omega)^2$，就反推出 $X(j\\omega)$。\n\n最后那个括号 $e^{j\\omega\\tau/2}+e^{-j\\omega\\tau/2}-2$ 用欧拉公式化成 $-4\\sin^2(\\omega\\tau/4)$，和分母的 $-\\omega^2$ 一约，正好凑出 $\\text{Sa}^2(\\omega\\tau/4)$ 的形式。结果 $\\frac{E\\tau}{2}\\text{Sa}^2(\\frac{\\omega\\tau}{4})$ 是实的、偶的，和 $x(t)$ 偶对称完全对得上。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 6
   }
  },
  {
   "id": "nmunqh8lxl",
   "kind": "note",
   "x": -792,
   "y": 2710,
   "w": 400,
   "h": 155,
   "src": "",
   "tex": "",
   "text": "第 6 页 · 重点\n\n- 三角脉冲二阶导是三个冲激\n- $\\delta(t-t_0)$ 的 FT 是 $e^{-j\\omega t_0}$\n- 微分性质：$X_2=(j\\omega)^2X$\n- 除以 $(j\\omega)^2$ 反推原信号 FT\n- 结果 $\\text{Sa}^2$ 是实偶函数",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 6
   }
  },
  {
   "id": "fmunqh8lxm",
   "kind": "formula",
   "x": -712,
   "y": 2883,
   "w": 320,
   "h": 41,
   "src": "x''(t)=\\frac{2E}{\\tau}\\left[\\delta\\left(t+\\frac{\\tau}{2}\\right)+\\delta\\left(t-\\frac{\\tau}{2}\\right)-2\\delta(t)\\right]",
   "tex": "x''(t)=\\frac{2E}{\\tau}\\left[\\delta\\left(t+\\frac{\\tau}{2}\\right)+\\delta\\left(t-\\frac{\\tau}{2}\\right)-2\\delta(t)\\right]",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 6
   }
  },
  {
   "id": "fmunqh8lxn",
   "kind": "formula",
   "x": -634,
   "y": 2942,
   "w": 242,
   "h": 41,
   "src": "X_2(j\\omega)=\\frac{2E}{\\tau}\\left(e^{j\\omega\\frac{\\tau}{2}}+e^{-j\\omega\\frac{\\tau}{2}}-2\\right)",
   "tex": "X_2(j\\omega)=\\frac{2E}{\\tau}\\left(e^{j\\omega\\frac{\\tau}{2}}+e^{-j\\omega\\frac{\\tau}{2}}-2\\right)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 6
   }
  },
  {
   "id": "fmunqh8lxo",
   "kind": "formula",
   "x": -560,
   "y": 3001,
   "w": 168,
   "h": 28,
   "src": "X_2(j\\omega)=(j\\omega)^2X(j\\omega)",
   "tex": "X_2(j\\omega)=(j\\omega)^2X(j\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 6
   }
  },
  {
   "id": "fmunqh8lxp",
   "kind": "formula",
   "x": -567,
   "y": 3047,
   "w": 175,
   "h": 41,
   "src": "X(j\\omega)=\\frac{E\\tau}{2}\\text{Sa}^2\\left(\\frac{\\omega\\tau}{4}\\right)",
   "tex": "X(j\\omega)=\\frac{E\\tau}{2}\\text{Sa}^2\\left(\\frac{\\omega\\tau}{4}\\right)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 6
   }
  },
  {
   "id": "nmunqh8lxq",
   "kind": "note",
   "x": 416,
   "y": 3270,
   "w": 400,
   "h": 513,
   "src": "",
   "tex": "",
   "text": "积分性质示例（第 7 页）\n\n这一页是积分性质的一个实战：求偶对称三角脉冲的傅里叶变换。直接对三角脉冲做积分很麻烦，所以换个思路——先求导，把三角脉冲变成简单的冲激函数，再通过积分性质倒推回去。\n\n先看二阶导数。三角脉冲是分段线性的，一阶导数是矩形波，二阶导数就是三个冲激：两端各一个正冲激，中间一个负的两倍冲激。所以 $x''(t)=\\frac{2E}{\\tau}[\\delta(t+\\frac{\\tau}{2})+\\delta(t-\\frac{\\tau}{2})-2\\delta(t)]$。对它做傅里叶变换，利用时移性质得到 $X_2(j\\omega)=\\frac{2E}{\\tau}(e^{j\\omega\\frac{\\tau}{2}}+e^{-j\\omega\\frac{\\tau}{2}}-2)$，再用欧拉公式化简成 $-\\frac{8E}{\\tau}\\sin^2(\\frac{\\omega\\tau}{4})$。\n\n关键在下一步：由积分性质，$x'(t)$ 是 $x''(t)$ 的变上限积分，所以 $X_1(j\\omega)=\\frac{1}{j\\omega}X_2(j\\omega)+\\pi X_2(0)\\delta(\\omega)$。注意那个 $\\pi X_2(0)\\delta(\\omega)$ 项——积分性质不是简单的除以 $j\\omega$，还要加上直流分量的冲激修正。这里 $X_2(0)=0$，所以这一项直接消失。同理再做一次积分得到 $X(j\\omega)=\\frac{1}{j\\omega}X_1(j\\omega)+\\pi X_1(0)\\delta(\\omega)$，而 $X_1(0)$ 也等于 0。\n\n最后把 $X_2(j\\omega)$ 代入两次除以 $j\\omega$，得到 $X(j\\omega)=\\frac{E\\tau}{2}\\text{Sa}^2(\\frac{\\omega\\tau}{4})$。三角脉冲的频谱是 Sa 函数的平方，这跟矩形脉冲的频谱是 Sa 函数正好对应——时域越平滑，频域衰减越快。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 7
   }
  },
  {
   "id": "nmunqh8lxr",
   "kind": "note",
   "x": -792,
   "y": 3270,
   "w": 400,
   "h": 155,
   "src": "",
   "tex": "",
   "text": "第 7 页 · 重点\n\n- 三角脉冲二阶导数是三个冲激\n- $X_2(j\\omega)=-\\frac{8E}{\\tau}\\sin^2(\\frac{\\omega\\tau}{4})$\n- 积分性质要加 $\\pi X(0)\\delta(\\omega)$ 修正项\n- 本题 $X_1(0)=X_2(0)=0$，修正项消失\n- 最终 $X(j\\omega)=\\frac{E\\tau}{2}\\text{Sa}^2(\\frac{\\omega\\tau}{4})$",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 7
   }
  },
  {
   "id": "fmunqh8lxs",
   "kind": "formula",
   "x": -712,
   "y": 3443,
   "w": 320,
   "h": 41,
   "src": "x''(t)=\\frac{2E}{\\tau}\\left[\\delta\\left(t+\\frac{\\tau}{2}\\right)+\\delta\\left(t-\\frac{\\tau}{2}\\right)-2\\delta(t)\\right]",
   "tex": "x''(t)=\\frac{2E}{\\tau}\\left[\\delta\\left(t+\\frac{\\tau}{2}\\right)+\\delta\\left(t-\\frac{\\tau}{2}\\right)-2\\delta(t)\\right]",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 7
   }
  },
  {
   "id": "fmunqh8lxt",
   "kind": "formula",
   "x": -765,
   "y": 3502,
   "w": 373,
   "h": 41,
   "src": "X_2(j\\omega)=\\frac{2E}{\\tau}\\left(e^{j\\omega\\frac{\\tau}{2}}+e^{-j\\omega\\frac{\\tau}{2}}-2\\right)=-\\frac{8E}{\\tau}\\sin^2\\left(\\frac{\\omega\\tau}{4}\\right)",
   "tex": "X_2(j\\omega)=\\frac{2E}{\\tau}\\left(e^{j\\omega\\frac{\\tau}{2}}+e^{-j\\omega\\frac{\\tau}{2}}-2\\right)=-\\frac{8E}{\\tau}\\sin^2\\left(\\frac{\\omega\\tau}{4}\\right)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 7
   }
  },
  {
   "id": "fmunqh8lxu",
   "kind": "formula",
   "x": -650,
   "y": 3561,
   "w": 258,
   "h": 43,
   "src": "X_1(j\\omega)=\\frac{1}{j\\omega}X_2(j\\omega)+\\pi X_2(0)\\delta(\\omega)",
   "tex": "X_1(j\\omega)=\\frac{1}{j\\omega}X_2(j\\omega)+\\pi X_2(0)\\delta(\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 7
   }
  },
  {
   "id": "fmunqh8lxv",
   "kind": "formula",
   "x": -567,
   "y": 3622,
   "w": 175,
   "h": 41,
   "src": "X(j\\omega)=\\frac{E\\tau}{2}\\text{Sa}^2\\left(\\frac{\\omega\\tau}{4}\\right)",
   "tex": "X(j\\omega)=\\frac{E\\tau}{2}\\text{Sa}^2\\left(\\frac{\\omega\\tau}{4}\\right)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 7
   }
  },
  {
   "id": "nmunqh8lxw",
   "kind": "note",
   "x": 416,
   "y": 3830,
   "w": 400,
   "h": 391,
   "src": "",
   "tex": "",
   "text": "傅里叶变换的微分性质（第 8 页）\n\n这一页在讲一个很容易踩的坑：微分性质到底能不能反过来用。信号 $x(t)$ 是个高 1.5、宽 2 的矩形，底下垫着 0.5 的直流。左边同学先求导：$x'(t)=\\delta(t+1)-\\delta(t-1)$，变换得 $X_1(j\\omega)=2j\\sin(\\omega)$，再用 $X_1=j\\omega X$ 除回去，得 $X=2\\mathrm{Sa}(\\omega)$——错了。\n\n错在哪？微分性质 $\\mathcal{F}\\{x^{(n)}\\}=(j\\omega)^nX(j\\omega)$ 是单向的：从 $x$ 推导数没问题，但反过来除 $(j\\omega)^n$ 会丢掉 $\\omega=0$ 处的信息。因为 $x(t)$ 有非零直流分量 0.5，它的频谱在 $\\omega=0$ 有个 $\\pi\\delta(\\omega)$ 冲激；求导后直流被抹掉，$X_1(0)=0$，除 $j\\omega$ 时这个冲激就永远回不来了。所以左边答案少了 $\\pi\\delta(\\omega)$。\n\n右边用线性性质拆：$x(t)=0.5+\\mathrm{rect}_2(t)$，常数 0.5 变换是 $\\pi\\delta(\\omega)$，矩形变换是 $2\\mathrm{Sa}(\\omega)$，加起来才对。记住：微分性质只能正着用，想反解 $X$ 必须先确认信号没有直流分量。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 8
   }
  },
  {
   "id": "nmunqh8lxx",
   "kind": "note",
   "x": -792,
   "y": 3830,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 8 页 · 重点\n\n- 微分性质 $\\mathcal{F}\\{x^{(n)}\\}=(j\\omega)^nX(j\\omega)$ 只能正用\n- 反解 $X=X_n/(j\\omega)^n$ 会丢 $\\omega=0$ 的冲激\n- 有直流分量时频谱含 $\\pi\\delta(\\omega)$\n- 正确做法：线性拆成 $0.5+\\mathrm{rect}_2(t)$",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 8
   }
  },
  {
   "id": "fmunqh8lxy",
   "kind": "formula",
   "x": -656,
   "y": 3980,
   "w": 264,
   "h": 28,
   "src": "X_n(j\\omega)\\equiv\\mathcal{F}\\{x^{(n)}(t)\\}=(j\\omega)^nX(j\\omega)",
   "tex": "X_n(j\\omega)\\equiv\\mathcal{F}\\{x^{(n)}(t)\\}=(j\\omega)^nX(j\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 8
   }
  },
  {
   "id": "fmunqh8lxz",
   "kind": "formula",
   "x": -571,
   "y": 4026,
   "w": 179,
   "h": 28,
   "src": "X(j\\omega)=X_n(j\\omega)/(j\\omega)^n",
   "tex": "X(j\\omega)=X_n(j\\omega)/(j\\omega)^n",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 8
   }
  },
  {
   "id": "fmunqh8lx10",
   "kind": "formula",
   "x": -586,
   "y": 4072,
   "w": 194,
   "h": 28,
   "src": "x'(t)=\\delta(t+1)-\\delta(t-1)",
   "tex": "x'(t)=\\delta(t+1)-\\delta(t-1)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 8
   }
  },
  {
   "id": "fmunqh8lx11",
   "kind": "formula",
   "x": -581,
   "y": 4118,
   "w": 189,
   "h": 28,
   "src": "X(j\\omega)=\\pi\\delta(\\omega)+2\\mathrm{Sa}(\\omega)",
   "tex": "X(j\\omega)=\\pi\\delta(\\omega)+2\\mathrm{Sa}(\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 8
   }
  },
  {
   "id": "nmunqh8lx12",
   "kind": "note",
   "x": 416,
   "y": 4390,
   "w": 400,
   "h": 413,
   "src": "",
   "tex": "",
   "text": "第 9 页 · 讲解\n\n这一页讲的是微分性质的一个“坑”：微分性质本身是 $x^{(n)}(t) \\leftrightarrow (j\\omega)^n X(j\\omega)$，也就是对信号求 $n$ 阶导，频谱就乘上 $(j\\omega)^n$。但很多同学看到这个式子，第一反应是把它反过来除：既然 $X_n(j\\omega)=(j\\omega)^n X(j\\omega)$，那 $X(j\\omega)$ 不就等于 $X_n(j\\omega)/(j\\omega)^n$ 吗？这页第一行那个大大的“推不出”符号（$\\nRightarrow$）就是在说：不能直接这么除。\n\n为什么不能？因为从 $x(t)$ 到 $x^{(n)}(t)$ 的微分过程会丢掉信息。举个最直白的例子：常数信号 $x(t)=C$ 和零信号，它们的导数都是 0，频谱都是 0。你只知道导数的频谱是 0，根本分不清原信号到底是常数还是零。所以想从微分信号的频谱反推原信号，必须补一个条件，把丢掉的那部分信息找回来。\n\n这个条件就是黄色框里写的：$x(+\\infty)+x(-\\infty)=0$，也就是原信号在正负无穷远处的极限值加起来等于零。满足这个条件时，才能用 $X(j\\omega)=X_n(j\\omega)/(j\\omega)^n$ 反推。注意，这个条件不是随便加的，它正是保证反推唯一的关键。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 9
   }
  },
  {
   "id": "nmunqh8lx13",
   "kind": "note",
   "x": -792,
   "y": 4390,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 9 页 · 重点\n\n- 微分性质：$x^{(n)}(t) \\leftrightarrow (j\\omega)^n X(j\\omega)$\n- 不能直接除 $(j\\omega)^n$ 反推 $X(j\\omega)$\n- 反推前提：$x(+\\infty)+x(-\\infty)=0$\n- 满足前提才可用 $X_n(j\\omega)/(j\\omega)^n$",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 9
   }
  },
  {
   "id": "fmunqh8lx14",
   "kind": "formula",
   "x": -563,
   "y": 4540,
   "w": 171,
   "h": 28,
   "src": "X_n(j\\omega)=(j\\omega)^n X(j\\omega)",
   "tex": "X_n(j\\omega)=(j\\omega)^n X(j\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 9
   }
  },
  {
   "id": "fmunqh8lx15",
   "kind": "formula",
   "x": -556,
   "y": 4586,
   "w": 164,
   "h": 28,
   "src": "x(+\\infty)+x(-\\infty)=0",
   "tex": "x(+\\infty)+x(-\\infty)=0",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 9
   }
  },
  {
   "id": "fmunqh8lx16",
   "kind": "formula",
   "x": -571,
   "y": 4632,
   "w": 179,
   "h": 28,
   "src": "X(j\\omega)=X_n(j\\omega)/(j\\omega)^n",
   "tex": "X(j\\omega)=X_n(j\\omega)/(j\\omega)^n",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 9
   }
  },
  {
   "id": "nmunqh8lx17",
   "kind": "note",
   "x": 416,
   "y": 4950,
   "w": 400,
   "h": 488,
   "src": "",
   "tex": "",
   "text": "第 10 页 · 讲解\n\n这是本章的目录页，先别急着记，它其实是给你一张地图：这一章要按什么顺序把傅里叶变换讲完。\n\n前四条是打地基。第 1 条从非周期信号出发，把傅里叶变换的定义和它为什么这么定义讲清楚；第 2 条拿几个典型信号（比如矩形脉冲、指数信号）把变换对算出来，这些结果以后要当公式用；第 3 条回头处理周期信号——周期信号本来是用傅里叶级数描述的，这里要把它也纳入傅里叶变换的框架，靠的是冲激函数；第 4 条是性质，对称、时移、频移、尺度变换这些，目的是让你不用每次重新积分。\n\n第 5 条标了红字“重点”，这是全章的核心：时域卷积对应频域相乘，反过来时域相乘对应频域卷积。为什么重要？因为线性时不变系统的输出就是输入和冲激响应的卷积，有了这条性质，求输出就从“做卷积”变成“乘一下再反变换”，计算量差一个量级。\n\n第 6、7 条是收口：第 6 条用傅里叶变换去解线性常系数微分方程描述的系统，第 7 条是实际应用。所以这一页你只要记住一件事——第 5 条是重点，前面四条都是为了把它讲清楚而铺的路。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 10
   }
  },
  {
   "id": "nmunqh8lx18",
   "kind": "note",
   "x": -792,
   "y": 4950,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 10 页 · 重点\n\n- 第 1~4 条：定义、典型信号、周期信号、性质\n- 第 5 条是本章重点：卷积↔相乘\n- 第 6~7 条：解微分方程与实际应用\n- 先打地基再讲重点，顺序不能乱",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 10
   }
  },
  {
   "id": "nmunqh8lx19",
   "kind": "note",
   "x": 416,
   "y": 5510,
   "w": 400,
   "h": 398,
   "src": "",
   "tex": "",
   "text": "5.1 性质数学描述（第 11 页）\n\n这一页讲傅里叶变换的两条对偶性质，右上角那个蓝框就是全页的提纲，先记住它：时域卷积对应频域乘积，时域乘积对应频域卷积（还多带一个 $1/2\\pi$）。\n\n先看上面那条。$x(t)*h(t)$ 里的星号是卷积，不是乘法，它表示把 $h$ 翻转平移后和 $x$ 逐点相乘再积分，算起来很麻烦。这条性质说：别在时域硬算卷积，先各自做傅里叶变换得到 $X(j\\omega)$ 和 $H(j\\omega)$，在频域直接相乘，再变回去就行。这就是为什么 LTI 系统可以用 $H(j\\omega)$ 描述——输出频谱等于输入频谱乘上系统函数，卷积被换成了乘法。\n\n下面那条是它的对偶：时域里两个信号相乘，频域里就变成两个频谱做卷积，前面多出 $1/2\\pi$。这个系数来自傅里叶反变换定义里的 $1/2\\pi$，不是随便加的，做题时最容易漏。\n\n两条合起来看：卷积和乘法在时域、频域之间是互换的，只是其中一个方向要配 $1/2\\pi$。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 11
   }
  },
  {
   "id": "nmunqh8lx1a",
   "kind": "note",
   "x": -792,
   "y": 5510,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 11 页 · 重点\n\n- 时域卷积 $\\Leftrightarrow$ 频域乘积\n- 时域乘积 $\\Leftrightarrow$ 频域卷积，带 $1/2\\pi$\n- 卷积变乘法，是 LTI 频域分析的基础\n- $1/2\\pi$ 来自反变换定义，别漏",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 11
   }
  },
  {
   "id": "fmunqh8lx1b",
   "kind": "formula",
   "x": -604,
   "y": 5660,
   "w": 212,
   "h": 31,
   "src": "x(t)*h(t) \\xleftrightarrow{\\mathcal{F}} X(j\\omega)H(j\\omega)",
   "tex": "x(t)*h(t) \\xleftrightarrow{\\mathcal{F}} X(j\\omega)H(j\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 11
   }
  },
  {
   "id": "fmunqh8lx1c",
   "kind": "formula",
   "x": -625,
   "y": 5709,
   "w": 233,
   "h": 40,
   "src": "x(t)h(t) \\xleftrightarrow{\\mathcal{F}} \\frac{1}{2\\pi}X(j\\omega)*H(j\\omega)",
   "tex": "x(t)h(t) \\xleftrightarrow{\\mathcal{F}} \\frac{1}{2\\pi}X(j\\omega)*H(j\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 11
   }
  },
  {
   "id": "nmunqh8lx1d",
   "kind": "note",
   "x": 416,
   "y": 6070,
   "w": 400,
   "h": 406,
   "src": "",
   "tex": "",
   "text": "回顾：LTI系统的分析思路（第 12 页）\n\n这一页是把前面学过的所有方法串成一条线，告诉你为什么会有时域和频域两套解法。\n\n核心就一句话：输入信号的分解形式决定响应的求解方法。LTI系统是线性的，所以你把输入拆成几个基本信号之和，输出就等于每个基本信号单独作用后的响应之和。\n\n时域里，基本信号选的是冲激 $\\delta(t)$。任何信号都能写成 $x(t)=\\int_{-\\infty}^{\\infty}x(\\tau)\\delta(t-\\tau)d\\tau$，也就是把无数个不同时刻、不同强度的冲激叠加起来。系统对每个冲激的响应是 $h(t)$，叠加起来就是卷积 $y(t)=x(t)*h(t)$。\n\n频域里，基本信号换成了复指数 $e^{j\\omega t}$。复指数有个好性质：经过LTI系统后还是同频率的复指数，只是幅度和相位变了。所以输出就是 $Y(j\\omega)=X(j\\omega)H(j\\omega)$，乘法代替了卷积。\n\n注意，频域输入分解式里写的是 $dt$，严格说应该是 $d\\omega$，这里按课件原样保留。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 12
   }
  },
  {
   "id": "nmunqh8lx1e",
   "kind": "note",
   "x": -792,
   "y": 6070,
   "w": 400,
   "h": 155,
   "src": "",
   "tex": "",
   "text": "第 12 页 · 重点\n\n- 输入分解形式决定求解方法\n- 时域基本信号：$\\delta(t)$\n- 频域基本信号：$e^{j\\omega t}$\n- 时域求解：卷积 $y=x*h$\n- 频域求解：乘法 $Y=XH$",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 12
   }
  },
  {
   "id": "fmunqh8lx1f",
   "kind": "formula",
   "x": -665,
   "y": 6243,
   "w": 273,
   "h": 45,
   "src": "x(t)=\\sum_i c_i\\phi_i(t) \\rightarrow y(t)=\\sum_i c_i r_i(t)",
   "tex": "x(t)=\\sum_i c_i\\phi_i(t) \\rightarrow y(t)=\\sum_i c_i r_i(t)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 12
   }
  },
  {
   "id": "fmunqh8lx1g",
   "kind": "formula",
   "x": -590,
   "y": 6306,
   "w": 198,
   "h": 46,
   "src": "x(t)=\\int_{-\\infty}^{\\infty}x(\\tau)\\delta(t-\\tau)d\\tau",
   "tex": "x(t)=\\int_{-\\infty}^{\\infty}x(\\tau)\\delta(t-\\tau)d\\tau",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 12
   }
  },
  {
   "id": "fmunqh8lx1h",
   "kind": "formula",
   "x": -525,
   "y": 6370,
   "w": 133,
   "h": 28,
   "src": "y(t)=x(t)*h(t)",
   "tex": "y(t)=x(t)*h(t)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 12
   }
  },
  {
   "id": "fmunqh8lx1i",
   "kind": "formula",
   "x": -562,
   "y": 6416,
   "w": 170,
   "h": 28,
   "src": "Y(j\\omega)=X(j\\omega)H(j\\omega)",
   "tex": "Y(j\\omega)=X(j\\omega)H(j\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 12
   }
  },
  {
   "id": "nmunqh8lx1j",
   "kind": "note",
   "x": 416,
   "y": 6630,
   "w": 400,
   "h": 473,
   "src": "",
   "tex": "",
   "text": "时域卷积性质推导（第 13 页）\n\n这一页想干一件事：把“时域卷积”和“频域相乘”这层关系，从最根上推给你看，而不是让你死记。\n\n看中间那个黄框，它就是一个 LTI 系统，冲激响应 $h(t)$、频率响应 $H(j\\omega)$。左边一列是输入，右边一列是输出，从上往下看：最上面输入一个复指数 $e^{j\\omega_0 t}$，出来是 $H(j\\omega_0)e^{j\\omega_0 t}$——这就是复指数作为“特征函数”的意思：波形没变，只是被乘了个复数。\n\n关键在往下走。任意信号 $x(t)$ 可以拆成一堆不同频率复指数的叠加，也就是最下面那个积分 $\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}X(j\\omega)e^{j\\omega t}d\\omega$。既然系统是线性的，就可以“各个频率分别过系统、再叠加”：每个频率分量乘上自己的 $H(j\\omega)$，合起来就是输出。\n\n把 $H(j\\omega)$ 塞进积分号里，右边就变成 $\\frac{1}{2\\pi}\\int X(j\\omega)H(j\\omega)e^{j\\omega t}d\\omega$。而输出 $y(t)$ 的傅里叶反变换本来也是这个形式，只是里面是 $Y(j\\omega)$。两下一对比，被积函数必须相等，于是 $Y(j\\omega)=X(j\\omega)H(j\\omega)$。\n\n所以最下面那行不是新结论，是这一页推出来的结果：时域卷积，对应频域相乘。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 13
   }
  },
  {
   "id": "nmunqh8lx1k",
   "kind": "note",
   "x": -792,
   "y": 6630,
   "w": 400,
   "h": 155,
   "src": "",
   "tex": "",
   "text": "第 13 页 · 重点\n\n- 复指数是 LTI 的特征函数：$e^{j\\omega_0 t}\\to H(j\\omega_0)e^{j\\omega_0 t}$\n- 任意 $x(t)$ 可分解为复指数积分（叠加）\n- LTI 线性：各频率分量分别乘 $H(j\\omega)$ 再叠加\n- 对比 $y(t)$ 的反变换得 $Y(j\\omega)=X(j\\omega)H(j\\omega)$\n- 结论：$x(t)*h(t)\\leftrightarrow X(j\\omega)H(j\\omega)$",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 13
   }
  },
  {
   "id": "fmunqh8lx1l",
   "kind": "formula",
   "x": -726,
   "y": 6803,
   "w": 334,
   "h": 28,
   "src": "y(t)=x(t)*h(t)\\;\\longleftrightarrow\\;Y(j\\omega)=X(j\\omega)H(j\\omega)",
   "tex": "y(t)=x(t)*h(t)\\;\\longleftrightarrow\\;Y(j\\omega)=X(j\\omega)H(j\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 13
   }
  },
  {
   "id": "fmunqh8lx1m",
   "kind": "formula",
   "x": -603,
   "y": 6849,
   "w": 211,
   "h": 46,
   "src": "x(t)=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}X(j\\omega)e^{j\\omega t}\\,d\\omega",
   "tex": "x(t)=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}X(j\\omega)e^{j\\omega t}\\,d\\omega",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 13
   }
  },
  {
   "id": "fmunqh8lx1n",
   "kind": "formula",
   "x": -647,
   "y": 6913,
   "w": 255,
   "h": 46,
   "src": "y(t)=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}X(j\\omega)H(j\\omega)e^{j\\omega t}\\,d\\omega",
   "tex": "y(t)=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}X(j\\omega)H(j\\omega)e^{j\\omega t}\\,d\\omega",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 13
   }
  },
  {
   "id": "nmunqh8lx1o",
   "kind": "note",
   "x": 416,
   "y": 7190,
   "w": 400,
   "h": 504,
   "src": "",
   "tex": "",
   "text": "时域卷积性质推导（第 14 页）\n\n这一页要证明一件很实用的事：时域里做卷积，到了频域就变成简单的乘法。\n\n先把已知摆出来。系统输出是输入和冲激响应的卷积 $y(t)=x(t)*h(t)=\\int_{-\\infty}^{\\infty}x(\\tau)h(t-\\tau)d\\tau$，这是时域的定义式。现在对 $y(t)$ 做傅里叶变换，把卷积式整个代进 $Y(j\\omega)$ 的积分里，就得到第二行那个二重积分。\n\n关键一步是交换积分顺序。原来先对 $\\tau$ 积、再对 $t$ 积，现在反过来先对 $t$ 积。为什么能换？因为两个积分都是绝对可积的，二重积分可以按任意顺序算。换完之后，把只跟 $\\tau$ 有关的 $x(\\tau)$ 提到内层积分外面。\n\n接着做变量代换 $\\sigma=t-\\tau$，于是 $t=\\sigma+\\tau$，$dt=d\\sigma$。这一步是为了让内层积分变成 $h$ 的傅里叶变换的标准形式。代进去后，$e^{-j\\omega t}$ 拆成 $e^{-j\\omega\\tau}\\cdot e^{-j\\omega\\sigma}$，其中 $e^{-j\\omega\\tau}$ 与 $\\sigma$ 无关，可以提到内层积分外面。\n\n内层积分 $\\int_{-\\infty}^{\\infty}h(\\sigma)e^{-j\\omega\\sigma}d\\sigma$ 正好就是 $H(j\\omega)$，即冲激响应的傅里叶变换。把它代回，剩下的外层积分 $\\int_{-\\infty}^{\\infty}x(\\tau)e^{-j\\omega\\tau}d\\tau$ 就是 $X(j\\omega)$。\n\n所以 $Y(j\\omega)=X(j\\omega)H(j\\omega)$。时域的卷积，频域就是相乘。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 14
   }
  },
  {
   "id": "nmunqh8lx1p",
   "kind": "note",
   "x": -792,
   "y": 7190,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 14 页 · 重点\n\n- 时域卷积 $y=x*h$，频域相乘 $Y=XH$\n- 交换积分顺序是推导的关键一步\n- 变量代换 $\\sigma=t-\\tau$ 把内层凑成 $H(j\\omega)$\n- $H(j\\omega)$ 就是 $h(t)$ 的傅里叶变换",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 14
   }
  },
  {
   "id": "fmunqh8lx1q",
   "kind": "formula",
   "x": -681,
   "y": 7340,
   "w": 289,
   "h": 46,
   "src": "y(t)=x(t)*h(t)=\\int_{-\\infty}^{\\infty}x(\\tau)h(t-\\tau)d\\tau",
   "tex": "y(t)=x(t)*h(t)=\\int_{-\\infty}^{\\infty}x(\\tau)h(t-\\tau)d\\tau",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 14
   }
  },
  {
   "id": "fmunqh8lx1r",
   "kind": "formula",
   "x": -713,
   "y": 7404,
   "w": 321,
   "h": 46,
   "src": "Y(j\\omega)=\\int_{-\\infty}^{\\infty}\\left\\{\\int_{-\\infty}^{\\infty}x(\\tau)h(t-\\tau)d\\tau\\right\\}e^{-j\\omega t}dt",
   "tex": "Y(j\\omega)=\\int_{-\\infty}^{\\infty}\\left\\{\\int_{-\\infty}^{\\infty}x(\\tau)h(t-\\tau)d\\tau\\right\\}e^{-j\\omega t}dt",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 14
   }
  },
  {
   "id": "fmunqh8lx1s",
   "kind": "formula",
   "x": -591,
   "y": 7468,
   "w": 199,
   "h": 46,
   "src": "H(j\\omega)=\\int_{-\\infty}^{\\infty}h(\\sigma)e^{-j\\omega\\sigma}d\\sigma",
   "tex": "H(j\\omega)=\\int_{-\\infty}^{\\infty}h(\\sigma)e^{-j\\omega\\sigma}d\\sigma",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 14
   }
  },
  {
   "id": "fmunqh8lx1t",
   "kind": "formula",
   "x": -562,
   "y": 7532,
   "w": 170,
   "h": 28,
   "src": "Y(j\\omega)=X(j\\omega)H(j\\omega)",
   "tex": "Y(j\\omega)=X(j\\omega)H(j\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 14
   }
  },
  {
   "id": "nmunqh8lx1u",
   "kind": "note",
   "x": 416,
   "y": 7750,
   "w": 400,
   "h": 541,
   "src": "",
   "tex": "",
   "text": "通过时域卷积性质关联时域和频域 LTI 系统分析方法（第 15 页）\n\n这一页是整章的一个总结性对照图，把 LTI 系统的两种分析方法摆在一起看。\n\n上面那个方框图，输入是 $x(t)$，系统是 $h(t)$，输出是 $y(t)$；下面一行写的是它们各自的傅里叶变换 $X(j\\omega)$、$H(j\\omega)$、$Y(j\\omega)$。也就是说，同一个系统，时域里看是 $h(t)$，频域里看是 $H(j\\omega)$，这两个是同一件事的两种描述。\n\n关键在中间两行式子。时域里，输出等于输入和单位冲激响应做卷积：$y(t)=x(t)*h(t)$。卷积这个运算很麻烦，要翻转、平移、积分。但傅里叶变换有一条性质：时域卷积对应频域相乘。所以两边同时做傅里叶变换，就得到 $Y(j\\omega)=X(j\\omega)H(j\\omega)$。\n\n这就是这一页想让你记住的东西：时域里难算的卷积，到了频域就变成简单的乘法。所以分析 LTI 系统有两条路——要么在时域里卷，要么变换到频域里乘，结果是一样的。\n\n下面黄框里那对箭头，是在强调 $h(t)$ 和 $H(j\\omega)$ 是一对傅里叶变换对：$h(t)$ 叫单位冲激响应，$H(j\\omega)$ 叫频率响应。做题时经常是给你一个 $h(t)$，让你先求 $H(j\\omega)$，再在频域里乘，最后变回去。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 15
   }
  },
  {
   "id": "nmunqh8lx1v",
   "kind": "note",
   "x": -792,
   "y": 7750,
   "w": 400,
   "h": 155,
   "src": "",
   "tex": "",
   "text": "第 15 页 · 重点\n\n- 时域：$y(t)=x(t)*h(t)$\n- 频域：$Y(j\\omega)=X(j\\omega)H(j\\omega)$\n- 时域卷积 $\\Leftrightarrow$ 频域相乘\n- $h(t)$ 与 $H(j\\omega)$ 是傅里叶变换对\n- $H(j\\omega)$ 叫频率响应",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 15
   }
  },
  {
   "id": "fmunqh8lx1w",
   "kind": "formula",
   "x": -525,
   "y": 7923,
   "w": 133,
   "h": 28,
   "src": "y(t)=x(t)*h(t)",
   "tex": "y(t)=x(t)*h(t)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 15
   }
  },
  {
   "id": "fmunqh8lx1x",
   "kind": "formula",
   "x": -562,
   "y": 7969,
   "w": 170,
   "h": 28,
   "src": "Y(j\\omega)=X(j\\omega)H(j\\omega)",
   "tex": "Y(j\\omega)=X(j\\omega)H(j\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 15
   }
  },
  {
   "id": "fmunqh8lx1y",
   "kind": "formula",
   "x": -526,
   "y": 8015,
   "w": 134,
   "h": 34,
   "src": "h(t)\\ \\overset{\\mathcal{F}}{\\longleftrightarrow}\\ H(j\\omega)",
   "tex": "h(t)\\ \\overset{\\mathcal{F}}{\\longleftrightarrow}\\ H(j\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 15
   }
  },
  {
   "id": "nmunqh8lx1z",
   "kind": "note",
   "x": 416,
   "y": 8321,
   "w": 400,
   "h": 467,
   "src": "",
   "tex": "",
   "text": "h(t)、H(jω)与系统特性（第 16 页）\n\n这一页在回答一个问题：我们凭什么说 h(t) 和 H(jω) 能“代表”一个 LTI 系统？\n\n先说 h(t)。所谓单位冲激响应，就是拿 δ(t) 去敲一下系统，看它怎么回应。为什么这一下就能把系统摸透？因为 δ(t) 这个信号很特殊：它里面含有所有频率的分量，而且每个频率的幅度一样、相位都是零（这就是①说的“同幅零相”）。所以拿它当输入，等于同时把所有频率都送进系统测了一遍。输出 h(t) 里，每个频率分量被系统改成了什么样，就原原本本记在 h(t) 里（②）。\n\n再看 H(jω)。既然 h(t) 是“所有频率一起测”的结果，那把它按频率拆开看，每个频率上的复振幅是多少，就是 H(jω)。所以 H(jω) 是 h(t) 的频谱，它直接告诉你：系统对频率为 ω 的那个分量，幅度乘了多少、相位加了多少。\n\n③ 给的是它的定义式：$H(j\\omega)=\\frac{Y(j\\omega)}{X(j\\omega)}$，即输出频谱比输入频谱。注意这个式子成立的前提是系统为 LTI 且初始松弛，否则“频率分量各自独立地被改变”这件事就不成立。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 16
   }
  },
  {
   "id": "nmunqh8lx20",
   "kind": "note",
   "x": -792,
   "y": 8321,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 16 页 · 重点\n\n- $h(t)$ 是时域的系统身份证\n- $H(j\\omega)$ 是频域的系统身份证\n- $\\delta(t)$ 含所有同幅零相频率分量\n- $H(j\\omega)=Y(j\\omega)/X(j\\omega)$ 记录各频率的改变量",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 16
   }
  },
  {
   "id": "fmunqh8lx21",
   "kind": "formula",
   "x": -523,
   "y": 8471,
   "w": 131,
   "h": 46,
   "src": "H(j\\omega)=\\frac{Y(j\\omega)}{X(j\\omega)}",
   "tex": "H(j\\omega)=\\frac{Y(j\\omega)}{X(j\\omega)}",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 16
   }
  },
  {
   "id": "nmunqh8lx22",
   "kind": "note",
   "x": 416,
   "y": 8881,
   "w": 400,
   "h": 376,
   "src": "",
   "tex": "",
   "text": "时域卷积性质的应用（第 17 页）\n\n这一页拿微分器当例子，把上一节的卷积性质用一遍。微分器就是输出等于输入导数的系统，$y(t)=x'(t)$。\n\n怎么求单位冲激响应？令输入 $x(t)=\\delta(t)$，输出就是 $h(t)=\\delta'(t)$。这一步别死记，它只是把定义代进去。有了 $h(t)$，任意输入的输出就能写成卷积 $y(t)=\\delta'(t)*x(t)$。\n\n接下来换到频域。卷积在频域变乘法，而 $\\delta'(t)$ 的傅里叶变换是 $j\\omega$，所以 $Y(j\\omega)=j\\omega X(j\\omega)$，频率响应 $H(j\\omega)=j\\omega$。注意 $j\\omega$ 是纯虚数，它的模 $|\\omega|$ 随频率线性增大，说明微分器对高频分量放大、对低频分量抑制——这就是微分器在频域的样子。\n\n右边电路是它的实现：运放加输入电容和反馈电阻，构成微分器，输出 $V_o(t)=-RC\\,dV_i/dt$。跟理想微分器比，多了一个负号和常数 $RC$，负号来自反相放大，$RC$ 是时间常数，决定增益大小。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 17
   }
  },
  {
   "id": "nmunqh8lx23",
   "kind": "note",
   "x": -792,
   "y": 8881,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 17 页 · 重点\n\n- 微分器：$y(t)=x'(t)$\n- 冲激响应：$h(t)=\\delta'(t)$\n- 频响：$H(j\\omega)=j\\omega$\n- 电路实现：$V_o=-RC\\,dV_i/dt$",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 17
   }
  },
  {
   "id": "fmunqh8lx24",
   "kind": "formula",
   "x": -486,
   "y": 9031,
   "w": 94,
   "h": 28,
   "src": "h(t)=\\delta'(t)",
   "tex": "h(t)=\\delta'(t)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 17
   }
  },
  {
   "id": "fmunqh8lx25",
   "kind": "formula",
   "x": -528,
   "y": 9077,
   "w": 136,
   "h": 28,
   "src": "y(t)=\\delta'(t)*x(t)",
   "tex": "y(t)=\\delta'(t)*x(t)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 17
   }
  },
  {
   "id": "fmunqh8lx26",
   "kind": "formula",
   "x": -535,
   "y": 9123,
   "w": 143,
   "h": 28,
   "src": "Y(j\\omega)=j\\omega X(j\\omega)",
   "tex": "Y(j\\omega)=j\\omega X(j\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 17
   }
  },
  {
   "id": "fmunqh8lx27",
   "kind": "formula",
   "x": -492,
   "y": 9169,
   "w": 100,
   "h": 28,
   "src": "H(j\\omega)=j\\omega",
   "tex": "H(j\\omega)=j\\omega",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 17
   }
  },
  {
   "id": "nmunqh8lx28",
   "kind": "note",
   "x": 416,
   "y": 9441,
   "w": 400,
   "h": 511,
   "src": "",
   "tex": "",
   "text": "时域卷积性质的应用（第 18 页）\n\n这一页开始用卷积性质去算具体系统的频率响应，第一个例子是微分器。所谓微分器，就是输出等于输入导数的系统：$y(t)=\\frac{dx(t)}{dt}$。怎么求它的 $H(j\\omega)$？把两边做傅里叶变换，左边是 $Y(j\\omega)$，右边用微分性质变成 $j\\omega X(j\\omega)$，于是 $Y(j\\omega)=j\\omega X(j\\omega)$，而 $H=Y/X$，所以 $H(j\\omega)=j\\omega$。这就是这一页最上面那个式子，它不是背出来的，是推出来的。\n\n接下来看这个 $H$ 说明什么。取模：$|H(j\\omega)|=|\\omega|$，也就是增益随频率线性增长。图上那条 V 形红线就是这个意思：$\\omega$ 靠近 0 时增益很小，低频被压下去（蓝色区域，低频能量被衰减）；$\\omega$ 大时增益很大，高频被抬起来（黄色区域，高频能量被放大）。这跟直觉一致——信号变化越剧烈（高频成分越多），导数越大。\n\n再看相位：$\\angle H(j\\omega)=\\frac{\\pi}{2}\\operatorname{sgn}(\\omega)$。$j\\omega$ 中 $j$ 对应 $+\\pi/2$，$\\omega$ 为负时整体相当于 $-j|\\omega|$，相位是 $-\\pi/2$，所以正负频率各是一条水平线。$\\operatorname{sgn}$ 就是符号函数，$\\omega>0$ 取 1，$\\omega<0$ 取 $-1$。\n\n容易想错的地方：$|H|$ 是 $|\\omega|$ 而不是 $\\omega$，所以曲线对纵轴对称；另外微分器对高频噪声特别敏感，实际用的时候不会单独拿它去处理带噪信号。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 18
   }
  },
  {
   "id": "nmunqh8lx29",
   "kind": "note",
   "x": -792,
   "y": 9441,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 18 页 · 重点\n\n- 微分器：$y(t)=dx/dt$，故 $H(j\\omega)=j\\omega$\n- 幅频 $|H(j\\omega)|=|\\omega|$：低频衰减、高频放大\n- 相频为 $\\pm\\pi/2$，由 $\\operatorname{sgn}(\\omega)$ 决定\n- $H$ 由微分性质推出，不是硬记的",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 18
   }
  },
  {
   "id": "fmunqh8lx2a",
   "kind": "formula",
   "x": -492,
   "y": 9591,
   "w": 100,
   "h": 28,
   "src": "H(j\\omega)=j\\omega",
   "tex": "H(j\\omega)=j\\omega",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 18
   }
  },
  {
   "id": "fmunqh8lx2b",
   "kind": "formula",
   "x": -502,
   "y": 9637,
   "w": 110,
   "h": 28,
   "src": "|H(j\\omega)|=|\\omega|",
   "tex": "|H(j\\omega)|=|\\omega|",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 18
   }
  },
  {
   "id": "fmunqh8lx2c",
   "kind": "formula",
   "x": -547,
   "y": 9683,
   "w": 155,
   "h": 37,
   "src": "\\angle H(j\\omega)=\\frac{\\pi}{2}\\operatorname{sgn}(\\omega)",
   "tex": "\\angle H(j\\omega)=\\frac{\\pi}{2}\\operatorname{sgn}(\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 18
   }
  },
  {
   "id": "nmunqh8lx2d",
   "kind": "note",
   "x": 416,
   "y": 10001,
   "w": 400,
   "h": 446,
   "src": "",
   "tex": "",
   "text": "5.2 时域卷积性质的应用 (2)（第 19 页）\n\n这一页拿积分器当例子，把\"时域求冲激响应、频域求频率响应\"这条链路走一遍。\n\n积分器的输入输出关系是 $y(t)=\\int_{-\\infty}^{t}x(t)dt$。求冲激响应 $h(t)$，就是问：输入换成 $\\delta(t)$ 时输出是什么？把 $x$ 换成 $\\delta$，积分出来就是 $u(t)$——因为 $\\delta$ 只在 $t=0$ 那一瞬间有值，$t<0$ 时积分为 0，$t>0$ 时已经积到 1。所以 $h(t)=u(t)$。这一步最容易想错的是：积分器不是\"稳定\"系统，$u(t)$ 一直不衰减，所以它的频率响应里会多出一项。\n\n对 $h(t)=u(t)$ 做傅里叶变换，得到 $H(j\\omega)=\\frac{1}{j\\omega}+\\pi\\delta(\\omega)$。注意这里不是只有 $\\frac{1}{j\\omega}$：$u(t)$ 有直流分量，直流在频域就是 $\\omega=0$ 处的一个冲激，所以必须补上 $\\pi\\delta(\\omega)$。漏掉它，$\\omega=0$ 处的信息就丢了。\n\n右边电路是积分器的实现：运放反相端接 R、反馈接 C，输出电压 $V_o(t)=-\\frac{1}{RC}\\int_{-\\infty}^{t}V_i(\\tau)d\\tau$，负号来自反相接法，$\\frac{1}{RC}$ 是时间常数决定的系数。它和左边理想积分器只差一个常数和符号，说明这个电路确实能当积分器用。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 19
   }
  },
  {
   "id": "nmunqh8lx2e",
   "kind": "note",
   "x": -792,
   "y": 10001,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 19 页 · 重点\n\n- 积分器冲激响应 $h(t)=u(t)$\n- 频率响应含直流项 $\\pi\\delta(\\omega)$\n- 漏掉 $\\pi\\delta(\\omega)$ 是常见错误\n- 运放积分器差一个 $-\\frac{1}{RC}$",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 19
   }
  },
  {
   "id": "fmunqh8lx2f",
   "kind": "formula",
   "x": -577,
   "y": 10151,
   "w": 185,
   "h": 48,
   "src": "h(t)=\\int_{-\\infty}^{t}\\delta(t)dt=u(t)",
   "tex": "h(t)=\\int_{-\\infty}^{t}\\delta(t)dt=u(t)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 19
   }
  },
  {
   "id": "fmunqh8lx2g",
   "kind": "formula",
   "x": -555,
   "y": 10217,
   "w": 163,
   "h": 43,
   "src": "H(j\\omega)=\\frac{1}{j\\omega}+\\pi\\delta(\\omega)",
   "tex": "H(j\\omega)=\\frac{1}{j\\omega}+\\pi\\delta(\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 19
   }
  },
  {
   "id": "fmunqh8lx2h",
   "kind": "formula",
   "x": -590,
   "y": 10278,
   "w": 198,
   "h": 48,
   "src": "V_o(t)=-\\frac{1}{RC}\\int_{-\\infty}^{t}V_i(\\tau)d\\tau",
   "tex": "V_o(t)=-\\frac{1}{RC}\\int_{-\\infty}^{t}V_i(\\tau)d\\tau",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 19
   }
  },
  {
   "id": "nmunqh8lx2i",
   "kind": "note",
   "x": 416,
   "y": 10561,
   "w": 400,
   "h": 443,
   "src": "",
   "tex": "",
   "text": "时域卷积性质的应用（第 20 页）\n\n这一页是例4.17，目标很明确：求右上角那个三角脉冲 $x(t)$ 的傅里叶变换。硬算积分当然可以，但很麻烦；这里想走一条捷径——把三角形看成两个矩形脉冲的卷积。\n\n为什么能这么看？因为卷积在几何上就是“一个矩形滑过另一个矩形时重叠面积的变化”。两个宽度相同、位置相同的矩形，重叠面积从零开始线性涨到最大，再线性落回零，画出来正好是个三角形。所以三角形就是这两个矩形的卷积结果。\n\n关键要对上参数。下面两个矩形都是 $g(t)=E_0\\text{rect}_{\\tau/2}(t)$，宽度是 $\\tau/2$，从 $-\\tau/4$ 到 $\\tau/4$。卷积出来的三角形底边是 $\\tau$，正好是矩形宽度的两倍，符合黄色框里那句话。但高度对不上：两个矩形卷积后的峰值是 $E_0^2\\cdot\\tau/2$，而图上三角形的高是 $E$，所以 $E_0$ 不能随便取，得让 $E_0^2\\tau/2=E$ 才配得上。\n\n思路就是：先写出 $x(t)=g(t)*g(t)$，再用卷积性质 $x(t)=g*g\\;\\Longleftrightarrow\\;X(j\\omega)=G(j\\omega)^2$，把求三角形FT的问题变成求矩形FT再平方的问题。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 20
   }
  },
  {
   "id": "nmunqh8lx2j",
   "kind": "note",
   "x": -792,
   "y": 10561,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 20 页 · 重点\n\n- 三角形 = 两个相同矩形脉冲的卷积\n- 矩形宽 $\\tau/2$，三角形底边 $\\tau$，是两倍关系\n- 卷积后峰值 $E_0^2\\tau/2$ 要等于三角形高 $E$\n- 用 $X=G^2$ 把三角形FT转成矩形FT的平方",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 20
   }
  },
  {
   "id": "fmunqh8ly2k",
   "kind": "formula",
   "x": -536,
   "y": 10711,
   "w": 144,
   "h": 28,
   "src": "g(t)=E_0\\text{rect}_{\\tau/2}(t)",
   "tex": "g(t)=E_0\\text{rect}_{\\tau/2}(t)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 20
   }
  },
  {
   "id": "fmunqh8ly2l",
   "kind": "formula",
   "x": -524,
   "y": 10757,
   "w": 132,
   "h": 28,
   "src": "x(t)=g(t)*g(t)",
   "tex": "x(t)=g(t)*g(t)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 20
   }
  },
  {
   "id": "fmunqh8ly2m",
   "kind": "formula",
   "x": -523,
   "y": 10803,
   "w": 131,
   "h": 28,
   "src": "X(j\\omega)=G(j\\omega)^2",
   "tex": "X(j\\omega)=G(j\\omega)^2",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 20
   }
  },
  {
   "id": "fmunqh8ly2n",
   "kind": "formula",
   "x": -473,
   "y": 10849,
   "w": 81,
   "h": 37,
   "src": "E_0^2\\frac{\\tau}{2}=E",
   "tex": "E_0^2\\frac{\\tau}{2}=E",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 20
   }
  },
  {
   "id": "nmunqh8ly2o",
   "kind": "note",
   "x": 416,
   "y": 11121,
   "w": 400,
   "h": 436,
   "src": "",
   "tex": "",
   "text": "第 21 页 · 讲解\n\n这一页在算一个很典型的卷积：两个完全相同的矩形脉冲卷在一起。先看上面那排图，左边两个矩形都是宽 $\\tau/2$、高 $E_0$ 的门函数，中间那个星号就是卷积。卷积出来的结果 $x(t)$ 是个三角形，底宽 $\\tau$，峰值在 $t=0$。为什么是三角形？你可以这样想：卷积就是让一个矩形滑过另一个，重叠面积有多大，输出就有多大。$t=0$ 时两个矩形完全对齐，重叠面积最大，所以 $x(t)$ 在这里取峰值；往两边滑，重叠越来越少，输出就线性地掉下去，于是拼出一个三角形。\n\n下面用式子把峰值算出来。取 $t=0$，两个矩形完全重叠，积分就是两个 $E_0$ 相乘、在重叠区间 $-\\tau/4$ 到 $\\tau/4$ 上积，长度是 $\\tau/2$，所以峰值 $E=x(0)=E_0^2\\tau/2$。这一步最容易错的是把重叠区间长度当成 $\\tau$——注意每个矩形宽是 $\\tau/2$，完全重叠时公共部分就是 $\\tau/2$。\n\n最后一步走频域：时域卷积对应频域相乘，所以 $X(j\\omega)=G^2(j\\omega)$。矩形脉冲的频谱是 $E_0\\frac{\\tau}{2}\\mathrm{Sa}(\\frac{\\omega\\tau}{2})$，平方之后用 $E_0=\\sqrt{2E/\\tau}$ 代进去，就得到 $\\frac{E\\tau}{2}\\mathrm{Sa}^2(\\frac{\\omega\\tau}{4})$。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 21
   }
  },
  {
   "id": "nmunqh8ly2p",
   "kind": "note",
   "x": -792,
   "y": 11121,
   "w": 400,
   "h": 155,
   "src": "",
   "tex": "",
   "text": "第 21 页 · 重点\n\n- 两个相同矩形卷积得到三角形\n- 完全重叠时取峰值 $E=x(0)$\n- 重叠区间长度是 $\\tau/2$ 不是 $\\tau$\n- 时域卷积对应频域相乘 $X=G^2$\n- 结果频谱是 $\\mathrm{Sa}^2$ 形状",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 21
   }
  },
  {
   "id": "fmunqh8ly2q",
   "kind": "formula",
   "x": -675,
   "y": 11294,
   "w": 283,
   "h": 28,
   "src": "x(t)=g(t)*g(t),\\quad g(t)=E_0\\mathrm{rect}_{\\tau/2}(t)",
   "tex": "x(t)=g(t)*g(t),\\quad g(t)=E_0\\mathrm{rect}_{\\tau/2}(t)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 21
   }
  },
  {
   "id": "fmunqh8ly2r",
   "kind": "formula",
   "x": -596,
   "y": 11340,
   "w": 204,
   "h": 46,
   "src": "x(t)=\\int_{-\\infty}^{\\infty}g(\\alpha)g(t-\\alpha)\\,d\\alpha",
   "tex": "x(t)=\\int_{-\\infty}^{\\infty}g(\\alpha)g(t-\\alpha)\\,d\\alpha",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 21
   }
  },
  {
   "id": "fmunqh8ly2s",
   "kind": "formula",
   "x": -651,
   "y": 11404,
   "w": 261,
   "h": 37,
   "src": "E=x(0)=E_0^2\\cdot\\frac{\\tau}{2},\\quad E_0=\\sqrt{2E/\\tau}",
   "tex": "E=x(0)=E_0^2\\cdot\\frac{\\tau}{2},\\quad E_0=\\sqrt{2E/\\tau}",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 21
   }
  },
  {
   "id": "fmunqh8ly2t",
   "kind": "formula",
   "x": -637,
   "y": 11459,
   "w": 245,
   "h": 41,
   "src": "X(j\\omega)=G^2(j\\omega)=\\frac{E\\tau}{2}\\mathrm{Sa}^2\\left(\\frac{\\omega\\tau}{4}\\right)",
   "tex": "X(j\\omega)=G^2(j\\omega)=\\frac{E\\tau}{2}\\mathrm{Sa}^2\\left(\\frac{\\omega\\tau}{4}\\right)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 21
   }
  },
  {
   "id": "nmunqh8ly2u",
   "kind": "note",
   "x": 416,
   "y": 11681,
   "w": 400,
   "h": 392,
   "src": "",
   "tex": "",
   "text": "5.3 时域相乘性质推导（第 22 页）\n\n这一页要证的结论就一句话：两个信号在时域里相乘，到了频域就变成它们的频谱做卷积，还要除以 $2\\pi$。\n\n推导从定义出发。$r(t)=s(t)p(t)$，直接代进傅里叶变换的定义式，得到 $R(j\\omega)=\\int_{-\\infty}^{\\infty}s(t)p(t)e^{-j\\omega t}dt$。现在卡住了：$p(t)$ 的频谱信息没进来。\n\n关键一步是把 $p(t)$ 用傅里叶逆变换写回去：$p(t)=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}P(j\\theta)e^{j\\theta t}d\\theta$。注意这里积分变量换成 $\\theta$，是为了不和外面的 $\\omega$ 撞车——这一步最容易看晕，其实就是把 $p(t)$ 换成它频谱的积分表示。\n\n代进去以后，把两个积分交换顺序。交换后先对 $t$ 积分，里面正好凑出 $\\int_{-\\infty}^{\\infty}s(t)e^{-j(\\omega-\\theta)t}dt$，这就是 $S(j(\\omega-\\theta))$。\n\n最后得到 $R(j\\omega)=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}P(j\\theta)S(j(\\omega-\\theta))d\\theta$，按卷积定义就是 $\\frac{1}{2\\pi}P(j\\omega)*S(j\\omega)$。\n\n记住：时域相乘 = 频域卷积，别漏掉那个 $\\frac{1}{2\\pi}$。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 22
   }
  },
  {
   "id": "nmunqh8ly2v",
   "kind": "note",
   "x": -792,
   "y": 11681,
   "w": 400,
   "h": 155,
   "src": "",
   "tex": "",
   "text": "第 22 页 · 重点\n\n- 时域相乘 $r(t)=s(t)p(t)$\n- 频域对应卷积：$R=\\frac{1}{2\\pi}P*S$\n- 关键：$p(t)$ 用逆变换展开\n- 交换积分顺序后凑出 $S(j(\\omega-\\theta))$\n- 别漏掉系数 $\\frac{1}{2\\pi}$",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 22
   }
  },
  {
   "id": "fmunqh8ly2w",
   "kind": "formula",
   "x": -507,
   "y": 11854,
   "w": 115,
   "h": 28,
   "src": "r(t)=s(t)p(t)",
   "tex": "r(t)=s(t)p(t)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 22
   }
  },
  {
   "id": "fmunqh8ly2x",
   "kind": "formula",
   "x": -603,
   "y": 11900,
   "w": 211,
   "h": 46,
   "src": "R(j\\omega)=\\int_{-\\infty}^{\\infty}s(t)p(t)e^{-j\\omega t}dt",
   "tex": "R(j\\omega)=\\int_{-\\infty}^{\\infty}s(t)p(t)e^{-j\\omega t}dt",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 22
   }
  },
  {
   "id": "fmunqh8ly2y",
   "kind": "formula",
   "x": -591,
   "y": 11964,
   "w": 199,
   "h": 46,
   "src": "p(t)=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}P(j\\theta)e^{j\\theta t}d\\theta",
   "tex": "p(t)=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}P(j\\theta)e^{j\\theta t}d\\theta",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 22
   }
  },
  {
   "id": "fmunqh8ly2z",
   "kind": "formula",
   "x": -592,
   "y": 12028,
   "w": 200,
   "h": 40,
   "src": "R(j\\omega)=\\frac{1}{2\\pi}P(j\\omega)*S(j\\omega)",
   "tex": "R(j\\omega)=\\frac{1}{2\\pi}P(j\\omega)*S(j\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 22
   }
  },
  {
   "id": "nmunqh8ly30",
   "kind": "note",
   "x": 416,
   "y": 12241,
   "w": 400,
   "h": 458,
   "src": "",
   "tex": "",
   "text": "时域相乘性质：示例（第 23 页）\n\n这一页是拿上一节的「时域相乘性质」做一道具体的题：求 $\\mathcal{F}\\{s(t)\\cos(\\omega_0 t)\\}$。\n\n先回忆性质本身：时域里两个信号相乘，频域里就是它们的频谱做卷积（再除以 $2\\pi$，取决于你书上傅里叶变换的定义）。所以这里要做的就是把 $s(t)$ 的频谱 $S(j\\omega)$ 和 $\\cos(\\omega_0 t)$ 的频谱卷起来。\n\n右边那张图就是 $S(j\\omega)$：一个以 0 为中心、最高点 $A$、在 $\\pm\\omega_1$ 处降到零的偶对称波形。\n\n关键在下面那行绿字：$\\cos(\\omega_0 t)$ 的频谱不是一条线，而是 $\\omega=\\pm\\omega_0$ 处的两个冲激，每个面积是 $\\pi$。注意是 $\\pi$ 不是 1，这是由傅里叶变换的定义带出来的系数，考试里最容易漏。\n\n于是卷积就变得很简单：和冲激卷积等于把函数搬到冲激的位置再乘上冲激的面积。结果就是 $S(j\\omega)$ 被复制成两份，分别搬到 $\\pm\\omega_0$，各乘 $\\pi$。\n\n这就是调制：低频的 $s(t)$ 被余弦搬到了高频载波附近，频谱形状不变、位置平移。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 23
   }
  },
  {
   "id": "nmunqh8ly31",
   "kind": "note",
   "x": -792,
   "y": 12241,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 23 页 · 重点\n\n- 时域相乘 $\\Leftrightarrow$ 频域卷积\n- $\\cos(\\omega_0 t)$ 的频谱是两个冲激\n- 冲激面积是 $\\pi$，不是 1\n- 结果：$S(j\\omega)$ 搬移到 $\\pm\\omega_0$",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 23
   }
  },
  {
   "id": "fmunqh8ly32",
   "kind": "formula",
   "x": -797,
   "y": 12391,
   "w": 405,
   "h": 40,
   "src": "\\mathcal{F}\\{s(t)\\cos(\\omega_0 t)\\} = \\frac{1}{2\\pi} S(j\\omega) * \\pi\\{\\delta(\\omega+\\omega_0)+\\delta(\\omega-\\omega_0)\\}",
   "tex": "\\mathcal{F}\\{s(t)\\cos(\\omega_0 t)\\} = \\frac{1}{2\\pi} S(j\\omega) * \\pi\\{\\delta(\\omega+\\omega_0)+\\delta(\\omega-\\omega_0)\\}",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 23
   }
  },
  {
   "id": "fmunqh8ly33",
   "kind": "formula",
   "x": -666,
   "y": 12449,
   "w": 274,
   "h": 28,
   "src": "\\cos(\\omega_0 t) \\leftrightarrow \\pi\\{\\delta(\\omega+\\omega_0)+\\delta(\\omega-\\omega_0)\\}",
   "tex": "\\cos(\\omega_0 t) \\leftrightarrow \\pi\\{\\delta(\\omega+\\omega_0)+\\delta(\\omega-\\omega_0)\\}",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 23
   }
  },
  {
   "id": "fmunqh8ly34",
   "kind": "formula",
   "x": -767,
   "y": 12495,
   "w": 375,
   "h": 40,
   "src": "\\mathcal{F}\\{s(t)\\cos(\\omega_0 t)\\} = \\frac{1}{2}\\{S(j(\\omega-\\omega_0)) + S(j(\\omega+\\omega_0))\\}",
   "tex": "\\mathcal{F}\\{s(t)\\cos(\\omega_0 t)\\} = \\frac{1}{2}\\{S(j(\\omega-\\omega_0)) + S(j(\\omega+\\omega_0))\\}",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 23
   }
  },
  {
   "id": "nmunqh8ly35",
   "kind": "note",
   "x": 416,
   "y": 12801,
   "w": 400,
   "h": 398,
   "src": "",
   "tex": "",
   "text": "冲激信号卷积的波形搬移性质（第 24 页）\n\n这一页在复习一个很实用的结论：信号 $x(t)$ 和冲激信号做卷积，结果就是把 $x(t)$ 的波形整体搬到冲激所在的位置去。\n\n先看左边那一列。最上面是原信号 $x(t)$，它的尖峰在原点 $t=0$。中间是冲激 $\\delta(t+2)$，注意它的位置是 $t=-2$，不是 $+2$——$\\delta(t+2)=\\delta(t-(-2))$，括号里是 $t$ 减掉 $-2$，所以冲激落在 $-2$。最下面就是卷积结果 $y(t)=x(t)*\\delta(t+2)$，波形形状和 $x(t)$ 一模一样，只是尖峰从 $0$ 挪到了 $-2$。红色虚线箭头画的就是这个搬移过程。\n\n右边那一列是同一个道理，只是换了个波形：原信号 $x(t)$ 的峰在 $t=2$，和 $\\delta(t+2)$ 卷积后，整个波形被搬到 $-2$ 处。\n\n所以记法很简单：$x(t)*\\delta(t-t_0)=x(t-t_0)$。冲激出现在哪，波形就整体平移到哪。最容易错的是符号——$\\delta(t+2)$ 对应的是左移 $2$，不是右移。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 24
   }
  },
  {
   "id": "nmunqh8ly36",
   "kind": "note",
   "x": -792,
   "y": 12801,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 24 页 · 重点\n\n- $x(t)*\\delta(t-t_0)=x(t-t_0)$\n- 冲激在哪，波形就搬到哪\n- $\\delta(t+2)$ 的位置是 $t=-2$\n- 卷积不改变波形形状，只平移",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 24
   }
  },
  {
   "id": "fmunqh8ly37",
   "kind": "formula",
   "x": -588,
   "y": 12951,
   "w": 196,
   "h": 28,
   "src": "x(t)*\\delta(t-t_0)=x(t-t_0)",
   "tex": "x(t)*\\delta(t-t_0)=x(t-t_0)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 24
   }
  },
  {
   "id": "fmunqh8ly38",
   "kind": "formula",
   "x": -560,
   "y": 12997,
   "w": 168,
   "h": 28,
   "src": "\\delta(t+2)=\\delta(t-(-2))",
   "tex": "\\delta(t+2)=\\delta(t-(-2))",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 24
   }
  },
  {
   "id": "nmunqh8ly39",
   "kind": "note",
   "x": 416,
   "y": 13361,
   "w": 400,
   "h": 376,
   "src": "",
   "tex": "",
   "text": "时域相乘性质：示例（第 25 页）\n\n这一页是拿上一节的“时域相乘 = 频域卷积”去算一个具体例子：$s(t)\\cos(\\omega_0 t)$ 的频谱长什么样。\n\n先看已知条件。右上角画的是 $S(j\\omega)$，一个中心在 0、宽度到 $\\pm\\omega_1$、高度为 $A$ 的波形。下面那行绿字是必须记住的：$\\cos(\\omega_0 t)$ 的频谱就是两个冲激，分别落在 $\\pm\\omega_0$ 处，每个冲激的“面积”是 $\\pi$。\n\n接下来套卷积公式。时域相乘对应频域卷积，还要除以 $2\\pi$，所以 $R(j\\omega)=\\frac{1}{2\\pi}S(j\\omega)*\\pi\\{\\delta(\\omega+\\omega_0)+\\delta(\\omega-\\omega_0)\\}$。这里最容易卡住的一步是：函数和冲激卷积，等于把这个函数搬到冲激所在的位置。于是 $\\frac{1}{2\\pi}$ 和 $\\pi$ 约掉，得到 $\\frac{1}{2}S(j(\\omega+\\omega_0))+\\frac{1}{2}S(j(\\omega-\\omega_0))$。\n\n结果就是底下那张图：原来在 0 处的频谱被一分为二，一半搬到 $-\\omega_0$，一半搬到 $+\\omega_0$，高度从 $A$ 变成 $A/2$。这就是“频谱搬移”——调制、变频的数学本质。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 25
   }
  },
  {
   "id": "nmunqh8ly3a",
   "kind": "note",
   "x": -792,
   "y": 13361,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 25 页 · 重点\n\n- $\\cos(\\omega_0 t)$ 的频谱是 $\\pm\\omega_0$ 处两个冲激\n- 时域相乘 = 频域卷积，别忘 $\\frac{1}{2\\pi}$\n- 与冲激卷积 = 把波形搬到冲激位置\n- 结果：频谱一分为二，搬到 $\\pm\\omega_0$，幅度减半",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 25
   }
  },
  {
   "id": "fmunqh8ly3b",
   "kind": "formula",
   "x": -666,
   "y": 13511,
   "w": 274,
   "h": 28,
   "src": "\\cos(\\omega_0 t) \\leftrightarrow \\pi\\{\\delta(\\omega+\\omega_0)+\\delta(\\omega-\\omega_0)\\}",
   "tex": "\\cos(\\omega_0 t) \\leftrightarrow \\pi\\{\\delta(\\omega+\\omega_0)+\\delta(\\omega-\\omega_0)\\}",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 25
   }
  },
  {
   "id": "fmunqh8ly3c",
   "kind": "formula",
   "x": -693,
   "y": 13557,
   "w": 301,
   "h": 40,
   "src": "R(j\\omega)=\\frac{1}{2}S(j(\\omega+\\omega_0))+\\frac{1}{2}S(j(\\omega-\\omega_0))",
   "tex": "R(j\\omega)=\\frac{1}{2}S(j(\\omega+\\omega_0))+\\frac{1}{2}S(j(\\omega-\\omega_0))",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 25
   }
  },
  {
   "id": "nmunqh8ly3d",
   "kind": "note",
   "x": 416,
   "y": 13921,
   "w": 400,
   "h": 421,
   "src": "",
   "tex": "",
   "text": "频域平移特性（第 26 页）\n\n这一页讲的是：一个信号 $s(t)$ 乘上单频复指数 $e^{-j\\omega_0 t}$ 之后，它的频谱会怎么变。结论就写在最上面那行：时域相乘，对应频域做卷积，而卷积的对象是一个冲激 $2\\pi\\delta(\\omega+\\omega_0)$。\n\n冲激做卷积的作用就是「搬移」。频域里跟 $\\delta(\\omega+\\omega_0)$ 卷积，等于把原来的频谱 $S(j\\omega)$ 整体平移到 $\\omega=-\\omega_0$ 处，再乘上 $2\\pi$。所以最上面那行式子其实是在说：$s(t)e^{-j\\omega_0 t}$ 的频谱，就是把 $S(j\\omega)$ 搬到 $-\\omega_0$ 去。\n\n看下面三张图。最上面是原来的 $S(j\\omega)$，中心在 $0$，峰值 $A/2$。中间那根带 $(2\\pi)$ 的箭头，就是冲激的位置和大小。最下面那张图是结果：原来的频谱被搬到了 $-\\omega_0$，中心频率从 $0$ 变成了 $-\\omega_0$，峰值还是 $A/2$（因为 $\\frac{1}{2\\pi}\\cdot 2\\pi=1$，系数抵消了）。\n\n注意这里最容易想错的两点：一是乘的是 $e^{-j\\omega_0 t}$，频谱却往负方向搬，符号是反的；二是那个 $\\frac{1}{2\\pi}$ 和 $2\\pi$ 是配对的，别漏掉也别多乘。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 26
   }
  },
  {
   "id": "nmunqh8ly3e",
   "kind": "note",
   "x": -792,
   "y": 13921,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 26 页 · 重点\n\n- 时域乘复指数 $e^{-j\\omega_0 t}$，频域频谱搬移\n- 搬移量由冲激 $2\\pi\\delta(\\omega+\\omega_0)$ 决定\n- 中心频率：$0 \\to -\\omega_0$\n- 峰值保持 $A/2$，系数 $\\frac{1}{2\\pi}\\cdot 2\\pi=1$",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 26
   }
  },
  {
   "id": "fmunqh8ly3f",
   "kind": "formula",
   "x": -677,
   "y": 14071,
   "w": 285,
   "h": 40,
   "src": "\\frac{1}{2\\pi}S(j\\omega)*2\\pi\\delta(\\omega+\\omega_0) \\leftrightarrow s(t)\\times e^{-j\\omega_0 t}",
   "tex": "\\frac{1}{2\\pi}S(j\\omega)*2\\pi\\delta(\\omega+\\omega_0) \\leftrightarrow s(t)\\times e^{-j\\omega_0 t}",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 26
   }
  },
  {
   "id": "fmunqh8ly3g",
   "kind": "formula",
   "x": -640,
   "y": 14129,
   "w": 248,
   "h": 28,
   "src": "S(j\\omega)*\\delta(\\omega+\\omega_0)=S(j(\\omega+\\omega_0))",
   "tex": "S(j\\omega)*\\delta(\\omega+\\omega_0)=S(j(\\omega+\\omega_0))",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 26
   }
  },
  {
   "id": "nmunqh8ly3h",
   "kind": "note",
   "x": 416,
   "y": 14481,
   "w": 400,
   "h": 376,
   "src": "",
   "tex": "",
   "text": "调制与频移（第 27 页）\n\n这一页在算一件事：把一个一般信号 $s(t)$ 乘上余弦 $\n\\cos(\\omega_0 t)$，频谱会变成什么样。\n\n先把余弦拆成两个复指数：$\\cos(\\omega_0 t)=\\frac{1}{2}(e^{j\\omega_0 t}+e^{-j\\omega_0 t})$。乘上 $e^{j\\omega_0 t}$ 在频域里就是把整个频谱往右搬 $\\omega_0$，乘 $e^{-j\\omega_0 t}$ 就是往左搬 $\\omega_0$，再各乘 $\\frac{1}{2}$。所以结果就是：把原来的 $S(j\\omega)$ 一分为二，一半搬到 $+\\omega_0$，一半搬到 $-\\omega_0$。\n\n图上从下往上看最清楚。最下面红色是原来的 $S(j\\omega)$，中心在 0，高度 $A/2$。中间那层画的是两个复指数各自的频谱，就是 $\\omega_0$ 和 $-\\omega_0$ 处的冲激。最上面蓝色是乘完以后的结果：原来 0 处那块被劈成两半，分别跑到 $\\pm\\omega_0$，高度各是 $A/4$，形状不变。\n\n最容易想错的地方是高度：不是搬过去就完事，每份都要除以 2，所以峰值从 $A/2$ 变成 $A/4$。另外注意频谱是对称的，正负频率两边都要搬，不能只搬一边。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 27
   }
  },
  {
   "id": "nmunqh8ly3i",
   "kind": "note",
   "x": -792,
   "y": 14481,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 27 页 · 重点\n\n- 乘以 $\\cos(\\omega_0 t)$ 就是把频谱搬移 $\\pm\\omega_0$\n- 用欧拉公式拆成两个复指数之和\n- 搬移后幅度各乘 $1/2$，峰值变 $A/4$\n- 正负频率两侧都要搬，形状不变",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 27
   }
  },
  {
   "id": "fmunqh8ly3j",
   "kind": "formula",
   "x": -763,
   "y": 14631,
   "w": 371,
   "h": 40,
   "src": "\\mathcal{F}\\{s(t)\\cos(\\omega_0 t)\\}=\\frac{1}{2}S(j(\\omega-\\omega_0))+\\frac{1}{2}S(j(\\omega+\\omega_0))",
   "tex": "\\mathcal{F}\\{s(t)\\cos(\\omega_0 t)\\}=\\frac{1}{2}S(j(\\omega-\\omega_0))+\\frac{1}{2}S(j(\\omega+\\omega_0))",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 27
   }
  },
  {
   "id": "fmunqh8ly3k",
   "kind": "formula",
   "x": -595,
   "y": 14689,
   "w": 203,
   "h": 40,
   "src": "\\cos(\\omega_0 t)=\\frac{1}{2}(e^{j\\omega_0 t}+e^{-j\\omega_0 t})",
   "tex": "\\cos(\\omega_0 t)=\\frac{1}{2}(e^{j\\omega_0 t}+e^{-j\\omega_0 t})",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 27
   }
  },
  {
   "id": "nmunqh8ly3l",
   "kind": "note",
   "x": 416,
   "y": 15041,
   "w": 400,
   "h": 421,
   "src": "",
   "tex": "",
   "text": "傅里叶变换性质综合应用（第 28 页）\n\n这页是例 4.A8：已知频谱 $X_1(j\\omega)$ 的模和相位，反求时域信号 $x_1(t)$。先看模：在 $|\\omega|<3\\pi$ 内是一个从 $9\\pi$ 降到 0 再升回 $9\\pi$ 的 V 形，外面为 0；相位在 $\\omega<0$ 是 $-\\pi/2$，在 $\\omega>0$ 是 $+\\pi/2$。注意相位是奇对称的，所以 $x_1(t)$ 是实信号。\n\n右上角给了两条提示：对偶、时域微分。思路是：V 形是三角脉冲的导数形状，所以先对 $X_1(j\\omega)$ 求导，得到两个矩形脉冲的组合，再用对偶性质把频域的矩形变回时域的 sinc，最后积分回去。\n\n关键一步：$\\frac{d}{d\\omega}X_1(j\\omega)$ 在 $\\omega\\in(-3\\pi,0)$ 是 $+9\\pi/(3\\pi)=3$，在 $\\omega\\in(0,3\\pi)$ 是 $-3$，即两个高度相反的矩形。对偶告诉我们，频域的矩形对应时域的 sinc，所以 $x_1(t)$ 里会出现 $\\text{Sa}(3\\pi t)$ 这样的项。\n\n最容易错的地方：相位里的 $\\pm\\pi/2$ 不能丢，它对应时域的奇对称性；另外求导会引入 $jt$ 因子，积分时要除以 $jt$，别漏。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 28
   }
  },
  {
   "id": "nmunqh8ly3m",
   "kind": "note",
   "x": -792,
   "y": 15041,
   "w": 400,
   "h": 155,
   "src": "",
   "tex": "",
   "text": "第 28 页 · 重点\n\n- 由 $|X_1(j\\omega)|$ 和 $\\angle X_1(j\\omega)$ 反求 $x_1(t)$\n- V 形频谱求导得两个反相矩形\n- 对偶性质：频域矩形 ↔ 时域 $\\text{Sa}$ 函数\n- 相位奇对称 ⇒ $x_1(t)$ 为实信号\n- 求导引入 $jt$ 因子，积分时需除以 $jt$",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 28
   }
  },
  {
   "id": "fmunqh8ly3n",
   "kind": "formula",
   "x": -594,
   "y": 15214,
   "w": 202,
   "h": 28,
   "src": "X_1(j\\omega)=|X_1(j\\omega)|e^{j\\angle X_1(j\\omega)}",
   "tex": "X_1(j\\omega)=|X_1(j\\omega)|e^{j\\angle X_1(j\\omega)}",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 28
   }
  },
  {
   "id": "fmunqh8ly3o",
   "kind": "formula",
   "x": -775,
   "y": 15260,
   "w": 383,
   "h": 46,
   "src": "\\frac{d}{d\\omega}X_1(j\\omega)=3\\,\\text{rect}\\left(\\frac{\\omega+1.5\\pi}{3\\pi}\\right)-3\\,\\text{rect}\\left(\\frac{\\omega-1.5\\pi}{3\\pi}\\right)",
   "tex": "\\frac{d}{d\\omega}X_1(j\\omega)=3\\,\\text{rect}\\left(\\frac{\\omega+1.5\\pi}{3\\pi}\\right)-3\\,\\text{rect}\\left(\\frac{\\omega-1.5\\pi}{3\\pi}\\right)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 28
   }
  },
  {
   "id": "fmunqh8ly3p",
   "kind": "formula",
   "x": -615,
   "y": 15324,
   "w": 223,
   "h": 46,
   "src": "x_1(t)=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}X_1(j\\omega)e^{j\\omega t}\\,d\\omega",
   "tex": "x_1(t)=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}X_1(j\\omega)e^{j\\omega t}\\,d\\omega",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 28
   }
  },
  {
   "id": "nmunqh8ly3q",
   "kind": "note",
   "x": 416,
   "y": 15601,
   "w": 400,
   "h": 428,
   "src": "",
   "tex": "",
   "text": "第 29 页 · 讲解\n\n这一页是接着上一页算出来的频谱往下走，把 $X_1(j\\omega)$ 一步步化简，最后反变换回时域。\n\n先看第一行：把幅度和相位合起来写。$|X_1(j\\omega)|e^{\\angle X_1(j\\omega)}$ 就是极坐标形式的频谱。在 $\\omega\\in(-3\\pi,0]$ 时相位是 $-\\frac{\\pi}{2}$，乘上 $e^{-j\\pi/2}$ 等于 $-j$，所以 $-3\\omega\\cdot(-j)=3j\\omega$；在 $\\omega\\in(0,3\\pi)$ 时相位是 $+\\frac{\\pi}{2}$，乘上 $e^{j\\pi/2}=j$，所以 $3\\omega\\cdot j=3j\\omega$。两段合起来，就是 $|\\omega|<3\\pi$ 时 $X_1(j\\omega)=3j\\omega$，其余为 0。\n\n注意这里最容易想错的地方：$3j\\omega$ 是个纯虚数，说明这个信号频谱的相位恒为 $\\pm\\pi/2$，幅度是 $3|\\omega|$。\n\n接着写成 $3j\\omega\\cdot\\text{rect}_{6\\pi}(\\omega)$，就是把\"只在 $|\\omega|<3\\pi$ 有值\"这件事用一个矩形窗表示出来。\n\n下面用两个已知变换对来反推：矩形脉冲的变换是 Sa 函数，时域微分对应乘 $(j\\omega)^n$。于是 $\\text{rect}_{6\\pi}(\\omega)\\leftrightarrow 3\\text{Sa}(3\\pi t)$，再乘 $3j\\omega$ 就相当于对时域求导并乘 3，得到 $x_1(t)=9\\text{Sa}'(3\\pi t)$。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 29
   }
  },
  {
   "id": "nmunqh8ly3r",
   "kind": "note",
   "x": -792,
   "y": 15601,
   "w": 400,
   "h": 155,
   "src": "",
   "tex": "",
   "text": "第 29 页 · 重点\n\n- 极坐标合成：$|X|e^{\\angle X}$ 在正负 $\\omega$ 段都化为 $3j\\omega$\n- $X_1(j\\omega)=3j\\omega$ 仅在 $|\\omega|<3\\pi$ 内非零\n- 用 $\\text{rect}_{6\\pi}(\\omega)$ 表示频域门函数\n- 矩形脉冲 $\\leftrightarrow$ Sa 函数，时域微分 $\\leftrightarrow$ 乘 $(j\\omega)^n$\n- 最终 $x_1(t)=9\\text{Sa}'(3\\pi t)$",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 29
   }
  },
  {
   "id": "fmunqh8ly3s",
   "kind": "formula",
   "x": -579,
   "y": 15774,
   "w": 187,
   "h": 28,
   "src": "X_1(j\\omega)=3j\\omega\\cdot\\text{rect}_{6\\pi}(\\omega)",
   "tex": "X_1(j\\omega)=3j\\omega\\cdot\\text{rect}_{6\\pi}(\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 29
   }
  },
  {
   "id": "fmunqh8ly3t",
   "kind": "formula",
   "x": -556,
   "y": 15820,
   "w": 164,
   "h": 28,
   "src": "\\text{rect}_{6\\pi}(\\omega)\\leftrightarrow 3\\text{Sa}(3\\pi t)",
   "tex": "\\text{rect}_{6\\pi}(\\omega)\\leftrightarrow 3\\text{Sa}(3\\pi t)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 29
   }
  },
  {
   "id": "fmunqh8ly3u",
   "kind": "formula",
   "x": -559,
   "y": 15866,
   "w": 167,
   "h": 28,
   "src": "x^{(n)}(t)\\leftrightarrow (j\\omega)^n X(j\\omega)",
   "tex": "x^{(n)}(t)\\leftrightarrow (j\\omega)^n X(j\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 29
   }
  },
  {
   "id": "fmunqh8ly3v",
   "kind": "formula",
   "x": -527,
   "y": 15912,
   "w": 135,
   "h": 28,
   "src": "x_1(t)=9\\text{Sa}'(3\\pi t)",
   "tex": "x_1(t)=9\\text{Sa}'(3\\pi t)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 29
   }
  },
  {
   "id": "nmunqh8ly3w",
   "kind": "note",
   "x": 416,
   "y": 16161,
   "w": 400,
   "h": 413,
   "src": "",
   "tex": "",
   "text": "傅里叶变换性质综合应用（第 30 页）\n\n这一页是道综合题，考的不是怎么硬算傅里叶变换，而是看你能不能从 $x(t)$ 的图形直接读出频谱的几条性质。\n\n先看右边那个三角形：底边从 $t=-1$ 到 $t=3$，顶点在 $t=1$、高度是 2。注意它关于 $t=1$ 左右对称——这就是全题的关键。\n\n(1) 求相位 $\\varphi(\\omega)$。因为 $x(t)$ 是实偶对称的（关于 $t=1$ 对称），它的频谱 $X(j\\omega)$ 是实函数，所以相位只可能是 0 或 $\\pi$。\n\n(2) 求 $X(0)$。$X(0)$ 就是频谱在零频的值，等于 $x(t)$ 对时间的积分，也就是三角形面积：$\\frac{1}{2}\\times 4\\times 2=4$。\n\n(3) 求 $\\int_{-\\infty}^{\\infty}X(j\\omega)d\\omega$。这是逆变换在 $t=0$ 的值乘上 $2\\pi$，即 $2\\pi x(0)$。从图上看 $x(0)=1$，所以结果是 $2\\pi$。\n\n(4) 求 $g(t)=\\mathcal{F}^{-1}\\{\\text{Re}[X(j\\omega)]\\}$。利用奇偶虚实性质：$X(j\\omega)$ 的实部对应 $x(t)$ 的偶部，即 $\\frac{x(t)+x(-t)}{2}$。把 $x(t)$ 和它翻转后的 $x(-t)$ 加起来除以 2，就得到 $g(t)$。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 30
   }
  },
  {
   "id": "nmunqh8ly3x",
   "kind": "note",
   "x": -792,
   "y": 16161,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 30 页 · 重点\n\n- $x(t)$ 关于 $t=1$ 对称，$X(j\\omega)$ 为实函数\n- $X(0)$ 等于 $x(t)$ 的面积，即 4\n- $\\int X(j\\omega)d\\omega = 2\\pi x(0) = 2\\pi$\n- $\\text{Re}[X(j\\omega)]$ 对应 $x(t)$ 的偶部",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 30
   }
  },
  {
   "id": "fmunqh8ly3y",
   "kind": "formula",
   "x": -537,
   "y": 16311,
   "w": 145,
   "h": 46,
   "src": "X(0)=\\int_{-\\infty}^{\\infty}x(t)dt",
   "tex": "X(0)=\\int_{-\\infty}^{\\infty}x(t)dt",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 30
   }
  },
  {
   "id": "fmunqh8ly3z",
   "kind": "formula",
   "x": -572,
   "y": 16375,
   "w": 180,
   "h": 46,
   "src": "\\int_{-\\infty}^{\\infty}X(j\\omega)d\\omega=2\\pi x(0)",
   "tex": "\\int_{-\\infty}^{\\infty}X(j\\omega)d\\omega=2\\pi x(0)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 30
   }
  },
  {
   "id": "fmunqh8ly40",
   "kind": "formula",
   "x": -683,
   "y": 16439,
   "w": 291,
   "h": 42,
   "src": "g(t)=\\mathcal{F}^{-1}\\{\\text{Re}[X(j\\omega)]\\}=\\frac{x(t)+x(-t)}{2}",
   "tex": "g(t)=\\mathcal{F}^{-1}\\{\\text{Re}[X(j\\omega)]\\}=\\frac{x(t)+x(-t)}{2}",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 30
   }
  },
  {
   "id": "nmunqh8ly41",
   "kind": "note",
   "x": 416,
   "y": 16721,
   "w": 400,
   "h": 496,
   "src": "",
   "tex": "",
   "text": "第 31 页 · 讲解\n\n这一页是接着上一页的三角形脉冲 $x(t)$ 往下算它的相位谱 $\\varphi(\\omega)$。直接算 $x(t)$ 的相位不好下手，所以先做一个平移：令 $x_0(t)=x(t+1)$，就是把 $x(t)$ 往左挪 1，挪完以后这个三角形正好关于纵轴对称，变成一个实偶信号。\n\n时域平移对应频域乘一个 $e^{j\\omega}$，所以 $X_0(j\\omega)=X(j\\omega)e^{j\\omega}$。这一步是关键：平移只改变相位，不改变幅度。\n\n接下来看 $x_0(t)$ 的性质。它是实偶的三角脉冲，而三角脉冲可以看成两个相同的实偶门信号做卷积。实偶信号做卷积，结果还是实偶的；它的频谱就是门信号频谱的平方，平方出来一定是非负实数，所以 $X_0(j\\omega)\\ge 0$。一个频谱是非负实数，说明它的相位只能是 0 或 $\\pi$，而这里连续变化，相位谱就是 0。\n\n于是 $X_0(j\\omega)=|X_0(j\\omega)|$，是纯实数。代回平移关系，$X_0(j\\omega)=|X(j\\omega)|e^{j\\varphi(\\omega)}e^{j\\omega}$，它的相位是 $\\varphi(\\omega)+\\omega$，而这个相位必须等于 0，所以 $\\varphi(\\omega)=-\\omega$。\n\n注意这里容易想错的地方：不要以为 $x(t)$ 的相位谱是 0，它其实是 $-\\omega$，是平移带来的线性相位。右下角那三条——时移、卷积、奇偶虚实——就是这一页用到的三个性质。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 31
   }
  },
  {
   "id": "nmunqh8ly42",
   "kind": "note",
   "x": -792,
   "y": 16721,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 31 页 · 重点\n\n- 平移 $x_0(t)=x(t+1)$ 使信号变实偶\n- 时移性质：$X_0(j\\omega)=X(j\\omega)e^{j\\omega}$\n- 实偶信号频谱为实偶，相位为 0\n- 由 $\\varphi(\\omega)+\\omega=0$ 得 $\\varphi(\\omega)=-\\omega$",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 31
   }
  },
  {
   "id": "fmunqh8ly43",
   "kind": "formula",
   "x": -517,
   "y": 16871,
   "w": 125,
   "h": 28,
   "src": "x_0(t)=x(t+1)",
   "tex": "x_0(t)=x(t+1)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 31
   }
  },
  {
   "id": "fmunqh8ly44",
   "kind": "formula",
   "x": -677,
   "y": 16917,
   "w": 285,
   "h": 28,
   "src": "X_0(j\\omega)=X(j\\omega)e^{j\\omega}=|X(j\\omega)|e^{j\\varphi(\\omega)}e^{j\\omega}",
   "tex": "X_0(j\\omega)=X(j\\omega)e^{j\\omega}=|X(j\\omega)|e^{j\\varphi(\\omega)}e^{j\\omega}",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 31
   }
  },
  {
   "id": "fmunqh8ly45",
   "kind": "formula",
   "x": -538,
   "y": 16963,
   "w": 146,
   "h": 28,
   "src": "X_0(j\\omega)=|X_0(j\\omega)|",
   "tex": "X_0(j\\omega)=|X_0(j\\omega)|",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 31
   }
  },
  {
   "id": "fmunqh8ly46",
   "kind": "formula",
   "x": -601,
   "y": 17009,
   "w": 209,
   "h": 28,
   "src": "\\varphi(\\omega)+\\omega=0,\\quad \\varphi(\\omega)=-\\omega",
   "tex": "\\varphi(\\omega)+\\omega=0,\\quad \\varphi(\\omega)=-\\omega",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 31
   }
  },
  {
   "id": "nmunqh8ly47",
   "kind": "note",
   "x": 416,
   "y": 17281,
   "w": 400,
   "h": 368,
   "src": "",
   "tex": "",
   "text": "第 32 页 · 讲解\n\n这一页在讲一个很实用的技巧：怎么一眼看出频谱在 $\\omega=0$ 处的值。把 $\\omega=0$ 代进傅里叶变换的定义式，指数项变成 $e^{-j0t}=1$，于是 $X(0)$ 就等于信号 $x(t)$ 在整个时间轴上的积分，也就是波形和横轴围出的**面积**。上面那个三角形信号，底边长 4、高 2，面积正好是 4，所以 $X(0)=4$，不用真去算积分。\n\n下面两张图是同一个道理的两个例子。左边矩形脉冲宽 2、高 1，面积是 2，所以它频谱在 $\\omega=0$ 处的高度就是 2。右边那个 $\\text{sinc}$ 形状的频谱，它和横轴围出的总面积是 1，注意这个面积不是 $X(0)$ 本身，而是 $X(0)$ 再除以 $2\\pi$。\n\n所以关键区别在这里：时域面积直接等于 $X(0)$，而频域面积等于 $X(0)/2\\pi$，那个 $2\\pi$ 是反变换公式里带出来的，别把两个面积混为一谈。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 32
   }
  },
  {
   "id": "nmunqh8ly48",
   "kind": "note",
   "x": -792,
   "y": 17281,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 32 页 · 重点\n\n- $X(0)$ 就是 $x(t)$ 与 $t$ 轴围成的面积\n- 时域面积 $=X(0)$\n- 频域面积 $=X(0)/2\\pi$\n- 矩形脉冲面积 $=2$，对应 $X(0)=2$",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 32
   }
  },
  {
   "id": "fmunqh8ly49",
   "kind": "formula",
   "x": -581,
   "y": 17431,
   "w": 189,
   "h": 46,
   "src": "X(j\\omega)=\\int_{-\\infty}^{\\infty}x(t)e^{-j\\omega t}dt",
   "tex": "X(j\\omega)=\\int_{-\\infty}^{\\infty}x(t)e^{-j\\omega t}dt",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 32
   }
  },
  {
   "id": "fmunqh8ly4a",
   "kind": "formula",
   "x": -537,
   "y": 17495,
   "w": 145,
   "h": 46,
   "src": "X(0)=\\int_{-\\infty}^{\\infty}x(t)dt",
   "tex": "X(0)=\\int_{-\\infty}^{\\infty}x(t)dt",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 32
   }
  },
  {
   "id": "fmunqh8ly4b",
   "kind": "formula",
   "x": -472,
   "y": 17559,
   "w": 78,
   "h": 37,
   "src": "\\frac{\\text{area}}{2\\pi}=1",
   "tex": "\\frac{\\text{area}}{2\\pi}=1",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 32
   }
  },
  {
   "id": "nmunqh8ly4c",
   "kind": "note",
   "x": 416,
   "y": 17841,
   "w": 400,
   "h": 309,
   "src": "",
   "tex": "",
   "text": "第 33 页 · 讲解\n\n这一页在讲傅里叶变换的一个常用性质：对频谱 $X(j\\omega)$ 在整个频率轴上积分，结果等于 $2\\pi x(0)$。\n\n推导只用到逆变换定义（IFT）：$x(t)=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}X(j\\omega)e^{j\\omega t}d\\omega$。把 $t=0$ 代进去，指数项变成 $e^{0}=1$，于是 $x(0)=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}X(j\\omega)d\\omega$，两边乘 $2\\pi$ 就得到 $\\int_{-\\infty}^{\\infty}X(j\\omega)d\\omega=2\\pi x(0)$。\n\n上面那个三角形信号，$x(0)=2$，所以积分等于 $4\\pi$。注意这里积的是频谱，不是时间信号；$x(0)$ 是信号在原点的值，不是面积。\n\n下面那组图是同一件事的图形版：左边矩形脉冲的频谱是 sinc，sinc 曲线下的面积除以 $2\\pi$ 正好等于 $x(0)=1$。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 33
   }
  },
  {
   "id": "nmunqh8ly4d",
   "kind": "note",
   "x": -792,
   "y": 17841,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 33 页 · 重点\n\n- $\\int_{-\\infty}^{\\infty}X(j\\omega)d\\omega=2\\pi x(0)$\n- 由 IFT 令 $t=0$ 直接得到\n- 频谱积分看的是 $x(0)$，不是面积\n- 矩形脉冲：频谱面积$/2\\pi=1$",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 33
   }
  },
  {
   "id": "fmunqh8ly4e",
   "kind": "formula",
   "x": -578,
   "y": 17991,
   "w": 186,
   "h": 46,
   "src": "x(0)=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}X(j\\omega)d\\omega",
   "tex": "x(0)=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}X(j\\omega)d\\omega",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 33
   }
  },
  {
   "id": "fmunqh8ly4f",
   "kind": "formula",
   "x": -572,
   "y": 18055,
   "w": 180,
   "h": 46,
   "src": "\\int_{-\\infty}^{\\infty}X(j\\omega)d\\omega=2\\pi x(0)",
   "tex": "\\int_{-\\infty}^{\\infty}X(j\\omega)d\\omega=2\\pi x(0)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 33
   }
  },
  {
   "id": "nmunqh8ly4g",
   "kind": "note",
   "x": 416,
   "y": 18401,
   "w": 400,
   "h": 398,
   "src": "",
   "tex": "",
   "text": "第 34 页 · 讲解\n\n这一页在推一个结论：把频谱 $X(j\\omega)$ 的实部单独拿出来做反变换，得到的是什么？答案是 $g(t)=\\{x(t)+x(-t)\\}/2$，也就是原信号和它左右翻折后的平均。\n\n推导的关键只有两步。第一步，实部可以用共轭拆开：$\\mathrm{Re}\\{X(j\\omega)\\}=\\frac{X(j\\omega)+X^*(j\\omega)}{2}$，这是复数求实部的定义，跟信号无关。第二步，因为 $x(t)$ 是实函数，它的频谱有共轭对称性 $X(-j\\omega)=X^*(j\\omega)$，于是把上式里的 $X^*(j\\omega)$ 换成 $X(-j\\omega)$，实部就写成了 $\\{X(j\\omega)+X(-j\\omega)\\}/2$。\n\n接下来做反变换。$X(j\\omega)$ 反变换回 $x(t)$，而 $X(-j\\omega)$ 反变换回 $x(-t)$——这就是右下角写的“反褶”，频率取负对应时间翻转。两者相加再除以 2，就得到 $g(t)$。\n\n看右上角的图最直观：$x(t)$ 是那个三角形，$x(-t)$ 是它关于纵轴翻过来的样子，两者平均后，原来不对称的部分被抵消，只剩偶对称的那一半。所以记住：频谱的实部只携带信号的偶部信息，虚部才管奇部。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 34
   }
  },
  {
   "id": "nmunqh8ly4h",
   "kind": "note",
   "x": -792,
   "y": 18401,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 34 页 · 重点\n\n- 实部拆共轭：$\\mathrm{Re}\\{X\\}=\\frac{X+X^*}{2}$\n- 实信号频谱共轭对称：$X(-j\\omega)=X^*(j\\omega)$\n- 频率取负对应时间反褶：$x(-t)\\leftrightarrow X(-j\\omega)$\n- 结论：$g(t)$ 是 $x(t)$ 的偶部",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 34
   }
  },
  {
   "id": "fmunqh8ly4i",
   "kind": "formula",
   "x": -572,
   "y": 18551,
   "w": 180,
   "h": 28,
   "src": "g(t)=\\mathcal{F}^{-1}\\{\\mathrm{Re}[X(j\\omega)]\\}",
   "tex": "g(t)=\\mathcal{F}^{-1}\\{\\mathrm{Re}[X(j\\omega)]\\}",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 34
   }
  },
  {
   "id": "fmunqh8ly4j",
   "kind": "formula",
   "x": -628,
   "y": 18597,
   "w": 236,
   "h": 42,
   "src": "\\mathrm{Re}\\{X(j\\omega)\\}=\\frac{X(j\\omega)+X^*(j\\omega)}{2}",
   "tex": "\\mathrm{Re}\\{X(j\\omega)\\}=\\frac{X(j\\omega)+X^*(j\\omega)}{2}",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 34
   }
  },
  {
   "id": "fmunqh8ly4k",
   "kind": "formula",
   "x": -537,
   "y": 18657,
   "w": 145,
   "h": 28,
   "src": "X(-j\\omega)=X^*(j\\omega)",
   "tex": "X(-j\\omega)=X^*(j\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 34
   }
  },
  {
   "id": "fmunqh8ly4l",
   "kind": "formula",
   "x": -546,
   "y": 18703,
   "w": 154,
   "h": 42,
   "src": "g(t)=\\frac{x(t)+x(-t)}{2}",
   "tex": "g(t)=\\frac{x(t)+x(-t)}{2}",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 34
   }
  },
  {
   "id": "nmunqh8ly4m",
   "kind": "note",
   "x": 416,
   "y": 18961,
   "w": 400,
   "h": 518,
   "src": "",
   "tex": "",
   "text": "连续时间傅里叶变换的性质（第 35 页）\n\n这一页是 CTFT 的性质总表，相当于一本“换算手册”：左边一列是时域里对信号做了什么，右边一列告诉你频域里会跟着变成什么。符号 $\\leftrightarrow$ 读作“对应”，表示 $x(t)$ 和 $X(j\\omega)$ 是一对傅里叶变换。\n\n先看最基础的两条。唯一性说时域和频域是一一对应的，知道一个就能唯一确定另一个。线性说变换是“按比例、可叠加”的：$ax(t)+by(t)$ 的频谱就是 $aX(j\\omega)+bY(j\\omega)$，这是后面所有推导的地基。\n\n再看两组最容易混的。时移 $x(t-t_0)$ 只让频谱乘上 $e^{-j\\omega t_0}$，幅度不变、只改相位，所以“信号晚到一会儿”不改变它含哪些频率；频移 $x(t)e^{j\\omega_0 t}$ 则把整个频谱搬到 $\\omega_0$ 处，这正是调制和通信的数学根据。\n\n微分积分那几条要抓规律：时域微分一次，频域就乘一个 $j\\omega$，所以 $n$ 阶导对应 $(j\\omega)^n$；反过来频域微分对应时域乘 $-jt$。时域积分多出一项 $\\pi X(0)\\delta(\\omega)$，是因为积分可能留下直流分量，这一项最容易漏。\n\n最后两条是重头戏：时域卷积对应频域相乘，时域相乘对应频域卷积（带 $1/2\\pi$）。这就是为什么滤波器可以在频域里直接乘。尺度变换那条注意 $1/|a|$：时域压得越窄，频域就展得越宽。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 35
   }
  },
  {
   "id": "nmunqh8ly4n",
   "kind": "note",
   "x": -792,
   "y": 18961,
   "w": 400,
   "h": 155,
   "src": "",
   "tex": "",
   "text": "第 35 页 · 重点\n\n- 线性：$ax+by\\leftrightarrow aX+bY$\n- 时移只改相位，频移搬移频谱\n- 时域微分乘 $j\\omega$，积分多直流项\n- 时域卷积 $\\leftrightarrow$ 频域相乘\n- 尺度变换：时域压窄、频域展宽",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 35
   }
  },
  {
   "id": "fmunqh8ly4o",
   "kind": "formula",
   "x": -574,
   "y": 19134,
   "w": 182,
   "h": 28,
   "src": "x(t-t_0)\\leftrightarrow X(j\\omega)e^{-j\\omega t_0}",
   "tex": "x(t-t_0)\\leftrightarrow X(j\\omega)e^{-j\\omega t_0}",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 35
   }
  },
  {
   "id": "fmunqh8ly4p",
   "kind": "formula",
   "x": -582,
   "y": 19180,
   "w": 190,
   "h": 28,
   "src": "x(t)e^{j\\omega_0 t}\\leftrightarrow X(j(\\omega-\\omega_0))",
   "tex": "x(t)e^{j\\omega_0 t}\\leftrightarrow X(j(\\omega-\\omega_0))",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 35
   }
  },
  {
   "id": "fmunqh8ly4q",
   "kind": "formula",
   "x": -559,
   "y": 19226,
   "w": 167,
   "h": 28,
   "src": "x^{(n)}(t)\\leftrightarrow (j\\omega)^n X(j\\omega)",
   "tex": "x^{(n)}(t)\\leftrightarrow (j\\omega)^n X(j\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 35
   }
  },
  {
   "id": "fmunqh8ly4r",
   "kind": "formula",
   "x": -592,
   "y": 19272,
   "w": 200,
   "h": 28,
   "src": "x(t)*h(t)\\leftrightarrow X(j\\omega)H(j\\omega)",
   "tex": "x(t)*h(t)\\leftrightarrow X(j\\omega)H(j\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 35
   }
  },
  {
   "id": "nmunqh8ly4s",
   "kind": "note",
   "x": 416,
   "y": 19521,
   "w": 400,
   "h": 421,
   "src": "",
   "tex": "",
   "text": "利用FT性质计算傅里叶变换的一般方法（第 36 页）\n\n这一页是这一章的收口，把前面讲的一堆性质（时移、频移、尺度、卷积、微分……）串成一套能照着做的流程。\n\n核心思想一句话：傅里叶变换的定义式积分 $X(j\\omega)=\\int_{-\\infty}^{\\infty}x(t)e^{-j\\omega t}dt$ 不是拿来硬算的。真正要算的信号，几乎都能拆成几个已知变换对（比如矩形脉冲、$e^{-at}u(t)$、$\\delta(t)$）经过平移、缩放、相乘、卷积拼出来的。所以第一步是看信号长什么样，认出它和哪个已知信号差在哪，然后用对应的性质把两者的变换连起来。\n\n第二步才是动笔：既然关系已经建立，就顺着关系把待求的 $X(j\\omega)$ 解出来，而不是重新积分。注意这里说的是正变换和逆变换都能这么干——已知频谱求时域信号时，同样先找它和哪个已知频谱差一个平移或缩放。\n\n最容易想错的地方：性质不是随便挑的，得看信号形式里到底出现了什么操作。看到 $x(t-t_0)$ 用时移，看到 $x(at)$ 用尺度，看到两个信号相乘用频域卷积。选错性质，关系就搭不起来。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 36
   }
  },
  {
   "id": "nmunqh8ly4t",
   "kind": "note",
   "x": -792,
   "y": 19521,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 36 页 · 重点\n\n- 先看信号形式，再选性质\n- 把待求变换对与已知变换对建立关系\n- 用性质间接求解，不硬算积分\n- 正变换、逆变换都可用此法",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 36
   }
  },
  {
   "id": "fmunqh8ly4u",
   "kind": "formula",
   "x": -581,
   "y": 19671,
   "w": 189,
   "h": 46,
   "src": "X(j\\omega)=\\int_{-\\infty}^{\\infty}x(t)e^{-j\\omega t}dt",
   "tex": "X(j\\omega)=\\int_{-\\infty}^{\\infty}x(t)e^{-j\\omega t}dt",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 36
   }
  },
  {
   "id": "nmunqh8ly4v",
   "kind": "note",
   "x": 416,
   "y": 20081,
   "w": 400,
   "h": 488,
   "src": "",
   "tex": "",
   "text": "线性常系数微分方程描述系统（第 37 页）\n\n这一页是目录，但别急着翻过去——红色标出的第 6 条就是接下来要讲的新内容：用线性常系数微分方程描述的系统。\n\n先把前面几条串一下，你就知道现在站在哪。第 1 条讲非周期信号的傅里叶变换，也就是从周期信号的傅里叶级数推广出去，让周期趋于无穷，谱线变成连续的频谱。第 2 条把常见信号（比如矩形脉冲、指数信号）的变换结果列成表，方便查。第 3 条反过来，用傅里叶变换去处理周期信号，这样周期和非周期就统一在一套工具里了。第 4、5 条是性质：时移、频移、微分、积分，还有最要紧的卷积定理——时域卷积对应频域相乘。\n\n那第 6 条为什么放在这儿？因为前面这些性质不是拿来欣赏的，是要用的。一个线性常系数微分方程，描述的是输入 $x(t)$ 和输出 $y(t)$ 之间的微分关系，直接解很麻烦。但两边做傅里叶变换，微分就变成乘 $j\\omega$，方程变成代数方程，解出 $Y(j\\omega)=H(j\\omega)X(j\\omega)$，再反变换回去就行。这就是第 7 条“傅里叶变换的应用”要干的事。\n\n注意：这里说的“线性常系数”，就是方程里 $y$ 和 $x$ 及其各阶导数都只乘常数、相加，没有平方、没有互相乘。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 37
   }
  },
  {
   "id": "nmunqh8ly4w",
   "kind": "note",
   "x": -792,
   "y": 20081,
   "w": 400,
   "h": 178,
   "src": "",
   "tex": "",
   "text": "第 37 页 · 重点\n\n- 第 6 条是本页新起点：线性常系数微分方程描述系统\n- 前 5 条是工具：变换、典型信号、周期信号、性质、卷积\n- 微分方程经傅里叶变换化为代数方程\n- 输出频谱 $Y(j\\omega)=H(j\\omega)X(j\\omega)$\n- 第 7 条是应用，用变换解系统问题",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 37
   }
  },
  {
   "id": "fmunqh8ly4x",
   "kind": "formula",
   "x": -562,
   "y": 20277,
   "w": 170,
   "h": 28,
   "src": "Y(j\\omega)=H(j\\omega)X(j\\omega)",
   "tex": "Y(j\\omega)=H(j\\omega)X(j\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 37
   }
  },
  {
   "id": "fmunqh8ly4y",
   "kind": "formula",
   "x": -560,
   "y": 20323,
   "w": 168,
   "h": 42,
   "src": "\\frac{d^n y(t)}{dt^n} \\leftrightarrow (j\\omega)^n Y(j\\omega)",
   "tex": "\\frac{d^n y(t)}{dt^n} \\leftrightarrow (j\\omega)^n Y(j\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 37
   }
  },
  {
   "id": "nmunqh8ly4z",
   "kind": "note",
   "x": 416,
   "y": 20641,
   "w": 400,
   "h": 466,
   "src": "",
   "tex": "",
   "text": "6.1 系统输入输出方程（第 38 页）\n\n这一页是第六章的开头，先告诉你：我们后面要研究的“连续 LTI 系统”，很大一部分可以用一个方程来刻画。\n\n上面那个框图就是系统的意思：左边 $x(t)$ 是输入，右边 $y(t)$ 是输出，中间那个方框代表系统本身。LTI 是“线性时不变”的缩写——线性指输入翻倍输出也翻倍、两个输入之和的响应等于各自响应之和；时不变指输入晚一会儿进来，输出也只是同样晚一会儿，形状不变。\n\n下面那个长式子就是这类系统的“身份证”。左边全是 $y(t)$ 和它的各阶导数，右边全是 $x(t)$ 和它的各阶导数，$a_N,\\dots,a_0$ 和 $b_M,\\dots,b_0$ 都是常数。为什么叫 N 阶？因为左边 $y$ 的最高导数是 N 阶。为什么叫线性？因为 $y$ 和 $x$ 都只以一次方、不带乘积地出现。为什么叫非齐次？因为右边不等于零，有输入项在推着系统走。\n\n注意一个容易看错的地方：右边第二项课件上写的是 $a_{M-1}$，按常理这里应该是 $b_{M-1}$，你按 $b$ 来理解就行。另外，这个方程是“输入输出方程”，它只关心外面看得到的 $x$ 和 $y$ 的关系，不涉及系统内部状态——这正是它和后面状态方程的区别。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 38
   }
  },
  {
   "id": "nmunqh8ly50",
   "kind": "note",
   "x": -792,
   "y": 20641,
   "w": 400,
   "h": 155,
   "src": "",
   "tex": "",
   "text": "第 38 页 · 重点\n\n- 连续 LTI 系统可由常系数线性微分方程描述\n- 左边是 $y(t)$ 及其各阶导数，右边是 $x(t)$ 及其各阶导数\n- $a_i$、$b_j$ 均为常数，$y$ 的最高阶数 $N$ 决定系统阶数\n- 右边非零，所以是“非齐次”方程\n- 该方程只描述输入输出关系，不涉及内部状态",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 38
   }
  },
  {
   "id": "fmunqh8ly51",
   "kind": "formula",
   "x": -952,
   "y": 20814,
   "w": 756,
   "h": 43,
   "src": "a_N\\frac{d^N y(t)}{dt^N}+a_{N-1}\\frac{d^{N-1}y(t)}{dt^{N-1}}+\\cdots+a_1\\frac{dy(t)}{dt}+a_0 y(t)=b_M\\frac{d^M x(t)}{dt^M}+b_{M-1}\\frac{d^{M-1}x(t)}{dt^{M-1}}+\\cdots+b_1\\frac{dx(t)}{dt}+b_0 x(t)",
   "tex": "a_N\\frac{d^N y(t)}{dt^N}+a_{N-1}\\frac{d^{N-1}y(t)}{dt^{N-1}}+\\cdots+a_1\\frac{dy(t)}{dt}+a_0 y(t)=b_M\\frac{d^M x(t)}{dt^M}+b_{M-1}\\frac{d^{M-1}x(t)}{dt^{M-1}}+\\cdots+b_1\\frac{dx(t)}{dt}+b_0 x(t)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 38
   }
  },
  {
   "id": "nmunqh8ly52",
   "kind": "note",
   "x": 416,
   "y": 21201,
   "w": 400,
   "h": 474,
   "src": "",
   "tex": "",
   "text": "6.1 系统输入输出方程（第 39 页）\n\n这一页干的事只有一件：把时域里的微分方程，变成频域里一个简单的除法，从而得到频率响应 $H(j\\omega)$。\n\n最上面那行是系统在时域的描述：左边是输出的各阶导数加权求和，右边是输入的各阶导数加权求和，$a_k$、$b_k$ 是常系数。这种方程直接解很麻烦，要解微分方程。\n\n关键一步是中间那个 $\\mathcal{FT}$：两边同时做傅里叶变换。这里用到傅里叶变换最重要的一条性质——时域求导，频域就是乘 $j\\omega$。所以 $\\frac{d^k y(t)}{dt^k}$ 变成 $(j\\omega)^k Y(j\\omega)$，$x$ 那边同理。这一步把微分运算变成了乘法，方程一下子从微积分降级成代数。\n\n再往下是把 $Y(j\\omega)$ 和 $X(j\\omega)$ 提到求和号外面——因为它们对 $k$ 求和来说不含 $k$，是常数，可以提出来。提出来以后，左边只剩 $Y$ 乘一个关于 $\\omega$ 的多项式，右边只剩 $X$ 乘另一个多项式。\n\n最后一步就是移项相除，定义 $H(j\\omega)=Y/X$，等于两个多项式之比。注意：这里默认 $X(j\\omega)\\neq 0$，而且 $H$ 只由系统自己的 $a_k$、$b_k$ 决定，跟输入无关——这正是“系统函数”的含义。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 39
   }
  },
  {
   "id": "nmunqh8ly53",
   "kind": "note",
   "x": -792,
   "y": 21201,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 39 页 · 重点\n\n- 时域微分方程 $\\sum a_k y^{(k)}=\\sum b_k x^{(k)}$\n- 求导性质：$\\frac{d^k}{dt^k}\\leftrightarrow(j\\omega)^k$\n- 把 $Y$、$X$ 提到求和号外，得代数方程\n- $H(j\\omega)=Y/X$，只由系统参数决定",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 39
   }
  },
  {
   "id": "fmunqh8ly54",
   "kind": "formula",
   "x": -601,
   "y": 21351,
   "w": 209,
   "h": 58,
   "src": "\\sum_{k=0}^{N} a_k \\frac{d^k y(t)}{dt^k} = \\sum_{k=0}^{M} b_k \\frac{d^k x(t)}{dt^k}",
   "tex": "\\sum_{k=0}^{N} a_k \\frac{d^k y(t)}{dt^k} = \\sum_{k=0}^{M} b_k \\frac{d^k x(t)}{dt^k}",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 39
   }
  },
  {
   "id": "fmunqh8ly55",
   "kind": "formula",
   "x": -672,
   "y": 21427,
   "w": 280,
   "h": 58,
   "src": "\\sum_{k=0}^{N} a_k (j\\omega)^k Y(j\\omega) = \\sum_{k=0}^{N} b_k (j\\omega)^k X(j\\omega)",
   "tex": "\\sum_{k=0}^{N} a_k (j\\omega)^k Y(j\\omega) = \\sum_{k=0}^{N} b_k (j\\omega)^k X(j\\omega)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 39
   }
  },
  {
   "id": "fmunqh8ly56",
   "kind": "formula",
   "x": -641,
   "y": 21503,
   "w": 249,
   "h": 53,
   "src": "H(j\\omega) = \\frac{Y(j\\omega)}{X(j\\omega)} = \\frac{\\sum_{k=0}^{N} b_k (j\\omega)^k}{\\sum_{k=0}^{N} a_k (j\\omega)^k}",
   "tex": "H(j\\omega) = \\frac{Y(j\\omega)}{X(j\\omega)} = \\frac{\\sum_{k=0}^{N} b_k (j\\omega)^k}{\\sum_{k=0}^{N} a_k (j\\omega)^k}",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 39
   }
  },
  {
   "id": "nmunqh8ly57",
   "kind": "note",
   "x": 416,
   "y": 21761,
   "w": 400,
   "h": 556,
   "src": "",
   "tex": "",
   "text": "6.2 在频域中求解非齐次微分方程（ODE）（第 40 页）\n\n这一页是6.2节的一个完整算例，把\"列方程→变到频域→反变换\"这条流水线走一遍。电路在右边：电压源 e(t) 串 R1，后面并两条支路——电容 C 和\"L 串 R2\"。要求的是流过 R1 的电流 i(t) 的单位冲激响应，也就是 e(t)=δ(t) 时的 i(t)。\n\n左边三个方程就是基尔霍夫定律加元件关系：(1) 是左边回路的 KVL，电源电压被 R1 和电容分掉；(2) 是右边回路的 KVL，电容电压等于电感电压加 R2 上的电压；(3) 是节点电流，i 分成电容支路和电感支路两股。三个未知量 i、v_C、i_L，三个方程，够解。\n\n中间那步消元是这页最容易卡住的地方：由 (1) 得 v_C=e−R1 i，代入 (3) 把 i_L 用 i 和 e 表示出来，再一起塞进 (2)，就得到那个二阶常系数方程 i''+7i'+10i=e''+6e'+4e。注意右边不是光秃秃的 e(t)，还带着 e 的导数——这正是电路里出现二阶导数的原因，别以为写错了。\n\n有了微分方程，两边取傅里叶变换，导数就变成乘 jω，微分方程立刻变成代数方程，解出 H(jω)=I/E。分母 (jω)²+7jω+10 因式分解成 (jω+2)(jω+5)，所以部分分式展开成 1 减去两个一阶项。最后逐项反变换：常数 1 对应 δ(t)，1/(2+jω) 对应 e^{−2t}u(t)，1/(5+jω) 对应 e^{−5t}u(t)，就得到 h(t)。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 40
   }
  },
  {
   "id": "nmunqh8ly58",
   "kind": "note",
   "x": -792,
   "y": 21761,
   "w": 400,
   "h": 155,
   "src": "",
   "tex": "",
   "text": "第 40 页 · 重点\n\n- 先列 KVL/KCL 三方程，消去 $v_C$、$i_L$ 得二阶 ODE\n- 方程右边含 $e$ 的导数，不是笔误\n- 频域里求导变乘 $j\\omega$，微分方程变代数式\n- 分母因式分解 $(j\\omega+2)(j\\omega+5)$ 后部分分式展开\n- 常数 1 反变换为 $\\delta(t)$，冲激响应含冲激项",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 40
   }
  },
  {
   "id": "fmunqh8ly59",
   "kind": "formula",
   "x": -716,
   "y": 21934,
   "w": 324,
   "h": 28,
   "src": "i''(t)+7i'(t)+10i(t)=e''(t)+6e'(t)+4e(t)",
   "tex": "i''(t)+7i'(t)+10i(t)=e''(t)+6e'(t)+4e(t)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 40
   }
  },
  {
   "id": "fmunqh8ly5a",
   "kind": "formula",
   "x": -663,
   "y": 21980,
   "w": 271,
   "h": 47,
   "src": "H(j\\omega)=\\frac{I(j\\omega)}{E(j\\omega)}=\\frac{(j\\omega)^2+6j\\omega+4}{(j\\omega)^2+7j\\omega+10}",
   "tex": "H(j\\omega)=\\frac{I(j\\omega)}{E(j\\omega)}=\\frac{(j\\omega)^2+6j\\omega+4}{(j\\omega)^2+7j\\omega+10}",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 40
   }
  },
  {
   "id": "fmunqh8ly5b",
   "kind": "formula",
   "x": -643,
   "y": 22045,
   "w": 251,
   "h": 43,
   "src": "H(j\\omega)=1-\\frac{4}{3}\\frac{1}{2+j\\omega}+\\frac{1}{3}\\frac{1}{5+j\\omega}",
   "tex": "H(j\\omega)=1-\\frac{4}{3}\\frac{1}{2+j\\omega}+\\frac{1}{3}\\frac{1}{5+j\\omega}",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 40
   }
  },
  {
   "id": "fmunqh8ly5c",
   "kind": "formula",
   "x": -652,
   "y": 22106,
   "w": 260,
   "h": 40,
   "src": "h(t)=\\delta(t)-\\frac{4}{3}e^{-2t}u(t)+\\frac{1}{3}e^{-5t}u(t)",
   "tex": "h(t)=\\delta(t)-\\frac{4}{3}e^{-2t}u(t)+\\frac{1}{3}e^{-5t}u(t)",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 40
   }
  },
  {
   "id": "nmunqh8ly5d",
   "kind": "note",
   "x": 416,
   "y": 22347,
   "w": 400,
   "h": 443,
   "src": "",
   "tex": "",
   "text": "在频域中求解非齐次微分方程（ODE）（第 41 页）\n\n这一页不是新推导，是给刚学完的频域解法做个总结，顺便告诉你后面为什么要学拉普拉斯变换。\n\n先说优点。时域里解微分方程，得做积分、定常数，一步错步步错；换到频域，微分这个动作直接变成乘 $j\\omega$，也就是把 $\\frac{d}{dt}$ 换成 $j\\omega$，方程从微分方程变成代数方程，解完再反变换回去。这就是“简化计算”四个字的全部含义——不是数学变简单了，是运算类型变了。\n\n但频域法有两个硬伤。第一，从电路或系统结构写出时域输入输出微分方程本身就很麻烦，元件一多、阶数一高，列方程比解方程还费时间。第二，傅里叶变换不是对什么信号都收敛，像 $e^{at}u(t)$（$a>0$）这种增长信号，积分根本不收敛，变换不存在，频域法直接失效。\n\n所以最后一句是伏笔：第 9 章要学的拉普拉斯变换，相当于给傅里叶变换乘上一个衰减因子 $e^{-\\sigma t}$，把不收敛的信号拉回可积的范围，同时保留“微分变乘法”这个最大好处。这一页要你记住的就是这个取舍：频域法赢在运算，输在适用范围和建模成本。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 41
   }
  },
  {
   "id": "nmunqh8ly5e",
   "kind": "note",
   "x": -792,
   "y": 22347,
   "w": 400,
   "h": 155,
   "src": "",
   "tex": "",
   "text": "第 41 页 · 重点\n\n- 频域法核心：微分运算 $\\to$ 乘法运算\n- 优点：把微分方程化为代数方程\n- 缺点一：建立时域微分方程复杂耗时\n- 缺点二：部分信号的傅里叶变换难求\n- 第9章拉氏变换可解决上述困难",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 41
   }
  },
  {
   "id": "fmunqh8ly5f",
   "kind": "formula",
   "x": -482,
   "y": 22520,
   "w": 90,
   "h": 41,
   "src": "\\frac{d}{dt} \\longleftrightarrow j\\omega",
   "tex": "\\frac{d}{dt} \\longleftrightarrow j\\omega",
   "text": "",
   "locked": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 41
   }
  },
  {
   "id": "nmunqh8ly5g",
   "kind": "note",
   "x": 416,
   "y": 22907,
   "w": 400,
   "h": 301,
   "src": "",
   "tex": "",
   "text": "第 42 页 · 讲解\n\n这一页是作业布置页，没有新知识点。上面只有一行：4.30 和 4.37，指的是教材第 4 章的第 30 题和第 37 题，题号前面的 4 是章号，不是题号的一部分。\n\n你需要做的是：翻到教材第 4 章，找到这两道题，按题目要求完整做一遍。这一页本身不提供任何公式或方法，所以别指望从这页里看出解法——解法都在前面第 4 章讲过的内容里，做题时哪一步卡住了，就回去翻对应的小节。\n\n交作业前注意两点：一是写清楚题号和必要的推导步骤，不要只写一个答案；二是这两题大概率对应本章的核心方法，做的时候顺手想一下它考的是哪个概念，比单纯算出结果更有用。",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 42
   }
  },
  {
   "id": "nmunqh8ly5h",
   "kind": "note",
   "x": -792,
   "y": 22907,
   "w": 400,
   "h": 132,
   "src": "",
   "tex": "",
   "text": "第 42 页 · 重点\n\n- 作业为教材第 4 章的 4.30、4.37 两题\n- 题号中 4 是章号，30/37 是题号\n- 解法在本章前面小节，卡住就回翻\n- 写清步骤，不要只给答案",
   "locked": true,
   "rich": true,
   "ask": {
    "doc": ".资料/ch4-CT傅里叶变换-4-3.pdf",
    "page": 42
   }
  },
  {
   "id": "fmunqqwh87f",
   "kind": "formula",
   "x": -593.7,
   "y": 3895.5,
   "w": 209,
   "h": 46,
   "src": "x(t)=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}X(j\\omega)e^{j\\omega t}d\\omega",
   "tex": "x(t)=\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty}X(j\\omega)e^{j\\omega t}d\\omega",
   "text": ""
  },
  {
   "id": "fmunqtgzf7g",
   "kind": "formula",
   "x": 841.3,
   "y": 3131.3,
   "w": 282,
   "h": 56,
   "src": "X_T(j\\omega)=\\sum_{k=-\\infty}^{\\infty}X_0(jk\\omega_1)\\omega_1\\delta(\\omega-k\\omega_1)",
   "tex": "X_T(j\\omega)=\\sum_{k=-\\infty}^{\\infty}X_0(jk\\omega_1)\\omega_1\\delta(\\omega-k\\omega_1)",
   "text": ""
  },
  {
   "id": "fmuns3z291",
   "kind": "formula",
   "x": 270,
   "y": 4344,
   "w": 174,
   "h": 28,
   "src": "X^{(n)}(j\\omega) \\leftrightarrow (-jt)^n x(t)",
   "tex": "X^{(n)}(j\\omega) \\leftrightarrow (-jt)^n x(t)",
   "text": ""
  }
 ],
 "docs": [
  {
   "id": "docmunqfkgh1",
   "path": ".资料/ch4-CT傅里叶变换-4-3.pdf",
   "title": "ch4-CT傅里叶变换-4-3",
   "x": -348,
   "y": -90,
   "w": 720,
   "pages": [
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ],
    [
     720,
     540
    ]
   ],
   "pageGaps": [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    11,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    26,
    0,
    0
   ]
  }
 ]
}
