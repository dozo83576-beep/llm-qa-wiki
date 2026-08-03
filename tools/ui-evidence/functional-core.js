const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RUNNER = 'functional-screenshots';
const CASE_ID_RE = /^TC-\d{3,}$/;
const ACTIONS = new Set([
  'goto', 'click', 'fill', 'select', 'check', 'uncheck', 'press', 'back', 'reload',
  'waitForUrl', 'waitForSelector'
]);

function detectRunner(config) {
  return config && config.runner === RUNNER ? RUNNER : 'legacy-ui';
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} должен быть объектом.`);
  }
}

function normalizeConfig(input) {
  assertObject(input, 'Конфиг');
  if (input.schemaVersion !== 2 || input.runner !== RUNNER) {
    throw new Error(`Для ${RUNNER} требуются schemaVersion=2 и runner="${RUNNER}".`);
  }
  if (typeof input.baseUrl !== 'string' || !/^https?:\/\//i.test(input.baseUrl)) {
    throw new Error('baseUrl должен быть абсолютным HTTP(S) URL.');
  }
  if (!Array.isArray(input.cases) || input.cases.length === 0) {
    throw new Error('cases должен содержать хотя бы один тест-кейс.');
  }

  const config = {
    ...input,
    allowedOrigins: input.allowedOrigins || [new URL(input.baseUrl).origin],
    evidencePolicy: input.evidencePolicy || 'all',
    browser: {
      mode: 'launch',
      windowState: 'maximized',
      expectedScreen: { width: 1920, height: 1080 },
      ...(input.browser || {})
    },
    capture: {
      mode: 'viewport',
      scroll: 'top',
      scale: 'css',
      animations: 'disabled',
      stableFrames: 2,
      stableIntervalMs: 500,
      stableTimeoutMs: 12000,
      collapseEmptyAds: [],
      ...(input.capture || {})
    },
    readiness: {
      readySelector: 'body',
      timeoutMs: 45000,
      fonts: true,
      visibleImages: true,
      forbiddenTitle: '(Checking|Just a moment|Attention Required|Проверка)',
      forbiddenText: '(404|Page not found|Страница не найдена)',
      ...(input.readiness || {})
    }
  };

  if (!['all', 'failures', 'selected'].includes(config.evidencePolicy)) {
    throw new Error(`evidencePolicy «${config.evidencePolicy}» не поддерживается.`);
  }
  if (!Array.isArray(config.allowedOrigins) || !config.allowedOrigins.length ||
      config.allowedOrigins.some(origin => {
        try { return new URL(origin).origin !== origin; } catch { return true; }
      })) {
    throw new Error('allowedOrigins должен содержать абсолютные origin без пути.');
  }
  if (!['launch', 'cdp'].includes(config.browser.mode)) {
    throw new Error(`browser.mode «${config.browser.mode}» не поддерживается.`);
  }
  if (!['maximized', 'fixed'].includes(config.browser.windowState)) {
    throw new Error(`browser.windowState «${config.browser.windowState}» не поддерживается.`);
  }
  if (config.browser.cookieBlocklist !== undefined &&
      (!Array.isArray(config.browser.cookieBlocklist) ||
       config.browser.cookieBlocklist.some(name => typeof name !== 'string' || !name.trim()))) {
    throw new Error('browser.cookieBlocklist должен быть массивом непустых имён cookies.');
  }
  if (config.browser.windowState === 'fixed') {
    const viewport = config.browser.viewport;
    if (!viewport || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height)) {
      throw new Error('Для browser.windowState="fixed" нужен browser.viewport с целыми width и height.');
    }
  }
  assertObject(config.browser.expectedScreen, 'browser.expectedScreen');
  if (!Number.isInteger(config.browser.expectedScreen.width) || !Number.isInteger(config.browser.expectedScreen.height)) {
    throw new Error('browser.expectedScreen должен содержать целые width и height.');
  }
  if (!['viewport', 'fullPage'].includes(config.capture.mode)) {
    throw new Error(`capture.mode «${config.capture.mode}» не поддерживается.`);
  }
  if (!['top', 'anchor', 'current'].includes(config.capture.scroll)) {
    throw new Error(`capture.scroll «${config.capture.scroll}» не поддерживается.`);
  }
  if (!Number.isInteger(config.capture.stableFrames) || config.capture.stableFrames < 2) {
    throw new Error('capture.stableFrames должен быть целым числом не меньше 2.');
  }

  const ids = new Set();
  config.cases = config.cases.map((testCase, index) => {
    assertObject(testCase, `cases[${index}]`);
    if (!CASE_ID_RE.test(testCase.id || '')) {
      throw new Error(`cases[${index}].id должен иметь формат TC-NNN.`);
    }
    if (ids.has(testCase.id)) throw new Error(`Case ID ${testCase.id} повторяется.`);
    ids.add(testCase.id);
    const steps = testCase.steps || [];
    if (!Array.isArray(steps)) throw new Error(`${testCase.id}.steps должен быть массивом.`);
    for (const [stepIndex, step] of steps.entries()) {
      assertObject(step, `${testCase.id}.steps[${stepIndex}]`);
      if (!ACTIONS.has(step.action)) {
        throw new Error(`${testCase.id}: действие «${step.action}» не поддерживается.`);
      }
    }
    const normalizedCase = {
      ...testCase,
      startUrl: testCase.startUrl || '/',
      steps,
      ready: { selector: config.readiness.readySelector, ...(testCase.ready || {}) },
      capture: { ...config.capture, ...(testCase.capture || {}) }
    };
    if (normalizedCase.capture.scroll === 'anchor' &&
        !(typeof normalizedCase.capture.anchor === 'string' && normalizedCase.capture.anchor.trim()) &&
        !(typeof normalizedCase.capture.target === 'string' && normalizedCase.capture.target.trim())) {
      throw new Error(`${testCase.id}: для scroll="anchor" нужен capture.anchor или capture.target.`);
    }
    if (normalizedCase.capture.anchorOffsetPx !== undefined &&
        (!Number.isInteger(normalizedCase.capture.anchorOffsetPx) || normalizedCase.capture.anchorOffsetPx < 0)) {
      throw new Error(`${testCase.id}: capture.anchorOffsetPx должен быть целым неотрицательным числом.`);
    }
    if (!Array.isArray(normalizedCase.capture.collapseEmptyAds)) {
      throw new Error(`${testCase.id}: capture.collapseEmptyAds должен быть массивом.`);
    }
    for (const [ruleIndex, rule] of normalizedCase.capture.collapseEmptyAds.entries()) {
      assertObject(rule, `${testCase.id}.capture.collapseEmptyAds[${ruleIndex}]`);
      if (typeof rule.container !== 'string' || !rule.container.trim() ||
          typeof rule.slot !== 'string' || !rule.slot.trim()) {
        throw new Error(`${testCase.id}: правило collapseEmptyAds должно содержать container и slot.`);
      }
      if (rule.optional !== undefined && typeof rule.optional !== 'boolean') {
        throw new Error(`${testCase.id}: collapseEmptyAds.optional должен быть boolean.`);
      }
    }
    return normalizedCase;
  });
  return config;
}

function pngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 ||
      !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Файл не является корректным PNG с заголовком IHDR.');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) throw new Error('PNG содержит нулевой размер.');
  return { width, height };
}

function inside(root, relative) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relative);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Путь выходит за каталог прогона: ${relative}`);
  }
  return resolved;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function validateRun(runDir, manifest) {
  const errors = [];
  const warnings = [];
  if (!manifest || manifest.runner !== RUNNER || !Array.isArray(manifest.cases)) {
    return { errors: ['manifest.json не соответствует functional-screenshots.'], warnings, files: [] };
  }
  const requested = new Set(manifest.requestedCaseIds || []);
  const seen = new Set();
  const sizes = new Map();
  const hashes = new Map();
  const files = [];

  for (const testCase of manifest.cases) {
    if (!testCase || !CASE_ID_RE.test(testCase.id || '')) {
      errors.push('В manifest найден кейс без корректного Case ID.');
      continue;
    }
    if (seen.has(testCase.id)) errors.push(`Case ID ${testCase.id} повторяется в manifest.`);
    seen.add(testCase.id);
    if (testCase.status !== 'captured') {
      errors.push(`${testCase.id}: снимок не получен${testCase.reason ? ` — ${testCase.reason}` : ''}.`);
      continue;
    }
    try {
      const file = inside(runDir, testCase.file);
      if (!isFile(file)) {
        errors.push(`${testCase.id}: файл не найден — ${testCase.file}.`);
        continue;
      }
      const buffer = fs.readFileSync(file);
      const dimensions = pngDimensions(buffer);
      const sizeKey = `${dimensions.width}x${dimensions.height}`;
      sizes.set(sizeKey, (sizes.get(sizeKey) || []).concat(testCase.id));
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      hashes.set(sha256, (hashes.get(sha256) || []).concat(testCase.id));
      if (testCase.sha256 && testCase.sha256 !== sha256) errors.push(`${testCase.id}: SHA-256 не совпадает с manifest.`);
      if (testCase.viewport && (testCase.viewport.width !== dimensions.width || testCase.viewport.height !== dimensions.height)) {
        errors.push(`${testCase.id}: размер PNG не совпадает с viewport в manifest.`);
      }
      if (testCase.target && testCase.target.required && !testCase.target.fullyVisible) {
        errors.push(`${testCase.id}: целевой элемент отсутствует, обрезан или перекрыт.`);
      }
      files.push({ id: testCase.id, name: path.basename(file), file, dimensions, sha256, primary: true });
      for (const extraReference of testCase.extraFiles || []) {
        const extra = inside(runDir, extraReference);
        if (!isFile(extra)) {
          errors.push(`${testCase.id}: дополнительный файл не найден — ${extraReference}.`);
          continue;
        }
        const extraBuffer = fs.readFileSync(extra);
        const extraDimensions = pngDimensions(extraBuffer);
        const extraSizeKey = `${extraDimensions.width}x${extraDimensions.height}`;
        sizes.set(extraSizeKey, (sizes.get(extraSizeKey) || []).concat(`${testCase.id}:${path.basename(extra)}`));
        files.push({
          id: testCase.id, name: path.basename(extra), file: extra, dimensions: extraDimensions,
          sha256: crypto.createHash('sha256').update(extraBuffer).digest('hex'), primary: false
        });
      }
    } catch (error) {
      errors.push(`${testCase.id}: ${error.message}`);
    }
  }

  for (const id of requested) {
    if (!seen.has(id)) errors.push(`В manifest отсутствует запрошенный кейс ${id}.`);
  }
  if (sizes.size > 1) {
    errors.push(`В одном прогоне разные размеры PNG: ${[...sizes.entries()].map(([size, ids]) => `${size} (${ids.join(', ')})`).join('; ')}.`);
  }
  const casesById = new Map((manifest.cases || []).map(testCase => [testCase.id, testCase]));
  for (const ids of hashes.values()) {
    if (ids.length > 1) {
      const explainedTransitions = ids.filter(id => (casesById.get(id)?.extraFiles || []).length > 0).length;
      if (explainedTransitions < ids.length - 1) warnings.push(`Точные дубликаты снимков: ${ids.join(', ')}.`);
    }
  }
  if (manifest.environment && manifest.environment.expectedScreen && manifest.environment.screen) {
    const expected = manifest.environment.expectedScreen;
    const actual = manifest.environment.screen;
    if (expected.width !== actual.width || expected.height !== actual.height) {
      errors.push(`Разрешение дисплея ${actual.width}x${actual.height} не совпадает с ожидаемым ${expected.width}x${expected.height}.`);
    }
  }
  return { errors, warnings, files };
}

function timestamp(value) {
  return value.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function promoteRun(projectRoot, runId, options = {}) {
  const project = path.resolve(projectRoot);
  const runsRoot = path.join(project, '.evidence-runs');
  const runDir = inside(runsRoot, runId);
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!isFile(manifestPath)) throw new Error(`Manifest прогона не найден: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const validation = validateRun(runDir, manifest);
  if (validation.errors.length) throw new Error(`Прогон не прошёл quality gate:\n- ${validation.errors.join('\n- ')}`);

  const now = options.now || new Date();
  const backupDir = path.join(project, '.evidence-backups', timestamp(now));
  const evidenceDir = path.join(project, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const promoted = [];
  const backedUp = [];

  for (const item of validation.files) {
    const destination = path.join(evidenceDir, item.name);
    if (fs.existsSync(destination)) {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.renameSync(destination, path.join(backupDir, path.basename(destination)));
      backedUp.push(destination);
    }
    const temp = destination + '.tmp';
    fs.copyFileSync(item.file, temp);
    fs.renameSync(temp, destination);
    promoted.push(destination);
  }

  const approved = {
    ...manifest,
    cases: manifest.cases.map(testCase => ({
      ...testCase,
      file: testCase.file ? path.basename(testCase.file) : testCase.file,
      extraFiles: (testCase.extraFiles || []).map(reference => path.basename(reference))
    })),
    status: validation.warnings.length ? 'approved-with-warnings' : 'approved',
    warnings: validation.warnings,
    approval: { status: 'approved', approvedAt: now.toISOString(), runId }
  };
  const dataDir = path.join(evidenceDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'screenshot-run.json'), JSON.stringify(approved, null, 2) + '\n', 'utf8');
  return { promoted, backedUp, backupDir: backedUp.length ? backupDir : null, warnings: validation.warnings };
}

module.exports = {
  RUNNER,
  ACTIONS,
  detectRunner,
  normalizeConfig,
  pngDimensions,
  validateRun,
  promoteRun
};
