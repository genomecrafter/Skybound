/**
 * Cinematic on-screen caption (route titles and "moment" captions).
 * Pure HTML/CSS: the fade and letter-spacing animation are CSS transitions.
 */
export class Caption {
  constructor(root) {
    this.el = document.createElement('div');
    this.el.className = 'caption';
    this.el.innerHTML = '<div class="caption-title"></div><div class="caption-text"></div>';
    root.append(this.el);
    this.titleEl = this.el.querySelector('.caption-title');
    this.textEl = this.el.querySelector('.caption-text');
    this.timer = null;
  }

  show(title, text = '', seconds = 4) {
    clearTimeout(this.timer);
    this.titleEl.textContent = title;
    this.textEl.textContent = text;
    // Restart the CSS animation: remove the class, force a reflow, add it again
    this.el.classList.remove('show');
    void this.el.offsetWidth;
    this.el.classList.add('show');
    this.timer = setTimeout(() => this.el.classList.remove('show'), seconds * 1000);
  }

  hide() {
    clearTimeout(this.timer);
    this.el.classList.remove('show');
  }
}
