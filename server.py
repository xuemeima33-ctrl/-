"""Dependency-free, fail-closed weather proxy. Run: python3 server.py."""
import concurrent.futures
import hashlib
import hmac
import http.client
import json
import os
import re
import socket
import sqlite3
import ssl
import time
import uuid
from email.utils import parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit
from weather import query_text, public_addresses, normalize, failure

ROOT=Path(__file__).resolve().parent
HOST='api.weatherapi.com'
QUERY_BUDGET=10
PATHS={'search':'/v1/search.json','current':'/v1/current.json','forecast':'/v1/forecast.json'}

class ServiceError(Exception):
    def __init__(self,code='unavailable',status=503,retry=30):
        self.code,self.status,self.retry=code,status,retry

def retry_after(value,now=None):
    try:
        seconds=int(value) if re.fullmatch(r'\d+',str(value)) else parsedate_to_datetime(value).timestamp()-(time.time() if now is None else now)
        return min(3600,max(1,int(__import__('math').ceil(seconds)))) if seconds>0 else 30
    except (ValueError,TypeError,OverflowError): return 30

class Store:
    """SQLite transactions share counters across workers using the same local volume."""
    def __init__(self,path):
        self.path=path
        with self.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS counts (key TEXT PRIMARY KEY, start REAL, n INTEGER)')
            db.execute('CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, fetched REAL, value TEXT)')
            db.execute('CREATE TABLE IF NOT EXISTS cities (key TEXT PRIMARY KEY, value TEXT, expires REAL)')
    def db(self):
        return sqlite3.connect(self.path,timeout=2)
    def consume(self,key,limit,window,now=None):
        now=time.time() if now is None else now
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT start,n FROM counts WHERE key=?',(key,)).fetchone()
            start,n=row if row and now-row[0]<window else (now,0)
            if n>=limit: raise ServiceError('rate_limited' if key.startswith('ip:') else 'quota_exhausted',429,retry_after(str(max(1,int(window-(now-start))))))
            db.execute('INSERT OR REPLACE INTO counts VALUES (?,?,?)',(key,start,n+1))
            db.execute('DELETE FROM counts WHERE start<?',(now-max(window,86400),))
    def get(self,key,ttl,now):
        with self.db() as db: row=db.execute('SELECT fetched,value FROM cache WHERE key=?',(key,)).fetchone()
        return (row[0],json.loads(row[1])) if row and 0<=now-row[0]<ttl else None
    def put(self,key,value,fetched):
        with self.db() as db:
            db.execute('INSERT OR REPLACE INTO cache VALUES (?,?,?)',(key,fetched,json.dumps(value)))
            db.execute('DELETE FROM cache WHERE fetched<?',(fetched-3600,))
    def city_put(self,key,value):
        with self.db() as db:
            db.execute('INSERT OR REPLACE INTO cities VALUES (?,?,?)',(key,json.dumps(value),time.time()+86400))
            db.execute('DELETE FROM cities WHERE expires<?',(time.time(),))
    def city_get(self,key):
        with self.db() as db: row=db.execute('SELECT value FROM cities WHERE key=? AND expires>?',(key,time.time())).fetchone()
        if not row: raise ServiceError('invalid_city',400)
        return json.loads(row[0])

class PinnedHTTPS(http.client.HTTPSConnection):
    def connect(self):
        addresses=public_addresses(list(dict.fromkeys(r[4][0] for r in socket.getaddrinfo(HOST,443,type=socket.SOCK_STREAM))))
        # Pin the resolved address; TLS still verifies the original hostname.
        remaining=getattr(self,'deadline',time.monotonic()+self.timeout)-time.monotonic()
        if remaining<=0: raise TimeoutError()
        sock=socket.create_connection((addresses[0],443),min(self.timeout,remaining))
        try: self.sock=self._context.wrap_socket(sock,server_hostname=HOST)
        except BaseException:
            sock.close()
            raise

class Provider:
    def __init__(self,env,store): self.env,self.store=env,store
    def request(self,module,q,deadline):
        if module not in PATHS: raise ServiceError('invalid_data',400)
        for attempt in range(2):
            remaining=deadline-time.monotonic()
            if remaining<=0: raise ServiceError('timeout',504)
            self.store.consume('quota:'+self.env['WEATHER_ACCOUNT'],int(self.env['QUOTA_LIMIT']),int(self.env['QUOTA_WINDOW']))
            params={'key':self.env['WEATHER_API_KEY'],'q':q,'lang':'zh','days':6,'aqi':'no','alerts':'no'}
            conn=PinnedHTTPS(HOST,timeout=min(10,remaining),context=ssl.create_default_context())
            conn.deadline=deadline
            try:
                conn.request('GET',PATHS[module]+'?'+urlencode(params),headers={'Accept':'application/json'})
                response=conn.getresponse()
                if response.status>=500:
                    if attempt==0: continue
                    raise ServiceError()
                if response.status==429: raise ServiceError('rate_limited',429,retry_after(response.getheader('Retry-After')))
                if response.status!=200: raise ServiceError()
                # Bound body size; do not reflect provider messages, URL or credentials.
                payload=response.read(2_000_001)
                if len(payload)>2_000_000: raise ServiceError('invalid_data')
                if time.monotonic()>deadline: raise ServiceError('timeout',504)
                return json.loads(payload)
            except (socket.timeout,TimeoutError): raise ServiceError('timeout',504)
            except (ssl.SSLError,ValueError): raise ServiceError('invalid_data')
            except (ConnectionError,socket.gaierror,http.client.HTTPException,OSError):
                if attempt: raise ServiceError()
            finally: conn.close()
        raise ServiceError()

class App:
    def __init__(self,env=None,store=None,provider=None):
        self.env=dict(os.environ if env is None else env)
        self.store=store
        self.provider=provider
    def configure(self):
        required=['WEATHER_API_KEY','WEATHER_ACCOUNT','WEATHER_ALLOWED_HOSTS','IP_LIMIT','IP_WINDOW','QUOTA_LIMIT','QUOTA_WINDOW','WEATHER_DB']
        if any(not self.env.get(k) for k in required) or self.env.get('WEATHER_ALLOWED_HOSTS')!=HOST: raise ServiceError()
        try:
            if any(int(self.env[k])<=0 for k in ['IP_LIMIT','IP_WINDOW','QUOTA_LIMIT','QUOTA_WINDOW']): raise ValueError()
        except ValueError: raise ServiceError()
        if self.store is None: self.store=Store(self.env['WEATHER_DB'])
        if self.provider is None: self.provider=Provider(self.env,self.store)
    def handle(self,path,params,ip):
        allowed={'/api/search':{'q'},'/api/weather':{'city_key','module','refresh'}}
        if path not in allowed: raise ServiceError('invalid_data',404)
        if set(params)-allowed[path] or any(len(v)!=1 for v in params.values()): raise ServiceError('invalid_data',400)
        if path=='/api/search':
            try: q=query_text(params.get('q',[''])[0])
            except ValueError: raise ServiceError('invalid_data',400)
        else:
            key=params.get('city_key',[''])[0]
            module=params.get('module',['all'])[0]
            refresh=params.get('refresh',['0'])[0]
            if not re.fullmatch(r'[a-f0-9]{32}',key) or module not in ('all','current','forecast') or refresh not in ('0','1'): raise ServiceError('invalid_city',400)
        self.configure()
        # Socket peer is trusted. X-Forwarded-For is deliberately never read.
        ipkey=hmac.new(self.env['WEATHER_API_KEY'].encode(),ip.encode(),hashlib.sha256).hexdigest()
        self.store.consume('ip:'+ipkey,int(self.env['IP_LIMIT']),int(self.env['IP_WINDOW']))
        reference=time.time()
        deadline=time.monotonic()+QUERY_BUDGET
        if path=='/api/search':
            pool=concurrent.futures.ThreadPoolExecutor(max_workers=1)
            future=pool.submit(self.provider.request,'search',q,deadline)
            try: raw=future.result(timeout=max(0,deadline-time.monotonic()))
            except concurrent.futures.TimeoutError: raise ServiceError('timeout',504)
            finally: pool.shutdown(wait=False,cancel_futures=True)
            if not isinstance(raw,list): raise ServiceError('invalid_data')
            candidates=[]
            seen=set()
            for row in raw:
                if not isinstance(row,dict): continue
                name,country,admin=(row.get(k) for k in ('name','country','region'))
                lat,lon=row.get('lat'),row.get('lon')
                coords=all(isinstance(v,(int,float)) and not isinstance(v,bool) for v in (lat,lon)) and -90<=lat<=90 and -180<=lon<=180
                valid=coords and all(isinstance(v,str) and v.strip() for v in (name,country))
                identity=f'{lat},{lon}' if coords else str(row.get('id',''))
                key=hmac.new(self.env['WEATHER_API_KEY'].encode(),identity.encode(),hashlib.sha256).hexdigest()[:32] if valid else None
                if key and key in seen: continue
                if key: seen.add(key)
                city={'city_key':key,'name':name if isinstance(name,str) else '', 'country':country if isinstance(country,str) else '', 'admin':admin if isinstance(admin,str) else '', 'lat':lat if coords else None,'lon':lon if coords else None}
                if valid: self.store.city_put(key,city)
                candidates.append(city)
            return {'candidates':candidates[:20],'truncated':len(candidates)>20}
        city=self.store.city_get(key)
        modules=['current','forecast'] if module=='all' else [module]
        def load(part):
            ck=HOST+':'+key+':'+part+':metric'
            cached=None
            try:
                cached=None if refresh=='1' else self.store.get(ck,600 if part=='current' else 3600,reference)
                if cached:
                    normalized=normalize(cached[1],reference,cached[0],part)
                    if normalized['status']=='success' and normalized['completeness']=='complete': return normalized
                raw=self.provider.request(part,f"{city['lat']},{city['lon']}",deadline)
                if time.monotonic()>deadline: return failure('timeout')
                fetched=time.time()
                normalized=normalize(raw,reference,fetched,part)
                if normalized['status']=='success': self.store.put(ck,raw,fetched)
                return normalized
            except ServiceError as e:
                result=failure(e.code)
                result['retry_after']=e.retry
                if cached:
                    fallback=normalize(cached[1],reference,cached[0],part)
                    if fallback['status']=='success':
                        fallback['refresh_error']=e.code
                        return fallback
                return result
            except Exception: return failure('unavailable')
        results={}
        # One shared query budget/reference; independent module outcomes.
        pool=concurrent.futures.ThreadPoolExecutor(max_workers=2)
        futures={part:pool.submit(load,part) for part in modules}
        for part,future in futures.items():
            try: results[part]=future.result(timeout=max(0,deadline-time.monotonic()))
            except concurrent.futures.TimeoutError: results[part]=failure('timeout')
        pool.shutdown(wait=False,cancel_futures=True)
        count=sum(v['status']=='success' for v in results.values())
        return dict(results,city=city,state='ready' if count==len(modules) else 'partial' if count else 'error',reference_at=reference,server_now=time.time(),attempt_id=str(uuid.uuid4()))

class Handler(BaseHTTPRequestHandler):
    app=App()
    def log_message(self,*args): pass
    def do_GET(self):
        try:
            url=urlsplit(self.path)
            if len(self.path)>4096: raise ServiceError('invalid_data',400)
            if url.path.startswith('/api/'):
                try: params=parse_qs(url.query,keep_blank_values=True,max_num_fields=10)
                except ValueError: raise ServiceError('invalid_data',400)
                result=self.app.handle(url.path,params,self.client_address[0])
                self.send_body(200,json.dumps(result,ensure_ascii=False).encode(),'application/json; charset=utf-8')
            else:
                files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'}
                if url.path not in files: raise ServiceError('invalid_data',404)
                name=files[url.path]
                self.send_body(200,(ROOT/'static'/name).read_bytes(),{'html':'text/html','js':'text/javascript','css':'text/css'}[name.rsplit('.',1)[1]]+'; charset=utf-8')
        except ServiceError as e:
            self.send_body(e.status,json.dumps({'error_code':e.code,'retry_after':e.retry}).encode(),'application/json',e.retry if e.status==429 else None)
        except Exception:
            self.send_body(503,b'{"error_code":"unavailable"}','application/json')
    def send_body(self,status,body,kind,retry=None):
        try:
            self.send_response(status)
            self.send_header('Content-Type',kind)
            self.send_header('Content-Length',str(len(body)))
            self.send_header('Cache-Control','no-store')
            self.send_header('X-Content-Type-Options','nosniff')
            self.send_header('Content-Security-Policy',"default-src 'self'; connect-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
            if retry: self.send_header('Retry-After',str(retry))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError,ConnectionResetError): pass

if __name__=='__main__':
    server=ThreadingHTTPServer((os.environ.get('BIND','127.0.0.1'),int(os.environ.get('PORT','8000'))),Handler)
    print('Weather site listening on port',server.server_port,flush=True)
    server.serve_forever()
