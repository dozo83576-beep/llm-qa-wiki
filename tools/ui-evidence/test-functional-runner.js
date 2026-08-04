const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runCapture, checkEnvironment, makeContactSheet, prepareProfile, normalizePageViewport, sanitizeManifestUrl, sanitizeEventUrl } = require('./functional-capture');
const { openFunctional, requirePlaywright, findBrowser } = require('./pw-env');

function page(body, script = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;font-family:Arial;background:white;color:#111}header{height:72px;position:sticky;top:0;background:#f3f3f3;display:flex;align-items:center;padding:0 24px;z-index:2}
    main{padding:24px;min-height:900px}.spacer{height:500px;background:#f7f7f7}.ad{height:90px;background:#ffd9b3}input,select,button,a{margin:8px;padding:8px}
  </style></head><body>${body}<script>${script}</script></body></html>`;
}

async function startServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/second') {
      res.end(page('<main style="background:#e5eef6"><a id="back" href="/">Назад</a><div id="second">Вторая страница</div><div style="height:620px;background:#d8e7f3;margin-top:12px">Содержательная область</div></main>'));
      return;
    }
    if (req.url === '/popup') {
      res.end(page('<main><h1 id="popup">OAuth popup</h1></main>'));
      return;
    }
    if (req.url === '/blank') {
      res.end('<!doctype html><html><body style="margin:0;background:white"></body></html>');
      return;
    }
    if (req.url === '/blank-band') {
      res.end(page('<header id="header">Шапка</header><div style="height:260px"></div><main><h1 id="content-anchor">Содержательная часть</h1><p>Результаты проверки</p></main>'));
      return;
    }
    if (req.url === '/empty-ad') {
      res.end(page('<header id="header">Шапка</header><div class="header-ann" style="height:250px"><div id="ad-slot" style="display:none;height:0"></div></div><main><h1 id="content-anchor">Содержательная часть</h1><p>Результаты проверки</p></main>'));
      return;
    }
    if (req.url === '/challenge') {
      res.end(page('<main><div id="challenge">Проверка</div></main>', `document.title='Just a moment';setTimeout(()=>{document.title='Готово';document.querySelector('#challenge').id='ready'},150)`));
      return;
    }
    if (req.url === '/state') {
      res.end(page(
        '<header id="header">Шапка</header><main><div id="counter" data-state="pending">0</div><div class="spinner">Загрузка</div><div id="cards"></div></main>',
        `setTimeout(()=>{const counter=document.querySelector('#counter');counter.textContent='1';counter.dataset.state='ready';document.querySelector('.spinner').remove();const card=document.createElement('article');card.className='card';card.textContent='Товар';document.querySelector('#cards').append(card)},150)`
      ));
      return;
    }
    res.end(page(
      '<header id="header">Шапка</header><main><input id="query"><select id="year"><option value="">—</option><option value="2020">2020</option></select><input id="agree" type="checkbox"><button id="popup-button">Popup</button><a id="next" href="/second">Дальше</a><div class="spacer"></div><div id="lazy"></div></main>',
      `setTimeout(()=>{const ad=document.createElement('div');ad.id='ad';ad.className='ad';ad.textContent='Реклама загружена';document.querySelector('#lazy').append(ad)},120);document.querySelector('#popup-button').onclick=()=>window.open('/popup','oauth','width=500,height=500')`
    ));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}/`,
    alternateOrigin: `http://localhost:${server.address().port}/`
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForCdp(port) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const request = http.get(`http://127.0.0.1:${port}/json/version`, response => {
          response.resume();
          response.statusCode === 200 ? resolve() : reject(new Error(String(response.statusCode)));
        });
        request.on('error', reject);
      });
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error(`CDP ${port} не открылся`);
}

function config(baseUrl, cases) {
  return {
    schemaVersion: 2,
    runner: 'functional-screenshots',
    baseUrl,
    evidencePolicy: 'all',
    browser: {
      mode: 'launch',
      windowState: 'fixed',
      viewport: { width: 900, height: 700 },
      expectedScreen: { width: 900, height: 700 }
    },
    capture: {
      mode: 'viewport', scroll: 'top', scale: 'css', animations: 'disabled',
      stableFrames: 2, stableIntervalMs: 50, stableTimeoutMs: 4000
    },
    readiness: {
      readySelector: 'body', timeoutMs: 5000, fonts: true, visibleImages: true,
      forbiddenTitle: '(Checking|Just a moment)', forbiddenText: '(Page not found)'
    },
    cases
  };
}

test('popup viewport is normalized to the canonical run viewport', async () => {
  let viewport = { width: 1920, height: 982 };
  const calls = [];
  const page = {
    evaluate: async () => ({
      screen: { width: 1920, height: 1080 }, viewport,
      devicePixelRatio: 1, scrollY: 0, documentHeight: 1200
    }),
    setViewportSize: async size => {
      calls.push(size);
      viewport = { ...size };
    }
  };
  const result = await normalizePageViewport(page, { width: 1920, height: 919 });
  assert.deepEqual(result, { width: 1920, height: 919 });
  assert.deepEqual(calls, [{ width: 1920, height: 919 }]);
});

test('manifest URLs redact credentials and personal query values', () => {
  const sanitized = new URL(sanitizeManifestUrl('https://accounts.example.test/login?client_id=public&state=secret&continue=https%3A%2F%2Fprivate.test%2F&email=user%40example.test#access_token=secret'));
  assert.equal(sanitized.searchParams.get('client_id'), 'public');
  assert.equal(sanitized.searchParams.get('state'), '[redacted]');
  assert.equal(sanitized.searchParams.get('continue'), '[redacted]');
  assert.equal(sanitized.searchParams.get('email'), '[redacted]');
  assert.equal(sanitized.hash, '#[redacted]');
  const eventUrl = new URL(sanitizeEventUrl('https://ads.example.test/bid?consent=private&id=123#opaque'));
  assert.equal(eventUrl.searchParams.get('consent'), '[redacted]');
  assert.equal(eventUrl.searchParams.get('id'), '[redacted]');
  assert.equal(eventUrl.hash, '#[redacted]');
});

test('functional runner captures stable viewport states, popup and partial selections', { timeout: 30000 }, async () => {
  const { server, baseUrl } = await startServer();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'functional-capture-'));
  process.env.UI_EVIDENCE_HEADLESS = '1';
  process.env.UI_EVIDENCE_PROFILE = path.join(project, '.profile');
  try {
    const cases = [
      {
        id: 'TC-001', startUrl: '/',
        steps: [
          { action: 'fill', selector: '#query', value: 'BMW' },
          { action: 'select', selector: '#year', value: '2020' },
          { action: 'check', selector: '#agree' },
          { action: 'waitForSelector', selector: '#ad' }
        ],
        ready: { selector: '#header' }, capture: { target: '#header', scroll: 'top' }
      },
      {
        id: 'TC-002', startUrl: '/',
        primaryCaptureAfter: 'second',
        steps: [
          { action: 'click', selector: '#next' },
          {
            action: 'waitForUrl', value: '/second', captureAfter: 'second', captureReady: '#second',
            captureProof: { title: 'TC-002 · вторая страница', highlights: ['#second'] }
          },
          { action: 'back' },
          { action: 'waitForSelector', selector: '#header' }
        ],
        ready: { selector: '#header' }, capture: { target: '#header', scroll: 'top' }
      },
      {
        id: 'TC-003', startUrl: '/',
        steps: [
          { action: 'waitForSelector', selector: '#popup-button', captureAfter: 'before-popup', captureReady: '#popup-button' },
          { action: 'click', selector: '#popup-button', expectPage: 'oauth' }
        ],
        ready: { selector: '#popup', page: 'oauth' }, capture: { page: 'oauth', target: '#popup', scroll: 'top' }
      },
      {
        id: 'TC-004', startUrl: '/', steps: [],
        ready: { selector: '#header' }, capture: { target: '#header', scroll: 'top' }
      },
      {
        id: 'TC-005', startUrl: '/', steps: [],
        ready: { selector: '#header' },
        capture: {
          target: '#header', scroll: 'top',
          proof: {
            title: 'TC-005 · шапка видима', position: 'bottom-right', highlights: ['#header'],
            metrics: [{ type: 'element-state', selector: '#header', label: 'Шапка' }]
          }
        }
      }
    ];
    const result = await runCapture({ config: config(baseUrl, cases), projectRoot: project });
    assert.equal(result.manifest.cases.length, 5);
    assert.ok(
      result.manifest.cases.every(item => item.status === 'captured'),
      JSON.stringify(result.manifest.cases.map(({ id, status, reason }) => ({ id, status, reason })))
    );
    assert.ok(!result.manifest.errors.some(item => /TC-004.*TC-005|TC-005.*TC-004/.test(item)));
    assert.equal(result.manifest.cases[4].proof.title, 'TC-005 · шапка видима');
    assert.ok(fs.existsSync(path.join(result.runDir, 'contact-sheet.png')));
    assert.ok(fs.existsSync(path.join(result.runDir, 'browser-events.json')));
    assert.equal(result.manifest.cases[0].viewport.width, 900);
    assert.equal(result.manifest.cases[0].viewport.height, 700);
    assert.equal(result.manifest.cases[0].scrollY, 0);
    assert.ok(fs.existsSync(path.join(result.runDir, 'screenshots', 'TC-002.png')));
    assert.ok(fs.existsSync(path.join(result.runDir, 'screenshots', 'TC-002-2-final.png')));
    assert.equal(result.manifest.cases[1].file, 'screenshots/TC-002.png');
    assert.ok(result.manifest.cases[1].extraFiles.includes('screenshots/TC-002-2-final.png'));
    fs.unlinkSync(path.join(result.runDir, 'contact-sheet.png'));
    await makeContactSheet(result.runDir, result.manifest);
    assert.ok(fs.existsSync(path.join(result.runDir, 'contact-sheet.png')));

    const partial = await runCapture({ config: config(baseUrl, cases), projectRoot: project, only: ['TC-003'] });
    assert.deepEqual(partial.manifest.requestedCaseIds, ['TC-003']);
    assert.deepEqual(partial.manifest.cases.map(item => item.id), ['TC-003']);
  } finally {
    delete process.env.UI_EVIDENCE_HEADLESS;
    delete process.env.UI_EVIDENCE_PROFILE;
    await new Promise(resolve => server.close(resolve));
  }
});

test('functional runner waits for business state and records screen, viewport and image separately', { timeout: 20000 }, async () => {
  const { server, baseUrl } = await startServer();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'functional-state-'));
  try {
    const result = await runCapture({
      config: config(baseUrl, [{
        id: 'TC-101', startUrl: '/state', stateGroup: 'favorites',
        steps: [
          { action: 'waitForText', selector: '#counter', value: '1', exact: true },
          { action: 'waitForCount', selector: '.card', value: 1 },
          { action: 'waitForAttribute', selector: '#counter', name: 'data-state', value: 'ready' },
          { action: 'waitForHidden', selector: '.spinner' },
          { action: 'assertText', selector: '#counter', value: '1', exact: true },
          { action: 'assertCount', selector: '.card', value: 1 },
          { action: 'assertUrl', value: '/state' }
        ],
        ready: { selector: '#counter' },
        capture: { target: '#counter', contextSelector: '#header', scroll: 'top' }
      }]),
      projectRoot: project
    });
    const captured = result.manifest.cases[0];
    assert.equal(captured.status, 'captured');
    assert.deepEqual(captured.viewport, { width: 900, height: 700 });
    assert.deepEqual(captured.image, { width: 900, height: 700 });
    assert.equal(captured.captureMode, 'viewport');
    assert.equal(captured.context.selector, '#header');
    assert.equal(captured.navigation[0].action, 'startUrl');
    assert.equal(captured.navigation[0].attempts, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('functional preflight opens the configured browser and reports actual dimensions', { timeout: 15000 }, async () => {
  const { server, baseUrl } = await startServer();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'functional-check-'));
  process.env.UI_EVIDENCE_HEADLESS = '1';
  process.env.UI_EVIDENCE_PROFILE = path.join(project, '.profile');
  try {
    const checked = await checkEnvironment({
      config: config(baseUrl, [{ id: 'TC-001', startUrl: '/', steps: [], ready: { selector: '#header' } }]),
      projectRoot: project
    });
    assert.deepEqual(checked.screen, { width: 900, height: 700 });
    assert.deepEqual(checked.viewport, { width: 900, height: 700 });
    assert.equal(checked.windowState, 'fixed');
  } finally {
    delete process.env.UI_EVIDENCE_HEADLESS;
    delete process.env.UI_EVIDENCE_PROFILE;
    await new Promise(resolve => server.close(resolve));
  }
});

test('functional runner blocks an effectively blank screenshot', { timeout: 20000 }, async () => {
  const { server, baseUrl } = await startServer();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'functional-blank-'));
  process.env.UI_EVIDENCE_HEADLESS = '1';
  process.env.UI_EVIDENCE_PROFILE = path.join(project, '.profile');
  try {
    const configured = config(baseUrl, [{ id: 'TC-006', startUrl: '/blank', steps: [], ready: { selector: 'body' } }]);
    configured.diagnostics = { trace: 'failures' };
    const result = await runCapture({
      config: configured,
      projectRoot: project
    });
    assert.equal(result.manifest.status, 'failed');
    assert.equal(result.manifest.cases[0].status, 'blocked');
    assert.equal(result.manifest.cases[0].blockType, 'execution');
    assert.match(result.manifest.cases[0].reason, /пуст/i);
    assert.equal(result.manifest.cases[0].diagnosticTrace, 'traces/TC-006.zip');
    assert.ok(fs.existsSync(path.join(result.runDir, 'traces', 'TC-006.zip')));
  } finally {
    delete process.env.UI_EVIDENCE_HEADLESS;
    delete process.env.UI_EVIDENCE_PROFILE;
    await new Promise(resolve => server.close(resolve));
  }
});

test('functional runner blocks a large internal blank horizontal band', { timeout: 20000 }, async () => {
  const { server, baseUrl } = await startServer();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'functional-blank-band-'));
  process.env.UI_EVIDENCE_HEADLESS = '1';
  process.env.UI_EVIDENCE_PROFILE = path.join(project, '.profile');
  try {
    const result = await runCapture({
      config: config(baseUrl, [{ id: 'TC-030', startUrl: '/blank-band', steps: [], ready: { selector: '#content-anchor' } }]),
      projectRoot: project
    });
    assert.equal(result.manifest.status, 'failed');
    assert.equal(result.manifest.cases[0].status, 'blocked');
    assert.match(result.manifest.cases[0].reason, /пуст.*горизонталь/i);
  } finally {
    delete process.env.UI_EVIDENCE_HEADLESS;
    delete process.env.UI_EVIDENCE_PROFILE;
    await new Promise(resolve => server.close(resolve));
  }
});

test('functional runner collapses only a declared empty advertising slot', { timeout: 20000 }, async () => {
  const { server, baseUrl } = await startServer();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'functional-empty-ad-'));
  process.env.UI_EVIDENCE_HEADLESS = '1';
  process.env.UI_EVIDENCE_PROFILE = path.join(project, '.profile');
  try {
    const result = await runCapture({
      config: config(baseUrl, [{
        id: 'TC-032', startUrl: '/empty-ad', steps: [], ready: { selector: '#content-anchor' },
        capture: {
          target: '#content-anchor', scroll: 'top',
          collapseEmptyAds: [{ container: '.header-ann', slot: '#ad-slot' }]
        }
      }]),
      projectRoot: project
    });
    assert.equal(result.manifest.status, 'clean');
    assert.equal(result.manifest.cases[0].status, 'captured');
    assert.deepEqual(result.manifest.cases[0].collapsedEmptyAds, [{
      container: '.header-ann', slot: '#ad-slot', originalHeightPx: 250
    }]);
    assert.ok(result.manifest.cases[0].target.rect.y < 200);
    assert.ok(result.manifest.cases[0].largestInternalBlankBand.heightPx < 160);
  } finally {
    delete process.env.UI_EVIDENCE_HEADLESS;
    delete process.env.UI_EVIDENCE_PROFILE;
    await new Promise(resolve => server.close(resolve));
  }
});

test('anchor capture aligns meaningful content below the sticky header', { timeout: 20000 }, async () => {
  const { server, baseUrl } = await startServer();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'functional-anchor-offset-'));
  process.env.UI_EVIDENCE_HEADLESS = '1';
  process.env.UI_EVIDENCE_PROFILE = path.join(project, '.profile');
  try {
    const result = await runCapture({
      config: config(baseUrl, [{
        id: 'TC-031', startUrl: '/blank-band', steps: [], ready: { selector: '#content-anchor' },
        capture: { scroll: 'anchor', anchor: '#content-anchor', anchorOffsetPx: 88, target: '#content-anchor' }
      }]),
      projectRoot: project
    });
    assert.equal(result.manifest.status, 'clean');
    assert.equal(result.manifest.cases[0].status, 'captured');
    assert.ok(result.manifest.cases[0].scrollY > 200);
    assert.ok(Math.abs(result.manifest.cases[0].target.rect.y - 88) <= 2);
  } finally {
    delete process.env.UI_EVIDENCE_HEADLESS;
    delete process.env.UI_EVIDENCE_PROFILE;
    await new Promise(resolve => server.close(resolve));
  }
});

test('functional runner blocks an undeclared external origin', { timeout: 20000 }, async () => {
  const { server, baseUrl, alternateOrigin } = await startServer();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'functional-origin-'));
  process.env.UI_EVIDENCE_HEADLESS = '1';
  process.env.UI_EVIDENCE_PROFILE = path.join(project, '.profile');
  try {
    const result = await runCapture({
      config: config(baseUrl, [{ id: 'TC-007', startUrl: alternateOrigin, steps: [], ready: { selector: '#header' } }]),
      projectRoot: project
    });
    assert.equal(result.manifest.cases[0].status, 'blocked');
    assert.match(result.manifest.cases[0].reason, /origin/i);
  } finally {
    delete process.env.UI_EVIDENCE_HEADLESS;
    delete process.env.UI_EVIDENCE_PROFILE;
    await new Promise(resolve => server.close(resolve));
  }
});

test('expectPage click failure is recorded as a blocked case', { timeout: 20000 }, async () => {
  const { server, baseUrl } = await startServer();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'functional-popup-failure-'));
  process.env.UI_EVIDENCE_HEADLESS = '1';
  try {
    const input = config(baseUrl, [{
      id: 'TC-001', startUrl: '/',
      steps: [{ action: 'click', selector: '#missing-popup-button', expectPage: 'popup', timeoutMs: 300 }],
      ready: { selector: 'body' }
    }]);
    const result = await runCapture({ config: input, projectRoot: project });
    assert.equal(result.manifest.cases[0].status, 'blocked');
    assert.match(result.manifest.cases[0].reason, /locator|missing-popup-button|popup/i);
  } finally {
    delete process.env.UI_EVIDENCE_HEADLESS;
    await new Promise(resolve => server.close(resolve));
  }
});

test('non-interactive profile preparation waits for challenge completion', { timeout: 15000 }, async () => {
  const { server, baseUrl } = await startServer();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'functional-profile-'));
  process.env.UI_EVIDENCE_HEADLESS = '1';
  process.env.UI_EVIDENCE_PROFILE = path.join(project, '.profile');
  try {
    const prepared = await prepareProfile({
      ...config(baseUrl, [{ id: 'TC-001', startUrl: '/', steps: [], ready: { selector: '#header' } }]),
      baseUrl: new URL('/challenge', baseUrl).href,
      browser: {
        mode: 'launch', windowState: 'fixed', viewport: { width: 900, height: 700 },
        expectedScreen: { width: 900, height: 700 }, profileReadySelector: '#ready'
      }
    }, project, { interactive: false, timeoutMs: 5000 });
    assert.equal(prepared.title, 'Готово');
  } finally {
    delete process.env.UI_EVIDENCE_HEADLESS;
    delete process.env.UI_EVIDENCE_PROFILE;
    await new Promise(resolve => server.close(resolve));
  }
});

test('isolated CDP run copies site cookies and leaves the external Chrome running', { timeout: 30000 }, async () => {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'functional-cdp-'));
  const { chromium } = requirePlaywright();
  const original = await chromium.launchPersistentContext(profile, {
    executablePath: findBrowser(), headless: true, viewport: { width: 900, height: 700 },
    args: [`--remote-debugging-port=${port}`]
  });
  try {
    const originalPage = original.pages()[0] || await original.newPage();
    await originalPage.setContent('<title>External Chrome</title><h1>Работает</h1>');
    await original.addCookies([{ name: 'site_session', value: 'prepared', domain: 'example.test', path: '/' }]);
    await original.addCookies([{ name: 'site_auth', value: 'private', domain: 'example.test', path: '/' }]);
    await original.addCookies([{ name: 'external_session', value: 'private', domain: 'accounts.google.com', path: '/' }]);
    await waitForCdp(port);
    const cdpConfig = config('http://example.test/', [{ id: 'TC-001', startUrl: '/', steps: [], ready: { selector: 'body' } }]);
    cdpConfig.browser = {
      mode: 'cdp', cdpUrl: `http://127.0.0.1:${port}`, windowState: 'fixed', isolateContext: true,
      cookieBlocklist: ['site_auth'],
      expectedScreen: { width: 900, height: 700 }
    };
    const connected = await openFunctional(cdpConfig, profile);
    const connectionBrowser = connected.context.browser();
    assert.equal(connectionBrowser.contexts().length, 2);
    assert.equal((await connected.context.cookies('http://example.test/')).find(cookie => cookie.name === 'site_session')?.value, 'prepared');
    assert.equal((await connected.context.cookies('http://example.test/')).some(cookie => cookie.name === 'site_auth'), false);
    assert.equal((await connected.context.cookies('https://accounts.google.com/')).length, 0);
    assert.equal(connectionBrowser.isConnected(), true);
    await connected.close();
    assert.equal(connectionBrowser.isConnected(), false);
    assert.equal(await originalPage.title(), 'External Chrome');
  } finally {
    await original.close();
  }
});
