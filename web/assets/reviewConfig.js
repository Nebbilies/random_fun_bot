import { feedback } from './portal.js';

const $ = (selector) => document.querySelector(selector);
const status = $('#configStatus');
const sections = $('#configSections');
const dialog = $('#changeReview');
let view;
let pending;
let busy = false;
let dirty = false;
const at = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);
const pretty = (value) => JSON.stringify(value, null, 2);
const title = (key) => key.replaceAll('_', ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('.', ' / ');
const probability = (field) => field.max === 1 && /Rate$|Chance$/.test(field.key);
const unit = (field) => field.section === 'itemExpiryDays' ? 'days' : probability(field) ? '%' : /Ms$/.test(field.key) ? 'milliseconds' : /Minutes$/.test(field.key) ? 'UTC offset minutes' : /weight/i.test(field.key) ? 'relative weight' : '';
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
async function request(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(response.status === 409 ? `${body.error} Reload / discard edits to load the latest revision before retrying.` : body.error || 'Request failed.');
  return body;
}
function lock(value) {
  busy = value;
  document.querySelectorAll('#configSections button, #scopeForm button, #confirmChanges').forEach((button) => { button.disabled = value; });
  sections.setAttribute('aria-busy', String(value));
}
async function load() {
  if (busy || (dirty && !confirm('Discard unsaved edits and reload this scope?'))) return;
  const guildId = $('#scope').value === 'guild' ? $('#configGuildId').value.trim() : null;
  if (guildId !== null && !/^[1-9]\d{0,19}$/.test(guildId)) { feedback(status, 'Enter a valid server ID (up to 20 digits).', 'error'); return; }
  lock(true);
  try {
    view = await request(`/api/config${guildId ? `?guildId=${encodeURIComponent(guildId)}` : ''}`);
    dirty = false;
    render();
    feedback(status, `Loaded ${view.guildId ? `server ${view.guildId}` : 'global defaults'} · revision ${view.revision}.`);
  } catch (error) { feedback(status, error.message, 'error'); }
  finally { lock(false); }
}
function render() {
  sections.replaceChildren();
  for (const section of view.sections) {
    const fields = Object.values(view.registry).filter((field) => field.section === section);
    const form = node('form', undefined, 'panel config-section');
    const fieldset = node('fieldset');
    fieldset.append(node('legend', section === 'itemExpiryDays' ? 'Item lifetimes' : title(section)));
    if (section === 'itemExpiryDays') fieldset.append(node('p', 'Applies to newly acquired items only.', 'notice'));
    const grid = node('div', undefined, 'config-fields');
    const inputs = new Map();
    for (const field of fields) {
      const value = at(view.effective, field.key);
      const structured = field.type === 'array';
      const wrapper = node('div', undefined, `config-field${structured ? ' structured' : ''}`);
      const fieldTitle = field.section === 'itemExpiryDays'
        ? field.key.split('.').at(-1).replace(/^./, letter => letter.toUpperCase()) : title(field.key);
      const label = node('label', `${fieldTitle}${unit(field) ? ` (${unit(field)})` : ''}`);
      const input = node(structured ? 'textarea' : 'input');
      input.id = `field-${field.key}`;
      label.htmlFor = input.id;
      input.dataset.key = field.key;
      if (field.type === 'boolean') { input.type = 'checkbox'; input.checked = value; }
      else if (structured) { input.value = pretty(value); input.spellcheck = false; input.required = true; }
      else {
        input.type = 'number'; input.required = true;
        const scale = probability(field) ? 100 : 1;
        input.value = value * scale;
        if (field.min !== undefined) input.min = field.min * scale;
        if (field.max !== undefined) input.max = field.max * scale;
        input.step = field.type === 'integer' ? '1' : 'any';
      }
      input.disabled = Boolean(view.guildId && !field.guild);
      input.addEventListener('input', () => { dirty = true; input.setCustomValidity(''); input.removeAttribute('aria-invalid'); });
      const meta = node('p', undefined, 'config-meta');
      meta.id = `${input.id}-hint`;
      const source = { builtin: 'Built-in default', global: 'Global configuration', guild: 'Server override' }[view.sources[field.key]];
      meta.textContent = `${source}. Built-in default: ${pretty(field.default)}. ${structured ? 'JSON array; preserve the example’s structure. Chance values use fractions from 0 to 1; times use milliseconds. Example: ' + pretty(field.default) : ''}`;
      input.setAttribute('aria-describedby', meta.id);
      wrapper.append(label, input, meta);
      if (Object.hasOwn(view.overrides, field.key)) {
        const resetField = node('button', 'Reset this setting…', 'secondary');
        resetField.type = 'button';
        resetField.addEventListener('click', () => review(section, {}, [field.key]));
        wrapper.append(resetField);
      }
      grid.append(wrapper);
      inputs.set(field.key, { field, input });
    }
    fieldset.append(grid);
    const actions = node('div', undefined, 'row');
    const save = node('button', section === 'schedules' ? 'Review and activate schedule…' : 'Review changes…');
    save.type = 'submit';
    const reset = node('button', 'Reset section…', 'danger'); reset.type = 'button';
    actions.append(save, reset); fieldset.append(actions); form.append(fieldset);
    if (section === 'schedules') fieldset.prepend(node('p', 'Warning: activation starts fresh affected allowance cycles. It does not erase marriages, inventory or daily-claim records.', 'notice'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = {};
      for (const [key, { field, input }] of inputs) {
        if (input.disabled) continue;
        let value;
        try {
          value = field.type === 'boolean' ? input.checked : field.type === 'array' ? JSON.parse(input.value) : Number(input.value) / (probability(field) ? 100 : 1);
          if (field.type === 'array' && (!Array.isArray(value) || value.length > field.maxLength)) throw new Error(`Expected an array with at most ${field.maxLength} entries.`);
        } catch (error) {
          input.setCustomValidity(`Invalid JSON for ${title(key)}. ${error.message}`); input.setAttribute('aria-invalid', 'true'); input.reportValidity(); input.focus(); return;
        }
        if (pretty(value) !== pretty(at(view.effective, key))) values[key] = value;
      }
      if (!Object.keys(values).length) { feedback(status, 'No changed values to save.'); return; }
      review(section, values, false);
    });
    reset.addEventListener('click', () => review(section, {}, true));
    sections.append(form);
  }
}
function review(section, values, reset) {
  if (busy) return;
  const keys = Array.isArray(reset) ? reset : reset ? Object.keys(view.overrides).filter((key) => view.registry[key]?.section === section) : Object.keys(values);
  if (!keys.length) { feedback(status, 'This section has no explicit overrides to reset.'); return; }
  pending = { guildId: view.guildId, section, values, reset: Array.isArray(reset) ? reset : reset ? true : [], expectedRevision: view.revision };
  $('#reviewTitle').textContent = reset ? 'Confirm settings reset' : 'Review changes';
  $('#reviewScope').textContent = `${view.guildId ? `Server ${view.guildId}` : 'Global defaults'} · ${title(section)} · revision ${view.revision}. ${reset ? 'Remove explicit settings and restore inheritance.' : 'Only these changed fields will be saved atomically. Other unsaved sections will be discarded when settings reload.'}${section === 'schedules' ? ' WARNING: this activates a fresh affected allowance cycle.' : section === 'itemExpiryDays' ? ' Applies to newly acquired items only. Units: days.' : ''}`;
  const changes = $('#reviewChanges'); changes.replaceChildren();
  for (const key of keys) {
    const row = node('div', undefined, 'config-change');
    row.append(node('strong', title(key)), node('pre', `Current: ${pretty(at(view.effective, key))}\nNew: ${reset ? 'Inherited value (server) / built-in default (global)' : pretty(values[key])}`));
    changes.append(row);
  }
  $('#confirmChanges').textContent = section === 'schedules' ? 'Confirm activation and fresh cycle' : reset ? 'Confirm reset' : 'Confirm save';
  dialog.showModal();
}
$('#confirmChanges').addEventListener('click', async () => {
  if (!pending || busy) return;
  lock(true);
  try {
    const activation = pending.section === 'schedules';
    view = await request(activation ? '/api/config/activate-schedule' : '/api/config/section', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...pending, ...(activation ? { confirmActivation: true } : {}) }),
    });
    dialog.close(); pending = null; dirty = false; render();
    feedback(status, `Saved. Effective values reloaded at revision ${view.revision}.`, 'success');
  } catch (error) { dialog.close(); feedback(status, `${error.message} Edits have been retained; reload to discard or correct them and review again.`, 'error'); }
  finally { lock(false); }
});
$('#cancelChanges').addEventListener('click', () => dialog.close());
$('#scope').addEventListener('change', () => { $('#configGuildId').disabled = $('#scope').value !== 'guild'; $('#configGuildId').required = $('#scope').value === 'guild'; });
$('#scopeForm').addEventListener('submit', (event) => { event.preventDefault(); load(); });
$('#reloadConfig').addEventListener('click', load);
window.addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
load();
