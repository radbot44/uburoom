'use strict';
// Uses the watch page's existing authenticated API and shared safe-DOM controls.
let accountPreview, accountMerge;
const accountButton=document.createElement('button');accountButton.id='account-settings';accountButton.className='icon-button';accountButton.type='button';accountButton.title='Account';accountButton.setAttribute('aria-label','Account');accountButton.hidden=true;
accountButton.append(RadTVUI.icon(document,'settings'));document.querySelector('.account-actions').insertBefore(accountButton,$('open-browser'));
$('account-close').append(RadTVUI.icon(document,'close'));
const logoutButton=document.createElement('button');logoutButton.id='account-logout';logoutButton.type='button';logoutButton.className='quiet browser-button';logoutButton.hidden=true;
logoutButton.append(RadTVUI.icon(document,'logout'),document.createTextNode('Log out'));$('account-dialog').append(logoutButton);
function updateAccountButton(){accountButton.hidden=!config?.unifiedAccounts||!me;}
function accountError(message=''){$('account-error').textContent=message;}
function identityRows(host,account){
  host.replaceChildren();
  for(const identity of account.identities){const row=document.createElement('p'),name=document.createElement('strong'),detail=document.createElement('span');
    name.textContent=(identity.provider==='plex'?'Plex':'Discord')+': '+identity.name;
    detail.className='hint';detail.textContent=' · '+identity.subject+(identity.assigned&&!identity.authenticated?' · owner-assigned, awaiting sign-in':'');
    row.append(name,detail);host.append(row);
  }
}
async function showAccount(){
  accountError();accountPreview=undefined;$('match-confirm').hidden=true;
  logoutButton.hidden=activity||!!token;
  try{
    const value=activity?{account:me.account}:await api('/api/account');if(!value.account)throw new Error('Restart the server to enable accounts');
    $('account-id').hidden=!value.admin;$('account-id').textContent='uburoom account '+value.account.id;identityRows($('account-identities'),value.account);
    const discord=value.account.identities.find(i=>i.provider==='discord'),plex=value.account.identities.find(i=>i.provider==='plex');
    $('connect-discord').hidden=!!discord?.authenticated;$('connect-plex').textContent=plex?.credentialStored?'Reconnect Plex':'Connect Plex';
    $('account-browser-hint').hidden=!activity;
    $('account-admin').hidden=activity||!value.admin;
    accountMerge=value.merge;$('account-merge').hidden=!accountMerge;
    if(accountMerge){$('account-merge-details').replaceChildren();for(const account of accountMerge.accounts){const section=document.createElement('div');identityRows(section,account);$('account-merge-details').append(section);}}
    if(value.admin&&!activity){const {accounts}=await api('/api/account/admin');for(const provider of ['discord','plex']){const list=$('known-'+provider);list.replaceChildren();for(const account of accounts)for(const identity of account.identities.filter(i=>i.provider===provider)){const option=document.createElement('option');option.value=identity.subject;option.label=identity.name;list.append(option);}}}
    if(!$('account-dialog').open)$('account-dialog').showModal();
  }catch(error){accountError(error.message);if(!$('account-dialog').open)$('account-dialog').showModal();}
}
accountButton.addEventListener('click',showAccount);
logoutButton.addEventListener('click',async()=>{
  logoutButton.disabled=true;accountError();pending=true;
  try{await api('/api/logout',{});stopBrowserHandoff();clearPlayer();hidePlaybackTest();location.replace('/watch');}
  catch(error){accountError(error.message);logoutButton.disabled=false;pending=false;}
});
$('account-close').addEventListener('click',()=>$('account-dialog').close());
for(const provider of ['plex','discord'])$('connect-'+provider).addEventListener('click',async()=>{
  if(activity){$('account-dialog').close();void openInBrowser();return;}
  const button=$('connect-'+provider);button.disabled=true;accountError();
  try{const {url}=await api('/api/account/'+provider+'/connect',{});location.assign(url);}catch(error){accountError(error.message);button.disabled=false;}
});
$('account-merge-confirm').addEventListener('click',async()=>{
  const button=$('account-merge-confirm');button.disabled=true;accountError();
  try{await api('/api/account/merge',{id:accountMerge.id});location.replace('/watch?account=1');}catch(error){accountError(error.message);button.disabled=false;}
});
for(const provider of ['discord','plex'])$('match-'+provider).addEventListener('input',()=>{accountPreview=undefined;$('match-confirm').hidden=true;$('match-summary').textContent='';});
$('match-preview').addEventListener('click',async()=>{
  accountError();accountPreview=undefined;$('match-confirm').hidden=true;
  try{accountPreview=await api('/api/account/admin/preview',{discordId:$('match-discord').value.trim(),plexId:$('match-plex').value.trim()});
    $('match-summary').textContent='Discord '+accountPreview.discordName+' ('+accountPreview.discordId+') ↔ Plex '+accountPreview.plexName+' ('+accountPreview.plexId+'). '+(accountPreview.accounts.length>1?'Merge '+accountPreview.accounts.map(a=>a.name).join(' and ')+'. Both must leave their watch sessions and sign in again.':accountPreview.accounts.length?'Attach to '+accountPreview.accounts[0].name+'.':'Reserve one account before either identity signs in.');
    $('match-confirm').hidden=false;
  }catch(error){accountError(error.message);}
});
$('match-confirm').addEventListener('click',async()=>{
  if(!accountPreview)return;const button=$('match-confirm');button.disabled=true;accountError();
  try{await api('/api/account/admin/assign',{id:accountPreview.id});accountPreview=undefined;await showAccount();$('match-summary').textContent='Match assigned.';}catch(error){accountError(error.message);}
  finally{button.disabled=false;}
});
