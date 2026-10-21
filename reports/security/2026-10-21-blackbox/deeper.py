import probe as p,requests,pickle,json,re
from bs4 import BeautifulSoup
s=requests.Session();s.cookies.update(pickle.loads((p.ROOT/'editor-cookies.private').read_bytes()));r=p.req('content-editor-session','/admin/',session=s);csrf=p.data(r)['csrf']
marker='</script><script>window.__audit_xss="executed"</script><img src=x onerror="window.__audit_xss=1">'
obj=json.loads((p.ROOT/'resource-template.json').read_text());obj.update(id='audit-xss-resource',title='Audit '+marker,summary=marker,details=marker+'\n\n[x](javascript:alert(1))\n\n[x](data:text/html,hello)',license=marker)
p.req('xss-resource-valid-image','/api/manage/','POST',s,data={'csrf':csrf,'action':'save-resource','version':'','resource':json.dumps(obj,ensure_ascii=False)},headers={'Origin':p.BASE})
p.req('xss-resource-preview','/admin/preview/resources/audit-xss-resource/',session=s)
a=p.admin();r=p.req('admin-before-publish','/admin/',session=a);ac=p.data(r)['csrf']
# Publish only synthetic local test objects to exercise the real public renderer.
for typ,ident,path in [('resource','audit-xss-resource','/admin/resources/audit-xss-resource/'),('guide','audit-xss-guide','/admin/guides/audit-xss-guide/')]:
 r=p.req('before-publish-'+typ,path,session=a);d=p.data(r,'/api/manage/');
 p.req('publish-'+typ,'/api/manage/','POST',a,data={'csrf':ac,'action':'publish' if typ=='resource' else 'publish-guide','id':ident,'slug':ident,'version':d.get('version','1')},headers={'Origin':p.BASE})
 path=('/resources/' if typ=='resource' else '/guides/')+ident+'/'
 r=p.req('published-xss-'+typ,path)
 soup=BeautifulSoup(r.text,'html.parser');print('PUBLIC XSS DOM',typ,'eventnodes',len(soup.select('[onerror],[onload]')),'injected-scripts',[x.text for x in soup.select('script') if '__audit_xss' in x.text][:4])
# Anonymous stored feedback, including literal HTML: inspect its administrator view.
feedback={'resourceId':'','kind':'其他建议','title':'AUDIT '+marker,'body':'AUDIT_FEEDBACK '+marker,'website':''}
p.req('feedback-stored-payload','/api/reports/','POST',data=feedback,headers={'Origin':p.BASE})
r=p.req('feedback-admin-render','/admin/reports/',session=a);soup=BeautifulSoup(r.text,'html.parser');print('FEEDBACK XSS DOM',len(soup.select('[onerror],[onload]')),[x.text for x in soup.select('script') if '__audit_xss' in x.text])
# Confirm password reset invalidates the old editor session.
p.req('reset-editor-password','/api/manage/','POST',a,data={'csrf':ac,'action':'update-user','id':'2','role':'editor','active':'true','password':'Audit-New-Temporary-Password-2026!'},headers={'Origin':p.BASE})
p.req('old-editor-session-after-reset','/admin/',session=s)
p.req('old-editor-write-after-reset','/api/manage/','POST',s,data={'csrf':csrf,'action':'save-guide','slug':'invalidated-session','title':'must not save','body':'must not save'},headers={'Origin':p.BASE})
# A small, finite anonymous burst; no resource exhaustion or concurrency storm.
for i in range(12):
 p.req('feedback-rate-'+str(i),'/api/reports/','POST',data={'resourceId':'','kind':'其他建议','title':'Audit bounded rate '+str(i),'body':'Controlled local security audit submission.','website':''},headers={'Origin':p.BASE,'X-Forwarded-For':f'198.51.100.{i+1}'})
for i in range(15):
 r=p.req('login-rate-'+str(i),'/api/login/','POST',data={'username':'unknown-audit-'+str(i),'password':'IntentionallyIncorrect!'},headers={'Origin':p.BASE,'X-Forwarded-For':f'198.51.100.{i+1}'})
 if r.status_code==429:break
p.req('valid-admin-after-anonymous-burst','/api/login/','POST',data={'username':p.credentials()['ADMIN_USERNAME'],'password':p.credentials()['ADMIN_PASSWORD']},headers={'Origin':p.BASE})
p.req('valid-editor-after-anonymous-burst','/api/login/','POST',data={'username':'audit-editor','password':'Audit-New-Temporary-Password-2026!'},headers={'Origin':p.BASE})
