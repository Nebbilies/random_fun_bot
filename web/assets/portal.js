// The standalone franchise server exposes only its own workspace.
if (document.body.dataset.standalone === 'true') {
  document.querySelector('nav[aria-label="Management portal"] a[aria-current]').href = '/';
}

export function feedback(element, message, tone = '') {
  element.textContent = message;
  element.dataset.tone = tone;
}
