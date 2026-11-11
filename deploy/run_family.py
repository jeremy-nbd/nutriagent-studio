from pathlib import Path
import shutil
from nutriagent.__main__ import main
file=Path('/data/accounts.sqlite3')
if not file.exists():
    shutil.copyfile('/seed/accounts.sqlite3',file)
    file.chmod(0o600)
main()
