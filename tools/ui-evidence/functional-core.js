const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { mergeAccessibility } = require('./axe-accessibility');

const RUNNER = 'functional-screenshots';
const CASE_ID_RE = /^TC-\d{3,}$/;
const ACTIONS = new Set([
  'goto', 'click', 'clickAt', 'fill', 'select', 'check', 'uncheck', 'press', 'back', 'reload',
  'waitForUrl', 'waitForSelector', 'waitForText', 'waitForCount', 'waitForAttribute', 'waitForHidden',
  'assertUrl', 'assertText', 'assertCount'
]);
const PROOF_METRICS = new Set([
  'page-overflow', 'image-health', 'navigation-timing', 'element-box', 'element-state'
]);
const PROOF_POSITIONS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);

function detectRunner(config) {
  return config && config.runner === RUNNER ? RUNNER : 'legacy-ui';
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} должен быть объектом.`);
  }
}

function validateProof(proof, label) {
  assertObject(proof, label);
  if (typeof proof.title !== 'string' || !proof.title.trim()) {
    throw new Error(`${label}.title должен быть непустой строкой.`);
  }
  if (proof.note !== undefined && typeof proof.note !== 'string') {
    throw new Error(`${label}.note должен быть строкой.`);
  }
  if (proof.position !== undefined && !PROOF_POSITIONS.has(proof.position)) {
    throw new Error(`${label}.position не поддерживается.`);
  }
  if (proof.highlights !== undefined &&
      (!Array.isArray(proof.highlights) || proof.highlights.some(selector => typeof selector !== 'string' || !selector.trim()))) {
    throw new Error(`${label}.highlights должен быть массивом непустых селекторов.`);
  }
  if (proof.metrics !== undefined && !Array.isArray(proof.metrics)) {
    throw new Error(`${label}.metrics должен быть массивом.`);
  }
  for (const [metricIndex, metric] of (proof.metrics || []).entries()) {
    assertObject(metric, `${label}.metrics[${metricIndex}]`);
    if (!PROOF_METRICS.has(metric.type)) {
      throw new Error(`${label}: proof metric «${metric.type}» не поддерживается.`);
    }
    if (metric.label !== undefined && typeof metric.label !== 'string') {
      throw new Error(`${label}: proof metric label должен быть строкой.`);
    }
    if (['element-box', 'element-state'].includes(metric.type) &&
        (typeof metric.selector !== 'string' || !metric.selector.trim())) {
      throw new Error(`${label}: proof metric ${metric.type} требует selector.`);
    }
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

  const readinessTimeoutMs = input.readiness && input.readiness.timeoutMs !== undefined
    ? input.readiness.timeoutMs
    : 45000;
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
    },
    navigation: {
      attempts: 3,
      timeoutMs: readinessTimeoutMs,
      retryDelayMs: 1000,
      networkIdleTimeoutMs: 3000,
      ...(input.navigation || {})
    },
    diagnostics: {
      trace: 'off',
      ...(input.diagnostics || {})
    },
    checks: {
      accessibility: null,
      ...(input.checks || {})
    }
  };

  if (input.checks !== undefined) assertObject(input.checks, 'checks');
  if (Object.keys(input.checks || {}).some(key => key !== 'accessibility')) {
    throw new Error('checks поддерживает только accessibility.');
  }
  const globalAccessibility = config.checks.accessibility;
  mergeAccessibility(undefined, globalAccessibility);

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
  if (!Number.isInteger(config.navigation.attempts) || config.navigation.attempts < 1 || config.navigation.attempts > 10) {
    throw new Error('navigation.attempts должен быть целым числом от 1 до 10.');
  }
  for (const name of ['timeoutMs', 'retryDelayMs', 'networkIdleTimeoutMs']) {
    if (!Number.isInteger(config.navigation[name]) || config.navigation[name] < 0 ||
        (name === 'timeoutMs' && config.navigation[name] === 0)) {
      throw new Error(`navigation.${name} должен быть ${name === 'timeoutMs' ? 'положительным' : 'неотрицательным'} целым числом.`);
    }
  }
  if (!['off', 'failures'].includes(config.diagnostics.trace)) {
    throw new Error('diagnostics.trace поддерживает только "off" и "failures".');
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
      if (step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs <= 0)) {
        throw new Error(`${testCase.id}: timeoutMs шага должен быть положительным целым числом.`);
      }
      if (step.action === 'clickAt' &&
          (!Number.isFinite(step.x) || step.x < 0 || !Number.isFinite(step.y) || step.y < 0)) {
        throw new Error(`${testCase.id}: clickAt требует неотрицательные числовые x и y.`);
      }
      if (['waitForText', 'assertText'].includes(step.action) &&
          (typeof step.selector !== 'string' || !step.selector.trim() || typeof step.value !== 'string')) {
        throw new Error(`${testCase.id}: ${step.action} требует selector и строковое value.`);
      }
      if (['waitForCount', 'assertCount'].includes(step.action) &&
          (typeof step.selector !== 'string' || !step.selector.trim() ||
           !Number.isInteger(step.value) || step.value < 0)) {
        throw new Error(`${testCase.id}: ${step.action} требует selector и неотрицательное целое value.`);
      }
      if (step.action === 'waitForAttribute' &&
          (typeof step.selector !== 'string' || !step.selector.trim() ||
           typeof step.name !== 'string' || !step.name.trim() || typeof step.value !== 'string')) {
        throw new Error(`${testCase.id}: waitForAttribute требует selector, name и строковое value.`);
      }
      if (step.action === 'waitForHidden' && (typeof step.selector !== 'string' || !step.selector.trim())) {
        throw new Error(`${testCase.id}: waitForHidden требует selector.`);
      }
      if (['waitForUrl', 'assertUrl'].includes(step.action) && typeof step.value !== 'string') {
        throw new Error(`${testCase.id}: ${step.action} требует строковое value.`);
      }
      if (step.captureProof !== undefined && step.captureProof !== false) {
        validateProof(step.captureProof, `${testCase.id}.steps[${stepIndex}].captureProof`);
      }
      if (step.captureAnchor !== undefined && (typeof step.captureAnchor !== 'string' || !step.captureAnchor.trim())) {
        throw new Error(`${testCase.id}: captureAnchor должен быть непустым селектором.`);
      }
    }
    if (testCase.primaryCaptureAfter !== undefined) {
      if (typeof testCase.primaryCaptureAfter !== 'string' || !testCase.primaryCaptureAfter.trim()) {
        throw new Error(`${testCase.id}: primaryCaptureAfter должен быть непустой строкой.`);
      }
      const matches = steps.filter(step => step.captureAfter === testCase.primaryCaptureAfter).length;
      if (matches !== 1) {
        throw new Error(`${testCase.id}: primaryCaptureAfter должен совпадать ровно с одним captureAfter.`);
      }
    }
    if (testCase.stateGroup !== undefined &&
        (typeof testCase.stateGroup !== 'string' || !testCase.stateGroup.trim())) {
      throw new Error(`${testCase.id}: stateGroup должен быть непустой строкой.`);
    }
    if (testCase.checks !== undefined) {
      assertObject(testCase.checks, `${testCase.id}.checks`);
      if (Object.keys(testCase.checks).some(key => key !== 'accessibility')) {
        throw new Error(`${testCase.id}.checks поддерживает только accessibility.`);
      }
    }
    const normalizedCase = {
      ...testCase,
      startUrl: testCase.startUrl || '/',
      steps,
      ready: { selector: config.readiness.readySelector, ...(testCase.ready || {}) },
      capture: { ...config.capture, ...(testCase.capture || {}) },
      checks: {
        accessibility: mergeAccessibility(
          globalAccessibility,
          testCase.checks && Object.prototype.hasOwnProperty.call(testCase.checks, 'accessibility')
            ? testCase.checks.accessibility
            : undefined,
          `${testCase.id}.checks.accessibility`
        )
      }
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
    if (normalizedCase.capture.contextSelector !== undefined && normalizedCase.capture.contextSelector !== false &&
        (typeof normalizedCase.capture.contextSelector !== 'string' || !normalizedCase.capture.contextSelector.trim())) {
      throw new Error(`${testCase.id}: capture.contextSelector должен быть непустым селектором или false.`);
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
    if (normalizedCase.capture.proof !== undefined) {
      validateProof(normalizedCase.capture.proof, `${testCase.id}.capture.proof`);
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
    return { errors: ['manifest.json не соответствует functional-screenshots.'], warnings, files: [], accessibilityFiles: [] };
  }
  const requested = new Set(manifest.requestedCaseIds || []);
  const seen = new Set();
  const viewportSizes = new Map();
  const fullPageWidths = new Map();
  const hashes = new Map();
  const files = [];
  const accessibilityFiles = [];

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
      const captureMode = testCase.captureMode || manifest.config?.capture?.mode || 'viewport';
      if (captureMode === 'fullPage') {
        fullPageWidths.set(dimensions.width, (fullPageWidths.get(dimensions.width) || []).concat(testCase.id));
      } else {
        const sizeKey = `${dimensions.width}x${dimensions.height}`;
        viewportSizes.set(sizeKey, (viewportSizes.get(sizeKey) || []).concat(testCase.id));
      }
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      hashes.set(sha256, (hashes.get(sha256) || []).concat(testCase.id));
      if (testCase.sha256 && testCase.sha256 !== sha256) errors.push(`${testCase.id}: SHA-256 не совпадает с manifest.`);
      const expectedImage = testCase.image || (testCase.captureMode ? null : testCase.viewport);
      if (expectedImage && (expectedImage.width !== dimensions.width || expectedImage.height !== dimensions.height)) {
        errors.push(`${testCase.id}: размер PNG не совпадает с image в manifest.`);
      }
      if (testCase.target && testCase.target.required && !testCase.target.fullyVisible) {
        errors.push(`${testCase.id}: целевой элемент отсутствует, обрезан или перекрыт.`);
      }
      if (testCase.context && testCase.context.required && !testCase.context.fullyVisible) {
        errors.push(`${testCase.id}: контекстный элемент отсутствует, обрезан или перекрыт.`);
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
        files.push({
          id: testCase.id, name: path.basename(extra), file: extra, dimensions: extraDimensions,
          sha256: crypto.createHash('sha256').update(extraBuffer).digest('hex'), primary: false
        });
      }
      if (testCase.accessibility) {
        const reference = testCase.accessibility.artifact;
        const artifactFile = inside(runDir, reference);
        if (!isFile(artifactFile)) {
          errors.push(`${testCase.id}: accessibility artifact не найден — ${reference}.`);
        } else {
          const content = fs.readFileSync(artifactFile);
          const sha256 = crypto.createHash('sha256').update(content).digest('hex');
          if (sha256 !== testCase.accessibility.sha256) {
            errors.push(`${testCase.id}: SHA-256 accessibility artifact не совпадает с manifest.`);
          } else {
            const artifact = JSON.parse(content.toString('utf8'));
            if (artifact.engine?.name !== 'axe-core' || artifact.engine?.version !== testCase.accessibility.engine?.version) {
              errors.push(`${testCase.id}: engine accessibility artifact не совпадает с manifest.`);
            }
            if (JSON.stringify(artifact.counts) !== JSON.stringify(testCase.accessibility.counts)) {
              errors.push(`${testCase.id}: counts accessibility artifact не совпадают с manifest.`);
            }
            if (artifact.manual_review_required !== Boolean(testCase.accessibility.manual_review_required)) {
              errors.push(`${testCase.id}: manual_review_required accessibility artifact не совпадает с manifest.`);
            }
            accessibilityFiles.push({ id: testCase.id, file: artifactFile, name: `${testCase.id}.json`, sha256 });
            if (artifact.manual_review_required) {
              warnings.push(`${testCase.id}: axe-core вернул incomplete; требуется ручная accessibility-проверка.`);
            }
          }
        }
      }
    } catch (error) {
      errors.push(`${testCase.id}: ${error.message}`);
    }
  }

  for (const id of requested) {
    if (!seen.has(id)) errors.push(`В manifest отсутствует запрошенный кейс ${id}.`);
  }
  if (viewportSizes.size > 1) {
    errors.push(`В одном прогоне разные размеры основных viewport-PNG: ${[...viewportSizes.entries()].map(([size, ids]) => `${size} (${ids.join(', ')})`).join('; ')}.`);
  }
  if (fullPageWidths.size > 1) {
    errors.push(`В одном прогоне разная ширина основных fullPage-PNG: ${[...fullPageWidths.entries()].map(([width, ids]) => `${width}px (${ids.join(', ')})`).join('; ')}.`);
  }
  for (const ids of hashes.values()) {
    if (ids.length > 1) {
      errors.push(`Точные дубликаты основных снимков: ${ids.join(', ')}. Каждый кейс должен показывать собственный проверяемый результат.`);
    }
  }
  if (manifest.environment && manifest.environment.expectedScreen && manifest.environment.screen) {
    const expected = manifest.environment.expectedScreen;
    const actual = manifest.environment.screen;
    if (expected.width !== actual.width || expected.height !== actual.height) {
      errors.push(`Разрешение дисплея ${actual.width}x${actual.height} не совпадает с ожидаемым ${expected.width}x${expected.height}.`);
    }
  }
  return { errors, warnings, files, accessibilityFiles };
}

function timestamp(value) {
  return value.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function environmentSignature(environment) {
  if (!environment) return null;
  return JSON.stringify({
    screen: environment.screen || null,
    viewport: environment.initialViewport || null,
    devicePixelRatio: environment.devicePixelRatio ?? null,
    userAgent: environment.userAgent || null,
    browserMode: environment.browserMode || null,
    headless: environment.headless ?? null
  });
}

function validateApprovedAccessibility(dataDir, testCase) {
  if (!testCase.accessibility) return;
  const file = inside(dataDir, testCase.accessibility.artifact);
  if (!isFile(file)) throw new Error(`${testCase.id}: сохранённый accessibility artifact отсутствует.`);
  const content = fs.readFileSync(file);
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  if (digest !== testCase.accessibility.sha256) {
    throw new Error(`${testCase.id}: сохранённый accessibility artifact изменён.`);
  }
  const artifact = JSON.parse(content.toString('utf8'));
  if (artifact.engine?.name !== 'axe-core' || artifact.engine?.version !== testCase.accessibility.engine?.version ||
      JSON.stringify(artifact.counts) !== JSON.stringify(testCase.accessibility.counts)) {
    throw new Error(`${testCase.id}: сохранённый accessibility artifact не совпадает с manifest.`);
  }
}

function validatePreservedCase(evidenceDir, dataDir, testCase) {
  if (!testCase || testCase.status !== 'captured') throw new Error('Сохранённый кейс имеет некорректный status.');
  const primary = inside(evidenceDir, testCase.file);
  if (!isFile(primary)) throw new Error(`${testCase.id}: сохранённый основной PNG отсутствует.`);
  if (testCase.sha256) {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(primary)).digest('hex');
    if (digest !== testCase.sha256) throw new Error(`${testCase.id}: сохранённый основной PNG изменён.`);
  }
  for (const reference of testCase.extraFiles || []) {
    if (!isFile(inside(evidenceDir, reference))) {
      throw new Error(`${testCase.id}: сохранённый дополнительный PNG отсутствует — ${reference}.`);
    }
  }
  validateApprovedAccessibility(dataDir, testCase);
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
  const dataDir = path.join(evidenceDir, 'data');
  const approvedPath = path.join(dataDir, 'screenshot-run.json');
  const previous = isFile(approvedPath) ? JSON.parse(fs.readFileSync(approvedPath, 'utf8')) : null;
  const previousEnvironment = environmentSignature(previous && previous.environment);
  const nextEnvironment = environmentSignature(manifest.environment);
  if (previousEnvironment && nextEnvironment && previousEnvironment !== nextEnvironment) {
    throw new Error('Частичная пересъёмка выполнена в другом окружении. Экран, viewport, DPR, User-Agent и режим браузера должны совпадать.');
  }
  fs.mkdirSync(evidenceDir, { recursive: true });
  const promoted = [];
  const backedUp = [];
  const incomingIds = new Set(manifest.cases.map(testCase => testCase.id));
  const incomingNames = new Set(validation.files.map(item => item.name));
  const preservedCases = (previous?.cases || []).filter(testCase => !incomingIds.has(testCase.id));
  for (const preserved of preservedCases) {
    try {
      validatePreservedCase(evidenceDir, dataDir, preserved);
    } catch (error) {
      throw new Error(`Частичное подтверждение заблокировано: ${error.message}`);
    }
  }

  for (const oldCase of previous?.cases || []) {
    if (!incomingIds.has(oldCase.id)) continue;
    for (const oldName of [oldCase.file, ...(oldCase.extraFiles || [])].filter(Boolean)) {
      if (incomingNames.has(path.basename(oldName))) continue;
      const stale = path.join(evidenceDir, path.basename(oldName));
      if (!fs.existsSync(stale)) continue;
      fs.mkdirSync(backupDir, { recursive: true });
      fs.renameSync(stale, path.join(backupDir, path.basename(stale)));
      backedUp.push(stale);
    }
    if (oldCase.accessibility?.artifact && !manifest.cases.find(testCase => testCase.id === oldCase.id)?.accessibility) {
      const staleAccessibility = inside(dataDir, oldCase.accessibility.artifact);
      if (fs.existsSync(staleAccessibility)) {
        fs.mkdirSync(backupDir, { recursive: true });
        fs.renameSync(staleAccessibility, path.join(backupDir, `accessibility-${oldCase.id}.json`));
        backedUp.push(staleAccessibility);
      }
    }
  }

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

  const accessibilityDir = path.join(dataDir, 'accessibility');
  for (const item of validation.accessibilityFiles || []) {
    fs.mkdirSync(accessibilityDir, { recursive: true });
    const destination = path.join(accessibilityDir, item.name);
    if (fs.existsSync(destination)) {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.renameSync(destination, path.join(backupDir, `accessibility-${item.name}`));
      backedUp.push(destination);
    }
    const temp = destination + '.tmp';
    fs.copyFileSync(item.file, temp);
    fs.renameSync(temp, destination);
    promoted.push(destination);
  }

  const incomingCases = manifest.cases.map(testCase => ({
      ...testCase,
      file: testCase.file ? path.basename(testCase.file) : testCase.file,
      extraFiles: (testCase.extraFiles || []).map(reference => path.basename(reference)),
      ...(testCase.accessibility ? {
        accessibility: { ...testCase.accessibility, artifact: `accessibility/${testCase.id}.json` }
      } : {}),
      sourceRunId: runId,
      sourceApprovedAt: now.toISOString()
    }));
  const cases = [...preservedCases, ...incomingCases]
    .sort((left, right) => left.id.localeCompare(right.id, 'ru'));
  const previousSourceRuns = previous?.approval?.sourceRuns?.length
    ? previous.approval.sourceRuns
    : (previous?.runId ? [previous.runId] : []);
  const sourceRuns = [...new Set([...previousSourceRuns, runId])];
  const approved = {
    ...manifest,
    requestedCaseIds: [...new Set([...(previous?.requestedCaseIds || []), ...(manifest.requestedCaseIds || [])])]
      .sort((left, right) => left.localeCompare(right, 'ru')),
    cases,
    status: validation.warnings.length ? 'approved-with-warnings' : 'approved',
    warnings: validation.warnings,
    approval: {
      status: 'approved', approvedAt: now.toISOString(), runId,
      revision: ((previous?.approval && previous.approval.revision) || 0) + 1,
      sourceRuns
    }
  };
  fs.mkdirSync(dataDir, { recursive: true });
  const approvedTemp = approvedPath + '.tmp';
  fs.writeFileSync(approvedTemp, JSON.stringify(approved, null, 2) + '\n', 'utf8');
  fs.renameSync(approvedTemp, approvedPath);
  return {
    promoted, backedUp, backupDir: backedUp.length ? backupDir : null,
    warnings: validation.warnings, revision: approved.approval.revision
  };
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
