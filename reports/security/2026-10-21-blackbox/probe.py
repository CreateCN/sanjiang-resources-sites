import requests, pathlib, json, re, urllib3, time
from bs4 import BeautifulSoup
urllib3.disable_warnings()
ROOT=pathlib.Path('/tmp/sanjiang-blackbox-20261021')
BASE='https://localhost:8443'
seq=max([int(x.name.split('-')[0]) for x in (ROOT/'evidence').glob('*.json')]+[0])

def req(label, path='/', method='GET', session=None, **kw):
 global seq
 seq+=1
 s=session or requests.Session()
 start=time.time()
 r=s.request(method, BASE+path,verify=False,allow_redirects=False,timeout=25,**kw)
 r.encoding='utf-8'
 h=dict(r.headers)
 for key in h:
  if key.lower()=='set-cookie': h[key]=re.sub(r'^([^=]+)=[^;]*',r'\1=<redacted>',h[key])
 safe_data={k:('<redacted>' if k in ('csrf','password') else v) for k,v in kw.get('data',{}).items()} if isinstance(kw.get('data',{}),dict) else '<raw body>'
 meta={'request_data':safe_data,'request_headers':{k:v for k,v in kw.get('headers',{}).items() if k.lower() not in ('cookie','authorization')},'label':label,'method':method,'path':path,'status':r.status_code,'headers':h,'elapsed':round(time.time()-start,3),'bytes':len(r.content)}
 p=ROOT/'evidence'/f'{seq:03}-{label}'
 p.with_suffix('.json').write_text(json.dumps(meta,indent=2,ensure_ascii=False))
 p.with_suffix('.html').write_text(re.sub(r'(name="(?:csrf|_csrf|csrfToken)" value=")[^"]+',r'\1<redacted>',r.text))
 print(label,method,path,r.status_code,h.get('location',''),len(r.content))
 return r

def forms(r):
 soup=BeautifulSoup(r.text,'html.parser')
 return [{'action':f.get('action'),'method':f.get('method'),'fields':[{k:x.get(k) for k in ('name','type','value') if x.get(k) is not None} for x in f.select('input,select,textarea,button')]} for f in soup.select('form')]

def data(r, action=None):
 soup=BeautifulSoup(r.text,'html.parser'); f=soup.find('form',action=action) if action else soup.find('form')
 return {x['name']:x.get('value','') for x in f.select('input[name]') if x.get('type') not in ('checkbox','radio','submit')}

def credentials():
 return dict(x.split('=',1) for x in (ROOT/'runtime.env').read_text().splitlines())

def login():
 s=requests.Session(); r=req('login-form','/admin/login/',session=s)
 d=data(r); env=credentials(); d.update(username=env['ADMIN_USERNAME'],password=env['ADMIN_PASSWORD'])
 r=req('login-success', '/api/login/', 'POST',s,data=d,headers={'Origin':BASE})
 return s

def admin():
 import pickle
 s=requests.Session(); s.cookies.update(pickle.loads((ROOT/'admin-cookies.private').read_bytes())); return s
