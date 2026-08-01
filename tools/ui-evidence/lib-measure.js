/**
 * Измерительная часть сбора UI-доказательств: вычисленные стили вместе с псевдоэлементами,
 * попиксельное сравнение областей, контраст по фактическим пикселям страницы, геометрия.
 *
 * Ни одна функция не решает, дефект это или нет. Они возвращают числа — вердикт ставит человек.
 */

const STYLE_PROPS = [
  'color', 'backgroundColor', 'backgroundImage', 'borderTopColor', 'borderRightColor',
  'borderBottomColor', 'borderLeftColor', 'borderBottomWidth', 'textDecorationLine',
  'opacity', 'transform', 'boxShadow', 'filter', 'cursor', 'fontSize', 'fontWeight',
  'fontFamily', 'lineHeight', 'letterSpacing', 'textTransform', 'transitionProperty',
  'transitionDuration', 'transitionTimingFunction', 'animationName', 'animationDuration',
  'outlineColor', 'outlineWidth', 'outlineStyle', 'visibility', 'display'
];
const PSEUDO_PROPS = [
  'content', 'backgroundColor', 'width', 'height', 'opacity', 'transform', 'borderBottomColor',
  'transitionDuration', 'left', 'right', 'top', 'bottom'
];

/** Снимок состояния элемента: свои стили, ::before, ::after, вложенная картинка, геометрия. */
async function snapshot(page, selector) {
  return page.evaluate(({ sel, props, pprops }) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const pick = (cs, list) => Object.fromEntries(list.map(p => [p, cs[p]]));
    const r = el.getBoundingClientRect();
    const inner = el.querySelector('img, svg');
    const cs = getComputedStyle(el);
    return {
      self: pick(cs, props),
      before: pick(getComputedStyle(el, '::before'), pprops),
      after: pick(getComputedStyle(el, '::after'), pprops),
      inner: inner ? pick(getComputedStyle(inner), props) : null,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      text: (el.innerText || '').replace(/\s+/g, ' ').trim(),
      overflow: { scrollW: el.scrollWidth, clientW: el.clientWidth, scrollH: el.scrollHeight, clientH: el.clientHeight },
      tabIndex: el.tabIndex,
      clickable: !!(el.getAttribute('href') || el.getAttribute('onclick') || el.tagName === 'BUTTON' || cs.cursor === 'pointer')
    };
  }, { sel: selector, props: STYLE_PROPS, pprops: PSEUDO_PROPS });
}

/** Различия двух снимков по всем слоям, включая псевдоэлементы и геометрию. */
function diff(a, b) {
  const out = {};
  if (!a || !b) return out;
  for (const layer of ['self', 'before', 'after', 'inner']) {
    if (!a[layer] || !b[layer]) continue;
    for (const k of Object.keys(a[layer])) {
      if (a[layer][k] !== b[layer][k]) out[layer + '.' + k] = [a[layer][k], b[layer][k]];
    }
  }
  for (const k of ['x', 'y', 'w', 'h']) {
    if (a.rect && b.rect && a.rect[k] !== b.rect[k]) out['rect.' + k] = [a.rect[k], b.rect[k]];
  }
  return out;
}

/** Из различий оставляет только те, что видны пользователю: без cursor, transition и прочей служебки. */
const VISUAL_KEYS = /(color|backgroundColor|backgroundImage|textDecorationLine|opacity|transform|boxShadow|filter|content|width|height|borderBottomWidth|outline)/;
function visualDelta(d) {
  return Object.fromEntries(Object.entries(d).filter(([k]) => VISUAL_KEYS.test(k) && !/transition|animation/.test(k)));
}

function parseRGB(s) {
  const m = String(s).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
}

function relLum({ r, g, b }) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(c1, c2) {
  const l1 = relLum(c1), l2 = relLum(c2);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** Порог WCAG 2.2 (1.4.3): 3:1 для крупного текста, 4.5:1 для обычного. */
function contrastThreshold(fontSizePx, fontWeight) {
  const large = fontSizePx >= 18.66 || (fontSizePx >= 14 && Number(fontWeight) >= 700);
  return { large, min: large ? 3 : 4.5 };
}

function clipOf(rect, pad = 0, viewport = { w: 1366, h: 900 }) {
  const x = Math.max(0, Math.round(rect.x - pad));
  const y = Math.max(0, Math.round(rect.y - pad));
  return {
    x, y,
    width: Math.max(1, Math.min(viewport.w - x, Math.round(rect.w + pad * 2))),
    height: Math.max(1, Math.min(viewport.h - y, Math.round(rect.h + pad * 2)))
  };
}

/**
 * Палитра области страницы: снимок → декодирование в canvas самой страницы → гистограмма цветов.
 * Так контраст считается по тому, что видит глаз, а не по CSS-декларации: под текстом может быть
 * фоновая картинка или градиент.
 */
async function pixelPalette(page, rect, viewport) {
  const b64 = (await page.screenshot({ clip: clipOf(rect, 0, viewport) })).toString('base64');
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + data;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const hist = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const k = d[i] + ',' + d[i + 1] + ',' + d[i + 2];
      hist.set(k, (hist.get(k) || 0) + 1);
    }
    const total = d.length / 4;
    return {
      total,
      top: [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([k, n]) => ({ rgb: k.split(',').map(Number), share: Math.round(n / total * 1000) / 10 }))
    };
  }, b64);
}

/** Попиксельное сравнение двух снимков одной области: сколько изменилось и насколько сильно. */
async function pixelDiff(page, b64a, b64b) {
  return page.evaluate(async ({ x, y }) => {
    const load = async (d) => { const i = new Image(); i.src = 'data:image/png;base64,' + d; await i.decode(); return i; };
    const [i1, i2] = [await load(x), await load(y)];
    const w = Math.min(i1.width, i2.width), h = Math.min(i1.height, i2.height);
    const data = (img) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, w, h).data;
    };
    const d1 = data(i1), d2 = data(i2);
    let changed = 0, maxDelta = 0, sum = 0;
    for (let i = 0; i < d1.length; i += 4) {
      const dd = Math.abs(d1[i] - d2[i]) + Math.abs(d1[i + 1] - d2[i + 1]) + Math.abs(d1[i + 2] - d2[i + 2]);
      if (dd > 8) changed++;
      if (dd > maxDelta) maxDelta = dd;
      sum += dd;
    }
    const total = w * h;
    return { w, h, total, changed, changedPct: Math.round(changed / total * 1000) / 10, maxDelta, avgDelta: Math.round(sum / total * 100) / 100 };
  }, { x: b64a, y: b64b });
}

/** Состояние блока: видим ли, где, чем накрыт. */
async function panelState(page, selector) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return { exists: false, visible: false };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      exists: true,
      visible: r.width > 2 && r.height > 2 && cs.visibility === 'visible' && cs.display !== 'none' && Number(cs.opacity) > 0.05,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity, zIndex: cs.zIndex,
      position: cs.position, transitionDuration: cs.transitionDuration,
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    };
  }, selector);
}

/** Пункты раскрытого блока: только видимые, с разделением «перекрыт» и «за пределами окна». */
async function panelItems(page, panel, itemSelector) {
  return page.evaluate(({ p, i }) => {
    const root = document.querySelector(p);
    if (!root) return [];
    return [...root.querySelectorAll(i)].filter(el => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && cs.visibility === 'visible' && cs.display !== 'none';
    }).map(el => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
      const outsideViewport = cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight;
      const hit = outsideViewport ? null : document.elementFromPoint(cx, cy);
      return {
        label: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 40),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        cursor: cs.cursor,
        tabbable: el.tabIndex >= 0,
        outsideViewport,
        covered: !outsideViewport && !(hit && (root.contains(hit) || hit === root)),
        coveredBy: hit ? (hit.tagName + (hit.id ? '#' + hit.id : '') + (typeof hit.className === 'string' && hit.className ? '.' + hit.className.trim().split(/\s+/)[0] : '')) : null
      };
    });
  }, { p: panel, i: itemSelector });
}

module.exports = {
  snapshot, diff, visualDelta, parseRGB, relLum, contrast, contrastThreshold,
  pixelPalette, pixelDiff, panelState, panelItems, clipOf, STYLE_PROPS
};
