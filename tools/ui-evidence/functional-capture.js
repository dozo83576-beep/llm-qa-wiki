const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const { normalizeConfig, pngDimensions, validateRun, promoteRun } = require('./functional-core');
const { openFunctional, maximizeWindow, requirePlaywright, findBrowser } = require('./pw-env');

function runId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function absoluteUrl(value, baseUrl) {
  return new URL(value || '/', baseUrl).href;
}

const SENSITIVE_URL_KEYS = new Set([
  'access_token', 'authorization', 'auth', 'code', 'continue', 'dsh', 'email',
  'id_token', 'login', 'opparams', 'password', 'phone', 'rart', 'refresh_token',
  'state', 'token', 'username'
]);

function sanitizeManifestUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_URL_KEYS.has(key.toLowerCase())) url.searchParams.set(key, '[redacted]');
    }
    if (url.hash && /(access_token|authorization|auth|code|email|password|phone|state|token|username)/i.test(url.hash)) {
      url.hash = '[redacted]';
    }
    return url.href;
  } catch {
    return value;
  }
}

function sanitizeEventUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[redacted]');
    if (url.hash) url.hash = '[redacted]';
    return url.href;
  } catch {
    return value;
  }
}

function safeLabel(value, fallback) {
  const label = String(value || fallback).toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-|-$/g, '');
  return label || fallback;
}

async function waitForVisibleImages(page, timeoutMs) {
  await page.waitForFunction(() => {
    const visible = [...document.images].filter(image => {
      const rect = image.getBoundingClientRect();
      const style = getComputedStyle(image);
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
        rect.top < innerHeight && rect.left < innerWidth && style.visibility !== 'hidden' && style.display !== 'none';
    });
    return visible.every(image => image.complete && image.naturalWidth > 0);
  }, null, { timeout: timeoutMs });
}

async function pageMetrics(page) {
  return page.evaluate(() => ({
    screen: { width: screen.width, height: screen.height },
    viewport: { width: innerWidth, height: innerHeight },
    devicePixelRatio,
    scrollY,
    documentHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)
  }));
}

async function normalizePageViewport(page, canonicalViewport) {
  if (!canonicalViewport) return (await pageMetrics(page)).viewport;
  const current = (await pageMetrics(page)).viewport;
  if (current.width === canonicalViewport.width && current.height === canonicalViewport.height) return current;
  await page.setViewportSize(canonicalViewport);
  const normalized = (await pageMetrics(page)).viewport;
  if (normalized.width !== canonicalViewport.width || normalized.height !== canonicalViewport.height) {
    throw new Error(`viewport ${normalized.width}x${normalized.height} не приведён к эталону ${canonicalViewport.width}x${canonicalViewport.height}`);
  }
  return normalized;
}

async function imageAnalysis(page, buffers) {
  const encoded = buffers.map(buffer => buffer.toString('base64'));
  return page.evaluate(async sources => {
    const load = source => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('PNG не декодируется браузером.'));
      image.src = `data:image/png;base64,${source}`;
    });
    const images = await Promise.all(sources.map(load));
    const canvas = document.createElement('canvas');
    canvas.width = images[0].naturalWidth;
    canvas.height = images[0].naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const pixels = [];
    for (const image of images) {
      if (image.naturalWidth !== canvas.width || image.naturalHeight !== canvas.height) {
        return { differentSize: true, diffRatio: 1, whiteRatio: 0 };
      }
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      pixels.push(context.getImageData(0, 0, canvas.width, canvas.height).data);
    }
    let sampled = 0;
    let white = 0;
    let changed = 0;
    let blankBandStart = null;
    let largestInternalBlankBand = { heightPx: 0, startY: null, endY: null };
    const colors = new Set();
    const stride = Math.max(1, Math.floor(Math.sqrt((canvas.width * canvas.height) / 150000)));
    const closeBlankBand = endY => {
      if (blankBandStart === null) return;
      const heightPx = endY - blankBandStart;
      const edgeMargin = Math.max(48, Math.round(canvas.height * 0.06));
      if (blankBandStart >= edgeMargin && endY <= canvas.height - edgeMargin &&
          heightPx > largestInternalBlankBand.heightPx) {
        largestInternalBlankBand = { heightPx, startY: blankBandStart, endY: endY - 1 };
      }
      blankBandStart = null;
    };
    for (let y = 0; y < canvas.height; y += stride) {
      let rowSampled = 0;
      let rowWhite = 0;
      for (let x = 0; x < canvas.width; x += stride) {
        const index = (y * canvas.width + x) * 4;
        const r = pixels[0][index];
        const g = pixels[0][index + 1];
        const b = pixels[0][index + 2];
        const a = pixels[0][index + 3];
        sampled++;
        rowSampled++;
        if (a < 8 || (r > 248 && g > 248 && b > 248)) {
          white++;
          rowWhite++;
        }
        colors.add(`${r >> 4}-${g >> 4}-${b >> 4}-${a >> 4}`);
        if (pixels.length > 1 && (
          Math.abs(r - pixels[1][index]) > 8 || Math.abs(g - pixels[1][index + 1]) > 8 ||
          Math.abs(b - pixels[1][index + 2]) > 8 || Math.abs(a - pixels[1][index + 3]) > 8
        )) changed++;
      }
      if (rowWhite / rowSampled >= 0.985) {
        if (blankBandStart === null) blankBandStart = y;
      } else {
        closeBlankBand(y);
      }
    }
    closeBlankBand(canvas.height);
    return {
      differentSize: false,
      diffRatio: pixels.length > 1 ? changed / sampled : 0,
      whiteRatio: white / sampled,
      sampledColors: colors.size,
      largestInternalBlankBand
    };
  }, encoded);
}

function screenshotOptions(testCase, file, page) {
  const capture = testCase.capture;
  const options = {
    path: file,
    fullPage: capture.mode === 'fullPage',
    animations: capture.animations,
    caret: 'hide',
    scale: capture.scale
  };
  if (Array.isArray(capture.redactSelectors) && capture.redactSelectors.length) {
    options.mask = capture.redactSelectors.map(selector => page.locator(selector));
    options.maskColor = '#000000';
  }
  return options;
}

async function targetState(page, selector) {
  if (!selector) return { required: false, fullyVisible: true };
  const locator = page.locator(selector).first();
  const count = await locator.count();
  if (!count || !(await locator.isVisible().catch(() => false))) {
    return { required: true, selector, fullyVisible: false, reason: 'target отсутствует или скрыт' };
  }
  const state = await locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const points = [
      [Math.max(0, rect.left + 1), Math.max(0, rect.top + 1)],
      [Math.min(innerWidth - 1, rect.right - 1), Math.min(innerHeight - 1, rect.bottom - 1)]
    ];
    const inside = rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    const uncovered = inside && points.every(([x, y]) => {
      const top = document.elementFromPoint(x, y);
      return top === element || element.contains(top);
    });
    return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, inside, uncovered };
  });
  return { required: true, selector, fullyVisible: state.inside && state.uncovered, ...state };
}

async function collapseDeclaredEmptyAds(page, rules) {
  if (!Array.isArray(rules) || !rules.length) return [];
  const result = await page.evaluate(items => items.map(rule => {
    const containers = document.querySelectorAll(rule.container);
    if (containers.length === 0 && rule.optional) return { skipped: true };
    if (containers.length !== 1) {
      return { error: `container ${rule.container}: найдено ${containers.length}` };
    }
    const container = containers[0];
    const slots = container.querySelectorAll(rule.slot);
    if (slots.length === 0 && rule.optional) return { skipped: true };
    if (slots.length !== 1) {
      return { error: `slot ${rule.slot}: найдено ${slots.length}` };
    }
    const slot = slots[0];
    const slotRect = slot.getBoundingClientRect();
    const slotStyle = getComputedStyle(slot);
    const slotIsEmpty = slotStyle.display === 'none' || slotStyle.visibility === 'hidden' ||
      slotRect.width === 0 || slotRect.height === 0;
    const hasVisibleCreative = [...container.querySelectorAll('iframe,img,video,canvas,object,embed')].some(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    if (!slotIsEmpty || hasVisibleCreative) return { skipped: true };
    const originalHeightPx = Math.round(container.getBoundingClientRect().height);
    container.dataset.uiEvidenceCollapsedEmptyAd = 'true';
    container.style.setProperty('display', 'none', 'important');
    container.style.setProperty('height', '0', 'important');
    container.style.setProperty('min-height', '0', 'important');
    container.style.setProperty('margin', '0', 'important');
    container.style.setProperty('padding', '0', 'important');
    return { container: rule.container, slot: rule.slot, originalHeightPx };
  }), rules);
  const failure = result.find(item => item.error);
  if (failure) throw new Error(`не удалось проверить пустую рекламу: ${failure.error}`);
  return result.filter(item => !item.skipped);
}

async function prepareForCapture(page, testCase, config) {
  const ready = testCase.ready;
  const timeout = config.readiness.timeoutMs;
  const actualOrigin = new URL(page.url()).origin;
  const allowedOrigins = ready.allowedOrigins || config.allowedOrigins;
  if (!allowedOrigins.includes(actualOrigin)) {
    throw new Error(`origin ${actualOrigin} не входит в allowedOrigins`);
  }
  if (ready.selector) {
    const structural = /^(html|body)$/i.test(ready.selector.trim());
    await page.locator(ready.selector).first().waitFor({ state: structural ? 'attached' : 'visible', timeout });
  }
  if (ready.url) await page.waitForURL(url => url.href.includes(ready.url), { timeout });
  if (ready.text) await page.getByText(ready.text, { exact: false }).first().waitFor({ state: 'visible', timeout });
  if (config.readiness.fonts) await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  if (config.readiness.visibleImages) await waitForVisibleImages(page, timeout);

  const title = await page.title();
  if (config.readiness.forbiddenTitle && new RegExp(config.readiness.forbiddenTitle, 'i').test(title)) {
    throw new Error(`запрещённый title: ${title}`);
  }
  if (config.readiness.forbiddenText) {
    const text = await page.locator('body').innerText().catch(() => '');
    if (new RegExp(config.readiness.forbiddenText, 'i').test(text)) throw new Error('страница содержит признак ошибки');
  }

  const capture = testCase.capture;
  const collapsedEmptyAds = await collapseDeclaredEmptyAds(page, capture.collapseEmptyAds);
  if (capture.scroll === 'top') {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => window.scrollY === 0, null, { timeout });
  } else if (capture.scroll === 'anchor') {
    const anchorSelector = capture.anchor || capture.target;
    if (!anchorSelector) throw new Error('для scroll="anchor" нужен capture.anchor или capture.target');
    const anchor = page.locator(anchorSelector).first();
    await anchor.waitFor({ state: 'visible', timeout });
    const offset = capture.anchorOffsetPx || 0;
    await anchor.evaluate((element, anchorOffset) => {
      const rect = element.getBoundingClientRect();
      window.scrollTo(0, Math.max(0, window.scrollY + rect.top - anchorOffset));
    }, offset);
    await anchor.evaluate(element => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(element.getBoundingClientRect().top)));
    }));
  }
  return { target: await targetState(page, capture.target), collapsedEmptyAds };
}

async function stableScreenshot(page, testCase, file) {
  const capture = testCase.capture;
  const deadline = Date.now() + capture.stableTimeoutMs;
  let previous = await page.screenshot(screenshotOptions(testCase, undefined, page));
  let stable = 1;
  let analysis = await imageAnalysis(page, [previous]);
  while (Date.now() < deadline) {
    await delay(capture.stableIntervalMs);
    const current = await page.screenshot(screenshotOptions(testCase, undefined, page));
    analysis = await imageAnalysis(page, [previous, current]);
    if (!analysis.differentSize && analysis.diffRatio <= (capture.maxDiffRatio ?? 0.001)) stable++;
    else stable = 1;
    previous = current;
    if (stable >= capture.stableFrames) {
      fs.writeFileSync(file, current);
      return { buffer: current, analysis };
    }
  }
  throw new Error(`страница не стабилизировалась за ${capture.stableTimeoutMs} мс`);
}

function locatorFor(page, step) {
  if (!step.selector) throw new Error(`для действия ${step.action} нужен selector`);
  return page.locator(step.selector).first();
}

async function performStep(state, step, config) {
  const page = state.pages[step.page || state.activePage || 'main'];
  if (!page) throw new Error(`страница «${step.page}» не найдена`);
  const timeout = step.timeoutMs || (step.optional ? Math.min(2000, config.readiness.timeoutMs) : config.readiness.timeoutMs);
  try {
    switch (step.action) {
      case 'goto':
        await page.goto(absoluteUrl(step.url || step.value, config.baseUrl), { waitUntil: 'domcontentloaded', timeout });
        break;
      case 'click': {
        const locator = locatorFor(page, step);
        if (step.expectPage) {
          const [popup] = await Promise.all([
            page.waitForEvent('popup', { timeout }),
            locator.click({ timeout, force: Boolean(step.force) })
          ]);
          await popup.waitForURL(url => /^https?:$/.test(url.protocol), { timeout });
          await popup.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
          if (config.browser.windowState === 'maximized') await maximizeWindow(state.context, popup);
          state.pages[typeof step.expectPage === 'string' ? step.expectPage : 'popup'] = popup;
        } else {
          await locator.click({ timeout, force: Boolean(step.force) });
        }
        break;
      }
      case 'fill': await locatorFor(page, step).fill(String(step.value ?? ''), { timeout }); break;
      case 'select': {
        const value = step.label !== undefined ? { label: String(step.label) } : String(step.value ?? '');
        await locatorFor(page, step).selectOption(value, { timeout, force: Boolean(step.force) });
        break;
      }
      case 'check': await locatorFor(page, step).check({ timeout, force: Boolean(step.force) }); break;
      case 'uncheck': await locatorFor(page, step).uncheck({ timeout, force: Boolean(step.force) }); break;
      case 'press': await (step.selector ? locatorFor(page, step) : page.keyboard).press(step.key || step.value, { timeout }); break;
      case 'back': await page.goBack({ waitUntil: 'domcontentloaded', timeout }); break;
      case 'reload': await page.reload({ waitUntil: 'domcontentloaded', timeout }); break;
      case 'waitForUrl':
        await page.waitForURL(url => {
          if (step.regex) return new RegExp(step.value).test(url.href);
          if (step.exact) return url.href === absoluteUrl(step.value, config.baseUrl);
          return url.href.includes(step.value);
        }, { timeout });
        break;
      case 'waitForSelector': await locatorFor(page, step).waitFor({ state: step.state || 'visible', timeout }); break;
      default: throw new Error(`действие «${step.action}» не поддерживается`);
    }
  } catch (error) {
    if (!step.optional) throw error;
  }
}

async function captureOne(state, testCase, file, config) {
  const pageName = testCase.capture.page || testCase.ready.page || 'main';
  const page = state.pages[pageName];
  if (!page) throw new Error(`страница «${pageName}» не найдена`);
  await page.bringToFront();
  await normalizePageViewport(page, state.canonicalViewport);
  const prepared = await prepareForCapture(page, testCase, config);
  const target = prepared.target;
  if (target.required && !target.fullyVisible) throw new Error(`целевой элемент ${target.selector} обрезан или перекрыт`);
  const { buffer, analysis } = await stableScreenshot(page, testCase, file);
  if (analysis.whiteRatio > 0.995 && analysis.sampledColors < 8) throw new Error('получен практически пустой снимок');
  const dimensions = pngDimensions(buffer);
  const blankBand = analysis.largestInternalBlankBand || { heightPx: 0, startY: null, endY: null };
  if (blankBand.heightPx >= Math.max(160, Math.round(dimensions.height * 0.18))) {
    throw new Error(`получена пустая горизонтальная область ${blankBand.heightPx} px (y=${blankBand.startY}–${blankBand.endY})`);
  }
  const metrics = await pageMetrics(page);
  return {
    file: path.relative(state.runDir, file).replace(/\\/g, '/'),
    url: sanitizeManifestUrl(page.url()), title: await page.title(), viewport: dimensions,
    screen: state.screen || metrics.screen, devicePixelRatio: metrics.devicePixelRatio,
    scrollY: metrics.scrollY, documentHeight: metrics.documentHeight,
    target, whiteRatio: analysis.whiteRatio, largestInternalBlankBand: blankBand,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    capturedAt: new Date().toISOString(),
    redactedSelectors: testCase.capture.redactSelectors || [],
    collapsedEmptyAds: prepared.collapsedEmptyAds
  };
}

function attachEvents(page, events) {
  if (page.__uiEvidenceTracked) return;
  page.__uiEvidenceTracked = true;
  page.on('console', message => {
    if (['warning', 'error'].includes(message.type())) events.console.push({ at: new Date().toISOString(), type: message.type(), text: message.text(), url: sanitizeManifestUrl(page.url()) });
  });
  page.on('requestfailed', request => events.requestFailed.push({
    at: new Date().toISOString(), url: sanitizeEventUrl(request.url()), method: request.method(), error: request.failure()?.errorText || 'request failed'
  }));
  page.on('response', response => {
    if (response.status() >= 400) events.httpErrors.push({ at: new Date().toISOString(), url: sanitizeEventUrl(response.url()), status: response.status() });
  });
}

async function makeContactSheet(runDir, manifest) {
  const frames = manifest.cases.flatMap(testCase => [
    { label: testCase.id, status: testCase.status, file: testCase.file, note: testCase.reason || testCase.url || '' },
    ...(testCase.extraFiles || []).map((file, index) => ({
      label: `${testCase.id} — переход ${index + 1}`,
      status: 'captureAfter', file, note: path.basename(file)
    }))
  ]);
  const cards = frames.map(frame => {
    const file = frame.file ? path.join(runDir, frame.file) : null;
    const image = file && fs.existsSync(file) ? `data:image/png;base64,${fs.readFileSync(file).toString('base64')}` : '';
    return `<article><h2>${frame.label} — ${frame.status}</h2>${image ? `<img src="${image}">` : ''}<p>${frame.note}</p></article>`;
  }).join('');
  const { chromium } = requirePlaywright();
  const executablePath = findBrowser();
  if (!executablePath) throw new Error('Не найден Chromium для построения contact sheet.');
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>body{font-family:Arial;margin:20px;background:#ddd}main{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}article{background:white;padding:12px;border:1px solid #aaa}h2{font-size:18px;margin:0 0 8px}img{display:block;width:100%;height:auto;border:1px solid #ddd}p{overflow-wrap:anywhere}</style><main>${cards}</main>`);
    await page.screenshot({ path: path.join(runDir, 'contact-sheet.png'), fullPage: true, animations: 'disabled', caret: 'hide', scale: 'css' });
  } finally {
    await browser.close();
  }
}

async function runCapture(options) {
  const config = normalizeConfig(options.config);
  const projectRoot = path.resolve(options.projectRoot);
  const selected = options.only && options.only.length
    ? config.cases.filter(testCase => options.only.includes(testCase.id))
    : config.cases;
  if (!selected.length) throw new Error('Ни один Case ID не выбран для прогона.');
  if (options.only) {
    const known = new Set(config.cases.map(testCase => testCase.id));
    const unknown = options.only.filter(id => !known.has(id));
    if (unknown.length) throw new Error(`Неизвестные Case ID: ${unknown.join(', ')}.`);
  }

  const id = runId(options.now);
  const runDir = path.join(projectRoot, '.evidence-runs', id);
  const shotsDir = path.join(runDir, 'screenshots');
  fs.mkdirSync(shotsDir, { recursive: true });
  const events = { console: [], requestFailed: [], httpErrors: [] };
  const browser = await openFunctional(config, projectRoot);
  const state = {
    context: browser.context,
    pages: { main: browser.page },
    activePage: 'main',
    runDir,
    canonicalViewport: browser.info.viewport,
    screen: browser.info.screen
  };
  browser.context.on('page', page => attachEvents(page, events));
  attachEvents(browser.page, events);
  const results = [];

  try {
    for (const [caseIndex, testCase] of selected.entries()) {
      for (const [name, candidate] of Object.entries(state.pages)) {
        if (name !== 'main' && !candidate.isClosed()) await candidate.close().catch(() => {});
      }
      if (caseIndex > 0) {
        const previousMain = browser.page;
        const nextMain = await browser.context.newPage();
        attachEvents(nextMain, events);
        if (config.browser.windowState === 'maximized') await maximizeWindow(browser.context, nextMain);
        browser.page = nextMain;
        if (!previousMain.isClosed()) await previousMain.close().catch(() => {});
      }
      state.pages = { main: browser.page };
      const extras = [];
      let captureIndex = 0;
      try {
        await browser.page.bringToFront();
        await browser.page.goto(absoluteUrl(testCase.startUrl, config.baseUrl), {
          waitUntil: 'domcontentloaded', timeout: config.readiness.timeoutMs
        });
        for (const step of testCase.steps) {
          await performStep(state, step, config);
          if (step.captureAfter) {
            captureIndex++;
            const extraName = `${testCase.id}-${captureIndex}-${safeLabel(step.captureAfter, 'step')}.png`;
            const extraFile = path.join(shotsDir, extraName);
            const capturePage = step.capturePage
              || (typeof step.expectPage === 'string' ? step.expectPage : null)
              || step.page
              || 'main';
            const extraCase = {
              ...testCase,
              ready: {
                ...testCase.ready,
                selector: step.captureReady || 'body',
                page: capturePage,
                allowedOrigins: step.captureAllowedOrigins || config.allowedOrigins
              },
              capture: {
                ...testCase.capture,
                target: step.captureTarget || null,
                page: capturePage
              }
            };
            const extra = await captureOne(state, extraCase, extraFile, config);
            extras.push(extra.file);
          }
        }
        const finalFile = path.join(shotsDir, `${testCase.id}.png`);
        const captured = await captureOne(state, testCase, finalFile, config);
        results.push({ id: testCase.id, status: 'captured', ...captured, extraFiles: extras });
      } catch (error) {
        results.push({ id: testCase.id, status: 'blocked', reason: error.message.split('\n')[0], extraFiles: extras });
      }
    }

    const environment = {
      expectedScreen: config.browser.expectedScreen,
      screen: browser.info.screen,
      initialViewport: browser.info.viewport,
      devicePixelRatio: browser.info.devicePixelRatio,
      userAgent: browser.info.userAgent,
      browserMode: browser.info.mode,
      browser: browser.info.browser || null,
      profile: browser.info.profile || null,
      headless: browser.info.headless
    };
    const manifest = {
      schemaVersion: 1,
      runner: 'functional-screenshots',
      runId: id,
      createdAt: new Date().toISOString(),
      status: 'captured',
      config: { evidencePolicy: config.evidencePolicy, capture: config.capture },
      requestedCaseIds: selected.map(testCase => testCase.id),
      environment,
      cases: results,
      warnings: [], errors: []
    };
    const validation = validateRun(runDir, manifest);
    manifest.errors = validation.errors;
    manifest.warnings = validation.warnings;
    manifest.status = validation.errors.length ? 'failed' : validation.warnings.length ? 'warnings' : 'clean';
    fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(runDir, 'browser-events.json'), JSON.stringify(events, null, 2) + '\n', 'utf8');
    await makeContactSheet(runDir, manifest);
    return { runId: id, runDir, manifest, events };
  } finally {
    await browser.close();
  }
}

async function waitForProfileReady(page, config, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const selector = config.browser.profileReadySelector || config.readiness.readySelector || 'body';
  const challengePattern = new RegExp(config.readiness.forbiddenTitle || '(Checking|Just a moment|Attention Required|Один момент|Проверка)', 'i');
  while (Date.now() < deadline) {
    const title = await page.title().catch(() => '');
    const ready = await page.locator(selector).first().isVisible().catch(() => false);
    if (!challengePattern.test(title) && ready) return { title, url: page.url(), selector };
    await delay(500);
  }
  throw new Error(`Профиль не достиг готового состояния по selector «${selector}» за ${timeoutMs} мс.`);
}

async function prepareProfile(config, projectRoot, options = {}) {
  const normalized = normalizeConfig(config);
  const browser = await openFunctional(normalized, projectRoot);
  try {
    await browser.page.goto(normalized.baseUrl, { waitUntil: 'domcontentloaded', timeout: normalized.readiness.timeoutMs });
    const interactive = options.interactive ?? Boolean(process.stdin.isTTY);
    const timeoutMs = options.timeoutMs || normalized.browser.profileTimeoutMs || 300000;
    if (interactive) {
      process.stdout.write('Профиль открыт. Выполни ручную авторизацию/проверку и нажми Enter в терминале.\n');
      const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
      await new Promise(resolve => terminal.question('', resolve));
      terminal.close();
    } else {
      process.stdout.write(`Профиль открыт. Ожидаю готовность «${normalized.browser.profileReadySelector || normalized.readiness.readySelector}» до ${Math.round(timeoutMs / 1000)} секунд.\n`);
    }
    return await waitForProfileReady(browser.page, normalized, timeoutMs);
  } finally {
    await browser.close();
  }
}

async function checkEnvironment(options) {
  const config = normalizeConfig(options.config);
  const browser = await openFunctional(config, path.resolve(options.projectRoot));
  try {
    const actual = {
      screen: browser.info.screen,
      viewport: browser.info.viewport,
      devicePixelRatio: browser.info.devicePixelRatio,
      userAgent: browser.info.userAgent,
      browserMode: browser.info.mode,
      browser: browser.info.browser || null,
      profile: browser.info.profile || null,
      headless: browser.info.headless,
      windowState: config.browser.windowState,
      expectedScreen: config.browser.expectedScreen
    };
    if (actual.screen.width !== actual.expectedScreen.width || actual.screen.height !== actual.expectedScreen.height) {
      throw new Error(`Разрешение дисплея ${actual.screen.width}x${actual.screen.height} не совпадает с ожидаемым ${actual.expectedScreen.width}x${actual.expectedScreen.height}.`);
    }
    return actual;
  } finally {
    await browser.close();
  }
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (item === '--config') out.config = argv[++index];
    else if (item === '--out') out.projectRoot = argv[++index];
    else if (item === '--url') out.url = argv[++index];
    else if (item === '--only') out.only = argv[++index].split(',').filter(Boolean);
    else if (item === '--approve') out.approve = argv[++index];
    else if (item === '--prepare-profile') out.prepareProfile = true;
    else if (item === '--check') out.check = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.projectRoot) throw new Error('Не задан --out с каталогом проекта.');
  if (args.approve) {
    const result = promoteRun(args.projectRoot, args.approve);
    console.log(`Одобрено снимков: ${result.promoted.length}`);
    if (result.backupDir) console.log(`Резервная копия: ${result.backupDir}`);
    if (result.warnings.length) console.log(`Предупреждения: ${result.warnings.join(' | ')}`);
    return 0;
  }
  if (!args.config) throw new Error('Не задан --config.');
  let config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  if (args.url) config = { ...config, baseUrl: args.url };
  if (args.check) {
    const checked = await checkEnvironment({ config, projectRoot: args.projectRoot });
    console.log(`Дисплей: ${checked.screen.width}x${checked.screen.height}`);
    console.log(`Viewport: ${checked.viewport.width}x${checked.viewport.height}`);
    console.log(`Окно: ${checked.windowState}`);
    console.log(`User-Agent: ${checked.userAgent}`);
    console.log(`Профиль: ${checked.profile || 'CDP-сессия'}`);
    return 0;
  }
  if (args.prepareProfile) {
    await prepareProfile(config, args.projectRoot);
    return 0;
  }
  const result = await runCapture({ config, projectRoot: args.projectRoot, only: args.only });
  console.log(`Прогон: ${result.runId}`);
  console.log(`Каталог: ${result.runDir}`);
  console.log(`Статус: ${result.manifest.status}`);
  console.log(`Contact sheet: ${path.join(result.runDir, 'contact-sheet.png')}`);
  for (const error of result.manifest.errors) console.error(`Ошибка: ${error}`);
  for (const warning of result.manifest.warnings) console.warn(`Предупреждение: ${warning}`);
  return result.manifest.status === 'failed' ? 2 : 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`Ошибка: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  runCapture, prepareProfile, checkEnvironment, performStep, prepareForCapture,
  stableScreenshot, makeContactSheet, waitForProfileReady, normalizePageViewport, sanitizeManifestUrl, sanitizeEventUrl, main
};
