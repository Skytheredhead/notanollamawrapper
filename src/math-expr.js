/**
 * Safe arithmetic parsing (no eval). Supports x when graphing.
 */

export class MathParser {
  constructor(expression, { allowX = false } = {}) {
    this.allowX = allowX;
    this.xValue = 0;
    this.tokens = String(expression || '').match(/pi|[a-z]+|\d+(?:\.\d+)?|\.\d+|[()+\-*/%^,]/gi) || [];
    this.index = 0;
  }

  peek() {
    return this.tokens[this.index];
  }

  take() {
    return this.tokens[this.index++];
  }

  parse() {
    const value = this.expression();
    if (this.peek() != null) throw new Error(`Unexpected token: ${this.peek()}`);
    return value;
  }

  expression() {
    let value = this.term();
    while (['+', '-'].includes(this.peek())) {
      const op = this.take();
      const right = this.term();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  }

  term() {
    let value = this.power();
    while (['*', '/', '%'].includes(this.peek())) {
      const op = this.take();
      const right = this.power();
      if ((op === '/' || op === '%') && right === 0) throw new Error('Division by zero.');
      if (op === '*') value *= right;
      if (op === '/') value /= right;
      if (op === '%') value %= right;
    }
    return value;
  }

  power() {
    let value = this.unary();
    while (this.peek() === '^') {
      this.take();
      value **= this.unary();
    }
    return value;
  }

  unary() {
    if (this.peek() === '+') {
      this.take();
      return this.unary();
    }
    if (this.peek() === '-') {
      this.take();
      return -this.unary();
    }
    return this.primary();
  }

  primary() {
    const token = this.take();
    if (token == null) throw new Error('Incomplete expression.');
    if (token === '(') {
      const value = this.expression();
      if (this.take() !== ')') throw new Error('Missing closing parenthesis.');
      return value;
    }
    if (/^\d|\./.test(token)) return Number(token);
    const lower = token.toLowerCase();
    if (lower === 'pi') return Math.PI;
    if (lower === 'e') return Math.E;
    if (this.allowX && lower === 'x') return this.xValue;
    if (/^[a-z]+$/i.test(token)) {
      if (this.take() !== '(') throw new Error(`Function ${token} needs parentheses.`);
      const arg = this.expression();
      if (this.take() !== ')') throw new Error('Missing closing parenthesis.');
      const fn = {
        sqrt: Math.sqrt,
        abs: Math.abs,
        round: Math.round,
        floor: Math.floor,
        ceil: Math.ceil,
        sin: Math.sin,
        cos: Math.cos,
        tan: Math.tan,
        log: Math.log10,
        ln: Math.log,
        exp: Math.exp
      }[lower];
      if (!fn) throw new Error(`Unknown function: ${token}`);
      return fn(arg);
    }
    throw new Error(`Unexpected token: ${token}`);
  }
}

export function evaluateExpressionAt(expression, x) {
  const parser = new MathParser(expression, { allowX: true });
  parser.xValue = x;
  return parser.parse();
}

export function calculate({ expression }) {
  const result = new MathParser(expression).parse();
  const displayResult = Number.isInteger(result) ? String(result) : String(Number(result.toPrecision(12)));
  return {
    expression,
    result,
    displayResult,
    equation: `${expression} = ${displayResult}`,
    text: displayResult
  };
}

function num(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number.`);
  return n;
}

const MAX_EXPR = 8;
const DEFAULT_SAMPLES = 384;

/**
 * Sample y = f(x) for graphing. Expressions are right-hand sides (strip leading y=).
 */
export function graphMathFunctions(args = {}) {
  let list = args.expressions;
  if (!Array.isArray(list)) {
    const q = String(args.query || args.expression || '').trim();
    list = q ? q.split(/[,;]/).map((s) => s.trim()) : [];
  }
  const cleaned = list
    .map((raw) => String(raw || '').replace(/^\s*y\s*=\s*/i, '').trim())
    .filter(Boolean)
    .slice(0, MAX_EXPR);

  if (!cleaned.length) throw new Error('Provide at least one expression in x (e.g. x^2, sin(x), 2*x+1).');

  const xMin = args.xMin != null ? num(args.xMin, 'xMin') : -10;
  const xMax = args.xMax != null ? num(args.xMax, 'xMax') : 10;
  if (xMin >= xMax) throw new Error('xMax must be greater than xMin.');

  const samples = Math.min(512, Math.max(32, Number.parseInt(args.samples, 10) || DEFAULT_SAMPLES));

  const series = [];
  let ymin = Infinity;
  let ymax = -Infinity;

  for (const expr of cleaned) {
    const points = [];
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const x = xMin + t * (xMax - xMin);
      let y;
      try {
        y = evaluateExpressionAt(expr, x);
      } catch {
        y = NaN;
      }
      if (!Number.isFinite(y)) {
        points.push({ x, y: null });
      } else {
        const yc = Math.max(-1e9, Math.min(1e9, y));
        ymin = Math.min(ymin, yc);
        ymax = Math.max(ymax, yc);
        points.push({ x, y: yc });
      }
    }
    series.push({ expression: expr, points });
  }

  if (!Number.isFinite(ymin)) {
    ymin = -1;
    ymax = 1;
  }
  const span = ymax - ymin || 1;
  const pad = span * 0.12 || 1;
  let vyMin = args.yMin != null ? num(args.yMin, 'yMin') : ymin - pad;
  let vyMax = args.yMax != null ? num(args.yMax, 'yMax') : ymax + pad;
  if (vyMin >= vyMax) {
    vyMin -= 1;
    vyMax += 1;
  }

  const text = cleaned.join(' · ');
  return {
    expressions: cleaned,
    series,
    viewport: { xMin, xMax, yMin: vyMin, yMax: vyMax },
    text
  };
}
