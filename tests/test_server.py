import concurrent.futures
import json
import tempfile
import time
import unittest
from unittest.mock import patch
from server import App, Store, ServiceError, Provider, retry_after
from weather import dates

class FakeProvider:
    def __init__(self): self.calls=[];self.fail=set()
    def request(self,module,q,deadline):
        self.calls.append(module)
        if module in self.fail: raise ServiceError('unavailable')
        if module=='search': return [{'name':'London','country':'UK','region':'England','lat':51.5,'lon':-0.1}]
        ref=time.time()
        return {'location':{'tz_id':'Europe/London'},'current':{'last_updated_epoch':int(ref)-60,'temp_c':10,'feelslike_c':9,'humidity':60,'wind_kph':3.6,'condition':{'code':1000}},'forecast':{'forecastday':[{'date':day,'day':{'maxtemp_c':12,'mintemp_c':0,'condition':{'code':1000}}} for day in dates(ref,'Europe/London')]}}

class AppTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.env={'WEATHER_API_KEY':'test-secret-never-return','WEATHER_ACCOUNT':'fixture','WEATHER_ALLOWED_HOSTS':'api.weatherapi.com','IP_LIMIT':'100','IP_WINDOW':'60','QUOTA_LIMIT':'100','QUOTA_WINDOW':'60','WEATHER_DB':self.tmp.name+'/state.sqlite'}
        self.store=Store(self.env['WEATHER_DB']);self.provider=FakeProvider();self.app=App(self.env,self.store,self.provider)
    def call(self,path,params): return self.app.handle(path,{k:[v] for k,v in params.items()},'127.0.0.1')
    def key(self): return self.call('/api/search',{'q':'London'})['candidates'][0]['city_key']
    def test_cache_and_refresh(self):
        key=self.key()
        a=self.call('/api/weather',{'city_key':key});self.assertEqual(a['state'],'ready')
        b=self.call('/api/weather',{'city_key':key});self.assertEqual(len(self.provider.calls),3)
        self.assertEqual(a['current']['fetched_at'],b['current']['fetched_at'])
        self.call('/api/weather',{'city_key':key,'refresh':'1'});self.assertEqual(len(self.provider.calls),5)
        self.assertNotIn(self.env['WEATHER_API_KEY'],json.dumps(a))
    def test_partial_and_error(self):
        key=self.key();self.provider.fail={'forecast'}
        a=self.call('/api/weather',{'city_key':key});self.assertEqual(a['state'],'partial')
        self.provider.fail.add('current')
        a=self.call('/api/weather',{'city_key':key,'refresh':'1'});self.assertEqual(a['state'],'error')
    def test_validation_no_outbound(self):
        for path,params in [('/api/search',{'q':' '*5}),('/api/search',{'q':'x','url':'http://localhost'}),('/api/weather',{'city_key':'http://localhost'}),('/api/search',{'q':'😀'*101})]:
            with self.assertRaises(ServiceError) as ctx:self.call(path,params)
            self.assertEqual(ctx.exception.status,400)
        self.assertEqual(self.provider.calls,[])
    def test_unknown_city(self):
        with self.assertRaises(ServiceError):self.call('/api/weather',{'city_key':'a'*32})
        self.assertEqual(self.provider.calls,[])
    def test_config_fail_closed(self):
        for field in self.env:
            env=dict(self.env);env.pop(field)
            with self.assertRaises(ServiceError):App(env,self.store,self.provider).handle('/api/search',{'q':['London']},'peer')
    def test_limit_includes_cache(self):
        key=self.key();self.call('/api/weather',{'city_key':key});self.env['IP_LIMIT']='2';self.app.env['IP_LIMIT']='2'
        with self.assertRaises(ServiceError) as ctx:self.call('/api/weather',{'city_key':key})
        self.assertEqual(ctx.exception.code,'rate_limited');self.assertEqual(len(self.provider.calls),3)
    def test_atomic_shared_budget(self):
        def consume(_):
            try:Store(self.env['WEATHER_DB']).consume('quota:account',5,60,now=100);return True
            except ServiceError:return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
            self.assertEqual(sum(pool.map(consume,range(50))),5)
        self.store.consume('quota:account',5,60,now=160)
    def test_ttl_boundaries(self):
        self.store.put('x',{'a':1},100)
        self.assertIsNotNone(self.store.get('x',600,699.999))
        self.assertIsNone(self.store.get('x',600,700))
        self.assertIsNone(self.store.get('x',3600,3700))
    def test_shared_deadline_discards_late_results(self):
        key=self.key()
        original=self.provider.request
        def slow(*args):
            time.sleep(.1)
            return original(*args)
        self.provider.request=slow
        with patch('server.QUERY_BUDGET',.03):
            start=time.monotonic()
            result=self.call('/api/weather',{'city_key':key})
            self.assertLess(time.monotonic()-start,.09)
            self.assertEqual(result['state'],'error')
            self.assertEqual(result['current']['error_code'],'timeout')
            self.assertEqual(result['forecast']['error_code'],'timeout')
        time.sleep(.15)
        with self.store.db() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM cache').fetchone()[0],0)
    def test_search_deadline(self):
        def slow(*args):time.sleep(.1);return []
        self.provider.request=slow
        with patch('server.QUERY_BUDGET',.03):
            with self.assertRaises(ServiceError) as ctx:self.call('/api/search',{'q':'London'})
            self.assertEqual(ctx.exception.code,'timeout')
        time.sleep(.15)
    def test_invalid_candidate(self):
        self.provider.request=lambda *args:[{'name':'X','lat':0,'lon':0}]
        result=self.call('/api/search',{'q':'x'})
        self.assertIsNone(result['candidates'][0]['city_key'])

class RetryTests(unittest.TestCase):
    def test_retry_after(self):
        for value,expected in [('0',30),('-1',30),('bad',30),('99999',3600),('2',2)]:self.assertEqual(retry_after(value),expected)
        self.assertEqual(retry_after('Thu, 01 Jan 1970 00:01:42 GMT',100),2)
    def test_provider_retry_policy(self):
        class Budget:
            n=0
            def consume(self,*args):self.n+=1
        class Reply:
            status=200
            def read(self,*args):return b'{}'
            def getheader(self,*args):return None
        class Connection:
            statuses=[];calls=0
            def __init__(self,*args,**kwargs):pass
            def request(self,*args,**kwargs):Connection.calls+=1
            def getresponse(self):
                value=Connection.statuses.pop(0)
                if isinstance(value,Exception):raise value
                r=Reply();r.status=value;return r
            def close(self):pass
        for statuses,expected in [([500,200],2),([ConnectionResetError(),200],2),([401],1),([403],1),([429],1),([302],1),([TimeoutError()],1)]:
            budget=Budget();Connection.statuses=list(statuses);Connection.calls=0
            provider=Provider({'WEATHER_API_KEY':'secret','WEATHER_ACCOUNT':'a','QUOTA_LIMIT':'10','QUOTA_WINDOW':'60'},budget)
            with patch('server.PinnedHTTPS',Connection):
                try:provider.request('current','0,0',time.monotonic()+10)
                except ServiceError:pass
            self.assertEqual(Connection.calls,expected)
            self.assertEqual(budget.n,expected)

if __name__=='__main__':unittest.main()
