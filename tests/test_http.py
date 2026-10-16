import concurrent.futures
import http.client
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch,MagicMock
from server import App,Handler,PinnedHTTPS

class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class TestHandler(Handler): app=App({})
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),TestHandler)
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
    @classmethod
    def tearDownClass(cls): cls.server.shutdown();cls.server.server_close();cls.thread.join()
    def get(self,path,headers=None):
        conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=5)
        conn.request('GET',path,headers=headers or {})
        response=conn.getresponse();body=response.read();result=response.status,dict(response.getheaders()),body;conn.close();return result
    def test_static_and_headers(self):
        for path in ['/','/app.js','/style.css']:
            status,headers,body=self.get(path)
            self.assertEqual(status,200);self.assertTrue(body)
            self.assertEqual(headers['X-Content-Type-Options'],'nosniff')
            self.assertIn("connect-src 'self'",headers['Content-Security-Policy'])
        self.assertEqual(self.get('/../server.py')[0],404)
        self.assertEqual(self.get('/.env')[0],404)
    def test_fail_closed_and_invalid(self):
        self.assertEqual(self.get('/api/search?q=London')[0],503)
        self.assertEqual(self.get('/api/search?q=x&host=127.0.0.1')[0],400)
        self.assertEqual(self.get('/api/search?q=x&q=y')[0],400)
        self.assertEqual(json.loads(self.get('/api/search?q=London')[2]),{'error_code':'unavailable','retry_after':30})
    def test_parallel_static(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
            self.assertTrue(all(status==200 for status,_,_ in pool.map(lambda _:self.get('/'),range(50))))

class DNSPinningTests(unittest.TestCase):
    def test_private_resolution_never_connects(self):
        for address in ['127.0.0.1','169.254.169.254','10.1.1.1','::1']:
            with patch('server.socket.getaddrinfo',return_value=[(2,1,6,'',(address,443))]),patch('server.socket.create_connection') as connect:
                with self.assertRaises(ValueError):PinnedHTTPS('api.weatherapi.com',timeout=1).connect()
                connect.assert_not_called()
    def test_mixed_dns_rejected(self):
        with patch('server.socket.getaddrinfo',return_value=[(2,1,6,'',('8.8.8.8',443)),(2,1,6,'',('127.0.0.1',443))]),patch('server.socket.create_connection') as connect:
            with self.assertRaises(ValueError):PinnedHTTPS('api.weatherapi.com',timeout=1).connect()
            connect.assert_not_called()
    def test_pins_ip_and_checks_original_tls_host(self):
        context=MagicMock();context.post_handshake_auth=False
        with patch('server.socket.getaddrinfo',return_value=[(2,1,6,'',('8.8.8.8',443))]) as dns,patch('server.socket.create_connection') as connect:
            conn=PinnedHTTPS('api.weatherapi.com',timeout=1,context=context);conn.connect()
            self.assertEqual(connect.call_args.args[0],('8.8.8.8',443))
            self.assertEqual(context.wrap_socket.call_args.kwargs['server_hostname'],'api.weatherapi.com')
            self.assertEqual(dns.call_count,1)
