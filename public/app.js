(() => {
  const root = document.documentElement;
  const bar = document.querySelector('[data-global-loading]');
  const spinners = document.querySelectorAll('[data-modal-loading]');
  const setLoading = (active) => {
    root.classList.toggle('is-loading', active);
    if (bar) bar.hidden = !active;
    spinners.forEach((spinner) => { spinner.hidden = !active; });
  };

  document.addEventListener('submit', async (event) => {
    const form = event.target.closest('form[data-async]');
    if (!form) return;
    event.preventDefault();
    setLoading(true);
    try {
      const values = new FormData(form);
      const body = new URLSearchParams();
      values.forEach((value, key) => body.append(key, String(value)));
      const response = await fetch(form.action, {
        method: form.method || 'POST', body,
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'request_failed');
      if (form.hasAttribute('data-keep-open')) {
        const output = form.querySelector('[data-form-error]');
        if (output) output.textContent = JSON.stringify(result, null, 2);
      } else if (result.redirect) window.location.assign(result.redirect);
      else window.location.reload();
    } catch (error) {
      const output = form.querySelector('[data-form-error]');
      if (output) output.textContent = error instanceof Error ? error.message : 'request_failed';
    } finally { setLoading(false); }
  });
})();
