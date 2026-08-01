/**
 * Универсальный сбор UI-доказательств: один прогон, одна навигация, один JSON.
 *
 * Читает декларативный конфиг кейсов и выполняет объявленные проверки, не требуя писать скрипт под
 * каждый заказ. Каждая навигация на сайте с анти-бот защитой стоит 40–90 секунд, поэтому все кейсы
 * снимаются в одной сессии.
 *
 * Запуск:
 *   node collect.js --config <config.json> --out <каталог проекта>
 *   node collect.js --check                        # проверка среды без прогона
 *   node collect.js --config c.json --only TC-001,TC-004
 *
 * Ни одна проверка не ставит вердикт Pass/Fail — она возвращает числа и признаки. Вердикт по
 * критериям тест-плана ставит тестировщик в _qa-run.md.
 */
const fs = require('fs');
const path = require('path');
const { open, goto, preflight } = require('./pw-env');
const M = require('./lib-measure');
const C = require('./lib-cursor');

function args(argv) {
  const out = { only: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--only') out.only = argv[++i].split(',').map(s => s.trim());
    else if (a === '--keep-open') out.keepOpen = true;
  }
  return out;
}

const sleep = (page, ms) => page.waitForTimeout(ms);

async function shot(page, file, rect, cfg) {
  const view = cfg.viewport;
  const bottom = rect ? Math.min(view.height, Math.max(cfg.minShotHeight, rect.y + rect.h + 20)) : cfg.minShotHeight;
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: view.width, height: bottom } });
}

/**
 * Снимок для отчёта с дорисованным указателем мыши в точке наведения.
 * Накладка ставится только на время съёмки: в замеры она не попадает.
 */
async function shotWithCursor(page, file, rect, cfg, target, opts = {}) {
  const point = typeof target === 'string' ? await C.centerOf(page, target) : target;
  if (point) await C.showCursor(page, point.x, point.y, opts);
  await shot(page, file, rect, cfg);
  if (point) await C.hideCursor(page);
}

/**
 * Склейка «до / под курсором»: два увеличенных фрагмента одного места, друг под другом,
 * с подписями и указателем мыши. Именно по ней заказчик видит, что изменилось при наведении —
 * на снимке всей шапки тонкое подчёркивание или смена оттенка теряются.
 */
async function compareShot(page, file, beforeB64, afterB64, cursorOffset, zoom = 2) {
  const dataUrl = await page.evaluate(async ({ a, b, cur, zoom }) => {
    const load = async (d) => { const i = new Image(); i.src = 'data:image/png;base64,' + d; await i.decode(); return i; };
    const [i1, i2] = [await load(a), await load(b)];
    const w = Math.min(i1.width, i2.width), h = Math.min(i1.height, i2.height);
    const pad = 12, labelH = 26;
    const c = document.createElement('canvas');
    c.width = w * zoom + pad * 2;
    c.height = (h * zoom + labelH) * 2 + pad * 3;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#f4f5f7';
    ctx.fillRect(0, 0, c.width, c.height);

    const drawBlock = (img, y, label) => {
      ctx.fillStyle = '#111';
      ctx.font = '600 15px system-ui, sans-serif';
      ctx.fillText(label, pad, y + 17);
      ctx.drawImage(img, 0, 0, w, h, pad, y + labelH, w * zoom, h * zoom);
      ctx.strokeStyle = '#c9ccd1';
      ctx.lineWidth = 1;
      ctx.strokeRect(pad - 0.5, y + labelH - 0.5, w * zoom + 1, h * zoom + 1);
      return y + labelH + h * zoom;
    };

    drawBlock(i1, pad, 'До наведения');
    const secondTop = drawBlock(i2, pad * 2 + labelH + h * zoom, 'Под курсором');

    // Указатель на нижнем фрагменте — в той точке, куда наводили.
    const cx = pad + cur.x * zoom, cy = secondTop - h * zoom + cur.y * zoom;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 18);
    g.addColorStop(0, 'rgba(255,204,0,.65)');
    g.addColorStop(1, 'rgba(255,204,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy + 21);
    ctx.lineTo(cx + 5.5, cy + 16);
    ctx.lineTo(cx + 9, cy + 24.5);
    ctx.lineTo(cx + 13, cy + 22.8);
    ctx.lineTo(cx + 9.6, cy + 14.4);
    ctx.lineTo(cx + 17, cy + 14.2);
    ctx.closePath();
    ctx.fillStyle = '#111';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.fill();

    return c.toDataURL('image/png');
  }, { a: beforeB64, b: afterB64, cur: cursorOffset, zoom });

  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
}

async function shotB64(page, rect, cfg, pad = 6) {
  return (await page.screenshot({ clip: M.clipOf(rect, pad, { w: cfg.viewport.width, h: cfg.viewport.height }) })).toString('base64');
}

/** Возврат страницы в исходное состояние: курсор в нейтраль, открытые блоки закрыты. */
async function reset(page, cfg, panels) {
  await page.mouse.move(cfg.idlePoint[0], cfg.idlePoint[1]);
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(page, 500);
  for (const p of panels) {
    const st = await M.panelState(page, p.panel);
    if (!st.visible) continue;
    if (p.closeButton) await page.click(p.panel + ' ' + p.closeButton, { timeout: 3000 }).catch(() => {});
    else if (p.closeByTriggerClick && p.trigger) await page.click(p.trigger, { timeout: 3000 }).catch(() => {});
    await sleep(page, 400);
    const again = await M.panelState(page, p.panel);
    if (again.visible) {
      await goto(page, cfg.url);
      await page.waitForSelector(cfg.readySelector, { timeout: 30000 });
      await sleep(page, cfg.waitAfterLoad);
      return 'reload';
    }
  }
  return 'ok';
}

/* ------------------------------- проверки ------------------------------- */

async function checkHover(page, c, cfg, ev) {
  const rest = await M.snapshot(page, c.selector);
  if (!rest) return { status: 'Blocked', note: 'Элемент не найден: ' + c.selector };
  await shot(page, path.join(ev, c.id + '-1-rest.png'), null, cfg);
  const before = await shotB64(page, rest.rect, cfg);

  try { await page.hover(c.selector, { timeout: 5000 }); }
  catch (e) { return { status: 'Blocked', note: 'Не удалось навести курсор: ' + e.message.split('\n')[0] }; }
  await sleep(page, c.settle || 900);

  const hover = await M.snapshot(page, c.selector);
  const after = await shotB64(page, rest.rect, cfg);
  const pixels = await M.pixelDiff(page, before, after);
  await shotWithCursor(page, path.join(ev, c.id + '-2-hover.png'), null, cfg, c.selector,
    { frameSelector: cfg.frameHovered ? c.selector : null });
  // Курсор стоит в центре элемента; во фрагменте он смещён на величину поля вокруг элемента.
  await compareShot(page, path.join(ev, c.id + '-3-compare.png'), before, after,
    { x: Math.round(rest.rect.w / 2) + 6, y: Math.round(rest.rect.h / 2) + 6 });

  await page.mouse.move(cfg.idlePoint[0], cfg.idlePoint[1]);
  await sleep(page, c.settle || 900);
  const back = await M.snapshot(page, c.selector);

  const delta = M.visualDelta(M.diff(rest, hover));
  return {
    clickable: rest.clickable,
    cursor: rest.self.cursor,
    transition: { property: rest.self.transitionProperty, duration: rest.self.transitionDuration },
    animation: { name: rest.self.animationName, duration: rest.self.animationDuration },
    rect: rest.rect,
    styleDelta: delta,
    pixels,
    reverted: Object.keys(M.visualDelta(M.diff(rest, back))).length === 0,
    signal: {
      reactionInStyles: Object.keys(delta).length > 0,
      reactionOnScreen: pixels.changed > 0,
      transitionMs: Math.round(parseFloat(rest.self.transitionDuration) * 1000) || 0
    },
    evidence: [c.id + '-1-rest.png', c.id + '-2-hover.png', c.id + '-3-compare.png']
  };
}

async function checkDropdown(page, c, cfg, ev) {
  const rec = { trigger: c.trigger, panel: c.panel };
  rec.closedState = await M.panelState(page, c.panel);
  if (!rec.closedState.exists) {
    // Панели нет в DOM вовсе — это ошибка селектора в конфиге, а не факт о системе.
    // Иначе из опечатки родился бы дефект «выпадающий блок не открывается».
    return { status: 'Blocked', note: 'Панель не найдена в DOM: ' + c.panel };
  }
  if (!(await M.panelState(page, c.trigger)).exists) {
    return { status: 'Blocked', note: 'Триггер не найден в DOM: ' + c.trigger };
  }
  await shot(page, path.join(ev, c.id + '-1-closed.png'), null, cfg);

  const openBy = c.openBy || 'auto';
  if (openBy === 'auto' || openBy === 'hover') {
    await page.hover(c.trigger, { timeout: 5000 }).catch(e => { rec.hoverError = e.message.split('\n')[0]; });
    await sleep(page, c.settle || 1200);
    rec.opensOnHover = (await M.panelState(page, c.panel)).visible;
  }
  if (!rec.opensOnHover && (openBy === 'auto' || openBy === 'click')) {
    rec.scrollBeforeClick = await page.evaluate(() => window.scrollY);
    await page.click(c.trigger, { timeout: 5000 }).catch(e => { rec.clickError = e.message.split('\n')[0]; });
    await sleep(page, c.settle || 1800);
    rec.opensOnClick = (await M.panelState(page, c.panel)).visible;
    rec.scrollAfterClick = await page.evaluate(() => window.scrollY);
    rec.urlAfterClick = page.url();
  }

  const st = await M.panelState(page, c.panel);
  rec.openState = st;
  if (!st.visible) {
    rec.signal = { opens: false };
    rec.evidence = [c.id + '-1-closed.png'];
    return rec;
  }

  rec.items = await M.panelItems(page, c.panel, c.itemSelector || 'a, button, input, li');
  rec.itemCount = rec.items.length;
  const v = cfg.viewport;
  rec.fitsViewport = st.rect.x >= 0 && st.rect.y >= 0 && st.rect.x + st.rect.w <= v.width && st.rect.y + st.rect.h <= v.height;
  rec.overflow = {
    right: Math.max(0, st.rect.x + st.rect.w - v.width),
    bottom: Math.max(0, st.rect.y + st.rect.h - v.height),
    left: Math.max(0, -st.rect.x)
  };
  rec.coveredItems = rec.items.filter(i => i.covered).map(i => ({ label: i.label, by: i.coveredBy }));
  rec.itemsOutsideViewport = rec.items.filter(i => i.outsideViewport).length;
  rec.notTabbableItems = rec.items.filter(i => !i.tabbable).length;
  await shotWithCursor(page, path.join(ev, c.id + '-2-open.png'), st.rect, cfg, c.trigger);

  if (!rec.fitsViewport) {
    rec.scroll = await page.evaluate(() => {
      const before = window.scrollY;
      window.scrollTo(0, 600);
      const after = window.scrollY;
      window.scrollTo(0, before);
      return { pageScrollable: after > before, docHeight: document.documentElement.scrollHeight, winHeight: window.innerHeight };
    });
  }

  // Достижимость нижнего пункта курсором — блок не должен закрываться по дороге.
  const last = rec.items[rec.items.length - 1];
  if (last && rec.opensOnHover && !last.outsideViewport) {
    const t = await page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, c.trigger);
    await page.mouse.move(t.x, t.y);
    await sleep(page, 400);
    const tx = last.rect.x + last.rect.w / 2, ty = last.rect.y + last.rect.h / 2;
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(t.x + (tx - t.x) * i / 12, t.y + (ty - t.y) * i / 12);
      await sleep(page, 60);
    }
    await sleep(page, 500);
    rec.reachableByMouse = (await M.panelState(page, c.panel)).visible;
  }

  // Способы закрытия.
  await page.keyboard.press('Escape');
  await sleep(page, 700);
  rec.closesByEsc = !(await M.panelState(page, c.panel)).visible;
  if (!rec.closesByEsc) {
    await page.mouse.move(cfg.idlePoint[0], cfg.idlePoint[1]);
    await sleep(page, 1000);
    rec.closesByMouseLeave = !(await M.panelState(page, c.panel)).visible;
    if (!rec.closesByMouseLeave) {
      await page.mouse.click(cfg.idlePoint[0], cfg.idlePoint[1]);
      await sleep(page, 900);
      rec.closesByOutsideClick = !(await M.panelState(page, c.panel)).visible;
    }
  }
  if (c.closeByTriggerClick) {
    if (!(await M.panelState(page, c.panel)).visible) {
      await page.click(c.trigger, { timeout: 5000 }).catch(() => {});
      await sleep(page, c.settle || 1200);
    }
    await page.click(c.trigger, { timeout: 5000 }).catch(e => { rec.triggerClickError = e.message.split('\n')[0]; });
    await sleep(page, 900);
    rec.closesByTriggerClick = !(await M.panelState(page, c.panel)).visible;
  }
  if (c.closeButton) {
    const opened = (await M.panelState(page, c.panel)).visible;
    if (!opened) {
      if (rec.opensOnHover) await page.hover(c.trigger).catch(() => {});
      else await page.click(c.trigger).catch(() => {});
      await sleep(page, 1200);
    }
    if ((await M.panelState(page, c.panel)).visible) {
      await page.click(c.panel + ' ' + c.closeButton, { timeout: 4000 }).catch(e => { rec.closeButtonError = e.message.split('\n')[0]; });
      await sleep(page, 700);
      rec.closesByButton = !(await M.panelState(page, c.panel)).visible;
    }
  }

  rec.signal = {
    opens: true,
    openedBy: rec.opensOnHover ? 'hover' : 'click',
    fitsViewport: rec.fitsViewport,
    itemsUnreachable: rec.coveredItems.length + rec.itemsOutsideViewport,
    closable: !!(rec.closesByEsc || rec.closesByMouseLeave || rec.closesByOutsideClick || rec.closesByButton || rec.closesByTriggerClick)
  };
  rec.evidence = [c.id + '-1-closed.png', c.id + '-2-open.png'];
  return rec;
}

async function checkEsc(page, c, cfg, ev) {
  const by = c.openBy || 'hover';
  if (!(await M.panelState(page, c.panel)).exists) {
    return { status: 'Blocked', note: 'Панель не найдена в DOM: ' + c.panel };
  }
  const openIt = async () => {
    if (by === 'hover') await page.hover(c.trigger, { timeout: 5000 });
    else await page.click(c.trigger, { timeout: 5000 });
    await sleep(page, c.settle || 1500);
    return M.panelState(page, c.panel);
  };

  let opened = await openIt();
  let reloaded = false;
  if (!opened.visible) {
    // Блок мог остаться закрытым из-за состояния, оставшегося от предыдущего кейса
    // (например, кнопка «Закрыть» проставила инлайновый стиль). Одна перезагрузка и повтор —
    // прежде чем объявлять кейс невыполнимым.
    await goto(page, cfg.url);
    await page.waitForSelector(cfg.readySelector, { timeout: 30000 });
    await sleep(page, cfg.waitAfterLoad);
    reloaded = true;
    opened = await openIt();
  }

  await shotWithCursor(page, path.join(ev, c.id + '-1-open.png'), opened.rect, cfg, c.trigger);
  if (!opened.visible) {
    return { status: 'Blocked', note: 'Блок не раскрылся способом «' + by + '» даже после перезагрузки страницы', opened, retriedAfterReload: reloaded };
  }
  if (reloaded) await sleep(page, 300);

  await page.keyboard.press('Escape');
  await sleep(page, 700);
  const afterEsc = await M.panelState(page, c.panel);
  await shotWithCursor(page, path.join(ev, c.id + '-2-after-esc.png'), opened.rect, cfg, c.trigger);

  return {
    openedBy: by, opened, afterEsc, retriedAfterReload: reloaded,
    signal: { closedByEsc: opened.visible && !afterEsc.visible },
    evidence: [c.id + '-1-open.png', c.id + '-2-after-esc.png']
  };
}

async function checkReadability(page, c, cfg, ev) {
  const snap = await M.snapshot(page, c.selector);
  if (!snap) return { status: 'Blocked', note: 'Элемент не найден: ' + c.selector };
  const box = c.hitAreaSelector ? await M.snapshot(page, c.hitAreaSelector) : snap;

  const palette = await M.pixelPalette(page, snap.rect, { w: cfg.viewport.width, h: cfg.viewport.height });
  const textColor = M.parseRGB(snap.self.color);
  const top = palette.top[0];
  const bg = { r: top.rgb[0], g: top.rgb[1], b: top.rgb[2] };
  const ratio = M.contrast(textColor, bg);
  const th = M.contrastThreshold(parseFloat(snap.self.fontSize), snap.self.fontWeight);
  const perColor = palette.top.filter(t => t.share >= 3).map(t => ({
    rgb: t.rgb, share: t.share, ratio: M.contrast(textColor, { r: t.rgb[0], g: t.rgb[1], b: t.rgb[2] })
  }));

  await page.screenshot({
    path: path.join(ev, c.id + '-text.png'),
    clip: M.clipOf(snap.rect, 12, { w: cfg.viewport.width, h: cfg.viewport.height })
  });

  return {
    text: snap.text,
    typography: {
      fontFamily: snap.self.fontFamily, fontSize: snap.self.fontSize, fontWeight: snap.self.fontWeight,
      lineHeight: snap.self.lineHeight, letterSpacing: snap.self.letterSpacing, textTransform: snap.self.textTransform
    },
    color: snap.self.color,
    backgroundDominant: { rgb: top.rgb, share: top.share },
    contrast: { ratio, required: th.min, isLargeText: th.large, worstAmongShades: perColor.length ? Math.min(...perColor.map(p => p.ratio)) : ratio },
    contrastPerColor: perColor,
    hitArea: { w: box.rect.w, h: box.rect.h },
    truncated: snap.overflow.scrollW > snap.overflow.clientW + 1,
    signal: {
      contrastPass: (perColor.length ? Math.min(...perColor.map(p => p.ratio)) : ratio) >= th.min,
      hitAreaPass: box.rect.w >= 24 && box.rect.h >= 24,
      truncated: snap.overflow.scrollW > snap.overflow.clientW + 1
    },
    evidence: [c.id + '-text.png']
  };
}

async function checkTabOrder(page, c, cfg, ev) {
  // Фокус нужно отдать документу: после запуска он может быть в интерфейсе браузера,
  // и тогда первый Tab уйдёт мимо страницы, а обход окажется пустым.
  await page.evaluate(() => {
    document.activeElement && document.activeElement.blur();
    document.body.setAttribute('tabindex', '-1');
    document.body.focus();
    window.scrollTo(0, 0);
  });
  await sleep(page, 200);
  const stops = [];
  let seenInScope = false;
  for (let i = 0; i < (c.maxStops || 15); i++) {
    await page.keyboard.press('Tab');
    await sleep(page, 220);
    const info = await page.evaluate((within) => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const scope = within ? document.querySelector(within) : document.body;
      return {
        tag: el.tagName,
        cls: String(el.className || '').slice(0, 40),
        text: (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        name: el.getAttribute('name'),
        inScope: scope ? scope.contains(el) : true,
        tabIndex: el.tabIndex,
        outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor,
        focusVisible: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0
      };
    }, c.within || null);
    if (!info) continue;
    if (c.within && !info.inScope) {
      // До первой остановки внутри области обход мог идти по служебным элементам страницы —
      // это не повод прекращать. Прекращаем, когда область уже пройдена и фокус ушёл из неё.
      if (seenInScope) break;
      continue;
    }
    seenInScope = true;
    stops.push(info);
  }
  await page.evaluate(() => document.body.removeAttribute('tabindex'));
  await shot(page, path.join(ev, c.id + '-tab-order.png'), null, cfg);
  const missing = (c.expectStops || []).filter(x => !stops.some(s => (s.text || '').toLowerCase().includes(x.toLowerCase())));
  return {
    stops,
    signal: { stopCount: stops.length, allFocusVisible: stops.every(s => s.focusVisible), missingExpectedStops: missing },
    evidence: [c.id + '-tab-order.png']
  };
}

async function checkFocusOpens(page, c, cfg, ev) {
  await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
  await page.mouse.move(cfg.idlePoint[0], cfg.idlePoint[1]);
  await sleep(page, 400);
  await page.focus(c.trigger).catch(() => {});
  await sleep(page, c.settle || 900);
  const st = await M.panelState(page, c.panel);
  await shotWithCursor(page, path.join(ev, c.id + '-focus.png'), st.rect, cfg, null,
    { frameSelector: c.trigger });
  return { panel: c.panel, state: st, signal: { opensOnFocus: st.visible }, evidence: [c.id + '-focus.png'] };
}

async function checkTabInside(page, c, cfg, ev) {
  await page.focus(c.trigger);
  await sleep(page, 900);
  const opened = (await M.panelState(page, c.panel)).visible;
  const stops = [];
  for (let i = 0; i < (c.presses || 10); i++) {
    await page.keyboard.press('Tab');
    await sleep(page, 200);
    stops.push(await page.evaluate((p) => {
      const el = document.activeElement;
      if (!el) return null;
      const panel = document.querySelector(p);
      return {
        tag: el.tagName, type: el.getAttribute('type'), name: el.getAttribute('name'),
        cls: String(el.className || '').slice(0, 40),
        text: (el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 30),
        tabIndex: el.tabIndex,
        inPanel: panel ? panel.contains(el) : false,
        panelStillOpen: panel ? getComputedStyle(panel).display !== 'none' : false
      };
    }, c.panel));
  }
  await shot(page, path.join(ev, c.id + '-tab-inside.png'), null, cfg);
  const expect = c.expectFocusOn || [];
  const reached = expect.filter(name => stops.some(s => s && (s.name === name || s.cls.includes(name) || s.text === name)));
  return {
    openedByFocus: opened, stops,
    signal: { expected: expect, reached, notReached: expect.filter(e => !reached.includes(e)) },
    evidence: [c.id + '-tab-inside.png']
  };
}

const HANDLERS = {
  hover: checkHover,
  dropdown: checkDropdown,
  esc: checkEsc,
  readability: checkReadability,
  'tab-order': checkTabOrder,
  'focus-opens': checkFocusOpens,
  'tab-inside': checkTabInside
};

/* -------------------------------- прогон -------------------------------- */

(async () => {
  const opts = args(process.argv);

  if (opts.check) {
    const info = preflight();
    console.log('Среда сбора доказательств:');
    Object.entries(info).forEach(([k, v]) => console.log('  ' + k + ': ' + v));
    console.log('Проверки: ' + Object.keys(HANDLERS).join(', '));
    return;
  }
  if (!opts.config) throw new Error('Не задан --config. Пример: node collect.js --config config.json --out D:\\Rabota\\projects\\<проект>');

  const cfg = JSON.parse(fs.readFileSync(opts.config, 'utf8'));
  cfg.url = opts.url || cfg.url;
  cfg.viewport = cfg.viewport || { width: 1366, height: 900 };
  cfg.idlePoint = cfg.idlePoint || [Math.round(cfg.viewport.width / 2), cfg.viewport.height - 140];
  cfg.waitAfterLoad = cfg.waitAfterLoad || 2000;
  cfg.readySelector = cfg.readySelector || 'body';
  cfg.minShotHeight = cfg.minShotHeight || 300;

  const projectRoot = opts.out || process.cwd();
  const ev = path.join(projectRoot, 'evidence');
  const dataDir = path.join(ev, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const cases = cfg.cases.filter(c => !opts.only || opts.only.includes(c.id));
  const panels = cfg.cases.filter(c => c.panel)
    .map(c => ({ panel: c.panel, closeButton: c.closeButton, trigger: c.trigger, closeByTriggerClick: c.closeByTriggerClick }));

  const started = Date.now();
  const { page, info, close } = await open(cfg.viewport);
  const nav = await goto(page, cfg.url);
  await page.waitForSelector(cfg.readySelector, { timeout: 30000 });
  await page.waitForTimeout(cfg.waitAfterLoad);

  const results = [];
  for (const c of cases) {
    const handler = HANDLERS[c.check];
    const rec = { id: c.id, name: c.name || c.id, check: c.check, at: new Date().toISOString() };
    if (!handler) {
      rec.status = 'Blocked';
      rec.note = 'Неизвестный тип проверки: ' + c.check + '. Доступны: ' + Object.keys(HANDLERS).join(', ');
      results.push(rec);
      console.log(`${c.id} [${c.check}] ОШИБКА КОНФИГА: ${rec.note}`);
      continue;
    }
    const how = await reset(page, cfg, panels);
    if (how === 'reload') rec.pageReloadedBefore = true;
    try {
      Object.assign(rec, await handler(page, c, cfg, ev));
    } catch (e) {
      rec.status = 'Blocked';
      rec.note = 'Проверка не выполнена: ' + e.message.split('\n')[0];
    }
    results.push(rec);
    const sig = rec.signal ? JSON.stringify(rec.signal) : (rec.status || '');
    console.log(`${rec.id} [${rec.check}] ${rec.name}\n    ${sig}${rec.note ? ' | ' + rec.note : ''}`);
  }

  const out = {
    meta: {
      url: cfg.url, http: nav.status, title: nav.title, navigationAttempts: nav.attempts,
      startedAt: new Date(started).toISOString(), durationSec: Math.round((Date.now() - started) / 1000),
      viewport: cfg.viewport.width + 'x' + cfg.viewport.height,
      browser: info.browser, headless: info.headless, profile: info.profile,
      userAgent: await page.evaluate(() => navigator.userAgent),
      casesRequested: cases.length
    },
    cases: results
  };
  fs.writeFileSync(path.join(dataDir, 'ui-evidence.json'), JSON.stringify(out, null, 1), 'utf8');

  const blocked = results.filter(r => r.status === 'Blocked');
  console.log('\nПрогон завершён за ' + out.meta.durationSec + ' с, навигаций: ' + nav.attempts + ', кейсов: ' + results.length + ', Blocked: ' + blocked.length);
  console.log('Данные: ' + path.join(dataDir, 'ui-evidence.json'));
  if (blocked.length) console.log('Blocked: ' + blocked.map(b => b.id + ' (' + b.note + ')').join('; '));

  if (!opts.keepOpen) await close();
  process.exitCode = blocked.length ? 2 : 0;
})();
