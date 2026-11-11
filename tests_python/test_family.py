import json
import tempfile
import threading
import unittest
import uuid
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from test_app import FakeClient
from nutriagent.accounts import Accounts
from nutriagent.nutrition import NutritionService
from nutriagent.server import App


def meal(**kw):
    return dict(dict(requestId=str(uuid.uuid4()),date='2026-11-11',slot='午餐',title='手动午餐',grams=None,totals=dict(kcal=550,protein=25,carbs=60,fat=20)),**kw)


class ManualTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.service=NutritionService(self.tmp.name,FakeClient())
    def test_idempotency_validation_and_restart(self):
        data=meal();first=self.service.manual(data)
        self.assertEqual(self.service.manual(data),first)
        with self.assertRaises(ValueError):self.service.manual(dict(data,grams=123))
        for invalid in (-1,True,float('nan'),10001):
            with self.assertRaises(ValueError):self.service.manual(meal(grams=invalid))
        with self.assertRaises(ValueError):self.service.manual(meal(totals={'kcal':100}))
        with self.assertRaises(ValueError):self.service.confirm(first['id'],{'revision':1,'items':[]},True)
        self.assertEqual(NutritionService(self.tmp.name,FakeClient()).overview(data['date'])['mealCount'],1)
    def test_week_weights_unknowns_and_deletions(self):
        self.service.manual(meal(grams=250))
        unknown=self.service.manual(meal())
        self.service.manual(meal(date='2026-11-12'))
        stats=self.service.overview('2026-11-11','week')
        wed,thu=stats['days'][2:4]
        self.assertEqual((wed['grams'],wed['unknownPortions'],wed['count']),(250,1,2))
        self.assertIsNone(thu['grams']);self.assertEqual(thu['totals']['kcal'],550)
        self.assertIsNone(stats['days'][0]['totals']);self.assertIsNone(stats['days'][0]['grams'])
        self.assertEqual(stats['averagePerRecordedDay']['kcal'],825)
        self.service.remove(unknown['id'],1)
        self.assertEqual(self.service.overview('2026-11-11')['days'][0]['unknownPortions'],0)


class FamilyHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.env=dict(AUTH_MODE='family',PUBLIC_ORIGIN='http://127.0.0.1',BASE_PATH='/family')
        self.app=App(self.tmp.name,env=self.env,client=FakeClient())
        self.a=self.app.accounts.create('alice','甲','test-password-a')
        self.b=self.app.accounts.create('bravo','乙','test-password-b')
        self.server=self.app.server(port=0)
        self.origin=f'http://127.0.0.1:{self.server.server_port}';self.app.origin=self.origin
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
        self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown)
    def req(self,path,body=None,cookie='',method=None,origin=None):
        headers={'Content-Type':'application/json','Cookie':cookie}
        if origin:headers['Origin']=origin
        r=Request(self.origin+'/family'+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method=method)
        try:res=urlopen(r)
        except HTTPError as e:res=e
        with res:
            raw=res.read().decode()
            return res.status,dict(res.headers),json.loads(raw) if res.headers.get('Content-Type','').startswith('application/json') else raw
    def login(self,username,password):
        status,headers,_=self.req('/api/auth/login',dict(username=username,password=password))
        self.assertEqual(status,200)
        self.assertIn('HttpOnly',headers['Set-Cookie']);self.assertIn('SameSite=Strict',headers['Set-Cookie'])
        self.assertIn('Path=/family',headers['Set-Cookie'])
        return headers['Set-Cookie'].split(';')[0]
    def test_auth_isolation_restart_and_ownership(self):
        self.assertEqual(self.req('/api/nutrition/overview')[0],401)
        self.assertEqual(self.req('/api/auth/login',dict(username='alice',password='wrong'))[0],401)
        a=self.login('alice','test-password-a');b=self.login('bravo','test-password-b')
        status,_,record=self.req('/api/nutrition/manual',meal(userId=self.b),a)
        self.assertEqual(status,200)
        p='/api/nutrition/records/'+record['id']
        self.assertNotEqual(self.req(p,cookie=b)[0],200)
        self.assertNotEqual(self.req(p,{'revision':1},b,'DELETE')[0],200)
        self.assertNotEqual(self.req(p,{'revision':1,'items':[]},b,'PATCH')[0],200)
        self.assertEqual(self.req('/api/nutrition/overview?date=2026-11-11',cookie=b)[2]['mealCount'],0)
        self.assertEqual(self.req('/api/nutrition/overview?date=2026-11-11',cookie=a)[2]['mealCount'],1)
        restored=App(self.tmp.name,env=self.env,client=FakeClient())
        self.assertEqual(restored.user_service({'id':self.a}).overview('2026-11-11')['mealCount'],1)
        self.assertEqual(restored.user_service({'id':self.b}).overview('2026-11-11')['mealCount'],0)
        self.assertEqual(self.req('/studio',cookie=a)[0],404)
        self.assertEqual(self.req('/api/nutrition/manual',meal(),a,origin='https://evil.test')[0],403)
        self.req('/api/auth/logout',{},a)
        self.assertEqual(self.req('/api/nutrition/overview',cookie=a)[0],401)
    def test_password_revocation_assets_and_secure_cookie(self):
        a=self.login('alice','test-password-a')
        self.assertEqual(self.req('/api/auth/password',dict(current='test-password-a',password='new-test-password'),a)[0],200)
        self.assertEqual(self.req('/api/nutrition/overview',cookie=a)[0],401)
        self.assertEqual(self.req('/api/auth/login',dict(username='alice',password='test-password-a'))[0],401)
        self.login('alice','new-test-password')
        html=self.req('/login')[2]
        self.assertIn('/family/login.js',html)
        self.assertNotIn('test-password',html)
        self.app.origin=self.origin.replace('http:','https:')
        _,headers,_=self.req('/api/auth/login',dict(username='alice',password='new-test-password'))
        self.assertIn('; Secure',headers['Set-Cookie'])
    def test_rate_limit(self):
        for _ in range(10):self.req('/api/auth/login',dict(username='alice',password='wrong'))
        result=self.req('/api/auth/login',dict(username='alice',password='test-password-a'))
        self.assertEqual(result[0],401);self.assertIn('尝试过多',result[2]['error'])

if __name__=='__main__':unittest.main()

class AdvisorTests(unittest.TestCase):
    def setUp(self):
        from nutriagent.advisor import Advisor
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=__import__('pathlib').Path(self.tmp.name)
        self.n=NutritionService(self.root/'nutrition',FakeClient())
        self.calls=[]
        outer=self
        class Bridge:
            def open(self,path,data):
                import io
                outer.calls.append(data)
                return io.BytesIO((json.dumps({'type':'answer_delta','data':{'text':'建议'}})+'\n'+json.dumps({'type':'result','data':{'answer':'完整建议','sources':[]}})+'\n').encode())
        self.advisor=Advisor(self.root,self.n,Bridge())
    def entry(self,**kw):
        return dict(dict(id=str(uuid.uuid4()),kind='restriction',content='不吃花生',status='active',saidOn='2026-11-01',validFrom='2026-11-01',validUntil='2026-11-10',confirmedOn='2026-11-01'),**kw)
    def test_memory_validation_and_conflict(self):
        e=self.entry();m=self.advisor.save_memory({'revision':0,'entries':[e]})
        self.assertEqual(m['entries'][0]['status'],'active')  # downstream resolver treats elapsed restrictions as review
        with self.assertRaises(ValueError):self.advisor.save_memory({'revision':0,'entries':[]})
        with self.assertRaises(ValueError):self.advisor.save_memory({'revision':1,'entries':[e,e]})
        with self.assertRaises(ValueError):self.advisor.save_memory({'revision':1,'entries':[self.entry(validUntil='2026-10-01')]})
    def test_consult_server_records_and_idempotency(self):
        self.n.manual(meal())
        self.advisor.save_memory({'revision':0,'entries':[self.entry()]})
        data=dict(question='今天怎么吃',date='2026-11-11',requestId=str(uuid.uuid4()),profile={'diet':'forged-user-data'})
        events=list(self.advisor.consult(data));self.assertEqual(events[-1]['type'],'result')
        self.assertIn('手动午餐',self.calls[0]['profile']['diet']);self.assertNotIn('forged-user-data',json.dumps(self.calls))
        self.assertEqual(self.calls[0]['mode'],'live');self.assertEqual(self.calls[0]['preferred'],'nutrition')
        self.assertEqual(self.calls[0]['memory']['entries'][0]['content'],'不吃花生')
        list(self.advisor.consult(data));self.assertEqual(len(self.calls),1)
    def test_incomplete_response_not_saved(self):
        import io
        self.advisor.bridge.open=lambda *a:io.BytesIO(b'{"type":"answer_delta","data":{"text":"partial"}}\n')
        with self.assertRaises(ValueError):list(self.advisor.consult(dict(question='饮食建议',date='2026-11-11',requestId=str(uuid.uuid4()))))
        self.assertEqual(self.advisor.conversations(),[])

class AdminTests(FamilyHttpTests):
    # Only this explicit admin scenario; inherited auth tests also exercise the upgraded schema.
    def test_superadmin_read_only_access(self):
        self.app.accounts.create('jeremy','我','admin-test-password',role='superadmin')
        admin=self.login('jeremy','admin-test-password');member=self.login('bravo','test-password-b')
        self.req('/api/nutrition/manual',meal(),member)
        self.assertEqual(self.req('/api/admin/users',cookie=member)[0],403)
        self.assertEqual(self.req('/api/admin/users',cookie=admin)[0],200)
        status,_,data=self.req('/api/admin/data?userId='+self.b+'&date=2026-11-11',cookie=admin)
        self.assertEqual(status,200);self.assertEqual(data['stats']['mealCount'],1)
        self.assertEqual(self.req('/api/admin/data',{},admin)[0],405)
        self.assertEqual(self.req('/api/auth/me',cookie=admin)[2]['user']['role'],'superadmin')
