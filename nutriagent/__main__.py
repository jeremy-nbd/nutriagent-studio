"""python3 -m nutriagent [serve|analyze|summary]"""
import argparse
import base64
import mimetypes
import os
import uuid
from pathlib import Path
from .core import ROOT, dumps, load_env
from .server import App
from .nutrition import today, SLOTS

def main():
    parser = argparse.ArgumentParser(description='NutriAgent Python 服务与营养分析脚本')
    parser.add_argument('--env-file',type=Path,default=ROOT/'.env')
    parser.add_argument('--data-dir',type=Path,default=ROOT/'.local/runs')
    commands = parser.add_subparsers(dest='command')
    serve = commands.add_parser('serve')
    serve.add_argument('--port',type=int)
    analyze = commands.add_parser('analyze',help='识别并保存待确认草稿')
    analyze.add_argument('--text',default='')
    analyze.add_argument('--image',type=Path)
    analyze.add_argument('--date',default=today())
    analyze.add_argument('--slot',choices=SLOTS,default='午餐')
    summary = commands.add_parser('summary')
    summary.add_argument('--date',default=today())
    summary.add_argument('--period',choices=['day','week'],default='day')
    args = parser.parse_args()
    load_env(args.env_file)
    app = App(args.data_dir)
    if args.command=='analyze':
        image = None
        if args.image:
            if args.image.stat().st_size>6*1024*1024:
                parser.error('图片不能超过6 MB。')
            mime = mimetypes.guess_type(args.image)[0]
            image = 'data:'+str(mime)+';base64,'+base64.b64encode(args.image.read_bytes()).decode()
        print(dumps(app.nutrition.analyze(dict(requestId=str(uuid.uuid4()),text=args.text,image=image,date=args.date,slot=args.slot))))
    elif args.command=='summary':
        print(dumps(app.nutrition.summarize(args.date,args.period)))
    else:
        host = os.environ.get('HOST','127.0.0.1')
        port = getattr(args,'port',None) or int(os.environ.get('PORT','4371'))
        server = app.server(host,port)
        print(f'NutriAgent · Python\nLocal: http://{host}:{port}\nMode: {app.mode}',flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()

if __name__=='__main__':
    main()
