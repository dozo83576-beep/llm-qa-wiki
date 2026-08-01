/**
 * Конфигурация браузера для сбора UI-доказательств.
 *
 * Три вещи, ради которых это вынесено в отдельный модуль:
 *  1) все кейсы прогона работают в одинаковых условиях — иначе результаты несравнимы;
 *  2) профиль браузера сохраняется между запусками, поэтому анти-бот проверка проходится один раз,
 *     а не на каждой навигации (см. patterns/process/blocked-target-browser-config.md);
 *  3) конфигурация меняется переменными окружения, без правки скриптов.
 *
 * Переменные окружения:
 *   UI_EVIDENCE_BROWSER   — путь к chrome.exe / chromium. По умолчанию ищется в кэше Playwright.
 *   UI_EVIDENCE_PROFILE   — каталог профиля. По умолчанию <os.tmpdir()>/ui-evidence-profile.
 *   UI_EVIDENCE_HEADLESS  — "1" переводит в headless. По умолчанию headed: сайты с анти-бот
 *                           защитой рвут headless-соединение.
 *   UI_EVIDENCE_UA        — User-Agent. По умолчанию реальный UA Chrome.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

function findBrowser() {
  if (process.env.UI_EVIDENCE_BROWSER) return process.env.UI_EVIDENCE_BROWSER;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const roots = [
    path.join(home, 'AppData', 'Local', 'ms-playwright'),
    path.join(home, '.cache', 'ms-playwright')
  ];
  const candidates = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      if (!/^chromium-\d+$/.test(dir)) continue;
      for (const rel of [['chrome-win64', 'chrome.exe'], ['chrome-linux', 'chrome'], ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']]) {
        const exe = path.join(root, dir, ...rel);
        if (fs.existsSync(exe)) candidates.push({ build: Number(dir.split('-')[1]), exe });
      }
    }
  }
  candidates.sort((a, b) => b.build - a.build);
  return candidates.length ? candidates[0].exe : null;
}

function requirePlaywright() {
  try {
    return require('playwright');
  } catch (e) {
    throw new Error(
      'Модуль playwright не найден. Установи его (npm i -g playwright) либо задай NODE_PATH на каталог, где он лежит. Исходная ошибка: ' + e.message
    );
  }
}

/** Проверка среды до прогона: движок, браузер, профиль. Возвращает описание найденного. */
function preflight() {
  const { chromium } = requirePlaywright();
  const exe = findBrowser();
  if (!exe) throw new Error('Не найден исполняемый файл Chromium. Запусти "npx playwright install chromium" или задай UI_EVIDENCE_BROWSER.');
  return {
    playwright: require('playwright/package.json').version,
    browser: exe,
    profile: profileDir(),
    headless: process.env.UI_EVIDENCE_HEADLESS === '1',
    userAgent: process.env.UI_EVIDENCE_UA || DEFAULT_UA,
    chromiumOk: typeof chromium.launchPersistentContext === 'function'
  };
}

function profileDir() {
  return process.env.UI_EVIDENCE_PROFILE || path.join(os.tmpdir(), 'ui-evidence-profile');
}

/**
 * Открывает браузер с сохраняемым профилем.
 * Возвращает { context, page, close, info }.
 */
async function open({ width = 1366, height = 900, locale = 'ru-RU' } = {}) {
  const { chromium } = requirePlaywright();
  const exe = findBrowser();
  if (!exe) throw new Error('Не найден исполняемый файл Chromium. Запусти "npx playwright install chromium" или задай UI_EVIDENCE_BROWSER.');
  const dir = profileDir();
  fs.mkdirSync(dir, { recursive: true });

  const context = await chromium.launchPersistentContext(dir, {
    executablePath: exe,
    headless: process.env.UI_EVIDENCE_HEADLESS === '1',
    locale,
    userAgent: process.env.UI_EVIDENCE_UA || DEFAULT_UA,
    viewport: { width, height },
    deviceScaleFactor: 1,
    args: ['--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check']
  });
  const page = context.pages()[0] || await context.newPage();
  return {
    context,
    page,
    info: { browser: exe, profile: dir, headless: process.env.UI_EVIDENCE_HEADLESS === '1', viewport: width + 'x' + height },
    close: () => context.close()
  };
}

/**
 * Навигация с повторами и ожиданием конца анти-бот проверки.
 * Возвращает { status, attempts, title }. Бросает исключение, если не удалось ни разу.
 */
async function goto(page, url, { attempts = 6, timeout = 45000 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      for (let i = 0; i < 30; i++) {
        const title = await page.title();
        if (!/Checking|Just a moment|Проверка|Attention Required/i.test(title)) break;
        await page.waitForTimeout(1000);
      }
      await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
      return { status: resp ? resp.status() : null, attempts: attempt, title: await page.title() };
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(3000 * attempt);
    }
  }
  throw new Error('Навигация не удалась за ' + attempts + ' попыток: ' + lastErr.message.split('\n')[0]);
}

module.exports = { open, goto, preflight, findBrowser, profileDir, DEFAULT_UA };
