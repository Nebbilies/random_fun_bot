// Searchable franchise picker: type to filter, arrow keys to browse, Enter to choose.
let pickerSequence = 0;

export function createFranchisePicker({
  loadOptions,
  excludeId = 0,
  placeholder = 'Search franchises…',
  ariaLabel = 'Franchise',
  emptyText = 'No matching franchises.',
  onSelect = () => {},
} = {}) {
  const root = document.createElement('div');
  root.className = 'picker';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'picker-input';
  input.placeholder = placeholder;
  input.setAttribute('aria-label', ariaLabel);
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');
  const listId = `franchise-picker-${++pickerSequence}`;
  input.setAttribute('aria-controls', listId);
  const list = document.createElement('ul');
  list.id = listId;
  list.className = 'picker-options';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  root.append(input, list);

  let options = [];
  let selection = null;
  let active = -1;
  let request = 0;
  let timer = 0;

  const excluded = () => (typeof excludeId === 'function' ? excludeId() : excludeId);

  function open() {
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function render() {
    list.replaceChildren();
    if (!options.length) {
      const empty = document.createElement('li');
      empty.className = 'picker-empty';
      empty.textContent = emptyText;
      list.append(empty);
      return;
    }
    options.forEach((option, index) => {
      const item = document.createElement('li');
      item.className = 'picker-option';
      item.id = `${listId}-${index}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(selection?.id === option.id));
      item.textContent = option.name;
      if (index === active) item.classList.add('active');
      item.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        choose(option);
      });
      list.append(item);
    });
  }

  function choose(option) {
    selection = { id: option.id, name: option.name };
    input.value = option.name;
    render();
    close();
    onSelect(selection);
  }

  function highlight(index) {
    const items = [...list.querySelectorAll('.picker-option')];
    if (!items.length) return;
    active = (index + items.length) % items.length;
    items.forEach((item, position) => item.classList.toggle('active', position === active));
    input.setAttribute('aria-activedescendant', items[active].id);
    items[active].scrollIntoView({ block: 'nearest' });
  }

  async function load(query) {
    const id = ++request;
    try {
      const found = await loadOptions(query, { excludeId: excluded() });
      if (id !== request) return;
      options = Array.isArray(found) ? found : [];
      active = -1;
      const typed = query.trim().toLocaleLowerCase('en-US');
      const exact = options.find((option) => option.name.toLocaleLowerCase('en-US') === typed);
      selection = exact ? { id: exact.id, name: exact.name } : null;
      render();
      open();
      onSelect(selection);
    } catch {
      if (id !== request) return;
      options = [];
      selection = null;
      render();
      open();
      onSelect(null);
    }
  }

  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { load(input.value); }, 120);
  });
  input.addEventListener('focus', () => { load(input.value); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (list.hidden) { load(input.value); return; }
      highlight(active + (event.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (event.key === 'Enter') {
      if (!list.hidden && active >= 0 && options[active]) { event.preventDefault(); choose(options[active]); }
      return;
    }
    if (event.key === 'Escape') { close(); return; }
    if (event.key === 'Tab') close();
  });
  root.addEventListener('focusout', (event) => {
    if (!root.contains(event.relatedTarget)) close();
  });

  return {
    element: root,
    input,
    get selection() { return selection; },
    reset() {
      selection = null;
      options = [];
      input.value = '';
      render();
      close();
      onSelect(null);
    },
  };
}
