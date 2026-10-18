import { feedback } from './portal.js';

const status = document.querySelector('#status');
async function apply(path, body, success) {
  const buttons = document.querySelectorAll('button');
  buttons.forEach((button) => { button.disabled = true; });
  feedback(status, 'Applying changes…');
  status.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Action failed.');
    feedback(status, success, 'success');
  } catch (error) { feedback(status, error.message, 'error'); }
  finally { buttons.forEach((button) => { button.disabled = false; }); status.removeAttribute('aria-busy'); }
}
document.querySelector('#rollForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const amount = Number(document.querySelector('#amount').value);
  if (!Number.isSafeInteger(amount) || amount < 1) {
    status.textContent = 'Enter a positive whole number of rolls.';
    return;
  }
  apply('/api/game/add-rolls', { amount }, `Added up to ${amount} rolls per user across all servers, capped at each server's maximum.`);
});
document.querySelector('#resetClaims').addEventListener('click', () => {
  apply('/api/game/reset-claims', {}, 'Claims reset. Every user can claim again across all servers.');
});
