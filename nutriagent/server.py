"""本机 HTTP/SSE 服务；后台线程运行模型任务，状态通过条件变量同步。"""
import os
from http.cookies import SimpleCookie
from .accounts import Accounts
from .advisor import Advisor, Wellnest
import copy
import json
import re
import socket
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs
from .core import ROOT, ModelClient, config, dumps, now, save_json
from .nutrition import NutritionService, today, ID, clean
from . import agent

ASSETS = {'/':'index.html','/studio':'studio.html','/app.js':'app.js','/styles.css':'styles.css','/nutrition.js':'nutrition.js','/nutrition.css':'nutrition.css','/favicon.svg':'favicon.svg'}
TYPES = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'}

class App:
    def __init__(self, directory=None, env=None, client=None):
        from pathlib import Path
        self.directory = Path(directory or ROOT/'.local/runs')
        self.directory.mkdir(parents=True,exist_ok=True)
        env = os.environ if env is None else env
        if env.get('AUTH_MODE','local') not in ('local','family'):
            raise ValueError('AUTH_MODE 只支持 local 或 family。')
        self.family = env.get('AUTH_MODE','local') == 'family'
        self.origin = env.get('PUBLIC_ORIGIN','').rstrip('/')
        self.base_path = env.get('BASE_PATH','').rstrip('/')
        if self.base_path not in ('','/family'):
            raise ValueError('BASE_PATH 只支持空值或 /family。')
        if self.family and (urlsplit(self.origin).scheme not in ('http','https') or not urlsplit(self.origin).netloc or urlsplit(self.origin).path or urlsplit(self.origin).username or urlsplit(self.origin).query or urlsplit(self.origin).fragment):
            raise ValueError('家庭模式必须配置 PUBLIC_ORIGIN，例如 https://your-host。')
        self.bridge=Wellnest(env)
        self.advisors={}
        self.accounts = Accounts(self.directory) if self.family else None
        self.services, self.services_lock = {}, threading.RLock()
        self.model_slots = threading.BoundedSemaphore(2)
        self.config = config(env)
        self.client = client or ModelClient(self.config)
        self.mode = 'live' if self.config['apiKey'] and self.config['model'] else 'demo'
        self.nutrition = NutritionService(self.directory/'nutrition',self.client)
        self.runs, self.condition = {}, threading.Condition(threading.RLock())
        for path in self.directory.glob('*.json'):
            if not ID.fullmatch(path.stem):
                continue
            run = json.loads(path.read_text())
            if run['id'] != path.stem:
                raise ValueError('本地任务标识异常。')
            self.runs[run['id']] = run
            if run['status']=='running':
                run.update(status='failed',error='服务已重启，中间结果已保存，请重试。')
                self.emit(run,'failed',{'error':run['error']})

    def user_service(self, user):
        with self.services_lock:
            if user['id'] not in self.services:
                service = NutritionService(self.directory/'users'/user['id']/'nutrition', self.client)
                service.slots = self.model_slots
                self.services[user['id']] = service
            return self.services[user['id']]

    def advisor(self,user=None):
        key=user['id'] if user else 'local'
        with self.services_lock:
            if key not in self.advisors:
                n=self.user_service(user) if user else self.nutrition
                directory=n.directory.parent
                self.advisors[key]=Advisor(directory,n,self.bridge)
            return self.advisors[key]

    def emit(self, run, kind, data):
        with self.condition:
            event = dict(id=len(run['events'])+1,type=kind,at=now(),data=copy.deepcopy(data))
            run['events'].append(event)
            run['updatedAt'] = event['at']
            save_json(self.directory/(run['id']+'.json'),run)
            self.condition.notify_all()

    def execute(self, run):
        emit = lambda kind,data:self.emit(run,kind,data)
        try:
            emit('started',dict(mode=run['mode'],message='真实模型编排 · 合成数据' if run['mode']=='live' else '示例编排 · 实际执行计算工具'))
            answer = agent.run_live(run,emit,self.client) if run['mode']=='live' else agent.run_demo(run,emit)
            with self.condition:
                run['answer'] = answer
                if run['status']=='awaiting_input':
                    emit('awaiting_input',{'question':run['question']})
                elif run.get('report'):
                    run['status'] = 'completed'
                    emit('completed',dict(answer=answer,report=run['report']))
                else:
                    raise ValueError('任务未产生有效报告。')
        except Exception as error:
            with self.condition:
                run.update(status='failed',error=str(error) if isinstance(error,ValueError) else '任务执行失败，已保存中间结果。')
                emit('failed',{'error':run['error']})

    def create_run(self, data):
        prompt = data.get('prompt')
        if not isinstance(prompt,str) or not 1 <= len(prompt.strip()) <= 2000:
            raise ValueError('请输入1–2000字任务。')
        with self.condition:
            if sum(r['status']=='running' for r in self.runs.values())>=2:
                return 429, {'error':'已有任务执行中，请稍后重试。'}
            previous = self.runs.get(data.get('previousRunId'))
            if data.get('previousRunId') and not previous:
                return 404, {'error':'上一条任务不存在。'}
            if previous and previous['status']=='running':
                return 409, {'error':'上一条任务尚未结束。'}
            scenario = data.get('scenario') or (previous.get('scenario') if previous and previous['status']=='awaiting_input' else None)
            if scenario and scenario not in [s['id'] for s in agent.DATA['scenarios']]:
                raise ValueError('示例场景不存在。')
            p = previous or {}
            retry = data.get('retry') is True and p.get('status')=='failed'
            history = (p.get('history',[])+[{'role':'user','content':p.get('prompt','')},{'role':'assistant','content':p.get('answer') or p.get('question') or p.get('error') or '上轮任务结束。'}])[-6:] if p else []
            run = dict(id=str(uuid.uuid4()), status='running', mode='demo' if scenario=='recovery' or retry and p['mode']=='demo' else self.mode,
                       scenario=scenario,prompt=prompt.strip(),previousRunId=p.get('id'),createdAt=now(),updatedAt=now(),
                       version=p['version'] if retry else (p.get('report') or {}).get('version',0)+1, events=[],
                       meals=copy.deepcopy(p.get('meals')),analysis=copy.deepcopy(p.get('analysis')) if retry else None,
                       validation=copy.deepcopy(p.get('validation')) if retry else None,
                       resumeReport=bool(retry and p.get('analysis') and (p.get('validation') or {}).get('passed')),
                       simulateFailure=scenario=='recovery' and not retry,history=history,report=None)
            self.runs[run['id']] = run
            save_json(self.directory/(run['id']+'.json'),run)
            threading.Thread(target=self.execute,args=(run,),daemon=True).start()
            return 202, dict(id=run['id'],mode=run['mode'])

    def handler(self):
        app = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def send(self, status, value, mime='application/json; charset=utf-8', filename=None):
                payload = value if isinstance(value,bytes) else dumps(value).encode() if mime.startswith('application/json') else value.encode()
                self.send_response(status)
                self.send_header('Content-Type',mime)
                self.send_header('Content-Length',str(len(payload)))
                self.send_header('Cache-Control','no-store')
                if getattr(self,'cookie',None): self.send_header('Set-Cookie',self.cookie)
                self.send_header('X-Content-Type-Options','nosniff')
                self.send_header('Referrer-Policy','no-referrer')
                self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
                if filename:
                    self.send_header('Content-Disposition',f'attachment; filename="{filename}"')
                self.end_headers()
                self.wfile.write(payload)

            def body(self, limit=24000):
                if not self.headers.get('Content-Type','').startswith('application/json'):
                    raise ValueError('请使用 JSON 请求。')
                if self.headers.get('Transfer-Encoding'):
                    raise ValueError('请提供 Content-Length。')
                size = int(self.headers.get('Content-Length','0'))
                if not 0 <= size <= limit:
                    raise ValueError('请求内容过长。')
                value = json.loads(self.rfile.read(size) or b'{}',parse_constant=lambda _: (_ for _ in ()).throw(ValueError('数值无效。')))
                if not isinstance(value,dict):
                    raise ValueError('请求必须为 JSON 对象。')
                return value

            def dispatch(self):
                self.connection.settimeout(15)
                try:
                    host = self.headers.get('Host','')
                    allowed_host = host == urlsplit(app.origin).netloc if app.family else bool(re.fullmatch(r'(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?',host))
                    expected_origin = app.origin if app.family else f'http://{host}'
                    if not allowed_host or self.headers.get('Origin',expected_origin) != expected_origin or self.headers.get('Sec-Fetch-Site') == 'cross-site':
                        return self.send(403,{'error':'只允许本机同源访问。'})
                    url = urlsplit(self.path)
                    path, method, q = url.path,self.command,parse_qs(url.query)
                    if method in ('POST','PATCH','DELETE') and not self.headers.get('Content-Type','').startswith('application/json'):
                        return self.send(415,{'error':'请使用 JSON 请求。'})
                    if app.base_path:
                        if not path.startswith(app.base_path+'/'):
                            return self.send(404,{'error':'页面不存在。'})
                        path = path[len(app.base_path):]
                    n,c = app.nutrition, app.config
                    user=None
                    if app.family:
                        cookie=SimpleCookie()
                        try: cookie.load(self.headers.get('Cookie',''))
                        except Exception: pass
                        token=cookie['nutri_session'].value if 'nutri_session' in cookie else ''
                        user=app.accounts.user(token)
                        def session_cookie(value, age):
                            return f'nutri_session={value}; Path={app.base_path or "/"}; HttpOnly; SameSite=Strict; Max-Age={age}'+('; Secure' if app.origin.startswith('https://') else '')
                        if path=='/api/auth/login' and method=='POST':
                            data=self.body()
                            try: token,user=app.accounts.login(data.get('username'),data.get('password'),self.client_address[0])
                            except ValueError as error: return self.send(401,{'error':str(error)})
                            self.cookie=session_cookie(token,604800)
                            return self.send(200,user)
                        if path=='/api/auth/logout' and method=='POST':
                            app.accounts.logout(token)
                            self.cookie=session_cookie('',0)
                            return self.send(200,{'ok':True})
                        if path=='/api/auth/me' and method=='GET':
                            return self.send(200,dict(family=True,user=user))
                        if path in ('/login','/login.js','/nutrition.css','/favicon.svg') and method=='GET':
                            filename={'/login':'login.html','/login.js':'login.js','/nutrition.css':'nutrition.css','/favicon.svg':'favicon.svg'}[path]
                            file=ROOT/'public'/filename
                            raw=file.read_bytes()
                            if file.suffix=='.html': raw=raw.replace(b'href="/',f'href="{app.base_path}/'.encode()).replace(b'src="/',f'src="{app.base_path}/'.encode())
                            return self.send(200,raw,TYPES[file.suffix])
                        if not user:
                            if path=='/':
                                self.send_response(303); self.send_header('Location',app.base_path+'/login');self.send_header('Cache-Control','no-store');self.end_headers();return
                            return self.send(401,{'error':'请先登录。'})
                        if path in ('/studio','/app.js','/styles.css') or path.startswith('/api/runs') or path in ('/api/config','/api/sample'):
                            return self.send(404,{'error':'家庭版不提供共享工程演示。'})
                        if path=='/api/auth/password' and method=='POST':
                            data=self.body()
                            app.accounts.change_password(user,data.get('current'),data.get('password'),self.client_address[0])
                            self.cookie=session_cookie('',0)
                            return self.send(200,{'ok':True})
                        if path.startswith('/api/admin/'):
                            if user['role']!='superadmin':return self.send(403,{'error':'需要超级管理员权限。'})
                            if method!='GET':return self.send(405,{'error':'管理员面板仅提供查看。'})
                            if path=='/api/admin/users':return self.send(200,app.accounts.list_users())
                            if path=='/api/admin/data':
                                target=next((u for u in app.accounts.list_users() if u['id']==q.get('userId',[''])[0]),None)
                                if not target:raise ValueError('账号不存在。')
                                service=app.user_service(target);advisor=app.advisor(target)
                                return self.send(200,dict(user=target,stats=service.overview(q.get('date',[today()])[0],q.get('period',['week'])[0]),drafts=service.drafts(),memory=advisor.profile(),consultations=advisor.conversations()))
                            return self.send(404,{'error':'接口不存在。'})
                        n=app.user_service(user)
                    elif path=='/api/auth/me' and method=='GET':
                        return self.send(200,dict(family=False,user=None))
                    if method=='GET' and path in ASSETS:
                        file = ROOT/'public'/ASSETS[path]
                        raw=file.read_bytes()
                        if file.suffix=='.html': raw=raw.replace(b'href="/',f'href="{app.base_path}/'.encode()).replace(b'src="/',f'src="{app.base_path}/'.encode())
                        return self.send(200,raw,TYPES[file.suffix])
                    if method=='GET' and path=='/api/nutrition/config':
                        return self.send(200,dict(textReady=bool(c['apiKey'] and c['model']),imageReady=bool(c['apiKey'] and c['visionModel']),model=c['model'],visionModel=c['visionModel'],provider=c['provider'],today=today(),timeZone='Asia/Shanghai',advisorReady=app.bridge.ready))
                    advisor=app.advisor(user)
                    if path=='/api/nutrition/memory':
                        if method=='GET':return self.send(200,advisor.profile())
                        if method=='POST':return self.send(200,advisor.save_memory(self.body(100000)))
                    if path=='/api/nutrition/consultations' and method=='GET':return self.send(200,advisor.conversations())
                    if path=='/api/nutrition/consult' and method=='POST':
                        data=self.body();events=advisor.consult(data)
                        # Start/validate before headers, so validation failures remain JSON errors.
                        first=next(events)
                        self.send_response(200)
                        self.send_header('Content-Type','application/x-ndjson; charset=utf-8')
                        self.send_header('Cache-Control','no-store')
                        self.send_header('X-Content-Type-Options','nosniff')
                        self.end_headers()
                        try:
                            self.wfile.write((dumps(first)+'\n').encode());self.wfile.flush()
                            for event in events:
                                self.wfile.write((dumps(event)+'\n').encode());self.wfile.flush()
                        except (BrokenPipeError,ConnectionResetError):pass
                        except Exception as error:
                            self.wfile.write((dumps(dict(type='error',data={'message':str(error) if isinstance(error,ValueError) else '咨询未完成，请重试。'}))+'\n').encode())
                        finally:events.close()
                        return
                    if path=='/api/nutrition/library' and method=='GET':return self.send(200,app.bridge.json('/status'))
                    if path=='/api/nutrition/search' and method=='POST':
                        query=clean(self.body().get('query'),501)
                        if not 1<=len(query)<=500:raise ValueError('请输入1–500字的检索问题。')
                        return self.send(200,app.bridge.json('/search',{'query':query}))
                    if path=='/api/nutrition/page' and method=='GET':
                        return self.send(200,app.bridge.page(q.get('document',[''])[0],int(q.get('page',['0'])[0])),'image/png')
                    if method=='POST' and path=='/api/nutrition/manual':
                        return self.send(200,n.manual(self.body()))
                    if method=='POST' and path=='/api/nutrition/analyze':
                        return self.send(200,n.analyze(self.body(9*1024*1024)))
                    if method=='GET' and path=='/api/nutrition/overview':
                        return self.send(200,n.overview(q.get('date',[today()])[0],q.get('period',['day'])[0]))
                    if method=='GET' and path=='/api/nutrition/drafts':
                        return self.send(200,n.drafts())
                    if method=='POST' and path=='/api/nutrition/summary':
                        data = self.body()
                        return self.send(200,n.summarize(data.get('date'),data.get('period','day'),data.get('force') is True))
                    match = re.fullmatch(r'/api/nutrition/records/([0-9a-f-]+)(/confirm)?',path)
                    if match and ID.fullmatch(match[1]):
                        id = match[1]
                        if method=='GET' and not match[2]:
                            return self.send(200,n.get(id))
                        if method=='POST' and match[2]:
                            return self.send(200,n.confirm(id,self.body()))
                        if method=='PATCH' and not match[2]:
                            return self.send(200,n.confirm(id,self.body(),editing=True))
                        if method=='DELETE' and not match[2]:
                            return self.send(200,n.remove(id,self.body().get('revision')))
                    if method=='GET' and path=='/api/config':
                        return self.send(200,dict(mode=app.mode,model=c['model'] if app.mode=='live' else None,configuredModel=c['model'],provider=c['provider'],temperature=c['temperature'],timeoutSeconds=c['timeout'],vision=dict(model=c['visionModel'],integrated=True),scenarios=agent.DATA['scenarios'],dataKind='synthetic'))
                    if method=='GET' and path=='/api/sample':
                        a = agent.calculate(agent.DATA['meals'])
                        return self.send(200,agent.report(a,agent.validate(a)))
                    if method=='POST' and path=='/api/runs':
                        return self.send(*app.create_run(self.body()))
                    match = re.fullmatch(r'/api/runs/([0-9a-f-]+)(?:/(events|markdown))?',path)
                    if match and method=='GET':
                        with app.condition:
                            run = app.runs.get(match[1])
                            if not run:
                                return self.send(404,{'error':'任务不存在。'})
                            if match[2]=='events':
                                after = int(self.headers.get('Last-Event-ID') or q.get('after',['0'])[0])
                            elif match[2]=='markdown':
                                if run['status']!='completed' or not run.get('report'):
                                    return self.send(409,{'error':'报告尚未生成。'})
                                return self.send(200,agent.markdown(run['report']),'text/markdown; charset=utf-8',f"nutrition-report-v{run['version']}.md")
                            else:
                                keys = ('id','status','prompt','mode','scenario','version','createdAt','updatedAt','question','answer','error','report','events')
                                return self.send(200,{k:copy.deepcopy(run.get(k)) for k in keys})
                        self.send_response(200)
                        self.send_header('Content-Type','text/event-stream')
                        self.send_header('Cache-Control','no-cache')
                        self.end_headers()
                        while True:
                            with app.condition:
                                events = copy.deepcopy([e for e in run['events'] if e['id']>after])
                                finished = run['status']!='running'
                                if not events and not finished:
                                    app.condition.wait(timeout=10)
                                    continue
                            for event in events:
                                self.wfile.write(f"id: {event['id']}\ndata: {dumps(event)}\n\n".encode())
                                after = event['id']
                            self.wfile.flush()
                            if finished:
                                return
                    return self.send(404,{'error':'页面或接口不存在。'})
                except (BrokenPipeError,ConnectionResetError,TimeoutError):
                    return
                except ValueError as error:
                    return self.send(400,{'error':str(error) if not isinstance(error,json.JSONDecodeError) else '请求或模型 JSON 格式无效。'})
                except (TypeError,KeyError,IndexError):
                    return self.send(400,{'error':'请求或模型结果无效，请检查输入与配置后重试。'})
                except Exception:
                    return self.send(500,{'error':'服务处理失败，请检查本地存储后重试。'})

            do_GET = do_POST = do_PATCH = do_DELETE = dispatch
        return Handler

    def server(self, host='127.0.0.1', port=4371):
        if host not in ('127.0.0.1','localhost','::1'):
            raise ValueError('本版本仅支持 localhost。')
        class Server(ThreadingHTTPServer):
            daemon_threads = True
            address_family = socket.AF_INET6 if host=='::1' else socket.AF_INET
        return Server((host,port), self.handler())
