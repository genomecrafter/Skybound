/**
 * End-of-route results card ("Route Complete" / "Landed!").
 * The mouse pointer is released when it opens so the buttons can be clicked.
 */
export class Results {
  /** @param {{ again: Function, routes: Function }} actions */
  constructor(root, actions) {
    this.el = document.createElement('div');
    this.el.className = 'menu results hidden';
    this.el.innerHTML = `
      <div class="results-card">
        <div class="results-badge"></div>
        <h2 class="menu-title small results-title"></h2>
        <p class="results-sub"></p>
        <div class="results-stats"></div>
        <div class="menu-buttons">
          <button data-a="again" class="primary">Fly again</button>
          <button data-a="routes">Choose another route</button>
        </div>
      </div>`;
    this.el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => actions[b.dataset.a]()));
    root.append(this.el);
  }

  /**
   * @param {object} r { title, subtitle, badge, stats: [[label, value], ...] }
   */
  show({ title, subtitle = '', badge = '', stats = [] }) {
    this.el.querySelector('.results-title').textContent = title;
    this.el.querySelector('.results-sub').textContent = subtitle;
    const b = this.el.querySelector('.results-badge');
    b.textContent = badge;
    b.style.display = badge ? '' : 'none';
    this.el.querySelector('.results-stats').innerHTML = stats
      .map(([k, v]) => `<div class="results-row"><span>${k}</span><b>${v}</b></div>`)
      .join('');
    this.el.classList.remove('hidden');
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Button captions (the simulator says "scenario" instead of "route"). */
  setLabels(again, routes) {
    this.el.querySelector('[data-a="again"]').textContent = again;
    this.el.querySelector('[data-a="routes"]').textContent = routes;
  }

  hide() {
    this.el.classList.add('hidden');
  }

  get visible() {
    return !this.el.classList.contains('hidden');
  }
}
