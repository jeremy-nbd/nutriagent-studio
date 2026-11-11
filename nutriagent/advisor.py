"""Reuse the private Wellnest nutrition tools without sharing family records."""
import copy
import json
import threading
import uuid
from urllib.request import Request, urlopen
from urllib.parse import urlsplit, urlencode
from urllib.error import HTTPError, URLError
from .core import dumps, save_json, now
from .nutrition import clean, valid_date, today, ID

class Wellnest:
    def __init__(self, env):
        self.url=env.get('WELLNEST_URL','').rstrip('/')
        self.token=env.get('BACKEND_SERVICE_TOKEN','')
        parsed=urlsplit(self.url)
        if self.url and (parsed.scheme!='http' or parsed.hostname not in ('127.0.0.1','localhost') or parsed.username or parsed.path or parsed.query or parsed.fragment):
            raise ValueError('WELLNEST_URL 必须为同机私有服务地址。')
    @property
    def ready(self):return bool(self.url and self.token)
    def open(self,path,data=None):
        if not self.ready:raise ValueError('营养师知识服务尚未连接，请联系管理员。')
        request=Request(self.url+path,data=dumps(data).encode() if data is not None else None,headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json'})
        try:return urlopen(request,timeout=330)
        except (HTTPError,URLError,TimeoutError):raise ValueError('营养师服务暂时不可用，请稍后重试。') from None
    def json(self,path,data=None):
        with self.open(path,data) as response:return json.loads(response.read(4*1024*1024))
    def page(self,document,page):
        if not isinstance(document,str) or not document or len(document)>100 or not isinstance(page,int) or not 1<=page<=10000:raise ValueError('资料页参数无效。')
        with self.open('/page?'+urlencode(dict(document=document,page=page))) as response:
            raw=response.read(12*1024*1024+1)
            if len(raw)>12*1024*1024 or not raw.startswith(b'\x89PNG'):raise ValueError('资料页暂时无法显示。')
            return raw

class Advisor:
    def __init__(self,directory,nutrition,bridge):
        self.directory=directory;self.nutrition=nutrition;self.bridge=bridge
        self.lock=threading.RLock();self.busy=threading.Lock()
        self.profile_file=directory/'diet-memory.json';self.history_file=directory/'consultations.json'
        self.memory=json.loads(self.profile_file.read_text()) if self.profile_file.exists() else {'revision':0,'entries':[]}
        self.history=json.loads(self.history_file.read_text()) if self.history_file.exists() else []
    def profile(self):
        with self.lock:return copy.deepcopy(self.memory)
    def conversations(self):
        with self.lock:return copy.deepcopy(self.history)
    def save_memory(self,data):
        entries=data.get('entries')
        if not isinstance(entries,list) or len(entries)>100:raise ValueError('最多保存100条饮食记忆。')
        result=[];seen=set()
        for entry in entries:
            if not isinstance(entry,dict):raise ValueError('记忆格式无效。')
            id=entry.get('id','');kind=entry.get('kind');status=entry.get('status','active');content=clean(entry.get('content'),301)
            if not isinstance(id,str) or not ID.fullmatch(id) or id in seen or kind not in ('preference','goal','restriction') or status not in ('active','review','ended') or not 1<=len(content)<=300:raise ValueError('请检查饮食记忆内容。')
            seen.add(id)
            said=valid_date(entry.get('saidOn'));start=valid_date(entry.get('validFrom'));confirmed=valid_date(entry.get('confirmedOn'));until=valid_date(entry['validUntil']) if entry.get('validUntil') else None
            if said>today() or confirmed>today() or confirmed<said or until and until<start:raise ValueError('记忆日期范围无效。')
            result.append(dict(id=id,revision=1,kind=kind,content=content,scope='diet',status=status,saidOn=said,validFrom=start,validUntil=until,confirmedOn=confirmed,sourceText=clean(entry.get('sourceText'),500)))
        with self.lock:
            if data.get('revision')!=self.memory['revision']:raise ValueError('记忆已更新，请刷新后再保存。')
            old={e['id']:e for e in self.memory['entries']}
            for e in result:
                previous=old.get(e['id'])
                e['revision']=previous['revision']+1 if previous else 1
            value={'revision':self.memory['revision']+1,'entries':result}
            save_json(self.profile_file,value);self.memory=value
            return copy.deepcopy(value)
    def consult(self,data):
        question=clean(data.get('question'),2001);id=data.get('requestId','')
        if not 1<=len(question)<=2000 or not isinstance(id,str) or not ID.fullmatch(id):raise ValueError('请输入1–2000字的饮食问题。')
        date=valid_date(data.get('date'));period=data.get('period','day')
        if not self.busy.acquire(blocking=False):raise ValueError('本账号已有咨询进行中。')
        acquired=False
        try:
            with self.lock:
                existing=next((h for h in self.history if h['id']==id),None)
                if existing:
                    if (existing['question'],existing['date'],existing['period'])!=(question,date,period):raise ValueError('请求标识冲突。')
                    yield {'type':'result','data':existing['result']};return
                memory=self.profile();history=copy.deepcopy(self.history[-4:]) if data.get('continue') is True else []
            stats=self.nutrition.overview(date,period)
            # A compact, server-built record summary also handles manual meals with unknown grams.
            diet=f"选择范围 {stats['start']} 至 {stats['end']}，已记录{stats['mealCount']}餐，{stats['recordedDays']}天；不代表完整摄入。确定性统计：{dumps(stats['totals'])}。\n"
            for r in stats['records']:
                row=f"{r['date']} {r['slot']} {r['title']}："+'、'.join(f"{i['name']} {i['grams'] if i.get('grams') is not None else '未知'}克" for i in r['items'])+f"；营养{dumps(r['totals'])}；{'手动输入' if r.get('source')=='manual' else 'AI估算'}。\n"
                if len(diet)+len(row)>1900:
                    diet+='部分餐食明细因长度未展开，以以上范围总计为准。';break
                diet+=row
            profile=dict(name='',age=None,goals='',conditions='',medications='',allergies='',sleep='',diet=diet,exercise='',vitals='',source='user')
            messages=[]
            for h in history:
                messages.extend([dict(role='user',content=h['question']),dict(role='assistant',content=h['result']['answer'][:12000])])
            messages.append(dict(role='user',content=question))
            acquired=self.nutrition.slots.acquire(blocking=False)
            if not acquired:raise ValueError('已有分析进行中，请稍后重试。')
            payload=dict(mode='live',preferred='nutrition',profile=profile,memory=memory,messages=messages,meals=[])
            final=None
            with self.bridge.open('/chat',payload) as response:
                total=0
                while True:
                    line=response.readline(1024*1024)
                    if not line:break
                    total+=len(line)
                    if total>8*1024*1024:raise ValueError('咨询响应过长，请缩小问题范围。')
                    event=json.loads(line)
                    if event.get('type')=='result':
                        final=event['data'];break
                    if event.get('type')=='error':raise ValueError('本次营养师咨询未完成，请重试。')
                    if event.get('type') in ('answer_delta','trace','route'):yield event
            if not final or not isinstance(final.get('answer'),str) or not final['answer']:raise ValueError('咨询未返回完整答案。')
            with self.lock:
                if self.nutrition.overview(date,period)['snapshotId']!=stats['snapshotId'] or self.memory['revision']!=memory['revision']:
                    raise ValueError('咨询期间饮食或记忆发生变化，请重新咨询。')
                record=dict(id=id,question=question,date=date,period=period,createdAt=now(),result=final)
                updated=(self.history+[record])[-100:]
                save_json(self.history_file,updated);self.history=updated
            yield {'type':'result','data':final}
        finally:
            if acquired:self.nutrition.slots.release()
            self.busy.release()
