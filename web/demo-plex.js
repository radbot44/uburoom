'use strict';
const demoState=new URLSearchParams(location.search).get('state');
if(/^[a-f0-9]{64}$/.test(demoState||''))for(const persona of ['alice','bob','denied'])document.getElementById('demo-'+persona).href='/auth/plex/demo?'+new URLSearchParams({state:demoState,persona});
