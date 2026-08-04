/**
 * Отрисовка указателя мыши на снимке.
 *
 * Скриншот страницы курсор не содержит: браузер снимает страницу, а курсор рисует операционная
 * система. Поэтому на снимке «под курсором» непонятно, куда именно наведено — и заказчик не может
 * связать изменившийся элемент с действием. Здесь курсор дорисовывается в страницу как накладка.
 *
 * Накладка не влияет на проверку:
 *  - `pointer-events: none` — она не перехватывает наведение, состояние :hover не сбрасывается;
 *  - вставляется после того, как сняты снимки для попиксельного сравнения, и убирается сразу после
 *    снимка для отчёта, поэтому в замеры не попадает.
 */

const MARK_ID = '__qa_cursor_mark__';

/** Рисует указатель в точке (x, y) экрана и, если нужно, рамку вокруг проверяемого элемента. */
async function showCursor(page, x, y, { frameSelector = null, label = null } = {}) {
  await page.evaluate(({ x, y, id, frameSelector, label }) => {
    const old = document.getElementById(id);
    if (old) old.remove();

    const root = document.createElement('div');
    root.id = id;
    root.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';

    if (frameSelector) {
      const el = document.querySelector(frameSelector);
      if (el) {
        const r = el.getBoundingClientRect();
        const frame = document.createElement('div');
        frame.style.cssText =
          'position:fixed;pointer-events:none;border:2px solid #ff3b30;border-radius:4px;' +
          'left:' + (r.x - 3) + 'px;top:' + (r.y - 3) + 'px;' +
          'width:' + (r.width + 6) + 'px;height:' + (r.height + 6) + 'px;';
        root.appendChild(frame);
      }
    }

    // Подсветка под указателем: мягкий кружок, чтобы точка наведения читалась на любом фоне.
    const halo = document.createElement('div');
    halo.style.cssText =
      'position:fixed;pointer-events:none;border-radius:50%;' +
      'left:' + (x - 16) + 'px;top:' + (y - 16) + 'px;width:32px;height:32px;' +
      'background:radial-gradient(circle, rgba(255,204,0,.55) 0%, rgba(255,204,0,.18) 60%, rgba(255,204,0,0) 100%);';
    root.appendChild(halo);

    // Сам указатель — привычная стрелка с белой обводкой, видна и на светлом, и на тёмном.
    const arrow = document.createElement('div');
    arrow.style.cssText = 'position:fixed;pointer-events:none;left:' + x + 'px;top:' + y + 'px;';
    arrow.innerHTML =
      '<svg width="22" height="30" viewBox="0 0 22 30" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M1 1 L1 22 L6.5 16.8 L10 25.5 L14 23.8 L10.6 15.4 L18 15.2 Z" ' +
      'fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    root.appendChild(arrow);

    if (label) {
      const tag = document.createElement('div');
      tag.textContent = label;
      tag.style.cssText =
        'position:fixed;pointer-events:none;left:' + (x + 20) + 'px;top:' + (y + 18) + 'px;' +
        'background:rgba(17,17,17,.85);color:#fff;font:12px/1.4 system-ui,sans-serif;' +
        'padding:3px 7px;border-radius:4px;white-space:nowrap;';
      root.appendChild(tag);
    }

    document.body.appendChild(root);
  }, { x, y, id: MARK_ID, frameSelector, label });
}

/** Убирает накладку. Вызывается сразу после снимка, чтобы она не попала в замеры. */
async function hideCursor(page) {
  await page.evaluate((id) => {
    const el = document.getElementById(id);
    if (el) el.remove();
  }, MARK_ID);
}

/** Центр элемента в координатах экрана — туда Playwright и наводит курсор. */
async function centerOf(page, selector) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, selector);
}

module.exports = { showCursor, hideCursor, centerOf };
