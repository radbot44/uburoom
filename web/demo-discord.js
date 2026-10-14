'use strict';
const discordDemoState=new URLSearchParams(location.search).get('state');
if(/^[a-f0-9]{64}$/.test(discordDemoState||''))for(const persona of ['host','guest','guest2'])document.getElementById('demo-'+persona).href='/auth/callback?'+new URLSearchParams({state:discordDemoState,code:persona});
