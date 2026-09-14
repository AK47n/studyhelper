// LaTeX 片段：\u0001 是"插入后光标停这里"的占位符，按 Tab 跳到下一个。
// 你不需要背这些——工具栏点一下就行。这里只是模板表，想加自己往数组里加。

export const SYMBOLS = [
  { label: '\\mu_0', insert: '\\mu_0 ', hint: '真空磁导率' },
  { label: '\\mu_r', insert: '\\mu_r ', hint: '相对磁导率' },
  { label: '\\varepsilon_0', insert: '\\varepsilon_0 ', hint: '真空介电常数' },
  { label: '\\varepsilon_r', insert: '\\varepsilon_r ', hint: '相对介电常数' },
  { label: '\\rho', insert: '\\rho ', hint: '电阻率 / 体电荷密度' },
  { label: '\\sigma', insert: '\\sigma ', hint: '电导率 / 面电荷密度' },
  { label: '\\omega', insert: '\\omega ', hint: '角频率' },
  { label: '\\varphi', insert: '\\varphi ', hint: '相位 / 磁通' },
  { label: '\\phi', insert: '\\phi ', hint: '相位 / 电势' },
  { label: '\\Phi', insert: '\\Phi ', hint: '磁通量' },
  { label: '\\theta', insert: '\\theta ', hint: '角度' },
  { label: '\\lambda', insert: '\\lambda ', hint: '波长 / 线电荷密度' },
  { label: '\\Delta', insert: '\\Delta ', hint: '增量' },
  { label: '\\partial', insert: '\\partial ', hint: '偏导' },
  { label: '\\alpha', insert: '\\alpha ', hint: '电流放大系数' },
  { label: '\\beta', insert: '\\beta ', hint: '电流放大系数' },
  { label: '\\Omega', insert: '\\Omega ', hint: '欧姆' },
  { label: '\\infty', insert: '\\infty ', hint: '无穷' },
  { label: '\\approx', insert: '\\approx ', hint: '约等于' },
  { label: '\\times', insert: '\\times ', hint: '乘' },
  { label: '\\cdot', insert: '\\cdot ', hint: '点乘' },
  { label: '\\propto', insert: '\\propto ', hint: '正比于' },
  { label: '\\Rightarrow', insert: '\\Rightarrow ', hint: '推出' },
  { label: '\\angle', insert: '\\angle ', hint: '相角' },
]

export const TEMPLATES = [
  { label: 'x²', hint: '上标 (Ctrl+2)', insert: '^{\\u0001}' },
  { label: 'xₙ', hint: '下标 (Ctrl+_)', insert: '_{\\u0001}' },
  { label: 'a/b', hint: '分式 (Ctrl+/)', insert: '\\frac{\\u0001}{\\u0001}' },
  { label: '√', hint: '根号', insert: '\\sqrt{\\u0001}' },
  { label: 'ⁿ√', hint: 'n 次根号', insert: '\\sqrt[\\u0001]{\\u0001}' },
  { label: 'x⃗', hint: '向量 (Ctrl+Shift+V)', insert: '\\vec{\\u0001}' },
  { label: 'x̄', hint: '平均 / 上划线', insert: '\\bar{\\u0001}' },
  { label: 'x̂', hint: '单位矢量', insert: '\\hat{\\u0001}' },
  { label: 'ẋ', hint: '时间导数', insert: '\\dot{\\u0001}' },
  { label: 'f(x)', hint: '函数括号', insert: '\\left( \\u0001 \\right)' },
  { label: '[ ]', hint: '方括号', insert: '\\left[ \\u0001 \\right]' },
  { label: '{ }', hint: '花括号', insert: '\\left\\{ \\u0001 \\right\\}' },
  { label: '|x|', hint: '绝对值', insert: '\\left| \\u0001 \\right|' },
  { label: '∑', hint: '求和', insert: '\\sum_{\\u0001}^{\\u0001} ' },
  { label: '∏', hint: '连乘', insert: '\\prod_{\\u0001}^{\\u0001} ' },
  { label: '∫', hint: '积分', insert: '\\int_{\\u0001}^{\\u0001} ' },
  { label: '∮', hint: '闭合回路积分', insert: '\\oint \\u0001' },
  { label: '∬', hint: '双重积分', insert: '\\iint \\u0001' },
  { label: '∂', hint: '偏导', insert: '\\frac{\\partial \\u0001}{\\partial \\u0001}' },
  { label: 'd/dx', hint: '导数', insert: '\\frac{d\\u0001}{d\\u0001}' },
  { label: 'lim', hint: '极限', insert: '\\lim_{\\u0001 \\to \\u0001} ' },
  { label: '∇', hint: 'Nabla 算子', insert: '\\nabla \\u0001' },
  { label: '∇·', hint: '散度', insert: '\\nabla \\cdot \\u0001' },
  { label: '∇×', hint: '旋度', insert: '\\nabla \\times \\u0001' },
  { label: '⇌', hint: '正比关系 / 等价', insert: '\\Longleftrightarrow ' },
  { label: '矩阵', hint: '2×2 矩阵', insert: '\\begin{pmatrix} \\u0001 & \\u0001 \\\\ \\u0001 & \\u0001 \\end{pmatrix}' },
]

/** 正文里插公式时两端自动补 $；已经在一个公式里就只插内容 */
export function wrapFormula(latex) {
  return `$${latex}$`
}
