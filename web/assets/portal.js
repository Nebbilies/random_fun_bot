// All workspace modules import this module before issuing API requests.
const nativeFetch = window.fetch.bind(window);
const sessionReady = nativeFetch('/api/auth/session').then(async (response) => {
  if (!response.ok) { location.replace('/login'); throw new Error('Sign in required'); }
  const account = await response.json();
  if (account.role !== 'admin') {
    for (const link of document.querySelectorAll('nav a[href="/config"], nav a[href="/game"]')) link.hidden = true;
  }
  const logout = document.createElement('button');
  logout.textContent = `Sign out (${account.username})`;
  logout.addEventListener('click', async () => {
    await window.fetch('/api/auth/logout', { method: 'POST' });
    location.replace('/login');
  });
  document.body.append(logout);
  return account;
});
window.fetch = async (input, init = {}) => {
  const account = await sessionReady;
  const url = new URL(input instanceof Request ? input.url : input, location.href);
  const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (url.origin === location.origin && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('x-csrf-token', account.csrfToken);
    init = { ...init, headers };
  }
  const response = await nativeFetch(input, init);
  if (url.origin === location.origin && response.status === 401) location.replace('/login');
  return response;
};

if (document.body.dataset.standalone !== 'true') {
  const nav = document.querySelector('nav[aria-label="Management portal"]');
  if (nav) {
    const link = document.createElement('a'); link.href = '/gender';
    link.textContent = 'Gender review';
    if (location.pathname === '/gender') link.setAttribute('aria-current', 'page');
    nav.append(link);
  }
}

// The standalone franchise server exposes only its own workspace.
if (document.body.dataset.standalone === 'true') {
  document.querySelector('nav[aria-label="Management portal"] a[aria-current]').href = '/';
}

export function feedback(element, message, tone = '') {
  element.textContent = message;
  element.dataset.tone = tone;
}
