const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AXE_VERSION,
  axeRunInput,
  mergeAccessibility,
  normalizeAxeResult,
  preflightAccessibility,
  redactText,
  resolveLocalAxe,
  writeAxeArtifact
} = require('./axe-accessibility');
const { normalizeConfig, validateRun } = require('./functional-core');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'tests', 'fixtures', name), 'utf8'));
const base = {
  schemaVersion: 2,
  runner: 'functional-screenshots',
  baseUrl: 'https://example.test/',
  browser: { mode: 'launch', windowState: 'fixed', viewport: { width: 1, height: 1 }, expectedScreen: { width: 1, height: 1 } },
  capture: { stableFrames: 2 },
  cases: [{ id: 'TC-001', steps: [] }]
};

test('accessibility config safely merges global defaults and case overrides', () => {
  const normalized = normalizeConfig({
    ...base,
    checks: { accessibility: { tags: ['wcag2a'], rules: { 'image-alt': true }, exclude: ['.third-party'] } },
    cases: [{ id: 'TC-001', steps: [], checks: { accessibility: { tags: ['wcag2aa'], include: ['main'] } } }]
  });
  assert.deepEqual(normalized.cases[0].checks.accessibility, {
    enabled: true,
    tags: ['wcag2aa'],
    rules: { 'image-alt': { enabled: true } },
    include: ['main'],
    exclude: ['.third-party']
  });
  assert.throws(() => normalizeConfig({ ...base, checks: { accessibility: { rules: { 'x;alert(1)': true } } } }), /безопасные rule-id/);
  assert.throws(() => mergeAccessibility(undefined, { tags: 'wcag2a' }), /массивом/);
});

test('axe input contains only normalized tags, rules and selector context', () => {
  const config = mergeAccessibility(undefined, {
    tags: ['wcag2a'], rules: { 'image-alt': false }, include: ['main'], exclude: ['.widget']
  });
  assert.deepEqual(axeRunInput(config), {
    context: { include: [['main']], exclude: [['.widget']] },
    options: {
      resultTypes: ['violations', 'incomplete', 'passes', 'inapplicable'],
      runOnly: { type: 'tag', values: ['wcag2a'] },
      rules: { 'image-alt': { enabled: false } }
    }
  });
});

test('known violation remains a human-only signal', () => {
  const result = normalizeAxeResult(fixture('axe-violation.json'), mergeAccessibility(undefined, true));
  assert.equal(result.counts.violations, 1);
  assert.equal(result.counts.violationNodes, 1);
  assert.equal(result.manual_review_required, false);
  assert.match(result.limitations.join(' '), /не доказывает соответствие WCAG/);
});

test('clean fixture reports zero findings without claiming WCAG compliance', () => {
  const result = normalizeAxeResult(fixture('axe-clean.json'), mergeAccessibility(undefined, true));
  assert.deepEqual(result.counts, {
    violations: 0, violationNodes: 0, incomplete: 0, incompleteNodes: 0, passes: 1, inapplicable: 0
  });
  assert.equal(result.engine.version, AXE_VERSION);
  assert.equal(result.limitations.length, 2);
});

test('axe artifacts omit raw HTML and redact sensitive node details', () => {
  const raw = fixture('axe-violation.json');
  raw.violations[0].nodes[0] = {
    impact: 'critical',
    target: ['a[href="/reset?token=secret&email=user@example.test"]'],
    html: '<a data-cookie="session-secret">user@example.test +7 999 123-45-67</a>',
    failureSummary: 'token=secret cookie=session-secret contact user@example.test +7 999 123-45-67'
  };
  const result = normalizeAxeResult(raw, mergeAccessibility(undefined, true));
  const node = result.violations[0].nodes[0];
  assert.equal(Object.prototype.hasOwnProperty.call(node, 'html'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(node, 'target'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(node, 'failureSummary'), false);
  assert.match(node.targetFingerprint, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /secret|user@example|999 123|reset\?|\.label/);
  assert.equal(redactText('password=hunter2'), 'password=[redacted]');
  assert.equal(redactText('Authorization: Bearer abc.def'), 'Authorization: Bearer [redacted]');
  assert.equal(redactText('Authorization: Basic dXNlcjpwYXNz'), 'Authorization: Basic [redacted]');
  assert.equal(redactText('Cookie: session=secret; other=value'), 'Cookie: [redacted]');
});

test('incomplete fixture always requires manual review and is validated from artifact hash', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axe-manifest-'));
  const artifact = normalizeAxeResult(fixture('axe-incomplete.json'), mergeAccessibility(undefined, true));
  const summary = writeAxeArtifact(runDir, 'TC-001', artifact);
  const screenshot = path.join(runDir, 'TC-001.png');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(screenshot, png);
  const manifest = {
    runner: 'functional-screenshots', requestedCaseIds: ['TC-001'],
    cases: [{
      id: 'TC-001', status: 'captured', file: 'TC-001.png', image: { width: 1, height: 1 },
      sha256: crypto.createHash('sha256').update(png).digest('hex'), accessibility: summary
    }]
  };
  const validation = validateRun(runDir, manifest);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.accessibilityFiles.length, 1);
  assert.equal(validation.warnings.length, 1);
  assert.equal(summary.manual_review_required, true);
  assert.equal(summary.verdict_policy, 'human_only');
});

test('missing project-local axe dependency blocks before a browser scan can start', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'axe-missing-'));
  assert.throws(() => resolveLocalAxe(empty), error => error.code === 'AXE_DEPENDENCY_MISSING');
});

test('tampered local axe.min.js is blocked by tracked SHA-256 metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axe-tamper-'));
  const moduleDir = path.join(root, 'node_modules', 'axe-core');
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({ version: AXE_VERSION }));
  fs.writeFileSync(path.join(moduleDir, 'axe.min.js'), 'tampered');
  fs.writeFileSync(path.join(root, 'axe-integrity.json'), JSON.stringify({
    name: 'axe-core', version: AXE_VERSION, axeMinSha256: '0'.repeat(64)
  }));
  assert.throws(() => resolveLocalAxe(root), error => error.code === 'AXE_INTEGRITY_MISMATCH');
});

test('accessibility preflight is pure and resolves dependency before browser or run setup', () => {
  const cases = normalizeConfig({ ...base, checks: { accessibility: true } }).cases;
  const sentinel = { version: AXE_VERSION };
  let calls = 0;
  assert.equal(preflightAccessibility(cases, () => { calls++; return sentinel; }), sentinel);
  assert.equal(calls, 1);
  assert.equal(preflightAccessibility(normalizeConfig(base).cases, () => { throw new Error('not called'); }), null);
});
