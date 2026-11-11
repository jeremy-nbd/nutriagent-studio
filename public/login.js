const basePath = location.pathname.startsWith('/family/') ? '/family' : '';
const form = document.querySelector('#login-form');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  document.querySelector('#login-error').textContent = '';
  try {
    const response = await fetch(basePath + '/api/auth/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username: form.username.value.trim(), password: form.password.value})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '登录失败，请重试。');
    form.password.value = '';
    location.replace(basePath + '/');
  } catch (error) {
    document.querySelector('#login-error').textContent = error.message;
  } finally { button.disabled = false; }
});
