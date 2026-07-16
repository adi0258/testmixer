// Fullscreen image viewer: click any question image to enlarge it.

let overlay = null;

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.className = 'lightbox';
  overlay.hidden = true;
  const img = document.createElement('img');
  img.alt = '';
  overlay.append(img);
  overlay.addEventListener('click', () => (overlay.hidden = true));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') overlay.hidden = true;
  });
  document.body.append(overlay);
  return overlay;
}

export function openLightbox(src) {
  const el = ensureOverlay();
  el.querySelector('img').src = src;
  el.hidden = false;
}

// Creates a clickable thumbnail strip for a question's images.
export function imageStrip(images) {
  const wrap = document.createElement('div');
  wrap.className = 'q-images';
  for (const src of images) {
    const img = document.createElement('img');
    img.src = src;
    img.title = 'לחצו להגדלה';
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      openLightbox(src);
    });
    wrap.append(img);
  }
  return wrap;
}
