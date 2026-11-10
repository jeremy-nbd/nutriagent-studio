"""共享配置、JSON 存储及兼容模型客户端（仅 Python 标准库）。"""
import json
import math
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
PROMPTS = json.loads(Path(__file__).with_name('prompts.json').read_text())
KEYS = ('kcal', 'protein', 'carbs', 'fat')

def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)

def number(value):
    return type(value) in (int, float) and math.isfinite(value)

def rounded(value):
    return math.floor(value * 10 + .5) / 10

def zero():
    return dict.fromkeys(KEYS, 0)

def save_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.pending-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(dumps(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def load_env(path, env=None):
    env = os.environ if env is None else env
    if Path(path).exists():
        for line in Path(path).read_text().splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.removeprefix('export ').split('=', 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            env.setdefault(key.strip(), value)
    return env

def config(env=None):
    env = os.environ if env is None else env
    llm = any(k in env for k in ('LLM_BASE_URL', 'LLM_API_KEY', 'LLM_DEFAULT_MODEL_ID'))
    prefix = 'LLM' if llm else 'MODEL'
    base = env.get(prefix + '_BASE_URL', 'https://api.openai.com/v1').strip().rstrip('/')
    url = urlsplit(base)
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError('模型地址必须是无认证信息的 HTTP(S) URL。')
    def setting(key, default, lower, upper):
        try:
            value = float(env.get(key) or default)
            if not math.isfinite(value) or not lower <= value <= upper:
                raise ValueError()
            return value
        except ValueError:
            raise ValueError(key + ' 配置无效。') from None
    return dict(baseURL=base, apiKey=env.get(prefix+'_API_KEY', '').strip(),
                model=env.get('LLM_DEFAULT_MODEL_ID' if llm else 'MODEL_NAME', '').strip(),
                temperature=setting(prefix+'_TEMPERATURE', .2, 0, 2),
                timeout=setting('LLM_TIMEOUT_S', 60, .001, 3600) if llm else setting('MODEL_TIMEOUT_MS', 45000, 1, 3600000)/1000,
                visionModel=env.get('VLM_DEFAULT_MODEL_ID', '').strip(), visionTimeout=setting('VLM_TIMEOUT_S', 120, .001, 3600),
                provider='阿里云百炼' if re.fullmatch(r'dashscope(?:-[a-z]+)?\.aliyuncs\.com', url.hostname) or url.hostname.endswith('.maas.aliyuncs.com') else '兼容服务')

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

class ModelClient:
    def __init__(self, settings):
        self.config = settings

    def chat(self, messages, *, vision=False, tools=None, structured=False):
        c = self.config
        model = c['visionModel'] if vision else c['model']
        if not c['apiKey'] or not model:
            raise ValueError('请先配置本地 API Key 和模型名称。')
        payload = dict(model=model, messages=messages, temperature=c['temperature'])
        if structured:
            payload['response_format'] = {'type': 'json_object'}
        if tools:
            payload.update(tools=[{'type':'function','function':t} for t in tools], tool_choice='auto', parallel_tool_calls=False)
        if c['provider'] == '阿里云百炼' and re.match(r'qwen3[.\-]', model, re.I):
            payload['enable_thinking'] = False
        request = Request(c['baseURL']+'/chat/completions', data=dumps(payload).encode(), headers={'Content-Type':'application/json','Authorization':'Bearer '+c['apiKey']})
        try:
            with build_opener(NoRedirect).open(request, timeout=c['visionTimeout'] if vision else c['timeout']) as response:
                body = response.read(2_000_001)
                if len(body) > 2_000_000:
                    raise ValueError('模型响应过长。')
                return json.loads(body)
        except HTTPError as error:
            raise ValueError(f'模型请求失败（HTTP {error.code}），请检查配置。') from None
        except (URLError, TimeoutError, OSError):
            raise ValueError('模型服务连接失败或超时，请重试。') from None
        except json.JSONDecodeError:
            raise ValueError('模型响应格式无效。') from None

    def structured(self, messages, vision=False):
        data = self.chat(messages, vision=vision, structured=True)
        try:
            content = data['choices'][0]['message']['content']
            if not isinstance(content, str) or len(content) > 150000:
                raise ValueError()
            return json.loads(re.sub(r'\s*```$', '', re.sub(r'^```(?:json)?\s*', '', content, flags=re.I)))
        except (KeyError, IndexError, TypeError, ValueError):
            raise ValueError('AI 未返回有效的结构化结果，请重试。') from None
