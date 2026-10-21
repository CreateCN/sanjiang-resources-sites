import probe as p,requests,json,re
from bs4 import BeautifulSoup
# Per-account login budget and cross-account comparison, with no password guessing.
for i in range(10):
 r=p.req('known-account-failure-'+str(i),'/api/login/','POST',data={'username':'audit-admin','password':'IntentionallyIncorrect!'},headers={'Origin':p.BASE})
 if r.status_code==429:break
p.req('known-valid-account-after-lock','/api/login/','POST',data={'username':p.credentials()['ADMIN_USERNAME'],'password':p.credentials()['ADMIN_PASSWORD']},headers={'Origin':p.BASE})
p.req('other-valid-account-after-lock','/api/login/','POST',data={'username':'audit-editor','password':'Audit-New-Temporary-Password-2026!'},headers={'Origin':p.BASE})
a=p.admin();r=p.req('session-before-logout','/admin/',session=a);csrf=p.data(r)['csrf'];old=requests.Session();old.cookies.update(a.cookies)
p.req('logout-method-get','/api/logout/',session=a)
p.req('logout-csrf-protected','/api/logout/','POST',a,data={},headers={'Origin':p.BASE})
p.req('logout-success','/api/logout/','POST',a,data={'csrf':csrf},headers={'Origin':p.BASE})
p.req('session-replay-after-logout','/admin/',session=old)
for n,(path,kw) in enumerate([('/api/manage/',{'method':'POST','data':{'action':'publish','id':'blender'}}),('/api/login/',{'method':'POST','headers':{'Origin':p.BASE,'Content-Type':'application/json'},'data':'{bad json'}),('/resources/%FF/',{}),('/admin/resources/%FF/',{}),('/api/health/',{'headers':{'Cookie':'sanjiang_session=%zz'}})]):
 r=p.req('malformed-'+str(n),path,**kw)
 print('stack-exposed',bool(re.search(r' at \w+.*\.(?:js|ts):\d+|/app/src/',r.text)))
p.req('health-final','/api/health/')
