/* The uburoom account sign-in form: username and password, for the entry page.
 * Self-contained: mount(container) fills the container with the form and handles submission.
 * The server answers every failure the same way and rate-limits them; on success it sets the
 * ordinary browser session cookie, and `onSignedIn` (default: reload) takes over. */

async function authenticateAccount(username, password) {
  const response = await fetch('/api/uburoom-accounts/sign-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(15000),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || 'Sign-in failed; try again');
}

/**
 * @param {HTMLElement} container where the form goes (its contents are replaced)
 * @param {{onSignedIn?: () => void, idPrefix?: string, label?: string,
 *   authenticate?: (username: string, password: string) => Promise<unknown>,
 *   usernameMaxLength?: number}} [options]
 * @returns {{form: HTMLFormElement, focus: () => void}}
 */
export function mount(
  container,
  {
    onSignedIn = () => location.reload(),
    idPrefix = 'account-sign-in',
    label = 'Sign in with a uburoom account',
    authenticate = authenticateAccount,
    usernameMaxLength = 32,
  } = {},
) {
  const doc = container.ownerDocument;
  const node = (tag, parent, props = {}) => {
    const element = Object.assign(doc.createElement(tag), props);
    parent.append(element);
    return element;
  };
  container.replaceChildren();
  const form = node('form', container, { className: 'entry-form account-sign-in', noValidate: false });
  form.setAttribute('aria-label', label);
  node('label', form, { htmlFor: idPrefix + '-username', textContent: 'Username' });
  const username = node('input', form, {
    id: idPrefix + '-username',
    className: 'entry-password',
    type: 'text',
    autocomplete: 'username',
    autocapitalize: 'none',
    spellcheck: false,
    maxLength: usernameMaxLength,
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
      await authenticate(username.value, password.value);
      password.value = '';
      onSignedIn();
    } catch (failure) {
      error.textContent = failure.name === 'TimeoutError' ? 'Sign-in timed out; try again' : failure.message;
      password.select();
      // Every Sign in shows a result: the error, wherever the form sits in a scrolling panel.
      submit.scrollIntoView({ block: 'nearest' });
    } finally {
      submit.disabled = false;
    }
  });
  return { form, focus: () => username.focus() };
}
