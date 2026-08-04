const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const AXE_VERSION = '4.12.1';
const AXE_ERROR_PREFIX = 'AXE_';
const ACCESSIBILITY_KEYS = new Set(['enabled', 'tags', 'rules', 'include', 'exclude']);
const RULE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function axeError(code, message) {
  const error = new Error(message);
  error.code = `${AXE_ERROR_PREFIX}${code}`;
  return error;
}

function stringList(value, label, pattern = null) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item =>
    typeof item !== 'string' || !item.trim() || item.length > 512 || (pattern && !pattern.test(item)))) {
    throw new Error(`${label} должен быть массивом непустых безопасных строк.`);
  }
  return [...new Set(value.map(item => item.trim()))];
}

function normalizeAccessibility(value, label = 'checks.accessibility') {
  if (value === undefined || value === false || value === null) return null;
  if (value === true) return { enabled: true, tags: [], rules: {}, include: [], exclude: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} должен быть boolean или объектом.`);
  }
  for (const key of Object.keys(value)) {
    if (!ACCESSIBILITY_KEYS.has(key)) throw new Error(`${label}.${key} не поддерживается.`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error(`${label}.enabled должен быть boolean.`);
  }
  if (value.enabled === false) return null;
  const tags = stringList(value.tags, `${label}.tags`, /^[a-zA-Z0-9._-]+$/) || [];
  const include = stringList(value.include, `${label}.include`) || [];
  const exclude = stringList(value.exclude, `${label}.exclude`) || [];
  const rawRules = value.rules || {};
  if (!rawRules || typeof rawRules !== 'object' || Array.isArray(rawRules)) {
    throw new Error(`${label}.rules должен быть объектом rule-id -> boolean.`);
  }
  const rules = {};
  for (const [id, setting] of Object.entries(rawRules)) {
    if (!RULE_ID_RE.test(id) || id.length > 128 || typeof setting !== 'boolean') {
      throw new Error(`${label}.rules должен содержать только безопасные rule-id и boolean.`);
    }
    rules[id] = { enabled: setting };
  }
  return { enabled: true, tags, rules, include, exclude };
}

function mergeAccessibility(globalValue, caseValue, label = 'checks.accessibility') {
  const globalConfig = normalizeAccessibility(globalValue, 'checks.accessibility');
  if (caseValue === false || caseValue === null) return null;
  if (caseValue === undefined || caseValue === true) {
    return caseValue === true && !globalConfig
      ? normalizeAccessibility(true, label)
      : globalConfig;
  }
  const local = normalizeAccessibility(caseValue, label);
  if (!local) return null;
  return {
    enabled: true,
    tags: caseValue.tags === undefined ? (globalConfig?.tags || []) : local.tags,
    rules: { ...(globalConfig?.rules || {}), ...local.rules },
    include: caseValue.include === undefined ? (globalConfig?.include || []) : local.include,
    exclude: caseValue.exclude === undefined ? (globalConfig?.exclude || []) : local.exclude
  };
}

function resolveLocalAxe(root = __dirname) {
  const packageFile = path.join(root, 'node_modules', 'axe-core', 'package.json');
  const scriptFile = path.join(root, 'node_modules', 'axe-core', 'axe.min.js');
  if (!fs.existsSync(packageFile) || !fs.existsSync(scriptFile)) {
    throw axeError('DEPENDENCY_MISSING',
      `Accessibility check включён, но локальный axe-core ${AXE_VERSION} не найден в tools/ui-evidence/node_modules. Выполни npm ci --prefix tools/ui-evidence.`);
  }
  let packageData;
  try {
    packageData = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  } catch (error) {
    throw axeError('DEPENDENCY_INVALID', `Не удалось прочитать локальный axe-core: ${error.message}`);
  }
  if (packageData.version !== AXE_VERSION) {
    throw axeError('VERSION_MISMATCH', `Нужен локальный axe-core ${AXE_VERSION}, найден ${packageData.version || 'unknown'}.`);
  }
  const integrityFile = path.join(root, 'axe-integrity.json');
  let integrity;
  try {
    integrity = JSON.parse(fs.readFileSync(integrityFile, 'utf8'));
  } catch (error) {
    throw axeError('INTEGRITY_METADATA', `Не удалось прочитать axe-integrity.json: ${error.message}`);
  }
  if (integrity.name !== 'axe-core' || integrity.version !== AXE_VERSION ||
      !/^[a-f0-9]{64}$/.test(integrity.axeMinSha256 || '')) {
    throw axeError('INTEGRITY_METADATA', 'axe-integrity.json не соответствует закреплённому axe-core 4.12.1.');
  }
  const sourceBuffer = fs.readFileSync(scriptFile);
  const actualSha256 = crypto.createHash('sha256').update(sourceBuffer).digest('hex');
  if (actualSha256 !== integrity.axeMinSha256) {
    throw axeError('INTEGRITY_MISMATCH', `SHA-256 локального axe.min.js не совпадает с tracked metadata: ${actualSha256}.`);
  }
  return {
    version: packageData.version,
    scriptFile,
    source: sourceBuffer.toString('utf8'),
    sha256: actualSha256,
    packageIntegrity: integrity.packageIntegrity || null
  };
}

function axeRunInput(config) {
  const context = {};
  if (config.include.length) context.include = config.include.map(selector => [selector]);
  if (config.exclude.length) context.exclude = config.exclude.map(selector => [selector]);
  const options = { resultTypes: ['violations', 'incomplete', 'passes', 'inapplicable'] };
  if (config.tags.length) options.runOnly = { type: 'tag', values: config.tags };
  if (Object.keys(config.rules).length) options.rules = config.rules;
  return { context: Object.keys(context).length ? context : null, options };
}

function preflightAccessibility(cases, resolveFn = resolveLocalAxe) {
  return (cases || []).some(testCase => testCase.checks && testCase.checks.accessibility)
    ? resolveFn()
    : null;
}

function redactText(value) {
  return String(value || '')
    .replace(/\b(authorization\s*:\s*(?:bearer|basic)|cookie\s*:)[^\r\n]+/gi, '$1 [redacted]')
    .replace(/([?&](?:access_token|authorization|auth|code|cookie|email|id_token|password|phone|refresh_token|state|token|username)=)[^&\s"'<>]+/gi, '$1[redacted]')
    .replace(/\b(access_token|id_token|password|refresh_token|token)\s*[:=]\s*[^\s,;"'<>]+/gi, '$1=[redacted]')
    .replace(/\b(cookie)\s*=\s*[^\s,;"'<>]+/gi, '$1=[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, '[redacted-phone]');
}

function compactFinding(item) {
  return {
    id: item.id,
    impact: item.impact || null,
    tags: Array.isArray(item.tags) ? item.tags : [],
    description: item.description || '',
    help: item.help || '',
    helpUrl: item.helpUrl || '',
    nodes: (item.nodes || []).map(node => ({
      impact: node.impact || null,
      targetFingerprint: crypto.createHash('sha256')
        .update(JSON.stringify(node.target || []))
        .digest('hex')
    }))
  };
}

function normalizeAxeResult(raw, config, expectedVersion = AXE_VERSION) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.violations) || !Array.isArray(raw.incomplete)) {
    throw axeError('RESULT_INVALID', 'axe.run вернул некорректный результат.');
  }
  const engineVersion = raw.testEngine && raw.testEngine.version;
  if (engineVersion && engineVersion !== expectedVersion) {
    throw axeError('VERSION_MISMATCH', `axe.run сообщил версию ${engineVersion}, ожидалась ${expectedVersion}.`);
  }
  const violations = raw.violations.map(compactFinding);
  const incomplete = raw.incomplete.map(compactFinding);
  return {
    schemaVersion: 1,
    check: 'accessibility',
    engine: { name: 'axe-core', version: engineVersion || expectedVersion },
    applied: {
      tags: config.tags,
      rules: Object.fromEntries(Object.entries(config.rules).map(([id, setting]) => [id, setting.enabled])),
      include: config.include,
      exclude: config.exclude
    },
    limitations: [
      'Автоматическая проверка не доказывает соответствие WCAG.',
      'Нарушения и неполные результаты требуют интерпретации человеком и не меняют QA verdict автоматически.'
    ],
    manual_review_required: incomplete.length > 0,
    counts: {
      violations: violations.length,
      violationNodes: violations.reduce((sum, item) => sum + item.nodes.length, 0),
      incomplete: incomplete.length,
      incompleteNodes: incomplete.reduce((sum, item) => sum + item.nodes.length, 0),
      passes: Array.isArray(raw.passes) ? raw.passes.length : 0,
      inapplicable: Array.isArray(raw.inapplicable) ? raw.inapplicable.length : 0
    },
    violations,
    incomplete
  };
}

function writeAxeArtifact(runDir, caseId, artifact) {
  const directory = path.join(runDir, 'accessibility');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${caseId}.json`);
  const content = JSON.stringify(artifact, null, 2) + '\n';
  fs.writeFileSync(file, content, 'utf8');
  return {
    artifact: path.relative(runDir, file).replace(/\\/g, '/'),
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    engine: artifact.engine,
    applied: artifact.applied,
    counts: artifact.counts,
    violations: artifact.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.length })),
    incomplete: artifact.incomplete.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.length })),
    manual_review_required: artifact.manual_review_required,
    verdict_policy: 'human_only'
  };
}

async function runAxe(page, config, dependency, runDir, caseId) {
  try {
    await page.addScriptTag({ content: dependency.source });
    const input = axeRunInput(config);
    const raw = await page.evaluate(async ({ context, options }) => {
      if (!globalThis.axe || typeof globalThis.axe.run !== 'function') throw new Error('axe.run недоступен после инъекции.');
      return globalThis.axe.run(context || document, options);
    }, input);
    return writeAxeArtifact(runDir, caseId, normalizeAxeResult(raw, config, dependency.version));
  } catch (error) {
    if (String(error.code || '').startsWith(AXE_ERROR_PREFIX)) throw error;
    throw axeError('ENGINE', `Ошибка axe-core для ${caseId}: ${error.message.split('\n')[0]}`);
  }
}

module.exports = {
  AXE_VERSION,
  AXE_ERROR_PREFIX,
  normalizeAccessibility,
  mergeAccessibility,
  resolveLocalAxe,
  axeRunInput,
  preflightAccessibility,
  normalizeAxeResult,
  redactText,
  writeAxeArtifact,
  runAxe
};
