const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  detectRunner,
  normalizeConfig,
  pngDimensions,
  validateRun,
  promoteRun
} = require('./functional-core');
const { functionalLaunchOptions, resolveFunctionalProfile, liveSmokePrerequisites, goto: gotoWithRetry } = require('./pw-env');

test('live smoke prerequisite check skips missing Playwright or browser and accepts both', () => {
  const missingPlaywright = liveSmokePrerequisites({
    requirePlaywrightFn: () => { throw new Error('module missing'); },
    findBrowserFn: () => 'unused'
  });
  assert.deepEqual(missingPlaywright, { available: false, reason: 'playwright', detail: 'module missing' });

  const missingBrowser = liveSmokePrerequisites({
    requirePlaywrightFn: () => ({}),
    findBrowserFn: () => null
  });
  assert.deepEqual(missingBrowser, { available: false, reason: 'browser', detail: 'Chromium/Chrome executable not found' });

  const ready = liveSmokePrerequisites({
    requirePlaywrightFn: () => ({}),
    findBrowserFn: () => 'C:\\Browser\\chrome.exe'
  });
  assert.deepEqual(ready, { available: true, reason: null, browser: 'C:\\Browser\\chrome.exe' });
});

function pngHeader(width, height, tail = '') {
  const buffer = Buffer.alloc(33 + Buffer.byteLength(tail));
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 4, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 2;
  buffer.write(tail, 33);
  return buffer;
}

function writeSimpleRun(project, runId, ids) {
  const runDir = path.join(project, '.evidence-runs', runId);
  const shots = path.join(runDir, 'screenshots');
  fs.mkdirSync(shots, { recursive: true });
  const cases = ids.map(id => {
    const buffer = pngHeader(900, 700, `${runId}-${id}`);
    fs.writeFileSync(path.join(shots, `${id}.png`), buffer);
    return {
      id, status: 'captured', file: `screenshots/${id}.png`, extraFiles: [],
      image: { width: 900, height: 700 },
      sha256: crypto.createHash('sha256').update(buffer).digest('hex')
    };
  });
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, runner: 'functional-screenshots', requestedCaseIds: ids, cases
  }, null, 2));
}

function baseConfig() {
  return {
    schemaVersion: 2,
    runner: 'functional-screenshots',
    baseUrl: 'https://example.test/',
    evidencePolicy: 'all',
    browser: {
      mode: 'launch',
      windowState: 'maximized',
      expectedScreen: { width: 1920, height: 1080 }
    },
    capture: {
      mode: 'viewport',
      scroll: 'top',
      scale: 'css',
      animations: 'disabled',
      stableFrames: 2
    },
    readiness: {
      readySelector: 'body',
      timeoutMs: 45000,
      fonts: true,
      visibleImages: true
    },
    cases: [{ id: 'TC-001', startUrl: '/', steps: [], ready: { selector: 'body' } }]
  };
}

test('detectRunner keeps legacy UI configs backward compatible', () => {
  assert.equal(detectRunner({ cases: [{ id: 'TC-001', check: 'hover' }] }), 'legacy-ui');
  assert.equal(detectRunner(baseConfig()), 'functional-screenshots');
});

test('normalizeConfig applies functional defaults without changing the display standard', () => {
  const config = baseConfig();
  delete config.capture;
  delete config.readiness;
  const normalized = normalizeConfig(config);
  assert.deepEqual(normalized.browser.expectedScreen, { width: 1920, height: 1080 });
  assert.equal(normalized.capture.mode, 'viewport');
  assert.equal(normalized.capture.scroll, 'top');
  assert.equal(normalized.capture.stableFrames, 2);
  assert.equal(normalized.readiness.readySelector, 'body');
  assert.equal(normalized.navigation.attempts, 3);
  assert.equal(normalized.navigation.networkIdleTimeoutMs, 3000);
  assert.equal(normalized.diagnostics.trace, 'off');
});

test('normalizeConfig rejects duplicate Case IDs and unsafe arbitrary JavaScript actions', () => {
  const duplicate = baseConfig();
  duplicate.cases.push({ id: 'TC-001', startUrl: '/', steps: [] });
  assert.throws(() => normalizeConfig(duplicate), /повторяется/i);

  const unsafe = baseConfig();
  unsafe.cases[0].steps = [{ action: 'evaluate', script: 'window.stop()' }];
  assert.throws(() => normalizeConfig(unsafe), /не поддерживается/i);
});

test('normalizeConfig validates safe coordinate clicks', () => {
  const configured = baseConfig();
  configured.cases[0].steps = [{ action: 'clickAt', x: 370, y: 220 }];
  assert.equal(normalizeConfig(configured).cases[0].steps[0].x, 370);

  configured.cases[0].steps[0].x = -1;
  assert.throws(() => normalizeConfig(configured), /clickAt/i);
});

test('normalizeConfig accepts declarative state waits and assertions', () => {
  const configured = baseConfig();
  configured.cases[0].stateGroup = 'favorites';
  configured.cases[0].steps = [
    { action: 'waitForText', selector: '#counter', value: '1' },
    { action: 'waitForCount', selector: '.card', value: 1 },
    { action: 'waitForAttribute', selector: '#counter', name: 'data-state', value: 'ready' },
    { action: 'waitForHidden', selector: '.spinner' },
    { action: 'assertUrl', value: '/favorites', exact: false },
    { action: 'assertText', selector: '#counter', value: '1', exact: true },
    { action: 'assertCount', selector: '.card', value: 1 }
  ];
  configured.cases[0].capture = { contextSelector: 'header' };
  const normalized = normalizeConfig(configured);
  assert.equal(normalized.cases[0].steps.length, 7);
  assert.equal(normalized.cases[0].stateGroup, 'favorites');
  assert.equal(normalized.cases[0].capture.contextSelector, 'header');

  configured.cases[0].capture.contextSelector = false;
  assert.equal(normalizeConfig(configured).cases[0].capture.contextSelector, false);

  configured.cases[0].steps[1].value = -1;
  assert.throws(() => normalizeConfig(configured), /waitForCount/i);
});

test('goto retries a transient navigation failure and reports attempts', async () => {
  let attempts = 0;
  const page = {
    goto: async () => {
      attempts++;
      if (attempts === 1) throw new Error('net::ERR_TIMED_OUT');
      return { status: () => 200 };
    },
    title: async () => 'Готово',
    waitForLoadState: async () => {},
    waitForTimeout: async () => {}
  };
  const result = await gotoWithRetry(page, 'https://example.test/', {
    attempts: 2, timeout: 1000, retryDelayMs: 0, networkIdleTimeoutMs: 0
  });
  assert.equal(result.attempts, 2);
  assert.equal(result.status, 200);
});

test('normalizeConfig validates anchor scrolling parameters', () => {
  const missingAnchor = baseConfig();
  missingAnchor.cases[0].capture = { scroll: 'anchor' };
  assert.throws(() => normalizeConfig(missingAnchor), /anchor/i);

  const invalidOffset = baseConfig();
  invalidOffset.cases[0].capture = { scroll: 'anchor', anchor: '#content', anchorOffsetPx: -1 };
  assert.throws(() => normalizeConfig(invalidOffset), /anchorOffsetPx/i);
});

test('maximized launch uses the native viewport while fixed launch pins DPR and screen', () => {
  const maximized = functionalLaunchOptions(baseConfig(), 'chrome.exe', 'profile', false);
  assert.equal(maximized.viewport, null);
  assert.equal('deviceScaleFactor' in maximized, false);
  assert.equal('screen' in maximized, false);
  assert.ok(maximized.args.includes('--start-maximized'));

  const fixedConfig = baseConfig();
  fixedConfig.browser.windowState = 'fixed';
  fixedConfig.browser.viewport = { width: 900, height: 700 };
  fixedConfig.browser.expectedScreen = { width: 900, height: 700 };
  const fixed = functionalLaunchOptions(fixedConfig, 'chrome.exe', 'profile', true);
  assert.deepEqual(fixed.viewport, { width: 900, height: 700 });
  assert.deepEqual(fixed.screen, { width: 900, height: 700 });
  assert.equal(fixed.deviceScaleFactor, 1);
});

test('launch mode resolves the persistent profile from the project config', () => {
  const root = path.join('D:', 'QA', 'project');
  const configured = baseConfig();
  configured.browser.profile = '.chrome-qa-profile';
  assert.equal(resolveFunctionalProfile(configured, root), path.resolve(root, '.chrome-qa-profile'));

  delete configured.browser.profile;
  assert.equal(resolveFunctionalProfile(configured, root), path.resolve(root, '.browser-profile'));
});

test('pngDimensions reads the CSS-sized viewport from a PNG header', () => {
  assert.deepEqual(pngDimensions(pngHeader(1913, 907)), { width: 1913, height: 907 });
  assert.throws(() => pngDimensions(Buffer.from('not png')), /PNG/i);
});

test('validateRun fails mixed viewport sizes and exact duplicate primary screenshots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-evidence-run-'));
  const shots = path.join(root, 'screenshots');
  fs.mkdirSync(shots);
  const a = pngHeader(1913, 907, 'same');
  const b = pngHeader(1913, 906, 'different');
  fs.writeFileSync(path.join(shots, 'TC-001.png'), a);
  fs.writeFileSync(path.join(shots, 'TC-002.png'), a);
  fs.writeFileSync(path.join(shots, 'TC-003.png'), b);
  const manifest = {
    schemaVersion: 1,
    runner: 'functional-screenshots',
    status: 'captured',
    requestedCaseIds: ['TC-001', 'TC-002', 'TC-003'],
    cases: [
      { id: 'TC-001', status: 'captured', file: 'screenshots/TC-001.png' },
      { id: 'TC-002', status: 'captured', file: 'screenshots/TC-002.png' },
      { id: 'TC-003', status: 'captured', file: 'screenshots/TC-003.png' }
    ]
  };
  const result = validateRun(root, manifest);
  assert.ok(result.errors.some(error => /размер/i.test(error)));
  assert.ok(result.errors.some(error => /TC-001.*TC-002|TC-002.*TC-001/.test(error)));

  fs.writeFileSync(path.join(shots, 'TC-002-1-before.png'), b);
  manifest.cases[1].extraFiles = ['screenshots/TC-002-1-before.png'];
  const explained = validateRun(root, manifest);
  assert.ok(explained.errors.some(error => /TC-001.*TC-002|TC-002.*TC-001/.test(error)));
});

test('validateRun allows different fullPage heights and differently sized detail frames', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-evidence-fullpage-'));
  const shots = path.join(root, 'screenshots');
  fs.mkdirSync(shots);
  const one = pngHeader(1200, 1800, 'one');
  const two = pngHeader(1200, 2400, 'two');
  const detail = pngHeader(900, 700, 'detail');
  fs.writeFileSync(path.join(shots, 'TC-001.png'), one);
  fs.writeFileSync(path.join(shots, 'TC-002.png'), two);
  fs.writeFileSync(path.join(shots, 'TC-002-2-detail.png'), detail);
  const manifest = {
    runner: 'functional-screenshots', requestedCaseIds: ['TC-001', 'TC-002'],
    config: { capture: { mode: 'fullPage' } },
    cases: [
      {
        id: 'TC-001', status: 'captured', file: 'screenshots/TC-001.png', captureMode: 'fullPage',
        viewport: { width: 1200, height: 800 }, image: { width: 1200, height: 1800 }
      },
      {
        id: 'TC-002', status: 'captured', file: 'screenshots/TC-002.png', captureMode: 'fullPage',
        viewport: { width: 1200, height: 800 }, image: { width: 1200, height: 2400 },
        extraFiles: ['screenshots/TC-002-2-detail.png']
      }
    ]
  };
  const result = validateRun(root, manifest);
  assert.deepEqual(result.errors, []);
});

test('normalizeConfig validates declarative proof overlays', () => {
  const configured = baseConfig();
  configured.cases[0].capture = {
    proof: {
      title: 'TC-001 · проверяемый результат',
      position: 'bottom-right',
      highlights: ['header'],
      metrics: [
        { type: 'page-overflow', label: 'Переполнение' },
        { type: 'element-state', selector: '#menu', label: 'Меню' }
      ]
    }
  };
  assert.equal(normalizeConfig(configured).cases[0].capture.proof.metrics.length, 2);

  const unsafe = baseConfig();
  unsafe.cases[0].capture = { proof: { title: 'Проверка', metrics: [{ type: 'javascript', script: 'alert(1)' }] } };
  assert.throws(() => normalizeConfig(unsafe), /не поддерживается/i);
});

test('normalizeConfig validates primary capture selection', () => {
  const configured = baseConfig();
  configured.cases[0].steps = [{
    action: 'waitForSelector', selector: 'body', captureAfter: 'result',
    captureProof: { title: 'Результат' }
  }];
  configured.cases[0].primaryCaptureAfter = 'result';
  assert.equal(normalizeConfig(configured).cases[0].primaryCaptureAfter, 'result');

  configured.cases[0].primaryCaptureAfter = 'missing';
  assert.throws(() => normalizeConfig(configured), /primaryCaptureAfter/i);
});

test('normalizeConfig validates a declarative capture anchor for intermediate states', () => {
  const configured = baseConfig();
  configured.cases[0].steps = [{
    action: 'waitForSelector', selector: '#result', captureAfter: 'result',
    captureAnchor: '#result', captureProof: { title: 'Результат' }
  }];
  assert.equal(normalizeConfig(configured).cases[0].steps[0].captureAnchor, '#result');
  configured.cases[0].steps[0].captureAnchor = '';
  assert.throws(() => normalizeConfig(configured), /captureAnchor/i);
});

test('promoteRun backs up and replaces only cases from the approved run', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-evidence-project-'));
  const runId = '20260803-120000-test';
  const runDir = path.join(project, '.evidence-runs', runId);
  const shots = path.join(runDir, 'screenshots');
  const evidence = path.join(project, 'evidence');
  fs.mkdirSync(shots, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  const oldOne = pngHeader(1913, 907, 'old-one');
  const oldTwo = pngHeader(1913, 907, 'old-two');
  const newOne = pngHeader(1913, 907, 'new-one');
  const transition = pngHeader(1913, 907, 'transition');
  fs.writeFileSync(path.join(evidence, 'TC-001.png'), oldOne);
  fs.writeFileSync(path.join(evidence, 'TC-002.png'), oldTwo);
  fs.writeFileSync(path.join(shots, 'TC-001.png'), newOne);
  fs.writeFileSync(path.join(shots, 'TC-001-1-returned.png'), transition);
  const manifest = {
    schemaVersion: 1,
    runner: 'functional-screenshots',
    status: 'clean',
    requestedCaseIds: ['TC-001'],
    cases: [{
      id: 'TC-001', status: 'captured', file: 'screenshots/TC-001.png',
      sha256: crypto.createHash('sha256').update(newOne).digest('hex'),
      viewport: { width: 1913, height: 907 }, extraFiles: ['screenshots/TC-001-1-returned.png']
    }]
  };
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const result = promoteRun(project, runId, { now: new Date('2026-08-03T12:34:56Z') });
  assert.equal(result.promoted.length, 2);
  assert.deepEqual(fs.readFileSync(path.join(evidence, 'TC-001.png')), newOne);
  assert.deepEqual(fs.readFileSync(path.join(evidence, 'TC-002.png')), oldTwo);
  assert.deepEqual(fs.readFileSync(path.join(evidence, 'TC-001-1-returned.png')), transition);
  assert.ok(fs.existsSync(path.join(project, '.evidence-backups', '20260803-123456', 'TC-001.png')));
  const approved = JSON.parse(fs.readFileSync(path.join(evidence, 'data', 'screenshot-run.json'), 'utf8'));
  assert.equal(approved.approval.status, 'approved');
  assert.equal(approved.approval.revision, 1);
  assert.deepEqual(approved.approval.sourceRuns, [runId]);
  assert.equal(approved.cases[0].sourceRunId, runId);
  assert.equal(approved.cases[0].file, 'TC-001.png');
  assert.deepEqual(approved.cases[0].extraFiles, ['TC-001-1-returned.png']);
});

test('promoteRun merges a partial recapture, removes stale extras and preserves lineage', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-evidence-revision-'));
  const environment = {
    screen: { width: 1920, height: 1080 }, initialViewport: { width: 1920, height: 897 },
    devicePixelRatio: 1, userAgent: 'Chrome/151', browserMode: 'launch', headless: false
  };
  const writeRun = (runId, cases) => {
    const runDir = path.join(project, '.evidence-runs', runId);
    const shots = path.join(runDir, 'screenshots');
    fs.mkdirSync(shots, { recursive: true });
    const manifestCases = cases.map(item => {
      const primary = pngHeader(1920, 897, `${runId}-${item.id}`);
      fs.writeFileSync(path.join(shots, `${item.id}.png`), primary);
      const extraFiles = [];
      if (item.extra) {
        const extra = pngHeader(1920, 897, `${runId}-${item.id}-extra`);
        const name = `${item.id}-2-detail.png`;
        fs.writeFileSync(path.join(shots, name), extra);
        extraFiles.push(`screenshots/${name}`);
      }
      return {
        id: item.id, status: 'captured', file: `screenshots/${item.id}.png`,
        sha256: crypto.createHash('sha256').update(primary).digest('hex'),
        viewport: { width: 1920, height: 897 }, extraFiles
      };
    });
    fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, runner: 'functional-screenshots', runId, status: 'clean', environment,
      requestedCaseIds: manifestCases.map(item => item.id), cases: manifestCases
    }, null, 2));
  };

  writeRun('20260803-120000-full', [{ id: 'TC-001' }, { id: 'TC-002', extra: true }]);
  promoteRun(project, '20260803-120000-full', { now: new Date('2026-08-03T12:00:00Z') });
  writeRun('20260803-130000-partial', [{ id: 'TC-002' }]);
  const result = promoteRun(project, '20260803-130000-partial', { now: new Date('2026-08-03T13:00:00Z') });

  const evidence = path.join(project, 'evidence');
  const approved = JSON.parse(fs.readFileSync(path.join(evidence, 'data', 'screenshot-run.json'), 'utf8'));
  assert.deepEqual(approved.cases.map(item => item.id), ['TC-001', 'TC-002']);
  assert.equal(approved.cases[0].sourceRunId, '20260803-120000-full');
  assert.equal(approved.cases[1].sourceRunId, '20260803-130000-partial');
  assert.equal(approved.approval.revision, 2);
  assert.deepEqual(approved.approval.sourceRuns, ['20260803-120000-full', '20260803-130000-partial']);
  assert.ok(!fs.existsSync(path.join(evidence, 'TC-002-2-detail.png')));
  assert.ok(result.backedUp.some(file => file.endsWith('TC-002-2-detail.png')));

  writeRun('20260803-140000-mismatch', [{ id: 'TC-002' }]);
  const mismatchedPath = path.join(project, '.evidence-runs', '20260803-140000-mismatch', 'manifest.json');
  const mismatched = JSON.parse(fs.readFileSync(mismatchedPath, 'utf8'));
  mismatched.environment.initialViewport.width = 1280;
  fs.writeFileSync(mismatchedPath, JSON.stringify(mismatched, null, 2));
  assert.throws(
    () => promoteRun(project, '20260803-140000-mismatch', { now: new Date('2026-08-03T14:00:00Z') }),
    /другом окружении/i
  );
});

test('partial promotion rejects a missing preserved primary artifact', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-evidence-preserved-missing-'));
  writeSimpleRun(project, '20260804-100000-full', ['TC-001', 'TC-002']);
  promoteRun(project, '20260804-100000-full');
  fs.unlinkSync(path.join(project, 'evidence', 'TC-002.png'));
  writeSimpleRun(project, '20260804-110000-partial', ['TC-001']);
  assert.throws(() => promoteRun(project, '20260804-110000-partial'), /сохранённый основной PNG отсутствует/i);
});

test('partial promotion rejects a tampered preserved accessibility artifact', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-evidence-preserved-axe-'));
  writeSimpleRun(project, '20260804-120000-full', ['TC-001', 'TC-002']);
  promoteRun(project, '20260804-120000-full');
  const dataDir = path.join(project, 'evidence', 'data');
  const axeDir = path.join(dataDir, 'accessibility');
  fs.mkdirSync(axeDir, { recursive: true });
  const artifact = { engine: { name: 'axe-core', version: '4.12.1' }, counts: { violations: 0 }, manual_review_required: false };
  const content = JSON.stringify(artifact) + '\n';
  fs.writeFileSync(path.join(axeDir, 'TC-002.json'), content);
  const approvedPath = path.join(dataDir, 'screenshot-run.json');
  const approved = JSON.parse(fs.readFileSync(approvedPath, 'utf8'));
  approved.cases.find(item => item.id === 'TC-002').accessibility = {
    artifact: 'accessibility/TC-002.json', engine: artifact.engine, counts: artifact.counts,
    sha256: crypto.createHash('sha256').update(content).digest('hex')
  };
  fs.writeFileSync(approvedPath, JSON.stringify(approved, null, 2));
  fs.appendFileSync(path.join(axeDir, 'TC-002.json'), 'tampered');
  writeSimpleRun(project, '20260804-130000-partial', ['TC-001']);
  assert.throws(() => promoteRun(project, '20260804-130000-partial'), /accessibility artifact изменён/i);
});

test('promotion rejects traversal in stale accessibility artifact path', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-evidence-axe-traversal-'));
  writeSimpleRun(project, '20260804-140000-full', ['TC-001']);
  promoteRun(project, '20260804-140000-full');
  const approvedPath = path.join(project, 'evidence', 'data', 'screenshot-run.json');
  const approved = JSON.parse(fs.readFileSync(approvedPath, 'utf8'));
  approved.cases[0].accessibility = { artifact: '../../outside.json' };
  fs.writeFileSync(approvedPath, JSON.stringify(approved, null, 2));
  writeSimpleRun(project, '20260804-150000-partial', ['TC-001']);
  assert.throws(() => promoteRun(project, '20260804-150000-partial'), /Путь выходит за каталог прогона/i);
});
