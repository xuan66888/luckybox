/** Original LuckyBox foil treatment. No motion sensors, external assets, or event cancellation. */
type HoloPointer = {
  element: HTMLElement;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  horizontal: boolean;
};

let installedCleanup: (() => void) | undefined;
const properties = ['--holo-x', '--holo-y', '--holo-rx', '--holo-ry'];

/** Install once; delegation also handles cards added by subsequent page renders. */
export function installHoloInteractions(): () => void {
  if (installedCleanup) return installedCleanup;

  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const controller = new AbortController();
  const options = { passive: true, signal: controller.signal };
  let active: HoloPointer | undefined;
  let frame: number | undefined;

  const enabled = () => !preference.matches && document.visibilityState !== 'hidden';
  const cardAt = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>('[data-holo]') : null;

  function reset() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    if (active) {
      active.element.classList.remove('is-holo-active');
      for (const property of properties) active.element.style.removeProperty(property);
    }
    active = undefined;
  }

  function paint() {
    frame = undefined;
    if (!active || !active.element.isConnected || !enabled()) { reset(); return; }
    const { element, x, y } = active;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) { reset(); return; }
    const fractionX = Math.min(1, Math.max(0, (x - rect.left) / rect.width));
    const fractionY = Math.min(1, Math.max(0, (y - rect.top) / rect.height));
    // Updating individual CSSOM properties works with the existing self-only style CSP.
    element.style.setProperty('--holo-x', `${(fractionX * 100).toFixed(2)}%`);
    element.style.setProperty('--holo-y', `${(fractionY * 100).toFixed(2)}%`);
    element.style.setProperty('--holo-rx', `${((0.5 - fractionY) * 8).toFixed(2)}deg`);
    element.style.setProperty('--holo-ry', `${((fractionX - 0.5) * 12).toFixed(2)}deg`);
    element.classList.add('is-holo-active');
  }

  function queuePaint() {
    if (frame === undefined) frame = requestAnimationFrame(paint);
  }

  function begin(event: PointerEvent, element: HTMLElement) {
    reset();
    active = { element, pointerId: event.pointerId, pointerType: event.pointerType, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, horizontal: false };
    if (event.pointerType === 'mouse' || event.pointerType === '') queuePaint();
  }

  function onOver(event: PointerEvent) {
    if (!enabled() || (event.pointerType !== 'mouse' && event.pointerType !== '')) return;
    const element = cardAt(event.target);
    if (element && active?.element !== element) begin(event, element);
  }

  function onDown(event: PointerEvent) {
    if (!enabled() || !event.isPrimary || event.button !== 0) return;
    const element = cardAt(event.target);
    if (element) begin(event, element);
  }

  function onMove(event: PointerEvent) {
    if (!enabled()) { reset(); return; }
    if (event.pointerType === 'mouse' || event.pointerType === '') {
      const element = cardAt(event.target);
      if (!element) { reset(); return; }
      if (active?.element !== element) begin(event, element);
    }
    if (!active || active.pointerId !== event.pointerId) return;
    if (event.pointerType !== 'mouse' && event.pointerType !== '' && !active.horizontal) {
      const dx = Math.abs(event.clientX - active.startX);
      const dy = Math.abs(event.clientY - active.startY);
      if (Math.max(dx, dy) < 7) return;
      // Native vertical scrolling wins. Never call preventDefault or capture a pointer.
      if (dy >= dx) { reset(); return; }
      active.horizontal = true;
    }
    active.x = event.clientX;
    active.y = event.clientY;
    queuePaint();
  }

  function onOut(event: PointerEvent) {
    if (!active || active.pointerId !== event.pointerId) return;
    if (event.relatedTarget instanceof Node && active.element.contains(event.relatedTarget)) return;
    reset();
  }

  function onEnd(event: PointerEvent) {
    if (active?.pointerId === event.pointerId && (event.type === 'pointercancel' || active.pointerType !== 'mouse')) reset();
  }

  const observer = new MutationObserver(() => {
    if (active && (!active.element.isConnected || !active.element.hasAttribute('data-holo'))) reset();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-holo'] });
  document.addEventListener('pointerover', onOver, options);
  document.addEventListener('pointerdown', onDown, options);
  document.addEventListener('pointermove', onMove, options);
  document.addEventListener('pointerout', onOut, options);
  document.addEventListener('pointerup', onEnd, options);
  document.addEventListener('pointercancel', onEnd, options);
  document.addEventListener('visibilitychange', reset, options);
  window.addEventListener('blur', reset, options);
  preference.addEventListener('change', reset, options);

  installedCleanup = () => {
    reset();
    controller.abort();
    observer.disconnect();
    installedCleanup = undefined;
  };
  return installedCleanup;
}
