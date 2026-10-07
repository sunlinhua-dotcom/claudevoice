/* ClaudeVoice Service Worker —— Web Push + 通知点击 */
'use strict';
self.addEventListener('install', function(e){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });

function idbGet(k){
  return new Promise(function(res){
    try{
      var rq=indexedDB.open('cv',1);
      rq.onupgradeneeded=function(){ rq.result.createObjectStore('kv'); };
      rq.onsuccess=function(){
        try{ var g=rq.result.transaction('kv','readonly').objectStore('kv').get(k);
          g.onsuccess=function(){ res(g.result); }; g.onerror=function(){ res(null); };
        }catch(e){ res(null); }
      };
      rq.onerror=function(){ res(null); };
    }catch(e){ res(null); }
  });
}

var LAB={done:'已完成',waiting:'等待输入',permission:'需要授权',notification:'通知',subagent:'子任务',failed:'任务失败'};

self.addEventListener('push', function(e){
  e.waitUntil((async function(){
    var ev=null;
    try{ if(e.data) ev=e.data.json(); }catch(_){}
    if(!ev){ // 无 payload：去服务端取最近一条（仅最小信息）
      try{
        var tk=await idbGet('token');
        var u='latest'+(tk?('?token='+encodeURIComponent(tk)):'');
        var r=await fetch(u);
        if(r.ok) ev=(await r.json()).event;
      }catch(_){}
    }
    var title = ev ? (ev.project+' · '+(LAB[ev.kind]||'')) : 'ClaudeVoice 信号';
    var body  = ev ? (ev.title||'有新信号') : '有新信号，点开查看';
    await self.registration.showNotification(title, {
      body: body, tag:'cv', renotify:true, requireInteraction: !!(ev&&ev.needsAction),
      icon:'assets/icon-192.png', badge:'assets/icon-192.png', data:{ url:'./' }
    });
  })());
});

self.addEventListener('notificationclick', function(e){
  e.notification.close();
  e.waitUntil((async function(){
    var url=(e.notification.data&&e.notification.data.url)||'./';
    var all=await clients.matchAll({type:'window', includeUncontrolled:true});
    for(var i=0;i<all.length;i++){ if('focus' in all[i]){ try{ await all[i].focus(); return; }catch(_){} } }
    if(clients.openWindow) return clients.openWindow(url);
  })());
});
