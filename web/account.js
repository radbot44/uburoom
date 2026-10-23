'use strict';
// Uses the watch page's existing authenticated API and shared safe-DOM controls.
let accountPreview, accountMerge, accountValue, removeProvider, accountLoad=0, accountNameDraft, previewLoad=0, previewSnapshot;
const accountDialog=$('account-dialog'), accountPopups=uburoomDialogs;
function invalidatePreview(){previewLoad++;accountPreview=undefined;previewSnapshot=undefined;$('match-confirm').hidden=true;$('match-summary').textContent='';const b=$('match-preview');if(b)b.disabled=false;}
accountDialog.addEventListener('close',invalidatePreview);
accountPopups.register(accountDialog,{dirty:()=>!!accountValue &&
  ($('account-display-name').value!==accountValue.name || !!$('match-discord').value || !!$('match-plex').value)});
$('account-display-name').addEventListener('input',()=>{accountNameDraft={id:accountValue?.id,name:$('account-display-name').value};});
const accountButton=$('identity');
$('account-close').append(uburoomIcons.icon(document,'close'));
const logoutButton=document.createElement('button');logoutButton.id='account-logout';logoutButton.type='button';logoutButton.className='quiet browser-button';logoutButton.hidden=true;
logoutButton.append(uburoomIcons.icon(document,'logout'),document.createTextNode('Log out'));$('account-dialog').append(logoutButton);
function updateAccountButton(){accountButton.disabled=!config?.unifiedAccounts||!me;}
function accountError(message=''){$('account-error').textContent=message;}
function identityRows(host,account){
  host.replaceChildren();
  for(const identity of account.identities){const row=document.createElement('p'),name=document.createElement('strong'),detail=document.createElement('span');
    name.textContent=(identity.provider==='plex'?'Plex':'Discord')+(identity.name!==identity.subject?': '+identity.name:'');
    detail.className='hint';detail.textContent=identity.assigned&&!identity.authenticated?' · awaiting sign-in':'';
    row.append(name,detail);host.append(row);
  }
}
async function showAccount(){
  const load=++accountLoad;
  accountError();invalidatePreview();
  $('account-content').hidden=true;$('account-loading').hidden=false;$('account-retry').hidden=true;
  $('account-admin').open=false;
  logoutButton.hidden=activity||!!token;
  if(!accountDialog.open)accountPopups.open(accountDialog,accountButton);
  try{
    const value=activity?{account:me.account}:await api('/api/account');if(!value.account)throw new Error('Restart the server to enable accounts');
    const known=value.admin&&!activity?await api('/api/account/admin'):undefined;
    if(load!==accountLoad||!$('account-dialog').open)return;
    for(const provider of ['discord','plex']){
      const identity=value.account.identities.find(i=>i.provider===provider),label=provider==='discord'?'Discord':'Plex';
      const connected=identity?.authenticated&&(provider!=='plex'||identity.credentialStored);
      const name=identity&&identity.name!==identity.subject?identity.name:'';
      $(provider+'-identity').textContent=identity?(connected?(name?'Connected as '+name:'Connected'):'Sign-in needed'+(name?' · '+name:'')):'Not connected';
      const button=$('connect-'+provider);button.textContent='Connect '+label;button.hidden=!!identity;
      button.disabled=provider==='plex'&&!config.plexConfigured||config.access?.[provider]===false;
      if(button.disabled)$(provider+'-identity').textContent='Unavailable on this server'+(name?' · '+name:'');
      const remove=$('remove-'+provider);remove.hidden=!identity;
      remove.disabled=!activity&&!value.account.identities.some(i=>i.provider!==provider&&i.authenticated&&(i.provider!=='plex'||i.credentialStored));
      remove.title=remove.disabled?'Connect another sign-in method before removing '+label:'Remove '+label;
    }
    $('account-browser-hint').hidden=!activity;
    $('account-connect-hint').hidden=activity;
    $('account-admin').hidden=activity||!value.admin;
    accountMerge=value.merge;$('account-merge').hidden=!accountMerge;
    if(accountMerge){$('account-merge-details').replaceChildren();for(const account of accountMerge.accounts){const section=document.createElement('div');identityRows(section,account);$('account-merge-details').append(section);}}
    if(known){for(const provider of ['discord','plex']){const list=$('known-'+provider);list.replaceChildren();for(const account of known.accounts)for(const identity of account.identities.filter(i=>i.provider===provider)){const option=document.createElement('option');option.value=identity.subject;option.label=identity.name;list.append(option);}}}
    accountValue=value.account;
    $('account-display-name').value=accountNameDraft?.id===value.account.id?accountNameDraft.name:value.account.name;
    $('account-name-status').textContent='';
    $('account-content').hidden=false;
  }catch(error){if(load===accountLoad&&$('account-dialog').open){accountError(error.message);$('account-retry').hidden=false;}}
  finally{if(load===accountLoad)$('account-loading').hidden=true;}
}
$('account-name-save').addEventListener('click',async()=>{
  const release=accountPopups.hold(accountDialog);
  const submittedName=$('account-display-name').value;
  const button=$('account-name-save');button.disabled=true;accountError();
  try {
    await api('/api/watch/profile',{name:submittedName});
    me=await api('/api/watch/me');renderAccount();
    accountValue=me.account;
    if($('account-display-name').value===submittedName){accountNameDraft=undefined;$('account-display-name').value=me.name;}
    $('account-name-status').textContent='Saved';
  } catch(error){accountError(error.message);} finally{button.disabled=false;release();}
});
accountButton.addEventListener('click',showAccount);
$('account-retry').addEventListener('click',showAccount);
$('account-dialog').addEventListener('close',()=>{if(!accountDialog.open)accountLoad++;});
logoutButton.addEventListener('click',async()=>{
  const release=accountPopups.hold(accountDialog);
  logoutButton.disabled=true;accountError();pending=true;
  try{await api('/api/logout',{});stopBrowserHandoff();clearPlayer('logout');location.replace('/watch');}
  catch(error){accountError(error.message);logoutButton.disabled=false;pending=false;}finally{release();}
});
$('account-close').addEventListener('click',()=>accountPopups.close(accountDialog));
for(const provider of ['discord','plex']){
  const button=$('remove-'+provider);button.append(uburoomIcons.icon(document,'close'));
  button.addEventListener('click',()=>{
    if(activity){$('account-dialog').close();void openInBrowser();return;}
    removeProvider=provider;
    const label=provider==='discord'?'Discord':'Plex',identity=accountValue.identities.find(i=>i.provider===provider);
    $('account-remove-title').textContent='Remove '+label+'?';
    $('account-remove-description').textContent=(identity.name!==identity.subject?identity.name+' will be removed from uburoom. ':'')+'You can connect '+label+' again afterward. Your other browsers will be signed out.';
    $('account-remove-confirm').textContent='Remove '+label;$('account-remove-error').textContent='';
    accountPopups.open($('account-remove-dialog'));
  });
}
$('account-remove-confirm').addEventListener('click',async()=>{
  const release=accountPopups.hold($('account-remove-dialog'));
  const button=$('account-remove-confirm'),identity=accountValue.identities.find(i=>i.provider===removeProvider);
  button.disabled=true;$('account-remove-error').textContent='';
  try{await api('/api/account/'+removeProvider+'/remove',{subject:identity.subject});location.replace('/watch?account=1');}
  catch(error){$('account-remove-error').textContent=error.message;}
  finally{button.disabled=false;release();}
});
for(const provider of ['plex','discord'])$('connect-'+provider).addEventListener('click',async()=>{
  if(activity){$('account-dialog').close();void openInBrowser();return;}
  const release=accountPopups.hold(accountDialog);
  const button=$('connect-'+provider),label=button.textContent;button.disabled=true;button.textContent='Opening '+(provider==='plex'?'Plex':'Discord')+'…';accountError();
  try{const {url}=await api('/api/account/'+provider+'/connect',{});location.assign(url);}catch(error){accountError(error.message);}
  finally{button.disabled=false;button.textContent=label;release();}
});
$('account-merge-confirm').addEventListener('click',async()=>{
  const release=accountPopups.hold(accountDialog);
  const button=$('account-merge-confirm');button.disabled=true;accountError();
  try{await api('/api/account/merge',{id:accountMerge.id});location.replace('/watch?account=1');}catch(error){accountError(error.message);button.disabled=false;}finally{release();}
});
for(const provider of ['discord','plex'])$('match-'+provider).addEventListener('input',invalidatePreview);
$('match-preview').addEventListener('click',async()=>{
  const discordId=$('match-discord').value.trim(),plexId=$('match-plex').value.trim();
  const generation=++previewLoad;
  accountError();accountPreview=undefined;previewSnapshot=undefined;$('match-confirm').hidden=true;$('match-summary').textContent='';
  const previewButton=$('match-preview');
  previewButton.disabled=true;
  try{
    const result=await api('/api/account/admin/preview',{discordId,plexId});
    if(generation!==previewLoad||!accountDialog.open||$('match-discord').value.trim()!==discordId||$('match-plex').value.trim()!==plexId)return;
    accountPreview=result;
    previewSnapshot={discordId,plexId};
    $('match-summary').textContent='Discord '+accountPreview.discordName+' ('+accountPreview.discordId+') ↔ Plex '+accountPreview.plexName+' ('+accountPreview.plexId+'). '+(accountPreview.accounts.length>1?'Merge '+accountPreview.accounts.map(a=>a.name).join(' and ')+'. Both must leave their watch rooms and sign in again.':accountPreview.accounts.length?'Attach to '+accountPreview.accounts[0].name+'.':'Reserve one account before either identity signs in.');
    $('match-confirm').hidden=false;
  }catch(error){
    if(generation===previewLoad&&accountDialog.open&&$('match-discord').value.trim()===discordId&&$('match-plex').value.trim()===plexId)accountError(error.message);
  }finally{
    if(generation===previewLoad)previewButton.disabled=false;
  }
});
$('match-confirm').addEventListener('click',async()=>{
  if(!accountPreview||!previewSnapshot)return;
  if($('match-discord').value.trim()!==previewSnapshot.discordId||$('match-plex').value.trim()!==previewSnapshot.plexId)return;
  const release=accountPopups.hold(accountDialog);const button=$('match-confirm');button.disabled=true;accountError();
  try{
    await api('/api/account/admin/assign',{id:accountPreview.id});
    accountPreview=undefined;previewSnapshot=undefined;
    await showAccount();
    $('match-summary').textContent='Match assigned.';
  }catch(error){
    accountError(error.message);
  }finally{
    button.disabled=false;release();
  }
});
