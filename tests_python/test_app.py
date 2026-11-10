import concurrent.futures
import copy
import json
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from unittest.mock import patch
from nutriagent import agent
from nutriagent.core import config, ModelClient, load_env, save_json
from nutriagent.nutrition import NutritionService, date_range, normalize, validate_image
from nutriagent.server import App

FIXTURE = dict(title='米饭', items=[dict(name='熟米饭',grams=150,per100g=dict(kcal=116,protein=2.6,carbs=25.9,fat=.3),amount_source='explicit')])
ENV = dict(LLM_API_KEY='test-secret',LLM_DEFAULT_MODEL_ID='qwen3.5-plus',LLM_BASE_URL='https://dashscope.aliyuncs.com/compatible-mode/v1',VLM_DEFAULT_MODEL_ID='qwen3-vl-plus')
class FakeClient:
    def __init__(self):
        self.config, self.calls = config(ENV), []
    def structured(self, messages, vision=False):
        self.calls.append((messages,vision))
        if '识别助手' in messages[0]['content']:
            time.sleep(.02)
            return copy.deepcopy(FIXTURE)
        facts = json.loads(messages[1]['content'])
        return dict(overview='已记录米饭。',observations=[dict(title='构成',text='有主食。',record_ids=[facts['meals'][0]['id']])],suggestions=[],limitations=[])

class NutritionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.client = FakeClient()
        self.service = NutritionService(self.tmp.name,self.client)
    def input(self,**kw):
        return dict(dict(requestId=str(uuid.uuid4()),date='2026-11-03',slot='午餐',text='150克米饭'),**kw)
    def confirm(self,r,grams=150):
        return self.service.confirm(r['id'],dict(revision=r['revision'],items=[dict(id=r['items'][0]['id'],grams=grams)]))
    def test_confirm_update_delete_and_restart(self):
        draft=self.service.analyze(self.input())
        self.assertIsNone(self.service.overview(draft['date'])['totals'])
        saved=self.confirm(draft)
        self.assertEqual(saved['totals']['kcal'],174)
        self.assertEqual(self.confirm(draft)['revision'],saved['revision'])
        with self.assertRaises(ValueError):
            self.service.confirm(saved['id'],dict(revision=1,items=[]),editing=True)
        updated=self.service.confirm(saved['id'],dict(revision=2,items=[dict(id='food-1',grams=100,per100g={'kcal':999})]),editing=True)
        self.assertEqual(updated['totals']['kcal'],116)
        restored=NutritionService(self.tmp.name,self.client)
        self.assertEqual(restored.get(saved['id'])['totals']['kcal'],116)
        self.service.remove(saved['id'],3)
        self.assertIsNone(self.service.overview(draft['date'])['totals'])
    def test_parallel_idempotency(self):
        data=self.input()
        with concurrent.futures.ThreadPoolExecutor(4) as pool:
            records=list(pool.map(lambda _:self.service.analyze(data),range(4)))
        self.assertEqual(len(self.client.calls),1)
        self.assertTrue(all(r==records[0] for r in records))
        with self.assertRaises(ValueError):
            self.service.analyze(dict(data,text='不同内容'))
    def test_week_and_cache(self):
        r=self.confirm(self.service.analyze(self.input()))
        a=self.service.summarize(r['date'],'week')
        self.assertEqual(a['stats']['recordedDays'],1)
        self.assertEqual(a['stats']['missingDays'],6)
        self.assertEqual(a['stats']['averagePerRecordedDay']['kcal'],174)
        self.service.summarize(r['date'],'week')
        self.assertEqual(len(self.client.calls),2)
        self.service.confirm(r['id'],dict(revision=r['revision'],items=[dict(id='food-1',grams=100)]),editing=True)
        self.assertEqual(self.service.summarize(r['date'],'week')['stats']['totals']['kcal'],116)
        self.assertEqual(len(self.client.calls),3)
    def test_summary_invalid_reference_and_changed_records(self):
        r=self.confirm(self.service.analyze(self.input()))
        with patch.object(self.client,'structured',return_value=dict(overview='x',observations=[dict(title='x',text='x',record_ids=['invented'])])):
            with self.assertRaises(ValueError):self.service.summarize(r['date'])
        original=self.client.structured
        def changing(messages,vision=False):
            result=original(messages,vision)
            self.service.remove(r['id'],r['revision'])
            return result
        with patch.object(self.client,'structured',side_effect=changing):
            with self.assertRaises(ValueError):self.service.summarize(r['date'])
    def test_empty_summary(self):
        self.assertIsNone(self.service.summarize('2026-11-03')['analysis'])
        self.assertEqual(self.client.calls,[])
    def test_unknown_invalid_and_duplicate_food(self):
        fixture=copy.deepcopy(FIXTURE);fixture['items'][0]['grams']=None
        with patch.object(self.client,'structured',return_value=fixture):r=self.service.analyze(self.input())
        self.assertIsNone(r['items'][0]['nutrition'])
        with self.assertRaises(ValueError):self.confirm(r,None)
        for value in (True,-1,float('nan'),5001):
            with self.assertRaises(ValueError):self.confirm(r,value)
        with self.assertRaises(ValueError):self.service.confirm(r['id'],dict(revision=1,items=[{'id':'food-1','grams':2}]*2))
    def test_vision_no_raw_image_on_disk(self):
        image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII='
        r=self.service.analyze(self.input(image=image))
        self.assertTrue(self.client.calls[-1][1])
        self.assertEqual(r['model'],'qwen3-vl-plus')
        raw=Path(self.tmp.name,r['id']+'.json').read_text()
        self.assertNotIn(image,raw);self.assertNotIn('test-secret',raw)
        with self.assertRaises(ValueError):validate_image(image.replace('image/png','image/jpeg'))
        with self.assertRaises(ValueError):validate_image('https://example.com/photo.png')
    def test_dates_and_bad_model_values(self):
        self.assertEqual(date_range('2027-01-01','week')['start'],'2026-12-28')
        with self.assertRaises(ValueError):date_range('2026-02-30')
        with self.assertRaises(ValueError):date_range('2026-11-03','month')
        raw=copy.deepcopy(FIXTURE);raw['items'][0]['per100g']['fat']=float('nan')
        with self.assertRaises(ValueError):normalize(raw)

class AgentTests(unittest.TestCase):
    def run_task(self,prompt='生成报告',**kwargs):
        return dict(dict(prompt=prompt,scenario=None,version=1,status='running',events=[]),**kwargs)
    def test_demo_math_clarify_resume(self):
        a=agent.calculate(agent.DATA['meals'])
        self.assertEqual(a['average']['kcal'],1572.6)
        run=self.run_task(scenario='clarify');emit=lambda *x:None
        agent.run_demo(run,emit,0);self.assertEqual(run['status'],'awaiting_input')
        run.update(prompt='米饭100克',status='running')
        agent.run_demo(run,emit,0);self.assertEqual(run['report']['analysis']['average']['kcal'],1541.7)
        fail=self.run_task(simulateFailure=True)
        with self.assertRaises(ValueError):agent.run_demo(fail,emit,0)
        fail.update(resumeReport=True);calls=[]
        agent.run_demo(fail,lambda k,v:calls.append(v.get('name')) if k=='tool_start' else None,0)
        self.assertEqual(calls,['generate_report'])
    def test_unauthorized_portion_and_repeat(self):
        r=self.run_task('米饭吃一半');emit=lambda *x:None
        agent.tool(r,'get_meal_records',{},emit)
        with self.assertRaises(ValueError):agent.tool(r,'revise_rice_portion',{'grams':100},emit)
        agent.tool(r,'revise_rice_portion',{'grams':90},emit)
        self.assertTrue(agent.tool(r,'revise_rice_portion',{'grams':90},emit)['reused'])
        r=self.run_task('鸡肉100克');agent.run_demo(r,emit,0);self.assertEqual(r['status'],'awaiting_input')
    def test_live_tool_loop(self):
        client=FakeClient();names=iter(['get_meal_records','calculate_nutrition','validate_report_data','generate_report'])
        client.chat=lambda *a,**k:{'choices':[{'message':{'tool_calls':[{'id':str(uuid.uuid4()),'function':{'name':next(names),'arguments':'{}'}}]}}]}
        r=self.run_task();agent.run_live(r,lambda *x:None,client)
        self.assertTrue(r['report']['validation']['passed'])

class HttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=App(self.tmp.name,env={},client=FakeClient());self.server=self.app.server(port=0)
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
        self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown)
        self.base='http://127.0.0.1:'+str(self.server.server_port)
    def request(self,path,data=None,method=None,headers=None):
        h={'Content-Type':'application/json'};h.update(headers or {})
        try:
            r=urlopen(Request(self.base+path,data=json.dumps(data).encode() if data is not None else None,method=method,headers=h),timeout=4)
        except HTTPError as error:r=error
        with r:return r.status,r.read()
    def test_frontend_and_nutrition_contract(self):
        for path in ('/','/studio','/nutrition.js','/api/config','/api/nutrition/config'):
            self.assertEqual(self.request(path)[0],200)
        data=dict(requestId=str(uuid.uuid4()),date='2026-11-03',slot='午餐',text='米饭')
        status,raw=self.request('/api/nutrition/analyze',data);self.assertEqual(status,200)
        r=json.loads(raw);path='/api/nutrition/records/'+r['id']
        self.assertEqual(self.request(path+'/confirm',dict(revision=1,items=[dict(id='food-1',grams=100)]))[0],200)
        summary=json.loads(self.request('/api/nutrition/summary',dict(date=data['date'],period='week'))[1])
        self.assertEqual(summary['stats']['totals']['kcal'],116)
        self.assertEqual(self.request(path,dict(revision=2),method='DELETE')[0],200)
        self.assertEqual(self.request('/api/nutrition/analyze',data,headers={'Origin':'https://evil.example'})[0],403)
        self.assertEqual(self.request('/.env')[0],404)
        self.assertNotIn(b'test-secret',self.request('/api/config')[1])
    def test_sse_report_markdown_restart(self):
        code,raw=self.request('/api/runs',dict(prompt='生成报告',scenario='weekly'))
        self.assertEqual(code,202);id=json.loads(raw)['id']
        status,events=self.request('/api/runs/'+id+'/events')
        self.assertEqual(status,200);self.assertIn(b'completed',events)
        r=json.loads(self.request('/api/runs/'+id)[1]);self.assertEqual(r['status'],'completed')
        after=len(r['events'])
        self.assertEqual(self.request('/api/runs/'+id+'/events?after='+str(after))[1],b'')
        self.assertIn('合成示例',self.request('/api/runs/'+id+'/markdown')[1].decode())
        restored=App(self.tmp.name,env={});self.assertEqual(restored.runs[id]['status'],'completed')
        saved=dict(r,status='running');save_json(Path(self.tmp.name,id+'.json'),saved)
        self.assertEqual(App(self.tmp.name,env={}).runs[id]['status'],'failed')

class ConfigTests(unittest.TestCase):
    def test_config_and_env(self):
        self.assertEqual(config(ENV)['provider'],'阿里云百炼')
        self.assertEqual(config(dict(ENV,LLM_API_KEY='',MODEL_API_KEY='old'))['apiKey'],'')
        for extra in ({'LLM_TIMEOUT_S':'nan'},{'LLM_BASE_URL':'https://secret@host/v1'}):
            with self.assertRaises(ValueError):config(dict(ENV,**extra))
    def test_model_protocol_and_errors(self):
        client=ModelClient(config(ENV))
        class Response:
            def __enter__(self):return self
            def __exit__(self,*a):pass
            def read(self,*a):return b'{"choices":[{"message":{"content":"{}"}}]}'
        with patch('nutriagent.core.build_opener') as opener:
            opener.return_value.open.return_value=Response()
            self.assertEqual(client.structured([{'role':'user','content':'JSON'}]),{})
            request=opener.return_value.open.call_args[0][0]
            payload=json.loads(request.data)
            self.assertFalse(payload['enable_thinking'])
            self.assertEqual(payload['temperature'],.2)
            opener.return_value.open.side_effect=HTTPError('url',401,'secret upstream',{},None)
            with self.assertRaisesRegex(ValueError,'HTTP 401') as context:client.chat([])
            self.assertNotIn('secret',str(context.exception))
