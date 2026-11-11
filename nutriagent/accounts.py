"""家庭账号及服务端会话；密码与会话均不保存明文。"""
from contextlib import contextmanager
import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import time
import uuid
from pathlib import Path

class Accounts:
    def __init__(self, directory):
        self.path = Path(directory)/'accounts.sqlite3'
        self.path.parent.mkdir(parents=True,exist_ok=True)
        with self.db() as db:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS attempts(key TEXT PRIMARY KEY, count INTEGER NOT NULL, until REAL NOT NULL);
            ''')
            columns={r['name'] for r in db.execute('PRAGMA table_info(users)')}
            if 'role' not in columns:db.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'")
        os.chmod(self.path,0o600)
    @contextmanager
    def db(self):
        db=sqlite3.connect(self.path,timeout=10)
        db.row_factory=sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()
    @staticmethod
    def password_hash(password,salt):
        return hashlib.pbkdf2_hmac('sha256',password.encode(),bytes.fromhex(salt),600000).hex()
    def create(self, username, name, password, reset=False, role="member"):
        if role not in ("member","superadmin"):raise ValueError("账号角色无效。")
        username=username.strip().lower()
        if not re.fullmatch(r'[a-z0-9_-]{3,32}',username) or not name.strip() or len(name)>50:
            raise ValueError('用户名需3–32位字母、数字、下划线或短横线，称呼不超过50字。')
        if not isinstance(password,str) or not 12<=len(password)<=128:
            raise ValueError('密码长度须为12–128个字符。')
        salt=secrets.token_hex(16);hashed=self.password_hash(password,salt)
        with self.db() as db:
            existing=db.execute('SELECT id FROM users WHERE username=?',(username,)).fetchone()
            if reset:
                if not existing:raise ValueError('账号不存在。')
                db.execute('UPDATE users SET salt=?,hash=? WHERE id=?',(salt,hashed,existing['id']))
                db.execute('DELETE FROM sessions WHERE user_id=?',(existing['id'],))
                return existing['id']
            if existing:raise ValueError('账号已存在。')
            id=str(uuid.uuid4())
            db.execute('INSERT INTO users(id,username,name,salt,hash,active,role) VALUES(?,?,?,?,?,1,?)',(id,username,name.strip(),salt,hashed,role))
            return id
    def list_users(self):
        with self.db() as db:
            return [dict(r) for r in db.execute('SELECT id,username,name,active,role FROM users ORDER BY username')]
    def login(self, username, password, peer):
        if not isinstance(username,str) or not isinstance(password,str) or len(username)>32 or len(password)>128:
            raise ValueError('账号或密码错误。')
        username=username.strip().lower();now=time.time()
        keys=['user:'+username,'peer:'+peer]
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM attempts WHERE until<?',(now,))
            for key in keys:
                row=db.execute('SELECT count FROM attempts WHERE key=?',(key,)).fetchone()
                if row and row['count']>=10:raise ValueError('尝试过多，请15分钟后再试。')
            for key in keys:
                db.execute('INSERT INTO attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1',(key,now+900))
            user=db.execute('SELECT * FROM users WHERE username=?',(username,)).fetchone()
        salt=user['salt'] if user else '00'*16
        valid=hmac.compare_digest(self.password_hash(password,salt),user['hash'] if user else '0'*64)
        if not user or not user['active'] or not valid:raise ValueError('账号或密码错误。')
        token=secrets.token_urlsafe(32)
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            current=db.execute('SELECT hash,active FROM users WHERE id=?',(user['id'],)).fetchone()
            if not current or not current['active'] or current['hash']!=user['hash']:raise ValueError('账号已更新，请重新登录。')
            db.execute('UPDATE attempts SET count=MAX(0,count-1) WHERE key IN (?,?)',keys)
            db.execute('DELETE FROM sessions WHERE expires<?',(now,))
            db.execute('INSERT INTO sessions VALUES(?,?,?)',(hashlib.sha256(token.encode()).hexdigest(),user['id'],now+86400*7))
        return token, {k:user[k] for k in ('id','username','name','role')}
    def user(self, token):
        if not token:return None
        with self.db() as db:
            row=db.execute('SELECT u.id,u.username,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1',(hashlib.sha256(token.encode()).hexdigest(),time.time())).fetchone()
            return dict(row) if row else None
    def logout(self, token):
        with self.db() as db:
            db.execute('DELETE FROM sessions WHERE token=?',(hashlib.sha256(token.encode()).hexdigest(),))

    def change_password(self, user, current, password, peer):
        # Reauthentication shares the login rate limit. Reset revokes all sessions.
        token, _ = self.login(user['username'], current, peer)
        self.logout(token)
        self.create(user['username'], user['name'], password, reset=True)
