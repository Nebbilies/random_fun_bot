document.querySelector('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    location.replace('/');
  } catch (error) { document.querySelector('#message').textContent = error.message; }
  finally { form.password.value = ''; button.disabled = false; }
});
