"""饮食识别、确认、日周汇总。文件格式兼容原 Node 版本。"""
import base64
import copy
import hashlib
import json
import re
import threading
from concurrent.futures import Future
from datetime import date as Date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
from .core import KEYS, PROMPTS, dumps, now, number, rounded, save_json, zero

SLOTS = ['早餐', '午餐', '晚餐', '加餐']
ID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
NOTICE = '仅汇总已确认的饮食记录；未记录不代表未进食，图片份量和营养参考值均可能存在估算误差。'

def today():
    return datetime.now(ZoneInfo('Asia/Shanghai')).date().isoformat()

def valid_date(value):
    if not isinstance(value, str) or not re.fullmatch(r'20\d{2}-\d{2}-\d{2}', value):
        raise ValueError('请选择有效日期。')
    Date.fromisoformat(value)
    return value

def date_range(value, period='day'):
    start = Date.fromisoformat(valid_date(value))
    if period not in ('day', 'week'):
        raise ValueError('统计周期应为 day 或 week。')
    if period == 'week':
        start -= timedelta(days=start.weekday())
    days = [(start + timedelta(days=i)).isoformat() for i in range(7 if period == 'week' else 1)]
    return dict(period=period, start=days[0], end=days[-1], dates=days)

def digest(value):
    return hashlib.sha256(dumps(value).encode()).hexdigest()

def clean(value, limit, fallback=''):
    return value.strip()[:limit] if isinstance(value, str) else fallback

def validate_image(image):
    if image is None or image == '':
        return None
    if not isinstance(image, str) or len(image) > 8400000:
        raise ValueError('图片不能超过6 MB。')
    match = re.fullmatch(r'data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})', image)
    if not match:
        raise ValueError('仅支持 JPG、PNG 或 WebP 图片。')
    try:
        data = base64.b64decode(match[2], validate=True)
    except ValueError:
        raise ValueError('图片编码无效。') from None
    mime = match[1]
    if not 12 <= len(data) <= 6*1024*1024 or not (
        mime == 'jpeg' and data.startswith(b'\xff\xd8\xff') or
        mime == 'png' and data.startswith(b'\x89PNG\r\n\x1a\n') or
        mime == 'webp' and data[:4] == b'RIFF' and data[8:12] == b'WEBP'):
        raise ValueError('图片内容与类型不匹配或超过6 MB。')
    return image

def normalize(raw):
    if not isinstance(raw, dict) or not isinstance(raw.get('items'), list) or len(raw['items']) > 30:
        raise ValueError('AI 食物清单无效。')
    items = []
    for index, item in enumerate(raw['items']):
        if not isinstance(item, dict):
            raise ValueError('AI 食物条目无效。')
        name, ref, grams = clean(item.get('name'), 80), item.get('per100g'), item.get('grams')
        if not name or not isinstance(ref, dict) or not all(number(ref.get(k)) and 0 <= ref[k] <= (1000 if k == 'kcal' else 100) for k in KEYS):
            raise ValueError('AI 营养参考值不完整或无效。')
        if sum(ref[k] for k in KEYS if k != 'kcal') > 110:
            raise ValueError('AI 营养组成不合理。')
        if grams is not None and (not number(grams) or not 0 < grams <= 5000):
            raise ValueError('AI 份量无效。')
        items.append(dict(id=f'food-{index+1}', name=name, grams=grams,
                          portion=clean(item.get('portion'), 100, '份量待补充' if grams is None else f'{grams} g'),
                          amountSource='unknown' if grams is None else 'extracted' if item.get('amount_source') == 'explicit' else 'estimated',
                          confidence=item.get('confidence') if item.get('confidence') in ('high','medium','low') else 'low',
                          per100g={k:rounded(ref[k]) for k in KEYS}, note=clean(item.get('note'), 300), nutritionSource='AI 参考估算（每100克）'))
    return dict(title=clean(raw.get('title'), 80, '这餐饮食'), items=items,
                notes=clean_list(raw.get('notes'), 5, 300),
                question='' if items else clean(raw.get('question'), 300, '请补充饮食描述或清晰的食物照片。'))

def clean_list(values, limit, length):
    return [clean(v, length) for v in values[:limit] if clean(v, length)] if isinstance(values, list) else []

def calculate(items):
    totals, rows, unknown = zero(), copy.deepcopy(items), 0
    for item in rows:
        item['nutrition'] = None
        if item['grams'] is None:
            unknown += 1
            continue
        item['nutrition'] = {}
        for key in KEYS:
            value = item['per100g'][key] * item['grams'] / 100
            totals[key] += value
            item['nutrition'][key] = rounded(value)
    return dict(items=rows, totals={k:rounded(v) for k,v in totals.items()}, unknownItems=unknown)

def aggregate(records, date, period='day'):
    span = date_range(date, period)
    records = sorted([copy.deepcopy(r) for r in records if r['status']=='saved' and span['start'] <= r['date'] <= span['end']], key=lambda r:(r['date'],SLOTS.index(r['slot']),r['createdAt']))
    days, totals = [], zero()
    for day in span['dates']:
        meals = [r for r in records if r['date']==day]
        values = {k:rounded(sum(r['totals'][k] for r in meals)) for k in KEYS}
        for k in KEYS:
            totals[k] += values[k]
        known = [i['grams'] for r in meals for i in r['items'] if number(i.get('grams'))]
        unknown = sum(1 for r in meals for i in r['items'] if not number(i.get('grams')))
        days.append(dict(date=day, recorded=bool(meals), count=len(meals), totals=values if meals else None,
                         grams=rounded(sum(known)) if known else None, unknownPortions=unknown))
    count = sum(d['recorded'] for d in days)
    totals = {k:rounded(v) for k,v in totals.items()}
    return dict(**span, snapshotId=digest([[r['id'],r['revision'],r['date'],r['slot'],r['totals']] for r in records]),
                records=records, days=days, mealCount=len(records), recordedDays=count, missingDays=len(days)-count,
                totals=totals if records else None, averagePerRecordedDay={k:rounded(v/count) for k,v in totals.items()} if count else None, notice=NOTICE)

class NutritionService:
    def __init__(self, directory, client):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.client, self.records, self.pending, self.summaries = client, {}, {}, {}
        self.lock, self.slots = threading.RLock(), threading.BoundedSemaphore(2)
        for file in self.directory.glob('*.json'):
            record = json.loads(file.read_text())
            if not ID.fullmatch(record.get('id','')) or record.get('status') not in ('draft','saved','deleted'):
                raise ValueError('本地饮食记录格式异常。')
            self.records[record['id']] = record

    def save(self, record):
        save_json(self.directory/(record['id']+'.json'), record)
        self.records[record['id']] = copy.deepcopy(record)
        return copy.deepcopy(record)

    def get(self, id):
        with self.lock:
            record = self.records.get(id)
            if not record or record['status']=='deleted':
                raise ValueError('饮食记录不存在。')
            return copy.deepcopy(record)

    def overview(self, date, period='day'):
        with self.lock:
            return aggregate(self.records.values(), date, period)

    def drafts(self):
        with self.lock:
            return [{k:r[k] for k in ('id','title','date','slot','createdAt')} for r in sorted(self.records.values(),key=lambda r:r['createdAt'],reverse=True) if r['status']=='draft']

    def analyze(self, data):
        id = data.get('requestId','')
        if not isinstance(id,str) or not ID.fullmatch(id):
            raise ValueError('缺少有效请求标识。')
        date, slot = valid_date(data.get('date')), data.get('slot')
        text = clean(data.get('text'), 5001)
        image = validate_image(data.get('image'))
        if slot not in SLOTS or len(text)>5000 or not (text or image):
            raise ValueError('请选择餐次并上传图片或填写5000字内的饮食描述。')
        fingerprint = digest([date, slot, text, image])
        with self.lock:
            if id in self.records:
                existing = self.get(id)
                if existing['inputHash'] != fingerprint:
                    raise ValueError('请求标识已用于其他内容。')
                return existing
            owner = id not in self.pending
            if owner:
                self.pending[id] = (fingerprint, Future())
            old_hash, future = self.pending[id]
            if old_hash != fingerprint:
                raise ValueError('请求标识冲突。')
        if not owner:
            return copy.deepcopy(future.result())
        acquired = self.slots.acquire(blocking=False)
        try:
            if not acquired:
                raise ValueError('已有分析进行中，请稍后重试。')
            content = [{'type':'image_url','image_url':{'url':image}}, {'type':'text','text':text or '识别可见食物与份量，列出不确定性。'}] if image else text
            started = datetime.now()
            result = normalize(self.client.structured([{'role':'system','content':PROMPTS['recognition']},{'role':'user','content':content}], vision=bool(image)))
            record = dict(id=id, revision=1, status='draft', date=date, slot=slot, title=result['title'], **calculate(result['items']),
                          notes=result['notes'], question=result['question'], inputText=text, hasImage=bool(image), inputHash=fingerprint,
                          model=self.client.config['visionModel' if image else 'model'], durationMs=int((datetime.now()-started).total_seconds()*1000),
                          createdAt=now(), updatedAt=now(), source='user_input', nutritionSource='AI 参考估算；由代码按份量换算', imageStored=False)
            with self.lock:
                result = self.save(record)
            future.set_result(result)
            return result
        except Exception as error:
            future.set_exception(error)
            raise
        finally:
            if acquired:
                self.slots.release()
            with self.lock:
                self.pending.pop(id, None)

    def manual(self, data):
        id=data.get('requestId','')
        if not isinstance(id,str) or not ID.fullmatch(id): raise ValueError('请求标识无效。')
        date,slot=valid_date(data.get('date')),data.get('slot')
        title=clean(data.get('title'),80)
        values=data.get('totals',{})
        grams=data.get('grams')
        if slot not in SLOTS or not title or not isinstance(values,dict) or not all(number(values.get(k)) and 0<=values[k]<=(10000 if k=='kcal' else 1000) for k in KEYS):
            raise ValueError('请填写餐食名称及有效的热量、蛋白质、碳水、脂肪。')
        if grams is not None and (not number(grams) or not 0<grams<=10000): raise ValueError('饭量请填写大于0、不超过10000克，未知可留空。')
        fingerprint=digest([date,slot,title,values,grams])
        with self.lock:
            if id in self.records:
                old=self.get(id)
                if old.get('inputHash')!=fingerprint: raise ValueError('请求标识冲突。')
                return old
            values={k:rounded(values[k]) for k in KEYS}
            return self.save(dict(id=id,revision=1,status='saved',date=date,slot=slot,title=title,totals=values,
                items=[dict(id='manual-1',name=title,grams=grams,nutrition=values,portion='整餐手动填写',amountSource='user_entered',nutritionSource='用户手动填写')],
                unknownItems=int(grams is None),source='manual',nutritionSource='用户手动填写',createdAt=now(),updatedAt=now(),inputHash=fingerprint,notes=[],question='',imageStored=False))

    def confirm(self, id, data, editing=False):
        with self.lock:
            record = self.get(id)
            if editing and record.get('source')=='manual':
                raise ValueError('手动记录请移除后重新填写，不能按份量自动换算。')
            if editing and record['status'] != 'saved':
                raise ValueError('请先确认保存。')
            if not editing and record['status']=='saved':
                return record
            if data.get('revision') != record['revision']:
                raise ValueError('记录已变化，请刷新后重试。')
            selected = data.get('items')
            if not isinstance(selected,list) or not 0 < len(selected) <= len(record['items']):
                raise ValueError('请至少保留一项食物。')
            items, seen = [], set()
            for item in selected:
                original = next((i for i in record['items'] if i['id']==item.get('id')), None)
                grams = item.get('grams')
                if original is None or item['id'] in seen or not number(grams) or not 0 < grams <= 5000:
                    raise ValueError('食物或份量无效，请填写大于0且不超过5000克的份量。')
                seen.add(item['id'])
                items.append(dict(original, grams=grams, confirmed=True, amountSource='user_corrected' if grams!=original['grams'] else original['amountSource']))
            date, slot = valid_date(data.get('date',record['date'])), data.get('slot',record['slot'])
            if slot not in SLOTS:
                raise ValueError('餐次无效。')
            record.update(calculate(items), date=date, slot=slot, status='saved', revision=record['revision']+1, updatedAt=now())
            return self.save(record)

    def remove(self, id, revision):
        with self.lock:
            record = self.get(id)
            if revision != record['revision']:
                raise ValueError('记录已变化，请刷新。')
            record.update(status='deleted', revision=revision+1, updatedAt=now())
            self.save(record)
            return {'deleted':True}

    def summarize(self, date, period='day', force=False):
        stats = self.overview(date, period)
        if not stats['mealCount']:
            return dict(stats=stats, analysis=None, reason='这段时间尚无已确认记录，先记录一餐。')
        key = (period, stats['start'], stats['snapshotId'])
        with self.lock:
            if not force and key in self.summaries:
                return copy.deepcopy(self.summaries[key])
        if not self.slots.acquire(blocking=False):
            raise ValueError('已有分析进行中，请稍后重试。')
        try:
            facts = {k:stats[k] for k in ('period','start','end','recordedDays','missingDays','totals','averagePerRecordedDay','days')}
            facts['meals'] = [{k:r[k] for k in ('id','date','slot','items','totals')} for r in stats['records']]
            value = self.client.structured([{'role':'system','content':PROMPTS['summary']},{'role':'user','content':dumps(facts)}])
            if not isinstance(value,dict) or not clean(value.get('overview'),800) or not isinstance(value.get('observations'),list):
                raise ValueError('AI 总结格式无效。')
            ids = {r['id'] for r in stats['records']}
            observations = []
            for o in value['observations'][:4]:
                refs = o.get('record_ids',[])
                if not isinstance(refs,list) or not refs or any(not isinstance(i,str) or i not in ids for i in refs) or not clean(o.get('title'),80) or not clean(o.get('text'),600):
                    raise ValueError('AI 总结缺少有效记录依据。')
                observations.append(dict(title=clean(o['title'],80),text=clean(o['text'],600),recordIds=list(dict.fromkeys(refs))))
            if not observations:
                raise ValueError('AI 总结缺少观察依据。')
            with self.lock:
                if self.overview(date,period)['snapshotId'] != stats['snapshotId']:
                    raise ValueError('总结期间记录发生变化，请重试。')
                result = dict(stats=stats, analysis=dict(overview=clean(value['overview'],800),observations=observations,
                              suggestions=clean_list(value.get('suggestions'),3,400),limitations=[NOTICE]+clean_list(value.get('limitations'),3,300),
                              model=self.client.config['model'],generatedAt=now()))
                self.summaries[key] = result
                return copy.deepcopy(result)
        finally:
            self.slots.release()
