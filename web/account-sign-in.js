/* The uburoom account sign-in form: username and password, for the entry page.
 * Self-contained: mount(container) fills the container with the form and handles submission.
 * The server answers every failure the same way and rate-limits them; on success it sets the
 * ordinary browser session cookie, and `onSignedIn` (default: reload) takes over. */

/**
 * @param {HTMLElement} container where the form goes (its contents are replaced)
 * @param {{onSignedIn?: () => void, idPrefix?: string}} [options]
 * @returns {{form: HTMLFormElement, focus: () => void}}
 */
export function mount(container, { onSignedIn = () => location.reload(), idPrefix = 'account-sign-in' } = {}) {
  const doc = container.ownerDocument;
  const node = (tag, parent, props = {}) => {
    const element = Object.assign(doc.createElement(tag), props);
    parent.append(element);
    return element;
  };
  container.replaceChildren();
  const form = node('form', container, { className: 'entry-form account-sign-in', noValidate: false });
  form.setAttribute('aria-label', 'Sign in with a uburoom account');
  node('label', form, { htmlFor: idPrefix + '-username', textContent: 'Username' });
  const username = node('input', form, {
    id: idPrefix + '-username',
    className: 'entry-password',
    type: 'text',
    autocomplete: 'username',
    autocapitalize: 'none',
    spellcheck: false,
    maxLength: 32,
    required: true,
  });
  node('label', form, { htmlFor: idPrefix + '-password', textContent: 'Password' });
  const password = node('input', form, {
    id: idPrefix + '-password',
    className: 'entry-password',
    type: 'password',
    autocomplete: 'current-password',
    maxLength: 1024,
    required: true,
  });
  const error = node('p', form, { className: 'form-error', id: idPrefix + '-error' });
  error.setAttribute('role', 'alert');
  const submit = node('button', form, { className: 'entry-submit primary', type: 'submit', textContent: 'Sign in' });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    try {
      const response = await fetch('/api/uburoom-accounts/sign-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.value, password: password.value }),
        signal: AbortSignal.timeout(15000),
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value.error || 'Sign-in failed; try again');
      password.value = '';
      onSignedIn();
    } catch (failure) {
      error.textContent = failure.name === 'TimeoutError' ? 'Sign-in timed out; try again' : failure.message;
      password.select();
    } finally {
      submit.disabled = false;
    }
  });
  return { form, focus: () => username.focus() };
}
