'use strict';
fetch('/api/account/auth-error',{signal:AbortSignal.timeout(10000)}).then(response=>response.json()).then(value=>{document.getElementById('auth-error').textContent=value.error;}).catch(()=>{document.getElementById('auth-error').textContent='Sign-in is unavailable. Return to uburoom and try again.';});
