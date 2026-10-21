import probe as p
from bs4 import BeautifulSoup
paths=['/admin/','/admin/users/','/admin/resources/blender/','/admin/preview/resources/blender/','/admin/preview/blender/','/admin/import/','/admin/audit/','/admin/metrics/','/admin/maintenance/','/api/export/','/api/manage/','/api/health/','/robots.txt','/sitemap.xml','/.env','/.git/config','/data/site.sqlite','/backups/','/package.json','/src/server/security.ts','/server/entry.mjs','/_astro/','/api/reports/']
for n,path in enumerate(paths):p.req('anon-surface-'+str(n),path)
for n,path in enumerate(['/admin/%2e%2e/.env','/..%2f.env','/%2e%2e/%2e%2e/etc/passwd','/admin//users/','//admin/users/','/api/health/?callback=alert(1)']):p.req('path-'+str(n),path)
for n,(path,method,h) in enumerate([('/api/manage/','OPTIONS',{'Origin':'https://evil.invalid','Access-Control-Request-Method':'POST'}),('/api/health/','GET',{'Origin':'https://evil.invalid'}),('/','GET',{'Host':'evil.invalid'}),('/','GET',{'X-Forwarded-Host':'evil.invalid','X-Forwarded-Proto':'http'}),('/','TRACE',{})]):p.req('headers-'+str(n),path,method,headers=h)
for n,path in enumerate(['/?q=%3Csvg%2Fonload%3Dalert(1)%3E','/feedback/?title=%22%3E%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&resourceId=%22%3E%3Csvg%20onload%3Dalert(1)%3E',"/resources/%27%20OR%201=1--/"]):
 r=p.req('reflected-'+str(n),path); soup=BeautifulSoup(r.text,'html.parser');print('injected-elements',len(soup.select('svg[onload],img[onerror]')))
s=p.admin(); r=p.req('admin-for-csrf','/admin/',session=s);csrf=p.data(r)['csrf']
base={'action':'create-user','username':'csrf-probe','password':'Audit-No-Real-Account-123!','role':'editor'}
for n,(token,origin) in enumerate([(None,p.BASE),(csrf,'https://evil.invalid'),(csrf,'null'),(csrf,None),('bad',p.BASE)]):
 d=dict(base)
 if token is not None:d['csrf']=token
 p.req('csrf-'+str(n),'/api/manage/','POST',s,data=d,headers={'Origin':origin} if origin is not None else {})
for n,origin in enumerate(['https://evil.invalid','null',None]):
 p.req('login-origin-'+str(n),'/api/login/','POST',data={'username':"' OR 1=1--",'password':'wrong'},headers={'Origin':origin} if origin is not None else {})
p.req('nginx-body-limit','/api/reports/','POST',data={'body':'X'*1100000},headers={'Origin':p.BASE})
