import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock
from nutriagent.persona import Persona
import test_family

class PersonaTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.p=Persona(Path(self.tmp.name),threading.RLock())
    def save(self,values,**kw):
        return self.p.update(dict(revision=self.p.get()['revision'],values=values,**kw))
    def test_validation_atomicity_and_unknown_health(self):
        self.assertEqual(self.p.get()['fields'],{})
        for values in ({'age':True},{'weight':float('nan')},{'height':270},{'age':25.5},{'sex':'guess'},{'conditions':'x'*301},{'bogus':'x'}):
            with self.assertRaises(ValueError):self.save(dict(goal='atomic',**values))
            self.assertEqual(self.p.get()['revision'],0)
        p=self.save({'conditions':'不清楚','allergies':'无','restrictions':'暂不提供'})
        self.assertEqual([v['value'] for v in p['fields'].values()],['不清楚','无','暂不提供'])
    def test_weight_dates_correction_delete_and_restart(self):
        self.save({'weight':70},date='2026-11-01')
        self.save({'weight':69},date='2026-11-02')
        p=self.save({'weight':68.5},date='2026-11-02')
        self.assertEqual([w['value'] for w in p['weights']],[70,68.5])
        with self.assertRaises(ValueError):self.save({'weight':80},date='2099-01-01')
        restored=Persona(Path(self.tmp.name),threading.RLock());self.assertEqual(restored.get(),p)
        p=self.p.update(dict(revision=p['revision'],action='delete_weight',id=p['weights'][1]['id']))
        self.assertEqual(p['weights'][-1]['value'],70)
    def test_cas_delete_skip_and_source(self):
        p=self.save({'age':35,'height':170})
        with self.assertRaises(ValueError):self.p.update(dict(revision=0,values={'age':30}))
        with self.assertRaises(ValueError):self.p.update(dict(revision=True,values={'age':30}))
        p=self.save({'height':None})
        self.assertNotIn('height',p['fields']);self.assertTrue(p['onboarding'])
        self.assertEqual(p['fields']['age']['source'],'form')
        self.assertEqual(self.p.update(dict(revision=p['revision'],action='dismiss'))['fields'],p['fields'])
    def test_unconfirmed_reject_edit_and_repeat_id(self):
        client=Mock();client.structured.return_value={'proposals':[dict(quote='我体重140斤',values={'weight':70,'height':999,'madeup':'no'})]}
        self.p.propose('我体重140斤',str(uuid.uuid4()),client)
        p=self.p.get();self.assertEqual(p['pending'][0]['values'],{'weight':70})
        self.assertNotIn('70',self.p.context(p))
        ident=p['pending'][0]['id']
        p=self.p.update(dict(revision=p['revision'],action='accept',id=ident,values={'weight':69}))
        self.assertEqual(p['weights'][0]['value'],69)
        with self.assertRaises(ValueError):self.p.update(dict(revision=p['revision'],action='accept',id=ident))
        self.p.propose('我体重140斤',str(uuid.uuid4()),client);p=self.p.get()
        p=self.p.update(dict(revision=p['revision'],action='reject',id=p['pending'][0]['id']))
        self.assertEqual(p['pending'],[]);self.assertEqual(p['weights'][0]['value'],69)
    def test_quote_spacing_keeps_original_and_rejects_changed_meaning(self):
        client=Mock();client.structured.return_value={'proposals':[
            dict(quote='我今年 35 岁，体重 140 斤',values={'age':35.0,'weight':70}),
            dict(quote='我喜欢香菜',values={'preferences':'喜欢香菜'})]}
        self.p.propose('我今年35岁，体重140斤。我不喜欢香菜。',str(uuid.uuid4()),client)
        p=self.p.get();self.assertEqual(len(p['pending']),1)
        self.assertEqual(p['pending'][0]['quote'],'我今年35岁，体重140斤')
        self.assertIs(type(p['pending'][0]['values']['age']),int)
    def test_third_party_and_questions_not_proposed(self):
        client=Mock()
        for question in ('我爸爸有糖尿病','我妈妈不吃香菜','我是不是有高血压？','如果我体重140斤呢','我有糖尿病的话怎么吃','我儿子身高170'):
            self.p.propose(question,str(uuid.uuid4()),client)
        client.structured.assert_not_called()

class PersonaContextTests(test_family.AdvisorTests):
    def test_confirmed_context_and_concurrent_change(self):
        p=self.advisor.persona.update(dict(revision=0,values={'age':32,'conditions':'无','preferences':'不吃辣','hometown':'湖南','weight':70}))
        list(self.advisor.consult(dict(question='怎么吃',date='2026-11-11',requestId=str(uuid.uuid4()))))
        profile=self.calls[-1]['profile']
        self.assertEqual(profile['age'],32);self.assertEqual(profile['conditions'],'无')
        self.assertIn('不吃辣',self.calls[-1]['messages'][0]['content']);self.assertIn('湖南',self.calls[-1]['messages'][0]['content'])
        self.assertLessEqual(len(profile['diet']),2000);self.assertLessEqual(len(profile['vitals']),2000)
        old=self.advisor.bridge.open
        def changing(*args):
            self.advisor.persona.update(dict(revision=p['revision'],values={'age':33}))
            return old(*args)
        self.advisor.bridge.open=changing
        with self.assertRaises(ValueError):list(self.advisor.consult(dict(question='继续',date='2026-11-11',requestId=str(uuid.uuid4()))))
        self.assertEqual(len(self.advisor.conversations()),1)

class PersonaHttpTests(test_family.FamilyHttpTests):
    def test_profile_ownership_and_admin(self):
        self.assertEqual(self.req('/api/nutrition/profile')[0],401)
        a=self.login('alice','test-password-a');b=self.login('bravo','test-password-b')
        status,_,p=self.req('/api/nutrition/profile',dict(revision=0,values={'age':40},userId=self.b),a)
        self.assertEqual(status,200);self.assertEqual(p['fields']['age']['value'],40)
        self.assertEqual(self.req('/api/nutrition/profile',cookie=b)[2]['fields'],{})
        self.assertEqual(self.req('/api/nutrition/profile',dict(revision=0,values={}),a)[0],400)
        self.app.accounts.create('admin','管理员','test-password-admin',role='superadmin')
        admin=self.login('admin','test-password-admin')
        status,_,p=self.req('/api/admin/data?userId='+self.a+'&date=2026-11-11',cookie=admin)
        self.assertEqual(status,200);self.assertEqual(p['personal']['fields']['age']['value'],40)
        self.assertEqual(self.req('/api/admin/data?userId='+self.a,cookie=b)[0],403)
        self.assertEqual(self.req('/api/nutrition/profile',dict(revision=1,values={}),a,origin='https://evil.test')[0],403)
