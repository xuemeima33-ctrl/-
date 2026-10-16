import unittest
from datetime import datetime, timezone
from weather import number, normalize, dates, query_text, public_addresses

class ContractTests(unittest.TestCase):
    def test_rounding(self):
        self.assertEqual(number(-1.5), -2)
        self.assertEqual(number(1.25, 1), 1.3)
        self.assertEqual(number(0), 0)
        self.assertIsNone(number(True))
        self.assertIsNone(number(float('nan')))
    def test_unicode(self):
        self.assertEqual(query_text(' 😀 '), '😀')
        with self.assertRaises(ValueError): query_text('😀'*101)
    def test_calendar(self):
        ref=datetime(2026,3,8,6,tzinfo=timezone.utc).timestamp()
        self.assertEqual(dates(ref,'America/New_York'), ['2026-03-09','2026-03-10','2026-03-11','2026-03-12','2026-03-13'])
    def test_private_dns(self):
        for addr in ['127.0.0.1','10.0.0.1','169.254.169.254','::1','::ffff:127.0.0.1']:
            with self.assertRaises(ValueError): public_addresses([addr])
    def test_freshness(self):
        ref=1770000000
        raw={'location':{'tz_id':'UTC'},'current':{'last_updated_epoch':ref-900,'temp_c':0,'feelslike_c':-1.5,'humidity':0,'wind_kph':0,'condition':{'code':1000}},'forecast':{'forecastday':[]}}
        a=normalize(raw,ref,ref,'current')
        self.assertEqual(a['status'],'success')
        self.assertEqual(a['values']['temperature'],0)
        raw['current']['last_updated_epoch']=ref-901
        self.assertEqual(normalize(raw,ref,ref,'current')['status'],'failure')
        raw['current']['last_updated_epoch']=ref+1
        self.assertEqual(normalize(raw,ref,ref,'current')['status'],'failure')
    def test_duplicate_merge(self):
        ref=1770000000
        ds=dates(ref,'UTC')
        day=lambda hi,lo,code:{'date':ds[0],'day':{'maxtemp_c':hi,'mintemp_c':lo,'condition':{'code':code}}}
        raw={'location':{'tz_id':'UTC'},'forecast':{'forecastday':[day(10,0,1000),day(11,0,1000)]}}
        a=normalize(raw,ref,ref,'forecast')
        self.assertEqual(a['status'],'success')
        self.assertIsNone(a['days'][0]['max'])
        self.assertEqual(a['days'][0]['min'],0)
        self.assertEqual(a['days'][1]['day_status'],'failure')
        self.assertEqual(a['completeness'],'incomplete')
    def test_metadata(self):
        self.assertEqual(normalize({},1770000000,1770000000,'current')['status'],'failure')
        raw={'location':{'tz_id':'UTC'},'forecast':{'forecastday':[{'date':'wrong'}]}}
        self.assertEqual(normalize(raw,1770000000,1770000000,'forecast')['status'],'failure')

if __name__=='__main__': unittest.main()
