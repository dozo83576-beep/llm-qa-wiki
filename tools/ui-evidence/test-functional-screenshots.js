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
const { functionalLaunchOptions, resolveFunctionalProfile } = require('./pw-env');

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
});

test('normalizeConfig rejects duplicate Case IDs and unsafe arbitrary JavaScript actions', () => {
  const duplicate = baseConfig();
  duplicate.cases.push({ id: 'TC-001', startUrl: '/', steps: [] });
  assert.throws(() => normalizeConfig(duplicate), /повторяется/i);

  const unsafe = baseConfig();
  unsafe.cases[0].steps = [{ action: 'evaluate', script: 'window.stop()' }];
  assert.throws(() => normalizeConfig(unsafe), /не поддерживается/i);
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

test('validateRun fails mixed viewport sizes and warns about exact duplicates', () => {
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
  assert.ok(result.warnings.some(warning => /TC-001.*TC-002|TC-002.*TC-001/.test(warning)));

  fs.writeFileSync(path.join(shots, 'TC-002-1-before.png'), b);
  manifest.cases[1].extraFiles = ['screenshots/TC-002-1-before.png'];
  const explained = validateRun(root, manifest);
  assert.ok(!explained.warnings.some(warning => /TC-001.*TC-002|TC-002.*TC-001/.test(warning)));
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
  assert.equal(approved.cases[0].file, 'TC-001.png');
  assert.deepEqual(approved.cases[0].extraFiles, ['TC-001-1-returned.png']);
});
