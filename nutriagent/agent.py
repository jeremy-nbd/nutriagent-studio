"""合成数据工程演示：确定性计算与模型工具循环。"""
import copy
import json
import re
import time
from pathlib import Path
from .core import KEYS, PROMPTS, dumps, now, number, rounded, zero

DATA = json.loads(Path(__file__).with_name('demo.json').read_text())
LABELS = dict(zip([t['name'] for t in DATA['tools']], ['读取饮食记录','更新米饭份量','计算营养与依据','校验数据一致性','生成报告','等待补充信息']))

def calculate(meals):
    if not isinstance(meals,list) or not meals:
        raise ValueError('没有饮食记录。')
    totals, days, rows = zero(), {}, []
    for meal in copy.deepcopy(meals):
        values, evidence = zero(), []
        for item in meal['items']:
            ref, grams = DATA['references'].get(item['food']), item['grams']
            if ref is None or not number(grams) or grams <= 0:
                raise ValueError('原料或重量无效。')
            for k in KEYS:
                values[k] += ref[k]*grams/100
            evidence.append(dict(food=item['food'], name=ref['name'], grams=grams, reference=ref,
                                 formula=f"{ref['kcal']} × {grams} ÷ 100", kcal=rounded(ref['kcal']*grams/100)))
        day = days.setdefault(meal['date'],zero())
        for k in KEYS:
            totals[k] += values[k]
            day[k] += values[k]
        rows.append(dict(meal,values={k:rounded(v) for k,v in values.items()},evidence=evidence))
    return dict(rows=rows,days=[dict(date=d,**{k:rounded(v) for k,v in values.items()}) for d,values in days.items()],
                totals={k:rounded(v) for k,v in totals.items()},average={k:rounded(v/len(days)) for k,v in totals.items()},sourceNote=DATA['sourceNote'])

def validate(analysis):
    if not analysis or not analysis['rows']:
        raise ValueError('分析数据尚未就绪。')
    for k in KEYS:
        if not number(analysis['totals'][k]) or abs(sum(r['values'][k] for r in analysis['rows'])-analysis['totals'][k]) > len(analysis['rows'])*.11:
            raise ValueError('明细与汇总不一致。')
    return copy.deepcopy(DATA['template']['validation'])

def report(analysis, validation, version=1):
    if not validation or not validation.get('passed'):
        raise ValueError('请先完成数据校验。')
    result = copy.deepcopy(DATA['template'])
    result.update(analysis=analysis,validation=validation,version=version,generatedAt=now())
    return result

def markdown(r):
    a = r['analysis']
    return '\n\n'.join([f"# {r['title']}", f"版本 {r['version']} · {a['days'][0]['date']} 至 {a['days'][-1]['date']}",
        '> 合成示例 · '+a['sourceNote'], '## 已记录日均营养', '| 能量 kcal | 蛋白质 g | 碳水 g | 脂肪 g |\n|---|---|---|---|\n| '+' | '.join(str(a['average'][k]) for k in KEYS)+' |',
        '## 饮食明细', '| 日期 | 餐次 | 食物 | 能量 kcal |\n|---|---|---|---|\n'+'\n'.join(f"| {x['date']} | {x['slot']} | {x['name']} | {x['values']['kcal']} |" for x in a['rows']),
        '## 观察', '\n\n'.join(f"### {o['title']}\n\n{o['text']}" for o in r['observations']), '## 依据与限制', '\n'.join('- '+x for x in r['limitations']), r['validation']['note']])+'\n'

def grams(prompt):
    match = re.search(r'(\d+(?:\.\d+)?)\s*(?:g|克)(?![a-z])',prompt,re.I)
    return float(match[1]) if match else None

def rice_request(run):
    return bool(re.search('米饭|熟饭',run['prompt']) or (run.get('scenario')=='clarify' and re.fullmatch(r'\s*(?:实际|吃了|是)?\s*\d+(?:\.\d+)?\s*(?:g|克)[。！!\s]*', run['prompt'],re.I)))

def tool(run, name, args, emit):
    if name not in LABELS or not isinstance(args,dict):
        raise ValueError('不支持的工具或参数。')
    started = time.monotonic()
    emit('tool_start',dict(name=name,label=LABELS[name],args=args))
    try:
        if name=='get_meal_records':
            run['meals'] = run.get('meals') or copy.deepcopy(DATA['meals'])
            result = dict(records=len(run['meals']),dates=list(dict.fromkeys(m['date'] for m in run['meals'])),dataKind='synthetic',meals=run['meals'])
        elif name=='revise_rice_portion':
            if not run.get('meals') or not rice_request(run):
                raise ValueError('只能修订用户明确指定的最近一日午餐米饭。')
            value = args.get('grams')
            if not number(value) or not 1 <= value <= 2000:
                raise ValueError('米饭份量应为1–2000克。')
            if run.get('portionRevision'):
                if value != run['portionRevision']['grams']:
                    raise ValueError('本轮份量已修订，不能重复折算。')
                result = dict(run['portionRevision'],reused=True)
            else:
                meal = [m for m in run['meals'] if m['slot']=='午餐'][-1]
                rice = next(i for i in meal['items'] if i['food']=='rice')
                authorized = grams(run['prompt'])
                if authorized is None and re.search('一半|半份',run['prompt']):
                    authorized = rice['grams']/2
                if authorized is None or abs(value-authorized)>.001:
                    raise ValueError('修订克数必须来自用户明确输入。')
                rice['grams'], meal['origin'] = value, '用户修订的示例记录'
                run.update(analysis=None,validation=None,report=None)
                result = dict(grams=value,scope='最近一日午餐米饭',source='用户明确修订')
                run['portionRevision'] = result
        elif name=='calculate_nutrition':
            run.update(analysis=calculate(run.get('meals')),validation=None,report=None)
            result = {k:run['analysis'][k] for k in ('average','days','sourceNote')}
        elif name=='validate_report_data':
            result = run['validation'] = validate(run.get('analysis'))
        elif name=='generate_report':
            if run.get('simulateFailure'):
                run['simulateFailure'] = False
                raise ValueError('演示故障：报告步骤失败，已保存计算结果，可重试。')
            run['report'] = report(run.get('analysis'),run.get('validation'),run['version'])
            result = dict(title=run['report']['title'],version=run['version'],generated=True)
        else:
            question = args.get('question')
            if not isinstance(question,str) or not question.strip() or len(question)>300:
                raise ValueError('补充问题格式无效。')
            run.update(status='awaiting_input',question=question)
            result = dict(question=question,paused=True)
        emit('tool_end',dict(name=name,label=LABELS[name],durationMs=int((time.monotonic()-started)*1000),result=result))
        return result
    except Exception as error:
        emit('tool_error',dict(name=name,label=LABELS[name],durationMs=int((time.monotonic()-started)*1000),error=str(error)))
        raise

def run_demo(run, emit, delay=.05):
    def call(name,args=None):
        time.sleep(delay)
        return tool(run,name,args or {},emit)
    if run.get('resumeReport') and run.get('analysis') and (run.get('validation') or {}).get('passed'):
        emit('message',{'text':'恢复已保存的计算与校验，只重试报告生成。'})
        call('generate_report')
        return '报告已恢复生成，未重复计算。'
    amount, half = grams(run['prompt']), bool(re.search('一半|半份',run['prompt']))
    if (amount is not None or half) and not rice_request(run):
        call('ask_user',{'question':'当前只支持修改最近一日午餐米饭，请明确食物与克数。'})
        return None
    call('get_meal_records')
    if run.get('scenario')=='clarify' and amount is None and not half:
        call('ask_user',{'question':'最近一日午餐米饭实际吃了多少克？例如“米饭实际吃了100克”。'})
        return None
    if not run.get('scenario') and amount is None and not half and not re.search('报告|分析|饮食|记录|生成|重试',run['prompt']):
        call('ask_user',{'question':'示例模式支持三日报告、米饭份量修订与失败恢复，请选择一个任务。'})
        return None
    if amount is not None or half:
        rice = next(i for i in [m for m in run['meals'] if m['slot']=='午餐'][-1]['items'] if i['food']=='rice')
        call('revise_rice_portion',{'grams':amount if amount is not None else rice['grams']/2})
    for name in ('calculate_nutrition','validate_report_data','generate_report'):
        call(name)
    return f"已完成3天、12条合成记录的分析，生成第{run['version']}版报告。"

def run_live(run, emit, client):
    messages = [{'role':'system','content':PROMPTS['agent']}]+run.get('history',[])[-6:]+[{'role':'user','content':run['prompt']}]
    if run.get('resumeReport'):
        messages.append({'role':'system','content':'已恢复计算与校验，可直接调用 generate_report。'})
    calls = 0
    for step in range(6):
        emit('model',dict(round=step+1,model=client.config['model'],message='模型正在选择下一步工具'))
        data = client.chat(messages,tools=DATA['tools'])
        choice = (data.get('choices') or [{}])[0].get('message')
        if not isinstance(choice,dict):
            raise ValueError('模型未返回有效消息。')
        if data.get('usage'):
            emit('usage',data['usage'])
        if not choice.get('tool_calls'):
            tool(run,'ask_user',{'question':'模型尚未生成报告，请明确分析任务或选择预置示例。'},emit)
            return None
        messages.append(dict(role='assistant',content=choice.get('content'),tool_calls=choice['tool_calls']))
        for call in choice['tool_calls']:
            calls += 1
            if calls>12:
                raise ValueError('工具调用达到上限。')
            try:
                result = tool(run,call['function']['name'],json.loads(call['function'].get('arguments') or '{}'),emit)
            except (ValueError,KeyError,TypeError) as error:
                result = {'error':str(error)}
            messages.append(dict(role='tool',tool_call_id=call['id'],content=dumps(result)))
            if run['status']=='awaiting_input':
                return None
        if run.get('report'):
            return '报告已生成，数值来自计算工具，校验与依据已保留。'
    raise ValueError('模型编排达到六轮上限。')
